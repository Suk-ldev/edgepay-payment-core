/**
 * Payment 请求路由与处理器。
 *
 * 这一层不认识任何具体插件：下单、回调、收款展示、流水匹配、轮询全部经由
 * 运行时注册表按编码取插件再调用生命周期方法。运行时（注册表、授权门、
 * License 客户端、构建信息）由 createPaymentWorker 挂在 env 上传进来。
 */

import {
  channelById, channelExpireMinutes, parseChannels, resolveChannel,
} from '../channels.js';
import { adminCaptchaResponse, clearAdminSession, createAdminSession, isAdminSession, verifyAdminLogin } from '../admin-auth.js';
import {
  EPAY_PAYLOAD_MAX_BYTES, PROVIDER_CALLBACK_MAX_BYTES, readBoundedJson, readBoundedText,
} from '../body-limits.js';
import { dispatchDueNotifications, enqueuePaymentNotification } from '../notifications.js';
import { jsonResponse } from '../security.js';
import {
  appendQuery, fenToMoney, isHttpsUrl, moneyToFen, optionalText,
  readEpayPayload, requireText, signEpayV1, verifyEpayV1,
} from '../epay-v1.js';
import {
  PERSONAL_RECEIPT_KEY, classifySmsForwarderDeliveryError, eventOrderNo,
  isSmsForwarderProbeRequest, paidAtIso, parseSmsForwarder, readSignedWatcherPayload,
  selectPersonalReceipt, verifyStaticPollToken, verifyWatcherSnapshotRequest, watcherRecords,
} from '../receipt-plugins.js';
import {
  readEncryptedJsonSetting, readPlainJsonSetting, writeEncryptedJsonSetting,
  writePlainJsonSetting,
} from '../runtime-settings.js';
import {
  adminOrderDetails, listAdminOrders, performAdminOrderAction, performEpayRefund,
} from '../order-actions.js';
import {
  CHANNEL_TEST_ALIPAY_PRODUCTS, CHANNEL_TEST_DEVICES, CHANNEL_TEST_WECHAT_PRODUCTS,
  channelTestFields, channelTestRecord,
} from '../channel-tests.js';
import {
  publicKeyStatus, revokePreviousRuntimeKey, rotateRuntimeKey, withRuntimeKeys,
} from '../runtime-keys.js';
import { pluginSupportsWorkerPoll, unsupportedHook } from '../plugin-api.js';
import { pollReceiptAccount, workerPollerAvailable } from '../receipt-poller.js';
import { decodeWechatXml, exchangeWechatOAuthCode } from '../wechat-v2-plugin.js';
import {
  receiptDiscoveryAccount, receiptDiscoveryAvailable, sanitizeReceiptDiscoveryRecords,
} from '../receipt-discovery.js';
import { fetchBundledAsset } from '../bundled-assets.js';
import { compareReleaseVersions, CURRENT_RELEASE_VERSION, fetchLatestRelease } from '../release.js';
import {
  PRESENCE_PREFIX, PRESENCE_SWEEP_MS, PRESENCE_TTL_MS,
  clearWatcherPresence, liveWatcherInstances, onlineWatcherPlugins, presenceKey, recordWatcherPresence,
  staleWatcherInstances, watcherChannelPresence, watcherSystemStatus,
} from '../watcher-presence.js';
import { emitAlert, clearAlert, mergeAlertConfig, publicAlertConfig, readAlertConfig, writeAlertConfig, deliverAlert } from '../alerts.js';
import { pluginContext } from './plugin-context.js';
import { runtimeOf, withRuntime } from './runtime-env.js';
import {
  INSTANCE_NAME_KEY, adminPluginForms, configForPlugin, missingPluginFields, pluginCodesWithInstances,
  pluginDisplayName, pluginEnabled, publicPluginList,
} from './plugin-config.js';
import {
  basePluginCode, isPluginInstanceCode, nextInstanceSequence, pluginConfigNumber, pluginInstanceCode,
} from '../plugin-instances.js';

// 插件要额外带给 Watcher / 轮询器的收款信息统一放在订单 metadata 的这个键下。
const WATCHER_RECEIPT_KEY = 'receipt_watcher';
const RECEIPT_DISCOVERY_PREFIX = 'receipt_discovery:';
const PLUGIN_LIST_CACHE_MILLISECONDS = 60_000;
const PLUGIN_LIST_FAILURE_CACHE_MILLISECONDS = 5_000;
const SNAPSHOT_MAX_ORDERS_PER_PLUGIN = 200;
const WATCHER_CONFIG_OMIT_KEYS = new Set(['receipt_qrcode_image']);
// 管理台插件页会同时读取并解密配置、读取授权状态、合并公开目录。结果按当前运行时
// 缓存在 isolate 内，既不把含配置值的响应放进共享 HTTP 缓存，也能合并并发冷请求。
const pluginListCache = new WeakMap();

/** 按编码取插件；不存在（没买或没打进这次构建）就报错。 */
function pluginOf(env, code) {
  return runtimeOf(env).registry.require(code);
}

function pluginOrNull(env, code) {
  return runtimeOf(env).registry.get(code);
}

/** 调用插件生命周期方法前先过授权门。 */
async function authorized(env, plugin, operation) {
  await runtimeOf(env).authorizePlugin({ plugin, operation, env });
  return plugin;
}

/** 组装一次插件调用的上下文。 */
function callContext(env, extra) {
  return pluginContext(runtimeOf(env), { env, ...extra });
}

const timestamp = () => new Date().toISOString();
const OAUTH_STATE_SECONDS = 10 * 60;
const utf8Encoder = new TextEncoder();
function unauthorized() { return jsonResponse({ error: 'unauthorized' }, 401); }
function errorHttpStatus(error, fallback = 400) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

function base64UrlEncode(value) {
  let binary = '';
  for (const byte of utf8Encoder.encode(String(value))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value) {
  const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function constantText(left, right) {
  const a = utf8Encoder.encode(String(left));
  const b = utf8Encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Encoder.encode(String(value))));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function createWechatOauthState(env, paymentNo) {
  const secret = settingsEncryptionSecret(env) || String(env.EPAY_KEY ?? '');
  if (!secret) throw new Error('微信网页授权状态签名密钥未配置');
  const payload = base64UrlEncode(JSON.stringify({
    payment_no: String(paymentNo),
    expires_at: Date.now() + OAUTH_STATE_SECONDS * 1_000,
  }));
  return `${payload}.${await hmacBase64Url(secret, payload)}`;
}

async function verifyWechatOauthState(env, token) {
  const value = String(token ?? '');
  const separator = value.lastIndexOf('.');
  if (separator < 1) throw new Error('微信网页授权状态无效');
  const payload = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  const secret = settingsEncryptionSecret(env) || String(env.EPAY_KEY ?? '');
  if (!secret || !constantText(supplied, await hmacBase64Url(secret, payload))) {
    throw new Error('微信网页授权状态验签失败');
  }
  const data = JSON.parse(base64UrlDecode(payload));
  if (Number(data.expires_at) <= Date.now() || !String(data.payment_no ?? '')) {
    throw new Error('微信网页授权状态已过期');
  }
  return String(data.payment_no);
}

function parseJson(value) {
  try { return JSON.parse(value ?? '{}') ?? {}; } catch { return {}; }
}

function settingsEncryptionSecret(env) {
  return String(env.CONFIG_ENCRYPTION_KEY ?? env.ADMIN_TOKEN ?? '');
}

async function runtimePluginConfig(env) {
  const configured = await readEncryptedJsonSetting(
    env,
    'plugin_config',
    settingsEncryptionSecret(env),
    {},
  );
  const merged = { ...configured };
  for (const pluginCode of ['wxpay_receipt', 'alipay_receipt', 'usdt_trc20_receipt', 'fubei_receipt']) {
    if (merged[pluginCode]) delete merged[pluginCode].receipt_valid_seconds;
  }
  for (const pluginCode of ['wxpay_receipt', 'fubei_receipt']) {
    const image = String(merged[pluginCode]?.receipt_qrcode_image ?? '').trim();
    if (['/wechat.png', '/fubei.jpg'].includes(image)) delete merged[pluginCode].receipt_qrcode_image;
  }
  if (merged.wechat_api) {
    delete merged.wechat_api.cert_path;
    delete merged.wechat_api.key_path;
  }
  return merged;
}

async function runtimeChannels(env) {
  const override = await readPlainJsonSetting(env, 'channels', null);
  return parseChannels(runtimeOf(env).registry, override);
}

/** 当前 License 允许使用、且已装载进本次构建的插件编码。 */
async function licensedCodes(env) {
  const runtime = runtimeOf(env);
  const state = await runtime.license.state(env, runtime.registry);
  return new Set(state.plugins.filter((code) => runtime.registry.hasBase(code)));
}

/**
 * 权益按平台算，不按账号算：买了某个插件，它的副本不需要再买一次。
 * License 权益列表里只有基础编码，所以比对前先把副本编码折回去。
 */
function licenseCovers(licensed, pluginCode) {
  return licensed.has(basePluginCode(pluginCode));
}

async function routableChannels(env) {
  const [channels, config, licensed] = await Promise.all([
    runtimeChannels(env), runtimePluginConfig(env), licensedCodes(env),
  ]);
  return channels.filter((channel) => licenseCovers(licensed, channel.plugin_code)
    && pluginEnabled(runtimeOf(env).registry, config, channel.plugin_code));
}

const DEFAULT_SITE_CONFIG = Object.freeze({
  merchant_name: 'EdgePay',
  order_expire_minutes: 5,
  cashier_footer_html: '',
  contact_enabled: true,
  contact_title: '添加我的企业微信与我联系吧',
  contact_qr_label: '手机微信扫码添加好友',
  contact_avatar_image: '',
  contact_qrcode_image: '',
});

function validateCashierFooterHtml(value) {
  const html = String(value ?? '').trim();
  if (html.length > 10_000) throw new Error('收银台底部 HTML 不能超过 10000 个字符');
  if (
    /<\s*\/?\s*(?:script|iframe|object|embed|style|link|meta|base|form|input|textarea|select|svg|math)\b/iu.test(html)
    || /\bon[a-z]+\s*=/iu.test(html)
    || /\b(?:javascript|vbscript)\s*:/iu.test(html)
    || /\bdata\s*:\s*text\/html/iu.test(html)
    || /\bstyle\s*=/iu.test(html)
  ) {
    throw new Error('收银台底部 HTML 含有脚本、事件、内联样式或危险标签');
  }
  return html;
}

function normalizedBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function validateContactImage(value, label, maximum) {
  const image = String(value ?? '').trim();
  if (!image) return '';
  if (image.length > maximum) throw new Error(`${label}压缩后仍然过大`);
  if (
    !/^\/[A-Za-z0-9._/-]+$/u.test(image)
    && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(image)
  ) {
    throw new Error(`${label}必须是 PNG、JPEG 或 WebP 图片`);
  }
  return image;
}

export function normalizeSiteConfig(value = {}) {
  const merchantName = String(value?.merchant_name ?? DEFAULT_SITE_CONFIG.merchant_name).trim();
  if (!merchantName || merchantName.length > 80) throw new Error('商户名称长度必须为 1 到 80 个字符');
  const orderExpireMinutes = Number(value?.order_expire_minutes ?? DEFAULT_SITE_CONFIG.order_expire_minutes);
  if (!Number.isInteger(orderExpireMinutes) || orderExpireMinutes < 1 || orderExpireMinutes > 30) {
    throw new Error('订单超时时间必须是 1 到 30 分钟的整数');
  }
  const contactTitle = String(value?.contact_title ?? DEFAULT_SITE_CONFIG.contact_title).trim();
  if (!contactTitle || contactTitle.length > 80) throw new Error('客服页提示语长度必须为 1 到 80 个字符');
  const contactQrLabel = String(value?.contact_qr_label ?? DEFAULT_SITE_CONFIG.contact_qr_label).trim();
  if (!contactQrLabel || contactQrLabel.length > 40) throw new Error('二维码提示语长度必须为 1 到 40 个字符');
  return {
    merchant_name: merchantName,
    order_expire_minutes: orderExpireMinutes,
    cashier_footer_html: validateCashierFooterHtml(value?.cashier_footer_html),
    contact_enabled: normalizedBoolean(value?.contact_enabled, DEFAULT_SITE_CONFIG.contact_enabled),
    contact_title: contactTitle,
    contact_qr_label: contactQrLabel,
    contact_avatar_image: validateContactImage(
      value?.contact_avatar_image ?? DEFAULT_SITE_CONFIG.contact_avatar_image,
      '客服头像',
      300_000,
    ),
    contact_qrcode_image: validateContactImage(
      value?.contact_qrcode_image ?? DEFAULT_SITE_CONFIG.contact_qrcode_image,
      '客服二维码',
      600_000,
    ),
  };
}

async function runtimeSiteConfig(env) {
  const fallback = normalizeSiteConfig({
    merchant_name: env.MERCHANT_NAME ?? DEFAULT_SITE_CONFIG.merchant_name,
    order_expire_minutes: env.ORDER_EXPIRE_MINUTES ?? DEFAULT_SITE_CONFIG.order_expire_minutes,
    cashier_footer_html: env.CASHIER_FOOTER_HTML ?? DEFAULT_SITE_CONFIG.cashier_footer_html,
    contact_enabled: env.CONTACT_ENABLED ?? DEFAULT_SITE_CONFIG.contact_enabled,
    contact_title: env.CONTACT_TITLE ?? DEFAULT_SITE_CONFIG.contact_title,
    contact_qr_label: env.CONTACT_QR_LABEL ?? DEFAULT_SITE_CONFIG.contact_qr_label,
    contact_avatar_image: env.CONTACT_AVATAR_IMAGE ?? DEFAULT_SITE_CONFIG.contact_avatar_image,
    contact_qrcode_image: env.CONTACT_QRCODE_IMAGE ?? DEFAULT_SITE_CONFIG.contact_qrcode_image,
  });
  const stored = await readPlainJsonSetting(env, 'site_config', fallback);
  const normalized = normalizeSiteConfig({ ...fallback, ...(stored ?? {}) });
  if (normalized.contact_qrcode_image === '/contact/default-qrcode.png') {
    normalized.contact_qrcode_image = '';
  }
  return normalized;
}

async function expireDuePayments(env) {
  const now = timestamp();
  return env.DB.prepare(`
    UPDATE payment_attempts
    SET status = 'EXPIRED', updated_at = ?
    WHERE status IN ('PENDING', 'PAYING') AND expires_at <= ?
  `).bind(now, now).run();
}

function expiringAt(seconds) {
  return new Date(Date.now() + Math.max(60, Math.min(86_400, Number(seconds ?? 300))) * 1000).toISOString();
}

function createPaymentNo() {
  // 微信支付 V2 的 out_trade_no 最多 32 字节。内部支付单号会直接作为
  // out_trade_no 发送给官方微信，因此保留 p_ 前缀后只使用 30 位十六进制。
  return `p_${crypto.randomUUID().replaceAll('-', '').slice(0, 30)}`;
}

async function activeReceiptPayments(env, pluginCode) {
  await expireDuePayments(env);
  const { results } = await env.DB.prepare(`
    SELECT * FROM payment_attempts
    WHERE plugin_code = ? AND status = 'PAYING' AND expires_at > ?
    ORDER BY created_at ASC
  `).bind(pluginCode, timestamp()).all();
  return results.map((payment) => ({ ...payment, metadata: parseJson(payment.metadata_json) }));
}

function configuredReceiptImage(plugin, config) {
  const configured = String(config.receipt_qrcode_image ?? '').trim();
  if (['/wechat.png', '/fubei.jpg'].includes(configured)) return '';
  if (configured && !/^[A-Za-z]:[\\/]/u.test(configured)) return configured;
  return '';
}

function uniqueRemarkCode(active) {
  const used = new Set(active.map((payment) => {
    return String(payment.metadata?.[PERSONAL_RECEIPT_KEY]?.remark_code ?? '');
  }).filter(Boolean));
  const random = new Uint16Array(1);
  crypto.getRandomValues(random);
  const start = 1_000 + (random[0] % 9_000);
  for (let offset = 0; offset < 9_000; offset += 1) {
    const code = String(1_000 + ((start - 1_000 + offset) % 9_000));
    if (!used.has(code)) return code;
  }
  throw new Error('当前账号可用付款备注已用尽');
}

async function receiptPresentation(env, plugin, config, amountFen, expiresAt, payType) {
  const activePayments = await activeReceiptPayments(env, plugin.manifest.code);
  // 有自己收款形态的插件（例如链上地址池）自行生成展示；其余走下面这套通用收款码。
  if (plugin.prepareReceipt) {
    return plugin.prepareReceipt(callContext(env, {
      config, amountFen, expiresAt, payType, activePayments,
    }));
  }
  const active = activePayments;
  const qrcode = String(config.receipt_qrcode_content ?? '');
  const qrcodeImage = configuredReceiptImage(plugin, config);
  if (!qrcode && !qrcodeImage) throw new Error(`${plugin.manifest.name}未配置收款码`);
  const mode = String(config.receipt_match_mode ?? 'amount') === 'remark' ? 'remark' : 'amount';
  const receipt = {
    platform: plugin.manifest.code,
    mode,
    original_amount: amountFen,
    receipt_amount: amountFen,
    expire_at: expiresAt,
  };
  if (mode === 'remark') {
    receipt.remark_code = uniqueRemarkCode(active);
  } else {
    const maxOffset = Math.max(0, Math.min(99, Number(config.amount_offset_max ?? 99)));
    const used = new Set(active.map((payment) => {
      return Number(payment.metadata?.[PERSONAL_RECEIPT_KEY]?.receipt_amount ?? 0);
    }).filter(Boolean));
    let selected = 0;
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      if (!used.has(amountFen + offset)) {
        selected = amountFen + offset;
        break;
      }
    }
    if (!selected) throw new Error('当前账号可用金额偏移已用尽');
    receipt.receipt_amount = selected;
    receipt.offset_amount = selected - amountFen;
  }
  const payParams = {
    _page: 'receiptQrcode',
    amount: fenToMoney(receipt.receipt_amount),
    original_amount: fenToMoney(amountFen),
    receipt_match_mode: mode,
    receipt_valid_seconds: Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000)),
    expire_at: expiresAt,
    expire_at_timestamp: Math.floor(Date.parse(expiresAt) / 1_000),
    description: mode === 'remark'
      ? '请扫码付款，并在付款备注中填写识别码。'
      : '请扫码付款，并按页面金额完成付款。',
  };
  if (mode === 'remark') {
    payParams.remark_code = receipt.remark_code;
    payParams.tips = `付款备注：${receipt.remark_code}`;
  }
  if (qrcode) payParams.qrcode = qrcode;
  if (qrcodeImage) payParams.qrcode_image = qrcodeImage;
  return {
    metadata: { [PERSONAL_RECEIPT_KEY]: receipt },
    presentation: {
      pay_page: 'page',
      pay_type: payType,
      pay_product: plugin.manifest.receiptSource === 'sms_forwarder' ? 'receipt' : 'receipt_plate',
      pay_action: plugin.manifest.receiptSource === 'sms_forwarder' ? 'sms_forwarder' : 'web_watcher',
      pay_params: payParams,
    },
  };
}

