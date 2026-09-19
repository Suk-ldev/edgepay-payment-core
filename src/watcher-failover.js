/**
 * 监听端掉线后的通道处置计划。
 *
 * 这里保持纯计算：调用方负责读取/写入运行配置和发送告警，测试则可以直接覆盖
 * Docker、应用宝和 Android 三类实例，而不需要伪造整套 D1。
 */

import { pluginSupportsWorkerPoll } from './plugin-api.js';
import { basePluginCode } from './plugin-instances.js';
import { configForPlugin, pluginEnabled } from './core/plugin-config.js';

export const WATCHER_FAILOVER_STATE_KEY = 'watcher_failover_state';

function affectedChannels(channels, item, trackedChannelIds) {
  const channelIds = new Set((item.channelIds ?? []).map(Number));
  const basePlugins = new Set((item.plugins ?? []).map((code) => basePluginCode(code)));
  return channels.filter((channel) => {
    if (!channel.enabled && !trackedChannelIds.has(Number(channel.id))) return false;
    if (channelIds.size) return channelIds.has(Number(channel.id));
    return basePlugins.has(basePluginCode(channel.plugin_code));
  });
}

function pluginLicensed(licensedBaseCodes, pluginCode) {
  return !(licensedBaseCodes instanceof Set)
    || licensedBaseCodes.has(basePluginCode(pluginCode));
}

function workerBackupAvailable(registry, pluginConfig, channel, licensedBaseCodes) {
  const plugin = registry.get(channel.plugin_code);
  return Boolean(plugin)
    && pluginLicensed(licensedBaseCodes, channel.plugin_code)
    && pluginEnabled(registry, pluginConfig, channel.plugin_code)
    && pluginSupportsWorkerPoll(plugin, configForPlugin(pluginConfig, channel.plugin_code));
}

function liveWatcherCoversChannel(liveWatcher, channel) {
  const channelIds = new Set((liveWatcher?.channelIds ?? []).map(Number));
  if (channelIds.size) return channelIds.has(Number(channel.id));
  const basePlugins = new Set((liveWatcher?.plugins ?? []).map((code) => basePluginCode(code)));
  return basePlugins.has(basePluginCode(channel.plugin_code));
}

function channelAvailable(registry, pluginConfig, channel, licensedBaseCodes) {
  return channel.enabled
    && Number(channel.weight) > 0
    && Boolean(registry.get(channel.plugin_code))
    && pluginLicensed(licensedBaseCodes, channel.plugin_code)
    && pluginEnabled(registry, pluginConfig, channel.plugin_code);
}

export function countAvailableChannelsByPayType(
  registry,
  pluginConfig,
  channels,
  payTypes,
  licensedBaseCodes,
) {
  return Object.fromEntries([...payTypes].map((payType) => [
    payType,
    channels.filter((channel) => (
      channelAvailable(registry, pluginConfig, channel, licensedBaseCodes)
      && (channel.pay_types ?? []).includes(payType)
    )).length,
  ]));
}

export function normalizeWatcherFailoverState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const channels = {};
  for (const [rawId, rawState] of Object.entries(source.channels ?? {})) {
    const channelId = Number(rawId);
    if (!Number.isSafeInteger(channelId) || channelId <= 0) continue;
    const failures = [...new Set((rawState?.failures ?? [])
      .map((key) => String(key ?? '').trim())
      .filter(Boolean))].sort();
    if (!failures.length) continue;
    channels[String(channelId)] = {
      failures,
      disabled_at: String(rawState?.disabled_at ?? ''),
    };
  }
  return { version: 1, channels };
}

export function trackedWatcherFailoverChannelIds(state) {
  return new Set(Object.keys(normalizeWatcherFailoverState(state).channels).map(Number));
}

/**
 * 在线实例先解除自己的故障归属；本轮仍离线且无 Worker 后备的实例再重新认领。
 * 归属清空的通道才允许自动恢复，避免一个监听器恢复就误开另一个仍故障的通道。
 */
export function reconcileWatcherFailoverState(state, failovers, liveKeys, now = Date.now()) {
  const normalized = normalizeWatcherFailoverState(state);
  const live = new Set((liveKeys ?? []).map(String));
  const evaluated = new Set(failovers.items.map(({ item }) => String(item.key)));
  const channels = Object.fromEntries(Object.entries(normalized.channels).map(([channelId, entry]) => [
    channelId,
    {
      ...entry,
      failures: entry.failures.filter((key) => !live.has(key) && !evaluated.has(key)),
    },
  ]));

  for (const { item, channelsToDisable } of failovers.items) {
    for (const channel of channelsToDisable) {
      const channelId = String(channel.id);
      const current = channels[channelId] ?? {
        failures: [],
        disabled_at: new Date(now).toISOString(),
      };
      current.failures = [...new Set([...current.failures, String(item.key)])].sort();
      channels[channelId] = current;
    }
  }

  const restoreChannelIds = [];
  for (const [channelId, entry] of Object.entries(channels)) {
    if (entry.failures.length) continue;
    restoreChannelIds.push(Number(channelId));
    delete channels[channelId];
  }
  restoreChannelIds.sort((left, right) => left - right);
  return { state: { version: 1, channels }, restoreChannelIds };
}

/**
 * 一轮内统一计算全部故障实例，确保多个监听端同时掉线时，剩余通道数按最终状态统计。
 */
export function planWatcherFailovers(registry, pluginConfig, channels, staleItems, options = {}) {
  const sourceChannels = Array.isArray(channels) ? channels : [];
  const trackedChannelIds = options.trackedChannelIds instanceof Set
    ? options.trackedChannelIds
    : new Set();
  const liveWatchers = Array.isArray(options.liveWatchers) ? options.liveWatchers : [];
  const { licensedBaseCodes } = options;
  const channelIdsToDisable = new Set();
  const items = (staleItems ?? []).map((item) => {
    const affected = affectedChannels(sourceChannels, item, trackedChannelIds);
    const channelsWithListenerBackup = [];
    const channelsWithWorkerBackup = [];
    const channelsToDisable = [];
    for (const channel of affected) {
      if (liveWatchers.some((watcher) => liveWatcherCoversChannel(watcher, channel))) {
        channelsWithListenerBackup.push(channel);
      } else if (workerBackupAvailable(registry, pluginConfig, channel, licensedBaseCodes)) {
        channelsWithWorkerBackup.push(channel);
      } else {
        channelsToDisable.push(channel);
        channelIdsToDisable.add(Number(channel.id));
      }
    }
    return {
      item, affected, channelsWithListenerBackup, channelsWithWorkerBackup, channelsToDisable,
    };
  });

  const nextChannels = sourceChannels.map((channel) => (
    channelIdsToDisable.has(Number(channel.id)) ? { ...channel, enabled: false } : channel
  ));
  const disabledPayTypes = new Set(items.flatMap(({ channelsToDisable }) => (
    channelsToDisable.flatMap((channel) => channel.pay_types ?? [])
  )));
  const remainingByPayType = countAvailableChannelsByPayType(
    registry,
    pluginConfig,
    nextChannels,
    disabledPayTypes,
    licensedBaseCodes,
  );

  return {
    items,
    nextChannels,
    disabledChannelIds: [...channelIdsToDisable].sort((left, right) => left - right),
    remainingByPayType,
  };
}
