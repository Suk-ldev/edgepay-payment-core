import { fenToMoney, moneyToFen } from './epay-v1.js';
import { configForPlugin } from './core/plugin-config.js';
import { pluginContext } from './core/plugin-context.js';
import { registryOf, runtimeOf, tryRuntimeOf } from './core/runtime-env.js';
import { unsupportedHook } from './plugin-api.js';
import { PLUGIN_CODE_RE, basePluginCode } from './plugin-instances.js';
import { dispatchDueNotifications, enqueuePaymentNotification } from './notifications.js';

const ACTION_META = Object.freeze({
  manual_success: { label: '手动补单', danger: true, requiresReason: true },
  renotify: { label: '重新通知', danger: false, requiresReason: false },
  active_query: { label: '主动查询', danger: false, requiresReason: false },
  api_refund: { label: 'API退款', danger: true, requiresReason: true, requiresAmount: true },
  manual_refund: { label: '手动退款', danger: true, requiresReason: true, requiresAmount: true },
  freeze: { label: '冻结订单', danger: true, requiresReason: true },
  unfreeze: { label: '解冻订单', danger: false, requiresReason: true },
});

const STATUS_LABELS = Object.freeze({
  PENDING: '待创建',
  PAYING: '支付中',
  PAID: '成功',
  FAILED: '失败',
  CLOSED: '关闭',
  EXPIRED: '超时',
});

const CALLBACK_STATUS_LABELS = Object.freeze({
  NONE: '未回调',
  PROCESSING: '处理中',
  SUCCESS: '成功',
  FAILED: '失败',
});

const NOTIFY_STATUS_LABELS = Object.freeze({
  PENDING: '待通知',
  SENDING: '通知中',
  RETRY: '等待重试',
  SENT: '已送达',
  GAVE_UP: '已停止',
});

const LISTENER_SOURCE_LABELS = Object.freeze({
  worker_poller: 'Worker 内置轮询',
  watcher: 'Watcher',
  sms_forwarder: 'SmsForwarder',
  provider_webhook: '官方支付回调',
  provider_query: '后台主动查询',
  manual: '后台手动补单',
});

const RESERVING_REFUND_STATUSES = ['CREATED', 'PROCESSING', 'SUCCEEDED'];
const MANUAL_SUCCESS_STATUSES = ['PENDING', 'PAYING', 'FAILED', 'CLOSED', 'EXPIRED'];
const ADMIN_ORDER_STATUSES = new Set(Object.keys(STATUS_LABELS));
const ADMIN_CALLBACK_STATUSES = new Set(Object.keys(CALLBACK_STATUS_LABELS));
const ADMIN_SEARCH_FIELDS = new Set(['all', 'external_order_no', 'payment_no', 'provider_trade_no']);

function timestamp() {
  return new Date().toISOString();
}

function parseJson(value) {
  try { return JSON.parse(value ?? '{}') ?? {}; } catch { return {}; }
}

function compactId(prefix) {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
}

function cleanText(value, maxLength = 300) {
  return [...String(value ?? '').trim()].slice(0, maxLength).join('');
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function allowedValue(value, allowed, fallback = '') {
  const normalized = String(value ?? '').trim();
  return allowed.has(normalized) ? normalized : fallback;
}

/**
 * 插件筛选值。白名单只列注册表里的基础插件，副本编码按它的基础编码放行——
 * 副本是配置里长出来的，注册表不知道有哪些。
 */
function allowedPluginCode(value, knownPluginCodes) {
  const code = String(value ?? '');
  if (!PLUGIN_CODE_RE.test(code)) return '';
  if (!knownPluginCodes) return code;
  return knownPluginCodes.has(code) || knownPluginCodes.has(basePluginCode(code)) ? code : '';
}

/**
 * 后台订单查询条件。传入 knownPluginCodes 时按注册表白名单校验插件筛选，
 * 不传（例如纯单测）时退回格式校验。
 */
export function normalizeAdminOrderQuery(input = {}, knownPluginCodes = null) {
  return {
    page: boundedInteger(input.page, 1, 1, 100_000),
    page_size: [10, 20, 50, 100].includes(Number(input.page_size))
      ? Number(input.page_size)
      : 20,
    search_field: allowedValue(input.search_field, ADMIN_SEARCH_FIELDS, 'all'),
    keyword: cleanText(input.keyword, 100),
    plugin_code: allowedPluginCode(input.plugin_code, knownPluginCodes),
    status: allowedValue(input.status, ADMIN_ORDER_STATUSES),
    callback_status: allowedValue(input.callback_status, ADMIN_CALLBACK_STATUSES),
  };
}

export function callbackSummary(row = {}, pluginCode = '', receiptMode = false) {
  const total = Math.max(0, Number(row.callback_times ?? 0));
  const processed = Math.max(0, Number(row.callback_processed_times ?? 0));
  const rejected = Math.max(0, Number(row.callback_rejected_times ?? 0));
  const pending = Math.max(0, Number(row.callback_pending_times ?? 0));
  // 这一栏回答的是"这笔订单的回调/监听成功过没有"，不是"最后一条事件长什么样"。
  // 以前先看最新一条事件：SmsForwarder 这类监听插件一笔订单会收到多条通知，
  // 确认订单的那条是 PROCESSED，之后再来一条没匹配上的 RECEIVED 就会把已经
  // 支付成功的订单显示成"监听处理中"。只要成功处理过一次，这一栏就是成功。
  const settled = ['PAID', 'CLOSED', 'EXPIRED', 'FAILED'].includes(String(row.status ?? ''));
  let status = 'NONE';
  if (processed > 0) status = 'SUCCESS';
  else if (rejected > 0) status = 'FAILED';
  // 订单已经终态还挂着没处理的事件，说明它始终没匹配上，不是"还在处理"。
  else if (pending > 0) status = settled ? 'FAILED' : 'PROCESSING';
  else if (total > 0) status = 'SUCCESS';
  return {
    status,
    status_text: receiptMode
      ? {
        NONE: '未监听',
        PROCESSING: '监听处理中',
        SUCCESS: '监听成功',
        FAILED: '监听失败',
      }[status]
      : CALLBACK_STATUS_LABELS[status],
    times: total,
    processed_times: processed,
    rejected_times: rejected,
    pending_times: pending,
    kind: receiptMode ? 'listener' : 'callback',
  };
}

function notificationSummary(row = {}) {
  const status = String(row.notify_status ?? '');
  return {
    status,
    status_text: status ? (NOTIFY_STATUS_LABELS[status] ?? status) : '未投递',
    attempts: Math.max(0, Number(row.notify_attempts ?? 0)),
    last_error: String(row.notify_last_error ?? ''),
  };
}

function maskSensitivePayload(value, depth = 0) {
  if (depth > 6) return '[内容过深]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => maskSensitivePayload(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 4_000) : value;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => {
    const sensitive = /(?:password|passwd|secret|token|authorization|private.?key|api.?key|client.?secret|^sign$)/iu.test(key);
    return [key, sensitive ? '***' : maskSensitivePayload(item, depth + 1)];
  }));
}