function validateSubmit(input, isMapi) {
  requireText(input, 'pid', 20);
  const type = optionalText(input, 'type', 32);
  if (isMapi && !type) throw new Error('type 参数不能为空');
  const clientIp = optionalText(input, 'clientip', 64);
  if (isMapi && !clientIp) throw new Error('clientip 参数不合法');
  const values = {
    type,
    outTradeNo: requireText(input, 'out_trade_no', 64),
    notifyUrl: requireText(input, 'notify_url', 255),
    returnUrl: isMapi ? optionalText(input, 'return_url', 255) : requireText(input, 'return_url', 255),
    name: requireText(input, 'name', 255),
    amountFen: moneyToFen(input.money),
    param: optionalText(input, 'param', 255),
    buyer: optionalText(input, 'buyer', 128),
    device: optionalText(input, 'device', 16),
    openid: optionalText(input, 'openid', 128),
    subOpenid: optionalText(input, 'sub_openid', 128),
    wxOpenid: optionalText(input, 'wx_openid', 128),
    miniOpenid: optionalText(input, 'mini_openid', 128),
    buyerOpenId: optionalText(input, 'buyer_open_id', 128),
    buyerId: optionalText(input, 'buyer_id', 128),
    subAppId: optionalText(input, 'sub_appid', 128),
    opAppId: optionalText(input, 'op_app_id', 128),
    authCode: optionalText(input, 'auth_code', 128),
    clientIp,
  };
  if (!isHttpsUrl(values.notifyUrl)) throw new Error('notify_url 必须是非本地 HTTPS 地址');
  if (values.returnUrl && !isHttpsUrl(values.returnUrl)) throw new Error('return_url 必须是非本地 HTTPS 地址');
  return values;
}

function checkoutUrl(request, paymentNo) {
  return new URL(`/payment/${encodeURIComponent(paymentNo)}`, request.url).toString();
}

function cashierUrl(request, externalOrderNo) {
  return new URL(`/cashier/${encodeURIComponent(externalOrderNo)}`, request.url).toString();
}

export function publicEndpointUrl(request, env, pathname) {
  const configured = String(env.PUBLIC_BASE_URL ?? '').trim();
  try {
    const base = new URL(configured);
    if (base.protocol === 'https:') return new URL(pathname, base).toString();
  } catch {
    // Fall back to the current request origin when no public base URL is configured.
  }
  return new URL(pathname, request.url).toString();
}

function providerCallbackUrl(request, env, paymentNo) {
  return publicEndpointUrl(request, env, `/api/pay/${encodeURIComponent(paymentNo)}/callback`);
}

