/**
 * 微信官方 API 支付（免费）。V2/V3、JSAPI/H5/APP/小程序/Native 的实现都在
 * wechat-v2-plugin.js；退款需要商户 API 双向证书，由 env.WECHAT_MTLS 绑定提供。
 */

import { definePlugin } from '../plugin-api.js';
import {
  createWechatV2Payment, handleWechatV2Notify, queryWechatV2Payment, refundWechatV2Payment,
  wechatV2NotifyResponse,
} from '../wechat-v2-plugin.js';

export const wechatApiPlugin = definePlugin({
  manifest: {
    code: 'wechat_api',
    name: '微信官方API支付',
    version: '1.0.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'direct',
    runtime: 'direct',
    payTypes: ['wxpay'],
    required: ['mch_id', 'api_v2_key'],
    adminFields: [
      { key: 'api_version', label: '接口版本', type: 'select', options: [['v2', 'V2 接口'], ['v3', 'V3 接口']] },
      { key: 'mode', label: '接入模式', type: 'select', options: [['merchant', '普通商户']] },
      { key: 'mch_id', label: '微信支付商户号', type: 'text' },
      { key: 'app_id', label: '默认 AppID', type: 'text' },
      { key: 'api_v2_key', label: 'API 密钥（V2）', type: 'password', secret: true },
      {
        key: 'enabled_products',
        label: '已开通微信支付产品',
        type: 'multiselect',
        options: [
          ['mp', 'JSAPI 支付'],
          ['h5', 'H5 支付'],
          ['app', 'APP 支付'],
          ['mini', '小程序支付'],
          ['scan', 'Native 支付'],
        ],
      },
      { key: 'mp_app_id', label: '公众号 AppID', type: 'text', placeholder: 'JSAPI 支付；留空使用默认 AppID' },
      { key: 'mp_app_secret', label: '公众号 AppSecret', type: 'password', secret: true, placeholder: '微信内自动获取 openid 时使用' },
      { key: 'app_app_id', label: 'APP 应用 AppID', type: 'text', placeholder: 'APP 支付；留空使用默认 AppID' },
      { key: 'mini_app_id', label: '小程序 AppID', type: 'text', placeholder: '小程序支付；留空使用默认 AppID' },
      {
        key: 'h5_info_type',
        label: 'H5 场景类型',
        type: 'select',
        options: [['Wap', 'WAP 网站'], ['Android', 'Android 应用'], ['IOS', 'iOS 应用']],
      },
      { key: 'h5_app_name', label: 'H5 应用名称', type: 'text', placeholder: 'WAP 网站名或移动应用名' },
      { key: 'h5_app_url', label: 'H5 网站 URL', type: 'text', placeholder: 'https://pay.example.com' },
      { key: 'h5_package_name', label: 'Android 应用包名', type: 'text', placeholder: 'com.example.app' },
      { key: 'h5_bundle_id', label: 'iOS Bundle ID', type: 'text', placeholder: 'com.example.app' },
    ],
    // JSAPI 支付要先把用户跳去公众号网页授权换 openid，核心为此签发带签名的 state。
    needsOauthState: true,
    // 微信 V2 的回调正文是 XML，且必须应答 XML；金额不一致一律拒收。
    callbackFormat: 'xml',
    verifyCallbackAmount: true,
    note: '保留原 V2/V3、普通/服务商、AppID、证书、APIv3 密钥及产品配置字段。',
  },

  createPayment({ config, order }) {
    return createWechatV2Payment(config, order);
  },

  handleCallback({ request, config }) {
    return handleWechatV2Notify(request, config);
  },

  queryPayment({ config, order }) {
    return queryWechatV2Payment(config, order);
  },

  refundPayment({ config, order, env }) {
    if (!env?.WECHAT_MTLS) throw new Error('微信官方退款需要先绑定商户 API 证书（WECHAT_MTLS）');
    return refundWechatV2Payment(config, order, (input, init) => env.WECHAT_MTLS.fetch(input, init));
  },

  // 微信 V2 退款走双向证书，没绑定就别在后台开放接口退款。
  refundCapability({ env }) {
    return typeof env?.WECHAT_MTLS?.fetch === 'function'
      ? { supported: true, reason: '' }
      : { supported: false, reason: '微信 V2 退款尚未绑定商户 API 双向证书' };
  },

  // 微信要求应答 XML，成功与失败都不能用普通的 success/fail 文本。
  callbackResponse({ ok }) {
    return wechatV2NotifyResponse(ok);
  },
});
