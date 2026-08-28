/**
 * Cloudflare Worker runtime port of the source project's:
 * - app/common/payment/AlipayApiPayment.php
 * - app/common/sdk/alipay/AlipayClient.php
 * - app/common/sdk/alipay/AlipaySigner.php
 *
 * Payment products, request parameters, RSA2 signing, notification verification
 * and result fields mirror the source.
 */

import { PROVIDER_CALLBACK_MAX_BYTES, readBoundedText } from './body-limits.js';

const GATEWAY_PRODUCTION = 'https://openapi.alipay.com/gateway.do';
const GATEWAY_SANDBOX = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const PRODUCT_WEB = 'web';
const PRODUCT_H5 = 'h5';
const PRODUCT_APP = 'app';
const PRODUCT_MINI = 'mini';
const PRODUCT_POS = 'pos';
const PRODUCT_SCAN = 'scan';

const encoder = new TextEncoder();

function text(value) {
  return String(value ?? '').trim();
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(text(value).toLowerCase());
}

function amountText(amountFen) {
  return (Number(amountFen) / 100).toFixed(2);
}

function moneyTextToFen(value) {
  const input = text(value);
  if (!/^\d+(?:\.\d{1,2})?$/u.test(input)) throw new Error('支付宝通知金额格式不合法');
  const [yuan, cents = ''] = input.split('.');
  return (Number(yuan) * 100) + Number(cents.slice(0, 2).padEnd(2, '0'));
}

function utf8ByteCut(value, maxBytes) {
  let output = '';
  let size = 0;
  for (const character of String(value ?? '')) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > maxBytes) break;
    output += character;
    size += bytes;
  }
  return output;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value.replace(/\s+/gu, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pemBody(value) {
  return text(value)
    .replace(/-----BEGIN [^-]+-----/gu, '')
    .replace(/-----END [^-]+-----/gu, '')
    .replace(/\s+/gu, '');
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derElement(tag, payload) {
  return concatBytes(Uint8Array.of(tag), derLength(payload.length), payload);
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const RSA_ALGORITHM_IDENTIFIER = Uint8Array.of(
  0x30, 0x0d,
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
);

function wrapPkcs1PrivateKey(pkcs1) {
  return derElement(0x30, concatBytes(
    Uint8Array.of(0x02, 0x01, 0x00),
    RSA_ALGORITHM_IDENTIFIER,
    derElement(0x04, pkcs1),
  ));
}

function wrapPkcs1PublicKey(pkcs1) {
  return derElement(0x30, concatBytes(
    RSA_ALGORITHM_IDENTIFIER,
    derElement(0x03, concatBytes(Uint8Array.of(0x00), pkcs1)),
  ));
}

async function importPrivateKey(value) {
  if (!text(value)) throw new Error('支付宝应用私钥不能为空');
  const bytes = base64ToBytes(pemBody(value));
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  try {
    return await crypto.subtle.importKey('pkcs8', bytes, algorithm, false, ['sign']);
  } catch (firstError) {
    try {
      return await crypto.subtle.importKey('pkcs8', wrapPkcs1PrivateKey(bytes), algorithm, false, ['sign']);
    } catch {
      throw new Error(`支付宝应用私钥无效：${String(firstError.message ?? firstError)}`);
    }
  }
}

async function importPublicKey(value) {
  if (!text(value)) throw new Error('支付宝公钥不能为空');
  const bytes = base64ToBytes(pemBody(value));
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  try {
    return await crypto.subtle.importKey('spki', bytes, algorithm, false, ['verify']);
  } catch (firstError) {
    try {
      return await crypto.subtle.importKey('spki', wrapPkcs1PublicKey(bytes), algorithm, false, ['verify']);
    } catch {
      throw new Error(`支付宝公钥无效：${String(firstError.message ?? firstError)}`);
    }
  }
}

function parameterValue(value) {
  return Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value)
    : String(value);
}

export function alipaySignContent(params, excludeSignType = false) {
  return Object.keys(params)
    .sort()
    .filter((key) => key !== 'sign' && !(excludeSignType && key === 'sign_type'))
    .filter((key) => params[key] !== null && params[key] !== '')
    .map((key) => `${key}=${parameterValue(params[key])}`)
    .join('&');
}

async function rsa2Sign(content, privateKey) {
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(content));
  return bytesToBase64(new Uint8Array(signature));
}

async function rsa2Verify(content, signature, publicKey) {
  let signatureBytes;
  try {
    signatureBytes = base64ToBytes(text(signature));
  } catch {
    return false;
  }
  const key = await importPublicKey(publicKey);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, encoder.encode(content));
}

function shanghaiTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/gu, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function queryString(params) {
  return Object.entries(params)
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join('&');
}

function gateway(config) {
  if (text(config.gateway)) return text(config.gateway);
  return boolValue(config.sandbox) ? GATEWAY_SANDBOX : GATEWAY_PRODUCTION;
}

export function enabledAlipayProducts(config) {
  const configured = config.enabled_products;
  if (Array.isArray(configured)) return configured.map(text).filter(Boolean);
  if (typeof configured !== 'string') return [];
  try {
    const parsed = JSON.parse(configured);
    if (Array.isArray(parsed)) return parsed.map(text).filter(Boolean);
  } catch {
    // The source also accepts comma-separated values when JSON decoding fails.
  }
  return configured.split(',').map(text).filter(Boolean);
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function baseBizContent(config, order) {
  const biz = {
    out_trade_no: String(order.payNo),
    total_amount: amountText(order.amount),
    subject: utf8ByteCut(order.subject, 256),
  };
  const body = text(order.body);
  if (body) biz.body = utf8ByteCut(body, 128);
  for (const key of ['seller_id', 'store_id', 'operator_id', 'terminal_id']) {
    if (text(config[key])) biz[key] = text(config[key]);
  }
  if (text(config.service_provider_id)) {
    biz.extend_params = { sys_service_provider_id: text(config.service_provider_id) };
  }
  if (text(order.merchantParam)) biz.passback_params = rfc3986(text(order.merchantParam));
  return biz;
}

function assertPaymentConfig(config) {
  if (text(config.mode || 'key').toLowerCase() !== 'key') {
    throw new Error('当前支付宝证书模式尚未配置 Worker 证书内容');
  }
  if (!text(config.app_id) || !text(config.private_key) || !text(config.alipay_public_key)) {
    throw new Error('支付宝应用 AppID、应用私钥和支付宝公钥不能为空');
  }
}

async function signedParams(config, method, bizContent, options = {}) {
  const params = {
    app_id: text(config.app_id),
    method,
    format: text(config.format).toUpperCase() || 'JSON',
    charset: text(config.charset) || 'UTF-8',
    sign_type: text(config.sign_type).toUpperCase() || 'RSA2',
    timestamp: shanghaiTimestamp(),
    version: text(config.version) || '1.0',
  };
  if (text(options.notifyUrl)) params.notify_url = text(options.notifyUrl);
  if (text(options.returnUrl)) params.return_url = text(options.returnUrl);
  if (text(config.app_auth_token)) params.app_auth_token = text(config.app_auth_token);
  params.biz_content = JSON.stringify(bizContent);
  params.sign = await rsa2Sign(alipaySignContent(params), config.private_key);
  return params;
}

async function signedClientParams(config, method, productCode, order, extraBiz = {}) {
  const biz = {
    ...baseBizContent(config, order),
    ...extraBiz,
    product_code: productCode,
  };
  const params = await signedParams(config, method, biz, {
    notifyUrl: order.callbackUrl,
    returnUrl: order.providerReturnUrl || order.returnUrl,
  });
  return { biz, params };
}

function productCandidates(order) {
  const explicit = text(order.alipayProduct).toLowerCase();
  if (explicit) return [explicit];
  if (text(order.authCode)) return [PRODUCT_POS, PRODUCT_SCAN, PRODUCT_WEB, PRODUCT_H5];

  const device = text(order.device || 'pc').toLowerCase();
  const mobileDevices = new Set(['mobile', 'qq', 'wechat', 'alipay', 'jump']);
  const candidates = mobileDevices.has(device)
    ? [PRODUCT_H5, PRODUCT_MINI, PRODUCT_WEB, PRODUCT_SCAN]
    : [PRODUCT_WEB, PRODUCT_SCAN, PRODUCT_H5];
  const hasMiniIdentity = firstText(order.subAppId, order.opAppId)
    && firstText(order.subOpenid, order.buyerOpenId, order.buyerId);
  if (device === 'alipay' && hasMiniIdentity) candidates.unshift(PRODUCT_MINI);
  return [...new Set(candidates)];
}

function resolvedProducts(config, order) {
  const supported = new Set([
    PRODUCT_WEB, PRODUCT_H5, PRODUCT_APP, PRODUCT_MINI, PRODUCT_POS, PRODUCT_SCAN,
  ]);
  const enabled = enabledAlipayProducts(config).filter((product) => supported.has(product));
  const explicit = text(order.alipayProduct).toLowerCase();
  if (explicit && !supported.has(explicit)) throw new Error(`不支持的支付宝支付产品：${explicit}`);
  const products = productCandidates(order).filter((product) => enabled.includes(product));
  if (products.length) return products;
  throw new Error('当前支付宝通道没有开通适合该支付环境的产品');
}

function alipayBusinessError(prefix, data) {
  const error = new Error(`${prefix}：${alipayResponseMessage(data)}`);
  error.channelErrorCode = text(data.sub_code ?? data.code);
  return error;
}

function shouldFallbackProduct(error) {
  const errorCode = text(error?.channelErrorCode).toUpperCase();
  const message = text(error?.message).toUpperCase();
  if ([
    'ACQ.ACCESS_FORBIDDEN',
    'ACCESS_FORBIDDEN',
    'ISV.INSUFFICIENT-ISV-PERMISSIONS',
    'INSUFFICIENT-ISV-PERMISSIONS',
  ].includes(errorCode)) return true;
  return ['ACCESS_FORBIDDEN', 'INSUFFICIENT-ISV-PERMISSIONS', '权限不足', '无权限', '未签约']
    .some((keyword) => message.includes(keyword.toUpperCase()));
}

function jumpPayment(product, description, url, params) {
  const raw = {
    method: 'GET',
    url,
    html: `<script>window.location.href=${JSON.stringify(url)};</script>`,
    params,
  };
  return {
    pay_page: 'jump',
    pay_type: 'alipay',
    pay_product: product,
    pay_action: 'jump',
    pay_params: { url, html: raw.html, description, raw },
    chan_order_no: '',
    chan_trade_no: '',
  };
}

async function payWeb(config, order) {
  const { params } = await signedClientParams(
    config,
    'alipay.trade.page.pay',
    'FAST_INSTANT_TRADE_PAY',
    order,
  );
  const result = jumpPayment(
    PRODUCT_WEB,
    '正在跳转支付宝网页支付。',
    `${gateway(config)}?${queryString(params)}`,
    params,
  );
  result.chan_order_no = String(order.payNo);
  return result;
}

async function payH5(config, order) {
  const extraBiz = {};
  if (text(order.returnUrl)) extraBiz.quit_url = text(order.returnUrl);
  const { params } = await signedClientParams(
    config,
    'alipay.trade.wap.pay',
    'QUICK_WAP_WAY',
    order,
    extraBiz,
  );
  const result = jumpPayment(
    PRODUCT_H5,
    '正在跳转支付宝 H5 支付。',
    `${gateway(config)}?${queryString(params)}`,
    params,
  );
  result.chan_order_no = String(order.payNo);
  return result;
}

async function payApp(config, order) {
  const { params } = await signedClientParams(
    config,
    'alipay.trade.app.pay',
    'QUICK_MSECURITY_PAY',
    order,
  );
  const orderString = queryString(params);
  return {
    pay_page: 'page',
    pay_type: 'alipay',
    pay_product: PRODUCT_APP,
    pay_action: 'app',
    pay_params: {
      _page: 'page',
      params: orderString,
      order_string: orderString,
      description: 'APP 支付参数已生成，请在原生 App 中交给支付宝 SDK。',
      raw: { order_string: orderString, params },
    },
    chan_order_no: String(order.payNo),
    chan_trade_no: '',
  };
}

async function payScan(config, order) {
  const { data, raw } = await alipayGatewayRequest(
    config,
    'alipay.trade.precreate',
    { ...baseBizContent(config, order), product_code: 'QR_CODE_OFFLINE' },
    { notifyUrl: order.callbackUrl },
  );
  if (text(data.code) !== '10000') throw alipayBusinessError('支付宝扫码支付预创建失败', data);
  const qrcode = text(data.qr_code);
  if (!qrcode) throw new Error('支付宝扫码支付预创建未返回 qr_code');
  return {
    pay_page: 'qrcode',
    pay_type: 'alipay',
    pay_product: PRODUCT_SCAN,
    pay_action: 'qrcode',
    pay_params: { qrcode, description: '请使用支付宝扫描二维码付款。', raw: JSON.parse(raw) },
    chan_order_no: text(data.out_trade_no) || String(order.payNo),
    chan_trade_no: text(data.trade_no),
  };
}

async function payMini(config, order) {
  const opAppId = firstText(order.subAppId, order.opAppId, config.mini_app_id);
  const buyerOpenId = firstText(order.subOpenid, order.buyerOpenId);
  const buyerId = text(order.buyerId);
  if (!opAppId) throw new Error('支付宝小程序支付必须配置或传入小程序 AppID');
  if (!buyerOpenId && !buyerId) {
    throw new Error('支付宝小程序支付必须传入 buyer_open_id 或 buyer_id');
  }
  const biz = {
    ...baseBizContent(config, order),
    product_code: 'JSAPI_PAY',
    op_app_id: opAppId,
  };
  if (buyerOpenId) biz.buyer_open_id = buyerOpenId;
  else biz.buyer_id = buyerId;
  const { data, raw } = await alipayGatewayRequest(
    config,
    'alipay.trade.create',
    biz,
    { notifyUrl: order.callbackUrl },
  );
  if (text(data.code) !== '10000') throw alipayBusinessError('支付宝小程序支付创建交易失败', data);
  const tradeNo = text(data.trade_no);
  if (!tradeNo) throw new Error('支付宝小程序支付创建交易未返回 trade_no');
  return {
    pay_page: 'page',
    pay_type: 'alipay',
    pay_product: PRODUCT_MINI,
    pay_action: 'jsapi',
    pay_params: {
      _page: 'alipayMini',
      tradeNO: tradeNo,
      trade_no: tradeNo,
      app_id: opAppId,
      mini_launch_path: text(config.mini_launch_path),
      description: '小程序支付参数已生成，请在支付宝小程序中调用 my.tradePay。',
      raw: JSON.parse(raw),
    },
    chan_order_no: text(data.out_trade_no) || String(order.payNo),
    chan_trade_no: tradeNo,
  };
}

async function payPos(config, order) {
  const authCode = text(order.authCode);
  if (!authCode) throw new Error('刷卡支付必须传入付款码 auth_code');
  const { data, raw } = await alipayGatewayRequest(
    config,
    'alipay.trade.pay',
    {
      ...baseBizContent(config, order),
      product_code: 'FACE_TO_FACE_PAYMENT',
      scene: 'bar_code',
      auth_code: authCode,
    },
    { notifyUrl: order.callbackUrl },
  );
  const code = text(data.code);
  if (!['10000', '10003'].includes(code)) throw alipayBusinessError('支付宝刷卡支付失败', data);
  return {
    pay_page: code === '10000' ? 'ok' : 'page',
    pay_type: 'alipay',
    pay_product: PRODUCT_POS,
    pay_action: 'scan',
    pay_params: {
      _page: 'page',
      params: code === '10000' ? '支付成功' : '等待用户确认支付',
      description: code === '10000' ? '支付宝已确认支付成功。' : '等待用户在支付宝确认支付。',
      raw: JSON.parse(raw),
    },
    chan_order_no: text(data.out_trade_no) || String(order.payNo),
    chan_trade_no: text(data.trade_no),
  };
}

async function payByProduct(product, config, order) {
  if (product === PRODUCT_POS) return payPos(config, order);
  if (product === PRODUCT_SCAN) return payScan(config, order);
  if (product === PRODUCT_MINI) return payMini(config, order);
  if (product === PRODUCT_APP) return payApp(config, order);
  if (product === PRODUCT_H5) return payH5(config, order);
  if (product === PRODUCT_WEB) return payWeb(config, order);
  throw new Error(`不支持的支付宝支付产品：${product}`);
}

export async function createAlipayPayment(config, order) {
  assertPaymentConfig(config);
  const products = resolvedProducts(config, order);
  const attempts = [];
  for (const [index, product] of products.entries()) {
    try {
      return await payByProduct(product, config, order);
    } catch (error) {
      attempts.push({
        product,
        message: String(error.message ?? error),
        channel_error_code: text(error.channelErrorCode),
      });
      if (index === products.length - 1 || !shouldFallbackProduct(error)) {
        error.productAttempts = attempts;
        throw error;
      }
    }
  }
  throw new Error('当前支付宝通道没有可用支付产品');
}

function alipayTradeIdentity(order) {
  const providerTradeNo = text(order.providerTradeNo);
  if (providerTradeNo && providerTradeNo !== text(order.payNo)) return { trade_no: providerTradeNo };
  return { out_trade_no: text(order.payNo) };
}

function extractJsonValue(rawBody, key) {
  const marker = `"${key}"`;
  const markerAt = rawBody.indexOf(marker);
  if (markerAt < 0) return '';
  const colonAt = rawBody.indexOf(':', markerAt + marker.length);
  if (colonAt < 0) return '';
  let start = colonAt + 1;
  while (start < rawBody.length && /\s/u.test(rawBody[start])) start += 1;
  if (rawBody[start] !== '{') return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < rawBody.length; index += 1) {
    const character = rawBody[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return rawBody.slice(start, index + 1);
    }
  }
  return '';
}

