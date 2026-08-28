/**
 * Cloudflare Worker runtime port of the V2 payment branches in the source project's:
 * - app/common/payment/WechatApiPayment.php
 * - app/common/sdk/wxpay/WxpayClient.php
 * - app/common/sdk/wxpay/WxpaySigner.php
 * - app/common/sdk/wxpay/WxpayXml.php
 */
import { md5Hex } from './epay-v1.js';

import { PROVIDER_CALLBACK_MAX_BYTES, readBoundedText } from './body-limits.js';

const encoder = new TextEncoder();
const V2_SUCCESS_XML = '<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>';
const V2_FAIL_XML = '<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[FAIL]]></return_msg></xml>';

function text(value) {
  return String(value ?? '').trim();
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(text(value).toLowerCase());
}

function apiKey(config) {
  return text(config.api_key ?? config.api_v2_key);
}

function utf8ByteCut(value, maxBytes) {
  let output = '';
  let size = 0;
  for (const character of String(value ?? '')) {
    const length = encoder.encode(character).length;
    if (size + length > maxBytes) break;
    output += character;
    size += length;
  }
  return output;
}

function normalizeProduct(value) {
  const product = text(value).toLowerCase();
  return {
    jsapi: 'mp',
    native: 'scan',
    mweb: 'h5',
    miniapp: 'mini',
    applet: 'mini',
  }[product] ?? product;
}

export function enabledWechatProducts(config) {
  const configured = config.enabled_products;
  let products = [];
  if (Array.isArray(configured)) products = configured;
  else if (typeof configured === 'string') {
    try {
      const parsed = JSON.parse(configured);
      products = Array.isArray(parsed) ? parsed : configured.split(',');
    } catch {
      products = configured.split(',');
    }
  }
  return [...new Set(products.map(normalizeProduct).filter((product) => {
    return ['mp', 'h5', 'app', 'mini', 'scan'].includes(product);
  }))];
}

function productAppId(config, product) {
  const field = {
    mp: 'mp_app_id',
    app: 'app_app_id',
    mini: 'mini_app_id',
  }[normalizeProduct(product)];
  return text(field ? config[field] : '') || text(config.app_id);
}

function openidFromOrder(order, product) {
  if (normalizeProduct(product) === 'mini') {
    return text(order.miniOpenid) || text(order.openid) || text(order.subOpenid);
  }
  return text(order.openid)
    || text(order.subOpenid)
    || text(order.wxOpenid)
    || text(order.buyerOpenId);
}

function requestedProduct(order) {
  const product = normalizeProduct(order.wechatProduct);
  return ['mp', 'h5', 'app', 'mini', 'scan'].includes(product) ? product : '';
}

export function resolveWechatV2Products(config, order) {
  const enabled = enabledWechatProducts(config);
  const explicit = requestedProduct(order);
  if (explicit) {
    if (!enabled.includes(explicit)) {
      throw new Error(`当前微信支付通道没有启用${wechatProductName(explicit)}`);
    }
    return [explicit];
  }

  const device = text(order.device || 'pc').toLowerCase();
  let candidates;
  if (text(order.miniOpenid)) candidates = ['mini', 'mp', 'scan'];
  else if (device === 'wechat') candidates = ['mp', 'mini', 'scan'];
  else if (device === 'app') candidates = ['app', 'h5', 'scan'];
  else if (['mobile', 'qq', 'alipay', 'jump'].includes(device)) candidates = ['h5', 'mini', 'scan'];
  else candidates = ['scan', 'h5'];

  const products = candidates.filter((product) => enabled.includes(product));
  if (!products.length) {
    throw new Error('当前微信支付通道没有开通适合该支付环境的产品');
  }
  return products;
}

function wechatProductName(product) {
  return {
    mp: 'JSAPI 支付',
    h5: 'H5 支付',
    app: 'APP 支付',
    mini: '小程序支付',
    scan: 'Native 支付',
  }[normalizeProduct(product)] ?? '微信支付';
}

function nonceStr(length = 32) {
  const characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let output = '';
  for (const byte of bytes) output += characters[byte % characters.length];
  return output;
}

function wechatTimeExpire(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
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
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function paymentOrigin(order) {
  for (const value of [order.paymentUrl, order.cashierUrl, order.returnUrl]) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') return url.origin;
    } catch {
      // Try the next known public URL.
    }
  }
  return '';
}

