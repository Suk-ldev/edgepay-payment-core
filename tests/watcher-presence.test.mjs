import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { onlineWatcherPlugins, presenceKey, recordWatcherPresence } from '../src/watcher-presence.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

/** 只实现 runtime_settings 上这几条语句的内存版 D1。 */
function memoryDb(rows = new Map()) {
  return {
    rows,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return null; },
        async all() {
          if (!sql.includes('SELECT value_text')) return { results: [] };
          const like = String(this.values[0]).replace(/%/gu, '');
          const results = [...rows.entries()]
            .filter(([key]) => key === 'watcher_presence' || key.startsWith(like))
            .map(([, row]) => row);
          return { results };
        },
        async run() {
          if (sql.includes('INSERT INTO runtime_settings')) {
            const [key, value, updatedAt, throttleBefore, sameValue] = this.values.map(String);
            const existing = rows.get(key);
            // 节流条件与真实 SQL 的 WHERE 一致：内容变了，或者上次写入已经够久。
            if (!existing || existing.value_text !== sameValue || existing.updated_at <= throttleBefore) {
              rows.set(key, { value_text: value, updated_at: updatedAt });
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM runtime_settings')) {
            const like = String(this.values[0]).replace(/%/gu, '');
            const before = String(this.values[1]);
            for (const [key, row] of [...rows.entries()]) {
              if (key.startsWith(like) && row.updated_at < before) rows.delete(key);
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

test('自报实例 ID 时按 ID 分行，不自报时按能力集分行', async () => {
  assert.equal(await presenceKey('bridge-1', ['wxpay_receipt']), 'watcher_presence:id:bridge-1');
  // 非法 ID 一律退回能力集分桶，别让调用方用奇怪的键污染 runtime_settings。
  const injected = await presenceKey('../../etc/passwd', ['wxpay_receipt']);
  assert.match(injected, /^watcher_presence:set:[0-9a-f]{32}$/u);
  // 能力集顺序不同不该分成两行。
  assert.equal(
    await presenceKey('', ['a_receipt', 'b_receipt']),
    await presenceKey('', ['b_receipt', 'a_receipt']),
  );
  assert.notEqual(await presenceKey('', ['a_receipt']), await presenceKey('', ['b_receipt']));
});

test('两个 Watcher 同时在线时取并集，不再互相覆盖', async () => {
  const env = { DB: memoryDb() };
  // 官方镜像负责渠道流水
  await recordWatcherPresence(env, await presenceKey('', ['fubei_receipt', 'alipay_bill_receipt']), ['fubei_receipt', 'alipay_bill_receipt'], NOW);
  // 桥接器负责个人收款
  await recordWatcherPresence(env, await presenceKey('yyb-bridge', ['wxpay_receipt']), ['wxpay_receipt'], NOW);

  const online = await onlineWatcherPlugins(env, NOW);
  assert.deepEqual([...online].sort(), ['alipay_bill_receipt', 'fubei_receipt', 'wxpay_receipt']);

  // 再来一轮，谁也不该把谁挤掉。
  await recordWatcherPresence(env, await presenceKey('', ['fubei_receipt', 'alipay_bill_receipt']), ['fubei_receipt', 'alipay_bill_receipt'], NOW + 1_000);
  assert.deepEqual(
    [...await onlineWatcherPlugins(env, NOW + 1_000)].sort(),
    ['alipay_bill_receipt', 'fubei_receipt', 'wxpay_receipt'],
  );
});

test('超过 TTL 的实例退出并集，其余不受影响', async () => {
  const env = { DB: memoryDb() };
  await recordWatcherPresence(env, 'watcher_presence:id:stale', ['fubei_receipt'], NOW);
  await recordWatcherPresence(env, 'watcher_presence:id:live', ['wxpay_receipt'], NOW + 100_000);

  // stale 已经 130 秒没上报
  const online = await onlineWatcherPlugins(env, NOW + 130_000);
  assert.deepEqual([...online], ['wxpay_receipt']);
});

test('升级后旧版单行 watcher_presence 仍然被认，直到它自己过期', async () => {
  const rows = new Map([['watcher_presence', {
    value_text: JSON.stringify({ plugins: ['fubei_receipt'] }),
    updated_at: new Date(NOW).toISOString(),
  }]]);
  const env = { DB: memoryDb(rows) };
  await recordWatcherPresence(env, 'watcher_presence:id:bridge', ['wxpay_receipt'], NOW);
  assert.deepEqual(
    [...await onlineWatcherPlugins(env, NOW)].sort(),
    ['fubei_receipt', 'wxpay_receipt'],
    '刚部署完不该出现一轮「所有 Watcher 都不在线」',
  );
  // 旧行随 TTL 自然退场，不需要人工清理。
  assert.deepEqual([...await onlineWatcherPlugins(env, NOW + 130_000)], []);
});

test('早就离线的实例行会被清掉，键不会无限增长', async () => {
  const env = { DB: memoryDb() };
  await recordWatcherPresence(env, 'watcher_presence:id:gone', ['fubei_receipt'], NOW);
  assert.equal(env.DB.rows.has('watcher_presence:id:gone'), true);
  // 11 分钟后再有实例上报，顺手扫掉超过 10 分钟没动静的行
  await recordWatcherPresence(env, 'watcher_presence:id:live', ['wxpay_receipt'], NOW + 660_000);
  assert.equal(env.DB.rows.has('watcher_presence:id:gone'), false);
  assert.equal(env.DB.rows.has('watcher_presence:id:live'), true);
});

test('坏掉的行被跳过，不影响其他实例', async () => {
  const rows = new Map([
    ['watcher_presence:id:broken', { value_text: '{ 不是 JSON', updated_at: new Date(NOW).toISOString() }],
    ['watcher_presence:id:shaped', { value_text: JSON.stringify({ plugins: 'not-an-array' }), updated_at: new Date(NOW).toISOString() }],
    ['watcher_presence:id:ok', { value_text: JSON.stringify({ plugins: ['wxpay_receipt'] }), updated_at: new Date(NOW).toISOString() }],
  ]);
  assert.deepEqual([...await onlineWatcherPlugins({ DB: memoryDb(rows) }, NOW)], ['wxpay_receipt']);
});
