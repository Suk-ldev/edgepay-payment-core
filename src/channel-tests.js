import {
  fenToMoney, isHttpsUrl, moneyToFen, requireText,
} from './epay-v1.js';

export const CHANNEL_TEST_DEVICES = Object.freeze([
  ['auto', '自动识别'],
  ['pc', '电脑'],
  ['mobile', '手机浏览器'],
  ['wechat', '微信内'],
  ['alipay', '支付宝内'],
  ['qq', 'QQ 内'],
]);

export const CHANNEL_TEST_WECHAT_PRODUCTS = Object.freeze([
  ['auto', '按支付环境自动选择'],
  ['scan', 'Native 支付'],
  ['mp', 'JSAPI 支付'],
  ['h5', 'H5 支付'],
  ['app', 'APP 支付'],
  ['mini', '小程序支付'],
]);

export const CHANNEL_TEST_ALIPAY_PRODUCTS = Object.freeze([
  ['auto', '按支付环境自动选择'],
  ['scan', '订单码支付'],
  ['pos', '当面付（付款码）'],
  ['mini', '小程序 JSAPI 支付'],
  ['app', 'APP 支付'],
  ['h5', '手机网站支付'],
  ['web', '电脑网站支付'],
]);

function optionalIdentity(value, label) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > 128) throw new Error(`${label}长度不能超过 128 个字符`);
  return normalized;
}

function optionalUrl(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > 255) throw new Error(`${fieldName}长度不能超过 255 个字符`);
  if (normalized && !isHttpsUrl(normalized)) {
    throw new Error(`${fieldName}必须是非本地 HTTPS 地址，或留空`);
  }
  return normalized;
}

export function inferChannelTestDevice(value, userAgent = '') {
  const requested = String(value ?? 'auto').trim().toLowerCase() || 'auto';
  const allowed = new Set(CHANNEL_TEST_DEVICES.map(([device]) => device));
  if (!allowed.has(requested)) throw new Error('测试支付环境不支持');
  if (requested !== 'auto') return requested;

  const agent = String(userAgent ?? '').toLowerCase();
  if (agent.includes('alipayclient')) return 'alipay';
  if (agent.includes('micromessenger')) return 'wechat';
  if (agent.includes(' qq/') || agent.includes('mqqbrowser')) return 'qq';
  if (/mobile|android|iphone|ipad|ipod|windows phone/iu.test(agent)) return 'mobile';
  return 'pc';
}

export function channelTestFields(input, channel, {
  clientIp = '',
  userAgent = '',
  now = new Date(),
  randomSuffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8),
} = {}) {
  if (!channel?.enabled) throw new Error('请先启用该通道再测试');
  const payType = String(input?.pay_type ?? channel.pay_types?.[0] ?? '').trim().toLowerCase();
  if (!channel.pay_types?.includes(payType)) throw new Error('所选支付方式不属于当前通道');

  const compactTime = now.toISOString().replace(/\D/gu, '').slice(0, 14);
  const outTradeNo = `CHTEST${channel.id}${compactTime}${String(randomSuffix).replace(/\W/gu, '').slice(0, 12)}`;
  const requestedWechatProduct = channel.plugin_code === 'wechat_api'
    ? String(input?.wechat_product ?? 'auto').trim().toLowerCase() || 'auto'
    : 'auto';
  if (!CHANNEL_TEST_WECHAT_PRODUCTS.some(([product]) => product === requestedWechatProduct)) {
    throw new Error('微信测试产品不支持');
  }
  const requestedAlipayProduct = channel.plugin_code === 'alipay_api'
    ? String(input?.alipay_product ?? 'auto').trim().toLowerCase() || 'auto'
    : 'auto';
  if (!CHANNEL_TEST_ALIPAY_PRODUCTS.some(([product]) => product === requestedAlipayProduct)) {
    throw new Error('支付宝测试产品不支持');
  }
  let device = inferChannelTestDevice(input?.device, userAgent);
  if (String(input?.device ?? 'auto').toLowerCase() === 'auto') {
    device = {
      scan: 'pc',
      mp: 'wechat',
      h5: 'mobile',
      app: 'app',
      mini: 'wechat',
    }[requestedWechatProduct] ?? device;
    device = {
      scan: 'pc',
      pos: 'pc',
      mini: 'alipay',
      app: 'app',
      h5: 'mobile',
      web: 'pc',
    }[requestedAlipayProduct] ?? device;
  }
  return {
    type: payType,
    outTradeNo,
    notifyUrl: optionalUrl(input?.notify_url, '测试通知地址'),
    returnUrl: optionalUrl(input?.return_url, '测试返回地址'),
    name: requireText({ name: input?.name }, 'name', 128),
    amountFen: moneyToFen(input?.money),
    param: 'channel_test',
    buyer: '',
    device,
    clientIp: String(clientIp ?? '').split(',')[0].trim().slice(0, 64),
    wechatProduct: requestedWechatProduct === 'auto' ? '' : requestedWechatProduct,
    alipayProduct: requestedAlipayProduct === 'auto' ? '' : requestedAlipayProduct,
    openid: optionalIdentity(input?.openid, '公众号 openid'),
    miniOpenid: optionalIdentity(input?.mini_openid, '小程序 openid'),
    buyerOpenId: optionalIdentity(input?.buyer_open_id, '支付宝 buyer_open_id'),
    buyerId: optionalIdentity(input?.buyer_id, '支付宝 buyer_id'),
    subAppId: optionalIdentity(input?.sub_appid, '支付宝小程序 AppID'),
    authCode: optionalIdentity(input?.auth_code, '支付宝付款码'),
  };
}

export function channelTestRecord(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json ?? '{}') ?? {}; } catch { metadata = {}; }
  return {
    payment_no: String(row.payment_no ?? ''),
    external_order_no: String(row.external_order_no ?? ''),
    channel_id: Number(metadata.channel_id ?? 0),
    channel_name: String(metadata.channel_name ?? ''),
    plugin_code: String(row.plugin_code ?? ''),
    pay_type: String(metadata.epay_type ?? ''),
    name: String(metadata.name ?? ''),
    money: fenToMoney(row.expected_amount_fen),
    status: String(row.status ?? ''),
    provider_trade_no: String(row.provider_trade_no ?? ''),
    provider_error: String(metadata.provider_error ?? ''),
    created_at: String(row.created_at ?? ''),
    paid_at: String(row.paid_at ?? ''),
    payment_page_path: `/payment/${encodeURIComponent(String(row.payment_no ?? ''))}`,
  };
}