function h5SceneInfo(config, order) {
  const configuredType = text(config.h5_info_type) || 'Wap';
  const normalizedType = configuredType.toLowerCase();
  const appName = text(config.h5_app_name) || text(order.merchantName) || 'EdgePay';
  if (normalizedType === 'android') {
    const packageName = text(config.h5_package_name);
    if (!packageName) throw new Error('微信 H5 Android 场景必须配置应用包名');
    return { h5_info: { type: 'Android', app_name: appName, package_name: packageName } };
  }
  if (normalizedType === 'ios') {
    const bundleId = text(config.h5_bundle_id);
    if (!bundleId) throw new Error('微信 H5 IOS 场景必须配置 Bundle ID');
    return { h5_info: { type: 'IOS', app_name: appName, bundle_id: bundleId } };
  }
  const wapUrl = text(config.h5_app_url) || paymentOrigin(order);
  if (!wapUrl) throw new Error('微信 H5 WAP 场景必须配置网站 URL');
  return { h5_info: { type: 'Wap', wap_url: wapUrl, wap_name: appName } };
}

function appendRedirectUrl(providerUrl, returnUrl) {
  const redirect = text(returnUrl);
  if (!redirect) return providerUrl;
  try {
    const url = new URL(providerUrl);
    url.searchParams.set('redirect_url', redirect);
    return url.toString();
  } catch {
    return providerUrl;
  }
}

function parameterValue(value) {
  return Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value)
    : String(value);
}

export function wechatV2SignContent(params, key) {
  const pairs = Object.keys(params)
    .sort()
    .filter((name) => name !== 'sign' && params[name] !== null && params[name] !== '')
    .map((name) => `${name}=${parameterValue(params[name])}`);
  return `${pairs.join('&')}&key=${key}`;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signWechatV2(params, key, signType = 'HMAC-SHA256') {
  const content = wechatV2SignContent(params, key);
  const normalized = text(signType).toUpperCase();
  if (normalized === 'MD5') return (await md5Hex(content)).toUpperCase();
  if (normalized !== 'HMAC-SHA256') throw new Error('微信支付 V2 签名类型必须是 MD5 或 HMAC-SHA256');
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(content))).toUpperCase();
}

function escapeCdata(value) {
  return String(value).replaceAll(']]>', ']]]]><![CDATA[>');
}

export function encodeWechatXml(data) {
  let xml = '<xml>';
  for (const [name, original] of Object.entries(data)) {
    if (original === null || original === '') continue;
    const value = parameterValue(original);
    xml += `<${name}><![CDATA[${escapeCdata(value)}]]></${name}>`;
  }
  return `${xml}</xml>`;
}