/**
 * 已签名的支付宝网关请求。这是通用签名能力，付费的支付宝账单插件在私有仓库里
 * 复用同一份实现，因此必须导出。
 */
export async function alipayGatewayRequest(config, method, bizContent, options = {}) {
  assertPaymentConfig(config);
  const params = await signedParams(config, method, bizContent, options);

  let response;
  try {
    response = await fetch(gateway(config), {
      method: 'POST',
      headers: { 'content-type': `application/x-www-form-urlencoded;charset=${params.charset}` },
      body: queryString(params),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`支付宝请求失败：${String(error.message ?? error)}`);
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`支付宝 HTTP 状态异常：${response.status}`);
  let decoded;
  try { decoded = JSON.parse(raw); } catch { throw new Error('支付宝响应不是有效 JSON'); }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') {
    throw new Error('支付宝响应不是有效 JSON');
  }

  const responseKey = `${method.replaceAll('.', '_')}_response`;
  const data = decoded[responseKey] ?? decoded.error_response ?? {};
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('支付宝响应节点不合法');
  const sign = text(decoded.sign);
  if (!sign) throw new Error('支付宝响应缺少 sign');
  const signContent = extractJsonValue(raw, decoded[responseKey] ? responseKey : 'error_response');
  if (!signContent || !await rsa2Verify(signContent, sign, config.alipay_public_key)) {
    throw new Error('支付宝响应验签失败');
  }
  return { data, raw };
}