async function createDirectPresentation(request, env, plugin, config, fields, paymentNo, expiresAt = '') {
  const inferredClientIp = fields.clientIp
    || String(request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  const oauthState = plugin.manifest.needsWechatOauthState
    ? await createWechatOauthState(env, paymentNo)
    : '';
  const oauthCallbackUrl = new URL(publicEndpointUrl(request, env, '/api/wechat/oauth/callback'));
  if (oauthState) oauthCallbackUrl.searchParams.set('resume', oauthState);
  const order = {
    payNo: paymentNo,
    bizNo: fields.outTradeNo,
    merchantNo: String(env.EPAY_PID ?? ''),
    amount: fields.amountFen,
    subject: fields.name,
    body: fields.name,
    merchantParam: fields.param,
    returnUrl: fields.returnUrl || checkoutUrl(request, paymentNo),
    paymentUrl: checkoutUrl(request, paymentNo),
    cashierUrl: cashierUrl(request, fields.outTradeNo),
    callbackUrl: providerCallbackUrl(request, env, paymentNo),
    providerReturnUrl: providerCallbackUrl(request, env, paymentNo),
    payType: fields.type,
    device: fields.device || 'pc',
    clientIp: inferredClientIp,
    expiresAt,
    openid: fields.openid,
    subOpenid: fields.subOpenid,
    wxOpenid: fields.wxOpenid,
    miniOpenid: fields.miniOpenid,
    buyerOpenId: fields.buyerOpenId,
    buyerId: fields.buyerId,
    subAppId: fields.subAppId,
    opAppId: fields.opAppId,
    authCode: fields.authCode,
    alipayProduct: fields.alipayProduct,
    wechatProduct: fields.wechatProduct,
    oauthCallbackUrl: oauthState ? oauthCallbackUrl.toString() : '',
  };
  await authorized(env, plugin, 'createPayment');
  return plugin.createPayment(callContext(env, { config, order }));
}

function paymentSnapshot(payment, metadata) {
  return {
    payment_no: payment.payment_no,
    external_order_no: payment.external_order_no,
    plugin_code: payment.plugin_code,
    expected_amount_fen: Number(payment.expected_amount_fen),
    status: payment.status,
    expires_at: payment.expires_at,
    created_at: payment.created_at,
  };
}

async function pluginSetup(env, fields, channel) {
  const plugin = pluginOf(env, channel.plugin_code);
  const { registry } = runtimeOf(env);
  const allConfig = await runtimePluginConfig(env);
  if (!pluginEnabled(registry, allConfig, plugin.manifest.code)) throw new Error(`${plugin.manifest.name}已停用`);
  const config = configForPlugin(allConfig, plugin.manifest.code);
  const missing = missingPluginFields(registry, allConfig, plugin.manifest.code);
  if (missing.length) throw new Error(`${plugin.manifest.name}缺少原配置字段：${missing.join('、')}`);
  const siteConfig = await runtimeSiteConfig(env);
  const expireMinutes = channelExpireMinutes(channel, siteConfig.order_expire_minutes);
  const expiresAt = expiringAt(expireMinutes * 60);
  const receiptSetup = plugin.manifest.mode === 'channel-notify'
    ? await receiptPresentation(env, plugin, config, fields.amountFen, expiresAt, fields.type)
    : null;
  return { plugin, config, expiresAt, expireMinutes, receiptSetup };
}

async function completeDirectPresentation(request, env, setup, fields, paymentNo, metadata) {
  if (setup.plugin.manifest.mode !== 'direct') return metadata;
  const providerPresentation = await createDirectPresentation(
    request,
    env,
    setup.plugin,
    setup.config,
    fields,
    paymentNo,
    setup.expiresAt,
  );
  return {
    ...metadata,
    presentation: providerPresentation,
    provider_order_no: String(providerPresentation.chan_order_no ?? ''),
    provider_trade_no: String(providerPresentation.chan_trade_no ?? ''),
    provider_callback_url: providerCallbackUrl(request, env, paymentNo),
  };
}

async function activateCashierAttempt(request, env, fields, channel, existing, metadataOverrides = {}) {
  const currentMetadata = parseJson(existing.metadata_json);
  if (existing.status === 'PAID') {
    return { payment: existing, metadata: currentMetadata, duplicate: true };
  }
  if (['EXPIRED', 'CLOSED'].includes(existing.status) || Date.parse(existing.expires_at) <= Date.now()) {
    throw new Error('订单已超时，不能继续支付');
  }
  if (
    existing.status === 'PAYING'
    && existing.plugin_code === channel.plugin_code
    && Number(currentMetadata.channel_id) === Number(channel.id)
  ) {
    return { payment: existing, metadata: currentMetadata, duplicate: true };
  }

  const setup = await pluginSetup(env, fields, channel);
  let metadata = {
    ...currentMetadata,
    protocol: 'epay_v1',
    epay_type: fields.type,
    name: fields.name,
    param: fields.param,
    buyer: fields.buyer,
    return_url: fields.returnUrl,
    device: fields.device,
    checkout_fields: fields,
    cashier_order: true,
    channel_id: channel.id,
    channel_name: channel.name,
    channel_weight: channel.weight,
    order_expire_minutes: setup.expireMinutes,
    confirmation_grace_seconds: setup.plugin.manifest.receiptGraceSeconds > 0
      ? setup.plugin.manifest.receiptGraceSeconds
      : 0,
    ...metadataOverrides,
    ...(setup.receiptSetup?.metadata ?? {}),
    ...(setup.receiptSetup ? { presentation: setup.receiptSetup.presentation } : {}),
  };
  delete metadata.provider_error;
  delete metadata.provider_order_no;
  delete metadata.provider_trade_no;
  delete metadata.provider_result;

  const activatedAt = timestamp();
  await env.DB.prepare(`
    UPDATE payment_attempts
    SET plugin_code = ?, status = 'PAYING', provider_trade_no = '', paid_at = NULL,
        expires_at = ?, metadata_json = ?, updated_at = ?
    WHERE payment_no = ? AND status <> 'PAID'
  `).bind(
    setup.plugin.manifest.code,
    setup.expiresAt,
    JSON.stringify(metadata),
    activatedAt,
    existing.payment_no,
  ).run();

  try {
    metadata = await completeDirectPresentation(
      request,
      env,
      setup,
      fields,
      existing.payment_no,
      metadata,
    );
    await env.DB.prepare(`
      UPDATE payment_attempts SET provider_trade_no = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status = 'PAYING'
    `).bind(
      String(metadata.provider_trade_no || metadata.provider_order_no || ''),
      JSON.stringify(metadata),
      timestamp(),
      existing.payment_no,
    ).run();
  } catch (error) {
    metadata.provider_error = String(error.message ?? error).slice(0, 500);
    await env.DB.prepare(`
      UPDATE payment_attempts SET status = 'FAILED', metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status = 'PAYING'
    `).bind(JSON.stringify(metadata), timestamp(), existing.payment_no).run();
    throw error;
  }

  return {
    payment: {
      ...paymentSnapshot(existing, metadata),
      plugin_code: setup.plugin.manifest.code,
      status: 'PAYING',
      expires_at: setup.expiresAt,
    },
    metadata,
    duplicate: false,
  };
}

async function createPaymentAttempt(request, env, fields, channel, metadataOverrides = {}) {
  const existing = await env.DB.prepare(`SELECT * FROM payment_attempts WHERE external_order_no = ?`).bind(fields.outTradeNo).first();
  if (existing?.plugin_code === 'cashier') {
    return activateCashierAttempt(request, env, fields, channel, existing, metadataOverrides);
  }
  if (existing) return { payment: existing, metadata: parseJson(existing.metadata_json), duplicate: true };

  const setup = await pluginSetup(env, fields, channel);
  const paymentNo = createPaymentNo();
  const createdAt = timestamp();
  let metadata = {
    protocol: 'epay_v1', epay_type: fields.type, name: fields.name, param: fields.param, buyer: fields.buyer,
    return_url: fields.returnUrl, device: fields.device, checkout_fields: fields,
    channel_id: channel.id, channel_name: channel.name, channel_weight: channel.weight,
    order_expire_minutes: setup.expireMinutes,
    confirmation_grace_seconds: setup.plugin.manifest.receiptGraceSeconds > 0
      ? setup.plugin.manifest.receiptGraceSeconds
      : 0,
    ...metadataOverrides,
    ...(setup.receiptSetup?.metadata ?? {}),
    ...(setup.receiptSetup ? { presentation: setup.receiptSetup.presentation } : {}),
  };
  await env.DB.prepare(`
    INSERT INTO payment_attempts (
      payment_no, external_order_no, plugin_code, expected_amount_fen, currency, status,
      notify_url, expires_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'CNY', 'PAYING', ?, ?, ?, ?, ?)
  `).bind(
    paymentNo,
    fields.outTradeNo,
    setup.plugin.manifest.code,
    fields.amountFen,
    fields.notifyUrl,
    setup.expiresAt,
    JSON.stringify(metadata),
    createdAt,
    createdAt,
  ).run();

  if (setup.plugin.manifest.mode === 'direct') {
    try {
      metadata = await completeDirectPresentation(request, env, setup, fields, paymentNo, metadata);
      await env.DB.prepare(`
        UPDATE payment_attempts SET provider_trade_no = ?, metadata_json = ?, updated_at = ?
        WHERE payment_no = ? AND status = 'PAYING'
      `).bind(
        String(metadata.provider_trade_no || metadata.provider_order_no || ''),
        JSON.stringify(metadata), timestamp(), paymentNo,
      ).run();
    } catch (error) {
      metadata.provider_error = String(error.message ?? error).slice(0, 500);
      await env.DB.prepare(`
        UPDATE payment_attempts SET status = 'FAILED', metadata_json = ?, updated_at = ?
        WHERE payment_no = ? AND status = 'PAYING'
      `).bind(JSON.stringify(metadata), timestamp(), paymentNo).run();
      throw error;
    }
  }

  return {
    payment: {
      payment_no: paymentNo,
      external_order_no: fields.outTradeNo,
      plugin_code: setup.plugin.manifest.code,
      expected_amount_fen: fields.amountFen,
      status: 'PAYING',
      expires_at: setup.expiresAt,
      created_at: createdAt,
    },
    metadata,
    duplicate: false,
  };
}

async function createCashierDraft(env, fields) {
  await expireDuePayments(env);
  const existing = await env.DB.prepare(
    'SELECT * FROM payment_attempts WHERE external_order_no = ?',
  ).bind(fields.outTradeNo).first();
  if (existing) {
    return {
      payment: existing,
      metadata: parseJson(existing.metadata_json),
      duplicate: true,
      cashier: true,
    };
  }
  const paymentNo = createPaymentNo();
  const createdAt = timestamp();
  const siteConfig = await runtimeSiteConfig(env);
  const expiresAt = expiringAt(siteConfig.order_expire_minutes * 60);
  const metadata = {
    protocol: 'epay_v1',
    epay_type: fields.type,
    name: fields.name,
    param: fields.param,
    buyer: fields.buyer,
    return_url: fields.returnUrl,
    device: fields.device,
    checkout_fields: fields,
    cashier_order: true,
  };
  await env.DB.prepare(`
    INSERT INTO payment_attempts (
      payment_no, external_order_no, plugin_code, expected_amount_fen, currency, status,
      notify_url, expires_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'cashier', ?, 'CNY', 'PENDING', ?, ?, ?, ?, ?)
  `).bind(
    paymentNo,
    fields.outTradeNo,
    fields.amountFen,
    fields.notifyUrl,
    expiresAt,
    JSON.stringify(metadata),
    createdAt,
    createdAt,
  ).run();
  return {
    payment: {
      payment_no: paymentNo,
      external_order_no: fields.outTradeNo,
      plugin_code: 'cashier',
      expected_amount_fen: fields.amountFen,
      status: 'PENDING',
      expires_at: expiresAt,
      created_at: createdAt,
    },
    metadata,
    duplicate: false,
    cashier: true,
  };
}

async function createEpayAttempt(request, env, input, isMapi) {
  await verifyEpayV1(input, env);
  const fields = validateSubmit(input, isMapi);
  if (!fields.type || fields.type === 'bank') return createCashierDraft(env, fields);
  const requestedType = fields.type;
  const channel = resolveChannel(runtimeOf(env).registry, await routableChannels(env), fields.type);
  fields.type = channel.pay_types[0];
  return createPaymentAttempt(request, env, fields, channel, { epay_requested_type: requestedType });
}

function mapiResponse(request, attempt) {
  const payUrl = attempt.cashier
    ? cashierUrl(request, attempt.payment.external_order_no)
    : String(
      attempt.metadata.presentation?.pay_params?.url
      ?? checkoutUrl(request, attempt.payment.payment_no),
    );
  const response = { code: 1, msg: '提交成功', trade_no: attempt.payment.payment_no, payurl: payUrl };
  const presentation = attempt.metadata.presentation ?? {};
  const payParams = attempt.metadata.presentation?.pay_params ?? {};
  if (payParams.qrcode) response.qrcode = payParams.qrcode;
  if (payParams.qrcode_image) response.qrcode = payParams.qrcode_image;
  if (presentation.pay_product) response.pay_product = presentation.pay_product;
  if (presentation.pay_page === 'jsapi') {
    const {
      raw: _raw, description: _description, ...clientParams
    } = payParams;
    response.pay_info = clientParams;
  } else if (presentation.pay_product === 'app' && payParams.params) {
    response.pay_info = payParams.params;
  } else if (presentation.pay_product === 'mini' && payParams.request_payment) {
    response.pay_info = payParams.request_payment;
    response.app_id = payParams.app_id;
  } else if (presentation.pay_product === 'mini' && payParams.tradeNO) {
    response.pay_info = { tradeNO: payParams.tradeNO };
    response.app_id = payParams.app_id;
    if (payParams.mini_launch_path) response.mini_launch_path = payParams.mini_launch_path;
  }
  return jsonResponse(response);
}

async function epaySubmit(request, env) {
  try {
    const attempt = await createEpayAttempt(request, env, await readEpayPayload(request), false);
    const payUrl = attempt.cashier
      ? cashierUrl(request, attempt.payment.external_order_no)
      : String(
        attempt.metadata.presentation?.pay_params?.url
        ?? checkoutUrl(request, attempt.payment.payment_no),
      );
    return Response.redirect(payUrl, 302);
  } catch (error) {
    return new Response(`ePay V1 提交失败：${String(error.message ?? error)}`, {
      status: Number(error.status) || 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function epayMapi(request, env) {
  try { return mapiResponse(request, await createEpayAttempt(request, env, await readEpayPayload(request), true)); }
  catch (error) { return jsonResponse({ code: 0, msg: String(error.message ?? error) }, Number(error.status) || 200); }
}

function assertEpayApiAccess(input, env) {
  const key = String(input.key ?? '');
  const acceptedKeys = [env.EPAY_KEY, env.EPAY_PREVIOUS_KEY].filter(Boolean).map(String);
  if (String(input.pid ?? '') !== String(env.EPAY_PID ?? '') || !acceptedKeys.includes(key)) {
    throw new Error('商户密钥错误');
  }
}

function ePayOrderRow(row, env) {
  const metadata = parseJson(row.metadata_json);
  return {
    trade_no: row.payment_no, out_trade_no: row.external_order_no, api_trade_no: row.provider_trade_no ?? '',
    type: metadata.epay_type ?? row.plugin_code, pid: Number(env.EPAY_PID), addtime: row.created_at,
    endtime: row.paid_at ?? '', name: metadata.name ?? '', money: fenToMoney(row.expected_amount_fen),
    status: row.status === 'PAID' ? 1 : 0, param: metadata.param ?? '', buyer: metadata.buyer ?? '',
  };
}

async function epayApi(request, env) {
  try {
    await expireDuePayments(env);
    const input = await readEpayPayload(request);
    assertEpayApiAccess(input, env);
    const act = String(input.act ?? '').toLowerCase();
    if (act === 'query') {
      const [{ count: orders = 0 } = {}] = (await env.DB.prepare('SELECT COUNT(*) AS count FROM payment_attempts').all()).results;
      return jsonResponse({ code: 1, pid: Number(env.EPAY_PID), active: 1, money: '0.00', type: 4, account: '', username: '', orders: Number(orders), order_today: 0, order_lastday: 0 });
    }
    if (act === 'settle') return jsonResponse({ code: 1, msg: '查询结算记录成功！', data: [] });
    if (act === 'order') {
      const tradeNo = optionalText(input, 'trade_no', 64); const outTradeNo = optionalText(input, 'out_trade_no', 64);
      if (!tradeNo && !outTradeNo) throw new Error('trade_no 或 out_trade_no 不能为空');
      const row = tradeNo
        ? await env.DB.prepare('SELECT * FROM payment_attempts WHERE payment_no = ?').bind(tradeNo).first()
        : await env.DB.prepare('SELECT * FROM payment_attempts WHERE external_order_no = ?').bind(outTradeNo).first();
      return row ? jsonResponse({ code: 1, msg: '查询订单号成功！', ...ePayOrderRow(row, env) }) : jsonResponse({ code: 0, msg: '订单不存在' });
    }
    if (act === 'orders') {
      const limit = Math.max(1, Math.min(50, Number(input.limit ?? 20))); const page = Math.max(1, Number(input.page ?? 1));
      const { results } = await env.DB.prepare('SELECT * FROM payment_attempts ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, (page - 1) * limit).all();
      return jsonResponse({ code: 1, msg: '查询订单成功！', data: results.map((row) => ePayOrderRow(row, env)) });
    }
    if (act === 'refund') {
      const refund = await performEpayRefund(env, input, await runtimePluginConfig(env));
      return jsonResponse({ code: 1, msg: '退款成功', ...refund });
    }
    throw new Error('act 参数不支持');
  } catch (error) { return jsonResponse({ code: 0, msg: String(error.message ?? error) }, Number(error.status) || 200); }
}

function digestHex(buffer) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }

async function mutableReceiptPayments(env, pluginCode) {
  await expireDuePayments(env);
  const now = timestamp();
  // 链上确认这类插件声明了宽限期：过期订单在这段时间内仍可被确认为已支付。
  const grace = pluginOrNull(env, pluginCode)?.manifest.receiptGraceSeconds ?? 0;
  const graceCutoff = new Date(Date.now() - (grace * 1_000)).toISOString();
  const query = grace > 0
    ? `
      SELECT * FROM payment_attempts
      WHERE plugin_code = ? AND status IN ('PAYING', 'EXPIRED') AND expires_at > ?
      ORDER BY created_at ASC
    `
    : `
      SELECT * FROM payment_attempts
      WHERE plugin_code = ? AND status = 'PAYING' AND expires_at > ?
      ORDER BY created_at ASC
    `;
  const { results } = await env.DB.prepare(query)
    .bind(pluginCode, grace > 0 ? graceCutoff : now)
    .all();
  return results.map((payment) => ({ ...payment, metadata: parseJson(payment.metadata_json) }));
}

async function receiptEventSeen(env, source, eventId) {
  return Boolean(await env.DB.prepare(
    'SELECT 1 AS seen FROM receipt_events WHERE source = ? AND event_id = ?',
  ).bind(source, eventId).first());
}

async function receiptEventRecord(env, source, eventId) {
  return env.DB.prepare(`
    SELECT payment_no, state, received_at, processed_at
    FROM receipt_events
    WHERE source = ? AND event_id = ?
  `).bind(source, eventId).first();
}

async function confirmReceipt(env, ctx, plugin, payment, {
  eventId, providerTradeNo, paidAt, eventAmountFen, raw, updateMetadata,
}) {
  if (!payment) throw new Error('订单不存在、已结束或插件不匹配');
  const metadata = payment.metadata ?? parseJson(payment.metadata_json);
  if (typeof updateMetadata === 'function') updateMetadata(metadata);
  const receivedAt = timestamp();
  const event = await env.DB.prepare(`
    INSERT INTO receipt_events (source, event_id, payment_no, provider_trade_no, amount_fen, received_at, state, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', ?) ON CONFLICT(source, event_id) DO NOTHING
  `).bind(plugin.manifest.code, eventId, payment.payment_no, providerTradeNo, eventAmountFen, receivedAt, raw).run();
  if (event.meta.changes !== 1) return { duplicate: true };
  const statusPredicate = plugin.manifest.receiptGraceSeconds > 0
    ? "status IN ('PAYING', 'EXPIRED')"
    : "status = 'PAYING'";
  const updated = await env.DB.prepare(`
    UPDATE payment_attempts
    SET status = 'PAID', provider_trade_no = ?, paid_at = ?, metadata_json = ?, updated_at = ?
    WHERE payment_no = ? AND ${statusPredicate}
  `).bind(providerTradeNo, paidAt, JSON.stringify(metadata), receivedAt, payment.payment_no).run();
  if (updated.meta.changes !== 1) throw new Error('订单状态已变化');
  await env.DB.prepare(`UPDATE receipt_events SET state = 'PROCESSED', processed_at = ? WHERE source = ? AND event_id = ?`).bind(timestamp(), plugin.manifest.code, eventId).run();
  await enqueuePaymentNotification(env, payment.payment_no);
  ctx.waitUntil(dispatchDueNotifications(env, 1, payment.payment_no));
  return { paymentNo: payment.payment_no };
}

async function applyProviderResult(env, ctx, plugin, result) {
  if (!result?.payNo || !result?.eventId) throw new Error('渠道回调缺少支付单号或事件号');
  const payment = await env.DB.prepare(
    'SELECT * FROM payment_attempts WHERE payment_no = ? AND plugin_code = ?',
  ).bind(result.payNo, plugin.manifest.code).first();
  if (!payment) throw new Error('订单不存在或插件不匹配');
  const notifiedAmountFen = Number(result.amountFen);
  if (
    plugin.manifest.verifyCallbackAmount
    && result.status === 'success'
    && (
      !Number.isSafeInteger(notifiedAmountFen)
      || notifiedAmountFen <= 0
      || notifiedAmountFen !== Number(payment.expected_amount_fen)
    )
  ) {
    throw new Error(`${plugin.manifest.name}通知金额不匹配：订单 ${payment.expected_amount_fen} 分，通知 ${result.amountFen ?? '缺失'} 分`);
  }

  const receivedAt = timestamp();
  const event = await env.DB.prepare(`
    INSERT INTO receipt_events (source, event_id, payment_no, provider_trade_no, amount_fen, received_at, state, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', ?) ON CONFLICT(source, event_id) DO NOTHING
  `).bind(
    plugin.manifest.code, result.eventId, payment.payment_no, String(result.channelTradeNo ?? ''),
    Number.isSafeInteger(notifiedAmountFen) && notifiedAmountFen > 0
      ? notifiedAmountFen
      : Number(payment.expected_amount_fen),
    receivedAt, String(result.raw ?? ''),
  ).run();
  if (event.meta.changes !== 1) return { duplicate: true, paymentNo: payment.payment_no };

  const metadata = parseJson(payment.metadata_json);
  const providerResult = {
    status: result.status,
    message: result.message ?? '',
    channel_order_no: result.channelOrderNo ?? '',
    channel_trade_no: result.channelTradeNo ?? '',
    channel_status: result.channelStatus ?? '',
    channel_error_code: result.channelErrorCode ?? '',
    channel_error_message: result.channelErrorMessage ?? '',
    details: result.details ?? {},
    event_id: result.eventId,
    updated_at: receivedAt,
  };

  let changedToPaid = false;
  if (result.status === 'success') {
    const paidAt = String(result.paidAt || receivedAt);
    metadata.provider_result = providerResult;
    metadata.payment_confirmation = {
      source: 'provider_callback',
      plugin_code: plugin.manifest.code,
      event_id: result.eventId,
      channel_trade_no: result.channelTradeNo ?? result.channelOrderNo ?? '',
      confirmed_at: paidAt,
    };
    const updated = await env.DB.prepare(`
      UPDATE payment_attempts
      SET status = 'PAID', provider_trade_no = ?, paid_at = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status IN ('PAYING', 'EXPIRED')
    `).bind(
      String(result.channelTradeNo || result.channelOrderNo || ''),
      paidAt, JSON.stringify(metadata), receivedAt, payment.payment_no,
    ).run();
    changedToPaid = updated.meta.changes === 1;
    if (!changedToPaid && payment.status !== 'PAID') throw new Error('订单状态已变化');
  } else if (result.status === 'failed') {
    metadata.provider_result = providerResult;
    await env.DB.prepare(`
      UPDATE payment_attempts SET status = 'FAILED', provider_trade_no = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status = 'PAYING'
    `).bind(
      String(result.channelTradeNo || result.channelOrderNo || ''),
      JSON.stringify(metadata), receivedAt, payment.payment_no,
    ).run();
  } else {
    metadata.provider_result = providerResult;
    await env.DB.prepare(`
      UPDATE payment_attempts SET provider_trade_no = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status = 'PAYING'
    `).bind(
      String(result.channelTradeNo || result.channelOrderNo || payment.provider_trade_no || ''),
      JSON.stringify(metadata), receivedAt, payment.payment_no,
    ).run();
  }

  await env.DB.prepare(`
    UPDATE receipt_events SET state = 'PROCESSED', processed_at = ?
    WHERE source = ? AND event_id = ?
  `).bind(timestamp(), plugin.manifest.code, result.eventId).run();

  if (changedToPaid) {
    await enqueuePaymentNotification(env, payment.payment_no);
    ctx.waitUntil(dispatchDueNotifications(env, 1, payment.payment_no));
  }
  return { paymentNo: payment.payment_no, status: result.status };
}

async function providerCallbackSnapshot(request, plugin) {
  const contentType = String(request.headers.get('content-type') ?? '').toLowerCase();
  const raw = await readBoundedText(request.clone(), PROVIDER_CALLBACK_MAX_BYTES, '渠道回调请求体');
  let payload = {};
  try {
    if (plugin.manifest.callbackFormat === 'xml' || contentType.includes('xml')) {
      payload = decodeWechatXml(raw);
    } else if (request.method === 'GET') {
      payload = Object.fromEntries(new URL(request.url).searchParams);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      payload = Object.fromEntries(new URLSearchParams(raw));
    } else if (contentType.includes('json')) {
      payload = JSON.parse(raw);
    } else if (raw) {
      payload = { raw_text: raw.slice(0, 8_000) };
    }
  } catch (error) {
    payload = {
      raw_text: raw.slice(0, 8_000),
      parse_error: String(error.message ?? error).slice(0, 300),
    };
  }
  return {
    source: 'provider_webhook',
    method: request.method,
    content_type: contentType,
    request: payload,
  };
}

async function recordProviderCallbackFailure(env, payment, plugin, snapshot, error) {
  try {
    const data = snapshot?.request && typeof snapshot.request === 'object'
      ? snapshot.request
      : {};
    const providerTradeNo = String(
      data.transaction_id ?? data.trade_no ?? data.id ?? payment.provider_trade_no ?? '',
    ).slice(0, 128);
    const parsedAmount = Number(data.total_fee ?? data.amount ?? payment.expected_amount_fen);
    const amountFen = Number.isSafeInteger(parsedAmount) && parsedAmount >= 0
      ? parsedAmount
      : Number(payment.expected_amount_fen);
    const reason = String(error.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 500);
    await env.DB.prepare(`
      INSERT INTO receipt_events (
        source, event_id, payment_no, provider_trade_no, amount_fen,
        received_at, processed_at, state, reason, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'REJECTED', ?, ?)
    `).bind(
      plugin.manifest.code,
      `${plugin.manifest.code}:rejected:${crypto.randomUUID()}`,
      payment.payment_no,
      providerTradeNo,
      amountFen,
      timestamp(),
      timestamp(),
      reason,
      JSON.stringify(snapshot).slice(0, 32_000),
    ).run();
  } catch (logError) {
    console.warn('payment_callback_failure_log_failed', {
      paymentNo: payment.payment_no,
      message: String(logError.message ?? logError),
    });
  }
}

function watcherChannelPayTypes(channel, plugin) {
  const supported = new Set(plugin.manifest.payTypes);
  const values = channel.pay_types.filter((type) => supported.has(type));
  return values.length ? values : [...plugin.manifest.payTypes];
}

function watcherConfigForPlugin(pluginConfig, pluginCode) {
  const config = { ...configForPlugin(pluginConfig, pluginCode) };
  for (const key of WATCHER_CONFIG_OMIT_KEYS) delete config[key];
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.length > 2048 && /(?:image|qrcode)/iu.test(key)) {
      delete config[key];
    }
  }
  return config;
}

async function receiptWatcherAccounts(env, options = {}) {
  const {
    supportedBaseCodes = null,
    expire = true,
    maxOrdersPerPlugin = 0,
    sanitizeConfig = false,
  } = options;
  if (expire) await expireDuePayments(env);
  const { registry } = runtimeOf(env);
  const supported = supportedBaseCodes instanceof Set ? supportedBaseCodes : null;
  const [pluginConfig, licensed] = await Promise.all([runtimePluginConfig(env), licensedCodes(env)]);
  const channels = (await runtimeChannels(env)).filter((channel) => {
    const plugin = registry.get(channel.plugin_code);
    return channel.enabled && plugin?.manifest.mode === 'channel-notify'
      && (!supported || supported.has(basePluginCode(channel.plugin_code)))
      && licenseCovers(licensed, channel.plugin_code)
      && pluginEnabled(registry, pluginConfig, channel.plugin_code);
  });
  if (!channels.length) return [];
  const now = timestamp();
  // 取所有已装载插件里最长的确认宽限期，保证声明了宽限期的插件仍能拿到刚过期的订单。
  const maxGrace = Math.max(0, ...registry.manifests().map((manifest) => manifest.receiptGraceSeconds));
  const graceCutoff = new Date(Date.now() - (maxGrace * 1_000)).toISOString();
  const pluginCodes = [...new Set(channels.map((channel) => channel.plugin_code))];
  const placeholders = pluginCodes.map(() => '?').join(',');
  // 声明了确认宽限期的插件（链上转账要等区块确认）连刚过期的订单也要一起交出去。
  // 按清单挑，不认编码——插件副本的编码不是 `usdt_trc20_receipt`，硬编码会漏掉它们。
  const graceCodes = pluginCodes.filter((code) => registry.require(code).manifest.receiptGraceSeconds > 0);
  const graceClause = graceCodes.length ? `OR (
      plugin_code IN (${graceCodes.map(() => '?').join(',')})
      AND status IN ('PAYING', 'EXPIRED')
      AND expires_at > ?
    )` : '';
  const limit = Math.max(0, Math.floor(Number(maxOrdersPerPlugin) || 0)) * pluginCodes.length;
  const limitClause = limit > 0 ? '\n    LIMIT ?' : '';
  const { results } = await env.DB.prepare(`
    SELECT payment_no, external_order_no, plugin_code, expected_amount_fen, currency,
      status, provider_trade_no, paid_at, expires_at, metadata_json, created_at, updated_at
    FROM payment_attempts
    WHERE (
      plugin_code IN (${placeholders}) AND status = 'PAYING' AND expires_at > ?
    ) ${graceClause}
    ORDER BY created_at ASC${limitClause}
  `).bind(
    ...pluginCodes,
    now,
    ...(graceCodes.length ? [...graceCodes, graceCutoff] : []),
    ...(limit > 0 ? [limit] : []),
  ).all();
  const groupedChannels = [...channels.reduce((groups, channel) => {
    if (!groups.has(channel.plugin_code)) groups.set(channel.plugin_code, []);
    groups.get(channel.plugin_code).push(channel);
    return groups;
  }, new Map()).values()];
  const accounts = groupedChannels.map((accountChannels) => {
    const primaryChannel = accountChannels[0];
    const plugin = registry.require(primaryChannel.plugin_code);
    const pluginAccountConfig = sanitizeConfig
      ? watcherConfigForPlugin(pluginConfig, primaryChannel.plugin_code)
      : configForPlugin(pluginConfig, primaryChannel.plugin_code);
    const config = {
      ...pluginAccountConfig,
      plugin_code: primaryChannel.plugin_code,
      api_config_id: primaryChannel.id,
      channel_id: primaryChannel.id,
      receipt_watcher_query_interval_seconds: 15,
    };
    const watcherChannels = accountChannels.flatMap((channel) => {
      return watcherChannelPayTypes(channel, plugin).map((payType) => ({
        channel_id: channel.id,
        merchant_id: 1,
        name: channel.name,
        pay_type: payType,
        pay_type_name: cashierTypeName(payType),
        terminal_no: String(config.receipt_terminal_no ?? ''),
      }));
    }).map((channel, index) => ({ ...channel, pay_type_id: index + 1 }));
    const channelIds = new Set(accountChannels.map((channel) => Number(channel.id)));
    const accountOrders = results
      .filter((payment) => {
        const metadata = parseJson(payment.metadata_json);
        return payment.plugin_code === primaryChannel.plugin_code
          && channelIds.has(Number(metadata.channel_id));
      })
      .map((payment) => {
        const metadata = parseJson(payment.metadata_json);
        const personalReceipt = metadata[PERSONAL_RECEIPT_KEY] ?? {};
        const watcherReceipt = metadata[WATCHER_RECEIPT_KEY] ?? {};
        const watcherChannel = watcherChannels.find((candidate) => {
          return Number(candidate.channel_id) === Number(metadata.channel_id)
            && candidate.pay_type === String(metadata.epay_type ?? '');
        }) ?? watcherChannels.find((candidate) => Number(candidate.channel_id) === Number(metadata.channel_id));
        return {
          pay_no: payment.payment_no,
          channel_id: Number(metadata.channel_id),
          pay_type_id: Number(watcherChannel?.pay_type_id ?? 1),
          pay_type: String(metadata.epay_type ?? watcherChannel?.pay_type ?? ''),
          pay_amount: Number(personalReceipt.receipt_amount ?? payment.expected_amount_fen),
          channel_order_no: payment.payment_no,
          channel_trade_no: String(payment.provider_trade_no ?? ''),
          request_at: payment.created_at,
          expire_at: payment.expires_at,
          created_at: payment.created_at,
          ext_json: Object.keys(watcherReceipt).length ? { [WATCHER_RECEIPT_KEY]: watcherReceipt } : {},
        };
      });
    return {
      account_key: primaryChannel.plugin_code,
      plugin_code: primaryChannel.plugin_code,
      api_config_id: primaryChannel.id,
      merchant_id: 1,
      config,
      query_interval_seconds: 15,
      channels: watcherChannels,
      orders: accountOrders,
      refreshed_at: Math.floor(Date.now() / 1_000),
    };
  });
  return accounts;
}

function receiptDiscoveryKey(requestId) {
  const value = String(requestId ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('最近流水查询任务 ID 不合法');
  }
  return `${RECEIPT_DISCOVERY_PREFIX}${value}`;
}

async function receiptWatcherDiscoveries(env, supported) {
  const cutoff = new Date(Date.now() - (2 * 60 * 1_000)).toISOString();
  const { results = [] } = await env.DB.prepare(`
    SELECT setting_key, value_text
    FROM runtime_settings
    WHERE setting_key LIKE 'receipt_discovery:%' AND updated_at >= ?
    ORDER BY updated_at ASC
  `).bind(cutoff).all();
  if (!results.length) return [];
  const config = await runtimePluginConfig(env);
  const discoveries = [];
  for (const row of results) {
    const job = parseJson(String(row.value_text ?? ''));
    const pluginCode = String(job.plugin_code ?? '');
    if (job.status !== 'pending' || !supported.has(basePluginCode(pluginCode))
      || Date.parse(String(job.expires_at ?? '')) <= Date.now()) continue;
    const running = { ...job, status: 'running', started_at: timestamp() };
    const nextValue = JSON.stringify(running);
    const claimed = await env.DB.prepare(`
      UPDATE runtime_settings
      SET value_text = ?, updated_at = ?
      WHERE setting_key = ? AND value_text = ?
    `).bind(nextValue, timestamp(), row.setting_key, row.value_text).run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) continue;
    discoveries.push({
      ...receiptDiscoveryAccount(pluginCode, watcherConfigForPlugin(config, pluginCode)),
      request_id: job.request_id,
    });
  }
  return discoveries;
}

async function watcherSnapshot(request, env) {
  const transportSecrets = [
    env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY,
    env.WATCHER_PREVIOUS_TRANSPORT_SECRET,
  ].filter(Boolean).map(String);
  if (!await verifyWatcherSnapshotRequest(request, transportSecrets)) return unauthorized();
  // Watcher 声明的是"我会查哪些平台"，永远是基础编码；副本由同一个监听插件接管，
  // 所以下面按基础编码把副本账号一并派给它。
  const { registry } = runtimeOf(env);
  const capabilities = [...new Set(String(request.headers.get('x-edgepay-watcher-plugins') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => registry.hasBase(value)))].sort();
  const instanceId = String(request.headers.get('x-edgepay-watcher-instance') ?? '').trim();
  const declaredKind = String(request.headers.get('x-edgepay-watcher-kind') ?? '').trim();
  const watcherKind = ['docker', 'yyb_bridge'].includes(declaredKind)
    ? declaredKind
    : (/^yyb-bridge-/u.test(instanceId) ? 'yyb_bridge' : 'docker');
  // 认领了确切通道的实例（应用宝桥接一个进程只盯一份插件配置）报上来，掉线告警就
  // 按通道归属，不再把同一插件下别的账号一并算成停摆——一个微信掉线不代表另一个也掉。
  // 官方 Watcher 一个进程包揽整个平台，不报这个头，仍按插件归属，行为不变。
  const declaredChannels = String(request.headers.get('x-edgepay-watcher-channels') ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  // 每个 Watcher 实例各写各的行，读的时候取并集：同时跑两个 Watcher 时
  // 不会再互相把对方声明的插件冲掉。详见 watcher-presence.js。
  await recordWatcherPresence(
    env,
    await presenceKey(instanceId, capabilities),
    capabilities,
    Date.now(),
    { kind: watcherKind, channelIds: declaredChannels },
  );
  if (!capabilities.length) {
    return jsonResponse(
      { generated_at: timestamp(), poll_seconds: 15, accounts: [], discoveries: [] },
      200,
      { 'cache-control': 'no-store' },
    );
  }
  const supported = new Set(capabilities);
  const [accounts, discoveries] = await Promise.all([
    receiptWatcherAccounts(env, {
      supportedBaseCodes: supported,
      expire: false,
      maxOrdersPerPlugin: SNAPSHOT_MAX_ORDERS_PER_PLUGIN,
      sanitizeConfig: true,
    }),
    receiptWatcherDiscoveries(env, supported),
  ]);
  return jsonResponse(
    { generated_at: timestamp(), poll_seconds: 15, accounts, discoveries },
    200,
    { 'cache-control': 'no-store' },
  );
}

async function watcherDiscoveryReport(request, env, requestId) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 256_000) return jsonResponse({ ok: false, error: '最近流水查询结果过大' }, 413);
  const transportSecrets = [
    env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY,
    env.WATCHER_PREVIOUS_TRANSPORT_SECRET,
  ].filter(Boolean).map(String);
  let signed;
  try {
    signed = await readSignedWatcherPayload(request, transportSecrets);
  } catch {
    return unauthorized();
  }
  try {
    const key = receiptDiscoveryKey(requestId);
    const job = await readPlainJsonSetting(env, key, null);
    if (!job) return jsonResponse({ ok: false, error: '最近流水查询任务不存在' }, 404);
    if (String(signed.payload.plugin_code ?? '') !== String(job.plugin_code ?? '')) {
      return jsonResponse({ ok: false, error: '最近流水查询插件不一致' }, 409);
    }
    const completedAt = timestamp();
    const status = signed.payload.status === 'complete' ? 'complete' : 'error';
    const next = {
      ...job,
      status,
      completed_at: completedAt,
      records: status === 'complete' ? sanitizeReceiptDiscoveryRecords(signed.payload.records) : [],
      error: status === 'error'
        ? String(signed.payload.error ?? 'Docker Watcher 查询失败').replace(/[\r\n]+/gu, ' ').slice(0, 300)
        : '',
    };
    await writePlainJsonSetting(env, key, next);
    return jsonResponse({ ok: true, status: next.status });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function watcherBootstrap(request, env) {
  const transportSecrets = [
    env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY,
    env.WATCHER_PREVIOUS_TRANSPORT_SECRET,
  ].filter(Boolean).map(String);
  let signed;
  for (const secret of transportSecrets) {
    try { signed = await readSignedWatcherPayload(request.clone(), secret); break; } catch { /* try previous key */ }
  }
  if (!signed) return unauthorized();
  const instanceId = String(signed.payload.instance_id ?? '');
  const publicKey = String(signed.payload.public_key ?? '');
  if (env.EDGEPAY_LICENSE) {
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encoder.encode(String(env.EDGEPAY_LICENSE))))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    if (!constantText(String(signed.payload.license_fingerprint ?? ''), expected)) {
      return jsonResponse({ error: 'watcher License 与 Worker Secret 不一致' }, 403);
    }
  }
  if (!env.EDGEPAY_LICENSE) {
    return jsonResponse({
      licensed: false,
      plugins: runtimeOf(env).registry.manifests()
        .filter((manifest) => manifest.tier === 'FREE' && manifest.mode === 'channel-notify')
        .map((manifest) => manifest.code),
    });
  }
  let grant;
  try {
    grant = await runtimeOf(env).license.grantEnvelope(env, {
      audience: 'watcher',
      instanceId,
      publicKey,
      nonce: String(signed.payload.nonce ?? ''),
      proofTimestamp: Number(signed.payload.proof_timestamp ?? 0),
      proofSignature: String(signed.payload.proof_signature ?? ''),
    });
  } catch (error) {
    // 这里原来不接错误：授权链路上的任何失败——授权服务不可达、超时、
    // 设备数超限、License 被停用——都会冒到最外层变成一个不带原因的 500。
    // watcher 那头只看得到 "HTTP 500"，完全不知道该查哪一段。
    const reason = String(error?.message ?? error);
    console.warn('watcher_bootstrap_grant_failed', { instance_id: instanceId, reason });
    return jsonResponse({ error: `watcher 授权失败：${reason}` }, Number(error?.status) || 502);
  }
  if (!grant?.envelope) {
    return jsonResponse({ error: 'watcher 授权失败：授权服务没有返回 Grant' }, 502);
  }
  // 付费插件包由 license 站直接下发；把插件包服务地址回给 watcher，避免在公开镜像里硬编码。
  return jsonResponse({
    licensed: true,
    grant: grant.envelope,
    // 包下发地址由 License 客户端提供，公开核心不硬编码授权服务地址。
    package_base_url: await runtimeOf(env).license.packageBaseUrl(env),
  });
}

/**
 * 统一告警推送的后台配置。
 *
 * token 走加密设置存储，读回时只说"配没配"，不回明文——后台页面没有任何
 * 需要看见它的理由。
 */
async function alertConfigApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  const secret = settingsEncryptionSecret(env) || String(env.EPAY_KEY ?? '');
  if (request.method === 'GET') {
    return jsonResponse({ config: publicAlertConfig(await readAlertConfig(env, secret)) });
  }
  if (request.method !== 'PUT') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    const next = mergeAlertConfig(await readAlertConfig(env, secret), body);
    await writeAlertConfig(env, secret, next);
    return jsonResponse({ ok: true, config: publicAlertConfig(next) });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

/** 后台"发一条测试"。绕开静默期，否则刚配好想验一下反而被自己的节流挡住。 */
async function alertTestApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const secret = settingsEncryptionSecret(env) || String(env.EPAY_KEY ?? '');
    const config = await readAlertConfig(env, secret);
    if (!config.enabled || !config.provider) {
      return jsonResponse({ ok: false, error: '推送尚未启用' }, 400);
    }
    const result = await deliverAlert(config, {
      event: 'test',
      level: 'info',
      title: 'EdgePay 推送测试',
      message: `这是一条测试消息，发出时间 ${timestamp()}。收到即说明推送配置可用。`,
    });
    return jsonResponse(result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 502);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

/**
 * 外部监听器上报告警。
 *
 * 复用 Watcher 那套 HMAC 签名，不另开一套凭据：能拉快照的组件本来就被信任，
 * 让它顺手报个警不需要新的信任关系。yyb-bridge 的"微信掉登录"就走这里。
 */
async function watcherAlertApi(request, env) {
  const transportSecrets = [
    env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY,
    env.WATCHER_PREVIOUS_TRANSPORT_SECRET,
  ].filter(Boolean).map(String);
  let signed;
  try {
    signed = await readSignedWatcherPayload(request, transportSecrets);
  } catch {
    return unauthorized();
  }
  const declared = String(signed.payload.event ?? '').trim();
  if (!declared) return jsonResponse({ ok: false, error: '缺少 event' }, 400);
  // 上报方带了通道号就按通道分事件。两台监听器（两个微信）掉登录时用的是同一个
  // event 名，不分开的话第二条会被第一条的静默期吞掉，人只会看到一条告警、
  // 还不知道说的是哪个账号。旧版监听器不带 channel_id，行为保持原样。
  const channelId = Number(signed.payload.channel_id ?? 0);
  const channel = Number.isSafeInteger(channelId) && channelId > 0
    ? channelById(await runtimeChannels(env), channelId)
    : null;
  const event = channel ? `${declared}:ch${channel.id}` : declared;
  // resolved=true 表示"恢复了"：清掉静默期，下次再出事能立刻提醒。
  if (signed.payload.resolved === true) {
    await clearAlert(env, event);
    return jsonResponse({ ok: true, cleared: true, event });
  }
  let label = '';
  if (channel) {
    const { registry } = runtimeOf(env);
    label = channelAlertLabel(registry, await runtimePluginConfig(env), channel);
  }
  const message = String(signed.payload.message ?? '');
  const result = await emitAlert(env, {
    event,
    level: String(signed.payload.level ?? 'warning'),
    title: String(signed.payload.title ?? 'EdgePay 告警'),
    // 通道标签放最前面：推送到手机上只看得见开头几行，得先说清是哪条通道。
    message: label ? `${label}\n${message}` : message,
  }, { secret: settingsEncryptionSecret(env) || String(env.EPAY_KEY ?? '') });
  return jsonResponse({ ok: true, event, ...result });
}

/**
 * 一条告警里怎么称呼一条通道。
 *
 * 出事时要找的是通道，不是插件编码：通道号是回调地址的一部分，通道名是管理员自己
 * 起的，配置编号是监听容器 `PLUGIN_INSTANCE` 要填的那个数字。三样凑齐才不用去猜
 * "挂的是哪个微信"。
 */
function channelAlertLabel(registry, config, channel) {
  const number = pluginConfigNumber(channel.plugin_code);
  const name = pluginDisplayName(registry, config, channel.plugin_code);
  return `#${channel.id} ${channel.name}（${name} · 配置 ${number}）`;
}

/**
 * 监听器掉线会影响哪几条通道。
 *
 * Watcher 声明的能力是基础编码，但同一个平台可能挂着好几份配置、好几条通道，
 * 它们会一起停摆。只报插件编码的话，管理员还得自己回去数哪几条通道用了它。
 */
async function channelsAffectedByPlugins(env, basePlugins) {
  const wanted = new Set(basePlugins.map((code) => basePluginCode(code)));
  if (!wanted.size) return [];
  const { registry } = runtimeOf(env);
  const [channels, config] = await Promise.all([runtimeChannels(env), runtimePluginConfig(env)]);
  return channels
    .filter((channel) => channel.enabled && wanted.has(basePluginCode(channel.plugin_code)))
    .map((channel) => channelAlertLabel(registry, config, channel));
}

/** 手机心跳绑定的是确切通道，不把同一插件的其它账号一并报成掉线。 */
async function channelsAffectedByIds(env, channelIds) {
  const wanted = new Set(channelIds.map(Number));
  if (!wanted.size) return [];
  const { registry } = runtimeOf(env);
  const [channels, config] = await Promise.all([runtimeChannels(env), runtimePluginConfig(env)]);
  return channels
    .filter((channel) => channel.enabled && wanted.has(Number(channel.id)))
    .map((channel) => channelAlertLabel(registry, config, channel));
}

/**
 * 巡检 Watcher 掉线。
 *
 * 判据是"上报过、但已经超过存活窗口没再上报"——从没上报过的实例不算掉线，
 * 否则没装 Watcher 的部署会一直收到告警。恢复上报时清掉静默期。
 */
async function checkWatcherLiveness(env, now = Date.now()) {
  const stale = await staleWatcherInstances(env, now);
  const secret = settingsEncryptionSecret(env) || String(env.EPAY_KEY ?? '');
  for (const item of stale) {
    const minutes = Math.round(item.silentMs / 60_000);
    const affected = await (item.channelIds.length
      ? channelsAffectedByIds(env, item.channelIds)
      : channelsAffectedByPlugins(env, item.plugins)).catch(() => []);
    const listenerName = {
      android: 'Android 到账监听',
      yyb_bridge: '应用宝监听器',
      docker: 'Docker Watcher',
    }[item.kind] ?? '监听器';
    await emitAlert(env, {
      event: `watcher_offline:${item.key}`,
      level: 'critical',
      title: `EdgePay ${listenerName}掉线`,
      message: `${listenerName}已 ${minutes} 分钟没有上报，这期间以下通道的到账不会被确认：\n`
        + (affected.length
          ? affected.join('\n')
          : `（暂无启用中的通道）受影响的插件：${item.plugins.join('、') || '未知'}`),
    }, { secret, now });
  }
  // 恢复销案：还在线的实例，把它上一次掉线的静默期清掉，下次再掉能立刻告警。
  const live = await liveWatcherInstances(env, now);
  for (const key of live) await clearAlert(env, `watcher_offline:${key}`).catch(() => {});
}

async function licenseAttestationApi(request, env) {
  let input;
  try { input = await readBoundedJson(request, EPAY_PAYLOAD_MAX_BYTES, '在线证明请求体'); } catch (error) {
    return jsonResponse({ error: String(error.message ?? '在线证明请求不是合法 JSON') }, Number(error.status) || 400);
  }
  try { return jsonResponse(await runtimeOf(env).license.attest(env, input)); }
  catch (error) { return jsonResponse({ error: String(error?.message ?? error) }, Number(error?.status) || 400); }
}

/** 没有自定义匹配规则的插件走这套：按金额或备注码匹配个人收款流水。 */
function defaultReceiptMatch(payments, record, eventId, now) {
  const selected = selectPersonalReceipt(payments, record);
  return {
    payment: selected.payment,
    eventAmountFen: selected.amountFen,
    metadataKey: PERSONAL_RECEIPT_KEY,
    receiptPatch: {
      record,
      trade_no: eventId,
      notified_at: now,
      notified_amount: selected.amountFen,
    },
  };
}

async function applyWatcherRecord(env, ctx, plugin, pluginConfig, record, raw) {
  const eventId = eventOrderNo(record, plugin.manifest.receiptEventLabel);
  if (await receiptEventSeen(env, plugin.manifest.code, eventId)) return { duplicate: true };
  const payments = await mutableReceiptPayments(env, plugin.manifest.code);
  const now = timestamp();
  const matched = plugin.matchReceipt
    ? await plugin.matchReceipt(callContext(env, {
      config: pluginConfig, payments, record, eventId, now,
    }))
    : defaultReceiptMatch(payments, record, eventId, now);
  const paidAt = paidAtIso(record.paid_at);
  if (!paidAt) throw new Error(`${plugin.manifest.name}流水缺少支付时间`);
  return confirmReceipt(env, ctx, plugin, matched.payment, {
    eventId,
    providerTradeNo: eventId,
    paidAt,
    eventAmountFen: matched.eventAmountFen,
    raw,
    updateMetadata(metadata) {
      const key = matched.metadataKey;
      metadata[key] = { ...(metadata[key] ?? {}), ...matched.receiptPatch };
    },
  });
}

export function receiptPollResponse(accounts, results, startedAt, finishedAt, trigger = 'external_get') {
  const summary = results.reduce((totals, result) => ({
    accounts: totals.accounts,
    active_accounts: totals.active_accounts + (Number(result.current_orders) > 0 ? 1 : 0),
    current_orders: totals.current_orders + Number(result.current_orders ?? 0),
    records_found: totals.records_found + Number(result.records ?? 0),
    confirmed_orders: totals.confirmed_orders + Number(result.confirmed ?? 0),
    duplicate_records: totals.duplicate_records + Number(result.duplicates ?? 0),
    ignored_records: totals.ignored_records + Number(result.ignored ?? 0),
    failed_records: totals.failed_records + Number(result.failed ?? 0),
    failed_accounts: totals.failed_accounts + (result.status === 'error' ? 1 : 0),
    busy_accounts: totals.busy_accounts + (result.status === 'busy' ? 1 : 0),
    docker_accounts: totals.docker_accounts + (result.status === 'docker' ? 1 : 0),
  }), {
    accounts: accounts.length,
    active_accounts: 0,
    current_orders: 0,
    records_found: 0,
    confirmed_orders: 0,
    duplicate_records: 0,
    ignored_records: 0,
    failed_records: 0,
    failed_accounts: 0,
    busy_accounts: 0,
    docker_accounts: 0,
  });
  const failed = summary.failed_accounts > 0 || summary.failed_records > 0;
  let status = 'checked';
  let message = `已检查 ${summary.active_accounts} 个监听账户、${summary.current_orders} 笔待支付订单，未发现可确认流水。`;
  if (summary.current_orders === 0) {
    status = 'idle';
    message = '当前没有待监听订单。';
  } else if (failed) {
    status = 'partial_failure';
    message = `已检查 ${summary.current_orders} 笔待支付订单；成功确认 ${summary.confirmed_orders} 笔，失败 ${summary.failed_records + summary.failed_accounts} 项。`;
  } else if (summary.confirmed_orders > 0) {
    status = 'confirmed';
    message = `已检查 ${summary.current_orders} 笔待支付订单；发现 ${summary.records_found} 条流水，成功确认 ${summary.confirmed_orders} 笔。`;
  } else if (summary.busy_accounts > 0) {
    status = 'busy';
    message = `当前有 ${summary.current_orders} 笔待支付订单；${summary.busy_accounts} 个监听账户正由另一轮任务处理。`;
  } else if (summary.docker_accounts > 0) {
    status = 'docker';
    message = `当前有 ${summary.current_orders} 笔待支付订单；${summary.docker_accounts} 个监听账户已交给在线 Docker Watcher 处理。`;
  }
  return {
    ok: !failed,
    status,
    message,
    trigger,
    started_at: startedAt,
    finished_at: finishedAt,
    summary,
    results,
  };
}

async function receiptPollTrigger(request, env, ctx) {
  let authorized = false;
  if (request.method === 'GET') {
    // 轮询 Token 可以在"密钥管理"里轮换，兼容期内旧 Token 仍然放行，
    // 这样外部计划任务来得及改地址，不至于一轮换就全部 401。
    authorized = [env.POLL_TRIGGER_TOKEN, env.POLL_PREVIOUS_TRIGGER_TOKEN]
      .filter(Boolean)
      .some((secret) => verifyStaticPollToken(request, secret));
  } else if (request.method === 'POST') {
    const transportSecrets = [
      env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY,
      env.WATCHER_PREVIOUS_TRANSPORT_SECRET,
    ].filter(Boolean).map(String);
    authorized = await verifyWatcherSnapshotRequest(request, transportSecrets);
  } else {
    return new Response('method_not_allowed', { status: 405 });
  }
  if (!authorized) return unauthorized();
  return jsonResponse(
    await runReceiptPoll(
      env,
      ctx,
      request.method === 'GET' ? 'external_get' : 'signed_post',
      true,
    ),
    200,
    { 'cache-control': 'no-store' },
  );
}

async function runReceiptPoll(env, ctx, trigger = 'scheduled', workerOnly = false, onlyPluginCode = '') {
  const startedAt = timestamp();
  const watcherPlugins = await onlineWatcherPlugins(env);
  const allAccounts = await receiptWatcherAccounts(env);
  const accounts = allAccounts.filter((account) => {
    if (workerOnly && !workerPollerAvailable(runtimeOf(env).registry, account.plugin_code, account.config)) return false;
    return !onlyPluginCode || account.plugin_code === onlyPluginCode;
  });
  const results = await Promise.all(accounts.map(async (account) => {
    const plugin = pluginOrNull(env, account.plugin_code);
    if (!plugin || !account.orders.length) {
      return {
        plugin_code: account.plugin_code,
        plugin_name: plugin?.name ?? account.plugin_code,
        status: 'idle',
        current_orders: account.orders.length,
        records: 0,
        confirmed: 0,
        duplicates: 0,
        ignored: 0,
        failed: 0,
        confirmations: [],
        errors: [],
      };
    }
    if (workerPollerAvailable(runtimeOf(env).registry, account.plugin_code, account.config)
      && watcherPlugins.has(basePluginCode(account.plugin_code))) {
      return {
        plugin_code: account.plugin_code,
        plugin_name: plugin.manifest.name,
        status: 'docker',
        current_orders: account.orders.length,
        records: 0,
        confirmed: 0,
        duplicates: 0,
        ignored: 0,
        failed: 0,
        confirmations: [],
        errors: [],
        details: { delegated: 'docker_watcher' },
      };
    }
    try {
      const polled = await pollReceiptAccount(runtimeOf(env), env, account);
      const summary = {
        plugin_code: account.plugin_code,
        plugin_name: plugin.manifest.name,
        status: polled.status,
        current_orders: account.orders.length,
        records: polled.records.length,
        confirmed: 0,
        duplicates: 0,
        ignored: 0,
        failed: 0,
        confirmations: [],
        errors: [],
        details: polled.details,
      };
      if (polled.status !== 'ok') return summary;
      const pluginConfig = account.config ?? {};
      for (const record of polled.records) {
        try {
          const applied = await applyWatcherRecord(
            env,
            ctx,
            plugin,
            pluginConfig,
            record,
            JSON.stringify({ delivery_source: 'worker_poller', source: 'worker_poller', record }),
          );
          if (applied.duplicate) {
            summary.duplicates += 1;
            summary.confirmations.push({
              event_id: String(record?.order_no ?? ''),
              status: 'duplicate',
            });
          } else {
            summary.confirmed += 1;
            summary.confirmations.push({
              event_id: String(record?.order_no ?? ''),
              payment_no: String(applied.paymentNo ?? ''),
              status: 'confirmed',
            });
          }
        } catch (error) {
          const message = String(error.message ?? error);
          const ignored = message.includes('未匹配到支付单') || message.includes('已结束');
          if (!ignored) {
            console.warn('receipt_poll_record_failed', {
              plugin: account.plugin_code,
              event: String(record?.order_no ?? '').slice(0, 64),
              message,
            });
          }
          if (ignored) summary.ignored += 1;
          else summary.failed += 1;
          summary.errors.push({
            event_id: String(record?.order_no ?? ''),
            status: ignored ? 'ignored' : 'failed',
            message: message.replace(/[\r\n]+/gu, ' ').slice(0, 200),
          });
        }
      }
      return summary;
    } catch (error) {
      const message = String(error.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 200);
      console.warn('receipt_poll_failed', { plugin: account.plugin_code, message });
      return {
        plugin_code: account.plugin_code,
        plugin_name: plugin.manifest.name,
        status: 'error',
        current_orders: account.orders.length,
        records: 0,
        confirmed: 0,
        duplicates: 0,
        ignored: 0,
        failed: 0,
        confirmations: [],
        errors: [{ status: 'failed', message }],
        error: message,
      };
    }
  }));
  return receiptPollResponse(accounts, results, startedAt, timestamp(), trigger);
}

function smsForwarderNotifyResponse(request, channel, payload, httpStatus = 200) {
  const responsePayload = {
    ...payload,
    code: httpStatus,
    channel_id: channel.id,
    plugin_code: channel.plugin_code,
    received_at: timestamp(),
  };
  if (new URL(request.url).searchParams.get('legacy') === '1' && payload.status !== 'ready') {
    return new Response(payload.ok ? '200' : '400', {
      status: payload.ok ? 200 : 400,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-edgepay-delivery-status': String(payload.status ?? ''),
      },
    });
  }
  return jsonResponse(responsePayload, httpStatus);
}

