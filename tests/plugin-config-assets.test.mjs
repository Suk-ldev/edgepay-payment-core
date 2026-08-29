/**
 * 收款码图片不与业务配置同住一行。
 *
 * 图片以 base64 内联，一张一百多 KB，几个插件就能把 plugin_config 撑到近 700 KB；
 * 而热路径（快照轮询、通道路由、掉线告警）要的只是密钥和开关这些短字段，却得先把
 * 整份密文解开才拿得到。所以超过阈值的值各存一行 plugin_asset:<插件>:<字段>，
 * 主配置里只留占位符。
 *
 * 这里最要紧的一条是"拆完之后插件不能被判成配置不全"——配置齐不齐是按字段**存在**
 * 判断的，占位符要是没留住，所有收款插件会被自动停用，等于直接停止收款。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

const { createAdminSession } = await import('../src/admin-auth.js');
const { encryptSetting, decryptSetting } = await import('../src/runtime-settings.js');
const { createTestWorker } = await import('./helpers/worker.mjs');

const ASSET_MARKER = '__edgepay_asset_v1__';
/** 和线上体量同数量级的一张收款码。 */
const QRCODE = `data:image/png;base64,${'Q'.repeat(120_000)}`;

/** 支持 LIKE 查询与 DELETE 的设置表，用来验证孤儿 asset 行会被清掉。 */
class MemoryDatabase {
  constructor() {
    this.settings = new Map();
  }

