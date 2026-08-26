/**
 * 核心合同测试用的假插件。
 *
 * 真实的付费插件在私有商业仓库里，公开核心的测试不该、也不能依赖它们。
 * 但核心自身的行为——通道路由、下单分发、回调应答、授权门——必须被覆盖，
 * 所以这里用一批只实现契约、不连任何真实平台的假插件来测。
 */

import { definePlugin } from '../../src/plugin-api.js';

/** 假的渠道直连插件。下单直接返回一个可断言的跳转结果。 */
export function fakeDirectPlugin(code, {
  name = code,
  payTypes = ['bank'],
  jumpUrl = `https://checkout.example/${code}`,
  tier = 'PAID',
} = {}) {
  return definePlugin({
    manifest: {
      code,
      name,
      version: '1.0.0',
      apiVersion: 1,
      tier,
      mode: 'direct',
      runtime: 'direct',
      payTypes,
      required: [],
      adminFields: [{ key: 'secret_key', label: '密钥', type: 'password', secret: true }],
    },
    createPayment({ order }) {
      return {
        pay_page: 'jump',
        pay_type: order.payType,
        pay_product: 'checkout',
        pay_action: 'redirect',
        pay_params: { url: jumpUrl },
        chan_order_no: `${code}_order`,
        chan_trade_no: `${code}_trade`,
      };
    },
    handleCallback({ request }) {
      return {
        status: 'success',
        payNo: new URL(request.url).searchParams.get('pay_no') ?? '',
        eventId: `${code}_event`,
        channelTradeNo: `${code}_trade`,
      };
    },
    queryPayment() {
      return { success: true, status: 'pending', message: `${name}查询占位` };
    },
    refundPayment({ order }) {
      return { success: true, status: 'success', providerRefundNo: `${code}_refund`, refundAmount: order.refundAmount };
    },
  });
}

/** 假的收款监听插件，用来测通道通知与 Worker 轮询编排。 */
export function fakeReceiptPlugin(code, {
  name = code,
  payTypes = ['alipay', 'wxpay'],
  tier = 'PAID',
  records = [],
  // 轮询期间的副作用。真实插件确认到账后核心会改写订单，测试用它模拟那一刻。
  onPoll = null,
} = {}) {
  return definePlugin({
    manifest: {
      code,
      name,
      version: '1.0.0',
      apiVersion: 1,
      tier,
      mode: 'channel-notify',
      runtime: 'hybrid',
      payTypes,
      required: ['receipt_qrcode_image'],
      adminFields: [{ key: 'receipt_qrcode_image', label: '码牌二维码', type: 'image' }],
    },
    async pollReceipts(context) {
      if (onPoll) await onPoll(context);
      return { records, details: { fake: true }, state: {} };
    },
  });
}