function decodeEntities(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function decodeWechatXml(xmlText) {
  const xml = text(xmlText);
  if (!xml) return {};
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || !/^<xml(?:\s[^>]*)?>[\s\S]*<\/xml>$/u.test(xml)) {
    throw new Error('微信支付 XML 解析失败');
  }
  const body = xml.replace(/^<xml(?:\s[^>]*)?>/u, '').replace(/<\/xml>$/u, '');
  const result = {};
  const fieldPattern = /<([A-Za-z_][A-Za-z0-9_.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/gu;
  for (const match of body.matchAll(fieldPattern)) {
    const value = match[2] === undefined ? decodeEntities(match[3] ?? '') : match[2];
    result[match[1]] = value;
  }
  if (!Object.keys(result).length || body.replace(
    /<([A-Za-z_][A-Za-z0-9_.-]*)>(?:<!\[CDATA\[[\s\S]*?\]\]>|[\s\S]*?)<\/\1>/gu,
    '',
  ).trim()) {
    throw new Error('微信支付 XML 解析失败');
  }
  return result;
}

function responseSummary(path, response, rawBody, data) {
  const success = data.return_code === 'SUCCESS' && (data.result_code ?? 'SUCCESS') === 'SUCCESS';
  return {
    api_version: 'v2',
    method: 'POST',
    path,
    status_code: response.status,
    success,
    code: text(data.err_code ?? data.return_code),
    message: text(data.err_code_des ?? data.return_msg),
    data,
    raw_body: rawBody,
  };
}

async function requestWechatV2(config, path, params, transport = globalThis.fetch) {
  const filtered = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== ''));
  filtered.sign = await signWechatV2(filtered, apiKey(config), text(filtered.sign_type) || 'HMAC-SHA256');
  const actualPath = boolValue(config.sandbox) ? `/sandboxnew${path}` : path;
  const body = encodeWechatXml(filtered);
  const response = await transport(`${text(config.gateway_v2) || 'https://api.mch.weixin.qq.com'}${actualPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset=UTF-8',
      'user-agent': 'Payment-Wxpay-Light-SDK',
    },
    body,
  });
  const rawBody = await response.text();
  const data = decodeWechatXml(rawBody);
  if (text(data.sign)) {
    const expectedSign = await signWechatV2(
      data,
      apiKey(config),
      text(data.sign_type) || text(filtered.sign_type) || 'MD5',
    );
    if (!sameText(data.sign, expectedSign)) {
      throw new Error('微信支付 V2 响应验签失败');
    }
  }
  return responseSummary(actualPath, response, rawBody, data);
}

function validateWechatV2Config(config) {
  if ((text(config.api_version) || 'v3').toLowerCase() !== 'v2') {
    throw new Error('当前微信通道不是 V2 接口');
  }
  if ((text(config.mode) || 'merchant').toLowerCase() !== 'merchant') {
    throw new Error('当前仅迁移了已配置的微信普通商户模式');
  }
  if (!text(config.mch_id) || !apiKey(config)) {
    throw new Error('微信支付商户号和 V2 API 密钥不能为空');
  }
  if (![config.app_id, config.mp_app_id, config.app_app_id, config.mini_app_id].some((value) => text(value))) {
    throw new Error('微信支付至少需要配置一个可用 AppID');
  }
}

function commonWechatOrder(config, order, product) {
  const appId = productAppId(config, product);
  if (!appId) throw new Error(`${wechatProductName(product)}缺少可用 AppID`);

  const requestData = {
    body: utf8ByteCut(order.subject, 127),
    out_trade_no: String(order.payNo),
    total_fee: Number(order.amount),
    notify_url: String(order.callbackUrl),
    spbill_create_ip: text(order.clientIp) || '127.0.0.1',
    appid: appId,
    mch_id: text(config.mch_id),
    nonce_str: nonceStr(),
    sign_type: 'HMAC-SHA256',
  };
  const expiresAt = wechatTimeExpire(order.expiresAt);
  if (expiresAt) requestData.time_expire = expiresAt;
  if (product === 'scan') {
    requestData.trade_type = 'NATIVE';
    requestData.product_id = String(order.payNo);
  } else if (product === 'h5') {
    requestData.trade_type = 'MWEB';
    requestData.scene_info = JSON.stringify(h5SceneInfo(config, order));
  } else if (product === 'app') {
    requestData.trade_type = 'APP';
  } else if (['mp', 'mini'].includes(product)) {
    const openid = openidFromOrder(order, product);
    if (!openid) throw new Error(`${wechatProductName(product)}必须传入对应 AppID 下的 openid`);
    requestData.trade_type = 'JSAPI';
    requestData.openid = openid;
  }
  return requestData;
}

async function frontendPayParams(config, product, appId, prepayId) {
  const timeStamp = String(Math.floor(Date.now() / 1_000));
  const frontendNonce = nonceStr();
  if (['mp', 'mini'].includes(product)) {
    const signType = 'HMAC-SHA256';
    const requestPayment = {
      timeStamp,
      nonceStr: frontendNonce,
      package: `prepay_id=${prepayId}`,
      signType,
    };
    const paySign = await signWechatV2({ appId, ...requestPayment }, apiKey(config), signType);
    return product === 'mini'
      ? { app_id: appId, request_payment: { ...requestPayment, paySign } }
      : { appId, ...requestPayment, paySign };
  }
  const signInput = {
    appid: appId,
    partnerid: text(config.mch_id),
    prepayid: prepayId,
    package: 'Sign=WXPay',
    noncestr: frontendNonce,
    timestamp: timeStamp,
  };
  return {
    appId,
    partnerId: signInput.partnerid,
    prepayId,
    packageValue: signInput.package,
    nonceStr: frontendNonce,
    timeStamp,
    sign: await signWechatV2(signInput, apiKey(config), 'HMAC-SHA256'),
  };
}

export function wechatOAuthAuthorizeUrl(config, callbackUrl) {
  const appId = productAppId(config, 'mp');
  if (!appId || !text(config.mp_app_secret)) {
    throw new Error('微信 JSAPI 自动授权需要配置公众号 AppID 和 AppSecret');
  }
  const query = new URLSearchParams({
    appid: appId,
    redirect_uri: String(callbackUrl),
    response_type: 'code',
    scope: 'snsapi_base',
    state: 'edgepay',
  });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${query.toString()}#wechat_redirect`;
}

export async function exchangeWechatOAuthCode(config, code, transport = globalThis.fetch) {
  const appId = productAppId(config, 'mp');
  const secret = text(config.mp_app_secret);
  if (!appId || !secret) throw new Error('微信 JSAPI 自动授权配置不完整');
  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  url.searchParams.set('appid', appId);
  url.searchParams.set('secret', secret);
  url.searchParams.set('code', text(code));
  url.searchParams.set('grant_type', 'authorization_code');
  const response = await transport(url, { headers: { accept: 'application/json' } });
  const rawBody = await response.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error('微信网页授权返回格式不正确');
  }
  if (!response.ok || !text(data.openid)) {
    throw new Error(text(data.errmsg) || `微信网页授权失败（${response.status}）`);
  }
  return { openid: text(data.openid), unionid: text(data.unionid), raw: data };
}