  prepare(sql) {
    const database = this;
    const text = sql.replace(/\s+/gu, ' ').trim();
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        if (!text.includes('runtime_settings')) return null;
        const value = database.settings.get(String(this.values[0]));
        return value === undefined ? null : { value_text: value };
      },
      async all() {
        if (text.includes('SELECT setting_key FROM runtime_settings') && text.includes('LIKE')) {
          const prefix = String(this.values[0]).replace(/%$/u, '');
          return {
            results: [...database.settings.keys()]
              .filter((key) => key.startsWith(prefix))
              .map((key) => ({ setting_key: key })),
          };
        }
        return { results: [] };
      },
      async run() {
        if (text.includes('INTO runtime_settings')) {
          database.settings.set(String(this.values[0]), String(this.values[1]));
          return { meta: { changes: 1 } };
        }
        if (text.startsWith('DELETE FROM runtime_settings')) {
          const existed = database.settings.delete(String(this.values[0]));
          return { meta: { changes: existed ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

// 加密配置在 isolate 内按 setting+密钥缓存，同一把密钥会让相邻用例互相看见对方的配置。
let configKeySequence = 0;

async function fixture() {
  const worker = createTestWorker();
  configKeySequence += 1;
  const configKey = `plugin-asset-config-key-${configKeySequence}`;
  const env = {
    ADMIN_TOKEN: 'plugin-asset-admin-token',
    ADMIN_USERNAME: 'admin',
    CONFIG_ENCRYPTION_KEY: configKey,
    DB: new MemoryDatabase(),
  };
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const call = (path, init = {}) => worker.fetch(new Request(`https://pay.example${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { origin: 'https://pay.example', 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  }), env, { waitUntil() {} });
  const decrypt = (key) => {
    const stored = env.DB.settings.get(key);
    return stored ? decryptSetting(stored, configKey, key) : null;
  };
  const seedConfig = async (config) => {
    await env.DB.prepare('INSERT INTO runtime_settings')
      .bind('plugin_config', await encryptSetting(config, configKey, 'plugin_config'))
      .run();
  };
  const savePlugin = (pluginCode, values) => call('/admin/api/plugins', {
    method: 'PUT',
    body: JSON.stringify({ plugin_code: pluginCode, values }),
  });
  return { env, call, decrypt, seedConfig, savePlugin };
}

const assetKey = (pluginCode, field) => `plugin_asset:${pluginCode}:${field}`;

test('保存后收款码单独成行，主配置里只留占位符且体积回到几 KB', async () => {
  const { env, decrypt, savePlugin } = await fixture();

  const saved = await savePlugin('wxpay_receipt', {
    sms_forwarder_secret: 'sms-secret',
    receipt_qrcode_image: QRCODE,
  });
  assert.equal(saved.status, 200);

  const lean = await decrypt('plugin_config');
  assert.equal(lean.wxpay_receipt.receipt_qrcode_image, ASSET_MARKER);
  assert.equal(lean.wxpay_receipt.sms_forwarder_secret, 'sms-secret', '短字段仍留在主配置里');

  const asset = await decrypt(assetKey('wxpay_receipt', 'receipt_qrcode_image'));
  assert.equal(asset.value, QRCODE);

  const leanBytes = env.DB.settings.get('plugin_config').length;
  assert.ok(leanBytes < 8_000, `主配置应当回到几 KB，实际 ${leanBytes}`);
  assert.ok(env.DB.settings.get(assetKey('wxpay_receipt', 'receipt_qrcode_image')).length > 100_000);
});

// 这条挂了就意味着线上所有收款插件会被判成配置不全而自动停用。
test('拆分之后插件仍算配置齐全，不会被误判成缺配置而停用', async () => {
  const { call, savePlugin } = await fixture();

  await savePlugin('wxpay_receipt', {
    sms_forwarder_secret: 'sms-secret',
    receipt_qrcode_image: QRCODE,
  });
  const enabled = await savePlugin('wxpay_receipt', { enabled: true });
  assert.equal(enabled.status, 200, '缺字段时这里会被拒，能开就说明占位符顶住了');

  const payload = await (await call('/admin/api/plugins')).json();
  const form = payload.forms.find((item) => item.code === 'wxpay_receipt');
  assert.deepEqual(form.missingFields, []);
  assert.equal(form.configured, true);
  assert.equal(form.enabled, true);
});

test('管理台读回的是真图不是占位符', async () => {
  const { call, savePlugin } = await fixture();
  await savePlugin('wxpay_receipt', {
    sms_forwarder_secret: 'sms-secret',
    receipt_qrcode_image: QRCODE,
  });

  const payload = await (await call('/admin/api/plugins')).json();
  const form = payload.forms.find((item) => item.code === 'wxpay_receipt');
  const field = form.fields.find((item) => item.key === 'receipt_qrcode_image');
  assert.equal(field.value, QRCODE);
});

test('换一张图会覆盖原来那行，不会留下两份', async () => {
  const { env, decrypt, savePlugin } = await fixture();
  await savePlugin('wxpay_receipt', {
    sms_forwarder_secret: 'sms-secret',
    receipt_qrcode_image: QRCODE,
  });

  const replaced = `data:image/png;base64,${'R'.repeat(120_000)}`;
  await savePlugin('wxpay_receipt', { receipt_qrcode_image: replaced });

  const asset = await decrypt(assetKey('wxpay_receipt', 'receipt_qrcode_image'));
  assert.equal(asset.value, replaced);
  assert.equal(
    [...env.DB.settings.keys()].filter((key) => key.startsWith('plugin_asset:')).length,
    1,
  );
});

test('删掉插件后它的 asset 行跟着清掉，不留孤儿', async () => {
  const { env, call, savePlugin } = await fixture();
  await savePlugin('wxpay_receipt', {
    sms_forwarder_secret: 'sms-secret',
    receipt_qrcode_image: QRCODE,
  });
  await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({ plugin_code: 'wxpay_receipt', name: '微信个人 2' }),
  });
  // 副本是另一个微信号，复制配置时不会继承原号的收款码（copyableInstanceConfig
  // 跳过 secret 和 image），所以这里给它单独存一张。
  await savePlugin('wxpay_receipt~2', {
    sms_forwarder_secret: 'second-secret',
    receipt_qrcode_image: `data:image/png;base64,${'S'.repeat(120_000)}`,
  });
  assert.equal(
    [...env.DB.settings.keys()].filter((key) => key.startsWith('plugin_asset:')).length,
    2,
  );

  const removed = await call('/admin/api/plugins/wxpay_receipt~2', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(removed.status, 200);
  assert.equal(env.DB.settings.has(assetKey('wxpay_receipt~2', 'receipt_qrcode_image')), false);
  assert.equal(env.DB.settings.has(assetKey('wxpay_receipt', 'receipt_qrcode_image')), true);
});

// 升级当下配置还是老样子（图片内联），这时候读到的必须仍是真图——否则收银台在
// 管理员第一次保存之前会拿不到收款码。
test('还没拆分的老配置照常能读出收款码', async () => {
  const { call, seedConfig } = await fixture();
  await seedConfig({
    wxpay_receipt: { sms_forwarder_secret: 'sms-secret', receipt_qrcode_image: QRCODE },
  });

  const payload = await (await call('/admin/api/plugins')).json();
  const form = payload.forms.find((item) => item.code === 'wxpay_receipt');
  assert.deepEqual(form.missingFields, []);
  assert.equal(form.fields.find((item) => item.key === 'receipt_qrcode_image').value, QRCODE);
});
