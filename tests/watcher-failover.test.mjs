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
  assert.deepEqual(JSON.parse(rows.get('watcher_failover_state').value_text).channels['9'].failures, [
    'id:android-9-phone',
  ]);
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

test('同一通道由多个故障实例共同停用时，要等全部实例恢复才自动打开', () => {
  const state = {
    version: 1,
    channels: {
      9: { failures: ['watcher-a', 'watcher-b'], disabled_at: '2026-09-04T12:00:00.000Z' },
    },
  };
  const affected = channel(9, '微信个人收款监听2', 'wxpay_receipt~2', 'wxpay', { enabled: false });
  const stillOffline = reconcileWatcherFailoverState(state, {
    items: [{
      item: stale('android', ['wxpay_receipt~2'], [9], 'watcher-b'),
      channelsToDisable: [affected],
    }],
  }, ['watcher-a']);
  assert.deepEqual(stillOffline.restoreChannelIds, []);
  assert.deepEqual(stillOffline.state.channels['9'].failures, ['watcher-b']);

  const allRecovered = reconcileWatcherFailoverState(stillOffline.state, { items: [] }, ['watcher-b']);
  assert.deepEqual(allRecovered.restoreChannelIds, [9]);
  assert.deepEqual(allRecovered.state.channels, {});
});
