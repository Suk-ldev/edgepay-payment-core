/**
 * 收银台状态接口只读订单，不承担查账。
 *
 * Worker 内置查账由带 POLL_TRIGGER_TOKEN 的外部计划任务触发；Docker 通道由
 * Watcher 快照链路处理。浏览器只能定时读取 D1 中已经确认的状态，不能借公开接口
 * 绕过触发凭据执行渠道查询。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { createTestWorker, allowAllPlugins, licenseAllowing } = await import('./helpers/worker.mjs');
const { fakeReceiptPlugin } = await import('./helpers/fake-plugins.mjs');
const { encryptSetting } = await import('../src/runtime-settings.js');

const PLUGIN_CODE = 'fake_receipt';
const CONFIG_KEY = 'test-config-encryption-key';
const PAY_NO = 'p_statusrefresh';

class Statement {
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
    const { database } = this;
    if (this.sql.includes("setting_key = 'watcher_presence'")) return null;
    if (this.sql.includes('FROM runtime_settings')) {
      const value = database.settings.get(String(this.values[0]));
      return value === undefined ? null : { value_text: value, updated_at: database.payment.updated_at };
    }
    if (this.sql.includes('WHERE payment_no = ?')) {
      return database.payment.payment_no === this.values[0] ? { ...database.payment } : null;
    }
    return null;
  }

  async all() {
    if (this.sql.includes('FROM payment_attempts')) {
      return { results: this.database.payment.status === 'PAYING' ? [{ ...this.database.payment }] : [] };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes('INTO runtime_settings')) {
      this.database.settings.set(String(this.values[0]), String(this.values[1]));
      return { meta: { changes: 1 } };
    }
    // 订单只在到期时才会被过期任务改写，本用例的 expires_at 在很远的将来。
    return { meta: { changes: 0 } };
  }
}

class Database {
  constructor(payment, settings) {
    this.payment = payment;
    this.settings = settings;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }
}

async function fixture({ onPoll } = {}) {
  const payment = {
    payment_no: PAY_NO,
    external_order_no: 'ORDER-STATUS-REFRESH-1',
    plugin_code: PLUGIN_CODE,
    expected_amount_fen: 1500,
    currency: 'CNY',
    status: 'PAYING',
    notify_url: 'https://merchant.example/notify',
    return_url: '',
    provider_trade_no: '',
    paid_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-08-26T10:00:00.000Z',
    updated_at: '2026-08-26T10:00:00.000Z',
    metadata_json: JSON.stringify({ channel_id: 1, epay_type: 'alipay' }),
  };
  const settings = new Map([
    ['channels', JSON.stringify([{
      id: 1, name: '假收款码牌', plugin_code: PLUGIN_CODE, pay_types: ['alipay'], weight: 100, enabled: true, sort: 0,
    }])],
    ['plugin_config', await encryptSetting(
      { [PLUGIN_CODE]: { receipt_qrcode_image: 'data:image/png;base64,iVBORw0KGgo=', enabled: true } },
      CONFIG_KEY,
      'plugin_config',
    )],
  ]);
  const database = new Database(payment, settings);
  const worker = createTestWorker({
    plugins: [fakeReceiptPlugin(PLUGIN_CODE, {
      name: '假收款监听',
      payTypes: ['alipay'],
      onPoll: onPoll ? () => onPoll(database) : null,
    })],
    authorizePlugin: allowAllPlugins,
    license: licenseAllowing([PLUGIN_CODE]),
  });
  const env = {
    DB: database,
    CONFIG_ENCRYPTION_KEY: CONFIG_KEY,
    ADMIN_TOKEN: 'admin-token',
    ADMIN_USERNAME: 'admin',
    EPAY_PID: '1000',
    EPAY_KEY: 'epay-key',
    POLL_TRIGGER_TOKEN: 'poll-trigger-token',
    PUBLIC_BASE_URL: 'https://pay.example',
  };
  return { worker, env, database };
}

async function readStatus(worker, env) {
  const response = await worker.fetch(
    new Request(`https://pay.example/api/cashier/pay-order-status?pay_no=${PAY_NO}`),
    env,
    { waitUntil() {} },
  );
  return (await response.json()).data;
}

async function triggerReceiptPoll(worker, env) {
  return worker.fetch(
    new Request(`https://pay.example/internal/receipt-poll?token=${env.POLL_TRIGGER_TOKEN}`),
    env,
    { waitUntil() {} },
  );
}

test('收银台状态读取不会触发渠道查账', async () => {
  let polled = false;
  const { worker, env } = await fixture({ onPoll() { polled = true; } });

  const data = await readStatus(worker, env);

  assert.equal(polled, false, '公开状态接口不得执行渠道查账');
  assert.equal(data.status_text, '支付中');
  assert.equal(data.status, 1);
});

test('只有带 POLL_TRIGGER_TOKEN 的外部入口触发 Worker 查账', async () => {
  let polled = false;
  const { worker, env, database } = await fixture({
    onPoll(db) {
      polled = true;
      db.payment.status = 'PAID';
      db.payment.paid_at = '2026-08-26T10:00:30.000Z';
      db.payment.provider_trade_no = 'fake_trade_1';
    },
  });

  const pollResponse = await triggerReceiptPoll(worker, env);
  const data = await readStatus(worker, env);

  assert.equal(pollResponse.status, 200);
  assert.equal(polled, true);
  assert.equal(database.payment.status, 'PAID');
  assert.equal(data.status_text, '支付成功');
  assert.equal(data.status, 2);
});

test('错误的 POLL_TRIGGER_TOKEN 不能触发查账', async () => {
  let polled = false;
  const { worker, env } = await fixture({ onPoll() { polled = true; } });

  const response = await worker.fetch(
    new Request('https://pay.example/internal/receipt-poll?token=wrong'),
    env,
    { waitUntil() {} },
  );

  assert.equal(response.status, 401);
  assert.equal(polled, false);
});
