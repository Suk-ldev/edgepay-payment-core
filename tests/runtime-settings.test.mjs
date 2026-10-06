import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  claimEncryptedJsonSetting, decryptSetting, encryptSetting, readCachedPlainJsonSetting, readEncryptedJsonSetting,
  writeEncryptedJsonSetting, writePlainJsonSetting,
} from '../src/runtime-settings.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('后台插件配置使用独立配置密钥派生 AES-GCM 密钥并可完整恢复', async () => {
  const config = {
    fubei_receipt: { watcher_username: 'account', watcher_password: 'secret-password' },
    usdt_trc20_receipt: { usdt_cny_rate: '7.000000' },
  };
  const encrypted = await encryptSetting(config, 'admin-token-for-test', 'plugin_config');
  assert.equal(encrypted.includes('secret-password'), false);
  assert.deepEqual(
    await decryptSetting(encrypted, 'admin-token-for-test', 'plugin_config'),
    config,
  );
});

test('后台插件配置密文不能被不同配置密钥或不同设置键解密', async () => {
  const encrypted = await encryptSetting({ ok: true }, 'correct-token', 'plugin_config');
  await assert.rejects(
    decryptSetting(encrypted, 'wrong-token', 'plugin_config'),
    /解密失败/u,
  );
  await assert.rejects(
    decryptSetting(encrypted, 'correct-token', 'channels'),
    /解密失败/u,
  );
});

// plugin_config 里存着收款码图片，线上实测密文有 678 KB。base64 与字节数组之间
// 逐字节搬运的写法在这个体量下会吃掉整个 CPU 预算（`Uint8Array.from(binary, cb)`
// 实测 560 KB 要 24 ms，而免费版 Worker 每请求只有 10 ms），所以读写两侧都改成了
// 预分配循环 / 分块喂 String.fromCharCode。这条用真实体量跑一次往返，锁住两件事：
// 分块拼接没有在块边界上错位，且展开调用不会撞上参数个数上限。
test('几百 KB 的插件配置（内联收款码）能原样加解密往返', async () => {
  const qrcode = `data:image/png;base64,${'QRCODE'.repeat(30_000)}`;
  const config = {
    wxpay_receipt: { sms_forwarder_secret: 'secret-value', receipt_qrcode_image: qrcode },
    alipay_receipt: { receipt_qrcode_image: qrcode },
  };
  const encrypted = await encryptSetting(config, 'admin-token-for-test', 'plugin_config');
  assert.ok(encrypted.length > 400_000, `密文应当有几百 KB，实际 ${encrypted.length}`);
  assert.equal(encrypted.includes('secret-value'), false);
  const restored = await decryptSetting(encrypted, 'admin-token-for-test', 'plugin_config');
  assert.deepEqual(restored, config);
  assert.equal(restored.wxpay_receipt.receipt_qrcode_image.length, qrcode.length);
});