async function smsForwarderChannelNotify(request, env, ctx, channel, plugin, pluginConfig) {
  if (isSmsForwarderProbeRequest(request)) {
    const configured = Boolean(String(pluginConfig.sms_forwarder_secret ?? '').trim());
    return smsForwarderNotifyResponse(request, channel, {
      ok: configured,
      accepted: false,
      confirmed: false,
      status: configured ? 'ready' : 'not_configured',
      message: configured
        ? `${plugin.manifest.name}通知入口可用；此 GET 仅用于探活，不代表某次通知已经投送。`
        : '通知入口存在，但尚未配置 SmsForwarder 密钥。',
      delivery_statuses: {
        confirmed: '通知投送成功且订单已确认',
        duplicate: '通知已在此前成功处理',
        unmatched: '通知已通过验签，但没有匹配到待支付订单',
      },
      legacy_mode: `${new URL(request.url).origin}${new URL(request.url).pathname}?legacy=1`,
    }, configured ? 200 : 503);
  }
  if (!['GET', 'POST'].includes(request.method)) {
    return smsForwarderNotifyResponse(request, channel, {
      ok: false,
      accepted: false,
      confirmed: false,
      status: 'method_not_allowed',
      message: '通知入口只接受 GET 查询参数或 POST 表单/JSON。',
    }, 405);
  }

  let eventId = '';
  try {
    const input = await readEpayPayload(request);
    const platform = plugin.manifest.payTypes.includes('alipay') ? 'alipay' : 'wechat';
    const signal = await parseSmsForwarder(input, pluginConfig, Date.now() / 1_000, platform, {
      method: request.method,
      path: new URL(request.url).pathname,
    });
    // 监听端的连通性探测心跳：已验签、无金额，直接回成功，别当成一次真实到账去匹配订单。
    // legacy=1 时回纯文本 "200"，兼容以正文判断成败的监听工具（mpay 等）。
    if (signal.probe) {
      const watcherKind = String(signal.content?.watcher_kind ?? '').trim();
      const watcherInstance = String(signal.content?.watcher_instance ?? '').trim();
      if (watcherKind === 'android' && /^[A-Za-z0-9._-]{8,40}$/u.test(watcherInstance)) {
        const capabilities = [plugin.manifest.code];
        await recordWatcherPresence(
          env,
          await presenceKey(`android-${channel.id}-${watcherInstance}`, capabilities),
          capabilities,
          Date.now(),
          { polling: false, kind: 'android', channelIds: [channel.id] },
        );
      }
      if (new URL(request.url).searchParams.get('legacy') === '1') {
        return new Response('200', {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-edgepay-delivery-status': 'ready',
          },
        });
      }
      return smsForwarderNotifyResponse(request, channel, {
        ok: true,
        accepted: true,
        confirmed: false,
        status: 'ready',
        message: `${plugin.manifest.name}通知入口可用；此消息是监听工具的连通性探测，不代表某次收款已到账。`,
      }, 200);
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${input.from ?? ''}|${input.timestamp ?? ''}|${input.content ?? ''}`),
    );
    eventId = `SF${digestHex(digest).slice(0, 30)}`;
    const existing = await receiptEventRecord(env, plugin.manifest.code, eventId);
    if (existing) {
      const confirmed = existing.state === 'PROCESSED' && Boolean(existing.payment_no);
      return smsForwarderNotifyResponse(request, channel, {
        ok: true,
        accepted: true,
        confirmed,
        status: confirmed ? 'duplicate' : 'processing',
        message: confirmed
          ? '通知投送成功；该通知此前已经完成订单确认。'
          : '通知已接收，当前处理状态尚未完成。',
        event_id: eventId,
        payment_no: String(existing.payment_no ?? ''),
      }, confirmed ? 200 : 202);
    }
    const record = {
      order_no: eventId,
      price: fenToMoney(signal.amountFen),
      paid_at: signal.paidAt,
      remark: signal.remarkCode,
    };
    const selected = selectPersonalReceipt(await mutableReceiptPayments(env, plugin.manifest.code), record);
    const confirmed = await confirmReceipt(env, ctx, plugin, selected.payment, {
      eventId,
      providerTradeNo: eventId,
      paidAt: new Date(signal.paidAt * 1_000).toISOString(),
      eventAmountFen: signal.amountFen,
      raw: JSON.stringify(input),
      updateMetadata(metadata) {
        const receipt = metadata[PERSONAL_RECEIPT_KEY] ?? {};
        receipt.trade_no = eventId;
        receipt.notified_at = timestamp();
        receipt.notified_amount = signal.amountFen;
        receipt.sms_forwarder_payload = input;
        metadata[PERSONAL_RECEIPT_KEY] = receipt;
      },
    });
    if (confirmed.duplicate) {
      return smsForwarderNotifyResponse(request, channel, {
        ok: true,
        accepted: true,
        confirmed: true,
        status: 'duplicate',
        message: '通知投送成功；该通知此前已经完成订单确认。',
        event_id: eventId,
        payment_no: selected.payment.payment_no,
      });
    }
    return smsForwarderNotifyResponse(request, channel, {
      ok: true,
      accepted: true,
      confirmed: true,
      status: 'confirmed',
      message: '通知投送成功，订单已经确认。',
      event_id: eventId,
      payment_no: confirmed.paymentNo,
    });
  } catch (error) {
    const failure = classifySmsForwarderDeliveryError(error);
    console.warn('sms_forwarder_notify_failed', {
      channelId: channel.id,
      eventId,
      status: failure.status,
      message: String(error.message ?? error),
    });
    return smsForwarderNotifyResponse(request, channel, {
      ok: failure.ok,
      accepted: failure.accepted,
      confirmed: failure.confirmed,
      status: failure.status,
      message: failure.message,
      ...(eventId ? { event_id: eventId } : {}),
    }, failure.httpStatus);
  }
}

async function channelNotify(request, env, ctx, channelId) {
  const channel = channelById(await runtimeChannels(env), channelId);
  const plugin = channel ? pluginOrNull(env, channel.plugin_code) : null;
  if (!channel || !plugin) return new Response('fail', { status: 404 });
  if (!licenseCovers(await licensedCodes(env), plugin.manifest.code)) return new Response('fail', { status: 403 });
  const config = await runtimePluginConfig(env);
  const pluginConfig = configForPlugin(config, plugin.manifest.code);
  if (plugin.manifest.receiptSource === 'sms_forwarder') {
    return smsForwarderChannelNotify(request, env, ctx, channel, plugin, pluginConfig);
  }
  try {
    // 渠道直连插件的 webhook 也落在这个入口。
    if (plugin.manifest.mode === 'direct') {
      await authorized(env, plugin, 'handleCallback');
      if (!plugin.handleCallback) throw unsupportedHook(plugin, 'handleCallback');
      const result = await plugin.handleCallback(callContext(env, { config: pluginConfig, request }));
      await applyProviderResult(env, ctx, plugin, result);
      return new Response('success');
    }
    await authorized(env, plugin, 'channelNotify');
    const transportSecrets = [
      pluginConfig.watcher_password,
      env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY,
      env.WATCHER_PREVIOUS_TRANSPORT_SECRET,
    ].filter(Boolean).map(String);
    const { payload, raw } = await readSignedWatcherPayload(request, transportSecrets);
    if (payload.plugin_code && String(payload.plugin_code) !== plugin.manifest.code) throw new Error('监听器插件编码不匹配');
    if (Number(payload.api_config_id ?? channel.id) !== channel.id) throw new Error('监听器配置 ID 不匹配');
    for (const record of watcherRecords(payload)) {
      await applyWatcherRecord(env, ctx, plugin, pluginConfig, record, raw);
    }
    return new Response('success');
  } catch (error) {
    console.warn('channel_notify_failed', { channelId, message: String(error.message ?? error) });
    return new Response('fail', { status: Number(error.status) || 400 });
  }
}

async function paymentCallback(request, env, ctx, paymentNo) {
  const payment = await env.DB.prepare('SELECT * FROM payment_attempts WHERE payment_no = ?').bind(paymentNo).first();
  if (!payment) return new Response('fail', { status: 404 });
  const plugin = pluginOrNull(env, payment.plugin_code);
  if (!plugin) return new Response('fail', { status: 404 });
  let snapshot = { source: 'provider_webhook', method: request.method, content_type: '', request: {} };
  try {
    snapshot = await providerCallbackSnapshot(request, plugin);
    const config = configForPlugin(await runtimePluginConfig(env), plugin.manifest.code);
    await authorized(env, plugin, 'handleCallback');
    // GET 是渠道同步回跳，POST 是异步通知。插件没单独实现回跳就统一交给 handleCallback。
    const handler = (request.method === 'GET' && plugin.handleReturn) || plugin.handleCallback;
    if (typeof handler !== 'function') throw unsupportedHook(plugin, 'handleCallback');
    const result = await handler(callContext(env, { config, request }));
    if (result.payNo && result.payNo !== paymentNo) throw new Error(`${plugin.manifest.name}回调订单号不匹配`);
    result.payNo = paymentNo;
    await applyProviderResult(env, ctx, plugin, result);
    if (plugin.callbackResponse) return plugin.callbackResponse({ ok: true });
    if (request.method === 'GET') {
      return Response.redirect(
        new URL(`/payment/${encodeURIComponent(paymentNo)}`, request.url),
        302,
      );
    }
    return new Response('success');
  } catch (error) {
    await recordProviderCallbackFailure(env, payment, plugin, snapshot, error);
    console.warn('payment_callback_failed', { paymentNo, message: String(error.message ?? error) });
    if (Number(error.status) === 413) return new Response('payload_too_large', { status: 413 });
    return plugin.callbackResponse
      ? plugin.callbackResponse({ ok: false })
      : new Response('fail', { status: 400 });
  }
}

async function wechatOauthCallback(request, env) {
  let paymentNo = '';
  try {
    const url = new URL(request.url);
    paymentNo = await verifyWechatOauthState(env, url.searchParams.get('resume'));
    const code = String(url.searchParams.get('code') ?? '').trim();
    if (!code) throw new Error(String(url.searchParams.get('error_description') ?? '微信网页授权未返回 code'));
    const payment = await env.DB.prepare(
      'SELECT * FROM payment_attempts WHERE payment_no = ?',
    ).bind(paymentNo).first();
    if (!payment || payment.plugin_code !== 'wechat_api') throw new Error('微信支付订单不存在');
    if (payment.status === 'PAID') {
      return Response.redirect(new URL(`/payment/${encodeURIComponent(paymentNo)}`, request.url), 302);
    }
    if (['EXPIRED', 'CLOSED'].includes(payment.status) || Date.parse(payment.expires_at) <= Date.now()) {
      throw new Error('微信支付订单已过期');
    }

    const config = configForPlugin(await runtimePluginConfig(env), 'wechat_api');
    const identity = await exchangeWechatOAuthCode(config, code);
    const metadata = parseJson(payment.metadata_json);
    const fields = {
      ...(metadata.checkout_fields ?? {}),
      type: String(metadata.epay_type ?? 'wxpay'),
      outTradeNo: payment.external_order_no,
      notifyUrl: payment.notify_url,
      returnUrl: String(metadata.return_url ?? ''),
      name: String(metadata.name ?? '支付订单'),
      amountFen: Number(payment.expected_amount_fen),
      param: String(metadata.param ?? ''),
      buyer: String(metadata.buyer ?? ''),
      device: 'wechat',
      clientIp: String(metadata.checkout_fields?.clientIp ?? ''),
      openid: identity.openid,
      wechatProduct: 'mp',
    };
    const plugin = pluginOf(env, 'wechat_api');
    const presentation = await createDirectPresentation(
      request,
      env,
      plugin,
      config,
      fields,
      paymentNo,
      payment.expires_at,
    );
    const updatedMetadata = {
      ...metadata,
      device: 'wechat',
      checkout_fields: fields,
      presentation,
      provider_order_no: String(presentation.chan_order_no ?? ''),
      provider_trade_no: String(presentation.chan_trade_no ?? ''),
      oauth_completed_at: timestamp(),
    };
    delete updatedMetadata.provider_error;
    await env.DB.prepare(`
      UPDATE payment_attempts
      SET status = 'PAYING', provider_trade_no = ?, metadata_json = ?, updated_at = ?
      WHERE payment_no = ? AND status <> 'PAID'
    `).bind(
      String(updatedMetadata.provider_trade_no || updatedMetadata.provider_order_no || ''),
      JSON.stringify(updatedMetadata),
      timestamp(),
      paymentNo,
    ).run();
    return Response.redirect(new URL(`/payment/${encodeURIComponent(paymentNo)}`, request.url), 302);
  } catch (error) {
    if (paymentNo) {
      const payment = await env.DB.prepare(
        'SELECT metadata_json FROM payment_attempts WHERE payment_no = ?',
      ).bind(paymentNo).first();
      if (payment) {
        const metadata = parseJson(payment.metadata_json);
        metadata.provider_error = String(error.message ?? error).slice(0, 500);
        await env.DB.prepare(`
          UPDATE payment_attempts SET status = 'FAILED', metadata_json = ?, updated_at = ?
          WHERE payment_no = ? AND status <> 'PAID'
        `).bind(JSON.stringify(metadata), timestamp(), paymentNo).run();
      }
    }
    return new Response(`微信网页授权失败：${String(error.message ?? error)}`, {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

function cashierApiResponse(data, status = 200) {
  return jsonResponse({ code: status === 200 ? 200 : status, msg: status === 200 ? 'success' : String(data), data: status === 200 ? data : null }, status);
}

function cashierStatus(status) {
  return {
    PENDING: [0, '待创建'],
    PAYING: [1, '支付中'],
    PAID: [2, '支付成功'],
    FAILED: [3, '支付失败'],
    CLOSED: [4, '已关闭'],
    EXPIRED: [5, '已超时'],
  }[String(status)] ?? [0, '待创建'];
}

function cashierPublicConfig(siteConfig) {
  return {
    site_name: `${siteConfig.merchant_name} 支付中台`,
    title: `${siteConfig.merchant_name} 收银台`,
    logo: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
    notice_enabled: true,
    notice: '确认支付方式后，系统会创建本次支付尝试并跳转支付页。',
    show_merchant_name: true,
    show_order_no: true,
    show_pay_type_desc: false,
    poll_interval_seconds: 2,
    poll_timeout_seconds: 300,
    customer_service_enabled: false,
    cashier_footer_html: siteConfig.cashier_footer_html,
  };
}

export function contactPublicConfig(siteConfig) {
  return {
    enabled: Boolean(siteConfig.contact_enabled),
    title: siteConfig.contact_title,
    qr_label: siteConfig.contact_qr_label,
    avatar_image: siteConfig.contact_avatar_image || '/contact/default-avatar.png',
    qrcode_image: siteConfig.contact_qrcode_image,
  };
}

function minimumAmountFen(config) {
  const value = String(config?.min_pay_amount_yuan ?? '').trim();
  const match = value.match(/^(\d+)(?:\.(\d{1,2}))?$/u);
  if (!match) return 0;
  return (Number(match[1]) * 100) + Number(String(match[2] ?? '').padEnd(2, '0'));
}

function cashierTypeName(code) {
  return {
    alipay: '支付宝',
    wxpay: '微信支付',
    usdt: 'USDT',
    paypal: 'PayPal',
    bank: '银行卡',
  }[String(code)] ?? String(code);
}

async function availableCashierMethods(env, amountFen, requestedPayType = '') {
  const normalizedType = String(requestedPayType ?? '').trim().toLowerCase();
  const channels = (await runtimeChannels(env)).filter((channel) => {
    return channel.enabled
      && channel.weight > 0
      && (!normalizedType || channel.pay_types.includes(normalizedType));
  });
  const pluginConfig = await runtimePluginConfig(env);
  const methods = [];
  const seen = new Set();
  for (const channel of channels) {
    const config = configForPlugin(pluginConfig, channel.plugin_code);
    const plugin = pluginOrNull(env, channel.plugin_code);
    if (
      !plugin
      || !pluginEnabled(runtimeOf(env).registry, pluginConfig, channel.plugin_code)
      || missingPluginFields(runtimeOf(env).registry, pluginConfig, channel.plugin_code).length
    ) continue;
    if (minimumAmountFen(config) > amountFen) continue;
    if (channel.pay_types.includes('bank')) {
      methods.push({
        pay_type_id: channel.id,
        code: `bank_ch_${channel.id}`,
        name: channel.name,
        icon: '',
        selected_channel_id: channel.id,
        selected_channel_name: channel.name,
        selected_channel_mode: 1,
      });
      continue;
    }
    const payType = channel.pay_types.find((type) => type !== 'bank');
    if (!payType || seen.has(payType)) continue;
    seen.add(payType);
    methods.push({
      pay_type_id: methods.length + 1,
      code: payType,
      name: cashierTypeName(payType),
      icon: '',
    });
  }
  return methods;
}

function activeCashierPayment(payment, metadata) {
  if (payment.plugin_code === 'cashier' || payment.status === 'PENDING') return null;
  return {
    pay_no: payment.payment_no,
    pay_type_code: String(metadata.epay_type ?? payment.plugin_code),
    pay_type_name: cashierTypeName(metadata.epay_type),
    pay_type_icon: '',
    pay_amount: Number(payment.expected_amount_fen),
    pay_amount_text: fenToMoney(payment.expected_amount_fen),
    status: cashierStatus(payment.status)[0],
    created_at: payment.created_at,
    request_at: payment.created_at,
    updated_at: payment.updated_at,
    expire_at: payment.expires_at,
    return_url: String(metadata.return_url ?? ''),
    payment_page_path: `/payment/${encodeURIComponent(payment.payment_no)}`,
    payment_page_url: '',
  };
}

function publicPresentation(presentation, serverTime = 0) {
  const payParams = { ...(presentation?.pay_params ?? {}) };
  delete payParams.raw;
  if (serverTime) payParams.server_time_timestamp = serverTime;
  return { ...(presentation ?? {}), pay_params: payParams };
}

async function cashierContextApi(request, env) {
  try {
    await expireDuePayments(env);
    const bizNo = String(new URL(request.url).searchParams.get('biz_no') ?? '').trim();
    if (!bizNo) throw new Error('biz_no 不能为空');
    const payment = await env.DB.prepare(
      'SELECT * FROM payment_attempts WHERE external_order_no = ?',
    ).bind(bizNo).first();
    if (!payment) return cashierApiResponse('业务单不存在', 404);
    const siteConfig = await runtimeSiteConfig(env);
    const metadata = parseJson(payment.metadata_json);
    const status = cashierStatus(payment.status);
    const canPay = payment.status !== 'PAID'
      && payment.status !== 'CLOSED'
      && new Date(payment.expires_at).getTime() > Date.now();
    return cashierApiResponse({
      biz_order: {
        biz_no: payment.external_order_no,
        trace_no: payment.payment_no,
        merchant_order_no: payment.external_order_no,
        subject: String(metadata.name ?? '支付订单'),
        body: String(metadata.name ?? ''),
        notify_url: payment.notify_url,
        return_url: String(metadata.return_url ?? ''),
        client_ip: String(metadata.checkout_fields?.clientIp ?? ''),
        device: String(metadata.device ?? ''),
        order_amount: Number(payment.expected_amount_fen),
        order_amount_text: fenToMoney(payment.expected_amount_fen),
        paid_amount: payment.status === 'PAID' ? Number(payment.expected_amount_fen) : 0,
        refund_amount: 0,
        status: status[0],
        status_text: status[1],
        active_pay_no: payment.plugin_code === 'cashier' ? '' : payment.payment_no,
        attempt_count: Number(metadata.cashier_attempt_count ?? (payment.plugin_code === 'cashier' ? 0 : 1)),
        ext_json: {},
        created_at: payment.created_at,
        updated_at: payment.updated_at,
        expire_at: payment.expires_at,
      },
      merchant: {
        merchant_id: 1,
        merchant_no: String(env.EPAY_PID),
        merchant_name: siteConfig.merchant_name,
        merchant_short_name: siteConfig.merchant_name,
        status: 1,
        pay_status: 1,
        settle_status: 1,
        settle_type: 4,
      },
      active_pay_order: activeCashierPayment(payment, metadata),
      available_pay_types: canPay
        ? await availableCashierMethods(
          env,
          Number(payment.expected_amount_fen),
          metadata.epay_type,
        )
        : [],
      can_pay: canPay,
      public_config: cashierPublicConfig(siteConfig),
    });
  } catch (error) {
    return cashierApiResponse(String(error.message ?? error), Number(error.status) || 400);
  }
}

async function selectedCashierChannel(env, typeCode) {
  const channels = await routableChannels(env);
  const match = String(typeCode).match(/^bank_ch_(\d+)$/u);
  if (!match) {
    const channel = resolveChannel(runtimeOf(env).registry, channels, typeCode);
    return { channel, payType: channel.pay_types[0] };
  }
  const channel = channelById(channels, match[1]);
  if (
    !channel
    || !channel.enabled
    || channel.weight <= 0
    || !channel.pay_types.includes('bank')
  ) {
    throw new Error('银行卡通道不可用');
  }
  return { channel, payType: 'bank' };
}

async function cashierConfirmApi(request, env) {
  try {
    await expireDuePayments(env);
    const input = await readBoundedJson(request, EPAY_PAYLOAD_MAX_BYTES, '收银台确认请求体');
    const bizNo = String(input?.biz_no ?? '').trim();
    const typeCode = String(input?.type ?? '').trim();
    if (!bizNo || !typeCode) throw new Error('biz_no 和 type 不能为空');
    const existing = await env.DB.prepare(
      'SELECT * FROM payment_attempts WHERE external_order_no = ?',
    ).bind(bizNo).first();
    if (!existing) return cashierApiResponse('业务单不存在', 404);
    if (['PAID', 'EXPIRED', 'CLOSED'].includes(existing.status) || Date.parse(existing.expires_at) <= Date.now()) {
      throw new Error(existing.status === 'PAID' ? '订单已经支付成功' : '订单已超时，不能继续支付');
    }
    const currentMetadata = parseJson(existing.metadata_json);
    const fields = {
      ...(currentMetadata.checkout_fields ?? {}),
      type: '',
      outTradeNo: existing.external_order_no,
      notifyUrl: existing.notify_url,
      returnUrl: String(currentMetadata.return_url ?? ''),
      name: String(currentMetadata.name ?? '支付订单'),
      amountFen: Number(existing.expected_amount_fen),
      param: String(currentMetadata.param ?? ''),
      buyer: String(currentMetadata.buyer ?? ''),
      device: String(currentMetadata.device ?? ''),
      clientIp: String(currentMetadata.checkout_fields?.clientIp ?? ''),
    };
    const selected = await selectedCashierChannel(env, typeCode);
    fields.type = selected.payType;
    const attempt = await activateCashierAttempt(
      request,
      env,
      fields,
      selected.channel,
      existing,
      { cashier_attempt_count: Number(currentMetadata.cashier_attempt_count ?? 0) + 1 },
    );
    const presentation = publicPresentation(attempt.metadata.presentation);
    return cashierApiResponse({
      biz_no: existing.external_order_no,
      trade_no: attempt.payment.payment_no,
      pay_type: String(presentation.pay_page ?? 'qrcode'),
      pay_info: presentation.pay_params,
      payment_result: presentation,
      payment_page_path: `/payment/${encodeURIComponent(attempt.payment.payment_no)}`,
      payment_page_url: new URL(
        `/payment/${encodeURIComponent(attempt.payment.payment_no)}`,
        request.url,
      ).toString(),
    });
  } catch (error) {
    return cashierApiResponse(String(error.message ?? error), Number(error.status) || 400);
  }
}

async function signedMerchantReturnUrl(payment, metadata, env) {
  if (!metadata.return_url) return '';
  const payload = {
    pid: String(env.EPAY_PID),
    trade_no: payment.payment_no,
    out_trade_no: payment.external_order_no,
    type: metadata.epay_type ?? payment.plugin_code,
    name: metadata.name ?? '',
    money: fenToMoney(payment.expected_amount_fen),
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'MD5',
  };
  if (metadata.param) payload.param = metadata.param;
  if (metadata.buyer) payload.buyer = metadata.buyer;
  payload.sign = await signEpayV1(payload, env.EPAY_KEY);
  return appendQuery(metadata.return_url, payload);
}

async function cashierPayOrderApi(request, env) {
  try {
    await expireDuePayments(env);
    const payNo = String(new URL(request.url).searchParams.get('pay_no') ?? '').trim();
    const payment = await env.DB.prepare(
      'SELECT * FROM payment_attempts WHERE payment_no = ?',
    ).bind(payNo).first();
    if (!payment || payment.plugin_code === 'cashier') return cashierApiResponse('支付单不存在', 404);
    const siteConfig = await runtimeSiteConfig(env);
    const metadata = parseJson(payment.metadata_json);
    const presentation = publicPresentation(
      metadata.presentation,
      Math.floor(Date.now() / 1_000),
    );
    const status = cashierStatus(payment.status);
    return cashierApiResponse({
      order: {
        pay_no: payment.payment_no,
        biz_no: payment.external_order_no,
        subject: String(metadata.name ?? '支付订单'),
        amount: Number(payment.expected_amount_fen),
        currency: 'CNY',
        status: status[0],
        status_text: status[1],
        created_at: payment.created_at,
        expire_at: payment.expires_at,
        updated_at: payment.updated_at,
        return_url: await signedMerchantReturnUrl(payment, metadata, env),
      },
      merchant: {
        merchant_id: 1,
        merchant_no: String(env.EPAY_PID),
        merchant_name: siteConfig.merchant_name,
        merchant_short_name: siteConfig.merchant_name,
      },
      payment_type: {
        id: Number(metadata.channel_id ?? 0),
        code: String(metadata.epay_type ?? payment.plugin_code),
        name: cashierTypeName(metadata.epay_type),
        icon: '',
      },
      presentation,
      cashier_path: `/cashier/${encodeURIComponent(payment.external_order_no)}`,
      payment_path: `/payment/${encodeURIComponent(payment.payment_no)}`,
      public_config: cashierPublicConfig(siteConfig),
    });
  } catch (error) {
    return cashierApiResponse(String(error.message ?? error), 400);
  }
}

async function cashierPayOrderStatusApi(request, env) {
  try {
    await expireDuePayments(env);
    const payNo = String(new URL(request.url).searchParams.get('pay_no') ?? '').trim();
    const payment = await env.DB.prepare(
      'SELECT * FROM payment_attempts WHERE payment_no = ?',
    ).bind(payNo).first();
    if (!payment) return cashierApiResponse('支付单不存在', 404);
    const status = cashierStatus(payment.status);
    return cashierApiResponse({
      pay_no: payment.payment_no,
      status: status[0],
      status_text: status[1],
      paid_at: payment.paid_at ?? '',
      closed_at: payment.status === 'CLOSED' ? payment.updated_at : '',
      failed_at: payment.status === 'FAILED' ? payment.updated_at : '',
      timeout_at: payment.status === 'EXPIRED' ? payment.updated_at : '',
      updated_at: payment.updated_at,
    });
  } catch (error) {
    return cashierApiResponse(String(error.message ?? error), 400);
  }
}

function legacyPaymentPage(request, paymentNo) {
  return Response.redirect(
    new URL(`/payment/${encodeURIComponent(paymentNo)}`, request.url),
    302,
  );
}

async function listOrders(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  await expireDuePayments(env);
  const search = Object.fromEntries(new URL(request.url).searchParams.entries());
  const result = await listAdminOrders(env, search);
  return jsonResponse({
    ...result,
    plugins: runtimeOf(env).registry.manifests().map(({ code, name }) => ({ code, name })),
  });
}

async function orderDetailsApi(request, env, paymentNo) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (!['GET', 'DELETE'].includes(request.method)) return new Response('method_not_allowed', { status: 405 });
  try {
    if (request.method === 'DELETE') {
      assertAdminMutationRequest(request);
      const existing = await env.DB.prepare(
        'SELECT payment_no FROM payment_attempts WHERE payment_no = ?',
      ).bind(paymentNo).first();
      if (!existing) return jsonResponse({ ok: false, error: '订单不存在' }, 404);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM notification_tasks WHERE payment_no = ?').bind(paymentNo),
        env.DB.prepare('DELETE FROM refund_orders WHERE payment_no = ?').bind(paymentNo),
        env.DB.prepare('DELETE FROM order_operation_logs WHERE payment_no = ?').bind(paymentNo),
        env.DB.prepare('DELETE FROM order_controls WHERE payment_no = ?').bind(paymentNo),
        env.DB.prepare('DELETE FROM receipt_events WHERE payment_no = ?').bind(paymentNo),
        env.DB.prepare('DELETE FROM payment_attempts WHERE payment_no = ?').bind(paymentNo),
      ]);
      return jsonResponse({ ok: true, message: '订单及关联记录已删除', payment_no: paymentNo });
    }
    await expireDuePayments(env);
    return jsonResponse(await adminOrderDetails(env, paymentNo));
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, request.method === 'GET' ? 404 : 400);
  }
}

async function orderActionApi(request, env, ctx, paymentNo, actionCode) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  try {
    await expireDuePayments(env);
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    return jsonResponse(await performAdminOrderAction(
      env,
      ctx,
      paymentNo,
      actionCode,
      body,
      await runtimePluginConfig(env),
    ));
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

function assertAdminMutationRequest(request) {
  const origin = String(request.headers.get('origin') ?? '');
  if (origin && origin !== new URL(request.url).origin) throw new Error('管理请求来源不合法');
  if (!String(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new Error('管理写入必须使用 JSON');
  }
}

async function adminJsonBody(request) {
  let body;
  try { body = await readBoundedJson(request, 1_000_000, '管理配置请求体'); } catch (error) {
    if (Number(error.status) === 413) throw Object.assign(new Error('管理配置内容过大'), { status: 413 });
    throw new Error('管理配置 JSON 格式不合法');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('管理配置格式不合法');
  return body;
}

function normalizedAdminField(field, value) {
  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field.label}必须是数字`);
    if (field.min !== undefined && number < field.min) throw new Error(`${field.label}不能小于 ${field.min}`);
    if (field.max !== undefined && number > field.max) throw new Error(`${field.label}不能大于 ${field.max}`);
    return number;
  }
  if (field.type === 'multiselect') {
    const allowed = new Set((field.options ?? []).map(([option]) => option));
    if (!Array.isArray(value)) throw new Error(`${field.label}格式不合法`);
    return [...new Set(value.map(String).filter((option) => allowed.has(option)))];
  }
  const textValue = String(value ?? '').trim();
  if (field.type === 'image') {
    if (!textValue) return '';
    if (textValue.length > 600_000) throw new Error(`${field.label}压缩后仍然过大`);
    if (
      !/^\/[A-Za-z0-9._/-]+$/u.test(textValue)
      && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(textValue)
    ) {
      throw new Error(`${field.label}必须是站内图片路径或 PNG、JPEG、WebP 图片`);
    }
  }
  if (field.type === 'select') {
    const allowed = new Set((field.options ?? []).map(([option]) => option));
    if (!allowed.has(textValue)) throw new Error(`${field.label}选项不支持`);
  }
  return textValue;
}