export function alipayResponseMessage(data) {
  return text(data.sub_msg ?? data.msg) || '支付宝请求失败';
}

export async function queryAlipayPayment(config, order) {
  const { data, raw } = await alipayGatewayRequest(
    config,
    'alipay.trade.query',
    alipayTradeIdentity(order),
  );
  if (text(data.code) !== '10000') {
    return { success: false, status: 'pending', message: alipayResponseMessage(data) };
  }
  const tradeStatus = text(data.trade_status).toUpperCase();
  const status = ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(tradeStatus)
    ? 'success'
    : tradeStatus === 'TRADE_CLOSED' ? 'closed' : 'pending';
  return {
    success: true,
    status,
    payNo: text(order.payNo),
    message: tradeStatus || text(data.msg),
    channelOrderNo: text(data.out_trade_no) || text(order.payNo),
    channelTradeNo: text(data.trade_no) || text(order.providerTradeNo) || text(order.payNo),
    channelStatus: tradeStatus,
    paidAt: status === 'success' ? text(data.send_pay_date ?? data.gmt_payment) : '',
    raw: JSON.parse(raw),
  };
}

export async function refundAlipayPayment(config, order) {
  const payload = {
    ...alipayTradeIdentity(order),
    refund_amount: amountText(Math.max(1, Number(order.refundAmount))),
    out_request_no: text(order.refundNo),
  };
  if (text(order.reason)) payload.refund_reason = [...text(order.reason)].slice(0, 256).join('');
  const { data, raw } = await alipayGatewayRequest(config, 'alipay.trade.refund', payload);
  if (text(data.code) !== '10000') {
    const upstreamMessage = alipayResponseMessage(data);
    const message = upstreamMessage.includes('卖家余额不足')
      ? '支付宝返回“卖家余额不足”：请检查该支付宝商户的可用余额、结算状态或资金渠道'
      : `支付宝退款失败：${upstreamMessage}`;
    return {
      success: false,
      message,
      providerStatus: text(data.sub_code ?? data.code),
      raw: JSON.parse(raw),
    };
  }
  return {
    success: true,
    message: '退款申请成功',
    providerRefundNo: text(data.trade_no) || text(order.refundNo),
    providerStatus: text(data.fund_change) || text(data.code),
    refundAmount: Number(order.refundAmount),
    raw: JSON.parse(raw),
  };
}