function oauthPresentation(config, order) {
  return {
    pay_page: 'jump',
    pay_type: 'wxpay',
    pay_product: 'mp',
    pay_action: 'oauth',
    pay_params: {
      url: wechatOAuthAuthorizeUrl(config, order.oauthCallbackUrl),
      description: '正在获取微信用户身份，授权完成后会自动调起 JSAPI 支付。',
    },
    chan_order_no: String(order.payNo),
    chan_trade_no: '',
  };
}

function canFallbackWechatProduct(error) {
  const code = text(error.channelErrorCode).toUpperCase();
  const message = text(error.message).toUpperCase();
  return [
    'NOAUTH',
    'NO_AUTH',
    'NOT_PERMITTED',
    'MCH_NOT_EXISTS',
    'PARAM_ERROR',
    'APPID_MCHID_NOT_MATCH',
  ].some((keyword) => code.includes(keyword) || message.includes(keyword))
    || ['权限', '未开通', '未配置', '商户号不存在'].some((keyword) => message.includes(keyword));
}

async function createWechatProductPayment(config, order, product, transport) {
  if (product === 'mp' && !openidFromOrder(order, product)) {
    if (text(order.oauthCallbackUrl) && text(config.mp_app_secret)) return oauthPresentation(config, order);
    throw new Error('微信 JSAPI 支付需要 openid，或配置公众号 AppSecret 后走网页授权');
  }
  if (product === 'mini' && !openidFromOrder(order, product)) {
    throw new Error('微信小程序支付必须传入 mini_openid');
  }

  const requestData = commonWechatOrder(config, order, product);
  const response = await requestWechatV2(config, '/pay/unifiedorder', requestData, transport);
  if (!response.success) {
    const error = new Error(response.message || `${wechatProductName(product)}下单失败`);
    error.channelErrorCode = response.code;
    throw error;
  }
  const raw = {
    api_version: 'v2',
    product,
    success: true,
    data: response.data,
    response,
  };
  if (product === 'scan') {
    const qrcode = text(response.data.code_url);
    if (!qrcode) throw new Error('微信 Native 支付未返回 code_url');
    return {
      pay_page: 'qrcode',
      pay_type: 'wxpay',
      pay_product: product,
      pay_action: 'qrcode',
      pay_params: { qrcode, raw },
      chan_order_no: String(order.payNo),
      chan_trade_no: '',
    };
  }
  if (product === 'h5') {
    const mwebUrl = text(response.data.mweb_url);
    if (!mwebUrl) throw new Error('微信 H5 支付未返回 mweb_url');
    return {
      pay_page: 'jump',
      pay_type: 'wxpay',
      pay_product: product,
      pay_action: 'jump',
      pay_params: {
        url: appendRedirectUrl(mwebUrl, order.paymentUrl),
        description: '正在跳转微信 H5 支付。',
        raw,
      },
      chan_order_no: String(order.payNo),
      chan_trade_no: '',
    };
  }

  const prepayId = text(response.data.prepay_id);
  if (!prepayId) throw new Error(`${wechatProductName(product)}未返回 prepay_id`);
  const payParams = await frontendPayParams(config, product, requestData.appid, prepayId);
  if (product === 'mp') {
    return {
      pay_page: 'jsapi',
      pay_type: 'wxpay',
      pay_product: product,
      pay_action: 'jsapi',
      pay_params: {
        ...payParams,
        description: '请在微信内打开，页面会自动调起微信支付。',
        raw,
      },
      chan_order_no: String(order.payNo),
      chan_trade_no: '',
    };
  }
  if (product === 'mini') {
    return {
      pay_page: 'page',
      pay_type: 'wxpay',
      pay_product: product,
      pay_action: 'mini',
      pay_params: {
        _page: 'wechatMini',
        ...payParams,
        description: '小程序支付参数已生成，请在小程序中调用 wx.requestPayment。',
        raw,
      },
      chan_order_no: String(order.payNo),
      chan_trade_no: '',
    };
  }
  return {
    pay_page: 'page',
    pay_type: 'wxpay',
    pay_product: product,
    pay_action: 'app',
    pay_params: {
      _page: 'page',
      params: payParams,
      description: 'APP 支付参数已生成，请交给商户原生 App 的微信支付 SDK。',
      raw,
    },
    chan_order_no: String(order.payNo),
    chan_trade_no: '',
  };
}

