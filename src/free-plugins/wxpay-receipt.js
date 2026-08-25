/**
 * 微信个人收款监听（免费）。收款展示与 SmsForwarder 通知都是核心层的通用实现，
 * 这里只声明清单，不需要平台专属代码。
 */

import { definePlugin } from '../plugin-api.js';
import { PERSONAL_RECEIPT_FIELDS } from '../admin-fields.js';

export const wxpayReceiptPlugin = definePlugin({
  manifest: {
    code: 'wxpay_receipt',
    name: '微信个人收款监听',
    version: '1.0.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'channel-notify',
    runtime: 'self',
    receiptSource: 'sms_forwarder',
    payTypes: ['wxpay'],
    required: ['sms_forwarder_secret', 'receipt_qrcode_image'],
    adminFields: [
      ...PERSONAL_RECEIPT_FIELDS,
      { key: 'receipt_qrcode_image', label: '收款二维码', type: 'image' },
    ],
    note: '保留 SmsForwarder timestamp/sign 校验与金额/备注匹配；通知入口返回明确投送状态，legacy=1 兼容原 200/400 正文。',
  },
});