function catalogPluginRow(item, licensed = false) {
  const code = String(item?.code ?? '').trim();
  const name = String(item?.name ?? code).trim();
  const catalogRuntime = String(item?.runtime ?? '').trim();
  const runtime = catalogRuntime === 'both' ? 'hybrid' : (catalogRuntime === 'watcher' ? 'docker' : catalogRuntime);
  return {
    code,
    name,
    version: String(item?.version ?? item?.current_version ?? ''),
    tier: String(item?.tier ?? 'PAID').trim() || 'PAID',
    mode: '',
    runtime,
    payTypes: [],
    required: [],
    note: '购买并升级当前 Worker 后开放配置。',
    docs: '',
    configured: false,
    enabled: false,
    missingFields: [],
    licensed,
    installed: false,
  };
}

async function pluginConfigPayload(env) {
  const runtime = runtimeOf(env);
  const { registry } = runtime;
  const [config, license] = await Promise.all([
    runtimePluginConfig(env), runtime.license.state(env, registry),
  ]);
  const licensed = new Set(license.plugins);
  // 已购但没装进这次构建的插件：按权益出货后，新买的插件要去 Deploy 站升级一次才会进包。
  const pendingInstall = license.plugins
    .filter((code) => !registry.has(code))
    .map((code) => ({ code, name: license.pluginNames?.[code] ?? code }));
  const results = publicPluginList(registry, config)
    .map((plugin) => ({ ...plugin, licensed: licenseCovers(licensed, plugin.code), installed: true }));
  const resultCodes = new Set(results.map((plugin) => plugin.code));
  for (const item of Array.isArray(license.catalog) ? license.catalog : []) {
    const code = String(item?.code ?? '').trim();
    if (!code || resultCodes.has(code) || licensed.has(code)) continue;
    results.push(catalogPluginRow(item, false));
    resultCodes.add(code);
  }
  return {
    results,
    forms: adminPluginForms(registry, config)
      .filter((form) => licenseCovers(licensed, form.code))
      .map((form) => ({ ...form, licensed: true })),
    storage: 'D1 AES-GCM / CONFIG_ENCRYPTION_KEY',
    license,
    pending_install: pendingInstall,
    upgrade_url: license.upgradeUrl ?? '',
  };
}

