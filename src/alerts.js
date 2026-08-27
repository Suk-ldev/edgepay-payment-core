/**
 * 统一告警推送。
 *
 * 支付站里会"出事但没人知道"的地方不止一处：Docker Watcher 掉线、个人收款的
 * 微信登录态失效、外部监听器自己报告的异常。以前这些只落在各自的日志里，
 * 而日志没人盯——等发现时通常已经掉了一批单。
 *
 * 这里把出口收成一个：各处只管 emitAlert(env, {...})，具体推到哪个渠道、
 * 会不会刷屏，都在这一个模块里决定。
 */

import { readEncryptedJsonSetting, readPlainJsonSetting, writeEncryptedJsonSetting, writePlainJsonSetting } from './runtime-settings.js';

export const ALERT_PROVIDERS = Object.freeze(['serverchan', 'pushplus', 'wecom', 'webhook']);
export const ALERT_LEVELS = Object.freeze(['info', 'warning', 'critical']);

const ALERT_CONFIG_KEY = 'alert_config';
const ALERT_STATE_KEY = 'alert_state';
/** 同一件事默认 10 分钟内只提醒一次。掉线是持续状态，每分钟推一条只会让人静音。 */
const DEFAULT_MIN_INTERVAL = 600;
/** 状态表里最多留这么多事件，避免 runtime_settings 里那一行无限长。 */
const MAX_STATE_ENTRIES = 200;

/** 去掉控制字符再截断：告警内容会原样进别人的 webhook，别把换行注入带过去。 */
function text(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max);
}

/** 校验并归一化后台提交的推送配置。 */
export function normalizeAlertConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const provider = text(source.provider, 32);
  const enabled = source.enabled === true || source.enabled === 'true';
  if (enabled && !ALERT_PROVIDERS.includes(provider)) {
    throw new Error(`推送渠道只能是 ${ALERT_PROVIDERS.join(' / ')}`);
  }
  const token = text(source.token, 256);
  const url = text(source.url, 500);
  if (enabled && ['serverchan', 'pushplus'].includes(provider) && !token) {
    throw new Error('该渠道需要填写 token');
  }
  if (enabled && ['wecom', 'webhook'].includes(provider)) {
    if (!url) throw new Error('该渠道需要填写 Webhook 地址');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Webhook 地址不是合法 URL'); }
    // 只允许 https：推送内容里带着订单和账号信息，明文出网没有理由。
    if (parsed.protocol !== 'https:') throw new Error('Webhook 地址必须是 https');
  }
  const interval = Number(source.min_interval_seconds ?? DEFAULT_MIN_INTERVAL);
  if (!Number.isFinite(interval) || interval < 60 || interval > 86_400) {
    throw new Error('提醒间隔必须在 60 到 86400 秒之间');
  }
  return {
    enabled,
    provider: ALERT_PROVIDERS.includes(provider) ? provider : '',
    token,
    url,
    min_interval_seconds: Math.floor(interval),
  };
}

/**
 * 把后台提交的配置合进现有配置。
 *
 * 留空的 token 表示"不改"。合并必须发生在校验**之前**——反过来的话，token
 * 已配置、这次留空提交，会先被"该渠道需要填写 token"挡下来，而输入框上明明
 * 写着"留空保留原值"。
 */
export function mergeAlertConfig(current, submitted) {
  return normalizeAlertConfig({
    ...(submitted && typeof submitted === 'object' ? submitted : {}),
    token: String(submitted?.token ?? '').trim() || String(current?.token ?? ''),
  });
}

/** 后台展示用：不回传 token 明文，只说配没配。 */
export function publicAlertConfig(config) {
  return {
    enabled: config.enabled === true,
    provider: config.provider ?? '',
    url: config.url ?? '',
    token_configured: Boolean(String(config.token ?? '').trim()),
    min_interval_seconds: config.min_interval_seconds ?? DEFAULT_MIN_INTERVAL,
  };
}

export async function readAlertConfig(env, secret) {
  const stored = await readEncryptedJsonSetting(env, ALERT_CONFIG_KEY, secret, {});
  return {
    enabled: stored.enabled === true,
    provider: String(stored.provider ?? ''),
    token: String(stored.token ?? ''),
    url: String(stored.url ?? ''),
    min_interval_seconds: Number(stored.min_interval_seconds ?? DEFAULT_MIN_INTERVAL),
  };
}

