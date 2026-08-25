/**
 * 支付宝个人收款监听（免费）。仅支持安卓 SmsForwarder；
 * 收钱码与经营码的通知无法区分，所以只能二选一。
 */

import { definePlugin } from '../plugin-api.js';
import { PERSONAL_RECEIPT_FIELDS } from '../admin-fields.js';

export const alipayReceiptPlugin = definePlugin({
  manifest: {
    code: 'alipay_receipt',
    name: '支付宝个人收款监听',
    version: '1.0.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'channel-notify',
    runtime: 'self',
    receiptSource: 'sms_forwarder',
    payTypes: ['alipay'],
    required: ['sms_forwarder_secret', 'receipt_code_type', 'receipt_qrcode_image'],
    adminFields: [
      { key: 'receipt_code_type', label: '收款码类型（只能二选一）', type: 'select', options: [['personal', '收钱码'], ['business', '经营码']] },
      ...PERSONAL_RECEIPT_FIELDS,
      { key: 'receipt_qrcode_image', label: '支付宝收款二维码', type: 'image' },
    ],
    note: '免费自监听插件；仅支持安卓 SmsForwarder。收钱码与经营码通知无法区分，只能选择其中一个收款码，暂不支持 PC 监听。',
  },
});
