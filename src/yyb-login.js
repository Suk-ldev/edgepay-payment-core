/**
 * 应用宝监听的微信登录状态，以及后台的「清除登录状态」指令。
 *
 * 应用宝监听掉登录时故意不刷新 presence（让支付站按掉线自动暂停通道），所以登录
 * 状态单独走一条上报：Watcher 定期把"登录着 / 等扫码（带二维码）/ 已失效"报上来，
 * 后台照着显示，人不必去翻容器日志找扫码链接。管理员点「清除登录状态」时，指令先
 * 落在这里，等 Watcher 下一次上报时随回包带回去。
 *
 * 应用宝监听一个容器只登录一个微信、也只认基础插件编码，所以两样都只有一行。
 */

export const YYB_LOGIN_STATE_KEY = 'yyb_login_state';
export const YYB_LOGOUT_REQUEST_KEY = 'yyb_logout_request';
/** 状态没变时的写入节流。Watcher 每 30 秒报一次，没必要每次都写库。 */
const LOGIN_STATE_THROTTLE_MS = 120_000;
/**
 * 清除指令多久没被取走就作废。Watcher 不在线时点的清除，不该在它几小时后回来、
 * 已经重新登录好的时候突然生效。
 */
export const YYB_LOGOUT_TTL_MS = 180_000;
/** 二维码多久没随上报刷新就不再显示：Watcher 停了，那张码早过期了，扫了也没用。 */
export const YYB_QR_FRESH_MS = 600_000;

const LOGIN_STATES = new Set(['alive', 'unknown', 'scanning', 'expired', 'not_logged_in', 'offline']);
const QR_URL_PATTERN = /^https:\/\/open\.weixin\.qq\.com\/connect\/qrcode\/[A-Za-z0-9_-]{1,64}$/u;

function iso(ms) {
  return new Date(ms).toISOString();
}

/** 校验并收窄 Watcher 上报的登录状态。 */
export function sanitizeYybLoginReport(payload) {
  const state = String(payload?.state ?? '').trim();
  if (!LOGIN_STATES.has(state)) throw new Error('应用宝登录状态不合法');
  const qrUrl = String(payload?.qr_url ?? '').trim();
  return {
    instance_id: String(payload?.instance_id ?? '').trim().slice(0, 64),
    state,
    logged_in: payload?.logged_in === true,
    nickname: String(payload?.nickname ?? '').replace(/\s+/gu, ' ').trim().slice(0, 64),
    // 只认微信自己托管的二维码地址：后台会把它当图片直接显示，不能让上报方塞进任意链接。
    qr_url: state === 'scanning' && QR_URL_PATTERN.test(qrUrl) ? qrUrl : '',
  };
}

/** 记下最新的登录状态。内容没变且刚写过就不写。 */
export async function recordYybLoginState(env, report, now = Date.now()) {
  const value = JSON.stringify(report);
  await env.DB.prepare(`
    INSERT INTO runtime_settings (setting_key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_text = excluded.value_text,
      updated_at = excluded.updated_at
    WHERE runtime_settings.updated_at <= ? OR runtime_settings.value_text <> ?
  `).bind(YYB_LOGIN_STATE_KEY, value, iso(now), iso(now - LOGIN_STATE_THROTTLE_MS), value).run();
}

async function readRow(env, key) {
  return env.DB.prepare(
    'SELECT value_text, updated_at FROM runtime_settings WHERE setting_key = ?',
  ).bind(key).first();
}

function parseRow(row) {
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value_text ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function logoutPending(request, now) {
  return request?.status === 'pending' && Date.parse(String(request.expires_at ?? '')) > now;
}

/**
 * 后台「监听状态」页看到的应用宝登录状态。从没上报过（没跑应用宝监听，或 Watcher
 * 还是旧版）时返回 null，后台就不显示登录信息和清除按钮。
 */
export async function yybLoginStatus(env, now = Date.now()) {
  const [stateRow, requestRow] = await Promise.all([
    readRow(env, YYB_LOGIN_STATE_KEY),
    readRow(env, YYB_LOGOUT_REQUEST_KEY),
  ]);
  const report = parseRow(stateRow);
  if (!report) return null;
  const updatedAt = Date.parse(String(stateRow.updated_at ?? ''));
  const fresh = Number.isFinite(updatedAt) && now - updatedAt < YYB_QR_FRESH_MS;
  return {
    state: LOGIN_STATES.has(report.state) ? report.state : 'unknown',
    logged_in: report.logged_in === true,
    nickname: String(report.nickname ?? ''),
    qr_url: fresh && report.state === 'scanning' ? String(report.qr_url ?? '') : '',
    updated_at: Number.isFinite(updatedAt) ? iso(updatedAt) : '',
    logout_pending: logoutPending(parseRow(requestRow), now),
  };
}

/** 后台点了「清除登录状态」：落一条待 Watcher 取走的指令。 */
export async function requestYybLogout(env, now = Date.now()) {
  if (!parseRow(await readRow(env, YYB_LOGIN_STATE_KEY))) {
    const error = new Error('还没有应用宝监听上报过登录状态，请确认 Watcher 已更新到最新版并在运行');
    error.status = 409;
    throw error;
  }
  const request = {
    request_id: crypto.randomUUID(),
    status: 'pending',
    requested_at: iso(now),
    expires_at: iso(now + YYB_LOGOUT_TTL_MS),
  };
  await env.DB.prepare(`
    INSERT INTO runtime_settings (setting_key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at
  `).bind(YYB_LOGOUT_REQUEST_KEY, JSON.stringify(request), iso(now)).run();
  return request;
}

/**
 * Watcher 上报时取走待执行的清除指令。用"值没变才更新"抢占，两个实例同时上报也
 * 只有一个拿到。
 */
export async function claimYybLogout(env, now = Date.now()) {
  const row = await readRow(env, YYB_LOGOUT_REQUEST_KEY);
  const request = parseRow(row);
  if (!logoutPending(request, now)) return null;
  const next = JSON.stringify({ ...request, status: 'delivered', delivered_at: iso(now) });
  const claimed = await env.DB.prepare(`
    UPDATE runtime_settings
    SET value_text = ?, updated_at = ?
    WHERE setting_key = ? AND value_text = ?
  `).bind(next, iso(now), YYB_LOGOUT_REQUEST_KEY, row.value_text).run();
  if (Number(claimed?.meta?.changes ?? 0) !== 1) return null;
  return { request_id: String(request.request_id ?? '') };
}
