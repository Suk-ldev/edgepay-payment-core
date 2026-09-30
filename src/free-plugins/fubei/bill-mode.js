/**
 * 付呗收款单模式（免输金额）。
 *
 * 下单时由 Worker 在付呗 b 站建一张"金额固定、只能付一笔、到订单过期时间自动截止"的收款单，
 * 收银台展示它的收款码；轮询时按收款单号把付款认领回订单。
 * 金额不做偏移，用户扫码后不用输金额；关单交给付呗的截止时间，不依赖轮询。
 */

import { FubeiReceiptClient } from './receipt-site.js';
import { epochSeconds, fubeiPayType, moneyToFen } from './shared.js';

// 与核心的 WATCHER_RECEIPT_KEY 一致：放在这个键下的数据会随订单一起交给轮询。
export const BILL_RECEIPT_KEY = 'receipt_watcher';
export const BILL_MODE = 'bill';
// 付呗收款单标题最多 15 个字。
const BILL_TITLE_PREFIX = 'EP';
const BILL_TITLE_SUFFIX_LENGTH = 12;
// 付款记录比订单创建时间早一点也要查到，免得时钟偏差漏单。
const QUERY_MARGIN_SECONDS = 120;

export function isBillMode(config = {}) {
  return String(config.receipt_bill_mode ?? '') === BILL_MODE;
}

/** 订单是不是收款单模式下的单。切换模式前后建的单可能混在一起，按单认，不按当前配置认。 */
export function billReceiptOf(order) {
  const receipt = order?.ext_json?.[BILL_RECEIPT_KEY] ?? order?.metadata?.[BILL_RECEIPT_KEY] ?? {};
  return receipt.mode === BILL_MODE && receipt.receipt_id ? receipt : null;
}

function billTitle(paymentNo) {
  return `${BILL_TITLE_PREFIX}${String(paymentNo ?? '').slice(-BILL_TITLE_SUFFIX_LENGTH)}`;
}

export async function prepareBill({
  config, amountFen, expiresAt, payType, paymentNo, state = {}, fetchImpl, helpers,
}) {
  const client = new FubeiReceiptClient(config, state.receipt_session, fetchImpl);
  const deadline = Math.floor(Date.parse(expiresAt) / 1_000);
  const storeId = await client.resolveStoreId();
  const receiptId = await client.createBill({ storeId, amountFen, title: billTitle(paymentNo) });
  let qrcodeImage;
  try {
    await client.setDeadline(receiptId, deadline);
    qrcodeImage = await client.billQrcode(receiptId);
  } catch (error) {
    // 截止时间没设上的单是长期有效的，留着就能一直收款却没有订单认领，必须当场关掉。
    await client.closeBill(receiptId).catch(() => {});
    throw error;
  }
  const amount = helpers.fenToMoney(amountFen);
  return {
    metadata: {
      [BILL_RECEIPT_KEY]: {
        mode: BILL_MODE,
        receipt_id: receiptId,
        store_id: String(storeId),
        amount_fen: amountFen,
        expire_at: expiresAt,
        qrcode_image: qrcodeImage,
      },
    },
    presentation: {
      pay_page: 'page',
      pay_type: payType,
      pay_product: 'receipt_plate',
      pay_action: 'web_watcher',
      pay_params: {
        _page: 'receiptQrcode',
        amount,
        original_amount: amount,
        receipt_match_mode: 'amount',
        receipt_valid_seconds: Math.max(60, deadline - Math.floor(Date.now() / 1_000)),
        expire_at: expiresAt,
        expire_at_timestamp: deadline,
        // 只给图片不给链接：付呗的链接在微信里直接打开会卡在公众号授权，必须扫码跳转。
        qrcode_image: qrcodeImage,
        description: '请用微信或支付宝扫码付款，金额已固定，无需手动输入。',
      },
    },
    state: { ...state, receipt_session: client.session() },
  };
}

export function normalizeBillPayments(rows, receiptIds) {
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const receiptId = String(row?.receiptId ?? '').trim();
    if (!receiptIds.has(receiptId) || Number(row?.tradeStatus) !== 1) continue;
    const orderNo = String(row?.payOrderNo ?? '').trim();
    const payType = fubeiPayType(row?.payType);
    const amountFen = moneyToFen(row?.realityAmount);
    const paidAt = epochSeconds(row?.payTime);
    if (!orderNo || !payType || !Number.isSafeInteger(amountFen) || amountFen <= 0 || paidAt === null) continue;
    records.push({
      order_no: orderNo.slice(0, 64),
      receipt_id: receiptId,
      pay_type: payType,
      price: (amountFen / 100).toFixed(2),
      paid_at: paidAt,
      store_id: String(row?.storeId ?? ''),
      merchant_name: String(row?.storeName ?? ''),
    });
  }
  return records;
}

export async function pollBills({ account, orders, state = {}, fetchImpl }) {
  const receiptIds = new Set(orders.map((order) => billReceiptOf(order).receipt_id));
  const created = orders
    .map((order) => epochSeconds(order.created_at ?? order.request_at))
    .filter((value) => value !== null);
  const now = Math.floor(Date.now() / 1_000);
  const start = (created.length ? Math.min(...created) : now) - QUERY_MARGIN_SECONDS;
  const client = new FubeiReceiptClient(account.config ?? {}, state.receipt_session, fetchImpl);
  const rows = await client.billPayments(start, now + 60);
  const records = normalizeBillPayments(rows, receiptIds);
  return {
    records,
    state: { ...state, receipt_session: client.session() },
    details: { bills: receiptIds.size, bill_rows: rows.length, bill_records: records.length },
  };
}

/** 按收款单号认领。流水里没有收款单号（码牌流水）就返回 null，交给核心按金额匹配。 */
export function matchBill({ payments, record, eventId, now, helpers }) {
  const receiptId = String(record?.receipt_id ?? '').trim();
  if (!receiptId) return null;
  const paidAt = helpers.paidAtTimestamp(record?.paid_at);
  if (paidAt === null) throw new Error('付呗收款单付款缺少支付时间');
  const payment = payments.find((candidate) => billReceiptOf(candidate)?.receipt_id === receiptId);
  if (!payment || !helpers.paymentWindowMatches(payment, paidAt)) {
    throw new Error('付呗收款单付款未匹配到支付单');
  }
  const amountFen = helpers.moneyTextToFen(record.price);
  if (amountFen !== Number(payment.expected_amount_fen)) {
    throw new Error(`付呗收款单实收 ${record.price} 元与订单金额不一致`);
  }
  return {
    payment,
    eventAmountFen: amountFen,
    metadataKey: BILL_RECEIPT_KEY,
    receiptPatch: {
      pay_order_no: eventId,
      pay_type: String(record.pay_type ?? ''),
      notified_at: now,
      notified_amount: amountFen,
      record,
    },
  };
}