export async function createWechatV2Payment(config, order, transport = globalThis.fetch) {
  validateWechatV2Config(config);
  const explicit = Boolean(requestedProduct(order));
  const products = resolveWechatV2Products(config, order);
  const attempts = [];
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    try {
      return await createWechatProductPayment(config, order, product, transport);
    } catch (error) {
      attempts.push({
        product,
        code: text(error.channelErrorCode),
        message: text(error.message),
      });
      const hasNext = index < products.length - 1;
      const missingIdentity = /OPENID|用户身份/u.test(text(error.message).toUpperCase());
      if (!explicit && hasNext && (missingIdentity || canFallbackWechatProduct(error))) continue;
      error.productAttempts = attempts;
      throw error;
    }
  }
  throw new Error('当前微信支付通道没有可用支付产品');
}

export async function createWechatNativePayment(config, order, transport = globalThis.fetch) {
  return createWechatV2Payment(config, { ...order, wechatProduct: 'scan' }, transport);
}

export async function queryWechatV2Payment(config, order) {
  validateWechatV2Config(config);
  const product = normalizeProduct(order.metadata?.presentation?.pay_product) || 'scan';
  const response = await requestWechatV2(config, '/pay/orderquery', {
    out_trade_no: text(order.payNo),
    appid: productAppId(config, product),
    mch_id: text(config.mch_id),
    nonce_str: nonceStr(),
    sign_type: 'HMAC-SHA256',
  });
  if (!response.success) {
    return { success: false, status: 'pending', message: response.message || '微信支付查单失败' };
  }
  const state = text(response.data.trade_state).toUpperCase();
  const status = state === 'SUCCESS'
    ? 'success'
    : ['CLOSED', 'REVOKED'].includes(state) ? 'closed'
      : state === 'PAYERROR' ? 'failed' : 'pending';
  return {
    success: true,
    status,
    payNo: text(order.payNo),
    message: text(response.data.trade_state_desc ?? response.data.return_msg ?? state),
    channelOrderNo: text(response.data.out_trade_no) || text(order.payNo),
    channelTradeNo: text(response.data.transaction_id) || text(order.providerTradeNo) || text(order.payNo),
    channelStatus: state,
    paidAt: status === 'success' ? wechatTime(response.data.time_end) : '',
    raw: {
      api_version: response.api_version,
      status_code: response.status_code,
      code: response.code,
      message: response.message,
      data: response.data,
    },
  };
}

