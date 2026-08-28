/**
 * 支付宝官方 API 支付（免费）。签名、网关请求与验签的通用能力在 alipay-plugin.js，
 * 属于公开部分；付费的支付宝账单插件在私有仓库里复用同一套签名能力。
 */

import { definePlugin } from '../plugin-api.js';
import {
  createAlipayPayment, handleAlipayNotify, queryAlipayPayment, refundAlipayPayment,
} from '../alipay-plugin.js';

export const alipayApiPlugin = definePlugin({
  manifest: {
    code: 'alipay_api',
    name: '支付宝官方API支付',
    version: '1.0.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'direct',
    runtime: 'direct',
    payTypes: ['alipay'],
    verifyCallbackAmount: true,
    required: ['app_id', 'private_key', 'alipay_public_key'],
    adminFields: [
      { key: 'mode', label: '加签模式', type: 'select', options: [['key', '密钥模式'], ['cert', '证书模式']] },
      { key: 'app_id', label: '支付宝应用 AppID', type: 'text' },
      { key: 'private_key', label: '应用私钥', type: 'textarea', secret: true },
      { key: 'alipay_public_key', label: '支付宝公钥', type: 'textarea', secret: true },
      {
        key: 'enabled_products',
        label: '已开通支付宝产品',
        type: 'multiselect',
        options: [
          ['pos', '当面付（付款码）'],
          ['scan', '订单码支付'],
          ['mini', '小程序 JSAPI 支付'],
          ['app', 'APP 支付'],
          ['h5', '手机网站支付'],
          ['web', '电脑网站支付'],
        ],
      },
      { key: 'seller_id', label: '收款支付宝用户 ID', type: 'text', placeholder: '选填；指定收款账号时填写' },
      { key: 'service_provider_id', label: '服务商 PID', type: 'text', placeholder: '选填；传入 extend_params' },
      { key: 'store_id', label: '门店 ID', type: 'text', placeholder: '当面付/订单码支付选填' },
      { key: 'operator_id', label: '操作员 ID', type: 'text', placeholder: '当面付/订单码支付选填' },
      { key: 'terminal_id', label: '终端 ID', type: 'text', placeholder: '当面付/订单码支付选填' },
      { key: 'app_auth_token', label: '第三方应用授权令牌', type: 'password', secret: true, placeholder: '普通商户留空' },
      { key: 'mini_app_id', label: '支付宝小程序 AppID', type: 'text', placeholder: '小程序 JSAPI 支付使用' },
      { key: 'mini_launch_path', label: '小程序承接页面路径', type: 'text', placeholder: '例如 pages/pay/index' },
      { key: 'sandbox', label: '运行环境', type: 'select', options: [['false', '正式环境'], ['true', '沙箱环境']] },
    ],
    note: '保留原 app_id、private_key、alipay_public_key/证书、enabled_products 等配置字段。',
  },

  createPayment({ config, order }) {
    return createAlipayPayment(config, order);
  },

  handleCallback({ request, config }) {
    return handleAlipayNotify(request, config);
  },

  handleReturn({ request, config }) {
    return handleAlipayNotify(request, config);
  },

  queryPayment({ config, order }) {
    return queryAlipayPayment(config, order);
  },

  refundPayment({ config, order }) {
    return refundAlipayPayment(config, order);
  },

  // 支付宝接口退款需要单独的退款证书，尚未接入前先不在后台开放，
  // 让运营走手动退款登记，而不是点下去才失败。
  refundCapability() {
    return { supported: false, reason: '支付宝退款证书尚未配置，请使用手动退款登记' };
  },
});
