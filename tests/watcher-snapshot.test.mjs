import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

const { hmacSha256Base64 } = await import('../src/receipt-plugins.js');
const { encryptSetting } = await import('../src/runtime-settings.js');
const { createTestWorker } = await import('./helpers/worker.mjs');

const SNAPSHOT_SECRET = 'watcher-snapshot-test-secret';

class MemoryStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/gu, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql.includes('FROM runtime_settings')) {
      const key = String(this.values[0]);
      this.database.settingReads.push(key);
      const value = this.database.settings.get(key);
      return value === undefined ? null : { value_text: value };
    }
    return null;
  }

  async all() {
    if (this.sql.includes('FROM payment_attempts')) {
      const hasLimit = /\bLIMIT \?/u.test(this.sql);
      const limit = hasLimit ? Number(this.values.at(-1)) : Infinity;
      const pluginCodes = new Set(this.values.filter((value) => {
        return typeof value === 'string' && this.database.knownPluginCodes.has(value);
      }));
      for (const code of pluginCodes) this.database.queriedPluginCodes.add(code);
      return {
        results: this.database.payments
          .filter((payment) => pluginCodes.has(payment.plugin_code))
          .filter((payment) => payment.status === 'PAYING' || payment.status === 'EXPIRED')
          .slice(0, limit),
      };
    }
    if (this.sql.includes("setting_key LIKE 'receipt_discovery:%'")) {
      return { results: [] };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes('UPDATE payment_attempts')) {
      this.database.expireRuns += 1;
      return { meta: { changes: 0 } };
    }
    if (this.sql.includes('INSERT INTO runtime_settings')) {
      this.database.settings.set(String(this.values[0]), String(this.values[1]));
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('DELETE FROM runtime_settings')) {
      return { meta: { changes: 0 } };
    }
    return { meta: { changes: 0 } };
  }
}

class MemoryDatabase {
  constructor(settings) {
    this.settings = settings;
    this.payments = [];
    this.settingReads = [];
    this.expireRuns = 0;
    this.queriedPluginCodes = new Set();
    this.knownPluginCodes = new Set(['wxpay_receipt', 'fubei_receipt']);
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

function payment(index, overrides = {}) {
  const channelId = Number(overrides.channel_id ?? 1);
  const pluginCode = String(overrides.plugin_code ?? 'wxpay_receipt');
  const payType = String(overrides.epay_type ?? 'wxpay');
  return {
    payment_no: `p_snapshot_${String(index).padStart(4, '0')}`,
    external_order_no: `SNAPSHOT${String(index).padStart(4, '0')}`,
    plugin_code: pluginCode,
    expected_amount_fen: 100 + index,
    currency: 'CNY',
    status: 'PAYING',
    provider_trade_no: '',
    paid_at: null,
    expires_at: '2026-12-01T00:00:00.000Z',
    metadata_json: JSON.stringify({
      channel_id: channelId,
      epay_type: payType,
    }),
    created_at: `2026-08-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

async function snapshotRequest(pluginCodes = 'wxpay_receipt') {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const path = '/api/watcher/snapshot';
  const signature = await hmacSha256Base64(SNAPSHOT_SECRET, `${timestamp}.GET.${path}.`);
  return new Request(`https://pay.example${path}`, {
    headers: {
      'x-watcher-timestamp': timestamp,
      'x-watcher-signature': `v1=${signature}`,
      'x-edgepay-watcher-plugins': pluginCodes,
      'x-edgepay-watcher-kind': 'yyb_bridge',
      'x-edgepay-watcher-instance': 'yyb-bridge-test',
    },
  });
}

async function snapshotEnv() {
  const configKey = 'watcher-snapshot-config-key';
  const settings = new Map([
    ['channels', JSON.stringify([
      {
        id: 1,
        name: '个人微信',
        plugin_code: 'wxpay_receipt',
        pay_types: ['wxpay'],
        weight: 100,
        enabled: true,
      },
      {
        id: 2,
        name: '付呗',
        plugin_code: 'fubei_receipt',
        pay_types: ['wxpay'],
        weight: 100,
        enabled: true,
      },
    ])],
    ['plugin_config', await encryptSetting({
      wxpay_receipt: {
        sms_forwarder_secret: 'sms-secret',
        receipt_match_mode: 'remark',
        receipt_qrcode_image: `data:image/png;base64,${'A'.repeat(150_000)}`,
      },
      fubei_receipt: {
        watcher_username: 'fubei-user',
        watcher_password: 'fubei-password',
        receipt_terminal_no: 'terminal-1',
        receipt_qrcode_image: `data:image/png;base64,${'B'.repeat(150_000)}`,
      },
    }, configKey, 'plugin_config')],
  ]);
  return {
    WATCHER_TRANSPORT_SECRET: SNAPSHOT_SECRET,
    CONFIG_ENCRYPTION_KEY: configKey,
    DB: new MemoryDatabase(settings),
  };
}

test('watcher 快照按声明能力早筛并跳过过期扫描', async () => {
  const worker = createTestWorker();
  const env = await snapshotEnv();
  env.DB.payments.push(
    payment(1, { plugin_code: 'wxpay_receipt', channel_id: 1, epay_type: 'wxpay' }),
    payment(2, { plugin_code: 'fubei_receipt', channel_id: 2, epay_type: 'wxpay' }),
  );

  const response = await worker.fetch(await snapshotRequest('wxpay_receipt'), env, { waitUntil() {} });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.accounts.map((account) => account.plugin_code), ['wxpay_receipt']);
  assert.equal(payload.accounts[0].orders.length, 1);
  assert.equal(env.DB.queriedPluginCodes.has('wxpay_receipt'), true);
  assert.equal(env.DB.queriedPluginCodes.has('fubei_receipt'), false);
  assert.equal(env.DB.expireRuns, 0);
});

test('watcher 快照不下发大图配置并限制单插件订单数量', async () => {
  const worker = createTestWorker();
  const env = await snapshotEnv();
  for (let index = 1; index <= 250; index += 1) {
    env.DB.payments.push(payment(index, { plugin_code: 'wxpay_receipt', channel_id: 1, epay_type: 'wxpay' }));
  }

  const response = await worker.fetch(await snapshotRequest('wxpay_receipt'), env, { waitUntil() {} });
  const payload = await response.json();
  const account = payload.accounts[0];

  assert.equal(response.status, 200);
  assert.equal(account.orders.length, 200);
  assert.equal(account.config.receipt_qrcode_image, undefined);
  assert.equal(account.config.sms_forwarder_secret, 'sms-secret');
  assert.equal(account.config.plugin_code, 'wxpay_receipt');
  assert.ok(JSON.stringify(payload).length < 60_000);
});
