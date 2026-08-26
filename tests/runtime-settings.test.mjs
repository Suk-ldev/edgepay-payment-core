import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  decryptSetting, encryptSetting, readEncryptedJsonSetting, writeEncryptedJsonSetting,
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
