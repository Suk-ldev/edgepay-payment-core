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
      this.sql.push(sql.replace(/\s+/gu, ' ').trim().slice(0, 2000));
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
  const db = countingDb({ open_payments: 0, grace_payments: 0, due_notifications: 0, silent_watchers: 0 });
  const pending = [];
  await worker.scheduled({ cron: '* * * * *' }, env(db), { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);

  assert.equal(db.sql.length, 1, `空跑应该只有一次查询，实际 ${db.sql.length} 次：${db.sql.join(' | ')}`);
  // 那一次必须是计数探测：数订单、数待发通知、数沉默的监听器，
  // 而不是解密密钥或读插件配置。
  assert.match(db.sql[0], /SELECT COUNT/u);
  assert.match(db.sql[0], /payment_attempts/u);
  assert.doesNotMatch(db.sql[0], /plugin_config/u);
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

test('监听器掉线也能唤醒 cron——哪怕一张待支付订单都没有', async () => {
  // 这正是掉线告警最该发出的时刻：没有单在跑，谁也不会注意到监听器已经没了。
  // 掉线检测并在同一条计数查询里，所以空跑仍然只有一次查询。
  const db = countingDb({ open_payments: 0, grace_payments: 0, due_notifications: 0, silent_watchers: 1 });
  const pending = [];
  await worker.scheduled({ cron: '* * * * *' }, env(db), { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.ok(db.sql.length > 1, '有监听器掉线时不该提前返回');
  assert.ok(
    db.sql.some((sql) => /runtime_settings/u.test(sql)),
    '应当去读 presence 行，把掉线的实例找出来',
  );
});

test('计数查询同时问出待办和掉线，空跑不额外加查询', async () => {
  const db = countingDb({ open_payments: 0, grace_payments: 0, due_notifications: 0, silent_watchers: 0 });
  const pending = [];
  await worker.scheduled({ cron: '* * * * *' }, env(db), { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(db.sql.length, 1, '掉线检测不该额外多一次查询');
  // 同一条里既数订单，也数沉默的监听器
  assert.match(db.sql[0], /open_payments/u);
  assert.match(db.sql[0], /silent_watchers/u);
});