function publicPayload(value) {
  const parsed = parseJson(value);
  if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
    return maskSensitivePayload(parsed);
  }
  const raw = String(value ?? '').trim();
  return raw ? { raw_text: raw.slice(0, 4_000) } : {};
}

function requireReason(body, action) {
  const reason = cleanText(body.reason, 300);
  if (!reason) throw new Error(`${ACTION_META[action]?.label ?? '操作'}原因不能为空`);
  return reason;
}

/**
 * 这个插件此刻能不能走接口退款。插件可以用 refundCapability 说明"实现了退款但
 * 当前环境不满足"（缺证书之类），这样后台能给出具体原因而不是笼统的不支持。
 */
function apiRefundCapability(pluginCode, env) {
  const plugin = tryRuntimeOf(env)?.registry.get(String(pluginCode));
  if (!plugin?.refundPayment) {
    return { supported: false, reason: '该收款插件不支持接口退款，请使用手动退款登记' };
  }
  if (plugin.refundCapability) return plugin.refundCapability({ env, config: {} });
  return { supported: true, reason: '' };
}

function action(code, enabled, reason = '') {
  const meta = ACTION_META[code];
  return {
    code,
    label: meta.label,
    enabled,
    reason: enabled ? '' : reason,
    danger: meta.danger,
    confirm: meta.danger,
    requires_reason: meta.requiresReason,
    requires_amount: Boolean(meta.requiresAmount),
  };
}

export function resolveOrderActions(order, env = {}) {
  const frozen = Boolean(Number(order.is_frozen));
  const paid = order.status === 'PAID';
  const hasNotifyUrl = cleanText(order.notify_url, 2048) !== '';
  const refundable = Math.max(0, Number(order.refundable_amount_fen ?? 0));
  const refundCapability = apiRefundCapability(String(order.plugin_code), env);
  const canManualSuccess = MANUAL_SUCCESS_STATUSES.includes(String(order.status));

  return [
    action(
      'manual_success',
      !frozen && canManualSuccess,
      frozen ? '订单已冻结' : paid ? '订单已成功，无需补单' : '当前状态不能手动补单',
    ),
    action(
      'renotify',
      !frozen && paid && hasNotifyUrl,
      frozen ? '订单已冻结' : !paid ? '只有成功订单可以重新通知' : '订单未配置 notify_url',
    ),
    action(
      'active_query',
      !frozen && !paid,
      frozen ? '订单已冻结' : '订单已成功，无需查单',
    ),
    action(
      'api_refund',
      !frozen && paid && refundable > 0 && refundCapability.supported,
      frozen ? '订单已冻结'
        : !paid ? '只有成功订单可以退款'
          : refundable <= 0 ? '订单暂无可退余额' : refundCapability.reason,
    ),
    action(
      'manual_refund',
      !frozen && paid && refundable > 0,
      frozen ? '订单已冻结' : !paid ? '只有成功订单可以退款' : '订单暂无可退余额',
    ),
    action('freeze', !frozen, frozen ? '订单已冻结' : ''),
    action('unfreeze', frozen, frozen ? '' : '订单未冻结'),
  ];
}

