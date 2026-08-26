const encoder = new TextEncoder();

export const PERSONAL_RECEIPT_KEY = 'personal_receipt';

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeTextEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function verifyStaticPollToken(request, secret) {
  // 同上：两端一起 trim，避免把计划任务地址里多出来的空白当成不同的 Token。
  const expected = String(secret ?? '').trim();
  if (request.method !== 'GET' || !expected) return false;
  const provided = String(new URL(request.url).searchParams.get('token') ?? '').trim();
  return timingSafeTextEqual(provided, expected);
}

export async function hmacSha256Base64(secret, content) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(content)))));
}

export function decimalToInteger(value, scale) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text)) throw new Error('数字格式不合法');
  const [integer, fraction = ''] = text.split('.', 2);
  return (Number(integer) * (10 ** scale)) + Number(fraction.slice(0, scale).padEnd(scale, '0'));
}

export function moneyTextToFen(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) throw new Error('流水金额格式不合法');
  const [integer, fraction = ''] = text.split('.', 2);
  return (Number(integer) * 100) + Number(fraction.slice(0, 2).padEnd(2, '0'));
}

export function paidAtTimestamp(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/u.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

export function paidAtIso(value) {
  const seconds = paidAtTimestamp(value);
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

export function receiptRemarkCode(record) {
  const match = String(record?.remark ?? '').trim().match(/(?<!\d)(\d{4})(?!\d)/u);
  if (!match) throw new Error('流水备注未识别到付款备注码');
  return match[1];
}

export function watcherRecord(payload) {
  const candidate = payload?.record && typeof payload.record === 'object' && !Array.isArray(payload.record)
    ? payload.record
    : payload;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('流水记录不能为空');
  }
  return candidate;
}

export function watcherRecords(payload) {
  if (payload?.record && typeof payload.record === 'object' && !Array.isArray(payload.record)) {
    return [payload.record];
  }
  if (Array.isArray(payload?.records)) {
    const records = payload.records.filter((record) => record && typeof record === 'object' && !Array.isArray(record));
    if (records.length) return records;
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return [payload];
  throw new Error('流水记录不能为空');
}

export function eventOrderNo(record, label = '流水') {
  const orderNo = String(record?.order_no ?? '').trim();
  if (!orderNo) throw new Error(`${label}订单号不能为空`);
  return orderNo.slice(0, 64);
}

export function paymentWindowMatches(payment, paidAtSeconds) {
  const requestSeconds = Math.floor(Date.parse(String(payment.created_at ?? '')) / 1_000);
  const expireSeconds = Math.floor(Date.parse(String(payment.expires_at ?? '')) / 1_000);
  return Number.isFinite(requestSeconds)
    && Number.isFinite(expireSeconds)
    && paidAtSeconds >= requestSeconds
    && paidAtSeconds <= expireSeconds;
}

export function closestPayment(payments, paidAtSeconds) {
  return [...payments].sort((left, right) => {
    const leftSeconds = Math.floor(Date.parse(String(left.created_at ?? '')) / 1_000);
    const rightSeconds = Math.floor(Date.parse(String(right.created_at ?? '')) / 1_000);
    return Math.abs(leftSeconds - paidAtSeconds) - Math.abs(rightSeconds - paidAtSeconds);
  })[0] ?? null;
}

export function payTypeMatches(paymentType, recordType) {
  const expected = String(paymentType ?? '').trim().toLowerCase();
  const actual = String(recordType ?? '').trim().toLowerCase();
  if (!actual || expected === 'usdt') return true;
  return expected === actual;
}

export function selectPersonalReceipt(payments, record) {
  const amountFen = moneyTextToFen(record?.price);
  const paidAt = paidAtTimestamp(record?.paid_at);
  if (paidAt === null) throw new Error('流水支付时间不能为空');
  const candidates = [];
  for (const payment of payments) {
    const metadata = typeof payment.metadata === 'object' ? payment.metadata : {};
    const receipt = metadata[PERSONAL_RECEIPT_KEY] ?? {};
    if (!paymentWindowMatches(payment, paidAt)) continue;
    if (!payTypeMatches(metadata.epay_type, record?.pay_type)) continue;
    if (receipt.mode === 'remark') {
      let code;
      try { code = receiptRemarkCode(record); } catch { continue; }
      if (String(receipt.remark_code ?? '') !== code) continue;
      if (Number(receipt.original_amount ?? payment.expected_amount_fen) !== amountFen) continue;
    } else if (Number(receipt.receipt_amount ?? payment.expected_amount_fen) !== amountFen) {
      continue;
    }
    candidates.push(payment);
  }
  const selected = closestPayment(candidates, paidAt);
  if (!selected) throw new Error('流水未匹配到支付单');
  return { payment: selected, amountFen, paidAt };
}

export async function readSignedWatcherPayload(request, secret, nowSeconds = Date.now() / 1_000) {
  const raw = await request.text();
  const timestamp = String(request.headers.get('x-watcher-timestamp') ?? '').trim();
  const signature = String(request.headers.get('x-watcher-signature') ?? '').trim();
  const seconds = Number(timestamp);
  // 两端都要 trim，而且必须一致。密钥从部署完成页复制、粘进 docker run 的引号里、
  // 或填进 Cloudflare 面板时，很容易多带一个换行。只有一端 trim 会让签名全部对不上，
  // 而错误只有一句 401，根本看不出是多了个看不见的字符。
  const secrets = (Array.isArray(secret) ? secret : [secret])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (!secrets.length || !timestamp || !signature || !Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > 300) {
    throw new Error('监听器签名参数不完整或已失效');
  }
  const path = new URL(request.url).pathname;
  let verified = false;
  for (const candidate of secrets) {
    const expected = `v1=${await hmacSha256Base64(candidate, `${timestamp}.${request.method}.${path}.${raw}`)}`;
    if (timingSafeTextEqual(signature, expected)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error('监听器签名校验失败');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('监听器通知必须是 JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('监听器通知格式不合法');
  return { payload, raw };
}

export async function verifyWatcherSnapshotRequest(request, secret, nowSeconds = Date.now() / 1_000) {
  const timestamp = String(request.headers.get('x-watcher-timestamp') ?? '').trim();
  const signature = String(request.headers.get('x-watcher-signature') ?? '').trim();
  const seconds = Number(timestamp);
  // 两端都要 trim，而且必须一致。密钥从部署完成页复制、粘进 docker run 的引号里、
  // 或填进 Cloudflare 面板时，很容易多带一个换行。只有一端 trim 会让签名全部对不上，
  // 而错误只有一句 401，根本看不出是多了个看不见的字符。
  const secrets = (Array.isArray(secret) ? secret : [secret])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (!secrets.length || !timestamp || !signature || !Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > 300) {
    return false;
  }
  const path = new URL(request.url).pathname;
  for (const candidate of secrets) {
    const expected = `v1=${await hmacSha256Base64(candidate, `${timestamp}.${request.method}.${path}.`)}`;
    if (timingSafeTextEqual(signature, expected)) return true;
  }
  return false;
}

export function isSmsForwarderProbeRequest(request) {
  if (request.method === 'HEAD') return true;
  if (request.method !== 'GET') return false;
  const search = new URL(request.url).searchParams;
  return !['timestamp', 'sign', 'from', 'content'].some((field) => search.has(field));
}

export function classifySmsForwarderDeliveryError(error) {
  const rawMessage = String(error?.message ?? error ?? '').replace(/[\r\n]+/gu, ' ').slice(0, 200);
  if (rawMessage.includes('未匹配到支付单')) {
    return {
      httpStatus: 202,
      ok: true,
      accepted: true,
      confirmed: false,
      status: 'unmatched',
      message: '通知已通过验签，但未匹配到有效待支付订单。',
    };
  }
  if (rawMessage.includes('签名')) {
    return {
      httpStatus: 401,
      ok: false,
      accepted: false,
      confirmed: false,
      status: 'unauthorized',
      message: '投送失败：签名参数不完整、签名不正确或通知已过期。',
    };
  }
  if (rawMessage.includes('订单状态已变化')) {
    return {
      httpStatus: 409,
      ok: false,
      accepted: true,
      confirmed: false,
      status: 'order_conflict',
      message: '通知已接收，但订单状态已经发生变化。',
    };
  }
  if (
    error instanceof SyntaxError
    || /通知内容|非微信通知来源|未支持的微信通知标题|收款金额|请求体格式|流水支付时间|流水金额|JSON/iu.test(rawMessage)
  ) {
    return {
      httpStatus: 422,
      ok: false,
      accepted: false,
      confirmed: false,
      status: 'invalid_payload',
      message: `投送失败：${rawMessage || '通知内容格式不合法'}`,
    };
  }
  return {
    httpStatus: 500,
    ok: false,
    accepted: false,
    confirmed: false,
    status: 'internal_error',
    message: '通知处理失败，请稍后重试并查看 Worker 日志。',
  };
}

export async function parseSmsForwarder(input, config, nowSeconds = Date.now() / 1_000, platform = 'wechat') {
  const timestamp = String(input?.timestamp ?? '');
  const sign = decodeURIComponent(String(input?.sign ?? ''));
  const secret = String(config?.sms_forwarder_secret ?? '');
  const tolerance = Math.max(30, Number(config?.sms_forwarder_time_tolerance ?? 300));
  const seconds = Math.floor(Number(timestamp) / 1_000);
  if (!timestamp || !sign || !secret || !seconds || Math.abs(nowSeconds - seconds) > tolerance) {
    throw new Error('SmsForwarder 通知签名参数不完整或已失效');
  }
  const expected = await hmacSha256Base64(secret, `${timestamp}\n${secret}`);
  if (!timingSafeTextEqual(expected, sign)) throw new Error('SmsForwarder 通知签名校验失败');
  const isAlipay = platform === 'alipay';
  const expectedPackage = isAlipay ? 'com.eg.android.AlipayGphone' : 'com.tencent.mm';
  if (input.from && input.from !== expectedPackage) throw new Error(`非${isAlipay ? '支付宝' : '微信'}通知来源`);
  let content;
  try { content = JSON.parse(String(input.content ?? '')); } catch { throw new Error('SmsForwarder 通知内容格式不合法'); }
  if (!content || typeof content !== 'object' || !String(content.title ?? '').trim() || !String(content.msg ?? '').trim()) {
    throw new Error('SmsForwarder 通知内容格式不合法');
  }
  const title = String(content.title);
  const message = String(content.msg);
  if (!isAlipay && !['微信支付', '微信收款助手', '微信收款商业版'].includes(title)) {
    throw new Error('未支持的微信通知标题');
  }
  if (isAlipay && !title.includes('元') && !message.includes('元')) throw new Error('未支持的支付宝收款通知');
  const notificationText = isAlipay ? `${title}\n${message}` : message;
  const amountMatch = notificationText.match(/(?:成功收款|收钱到账|收款到账|到账|收款)?\s*(\d+(?:\.\d{1,2})?)\s*元/u);
  if (!amountMatch) throw new Error('通知内容未识别到收款金额');
  const remarkMatch = notificationText.match(/(?:备注|留言|附言|付款备注|收款备注)[:：\s]*([0-9]{4})/u);
  return {
    amountFen: moneyTextToFen(amountMatch[1]),
    remarkCode: remarkMatch?.[1] ?? '',
    paidAt: seconds,
    content,
    platform: isAlipay ? 'alipay' : 'wechat',
  };
}