function requestParameters(request, rawBody = '') {
  const values = Object.fromEntries(new URL(request.url).searchParams.entries());
  if (!['GET', 'HEAD'].includes(request.method)) {
    Object.assign(values, Object.fromEntries(new URLSearchParams(rawBody).entries()));
  }
  return values;
}

function notifyStatus(tradeStatus) {
  if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(tradeStatus)) return 'success';
  if (tradeStatus === 'TRADE_CLOSED') return 'failed';
  return 'pending';
}

export async function handleAlipayNotify(request, config) {
  const raw = ['GET', 'HEAD'].includes(request.method)
    ? new URL(request.url).searchParams.toString()
    : await readBoundedText(request.clone(), PROVIDER_CALLBACK_MAX_BYTES, '支付宝回调请求体');
  const params = requestParameters(request, raw);
  if (!await rsa2Verify(
    alipaySignContent(params, true),
    params.sign,
    config.alipay_public_key,
  )) {
    throw new Error('支付宝异步通知验签失败');
  }
  if (text(params.app_id) !== text(config.app_id)) {
    throw new Error('支付宝异步通知 app_id 不匹配');
  }

  const payNo = text(params.out_trade_no);
  const tradeNo = text(params.trade_no);
  if (!payNo) throw new Error('支付宝异步通知缺少 out_trade_no');
  const tradeStatus = text(params.trade_status).toUpperCase();
  const status = notifyStatus(tradeStatus);
  const amountFen = params.total_amount ? moneyTextToFen(params.total_amount) : 0;
  if (status === 'success' && amountFen <= 0) throw new Error('支付宝通知金额格式不合法');
  const eventId = text(params.notify_id)
    || `alipay:${tradeNo || payNo}:${tradeStatus || 'PENDING'}:${text(params.gmt_payment || params.notify_time)}`;

  return {
    status,
    payNo,
    amountFen,
    message: tradeStatus,
    channelOrderNo: payNo,
    channelTradeNo: tradeNo || payNo,
    channelStatus: tradeStatus,
    paidAt: status === 'success' ? text(params.gmt_payment) : '',
    failedAt: status === 'failed' ? text(params.notify_time) : '',
    eventId,
    raw,
  };
}