test('同一加密配置在 isolate 内复用，写入后立即替换缓存', async () => {
  const values = new Map();
  let reads = 0;
  const env = {
    DB: {
      prepare() {
        return {
          bind(...params) {
            return {
              async first() {
                reads += 1;
                return values.has(params[0]) ? { value_text: values.get(params[0]) } : null;
              },
              async run() {
                values.set(params[0], params[1]);
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  await writeEncryptedJsonSetting(env, 'cache-test', 'cache-secret', { version: 1 });
  assert.deepEqual(await readEncryptedJsonSetting(env, 'cache-test', 'cache-secret', {}), { version: 1 });
  assert.deepEqual(await readEncryptedJsonSetting(env, 'cache-test', 'cache-secret', {}), { version: 1 });
  assert.equal(reads, 0, '写入后的两次读取都应直接命中已解密缓存');

  await writeEncryptedJsonSetting(env, 'cache-test', 'cache-secret', { version: 2 });
  assert.deepEqual(await readEncryptedJsonSetting(env, 'cache-test', 'cache-secret', {}), { version: 2 });
  assert.equal(reads, 0);
});

/** 计数的设置表：按 setting_key 存取，记下真正打到库上的读取次数。 */
function countingSettingsEnv(initial = {}) {
  const values = new Map(Object.entries(initial));
  const env = {
    reads: 0,
    DB: {
      prepare() {
        return {
          bind(...params) {
            return {
              async first() {
                env.reads += 1;
                return values.has(params[0]) ? { value_text: values.get(params[0]) } : null;
              },
              async run() {
                values.set(params[0], params[1]);
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
  return env;
}

test('site_config 这类大明文配置一分钟内只读一次库，本进程写入后立即读到新值', async () => {
  const env = countingSettingsEnv({ site_config: JSON.stringify({ merchant_name: '旧名字' }) });
  assert.deepEqual(await readCachedPlainJsonSetting(env, 'site_config', null), { merchant_name: '旧名字' });
  assert.deepEqual(await readCachedPlainJsonSetting(env, 'site_config', null), { merchant_name: '旧名字' });
  assert.equal(env.reads, 1);

  await writePlainJsonSetting(env, 'site_config', { merchant_name: '新名字' });
  assert.deepEqual(await readCachedPlainJsonSetting(env, 'site_config', null), { merchant_name: '新名字' });
  assert.equal(env.reads, 2);

  // 缓存按库分开：另一个库里没有这条设置，拿到的是它自己的兜底值。
  const other = countingSettingsEnv();
  assert.equal(await readCachedPlainJsonSetting(other, 'site_config', 'fallback'), 'fallback');
});

// Makers 每个请求都会重新执行一遍模块，等于每次拿到一份新的模块实例。缓存要是放在
// 模块变量里，换一份实例就全丢了；放在 globalThis 上才能跨请求命中。
test('配置缓存跨模块实例共享（Makers 每个请求重新执行模块）', async () => {
  const fresh = await import('../src/runtime-settings.js?makers-request=2');
  const env = countingSettingsEnv();
  await writeEncryptedJsonSetting(env, 'shared-cache-test', 'shared-secret', { version: 1 });
  assert.deepEqual(await fresh.readEncryptedJsonSetting(env, 'shared-cache-test', 'shared-secret', {}), { version: 1 });

  const plain = countingSettingsEnv({ site_config: JSON.stringify({ merchant_name: 'Suk' }) });
  await readCachedPlainJsonSetting(plain, 'site_config', null);
  await fresh.readCachedPlainJsonSetting(plain, 'site_config', null);
  assert.equal(env.reads + plain.reads, 1, '另一份模块实例应直接命中缓存');
});

/** 真 SQLite 上的最小 D1 外形：ON CONFLICT 的语义由数据库自己决定，不靠假实现模拟。 */
function sqliteSettingsEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runtime_settings (setting_key TEXT PRIMARY KEY, value_text TEXT NOT NULL, updated_at TEXT NOT NULL)');
  return {
    db,
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        let values = [];
        return {
          bind(...next) { values = next; return this; },
          async first() { return statement.get(...values) ?? null; },
          async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
        };
      },
    },
  };
}

test('claimEncryptedJsonSetting：先落库的胜出，后来者拿到的是库里那份而不是自己的', async () => {
  // 新库刚上线时多个请求会同时生成 Worker 授权身份。原来后写覆盖先写，
  // 先写的那份已经在授权站绑定了，库里留下的那份再申请授权就永远 409。
  const env = sqliteSettingsEnv();
  const key = 'claim_test_first_wins';
  const secret = 'claim-secret-1';
  // 先读一次"不存在"，让缓存里留下 null——claim 必须绕过它回读库。
  assert.equal(await readEncryptedJsonSetting(env, key, secret, null), null);
  const first = await claimEncryptedJsonSetting(env, key, secret, { id: 'first' });
  const second = await claimEncryptedJsonSetting(env, key, secret, { id: 'second' });
  assert.deepEqual(first, { id: 'first' });
  assert.deepEqual(second, { id: 'first' }, '后来者必须拿到库里已有的值');
  const stored = env.db.prepare('SELECT value_text FROM runtime_settings WHERE setting_key=?').get(key);
  assert.deepEqual(await decryptSetting(stored.value_text, secret, key), { id: 'first' });
});

test('claimEncryptedJsonSetting：并发的首个请求最终都拿到同一份', async () => {
  const env = sqliteSettingsEnv();
  const key = 'claim_test_concurrent';
  const secret = 'claim-secret-2';
  const results = await Promise.all(['a', 'b', 'c', 'd'].map((id) => claimEncryptedJsonSetting(env, key, secret, { id })));
  assert.equal(new Set(results.map((value) => value.id)).size, 1, JSON.stringify(results));
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM runtime_settings').get().n, 1);
});