export async function refundWechatV2Payment(config, order, mtlsFetch) {
  if (typeof mtlsFetch !== 'function') {
    throw new Error('微信 V2 API 退款需要配置 Cloudflare 出站 mTLS 证书绑定');
  }
  validateWechatV2Config(config);
  const product = normalizeProduct(order.metadata?.presentation?.pay_product) || 'scan';
  const refundAmount = Math.max(1, Number(order.refundAmount));
  const totalAmount = Math.max(1, Number(order.amount));
  const requestData = {
    out_trade_no: text(order.payNo),
    out_refund_no: text(order.refundNo),
    total_fee: totalAmount,
    refund_fee: refundAmount,
    appid: productAppId(config, product),
    mch_id: text(config.mch_id),
    nonce_str: nonceStr(),
    sign_type: 'HMAC-SHA256',
  };
  if (text(order.reason)) requestData.refund_desc = [...text(order.reason)].slice(0, 80).join('');
  const response = await requestWechatV2(config, '/secapi/pay/refund', requestData, mtlsFetch);
  if (!response.success) {
    return {
      success: false,
      message: response.message || '微信支付退款失败',
      providerStatus: response.code,
      raw: {
        api_version: response.api_version,
        status_code: response.status_code,
        code: response.code,
        message: response.message,
        data: response.data,
      },
    };
  }
  return {
    success: true,
    message: '退款申请成功',
    providerRefundNo: text(response.data.refund_id) || text(order.refundNo),
    providerStatus: text(response.data.result_code ?? response.data.return_code),
    refundAmount,
    raw: {
      api_version: response.api_version,
      status_code: response.status_code,
      code: response.code,
      message: response.message,
      data: response.data,
    },
  };
}

function sameText(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function wechatTime(value) {
  const time = text(value);
  if (/^\d{14}$/u.test(time)) {
    return `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}`;
  }
  return time;
}

export async function handleWechatV2Notify(request, config) {
  const raw = await readBoundedText(request, PROVIDER_CALLBACK_MAX_BYTES, '微信支付回调请求体');
  const data = decodeWechatXml(raw);
  const suppliedSign = text(data.sign);
  if (!suppliedSign) throw new Error('微信支付 V2 通知验签失败');
  const declaredSignType = text(data.sign_type ?? data.signType).toUpperCase();
  const signTypes = declaredSignType
    ? [declaredSignType]
    : suppliedSign.length === 64 ? ['HMAC-SHA256'] : ['MD5', 'HMAC-SHA256'];
  let verified = false;
  for (const signType of signTypes) {
    const expectedSign = await signWechatV2(data, apiKey(config), signType);
    if (sameText(suppliedSign.toUpperCase(), expectedSign.toUpperCase())) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error('微信支付 V2 通知验签失败');
  if (text(data.mch_id) && text(data.mch_id) !== text(config.mch_id)) {
    throw new Error('微信支付 V2 通知商户号不匹配');
  }
  const acceptedAppIds = new Set(
    ['scan', 'h5', 'mp', 'app', 'mini'].map((product) => productAppId(config, product)).filter(Boolean),
  );
  if (text(data.appid) && !acceptedAppIds.has(text(data.appid))) {
    throw new Error('微信支付 V2 通知 AppID 不匹配');
  }

  const resultCode = text(data.result_code ?? data.return_code).toUpperCase();
  const payNo = text(data.out_trade_no);
  const transactionId = text(data.transaction_id);
  const amountFen = Number(data.total_fee);
  if (!payNo) throw new Error('微信支付 V2 通知缺少 out_trade_no');
  const status = resultCode === 'SUCCESS' ? 'success' : 'failed';
  if (status === 'success' && (!Number.isSafeInteger(amountFen) || amountFen <= 0)) {
    throw new Error('微信支付 V2 通知金额不合法');
  }
  return {
    status,
    payNo,
    message: text(data.err_code_des ?? resultCode),
    channelOrderNo: payNo,
    channelTradeNo: transactionId || payNo,
    channelStatus: resultCode,
    paidAt: status === 'success' ? wechatTime(data.time_end) : '',
    failedAt: status === 'failed' ? new Date().toISOString() : '',
    eventId: `wechat-v2:${transactionId || payNo}:${resultCode}`,
    amountFen,
    details: {
      appid: text(data.appid),
      mch_id: text(data.mch_id),
      transaction_id: transactionId,
      out_trade_no: payNo,
      trade_type: text(data.trade_type),
      total_fee: amountFen,
      cash_fee: Number(data.cash_fee ?? 0),
      fee_type: text(data.fee_type),
      bank_type: text(data.bank_type),
      time_end: text(data.time_end),
      return_code: text(data.return_code),
      result_code: text(data.result_code),
    },
    raw: JSON.stringify({
      source: 'provider_webhook',
      api_version: 'v2',
      request: data,
    }),
  };
}

export function wechatV2NotifyResponse(success) {
  return new Response(success ? V2_SUCCESS_XML : V2_FAIL_XML, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}
