/**
 * 通道解析。插件是否存在、支持哪些支付方式、默认订单有效期多久，
 * 全部问注册表和插件清单，这里不认识任何具体插件编码。
 */

import { basePluginCode } from './plugin-instances.js';

function normalizedChannel(registry, input, fallbackIndex) {
  const id = Number(input?.id);
  const pluginCode = String(input?.plugin_code ?? '').trim();
  const plugin = registry.get(pluginCode);
  const types = Array.isArray(input?.pay_types) ? input.pay_types : [];
  if (!Number.isInteger(id) || id <= 0 || !plugin) return null;
  const payTypes = [...new Set(types.map((type) => String(type).trim().toLowerCase()).filter(Boolean))];
  if (!payTypes.length) return null;
  if (payTypes.length !== 1) throw new Error(`通道 ${id} 只能选择一种支付方式`);
  const unsupportedTypes = payTypes.filter((type) => !plugin.manifest.payTypes.includes(type));
  if (unsupportedTypes.length) {
    throw new Error(`通道 ${id} 不支持支付方式：${unsupportedTypes.join('、')}`);
  }
  const hasExpireOverride = Object.prototype.hasOwnProperty.call(input ?? {}, 'order_expire_minutes');
  const expireRaw = hasExpireOverride
    ? input.order_expire_minutes
    : (plugin.manifest.defaultExpireMinutes || null);
  const expireMinutes = expireRaw === null || String(expireRaw ?? '').trim() === ''
    ? null
    : Number(expireRaw);
  if (
    expireMinutes !== null
    && (!Number.isInteger(expireMinutes) || expireMinutes < 1 || expireMinutes > 1440)
  ) {
    throw new Error(`通道 ${id} 的订单有效期必须是 1 到 1440 分钟的整数`);
  }
  return {
    id,
    name: String(input.name ?? pluginCode).trim() || pluginCode,
    plugin_code: pluginCode,
    pay_types: payTypes,
    weight: Math.max(0, Math.min(100000, Math.floor(Number(input.weight ?? 100)))),
    enabled: input.enabled !== false,
    order_expire_minutes: expireMinutes,
    sort: Number.isFinite(Number(input.sort)) ? Number(input.sort) : fallbackIndex,
  };
}

export function parseChannels(registry, configuredChannels) {
  const source = Array.isArray(configuredChannels) ? configuredChannels : [];
  const ids = new Set();
  const result = source.map((input, index) => normalizedChannel(registry, input, index)).filter((channel) => {
    if (!channel || ids.has(channel.id)) return false;
    ids.add(channel.id);
    return true;
  });
  return result.sort((left, right) => left.sort - right.sort || left.id - right.id);
}

export function channelById(channels, channelId) {
  return channels.find((channel) => String(channel.id) === String(channelId)) ?? null;
}

export function weightedChannel(candidates, random = Math.random()) {
  const enabled = candidates.filter((channel) => channel.enabled && channel.weight > 0);
  const total = enabled.reduce((sum, channel) => sum + channel.weight, 0);
  if (!total) return null;
  let cursor = Math.min(0.999999999, Math.max(0, Number(random) || 0)) * total;
  for (const channel of enabled) {
    cursor -= channel.weight;
    if (cursor < 0) return channel;
  }
  return enabled.at(-1) ?? null;
}

export function resolveChannel(registry, channels, payType) {
  const type = String(payType ?? '').trim().toLowerCase();
  if (!type) throw new Error('type 参数不能为空');
  // type 允许直接写插件编码，指定用某个插件收款。写基础编码时，该插件所有副本的
  // 通道都是候选，仍按权重随机——上游只想"走微信个人收款"，不必关心是哪个账号。
  const exactPlugin = registry.get(type);
  const candidates = exactPlugin
    ? channels.filter((channel) => (
      channel.plugin_code === exactPlugin.manifest.code
      || basePluginCode(channel.plugin_code) === type
    ))
    : channels.filter((channel) => channel.pay_types.includes(type));
  const selected = weightedChannel(candidates);
  if (!selected) throw new Error('没有启用的支付通道或通道权重为 0');
  return selected;
}

export function channelExpireMinutes(channel, fallbackMinutes) {
  const override = channel?.order_expire_minutes;
  const value = override === null || override === undefined || override === ''
    ? Number(fallbackMinutes)
    : Number(override);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error('订单有效期必须是 1 到 1440 分钟的整数');
  }
  return value;
}