async function cachedPluginConfigPayload(env) {
  const runtime = runtimeOf(env);
  const now = Date.now();
  const cached = pluginListCache.get(runtime);
  if (cached?.expiresAt > now) {
    return { payload: await cached.promise, cacheStatus: 'HIT' };
  }

  const entry = {
    expiresAt: now + PLUGIN_LIST_CACHE_MILLISECONDS,
    promise: pluginConfigPayload(env),
  };
  pluginListCache.set(runtime, entry);
  try {
    const payload = await entry.promise;
    // 授权服务故障的降级结果只短暂缓存，避免恢复后仍长时间显示“未购买”。
    const ttl = payload.license?.retryable
      ? PLUGIN_LIST_FAILURE_CACHE_MILLISECONDS
      : PLUGIN_LIST_CACHE_MILLISECONDS;
    if (pluginListCache.get(runtime) === entry) entry.expiresAt = Date.now() + ttl;
    return { payload, cacheStatus: 'MISS' };
  } catch (error) {
    if (pluginListCache.get(runtime) === entry) pluginListCache.delete(runtime);
    throw error;
  }
}

function invalidatePluginListCache(env) {
  pluginListCache.delete(runtimeOf(env));
}

function assertInstanceName(value) {
  const name = String(value ?? '').trim();
  if (name.length > 40) throw new Error('插件副本名称不能超过 40 个字');
  return name;
}