const ORDER_SELECT = `
  SELECT
    p.*,
    COALESCE(c.is_frozen, 0) AS is_frozen,
    COALESCE(c.freeze_reason, '') AS freeze_reason,
    c.frozen_at,
    COALESCE(c.unfreeze_reason, '') AS unfreeze_reason,
    c.unfrozen_at,
    COALESCE(r.reserved_refund_fen, 0) AS reserved_refund_fen,
    MAX(0, p.expected_amount_fen - COALESCE(r.reserved_refund_fen, 0)) AS refundable_amount_fen,
    n.status AS notify_status,
    n.attempts AS notify_attempts,
    n.last_error AS notify_last_error,
    n.next_attempt_at AS notify_next_attempt_at,
    n.sent_at AS notify_sent_at,
    n.updated_at AS notify_updated_at,
    COALESCE(es.callback_times, 0) AS callback_times,
    COALESCE(es.callback_processed_times, 0) AS callback_processed_times,
    COALESCE(es.callback_rejected_times, 0) AS callback_rejected_times,
    COALESCE(es.callback_pending_times, 0) AS callback_pending_times,
    e.source AS receipt_event_source,
    e.event_id AS receipt_event_id,
    e.state AS receipt_event_state,
    e.received_at AS receipt_event_received_at,
    e.processed_at AS receipt_event_processed_at,
    e.raw_json AS receipt_event_raw_json
  FROM payment_attempts p
  LEFT JOIN order_controls c ON c.payment_no = p.payment_no
  LEFT JOIN (
    SELECT payment_no, SUM(refund_amount_fen) AS reserved_refund_fen
    FROM refund_orders
    WHERE status IN ('CREATED', 'PROCESSING', 'SUCCEEDED')
    GROUP BY payment_no
  ) r ON r.payment_no = p.payment_no
  LEFT JOIN notification_tasks n ON n.payment_no = p.payment_no
  LEFT JOIN (
    SELECT
      payment_no,
      COUNT(*) AS callback_times,
      SUM(CASE WHEN state = 'PROCESSED' THEN 1 ELSE 0 END) AS callback_processed_times,
      SUM(CASE WHEN state = 'REJECTED' THEN 1 ELSE 0 END) AS callback_rejected_times,
      SUM(CASE WHEN state = 'RECEIVED' THEN 1 ELSE 0 END) AS callback_pending_times
    FROM receipt_events
    GROUP BY payment_no
  ) es ON es.payment_no = p.payment_no
  LEFT JOIN receipt_events e ON e.id = (
    SELECT latest_event.id
    FROM receipt_events latest_event
    WHERE latest_event.payment_no = p.payment_no
    ORDER BY latest_event.id DESC
    LIMIT 1
  )
`;

async function loadOrder(env, paymentNo) {
  return env.DB.prepare(`${ORDER_SELECT} WHERE p.payment_no = ?`).bind(paymentNo).first();
}

function publicOrder(row, env) {
  if (!row) return null;
  const plugin = tryRuntimeOf(env)?.registry.get(String(row.plugin_code)) ?? null;
  const metadata = parseJson(row.metadata_json);
  const callback = callbackSummary(row, row.plugin_code, plugin?.manifest.mode === 'channel-notify');
  const notification = notificationSummary(row);
  const order = {
    payment_no: String(row.payment_no),
    external_order_no: String(row.external_order_no),
    plugin_code: String(row.plugin_code),
    plugin_name: plugin?.manifest.name ?? String(row.plugin_code),
    expected_amount_fen: Number(row.expected_amount_fen),
    amount_text: fenToMoney(row.expected_amount_fen),
    currency: String(row.currency),
    status: String(row.status),
    status_text: STATUS_LABELS[row.status] ?? String(row.status),
    provider_trade_no: String(row.provider_trade_no ?? ''),
    paid_at: row.paid_at ?? '',
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_notify_url: Boolean(row.notify_url),
    notify_url: String(row.notify_url ?? ''),
    notify_status: String(row.notify_status ?? ''),
    notify_status_text: notification.status_text,
    notify_attempts: Number(row.notify_attempts ?? 0),
    notify_last_error: String(row.notify_last_error ?? ''),
    notify_next_attempt_at: row.notify_next_attempt_at ?? '',
    notify_sent_at: row.notify_sent_at ?? '',
    callback_status: callback.status,
    callback_status_text: callback.status_text,
    callback_times: callback.times,
    callback,
    notification,
    is_frozen: Boolean(Number(row.is_frozen)),
    freeze_reason: String(row.freeze_reason ?? ''),
    frozen_at: row.frozen_at ?? '',
    unfreeze_reason: String(row.unfreeze_reason ?? ''),
    unfrozen_at: row.unfrozen_at ?? '',
    reserved_refund_fen: Number(row.reserved_refund_fen ?? 0),
    refundable_amount_fen: Number(row.refundable_amount_fen ?? 0),
    refundable_amount_text: fenToMoney(row.refundable_amount_fen ?? 0),
    is_test_order: metadata.is_test_order === true,
    channel_id: Number(metadata.channel_id ?? 0),
    channel_name: String(metadata.channel_name ?? ''),
    provider_callback_url: String(metadata.provider_callback_url ?? ''),
    listener_source: confirmationSource(row),
  };
  order.actions = resolveOrderActions({ ...row, ...order }, env);
  order.enabled_actions = order.actions.filter((item) => item.enabled).map((item) => item.code);
  return order;
}

export function confirmationSource(row = {}) {
  const metadata = parseJson(row.metadata_json);
  const raw = parseJson(row.receipt_event_raw_json);
  const eventSource = String(row.receipt_event_source ?? '');
  const eventBaseSource = basePluginCode(eventSource);
  let code = String(raw.delivery_source ?? raw.source ?? '').trim();

  if (!code && eventBaseSource) {
    if (['wxpay_receipt', 'alipay_receipt'].includes(eventBaseSource)) code = 'sms_forwarder';
    else if (['fubei_receipt', 'usdt_trc20_receipt'].includes(eventBaseSource)) code = 'watcher';
    else code = 'provider_webhook';
  }
  if (!code) code = String(metadata.payment_confirmation?.source ?? '').trim();

  return {
    code,
    label: LISTENER_SOURCE_LABELS[code] ?? (code || '尚未确认'),
    event_id: String(row.receipt_event_id ?? ''),
    state: String(row.receipt_event_state ?? ''),
    received_at: row.receipt_event_received_at ?? '',
    processed_at: row.receipt_event_processed_at ?? '',
  };
}

const EVENT_STATS_JOIN = `
  LEFT JOIN (
    SELECT
      payment_no,
      COUNT(*) AS callback_times,
      SUM(CASE WHEN state = 'PROCESSED' THEN 1 ELSE 0 END) AS callback_processed_times,
      SUM(CASE WHEN state = 'REJECTED' THEN 1 ELSE 0 END) AS callback_rejected_times,
      SUM(CASE WHEN state = 'RECEIVED' THEN 1 ELSE 0 END) AS callback_pending_times
    FROM receipt_events
    GROUP BY payment_no
  ) es ON es.payment_no = p.payment_no
`;