export async function writeAlertConfig(env, secret, config) {
  await writeEncryptedJsonSetting(env, ALERT_CONFIG_KEY, secret, config);
}

/** 把一条告警变成具体渠道的请求。抽出来是为了让测试能直接检查报文。 */
export function buildAlertRequest(config, alert) {
  const title = text(alert.title, 120) || 'EdgePay 告警';
  const message = text(alert.message, 1_000);
  const body = message ? `${message}` : title;
  switch (config.provider) {
    case 'serverchan':
      return {
        url: `https://sctapi.ftqq.com/${encodeURIComponent(config.token)}.send`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: new URLSearchParams({ title, desp: body }).toString(),
        },
      };
    case 'pushplus':
      return {
        url: 'https://www.pushplus.plus/send',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ token: config.token, title, content: body, template: 'txt' }),
        },
      };
    case 'wecom':
      return {
        url: config.url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}` } }),
        },
      };
    case 'webhook':
      return {
        url: config.url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            event: text(alert.event, 64),
            level: ALERT_LEVELS.includes(alert.level) ? alert.level : 'warning',
            title,
            message: body,
            occurred_at: new Date(alert.now ?? Date.now()).toISOString(),
          }),
        },
      };
    default:
      throw new Error(`未知推送渠道：${config.provider}`);
  }
}

/** 真正发出去。失败只返回结果，不抛——推送失败不该反过来影响业务链路。 */
export async function deliverAlert(config, alert, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let request;
  try { request = buildAlertRequest(config, alert); }
  catch (error) { return { ok: false, error: String(error.message ?? error) }; }
  try {
    const response = await fetchImpl(request.url, { ...request.init, signal: AbortSignal.timeout(timeoutMs) });
    const raw = (await response.text()).slice(0, 200);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${raw}` };
    return { ok: true, response: raw };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `超过 ${timeoutMs}ms 未响应` : String(error?.message ?? error);
    return { ok: false, error: reason };
  }
}

async function readAlertState(env) {
  const stored = await readPlainJsonSetting(env, ALERT_STATE_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/**
 * 记下某个事件最近一次推送时间，并顺手裁掉最旧的记录。
 *
 * 用 runtime_settings 里一行 JSON 而不是新开一张表：告警状态是可丢的，
 * 丢了最多重复推一条，不值得为它加一次 schema 迁移。
 */
async function writeAlertState(env, state) {
  const entries = Object.entries(state).sort((left, right) => right[1] - left[1]).slice(0, MAX_STATE_ENTRIES);
  await writePlainJsonSetting(env, ALERT_STATE_KEY, Object.fromEntries(entries));
}

/**
 * 发一条告警。
 *
 * 没配、没启用、或者同一事件还在静默期内，都安静返回——调用方不需要为这些
 * 情况写任何分支，出事的地方只管说"出事了"。
 */
export async function emitAlert(env, alert, { secret, now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const event = text(alert.event, 64) || 'unknown';
  let config;
  try { config = await readAlertConfig(env, secret); }
  catch (error) { return { sent: false, reason: 'config_unreadable', error: String(error.message ?? error) }; }
  if (!config.enabled || !config.provider) return { sent: false, reason: 'disabled' };

  const nowSeconds = Math.floor(now / 1_000);
  const state = await readAlertState(env);
  const last = Number(state[event] ?? 0);
  if (last && nowSeconds - last < config.min_interval_seconds) {
    return { sent: false, reason: 'throttled', retry_after: config.min_interval_seconds - (nowSeconds - last) };
  }

  const result = await deliverAlert(config, { ...alert, now }, { fetchImpl });
  if (result.ok) {
    state[event] = nowSeconds;
    await writeAlertState(env, state);
    return { sent: true };
  }
  // 发失败不写静默期：下一轮还要再试，否则一次网络抖动就把这条告警吞掉 10 分钟。
  console.warn('alert_delivery_failed', { event, provider: config.provider, error: result.error });
  return { sent: false, reason: 'delivery_failed', error: result.error };
}

/** 事件恢复了就清掉静默期，下次再出事能立刻提醒。 */
export async function clearAlert(env, event) {
  const key = text(event, 64);
  const state = await readAlertState(env);
  if (!(key in state)) return false;
  delete state[key];
  await writeAlertState(env, state);
  return true;
}