/**
 * 复制一份插件配置给副本用。
 *
 * 密钥和收款码永远不复制：副本的意义就是换一个账号收款，把原账号的投递密钥或
 * 收款二维码带过去，轻则两个通道抢同一笔到账，重则钱进了不该进的那个账号。
 * 剩下的字段（轮询间隔、图鉴之类）复制过去能省几次填写。
 */
function copyableInstanceConfig(plugin, sourceConfig) {
  const copied = {};
  for (const field of plugin.manifest.adminFields) {
    if (field.secret || field.type === 'image') continue;
    if (!(field.key in sourceConfig)) continue;
    copied[field.key] = sourceConfig[field.key];
  }
  return copied;
}

/** 复制插件：给同一个平台再开一个账号位，可以顺带建好它自己的通道。 */
async function duplicatePluginApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    const { registry } = runtimeOf(env);
    const sourceCode = String(body.plugin_code ?? '').trim();
    const source = registry.get(sourceCode);
    if (!source) throw new Error('插件不存在');
    const baseCode = basePluginCode(source.manifest.code);
    if (!licenseCovers(await licensedCodes(env), baseCode)) {
      return jsonResponse({ ok: false, error: '该插件尚未购买，请先前往 License 站购买' }, 403);
    }
    const config = await runtimePluginConfig(env);
    const instanceCode = pluginInstanceCode(
      baseCode,
      nextInstanceSequence(baseCode, pluginCodesWithInstances(registry, config)),
    );
    const instance = registry.require(instanceCode);
    const instanceConfig = body.copy_config === true
      ? copyableInstanceConfig(instance, configForPlugin(config, sourceCode))
      : {};
    instanceConfig[INSTANCE_NAME_KEY] = assertInstanceName(body.name) || instance.manifest.name;
    // 副本一定缺配置（至少缺密钥），先停用；配置齐了再由管理员打开。
    instanceConfig.enabled = false;
    config[instanceCode] = instanceConfig;
    await writeEncryptedJsonSetting(env, 'plugin_config', settingsEncryptionSecret(env), config);
    invalidatePluginListCache(env);

    let channel = null;
    if (body.channel && typeof body.channel === 'object') {
      channel = await appendPluginInstanceChannel(env, instance, body.channel, instanceConfig);
    }
    return jsonResponse({
      ok: true,
      plugin_code: instanceCode,
      message: channel
        ? `已复制为「${instanceConfig[INSTANCE_NAME_KEY]}」，并新建通道 #${channel.id}；补齐配置后启用即可收款。`
        : `已复制为「${instanceConfig[INSTANCE_NAME_KEY]}」；补齐配置后启用即可收款。`,
      channel,
      form: adminPluginForms(registry, config).find((form) => form.code === instanceCode),
      plugin: publicPluginList(registry, config).find((item) => item.code === instanceCode),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

/**
 * 给刚建好的副本追加一条自己的通道。
 *
 * 通道是分流的单位：两个账号各一条通道、各自权重，收款就按权重在两个账号之间走。
 * 所以复制插件时顺手把通道建出来，省得再去通道页手动配一遍。
 */
async function appendPluginInstanceChannel(env, instance, input, instanceConfig) {
  const { registry } = runtimeOf(env);
  const existing = await runtimeChannels(env);
  const payType = String(input.pay_type ?? '').trim().toLowerCase();
  if (!instance.manifest.payTypes.includes(payType)) {
    throw new Error(`${instance.manifest.name}不支持支付方式：${payType || '（空）'}`);
  }
  const created = {
    id: Math.max(0, ...existing.map((channel) => Number(channel.id) || 0)) + 1,
    name: String(input.name ?? '').trim()
      || `${instanceConfig[INSTANCE_NAME_KEY]} · ${payType}`,
    plugin_code: instance.manifest.code,
    pay_types: [payType],
    weight: input.weight === undefined || input.weight === '' ? 100 : Number(input.weight),
    // 插件还没配好就先别接单；通道页可以随时打开。
    enabled: false,
    sort: Math.max(-1, ...existing.map((channel) => Number(channel.sort) || 0)) + 1,
    ...(input.order_expire_minutes === undefined || String(input.order_expire_minutes).trim() === ''
      ? {}
      : { order_expire_minutes: Number(input.order_expire_minutes) }),
  };
  const normalized = parseChannels(registry, [...existing, created]);
  await writePlainJsonSetting(env, 'channels', normalized);
  return normalized.find((channel) => channel.id === created.id) ?? null;
}

/** 删除插件副本。基础插件删不掉——它是构建的一部分，不是配置。 */
async function deletePluginInstanceApi(request, env, pluginCode) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'DELETE') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    if (body.confirm !== true) throw new Error('删除插件副本需要明确确认');
    if (!isPluginInstanceCode(pluginCode)) throw new Error('只能删除插件副本');
    const { registry } = runtimeOf(env);
    const config = await runtimePluginConfig(env);
    if (!(pluginCode in config)) return jsonResponse({ ok: false, error: '插件副本不存在' }, 404);
    const name = pluginDisplayName(registry, config, pluginCode);
    // 通道离了插件就是条死路由，跟着一起删；历史订单照旧保留。
    const channels = await runtimeChannels(env);
    const removedChannels = channels.filter((channel) => channel.plugin_code === pluginCode);
    if (removedChannels.length) {
      await writePlainJsonSetting(
        env,
        'channels',
        channels.filter((channel) => channel.plugin_code !== pluginCode),
      );
    }
    delete config[pluginCode];
    await writeEncryptedJsonSetting(env, 'plugin_config', settingsEncryptionSecret(env), config);
    invalidatePluginListCache(env);
    return jsonResponse({
      ok: true,
      message: removedChannels.length
        ? `已删除「${name}」及其 ${removedChannels.length} 条通道，历史订单仍保留`
        : `已删除「${name}」`,
      removed_channels: removedChannels.map((channel) => channel.id),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function pluginConfigApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method === 'GET') {
    const { payload, cacheStatus } = await cachedPluginConfigPayload(env);
    const response = jsonResponse(payload);
    response.headers.set('x-edgepay-cache', cacheStatus);
    return response;
  }
  if (request.method !== 'PUT') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    const { registry } = runtimeOf(env);
    const plugin = registry.get(String(body.plugin_code ?? ''));
    if (!plugin) throw new Error('插件不存在');
    if (!licenseCovers(await licensedCodes(env), plugin.manifest.code)) {
      return jsonResponse({ ok: false, error: '该插件尚未购买，请先前往 License 站购买' }, 403);
    }
    const values = body.values;
    const hasValues = values && typeof values === 'object' && !Array.isArray(values);
    const hasEnabled = typeof body.enabled === 'boolean';
    const hasInstanceName = typeof body.instance_name === 'string';
    if (!hasValues && !hasEnabled && !hasInstanceName) throw new Error('没有可保存的插件配置');
    const config = await runtimePluginConfig(env);
    // 副本的存在性由配置说了算。编码是能猜出来的，不该靠猜就凭空多出一个账号位。
    if (isPluginInstanceCode(plugin.manifest.code) && !(plugin.manifest.code in config)) {
      throw new Error('插件副本不存在，请先在插件列表里复制一个');
    }
    const current = { ...configForPlugin(config, plugin.manifest.code) };
    if (hasInstanceName) {
      if (!isPluginInstanceCode(plugin.manifest.code)) throw new Error('只有插件副本可以改名');
      current[INSTANCE_NAME_KEY] = assertInstanceName(body.instance_name);
    }
    if (hasValues) {
      for (const field of plugin.manifest.adminFields) {
        if (!(field.key in values)) continue;
        const raw = values[field.key];
        if (field.secret && String(raw ?? '').trim() === '') continue;
        current[field.key] = normalizedAdminField(field, raw);
      }
    }
    config[plugin.manifest.code] = current;
    const missingFields = missingPluginFields(registry, config, plugin.manifest.code);
    if (hasEnabled && body.enabled && missingFields.length) {
      throw new Error(`请先补齐插件配置：${missingFields.join('、')}`);
    }
    if (hasEnabled) current.enabled = body.enabled;
    if (current.enabled === true && missingFields.length) {
      throw new Error(`已启用插件不能缺少配置：${missingFields.join('、')}`);
    }
    await writeEncryptedJsonSetting(env, 'plugin_config', settingsEncryptionSecret(env), config);
    invalidatePluginListCache(env);
    return jsonResponse({
      ok: true,
      form: adminPluginForms(registry, config).find((form) => form.code === plugin.manifest.code),
      plugin: publicPluginList(registry, config).find((item) => item.code === plugin.manifest.code),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

function publicReceiptDiscovery(job) {
  const expired = !['complete', 'error'].includes(String(job.status))
    && Date.parse(String(job.expires_at ?? '')) <= Date.now();
  return {
    request_id: String(job.request_id ?? ''),
    plugin_code: String(job.plugin_code ?? ''),
    status: expired ? 'expired' : String(job.status ?? 'pending'),
    execution: String(job.execution ?? 'docker'),
    requested_at: String(job.requested_at ?? ''),
    completed_at: String(job.completed_at ?? ''),
    records: Array.isArray(job.records) ? job.records : [],
    error: expired ? '最近流水查询超时，请确认 Docker Watcher 在线后重试' : String(job.error ?? ''),
  };
}

async function pluginReceiptDiscoveryApi(request, env, pluginCode) {
  if (!await isAdminSession(request, env)) return unauthorized();
  try {
    const runtime = runtimeOf(env);
    const plugin = runtime.registry.get(pluginCode);
    if (!plugin || !receiptDiscoveryAvailable(plugin.manifest)) throw new Error('该插件不需要查询收款终端信息');
    if (!licenseCovers(await licensedCodes(env), pluginCode)) {
      return jsonResponse({ ok: false, error: '该插件尚未购买' }, 403);
    }
    if (request.method === 'GET') {
      const requestId = new URL(request.url).searchParams.get('request_id');
      const job = await readPlainJsonSetting(env, receiptDiscoveryKey(requestId), null);
      if (!job || job.plugin_code !== pluginCode) return jsonResponse({ ok: false, error: '最近流水查询任务不存在' }, 404);
      return jsonResponse({ ok: true, ...publicReceiptDiscovery(job) });
    }
    if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
    assertAdminMutationRequest(request);
    await adminJsonBody(request);
    const config = configForPlugin(await runtimePluginConfig(env), pluginCode);
    const account = receiptDiscoveryAccount(pluginCode, config);
    if (pluginSupportsWorkerPoll(plugin, config)) {
      const result = await pollReceiptAccount(runtime, env, account);
      if (result.status === 'busy') throw new Error('该插件正在执行流水查询，请稍后重试');
      return jsonResponse({
        ok: true,
        request_id: '',
        plugin_code: pluginCode,
        status: 'complete',
        execution: 'worker',
        records: sanitizeReceiptDiscoveryRecords(result.records),
      });
    }
    if (!(await onlineWatcherPlugins(env)).has(basePluginCode(pluginCode))) {
      throw new Error('该插件需要 Docker Watcher 查询；请先启动并确认 Watcher 已在线');
    }
    const requestId = crypto.randomUUID();
    const requestedAt = timestamp();
    const job = {
      request_id: requestId,
      plugin_code: pluginCode,
      status: 'pending',
      execution: 'docker',
      requested_at: requestedAt,
      expires_at: new Date(Date.now() + (2 * 60 * 1_000)).toISOString(),
      records: [],
      error: '',
    };
    await writePlainJsonSetting(env, receiptDiscoveryKey(requestId), job);
    return jsonResponse({ ok: true, ...publicReceiptDiscovery(job) }, 202);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function licenseStatusApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'GET') return new Response('method_not_allowed', { status: 405 });
  const runtime = runtimeOf(env);
  return jsonResponse(await runtime.license.state(env, runtime.registry));
}

async function siteConfigApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  const publicBaseUrl = String(env.PUBLIC_BASE_URL ?? new URL(request.url).origin);
  const contactUrl = new URL('/contact', publicBaseUrl).toString();
  const pollTriggerUrl = String(env.POLL_TRIGGER_TOKEN ?? '')
    ? (() => {
        const url = new URL('/internal/receipt-poll', publicBaseUrl);
        url.searchParams.set('token', String(env.POLL_TRIGGER_TOKEN));
        return url.toString();
      })()
    : '';
  if (request.method === 'GET') {
    return jsonResponse({
      config: await runtimeSiteConfig(env),
      contact_url: contactUrl,
      poll_trigger_url: pollTriggerUrl,
    });
  }
  if (request.method !== 'PUT') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    const config = normalizeSiteConfig(body);
    await writePlainJsonSetting(env, 'site_config', config);
    return jsonResponse({ ok: true, config, contact_url: contactUrl, poll_trigger_url: pollTriggerUrl });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function contactConfigApi(env) {
  const siteConfig = await runtimeSiteConfig(env);
  return jsonResponse({ config: contactPublicConfig(siteConfig) });
}

async function keyManagementApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method === 'GET') return jsonResponse({ keys: await publicKeyStatus(env) });
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    const code = String(body.key ?? '');
    if (body.action === 'rotate') {
      const result = await rotateRuntimeKey(env, code);
      return jsonResponse({ ok: true, result, keys: await publicKeyStatus(env) });
    }
    if (body.action === 'revoke_previous') {
      await revokePreviousRuntimeKey(env, code);
      return jsonResponse({ ok: true, keys: await publicKeyStatus(env) });
    }
    throw new Error('不支持的密钥操作');
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function systemStatusApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'GET') return new Response('method_not_allowed', { status: 405 });
  const checkedAt = Date.now();
  return jsonResponse({
    checked_at: new Date(checkedAt).toISOString(),
    listeners: await watcherSystemStatus(env, checkedAt),
  });
}

async function clearSystemStatusApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const cleared = await clearWatcherPresence(env);
    const checkedAt = Date.now();
    return jsonResponse({
      ok: true,
      cleared,
      checked_at: new Date(checkedAt).toISOString(),
      listeners: await watcherSystemStatus(env, checkedAt),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function adminChannelData(env, channels = null) {
  const [resolvedChannels, config, licensed, listenerPresence] = await Promise.all([
    channels ? Promise.resolve(channels) : runtimeChannels(env),
    runtimePluginConfig(env),
    licensedCodes(env),
    watcherChannelPresence(env),
  ]);
  return {
    results: resolvedChannels.filter((channel) => licenseCovers(licensed, channel.plugin_code)).map((channel) => {
      const plugin = pluginOrNull(env, channel.plugin_code);
      return {
        ...channel,
        available_pay_types: [...(plugin?.manifest.payTypes ?? [])],
        // 通道页要一眼看得出这条路由挂在哪个账号上，光有编码不够。
        plugin_name: pluginDisplayName(runtimeOf(env).registry, config, channel.plugin_code),
        plugin_enabled: pluginEnabled(runtimeOf(env).registry, config, channel.plugin_code),
        ...(plugin?.manifest.receiptSource === 'sms_forwarder'
          ? { listener_presence: listenerPresence.get(Number(channel.id)) ?? { status: 'unknown', last_seen_at: '' } }
          : {}),
      };
    }),
    // 副本也要出现在这份列表里：新增通道时得能挑到"微信个人收款监听 2"。
    plugins: pluginCodesWithInstances(runtimeOf(env).registry, config)
      .filter((code) => licenseCovers(licensed, code))
      .map((code) => {
        const { manifest } = runtimeOf(env).registry.get(code);
        return {
          code,
          name: pluginDisplayName(runtimeOf(env).registry, config, code),
          base_code: manifest.baseCode ?? code,
          instance_sequence: manifest.instanceSequence ?? 1,
          pay_types: [...manifest.payTypes],
          enabled: pluginEnabled(runtimeOf(env).registry, config, code),
        };
      }),
  };
}

async function channelsApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method === 'GET') return jsonResponse(await adminChannelData(env));
  if (request.method !== 'PUT') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    if (!Array.isArray(body.channels)) throw new Error('通道配置必须是数组');
    const normalized = parseChannels(runtimeOf(env).registry, body.channels);
    // 副本编码是能猜出来的，但没建过的副本没有配置，指过去只会得到一条永远收不了款的通道。
    const config = await runtimePluginConfig(env);
    const missingInstance = normalized.find((channel) => (
      isPluginInstanceCode(channel.plugin_code) && !(channel.plugin_code in config)
    ));
    if (missingInstance) {
      throw new Error(`通道 #${missingInstance.id} 指向的插件副本不存在，请先在插件列表里复制一个`);
    }
    const licensed = await licensedCodes(env);
    const unlicensed = normalized.find((channel) => !licenseCovers(licensed, channel.plugin_code));
    if (unlicensed) {
      const name = pluginOrNull(env, unlicensed.plugin_code)?.manifest.name ?? unlicensed.plugin_code;
      return jsonResponse({ ok: false, error: `${name}尚未购买` }, 403);
    }
    await writePlainJsonSetting(env, 'channels', normalized);
    return jsonResponse({ ok: true, ...await adminChannelData(env, normalized) });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function deleteChannelApi(request, env, channelId) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'DELETE') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const body = await adminJsonBody(request);
    if (body.confirm !== true) throw new Error('删除通道需要明确确认');
    const channels = await runtimeChannels(env);
    const target = channelById(channels, channelId);
    if (!target) return jsonResponse({ ok: false, error: '支付通道不存在' }, 404);
    const remaining = channels.filter((channel) => Number(channel.id) !== Number(target.id));
    await writePlainJsonSetting(env, 'channels', remaining);
    return jsonResponse({
      ok: true,
      message: `支付通道 #${target.id} 已删除，历史订单仍保留`,
      ...await adminChannelData(env, remaining),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

async function channelTestRecordsApi(request, env, channelId) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'GET') return new Response('method_not_allowed', { status: 405 });
  await expireDuePayments(env);
  const channel = channelById(await runtimeChannels(env), channelId);
  if (!channel) return jsonResponse({ ok: false, error: '支付通道不存在' }, 404);
  if (!licenseCovers(await licensedCodes(env), channel.plugin_code)) {
    return jsonResponse({ ok: false, error: '该通道插件尚未购买' }, 403);
  }
  const limit = Math.min(20, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 8)));
  const { results } = await env.DB.prepare(`
    SELECT * FROM payment_attempts
    WHERE json_extract(metadata_json, '$.is_test_order') = 1
      AND json_extract(metadata_json, '$.channel_id') = ?
      AND plugin_code = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(Number(channel.id), channel.plugin_code, limit).all();
  return jsonResponse({
    channel,
    devices: CHANNEL_TEST_DEVICES,
    wechat_products: CHANNEL_TEST_WECHAT_PRODUCTS,
    alipay_products: CHANNEL_TEST_ALIPAY_PRODUCTS,
    results: results.map(channelTestRecord),
  });
}

async function channelTestApi(request, env, channelId) {
  if (!await isAdminSession(request, env)) return unauthorized();
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  try {
    assertAdminMutationRequest(request);
    const channel = channelById(await runtimeChannels(env), channelId);
    if (!channel) throw new Error('支付通道不存在');
    if (!licenseCovers(await licensedCodes(env), channel.plugin_code)) {
      return jsonResponse({ ok: false, error: '该通道插件尚未购买' }, 403);
    }
    const body = await adminJsonBody(request);
    const fields = channelTestFields(body, channel, {
      clientIp: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? '',
      userAgent: request.headers.get('user-agent') ?? '',
    });
    const attempt = await createPaymentAttempt(request, env, fields, channel, {
      is_test_order: true,
      source: 'admin_channel_test',
    });
    const paymentPagePath = `/payment/${encodeURIComponent(attempt.payment.payment_no)}`;
    return jsonResponse({
      ok: true,
      message: '测试订单已创建',
      payment_no: attempt.payment.payment_no,
      external_order_no: attempt.payment.external_order_no,
      money: fenToMoney(attempt.payment.expected_amount_fen),
      payment_page_path: paymentPagePath,
      payment_page_url: new URL(paymentPagePath, request.url).toString(),
      status: attempt.payment.status,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message ?? error) }, errorHttpStatus(error));
  }
}

function adminLoginRedirect(request, result = null) {
  const url = new URL('/admin/login', request.url);
  if (result?.locked) url.searchParams.set('locked', String(result.retryAfterSeconds ?? 600));
  else if (result) {
    url.searchParams.set('error', '1');
    url.searchParams.set('remaining', String(result.remainingAttempts ?? 0));
  }
  return Response.redirect(url, 303);
}

function adminRedirectWithCookie(target, cookie) {
  return new Response(null, { status: 303, headers: { location: target.toString(), 'set-cookie': cookie } });
}

export function isCashierShellPath(pathname) {
  return pathname === '/cashier'
    || pathname === '/cashier/'
    || /^\/cashier\/[^/.]+$/u.test(pathname)
    || /^\/payment\/(?:p_[a-z0-9]+|entry\/error)$/u.test(pathname);
}

async function adminLogin(request, env) {
  if (request.method === 'GET') {
    if (await isAdminSession(request, env)) return Response.redirect(new URL('/admin/site', request.url), 303);
    return fetchBundledAsset(new Request(new URL('/admin-login.html', request.url), request));
  }
  if (request.method !== 'POST') return adminLoginRedirect(request);
  let result;
  try {
    result = await verifyAdminLogin(request, env);
  } catch (error) {
    if (Number(error.status) === 413) return new Response('payload_too_large', { status: 413 });
    throw error;
  }
  if (!result.ok) {
    // 失败的登录必须同时作废已有会话，否则跳回 /admin/login 时那个 GET 会看到
    // 旧 cookie 仍然有效，直接把人送进 /admin/site——看起来就像"随便填也能进"。
    const redirect = adminLoginRedirect(request, result);
    const response = new Response(redirect.body, redirect);
    response.headers.append('set-cookie', clearAdminSession());
    return response;
  }
  return adminRedirectWithCookie(new URL('/admin/site', request.url), await createAdminSession(env));
}

async function adminDashboard(request, env) {
  const asset = await fetchBundledAsset(new Request(new URL('/dashboard.html', request.url), request));
  return new Response(asset.body, {
    status: asset.status,
    // Asset 响应带有由平台管理的 Content-Length / Encoding 等头；将它们和流再次组合会触发
    // Worker 运行时异常。管理页只需明确自身的 HTML 类型和不缓存策略。
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const RELEASE_CHECK_KEY = 'release_check';
const RELEASE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 带缓存的最新版本查询。
 *
 * 原来每打开一次后台都要现查一遍 GitHub（失败再退到部署站），两次外网请求串行，
 * 插件页要一直等着它转。发行版本一天也变不了几次，没必要每次都问。
 *
 * 查不到就继续用上一次的结果：一次网络抖动不该把升级提示弄没。
 */
async function cachedLatestRelease(env) {
  const cached = await readPlainJsonSetting(env, RELEASE_CHECK_KEY, null);
  const version = String(cached?.version ?? '');
  const checkedAt = Date.parse(String(cached?.checked_at ?? ''));
  if (version && Number.isFinite(checkedAt) && Date.now() - checkedAt < RELEASE_CHECK_TTL_MS) {
    return { version, checked_at: cached.checked_at, fresh: false };
  }
  try {
    const latest = await fetchLatestRelease();
    const checked = new Date().toISOString();
    await writePlainJsonSetting(env, RELEASE_CHECK_KEY, { version: latest.version, checked_at: checked });
    return { version: latest.version, checked_at: checked, fresh: true };
  } catch (error) {
    if (version) return { version, checked_at: cached.checked_at, fresh: false };
    throw error;
  }
}

async function adminVersionApi(request, env) {
  if (!await isAdminSession(request, env)) return unauthorized();
  try {
    const latest = await cachedLatestRelease(env);
    const deployUrl = new URL('https://deploy.imsuk.cn/');
    deployUrl.searchParams.set('mode', 'upgrade');
    deployUrl.searchParams.set('publicBaseUrl', new URL(request.url).origin);
    if (String(env.EDGEPAY_PROJECT_NAME ?? '').trim()) {
      deployUrl.searchParams.set('project', String(env.EDGEPAY_PROJECT_NAME).trim());
    }
    return jsonResponse({
      ok: true,
      current_version: CURRENT_RELEASE_VERSION,
      latest_version: latest.version,
      update_available: compareReleaseVersions(latest.version, CURRENT_RELEASE_VERSION) > 0,
      deploy_url: deployUrl.toString(),
    });
  } catch {
    return jsonResponse({ ok: false, current_version: CURRENT_RELEASE_VERSION, update_available: false });
  }
}

async function adminLogout(request, env) {
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  return adminRedirectWithCookie(new URL('/admin/login', request.url), clearAdminSession());
}

async function route(request, env, ctx) {
  const url = new URL(request.url); const { pathname } = url;
  if (pathname === '/health') return jsonResponse({ ok: true, service: 'payment-service', protocol: 'epay-v1', time: timestamp() });
  if ((pathname === '/submit' || pathname === '/submit.php')) return epaySubmit(request, env);
  if ((pathname === '/mapi' || pathname === '/mapi.php') && request.method === 'POST') return epayMapi(request, env);
  if (pathname === '/api/wechat/oauth/callback' && request.method === 'GET') {
    return wechatOauthCallback(request, env);
  }
  if (pathname === '/api/cashier/context' && request.method === 'GET') return cashierContextApi(request, env);
  if (pathname === '/api/cashier/confirm' && request.method === 'POST') return cashierConfirmApi(request, env);
  if (pathname === '/api/cashier/pay-order' && request.method === 'GET') return cashierPayOrderApi(request, env);
  if (pathname === '/api/cashier/pay-order-status' && request.method === 'GET') {
    return cashierPayOrderStatusApi(request, env);
  }
  if (pathname === '/api/contact' && request.method === 'GET') return contactConfigApi(env);
  if (pathname === '/api/license/attest' && request.method === 'POST') return licenseAttestationApi(request, env);
  if (pathname === '/api/watcher/snapshot' && request.method === 'GET') return watcherSnapshot(request, env);
  const watcherDiscoveryMatch = pathname.match(
    /^\/api\/watcher\/discoveries\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu,
  );
  if (watcherDiscoveryMatch && request.method === 'POST') {
    return watcherDiscoveryReport(request, env, watcherDiscoveryMatch[1]);
  }
  if (pathname === '/api/watcher/bootstrap' && request.method === 'POST') return watcherBootstrap(request, env);
  if (pathname === '/api/watcher/alert' && request.method === 'POST') return watcherAlertApi(request, env);
  if (pathname === '/internal/receipt-poll') return receiptPollTrigger(request, env, ctx);
  if (pathname === '/api/pay/' || pathname === '/api/pay') return new Response('not_found', { status: 404 });
  if ((pathname === '/api' || pathname === '/api.php')) return epayApi(request, env);
  const channelMatch = pathname.match(/^\/api\/pay\/(\d+)\/notify$/u);
  if (channelMatch) return channelNotify(request, env, ctx, channelMatch[1]);
  const callbackMatch = pathname.match(/^\/api\/pay\/(p_[a-z0-9]+)\/callback$/u);
  if (callbackMatch) return paymentCallback(request, env, ctx, callbackMatch[1]);
  const payMatch = pathname.match(/^\/pay\/(p_[a-z0-9]+)$/u);
  if (payMatch && request.method === 'GET') return legacyPaymentPage(request, payMatch[1]);
  if (
    request.method === 'GET'
    && isCashierShellPath(pathname)
  ) {
    return fetchBundledAsset(new Request(new URL('/cashier/index.html', request.url), request));
  }
  if ((pathname === '/contact' || pathname === '/contact/') && ['GET', 'HEAD'].includes(request.method)) {
    return fetchBundledAsset(new Request(new URL('/contact/index.html', request.url), request));
  }
  if (pathname === '/admin/login') return adminLogin(request, env);
  if (pathname === '/admin/captcha' && request.method === 'GET') return adminCaptchaResponse(env);
  if (pathname === '/admin/logout') return adminLogout(request, env);
  if (pathname === '/dashboard.html' || pathname === '/admin-login.html') {
    return new Response('not_found', { status: 404 });
  }
  if (pathname === '/admin/api/orders' && request.method === 'GET') return listOrders(request, env);
  const adminOrderMatch = pathname.match(/^\/admin\/api\/orders\/([A-Za-z0-9_-]+)$/u);
  if (adminOrderMatch) return orderDetailsApi(request, env, adminOrderMatch[1]);
  const adminOrderActionMatch = pathname.match(/^\/admin\/api\/orders\/([A-Za-z0-9_-]+)\/([a-z_]+)$/u);
  if (adminOrderActionMatch) {
    return orderActionApi(request, env, ctx, adminOrderActionMatch[1], adminOrderActionMatch[2]);
  }
  const adminPluginDiscoveryMatch = pathname.match(/^\/admin\/api\/plugins\/([a-z][a-z0-9_~]*)\/recent-receipts$/u);
  if (adminPluginDiscoveryMatch && ['GET', 'POST'].includes(request.method)) {
    return pluginReceiptDiscoveryApi(request, env, adminPluginDiscoveryMatch[1]);
  }
  if (pathname === '/admin/api/plugins' && ['GET', 'PUT'].includes(request.method)) return pluginConfigApi(request, env);
  if (pathname === '/admin/api/plugins/duplicate' && request.method === 'POST') {
    return duplicatePluginApi(request, env);
  }
  const adminPluginInstanceMatch = pathname.match(/^\/admin\/api\/plugins\/([a-z][a-z0-9_]*~[0-9]{1,2})$/u);
  if (adminPluginInstanceMatch && request.method === 'DELETE') {
    return deletePluginInstanceApi(request, env, adminPluginInstanceMatch[1]);
  }
  if (pathname === '/admin/api/license' && request.method === 'GET') return licenseStatusApi(request, env);
  if (pathname === '/admin/api/version' && request.method === 'GET') return adminVersionApi(request, env);
  if (pathname === '/admin/api/site' && ['GET', 'PUT'].includes(request.method)) return siteConfigApi(request, env);
  if (pathname === '/admin/api/alerts' && ['GET', 'PUT'].includes(request.method)) return alertConfigApi(request, env);
  if (pathname === '/admin/api/alerts/test' && request.method === 'POST') return alertTestApi(request, env);
  if (pathname === '/admin/api/keys' && ['GET', 'POST'].includes(request.method)) return keyManagementApi(request, env);
  if (pathname === '/admin/api/system-status' && request.method === 'GET') return systemStatusApi(request, env);
  if (pathname === '/admin/api/system-status/clear' && request.method === 'POST') return clearSystemStatusApi(request, env);
  if (pathname === '/admin/api/channels' && ['GET', 'PUT'].includes(request.method)) return channelsApi(request, env);
  const adminChannelDeleteMatch = pathname.match(/^\/admin\/api\/channels\/(\d+)$/u);
  if (adminChannelDeleteMatch && request.method === 'DELETE') {
    return deleteChannelApi(request, env, adminChannelDeleteMatch[1]);
  }
  const adminChannelTestRecordsMatch = pathname.match(/^\/admin\/api\/channels\/(\d+)\/test-records$/u);
  if (adminChannelTestRecordsMatch) return channelTestRecordsApi(request, env, adminChannelTestRecordsMatch[1]);
  const adminChannelTestMatch = pathname.match(/^\/admin\/api\/channels\/(\d+)\/test$/u);
  if (adminChannelTestMatch) return channelTestApi(request, env, adminChannelTestMatch[1]);
  if (pathname === '/admin' || pathname === '/admin/') {
    if (!await isAdminSession(request, env)) return adminLoginRedirect(request);
    return Response.redirect(new URL('/admin/site', request.url), 303);
  }
  if (/^\/admin\/(?:status|site|plugins|channels|alerts|orders|keys|docs)$/u.test(pathname)) {
    if (!await isAdminSession(request, env)) return adminLoginRedirect(request);
    return adminDashboard(request, env);
  }
  if (pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
    return fetchBundledAsset(new Request(new URL('/index.html', request.url), request));
  }
  return fetchBundledAsset(request);
}

/**
 * 由 createPaymentWorker 调用，产出 Cloudflare Worker 的 fetch/scheduled。
 * 公开仓库本身不导出 `export default`，所以单靠这里的源码构建不出可部署的 Worker。
 */
/**
 * 这一轮 cron 有没有活要干。
 *
 * cron 每分钟都会被触发，但绝大多数时候一单都没有。原来不管有没有事都要：
 * 解密 security_keys、读 channels 和 plugin_config、查授权状态、扫两遍
 * payment_attempts（expireDuePayments 被直接调一次、receiptWatcherAccounts
 * 里又调一次）——空跑一次七八个 D1 操作，一天 1440 次全是白烧。
 *
 * 这里用一次计数查询把三类活一次问清楚：待支付订单、还在宽限期内的 USDT
 * 订单（它过期后仍要再等一会儿链上确认）、到点该重投的通知。三个都是 0
 * 就直接返回。判断条件必须和 receiptWatcherAccounts / dispatchDueNotifications
 * 各自的取数条件保持一致，宁可多算一次也不能漏掉活。
 */
/**
 * 这一轮 cron 有没有事要做。
 *
 * 掉线检测也并在这条查询里。原来它跟在 hasScheduledWork 的闸门后面，于是"没有
 * 待支付订单"就直接返回，巡检根本不会跑——而越是没单的时候，越需要知道监听器
 * 已经掉了。并进来之后，空跑仍然只有这一次查询。
 */
async function scheduledWork(env, registry, now = Date.now()) {
  const maxGrace = Math.max(0, ...registry.manifests().map((manifest) => manifest.receiptGraceSeconds));
  const graceCutoff = new Date(now - (maxGrace * 1_000)).toISOString();
  const offlineBefore = new Date(now - PRESENCE_TTL_MS).toISOString();
  const forgetBefore = new Date(now - PRESENCE_SWEEP_MS).toISOString();
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM payment_attempts WHERE status IN ('PENDING', 'PAYING')) AS open_payments,
      (SELECT COUNT(*) FROM payment_attempts
        WHERE plugin_code = 'usdt_trc20_receipt' AND status = 'EXPIRED' AND expires_at > ?) AS grace_payments,
      (SELECT COUNT(*) FROM notification_tasks
        WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= ?) AS due_notifications,
      (SELECT COUNT(*) FROM runtime_settings
        WHERE (setting_key = 'watcher_presence' OR setting_key LIKE ?)
          AND updated_at < ? AND updated_at > ?) AS silent_watchers
  `).bind(graceCutoff, timestamp(), `${PRESENCE_PREFIX}%`, offlineBefore, forgetBefore).first();
  return {
    hasPaymentWork: Number(row?.open_payments ?? 0)
      + Number(row?.grace_payments ?? 0)
      + Number(row?.due_notifications ?? 0) > 0,
    hasSilentWatcher: Number(row?.silent_watchers ?? 0) > 0,
  };
}

