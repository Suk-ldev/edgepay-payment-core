export const RECEIPT_IDENTIFIER_KEYS = Object.freeze([
  'receipt_account_no',
  'receipt_store_id',
  'receipt_terminal_no',
  'receipt_page_id',
]);

export const RECEIPT_DISCOVERY_WINDOW_SECONDS = 5 * 60;

function clean(value, maximum = 128) {
  return String(value ?? '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, maximum);
}

export function receiptDiscoveryFields(manifest) {
  if (manifest?.mode !== 'channel-notify') return [];
  return (manifest.adminFields ?? [])
    .filter((field) => RECEIPT_IDENTIFIER_KEYS.includes(field.key))
    .map((field) => ({ key: field.key, label: field.label }));
}

export function receiptDiscoveryAvailable(manifest) {
  return receiptDiscoveryFields(manifest).length > 0;
}

/** 流水探测不能带用户可能填错的筛选编号，否则恰好会把真实流水过滤掉。 */
export function unscopedReceiptConfig(config = {}) {
  const result = { ...config };
  for (const key of RECEIPT_IDENTIFIER_KEYS) result[key] = '';
  return result;
}

/**
 * 各平台查询器会在订单时间窗前后留缓冲；用当前时刻作锚点，查询后再严格裁成近 5 分钟。
 */
export function receiptDiscoveryAccount(pluginCode, config, now = new Date()) {
  const anchor = now.toISOString();
  return {
    account_key: `discovery:${pluginCode}`,
    plugin_code: pluginCode,
    config: unscopedReceiptConfig(config),
    discovery: true,
    orders: [{ created_at: anchor, request_at: anchor, expire_at: anchor }],
  };
}

export function sanitizeReceiptDiscoveryRecords(records, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const cutoff = nowSeconds - RECEIPT_DISCOVERY_WINDOW_SECONDS;
  const normalized = [];
  for (const record of Array.isArray(records) ? records : []) {
    const paidAt = Number(record?.paid_at);
    if (!Number.isFinite(paidAt) || paidAt < cutoff || paidAt > nowSeconds + 60) continue;
    const price = clean(record?.price, 32);
    if (!/^\d+(?:\.\d{1,6})?$/u.test(price)) continue;
    const identifiers = {
      receipt_account_no: clean(record?.merchant_no),
      receipt_store_id: clean(record?.store_id),
      receipt_terminal_no: clean(record?.terminal_no),
      receipt_page_id: clean(record?.page_id),
    };
    if (!Object.values(identifiers).some(Boolean) && record?.channel) {
      identifiers.receipt_terminal_no = clean(record.channel);
    }
    normalized.push({
      order_no: clean(record?.order_no, 96),
      paid_at: Math.floor(paidAt),
      price,
      pay_type: ['wxpay', 'alipay'].includes(String(record?.pay_type)) ? String(record.pay_type) : '',
      merchant_name: clean(record?.merchant_name),
      identifiers,
    });
  }
  return normalized
    .sort((left, right) => right.paid_at - left.paid_at)
    .slice(0, 20);
}
