import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { acquirePollLease, releasePollLease } from '../src/receipt-poller.js';
import { buildWorkerFubeiQuery, normalizeWorkerFubeiRecords, queryWorkerFubei } from '../src/free-plugins/fubei-receipt.js';
import { queryWorkerShouqianba } from '../src/free-plugins/shouqianba-receipt.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('Worker 付呗查询沿用 watcher 的时间窗、终端与成功流水过滤', async () => {
  const now = Date.parse('2026-07-27T14:05:00Z') / 1_000;
  const orders = [{
    created_at: '2026-07-27T13:50:00.000Z',
    expire_at: '2026-07-27T14:10:00.000Z',
  }];
  const query = buildWorkerFubeiQuery(orders, now);
  assert.equal(query.window.start, Date.parse('2026-07-27T13:45:00.000Z') / 1_000);
  assert.equal(new URLSearchParams(query.body).get('length'), '100');

  let cookieHeader = '';
  const result = await queryWorkerFubei({
    config: {
      watcher_username: 'account',
      watcher_password: 'password',
      receipt_terminal_no: 'TERMINAL-1',
    },
    orders,
  }, { cookies: [['sid', 'existing']] }, async (_url, options) => {
    cookieHeader = String(options.headers.cookie ?? '');
    return new Response(JSON.stringify({
      status: 'ok',
      data: [{
        order_sn: 'FB-1',
        pay_type: 1,
        order_sumprice: '0.01',
        device_no: 'TERMINAL-1',
        pay_time: now,
        pay_status: '1',
        type: '1',
      }],
    }), { headers: { 'content-type': 'application/json', 'set-cookie': 'sid=renewed; Path=/' } });
  });
  assert.equal(cookieHeader, 'sid=existing');
  assert.equal(result.records[0].order_no, 'FB-1');
  assert.deepEqual(result.state.cookies, [['sid', 'renewed']]);
  assert.equal(result.details.normalized, 1);

  const normalized = normalizeWorkerFubeiRecords([{
    order_sn: 'FB-WRONG',
    pay_type: 1,
    order_sumprice: '0.01',
    device_no: 'TERMINAL-2',
    pay_time: now,
    pay_status: '1',
    type: '1',
  }], 'TERMINAL-1');
  assert.equal(normalized.records.length, 0);

  const bank = normalizeWorkerFubeiRecords([{
    order_sn: 'FB-BANK',
    pay_type: 3,
    order_sumprice: '1.00',
    device_no: 'TERMINAL-1',
    pay_time: now,
    pay_status: '1',
    type: '1',
  }], 'TERMINAL-1');
  assert.equal(bank.records.length, 0);
});
test('收钱吧沿用 MPay 免挂机登录与 Token 流水查询', async () => {
  const now = Math.floor(Date.now() / 1_000);
  const paths = [];
  const result = await queryWorkerShouqianba({
    config: { watcher_username: 'merchant', watcher_password: 'plain-password' },
    orders: [{ created_at: new Date((now - 30) * 1_000).toISOString(), expire_at: new Date((now + 300) * 1_000).toISOString() }],
  }, {}, async (url, options) => {
    paths.push(new URL(url).pathname);
    if (new URL(url).pathname.endsWith('/login')) {
      const payload = JSON.parse(options.body);
      assert.notEqual(payload.password, 'plain-password');
      return Response.json({ code: 50000, data: { code: 50000, mchUserTokenInfo: { token: 'sqb-token' } } });
    }
    assert.match(String(url), /token=sqb-token/u);
    return Response.json({
      code: 50000,
      data: { records: [{ order_sn: 'SQB-1', payway: 2, original_amount: 123, terminal_sn: 'T-1', status: '2000' }] },
    });
  });
  assert.deepEqual(paths, ['/api/login/ucUser/login', '/api/transaction/findTransactions']);
  assert.equal(result.records[0].pay_type, 'alipay');
  assert.equal(result.records[0].price, '1.23');
  assert.equal(result.state.token, 'sqb-token');
});

class LeaseDatabase {
  constructor() {
    this.rows = new Map();
  }

  prepare(sql) {
    return {
      bind: (...params) => ({
        run: async () => {
          if (sql.includes('INSERT INTO runtime_settings')) {
            const [key, value, expiresAt, now] = params;
            const current = this.rows.get(key);
            if (current && current.updatedAt > now) return { meta: { changes: 0 } };
            this.rows.set(key, { value, updatedAt: expiresAt });
            return { meta: { changes: 1 } };
          }
          const [value, nextAt, key, expected] = params;
          const current = this.rows.get(key);
          if (!current || current.value !== expected) return { meta: { changes: 0 } };
          this.rows.set(key, { value, updatedAt: nextAt });
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

test('Worker 轮询锁阻止同一插件并发，但释放后允许下一轮接管', async () => {
  const env = { DB: new LeaseDatabase() };
  const now = new Date();
  const first = await acquirePollLease(env, 'fubei_receipt', 30, now);
  const second = await acquirePollLease(env, 'fubei_receipt', 30, now);
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  await releasePollLease(env, first, 0);
  const third = await acquirePollLease(
    env,
    'fubei_receipt',
    30,
    new Date(Date.now() + 1_000),
  );
  assert.equal(third.acquired, true);
});