function adminOrderWhere(filters) {
  const clauses = [];
  const bindings = [];
  if (filters.keyword) {
    const term = `%${filters.keyword}%`;
    const searchColumns = {
      external_order_no: 'p.external_order_no',
      payment_no: 'p.payment_no',
      provider_trade_no: 'p.provider_trade_no',
    };
    if (filters.search_field === 'all') {
      clauses.push('(p.external_order_no LIKE ? OR p.payment_no LIKE ? OR p.provider_trade_no LIKE ?)');
      bindings.push(term, term, term);
    } else {
      clauses.push(`${searchColumns[filters.search_field]} LIKE ?`);
      bindings.push(term);
    }
  }
  if (filters.plugin_code) {
    clauses.push('p.plugin_code = ?');
    bindings.push(filters.plugin_code);
  }
  if (filters.status) {
    clauses.push('p.status = ?');
    bindings.push(filters.status);
  }
  if (filters.callback_status === 'NONE') {
    clauses.push('COALESCE(es.callback_times, 0) = 0');
  } else if (filters.callback_status === 'FAILED') {
    clauses.push("e.state = 'REJECTED'");
  } else if (filters.callback_status === 'PROCESSING') {
    clauses.push("e.state = 'RECEIVED'");
  } else if (filters.callback_status === 'SUCCESS') {
    clauses.push("e.state = 'PROCESSED'");
  }
  return {
    sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    bindings,
  };
}

export async function listAdminOrders(env, input = {}) {
  const filters = normalizeAdminOrderQuery(input, new Set(registryOf(env).codes()));
  const where = adminOrderWhere(filters);
  const countStatement = env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM payment_attempts p
    ${EVENT_STATS_JOIN}
    ${where.sql}
  `);
  const count = await (where.bindings.length
    ? countStatement.bind(...where.bindings)
    : countStatement).first();
  const total = Math.max(0, Number(count?.total ?? 0));
  const pageCount = Math.max(1, Math.ceil(total / filters.page_size));
  const page = Math.min(filters.page, pageCount);
  const offset = (page - 1) * filters.page_size;
  const { results } = await env.DB.prepare(`
    ${ORDER_SELECT}
    ${where.sql}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...where.bindings, filters.page_size, offset).all();
  return {
    results: results.map((row) => publicOrder(row, env)),
    total,
    page,
    page_size: filters.page_size,
    page_count: total === 0 ? 0 : pageCount,
    filters,
  };
}

export function buildOrderTimeline({
  order = {},
  receipt_events: receiptEvents = [],
  callback_events: callbackEvents = [],
  notification_tasks: notificationTasks = [],
  refunds = [],
  operations = [],
} = {}) {
  const events = [];
  const push = (event) => {
    if (!event.at) return;
    events.push({
      type: String(event.type),
      type_text: String(event.type_text),
      title: String(event.title),
      status: String(event.status ?? ''),
      status_text: String(event.status_text ?? ''),
      description: String(event.description ?? ''),
      source_no: String(event.source_no ?? ''),
      at: event.at,
    });
  };

  push({
    type: 'order',
    type_text: '支付订单',
    title: '订单已创建',
    status: 'PENDING',
    status_text: '待支付',
    source_no: order.payment_no,
    at: order.created_at,
  });
  if (order.paid_at) {
    push({
      type: 'order',
      type_text: '支付订单',
      title: '订单支付成功',
      status: 'PAID',
      status_text: '成功',
      description: order.provider_trade_no ? `上游流水：${order.provider_trade_no}` : '',
      source_no: order.payment_no,
      at: order.paid_at,
    });
  } else if (['FAILED', 'CLOSED', 'EXPIRED'].includes(String(order.status))) {
    push({
      type: 'order',
      type_text: '支付订单',
      title: {
        FAILED: '订单支付失败',
        CLOSED: '订单已关闭',
        EXPIRED: '订单已超时',
      }[order.status],
      status: order.status,
      status_text: order.status_text,
      source_no: order.payment_no,
      at: order.status === 'EXPIRED' ? order.expires_at : order.updated_at,
    });
  }

  for (const event of [...receiptEvents, ...callbackEvents]) {
    const listener = event.kind === 'listener';
    push({
      type: listener ? 'listener' : 'callback',
      type_text: listener ? '收款监听' : '上游回调',
      title: listener ? `${event.source?.label || '监听器'}确认收款` : `${event.source?.label || '支付通道'}回调`,
      status: event.state,
      status_text: event.state_text,
      description: event.reason || (event.provider_trade_no ? `上游流水：${event.provider_trade_no}` : ''),
      source_no: event.event_id,
      at: event.received_at,
    });
  }

  for (const task of notificationTasks) {
    push({
      type: 'notification',
      type_text: '商户通知',
      title: task.status === 'SENT' ? '商户通知已送达' : '商户通知任务更新',
      status: task.status,
      status_text: task.status_text,
      description: task.last_error || `已尝试 ${task.attempts} 次`,
      source_no: `notify-${task.id}`,
      at: task.sent_at || task.updated_at || task.created_at,
    });
  }

  for (const refund of refunds) {
    push({
      type: 'refund',
      type_text: '退款',
      title: refund.method === 'API' ? 'API 退款' : '手动退款',
      status: refund.status,
      status_text: {
        CREATED: '待创建',
        PROCESSING: '处理中',
        SUCCEEDED: '成功',
        FAILED: '失败',
        CLOSED: '关闭',
      }[refund.status] ?? refund.status,
      description: refund.last_error || refund.reason,
      source_no: refund.refund_no,
      at: refund.completed_at || refund.updated_at || refund.created_at,
    });
  }

  for (const operation of operations) {
    push({
      type: 'operation',
      type_text: '后台操作',
      title: ACTION_META[operation.action]?.label ?? operation.action,
      status: operation.result_status,
      status_text: operation.result_status === 'success' ? '成功' : operation.result_status,
      description: operation.result_message || operation.reason,
      source_no: operation.action,
      at: operation.created_at,
    });
  }

  return events.sort((left, right) => {
    const leftTime = Date.parse(left.at) || 0;
    const rightTime = Date.parse(right.at) || 0;
    return rightTime - leftTime;
  });
}