export function createHandlers(runtime) {
  const prepare = async (env) => withRuntime(await withRuntimeKeys(env), runtime);
  return {
    async fetch(request, env, ctx) {
      try { return await route(request, await prepare(env), ctx); }
      catch (error) {
        console.error('request_failed', { path: new URL(request.url).pathname, message: String(error.message ?? error) });
        return jsonResponse({ error: 'internal_error' }, 500);
      }
    },
    async scheduled(_controller, env, ctx) {
      ctx.waitUntil((async () => {
        // 先花一次计数查询问清楚有没有活；都没有就到此为止，
        // 后面那一整套（密钥解密、通道与插件配置、授权状态、两遍订单扫描）全省掉。
        const work = await scheduledWork(env, runtime.registry);
        if (!work.hasPaymentWork && !work.hasSilentWatcher) return;
        const runtimeEnv = await prepare(env);
        // 掉线巡检不该拖垮这一轮的正事，失败只记日志。
        if (work.hasSilentWatcher) {
          await checkWatcherLiveness(runtimeEnv).catch((error) => {
            console.warn('watcher_liveness_check_failed', { message: String(error?.message ?? error) });
          });
        }
        if (!work.hasPaymentWork) return;
        await Promise.all([expireDuePayments(runtimeEnv), dispatchDueNotifications(runtimeEnv)]);
        await runReceiptPoll(runtimeEnv, ctx, 'scheduled', true);
      })());
    },
  };
}
