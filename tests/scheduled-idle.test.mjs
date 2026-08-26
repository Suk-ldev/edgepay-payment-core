/**
 * cron 空跑的成本。
 *
 * 每分钟触发一次，绝大多数时候一单都没有。原来不管有没有事都要解密密钥、
 * 读通道与插件配置、查授权状态、扫两遍 payment_attempts——一天 1440 次白烧。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { createTestWorker } = await import('./helpers/worker.mjs');

/** 记录每一条 SQL，用来数这一轮到底碰了几次 D1。 */
function countingDb(counts) {
  return {
    sql: [],
    prepare(sql) {
      this.sql.push(sql.replace(/\s+/gu, ' ').trim().slice(0, 60));
      const db = this;
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return counts; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
  };
}

const worker = createTestWorker();
const env = (db) => ({
  DB: db, CONFIG_ENCRYPTION_KEY: 'k', ADMIN_TOKEN: 't', EPAY_KEY: 'e', PUBLIC_BASE_URL: 'https://pay.example',
});

test('没有待办时 cron 只查一次就返回，不碰密钥和配置', async () => {
  const db = countingDb({ open_payments: 0, grace_payments: 0, due_notifications: 0 });
  const pending = [];
  await worker.scheduled({ cron: '* * * * *' }, env(db), { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);

  assert.equal(db.sql.length, 1, `空跑应该只有一次查询，实际 ${db.sql.length} 次：${db.sql.join(' | ')}`);
  assert.match(db.sql[0], /SELECT/u);
  // 那一次必须是计数探测，不能是解密密钥或读配置。
  assert.doesNotMatch(db.sql[0], /runtime_settings/u);
});

test('有待支付订单时照常走完整轮询', async () => {
  const db = countingDb({ open_payments: 1, grace_payments: 0, due_notifications: 0 });
  const pending = [];
  await worker.scheduled({ cron: '* * * * *' }, env(db), { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.ok(db.sql.length > 1, '有活时不该提前返回');
});

test('三类待办各自都能把 cron 唤醒', async () => {
  for (const counts of [
    { open_payments: 0, grace_payments: 1, due_notifications: 0 },
    { open_payments: 0, grace_payments: 0, due_notifications: 1 },
  ]) {
    const db = countingDb(counts);
    const pending = [];
    await worker.scheduled({ cron: '* * * * *' }, env(db), { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.ok(db.sql.length > 1, `${JSON.stringify(counts)} 应该唤醒 cron`);
  }
});