export async function adminOrderDetails(env, paymentNo) {
  const row = await loadOrder(env, paymentNo);
  if (!row) throw new Error('订单不存在');
  const [refunds, operations, receiptEvents, notificationTasks] = await Promise.all([
    env.DB.prepare(`
      SELECT refund_no, merchant_refund_no, refund_amount_fen, method, status,
             provider_refund_no, reason, provider_result_json, last_error,
             created_at, updated_at, completed_at
      FROM refund_orders WHERE payment_no = ? ORDER BY created_at DESC
    `).bind(paymentNo).all(),
    env.DB.prepare(`
      SELECT action, reason, result_status, result_message, result_json, created_at
      FROM order_operation_logs WHERE payment_no = ? ORDER BY created_at DESC LIMIT 50
    `).bind(paymentNo).all(),
    env.DB.prepare(`
      SELECT id, source AS receipt_event_source, event_id AS receipt_event_id,
             provider_trade_no, amount_fen, state AS receipt_event_state, reason,
             received_at AS receipt_event_received_at,
             processed_at AS receipt_event_processed_at, raw_json AS receipt_event_raw_json
      FROM receipt_events WHERE payment_no = ? ORDER BY id DESC LIMIT 50
    `).bind(paymentNo).all(),
    env.DB.prepare(`
      SELECT id, notify_url, payload_json, status, attempts, next_attempt_at,
             last_error, sent_at, created_at, updated_at
      FROM notification_tasks WHERE payment_no = ? ORDER BY id DESC
    `).bind(paymentNo).all(),
  ]);
  const order = publicOrder(row, env);
  const refundRows = refunds.results.map((refund) => ({
    ...refund,
    refund_amount_fen: Number(refund.refund_amount_fen),
    refund_amount_text: fenToMoney(refund.refund_amount_fen),
    provider_result: publicPayload(refund.provider_result_json),
  }));
  const operationRows = operations.results.map((operation) => ({
    ...operation,
    result: publicPayload(operation.result_json),
  }));
  const eventRows = receiptEvents.results.map((event) => ({
    id: Number(event.id),
    kind: registryOf(env).get(String(row.plugin_code))?.manifest.mode === 'channel-notify' ? 'listener' : 'callback',
    source: confirmationSource({ ...row, ...event }),
    event_id: String(event.receipt_event_id ?? ''),
    provider_trade_no: String(event.provider_trade_no ?? ''),
    amount_fen: Number(event.amount_fen ?? 0),
    amount_text: fenToMoney(event.amount_fen ?? 0),
    state: String(event.receipt_event_state ?? ''),
    state_text: {
      RECEIVED: '处理中',
      PROCESSED: '成功',
      REJECTED: '失败',
    }[event.receipt_event_state] ?? String(event.receipt_event_state ?? ''),
    reason: String(event.reason ?? ''),
    received_at: event.receipt_event_received_at ?? '',
    processed_at: event.receipt_event_processed_at ?? '',
    payload: publicPayload(event.receipt_event_raw_json),
  }));
  const notifyRows = notificationTasks.results.map((task) => ({
    id: Number(task.id),
    notify_url: String(task.notify_url ?? ''),
    status: String(task.status ?? ''),
    status_text: NOTIFY_STATUS_LABELS[task.status] ?? String(task.status ?? ''),
    attempts: Number(task.attempts ?? 0),
    next_attempt_at: task.next_attempt_at ?? '',
    last_error: String(task.last_error ?? ''),
    sent_at: task.sent_at ?? '',
    created_at: task.created_at ?? '',
    updated_at: task.updated_at ?? '',
    payload: publicPayload(task.payload_json),
  }));
  const listenerEvents = eventRows.filter((event) => event.kind === 'listener');
  const callbackEvents = eventRows.filter((event) => event.kind === 'callback');
  const result = {
    order,
    metadata: parseJson(row.metadata_json),
    refunds: refundRows,
    operations: operationRows,
    receipt_events: listenerEvents,
    callback_events: callbackEvents,
    notification_tasks: notifyRows,
  };
  result.timeline = buildOrderTimeline(result);
  return result;
}

