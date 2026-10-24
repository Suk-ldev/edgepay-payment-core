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
 * 通道级故障状态：停用时不记"是哪个实例键停的"，只记停用时间。
 *
 * 早期版本按实例键归属（failures 数组），恢复条件是"当初停用通道的键本人
 * 重新上线"。这个模型对实例 ID 稳定的监听端没问题，但 PC 监听端每次启动
 * 换一个短 hash——重启后旧键再也不会上线，通道被一个已经不存在的键永久
 * 锁在停用状态。现在改成按通道判断：掉线一轮里有没有**别的在线实例**
 * （或 Worker 后备）覆盖这条通道，与具体是谁、什么 ID 无关。监听器换了
 * ID 也好、换了设备也好，通道只看"现在有没有人管"。
 */

/**
 * 本轮恢复判断：通道有没有在线实例覆盖（按通道号或插件编码，与停用判定
 * 用的 liveWatcherCoversChannel 同一套标准）。
 */
function liveCoverageChannelIds(liveWatchers, channels) {
  const covered = new Set();
  for (const channel of channels) {
    if (liveWatchers.some((watcher) => liveWatcherCoversChannel(watcher, channel))) {
      covered.add(Number(channel.id));
    }
  }
  return covered;
}

/**
 * 恢复与继续停用的统一结算，全部按通道覆盖判断，与实例 ID 无关。
 *
 * 恢复：状态里记录的自动停用通道，本轮只要仍有在线监听端覆盖、或仍被
 * 掉线实例认领（failover 计划要求继续停用），就保持现状；既没人覆盖、
 * 又没人认领的（掉线实例回来了、或彻底不存在了），恢复启用。监听器换
 * 了 ID 也好、换了设备也好，通道只看"现在有没有人管"。
 *
 * 停用认领：本轮仍掉线且无后备的实例认领它们覆盖的通道。这保证
 * "有别的实例在线就只报警不停用"在连续多轮巡检之间也成立：1 号掉了
 * 先停，1 号还没回来 2 号也掉了，2 号这一轮必须把通道继续锁在停用状态，
 * 不能因为 1 号的键从状态里消失了就误开。
 */
export function reconcileWatcherFailoverState(state, failovers, liveWatchers, now = Date.now(), allChannels = []) {
  const normalized = normalizeWatcherFailoverState(state);
  const liveCovered = liveCoverageChannelIds(liveWatchers, allChannels);
  const claimed = new Set(failovers.items.flatMap(({ channelsToDisable }) => (
    channelsToDisable.map((channel) => Number(channel.id))
  )));

  const channels = {};
  const restoreChannelIds = [];
  for (const [rawId, entry] of Object.entries(normalized.channels)) {
    const channelId = Number(rawId);
    // 恢复条件只有两个：本轮有在线实例覆盖，且没有掉线实例认领继续停用。
    // failures 只作诊断保留，不参与判断——实例 ID 会变，按 ID 归属会让
    // 换了 ID 的实例永远解不开旧锁。
    if (liveCovered.has(channelId) && !claimed.has(channelId)) {
      restoreChannelIds.push(channelId);
    } else {
      channels[rawId] = entry;
    }
  }
  // 本轮新停用的通道落进状态：failures 记下当时的实例键（诊断用，不参与
  // 恢复判断），恢复只看通道覆盖。
  for (const { item, channelsToDisable } of failovers.items) {
    for (const channel of channelsToDisable) {
      const channelId = String(channel.id);
      if (restoreChannelIds.includes(Number(channelId))) continue;
      const current = channels[channelId] ?? {
        failures: [],
        disabled_at: new Date(now).toISOString(),
      };
      current.failures = [...new Set([...current.failures, String(item.key)])].sort();
      channels[channelId] = current;
    }
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
