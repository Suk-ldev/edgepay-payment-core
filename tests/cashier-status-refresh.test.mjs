/**
 * 收银台状态接口的即时性合同。
 *
 * 线上表现：已付款订单直接重载能正确显示"支付成功"，但页面从"支付中"动态切到
 * "支付成功"的那一刻切不过去。两个原因叠在一起：
 *
 * 1. request-router.js 调了 workerPollerAvailable 却没导入它，订单还是 PAYING 时
 *    这一行必然抛 ReferenceError，状态接口直接 400。已付款订单因为短路掉这个判断
 *    才看起来正常——所以"重载能显示成功、动态切换不行"完全对得上。
 * 2. 就算能跑，查账原先是丢给 ctx.waitUntil 的，响应里带的仍是查账之前那个
 *    PAYING 快照。
 *
 * 这里把"响应必须反映查账之后的订单状态"钉成测试：轮询期间发生的任何状态变化，
 * 都要出现在同一次响应里。回退任意一个修复，这组测试都会红。
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

test('轮询期间确认到账时，同一次状态响应就返回支付成功', async () => {
  let polled = false;
  const { worker, env, database } = await fixture({
    onPoll(db) {
      polled = true;
      db.payment.status = 'PAID';
      db.payment.paid_at = '2026-08-26T10:00:30.000Z';
      db.payment.provider_trade_no = 'fake_trade_1';
    },
  });

  const data = await readStatus(worker, env);

  assert.equal(polled, true, '状态接口必须真的触发一次 Worker 查账');
  // 修复前这里是"支付中"：响应用的是查账之前那个订单快照，
  // 前端要等下一轮 2 秒轮询才可能看到成功，页面就卡在"支付中"。
  assert.equal(data.status_text, '支付成功');
  assert.equal(data.status, 2);
  assert.equal(database.payment.status, 'PAID');
});

test('轮询没查到到账时状态保持支付中，不会误报成功', async () => {
  let polled = false;
  const { worker, env } = await fixture({ onPoll() { polled = true; } });

  const data = await readStatus(worker, env);

  assert.equal(polled, true);
  assert.equal(data.status_text, '支付中');
  assert.equal(data.status, 1);
});

test('查账抛错不会让状态接口失败，仍按当前订单状态回答', async () => {
  const { worker, env } = await fixture({
    onPoll() { throw new Error('平台登录失效'); },
  });

  const data = await readStatus(worker, env);

  assert.equal(data.status_text, '支付中');
  assert.equal(data.pay_no, PAY_NO);
});