async function recordOperation(env, paymentNo, actionCode, reason, resultStatus, resultMessage, result = {}) {
  try {
    await env.DB.prepare(`
      INSERT INTO order_operation_logs (
        payment_no, action, reason, result_status, result_message, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      paymentNo,
      actionCode,
      cleanText(reason, 300),
      cleanText(resultStatus, 32),
      cleanText(resultMessage, 500),
      JSON.stringify(result).slice(0, 8_000),
      timestamp(),
    ).run();
  } catch (error) {
    console.warn('order_operation_log_failed', {
      paymentNo,
      action: actionCode,
      message: String(error.message ?? error),
    });
  }
}

function providerOrder(row) {
  return {
    payNo: String(row.payment_no),
    amount: Number(row.expected_amount_fen),
    providerTradeNo: String(row.provider_trade_no ?? ''),
    providerOrderNo: String(parseJson(row.metadata_json).provider_order_no ?? ''),
    metadata: parseJson(row.metadata_json),
  };
}

async function queryProvider(row, env, pluginConfig) {
  const runtime = runtimeOf(env);
  const config = configForPlugin(pluginConfig, row.plugin_code);
  const plugin = runtime.registry.get(String(row.plugin_code));
  // 收款监听类插件本来就没有查单接口，等流水到达即可，不算失败。
  if (!plugin?.queryPayment) {
    return {
      success: true,
      status: 'pending',
      payNo: row.payment_no,
      message: plugin?.manifest.mode === 'channel-notify'
        ? `${plugin.manifest.name}等待收款流水到达`
        : '该插件没有主动查单接口',
    };
  }
  await runtime.authorizePlugin({ plugin, operation: 'queryPayment', env });
  return plugin.queryPayment(pluginContext(runtime, { env, config, order: providerOrder(row) }));
}

function providerResultSnapshot(result) {
  return {
    success: Boolean(result?.success),
    status: cleanText(result?.status ?? result?.providerStatus, 64),
    message: cleanText(result?.message, 500),
    channel_order_no: cleanText(result?.channelOrderNo, 128),
    channel_trade_no: cleanText(result?.channelTradeNo, 128),
    provider_refund_no: cleanText(result?.providerRefundNo, 128),
    refund_amount: Number(result?.refundAmount ?? 0),
  };
}

async function dispatchNotification(env, ctx, paymentNo) {
  const promise = dispatchDueNotifications(env, 1, paymentNo);
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(promise);
  else await promise;
}

async function manualSuccess(env, ctx, row, body) {
  const reason = requireReason(body, 'manual_success');
  const metadata = parseJson(row.metadata_json);
  metadata.admin_action = {
    type: 'manual_success',
    reason,
    operated_at: timestamp(),
  };
  const now = timestamp();
  metadata.payment_confirmation = {
    source: 'manual',
    operated_at: now,
  };
  const updated = await env.DB.prepare(`
    UPDATE payment_attempts
    SET status = 'PAID', paid_at = COALESCE(paid_at, ?), metadata_json = ?, updated_at = ?
    WHERE payment_no = ?
      AND status IN ('PENDING', 'PAYING', 'FAILED', 'CLOSED', 'EXPIRED')
      AND NOT EXISTS (
        SELECT 1 FROM order_controls WHERE payment_no = ? AND is_frozen = 1
      )
  `).bind(now, JSON.stringify(metadata), now, row.payment_no, row.payment_no).run();
  if (updated.meta.changes !== 1) throw new Error('订单状态已变化，无法手动补单');
  await enqueuePaymentNotification(env, row.payment_no);
  await recordOperation(env, row.payment_no, 'manual_success', reason, 'success', '支付单已手动补单为成功');
  await dispatchNotification(env, ctx, row.payment_no);
  return '支付单已手动补单为成功';
}

async function renotify(env, ctx, row) {
  await enqueuePaymentNotification(env, row.payment_no, { force: true });
  await recordOperation(env, row.payment_no, 'renotify', '', 'success', '支付成功通知已重新投递');
  await dispatchNotification(env, ctx, row.payment_no);
  return '支付成功通知已重新投递';
}

async function activeQuery(env, ctx, row, pluginConfig) {
  const result = await queryProvider(row, env, pluginConfig);
  const snapshot = providerResultSnapshot(result);
  const metadata = parseJson(row.metadata_json);
  metadata.provider_query = { ...snapshot, queried_at: timestamp() };
  const now = timestamp();
  const values = {
    success: 'PAID',
    failed: 'FAILED',
    closed: 'CLOSED',
  };
  const nextStatus = values[String(result.status)] ?? null;
  if (nextStatus === 'PAID') {
    metadata.payment_confirmation = {
      source: 'provider_query',
      plugin_code: row.plugin_code,
      channel_trade_no: String(result.channelTradeNo ?? row.provider_trade_no ?? ''),
      confirmed_at: String(result.paidAt || now),
    };
    const update = await env.DB.prepare(`
      UPDATE payment_attempts SET
        status = 'PAID',
        provider_trade_no = ?,
        paid_at = COALESCE(paid_at, ?),
        metadata_json = ?,
        updated_at = ?
      WHERE payment_no = ? AND status <> 'PAID'
        AND NOT EXISTS (
          SELECT 1 FROM order_controls WHERE payment_no = ? AND is_frozen = 1
        )
    `).bind(
      String(result.channelTradeNo ?? row.provider_trade_no ?? ''),
      String(result.paidAt || now),
      JSON.stringify(metadata),
      now,
      row.payment_no,
      row.payment_no,
    ).run();
    if (update.meta.changes !== 1) throw new Error('订单状态已变化，查单结果未写入');
    await enqueuePaymentNotification(env, row.payment_no);
    await dispatchNotification(env, ctx, row.payment_no);
  } else if (nextStatus) {
    await env.DB.prepare(`
      UPDATE payment_attempts SET status = ?, provider_trade_no = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status <> 'PAID'
    `).bind(
      nextStatus,
      String(result.channelTradeNo ?? row.provider_trade_no ?? ''),
      JSON.stringify(metadata),
      now,
      row.payment_no,
    ).run();
  } else {
    await env.DB.prepare(`
      UPDATE payment_attempts SET provider_trade_no = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status <> 'PAID'
    `).bind(
      String(result.channelTradeNo ?? row.provider_trade_no ?? ''),
      JSON.stringify(metadata),
      now,
      row.payment_no,
    ).run();
  }
  const message = snapshot.message || `上游状态：${snapshot.status || 'pending'}`;
  await recordOperation(env, row.payment_no, 'active_query', '', result.success ? 'success' : 'failed', message, snapshot);
  return message;
}

async function freezeOrder(env, row, body) {
  const reason = requireReason(body, 'freeze');
  const now = timestamp();
  await env.DB.prepare(`
    INSERT INTO order_controls (
      payment_no, is_frozen, freeze_reason, frozen_at, unfreeze_reason, unfrozen_at, updated_at
    ) VALUES (?, 1, ?, ?, '', NULL, ?)
    ON CONFLICT(payment_no) DO UPDATE SET
      is_frozen = 1,
      freeze_reason = excluded.freeze_reason,
      frozen_at = excluded.frozen_at,
      unfreeze_reason = '',
      unfrozen_at = NULL,
      updated_at = excluded.updated_at
  `).bind(row.payment_no, reason, now, now).run();
  await recordOperation(env, row.payment_no, 'freeze', reason, 'success', '订单已冻结');
  return '订单已冻结';
}

async function unfreezeOrder(env, row, body) {
  const reason = requireReason(body, 'unfreeze');
  const now = timestamp();
  const update = await env.DB.prepare(`
    UPDATE order_controls
    SET is_frozen = 0, unfreeze_reason = ?, unfrozen_at = ?, updated_at = ?
    WHERE payment_no = ? AND is_frozen = 1
  `).bind(reason, now, now, row.payment_no).run();
  if (update.meta.changes !== 1) throw new Error('订单未冻结');
  await recordOperation(env, row.payment_no, 'unfreeze', reason, 'success', '订单已解冻');
  return '订单已解冻';
}

function parseRefundAmount(body, remaining) {
  if (body.refund_full_remaining === true || cleanText(body.money, 64) === '') return remaining;
  return moneyToFen(body.money);
}

async function existingRefund(env, merchantRefundNo) {
  if (!merchantRefundNo) return null;
  return env.DB.prepare('SELECT * FROM refund_orders WHERE merchant_refund_no = ?')
    .bind(merchantRefundNo).first();
}

async function reserveRefund(env, row, body, method, requireAdminReason) {
  const reason = requireAdminReason
    ? requireReason(body, method === 'API' ? 'api_refund' : 'manual_refund')
    : cleanText(body.reason, 300);
  const merchantRefundNo = cleanText(
    body.merchant_refund_no ?? body.refund_no,
    128,
  ) || compactId('MRF');
  const amount = parseRefundAmount(body, Number(row.refundable_amount_fen));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('退款金额不合法');

  const duplicate = await existingRefund(env, merchantRefundNo);
  if (duplicate) {
    if (duplicate.payment_no !== row.payment_no || Number(duplicate.refund_amount_fen) !== amount) {
      throw new Error('退款幂等键冲突');
    }
    return { refund: duplicate, duplicate: true };
  }

  const refundNo = compactId('RFD');
  const status = method === 'API' ? 'PROCESSING' : 'SUCCEEDED';
  const now = timestamp();
  let inserted;
  try {
    inserted = await env.DB.prepare(`
      INSERT INTO refund_orders (
        refund_no, merchant_refund_no, payment_no, refund_amount_fen, method, status,
        provider_refund_no, reason, provider_result_json, last_error,
        created_at, updated_at, completed_at
      )
      SELECT ?, ?, p.payment_no, ?, ?, ?, '', ?, '{}', '', ?, ?, ?
      FROM payment_attempts p
      WHERE p.payment_no = ? AND p.status = 'PAID'
        AND NOT EXISTS (
          SELECT 1 FROM order_controls c WHERE c.payment_no = p.payment_no AND c.is_frozen = 1
        )
        AND ? <= p.expected_amount_fen - COALESCE((
          SELECT SUM(refund_amount_fen) FROM refund_orders
          WHERE payment_no = p.payment_no AND status IN ('CREATED', 'PROCESSING', 'SUCCEEDED')
        ), 0)
    `).bind(
      refundNo,
      merchantRefundNo,
      amount,
      method,
      status,
      reason,
      now,
      now,
      method === 'MANUAL' ? now : null,
      row.payment_no,
      amount,
    ).run();
  } catch (error) {
    const raced = await existingRefund(env, merchantRefundNo);
    if (raced && raced.payment_no === row.payment_no && Number(raced.refund_amount_fen) === amount) {
      return { refund: raced, duplicate: true };
    }
    throw error;
  }
  if (inserted.meta.changes !== 1) {
    const fresh = await loadOrder(env, row.payment_no);
    if (!fresh) throw new Error('订单不存在');
    if (Number(fresh.is_frozen)) throw new Error('支付单已冻结，禁止退款');
    if (fresh.status !== 'PAID') throw new Error('只有成功订单可以退款');
    throw new Error('退款金额超过可退余额');
  }
  return {
    refund: await env.DB.prepare('SELECT * FROM refund_orders WHERE refund_no = ?').bind(refundNo).first(),
    duplicate: false,
  };
}

async function providerRefund(row, refund, env, pluginConfig) {
  const capability = apiRefundCapability(row.plugin_code, env);
  if (!capability.supported) throw new Error(capability.reason);
  const config = configForPlugin(pluginConfig, row.plugin_code);
  const order = {
    ...providerOrder(row),
    refundNo: refund.refund_no,
    refundAmount: Number(refund.refund_amount_fen),
    reason: refund.reason,
  };
  const runtime = runtimeOf(env);
  const plugin = runtime.registry.get(String(row.plugin_code));
  if (!plugin?.refundPayment) throw unsupportedHook(plugin ?? { manifest: { name: row.plugin_code } }, 'refundPayment');
  await runtime.authorizePlugin({ plugin, operation: 'refundPayment', env });
  return plugin.refundPayment(pluginContext(runtime, { env, config, order }));
}

async function apiRefund(env, row, body, pluginConfig, requireAdminReason = true) {
  const reserved = await reserveRefund(env, row, body, 'API', requireAdminReason);
  if (reserved.duplicate) {
    if (reserved.refund.status === 'SUCCEEDED') return reserved.refund;
    if (reserved.refund.status === 'PROCESSING') throw new Error('相同退款单正在处理中');
    throw new Error(reserved.refund.last_error || '相同退款单已失败');
  }
  const refund = reserved.refund;
  let providerFailureSnapshot = null;
  try {
    const result = await providerRefund(row, refund, env, pluginConfig);
    const snapshot = providerResultSnapshot(result);
    if (!result?.success) {
      providerFailureSnapshot = snapshot;
      throw new Error(result?.message || '上游退款失败');
    }
    const now = timestamp();
    await env.DB.prepare(`
      UPDATE refund_orders
      SET status = 'SUCCEEDED', provider_refund_no = ?, provider_result_json = ?,
          last_error = '', updated_at = ?, completed_at = ?
      WHERE refund_no = ? AND status = 'PROCESSING'
    `).bind(
      String(result.providerRefundNo ?? ''),
      JSON.stringify(snapshot),
      now,
      now,
      refund.refund_no,
    ).run();
    await recordOperation(
      env,
      row.payment_no,
      'api_refund',
      refund.reason,
      'success',
      'API 退款申请成功',
      { refund_no: refund.refund_no, ...snapshot },
    );
    return env.DB.prepare('SELECT * FROM refund_orders WHERE refund_no = ?').bind(refund.refund_no).first();
  } catch (error) {
    const message = cleanText(error.message ?? error, 500);
    const now = timestamp();
    await env.DB.prepare(`
      UPDATE refund_orders
      SET status = 'FAILED', provider_result_json = ?, last_error = ?, updated_at = ?, completed_at = ?
      WHERE refund_no = ? AND status = 'PROCESSING'
    `).bind(
      providerFailureSnapshot ? JSON.stringify(providerFailureSnapshot) : '{}',
      message,
      now,
      now,
      refund.refund_no,
    ).run();
    await recordOperation(
      env,
      row.payment_no,
      'api_refund',
      refund.reason,
      'failed',
      message,
      { refund_no: refund.refund_no, ...(providerFailureSnapshot ?? {}) },
    );
    throw new Error(message);
  }
}

async function manualRefund(env, row, body) {
  const reserved = await reserveRefund(env, row, body, 'MANUAL', true);
  if (reserved.duplicate && reserved.refund.status !== 'SUCCEEDED') {
    throw new Error(reserved.refund.last_error || '相同退款单状态异常');
  }
  if (!reserved.duplicate) {
    await recordOperation(
      env,
      row.payment_no,
      'manual_refund',
      reserved.refund.reason,
      'success',
      '手动退款已登记成功',
      {
        refund_no: reserved.refund.refund_no,
        refund_amount_fen: Number(reserved.refund.refund_amount_fen),
      },
    );
  }
  return reserved.refund;
}

export async function performAdminOrderAction(env, ctx, paymentNo, actionCode, body, pluginConfig) {
  if (!ACTION_META[actionCode]) throw new Error('订单操作不存在');
  const row = await loadOrder(env, paymentNo);
  if (!row) throw new Error('订单不存在');
  const displayed = publicOrder(row, env);
  const allowed = displayed.actions.find((candidate) => candidate.code === actionCode);
  if (!allowed?.enabled) throw new Error(allowed?.reason || '当前订单不允许此操作');

  let message;
  if (actionCode === 'manual_success') message = await manualSuccess(env, ctx, row, body);
  else if (actionCode === 'renotify') message = await renotify(env, ctx, row);
  else if (actionCode === 'active_query') message = await activeQuery(env, ctx, row, pluginConfig);
  else if (actionCode === 'freeze') message = await freezeOrder(env, row, body);
  else if (actionCode === 'unfreeze') message = await unfreezeOrder(env, row, body);
  else if (actionCode === 'api_refund') {
    const refund = await apiRefund(env, row, body, pluginConfig, true);
    message = `API 退款已提交：¥${fenToMoney(refund.refund_amount_fen)}`;
  } else if (actionCode === 'manual_refund') {
    const refund = await manualRefund(env, row, body);
    message = `手动退款已登记：¥${fenToMoney(refund.refund_amount_fen)}`;
  }
  return {
    ok: true,
    message,
    order: publicOrder(await loadOrder(env, paymentNo), env),
  };
}

export async function performEpayRefund(env, input, pluginConfig) {
  const tradeNo = cleanText(input.trade_no, 64);
  const outTradeNo = cleanText(input.out_trade_no, 64);
  if (!tradeNo && !outTradeNo) throw new Error('trade_no 或 out_trade_no 不能为空');
  const row = tradeNo
    ? await env.DB.prepare('SELECT * FROM payment_attempts WHERE payment_no = ?').bind(tradeNo).first()
    : await env.DB.prepare('SELECT * FROM payment_attempts WHERE external_order_no = ?').bind(outTradeNo).first();
  if (!row) throw new Error('订单不存在');
  const aggregate = await loadOrder(env, row.payment_no);
  const body = {
    money: cleanText(input.money, 64),
    reason: cleanText(input.reason, 300),
    merchant_refund_no: cleanText(input.refund_no ?? input.merchant_refund_no, 128),
  };
  if (!body.money) throw new Error('money 参数不能为空');
  const refund = await apiRefund(env, aggregate, body, pluginConfig, false);
  return {
    refund_no: String(refund.refund_no),
    money: fenToMoney(refund.refund_amount_fen),
  };
}

export const ORDER_ACTION_CODES = Object.freeze(Object.keys(ACTION_META));
export const ORDER_STATUS_LABELS = STATUS_LABELS;
export const REFUND_RESERVING_STATUSES = RESERVING_REFUND_STATUSES;
