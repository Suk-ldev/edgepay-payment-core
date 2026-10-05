import { signEpayV1, fenToMoney } from './epay-v1.js';
import { safeWebhookUrl } from './security.js';

const now = () => new Date().toISOString();

// 通知认领成 SENDING 之后，如果执行被平台掐断（后台任务超时、云函数实例被回收），
// 这一行就永远停在 SENDING，商户再也收不到通知。超过这个时长还没收尾的一律视为中断。
const STALE_SENDING_MS = 5 * 60_000;
const NOTIFY_TIMEOUT_MS = 10_000;

/** 早于这个时间还停在 SENDING 的通知任务算中断。scheduledWork 的计数条件要和这里一致。 */
export function staleSendingBefore(nowMs = Date.now()) {
  return new Date(nowMs - STALE_SENDING_MS).toISOString();
}

function retryAt(attempts) {
  const seconds = Math.min(60 * 60, 30 * (2 ** Math.max(0, attempts - 1)));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function metadataOf(payment) {
  try { return JSON.parse(payment.metadata_json ?? '{}') ?? {}; } catch { return {}; }
}

/**
 * 完整复用原项目 MerchantNotifyDispatcherService 的 V1 语义：
 * - 回调参数是 ePay V1 参数，MD5 用商户 key 签名；
 * - GET query 请求 notify_url；
 * - 只有响应正文严格等于 success（忽略大小写和首尾空格）才标记成功。
 */
export async function enqueuePaymentNotification(env, paymentNo, { force = false } = {}) {
  const payment = await env.DB.prepare(`
    SELECT payment_no, external_order_no, plugin_code, expected_amount_fen, status, notify_url,
           provider_trade_no, paid_at, metadata_json
    FROM payment_attempts WHERE payment_no = ? AND status = 'PAID'
  `).bind(paymentNo).first();
  if (!payment || !payment.notify_url) return;

  const metadata = metadataOf(payment);
  const payload = {
    pid: String(env.EPAY_PID),
    trade_no: payment.payment_no,
    out_trade_no: payment.external_order_no,
    type: String(metadata.epay_type ?? payment.plugin_code),
    name: String(metadata.name ?? ''),
    money: fenToMoney(payment.expected_amount_fen),
    trade_status: 'TRADE_SUCCESS',
  };
  if (metadata.param) payload.param = String(metadata.param);
  if (metadata.buyer) payload.buyer = String(metadata.buyer);
  payload.sign_type = 'MD5';
  payload.sign = await signEpayV1(payload, env.EPAY_KEY);

  const createdAt = now();
  if (force) {
    await env.DB.prepare(`
      INSERT INTO notification_tasks (payment_no, notify_url, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?)
      ON CONFLICT(payment_no) DO UPDATE SET
        notify_url = excluded.notify_url,
        payload_json = excluded.payload_json,
        status = 'PENDING',
        attempts = 0,
        next_attempt_at = excluded.next_attempt_at,
        last_error = '',
        sent_at = NULL,
        updated_at = excluded.updated_at
    `).bind(payment.payment_no, payment.notify_url, JSON.stringify(payload), createdAt, createdAt, createdAt).run();
    return;
  }
  await env.DB.prepare(`
      INSERT INTO notification_tasks (payment_no, notify_url, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?)
      ON CONFLICT(payment_no) DO NOTHING
    `).bind(payment.payment_no, payment.notify_url, JSON.stringify(payload), createdAt, createdAt, createdAt).run();
}

export async function dispatchNotificationTask(env, task) {
  const claimedAt = now();
  const claim = await env.DB.prepare(`
    UPDATE notification_tasks
    SET status = 'SENDING', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status IN ('PENDING', 'RETRY') AND next_attempt_at <= ?
  `).bind(claimedAt, task.id, claimedAt).run();
  if (claim.meta.changes !== 1) return { skipped: true };

  const fresh = await env.DB.prepare('SELECT * FROM notification_tasks WHERE id = ?').bind(task.id).first();
  if (!fresh || !safeWebhookUrl(fresh.notify_url)) {
    await env.DB.prepare(`UPDATE notification_tasks SET status = 'GAVE_UP', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind('notify_url 必须是非本地 http/https 地址', now(), task.id).run();
    return { skipped: true };
  }

  try {
    const payload = JSON.parse(fresh.payload_json);
    const notifyUrl = new URL(fresh.notify_url);
    Object.entries(payload).forEach(([key, value]) => notifyUrl.searchParams.set(key, String(value)));
    const response = await fetch(notifyUrl, {
      method: 'GET',
      headers: { 'user-agent': 'Payment-Notify/1.0' },
      // 不设超时的话，商户接口挂住会把这次执行拖到被平台掐断，任务停在 SENDING。
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    const responseText = (await response.text()).trim();
    if (!response.ok || responseText.toLowerCase() !== 'success') {
      throw new Error(responseText || `notify HTTP ${response.status}，商户未返回 success`);
    }

    await env.DB.prepare(`UPDATE notification_tasks SET status = 'SENT', sent_at = ?, last_error = '', updated_at = ? WHERE id = ?`)
      .bind(now(), now(), task.id).run();
    return { sent: true };
  } catch (error) {
    const attempts = Number(fresh.attempts);
    const gaveUp = attempts >= 8;
    await env.DB.prepare(`
      UPDATE notification_tasks
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      gaveUp ? 'GAVE_UP' : 'RETRY',
      gaveUp ? now() : retryAt(attempts),
      String(error.message ?? error).slice(0, 500),
      now(), task.id,
    ).run();
    return { sent: false };
  }
}

export async function dispatchDueNotifications(env, limit = 25, paymentNo = null) {
  // 只在定时轮次里回收，支付回调里单发那一条不多花这次写。attempts 在认领时已经加过，
  // 放回 RETRY 后照常按次数上限处理。
  if (!paymentNo) {
    await env.DB.prepare(`
      UPDATE notification_tasks SET status = 'RETRY', last_error = ?, updated_at = ?
      WHERE status = 'SENDING' AND updated_at < ?
    `).bind('上次投递没有收尾（执行被中断），重新排队', now(), staleSendingBefore()).run();
  }
  const statement = paymentNo
    ? env.DB.prepare(`SELECT * FROM notification_tasks WHERE payment_no = ? AND status IN ('PENDING', 'RETRY') AND next_attempt_at <= ? LIMIT ?`).bind(paymentNo, now(), limit)
    : env.DB.prepare(`SELECT * FROM notification_tasks WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`).bind(now(), limit);
  const { results } = await statement.all();
  const summary = { selected: results.length, sent: 0, failed: 0 };
  for (const task of results) {
    const result = await dispatchNotificationTask(env, task);
    if (result.sent) summary.sent += 1;
    else if (!result.skipped) summary.failed += 1;
  }
  return summary;
}
