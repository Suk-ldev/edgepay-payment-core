import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginRegistry, freePlugins, RUNTIME_KEY } from '../src/index.js';
import { checkWatcherLiveness, watcherFailoverMessage } from '../src/core/request-router.js';
import {
  planWatcherFailovers, reconcileWatcherFailoverState,
} from '../src/watcher-failover.js';

const registry = createPluginRegistry(freePlugins);
const runtime = {
  registry,
  license: {
    async state() {
      return { plugins: registry.manifests().map(({ code }) => code) };
    },
  },
};
const pluginConfig = {
  fubei_receipt: { enabled: true },
  wxpay_receipt: { enabled: true },
  'wxpay_receipt~2': { enabled: true, instance_name: '微信个人收款监听2' },
  wechat_api: { enabled: true },
};

function channel(id, name, pluginCode, payType = 'wxpay', overrides = {}) {
  return {
    id,
    name,
    plugin_code: pluginCode,
    pay_types: [payType],
    weight: 100,
    enabled: true,
    sort: id,
    ...overrides,
  };
}

function stale(kind, plugins, channelIds = [], key = kind) {
  return { key, kind, plugins, channelIds, silentMs: 125_000 };
}

function runtimeDb(rows) {
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          const row = rows.get(String(this.values[0] ?? ''));
          return row ? { value_text: row.value_text } : null;
        },
        async all() {
          return {
            results: [...rows.entries()]
              .filter(([key]) => key === 'watcher_presence' || key.startsWith('watcher_presence:'))
              .map(([settingKey, row]) => ({ setting_key: settingKey, ...row })),
          };
        },
        async run() {
          if (sql.includes('DELETE FROM runtime_settings')) {
            const deleted = rows.delete(String(this.values[0]));
            return { meta: { changes: deleted ? 1 : 0 } };
          }
          if (sql.includes("VALUES ('channels', ?, ?)")) {
            rows.set('channels', {
              value_text: String(this.values[0]),
              updated_at: String(this.values[1]),
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO runtime_settings')) {
            rows.set(String(this.values[0]), {
              value_text: String(this.values[1]),
              updated_at: String(this.values[2]),
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

test('Docker 监听器掉线但有 Worker 后备时只告警，不停用通道', () => {
  const channels = [channel(3, '付呗微信码牌', 'fubei_receipt')];
  const plan = planWatcherFailovers(
    registry,
    pluginConfig,
    channels,
    [stale('docker', ['fubei_receipt'])],
  );

  assert.deepEqual(plan.disabledChannelIds, []);
  assert.equal(plan.nextChannels[0].enabled, true);
  assert.deepEqual(plan.items[0].channelsWithWorkerBackup.map(({ id }) => id), [3]);
  assert.deepEqual(plan.items[0].channelsToDisable, []);
  const message = watcherFailoverMessage(
    registry,
    pluginConfig,
    plan.items[0],
    plan.remainingByPayType,
  );
  assert.match(message, /^Docker监听器已2分钟没有上报/u);
  assert.match(message, /存在 Worker 后备，仅上报告警、不停用通道/u);
  assert.match(message, /#3付呗微信码牌/u);
});

test('Android 监听掉线且无 Worker 后备时停用确切通道并上报剩余通道数', () => {
  const channels = [
    channel(9, '微信个人收款监听2', 'wxpay_receipt~2'),
    channel(10, '微信官方支付', 'wechat_api'),
    channel(11, '零权重备用', 'wechat_api', 'wxpay', { weight: 0 }),
    channel(12, '原已停用', 'wxpay_receipt', 'wxpay', { enabled: false }),
  ];
  const plan = planWatcherFailovers(
    registry,
    pluginConfig,
    channels,
    [stale('android', ['wxpay_receipt~2'], [9])],
  );

  assert.deepEqual(plan.disabledChannelIds, [9]);
  assert.equal(plan.nextChannels.find(({ id }) => id === 9).enabled, false);
  assert.equal(plan.nextChannels.find(({ id }) => id === 10).enabled, true);
  assert.equal(plan.remainingByPayType.wxpay, 1, '零权重和已停用通道都不算可用');
  const message = watcherFailoverMessage(
    registry,
    pluginConfig,
    plan.items[0],
    plan.remainingByPayType,
  );
  assert.match(message, /^Android到账监听已2分钟没有上报/u);
  assert.match(message, /这期间以下通道的到账不会被确认，已自动停用/u);
  assert.match(message, /#9微信个人收款监听2（微信个人收款监听2 · 配置1）/u);
  assert.match(message, /微信支付剩余可用通道数：1/u);
});

test('监听实例掉线但同一通道仍被其他在线实例覆盖时不停止通道', () => {
  const channels = [channel(9, '微信个人收款监听2', 'wxpay_receipt~2')];
  const plan = planWatcherFailovers(
    registry,
    pluginConfig,
    channels,
    [stale('android', ['wxpay_receipt~2'], [9], 'android-old')],
    {
      liveWatchers: [{
        key: 'android-backup', kind: 'android', plugins: ['wxpay_receipt~2'], channelIds: [9],
      }],
    },
  );

  assert.deepEqual(plan.disabledChannelIds, []);
  assert.equal(plan.nextChannels[0].enabled, true);
  assert.deepEqual(plan.items[0].channelsWithListenerBackup.map(({ id }) => id), [9]);
  const message = watcherFailoverMessage(
    registry,
    pluginConfig,
    plan.items[0],
    plan.remainingByPayType,
  );
  assert.match(message, /仍有其他在线监听实例覆盖，仅上报告警、不停用通道/u);
});

test('应用宝未上报通道 ID 时按插件及其副本停用，多个故障按最终状态计数', () => {
  const channels = [
    channel(8, '微信个人主号', 'wxpay_receipt'),
    channel(9, '微信个人副号', 'wxpay_receipt~2'),
    channel(10, '微信官方支付', 'wechat_api'),
  ];
  const plan = planWatcherFailovers(
    registry,
    pluginConfig,
    channels,
    [
      stale('yyb_bridge', ['wxpay_receipt'], [], 'yyb-main'),
      stale('android', ['wxpay_receipt~2'], [9], 'android-second'),
    ],
  );

  assert.deepEqual(plan.disabledChannelIds, [8, 9]);
  assert.equal(plan.remainingByPayType.wxpay, 1);
  assert.deepEqual(plan.items[0].channelsToDisable.map(({ id }) => id), [8, 9]);
  assert.deepEqual(plan.items[1].channelsToDisable.map(({ id }) => id), [9]);
  const message = watcherFailoverMessage(
    registry,
    pluginConfig,
    plan.items[0],
    plan.remainingByPayType,
  );
  assert.match(message, /^应用宝监听已2分钟没有上报/u);
  assert.match(message, /#8微信个人主号/u);
  assert.match(message, /#9微信个人副号/u);
  assert.match(message, /微信支付剩余可用通道数：1/u);
});

test('掉线巡检会把无 Worker 后备的通道停用并写回运行配置', async () => {
  const now = Date.parse('2026-09-04T12:00:00.000Z');
  const rows = new Map([
    ['channels', {
      value_text: JSON.stringify([
        channel(9, '微信个人收款监听2', 'wxpay_receipt~2'),
        channel(10, '微信官方支付', 'wechat_api'),
      ]),
      updated_at: new Date(now - 60_000).toISOString(),
    }],
    ['watcher_presence:id:android-9-phone', {
      value_text: JSON.stringify({
        plugins: ['wxpay_receipt~2'],
        polling: false,
        kind: 'android',
        channel_ids: [9],
      }),
      updated_at: new Date(now - 125_000).toISOString(),
    }],
  ]);
  const db = runtimeDb(rows);

  await checkWatcherLiveness({ DB: db, [RUNTIME_KEY]: runtime }, now);

  const stored = JSON.parse(rows.get('channels').value_text);
  assert.equal(stored.find(({ id }) => id === 9).enabled, false);
  assert.equal(stored.find(({ id }) => id === 10).enabled, true);
  // 新模型不记实例键归属，只记停用时间；通道 9 被认领，状态行存在即可。
  assert.ok(rows.get('watcher_failover_state').value_text.includes('"9"'), '通道 9 应处于自动停用状态');
});

test('监听器重新上线后只恢复自动停用通道，原本手动禁用的通道保持关闭', async () => {
  const now = Date.parse('2026-09-04T12:10:00.000Z');
  const owner = 'id:android-9-phone';
  const rows = new Map([
    ['channels', {
      value_text: JSON.stringify([
        channel(9, '自动停用', 'wxpay_receipt~2', 'wxpay', { enabled: false }),
        channel(12, '手动停用', 'wxpay_receipt', 'wxpay', { enabled: false }),
      ]),
      updated_at: new Date(now - 60_000).toISOString(),
    }],
    ['watcher_failover_state', {
      value_text: JSON.stringify({
        version: 1,
        channels: {
          9: { failures: [owner], disabled_at: new Date(now - 300_000).toISOString() },
        },
      }),
      updated_at: new Date(now - 60_000).toISOString(),
    }],
    [`watcher_presence:${owner}`, {
      value_text: JSON.stringify({
        plugins: ['wxpay_receipt~2'], polling: false, kind: 'android', channel_ids: [9],
      }),
      updated_at: new Date(now - 30_000).toISOString(),
    }],
  ]);

  await checkWatcherLiveness({ DB: runtimeDb(rows), [RUNTIME_KEY]: runtime }, now);

  const stored = JSON.parse(rows.get('channels').value_text);
  assert.equal(stored.find(({ id }) => id === 9).enabled, true, '系统自动停用的通道应恢复');
  assert.equal(stored.find(({ id }) => id === 12).enabled, false, '手动停用的通道不能恢复');
  assert.equal(rows.has('watcher_failover_state'), false, '恢复完成后应清除自动停用状态');
});

test('同一通道有在线实例覆盖时不再继续停用，掉线实例仍认领时保持停用', () => {
  const state = {
    version: 1,
    channels: {
      9: { failures: ['watcher-b'], disabled_at: '2026-09-04T12:00:00.000Z' },
    },
  };
  const affected = channel(9, '微信个人收款监听2', 'wxpay_receipt~2', 'wxpay', { enabled: false });
  // 仍掉线的实例本轮重新认领通道 9：即使同时有别的实例在线覆盖，
  // 报警与恢复不在同一轮打架，通道保持停用。
  const stillClaimed = reconcileWatcherFailoverState(state, {
    items: [{
      item: stale('android', ['wxpay_receipt~2'], [9], 'watcher-b'),
      channelsToDisable: [affected],
    }],
  }, [{ key: 'watcher-a', plugins: ['wxpay_receipt~2'], channelIds: [9], kind: 'android' }], new Date(), [affected]);
  assert.deepEqual(stillClaimed.restoreChannelIds, []);
  assert.ok(stillClaimed.state.channels['9'], '被认领的通道保持停用状态');

  // 认领结束（掉线实例恢复或消失）：通道恢复，状态清空。
  const allRecovered = reconcileWatcherFailoverState(stillClaimed.state, { items: [] }, [
    { key: 'watcher-b', plugins: ['wxpay_receipt~2'], channelIds: [9], kind: 'android' },
  ], new Date(), [affected]);
  assert.deepEqual(allRecovered.restoreChannelIds, [9]);
  assert.deepEqual(allRecovered.state.channels, {});
});

// 实例 ID 会变的监听端（PC 端每次启动换一个短 hash）：掉线时通道按当时的键
// 停用，重启后新 ID 正常在线、旧 ID 永远不会回来。恢复按"通道现在有没有人
// 管"判断，与实例 ID 无关，新 ID 一上线通道就恢复，不会被旧键永久锁住。
test('换 ID 上线的新实例覆盖通道即恢复，旧实例键不再阻塞', () => {
  const state = {
    version: 1,
    channels: {
      10: { failures: ['id:pc-10-edgepaypc-8f3a21'], disabled_at: '2026-10-24T01:39:18.753Z' },
    },
  };
  const affected = channel(10, '微信个人收款监听pc test', 'wxpay_receipt~2', 'wxpay', { enabled: false });

  // 没人在线覆盖：通道保持停用（实例还在掉线）。
  const uncovered = reconcileWatcherFailoverState(state, { items: [] }, [], new Date(), [affected]);
  assert.deepEqual(uncovered.restoreChannelIds, []);

  // 新 ID 的实例上线（旧 ID 从未回来）：通道按覆盖恢复。
  const recovered = reconcileWatcherFailoverState(uncovered.state, { items: [] }, [
    { key: 'id:pc-10-edgepaypc-ed0c4f0db4fc', plugins: ['wxpay_receipt~2'], channelIds: [10], kind: 'pc' },
  ], new Date(), [affected]);
  assert.deepEqual(recovered.restoreChannelIds, [10]);
  assert.deepEqual(recovered.state.channels, {});
});

// 双监听器：1 号监通道 1、2 号监通道 2，两号都掉线时两个通道都停用。
// 2 号隔了很久才回来（换了设备、ID 变了），1 号始终没上线：只恢复 2 号
// 监听的通道 2，通道 1 没有任何人覆盖，继续停用。
test('双监听器只恢复有在线覆盖的通道，无人管的通道继续停用', () => {
  const now = Date.parse('2026-10-24T03:00:00.000Z');
  const state = {
    version: 1,
    channels: {
      1: { failures: ['id:android-1-phone-aaaa'], disabled_at: '2026-10-24T01:00:00.000Z' },
      2: { failures: ['id:pc-2-pcwatcher-bbbb'], disabled_at: '2026-10-24T01:00:00.000Z' },
    },
  };
  const channelOne = channel(1, '个人微信1', 'wxpay_receipt', 'wxpay', { enabled: false });
  const channelTwo = channel(2, '个人微信2', 'wxpay_receipt~2', 'wxpay', { enabled: false });
  const result = reconcileWatcherFailoverState(state, { items: [] }, [
    { key: 'id:pc-2-pcwatcher-cccc', plugins: ['wxpay_receipt~2'], channelIds: [2], kind: 'pc' },
  ], now, [channelOne, channelTwo]);

  assert.deepEqual(result.restoreChannelIds, [2], '只恢复有在线覆盖的通道');
  assert.ok(result.state.channels['1'], '通道 1 无人覆盖，继续停用');
  assert.equal(result.state.channels['2'], undefined);
});
