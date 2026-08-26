import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  PERSONAL_RECEIPT_KEY, classifySmsForwarderDeliveryError, closestPayment, eventOrderNo,
  isSmsForwarderProbeRequest,
  hmacSha256Base64, moneyTextToFen, paidAtIso, paidAtTimestamp, parseSmsForwarder,
  paymentWindowMatches, payTypeMatches, readSignedWatcherPayload, receiptRemarkCode,
  selectPersonalReceipt, verifyStaticPollToken, verifyWatcherSnapshotRequest,
  watcherRecord, watcherRecords, decimalToInteger,
} from '../src/receipt-plugins.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

if (!globalThis.crypto) globalThis.crypto = webcrypto;
function payment(overrides = {}) {
  return {
    payment_no: 'p_receipt_1',
    expected_amount_fen: 1_000,
    created_at: '2026-07-27T08:00:00.000Z',
    expires_at: '2026-07-27T08:10:00.000Z',
    metadata: { epay_type: 'wxpay' },
    ...overrides,
  };
}

test('静态轮询 Token 只接受完全匹配的 GET 查询参数', () => {
  const secret = 'poll-trigger-test-token';
  assert.equal(
    verifyStaticPollToken(
      new Request(`https://worker.example/internal/receipt-poll?token=${secret}`),
      secret,
    ),
    true,
  );
  assert.equal(
    verifyStaticPollToken(
      new Request('https://worker.example/internal/receipt-poll?token=wrong'),
      secret,
    ),
    false,
  );
  assert.equal(
    verifyStaticPollToken(
      new Request(`https://worker.example/internal/receipt-poll?token=${secret}`, { method: 'POST' }),
      secret,
    ),
    false,
  );
  assert.equal(
    verifyStaticPollToken(
      new Request(`https://worker.example/internal/receipt-poll?token=${secret}`),
      '',
    ),
    false,
  );
});
test('付呗金额模式按识别金额、支付方式和订单时间窗匹配', () => {
  const payments = [
    payment({
      metadata: {
        epay_type: 'wxpay',
        [PERSONAL_RECEIPT_KEY]: {
          mode: 'amount',
          original_amount: 1_000,
          receipt_amount: 1_001,
        },
      },
    }),
  ];
  const selected = selectPersonalReceipt(payments, {
    order_no: 'FUBEI-1',
    price: '10.01',
    pay_type: 'wxpay',
    paid_at: '2026-07-27 16:05:00',
  });
  assert.equal(selected.payment.payment_no, 'p_receipt_1');
  assert.equal(selected.amountFen, 1_001);
});
test('付呗备注模式同时校验四位备注、原始金额和支付时间', () => {
  const payments = [
    payment({
      metadata: {
        epay_type: 'alipay',
        [PERSONAL_RECEIPT_KEY]: {
          mode: 'remark',
          original_amount: 1_000,
          receipt_amount: 1_000,
          remark_code: '2048',
        },
      },
    }),
  ];
  const selected = selectPersonalReceipt(payments, {
    order_no: 'FUBEI-2',
    price: '10.00',
    pay_type: 'alipay',
    remark: '付款备注 2048',
    paid_at: '2026-07-27 16:04:00',
  });
  assert.equal(selected.payment.payment_no, 'p_receipt_1');
});
test('SmsForwarder 保持原 timestamp 换行 secret 的 HMAC 和微信通知解析', async () => {
  const secret = 'sms-test-secret';
  const timestamp = 1_800_000_000_000;
  const input = {
    timestamp: String(timestamp),
    sign: await hmacSha256Base64(secret, `${timestamp}\n${secret}`),
    from: 'com.tencent.mm',
    content: JSON.stringify({ title: '微信收款助手', msg: '微信收款到账 10.01 元，付款备注：2048' }),
  };
  const parsed = await parseSmsForwarder(input, {
    sms_forwarder_secret: secret,
    sms_forwarder_time_tolerance: 300,
  }, timestamp / 1_000);
  assert.equal(parsed.amountFen, 1_001);
  assert.equal(parsed.remarkCode, '2048');
});
test('支付宝个人收款使用 SmsForwarder 自监听并解析标题金额', async () => {
  const secret = 'alipay-sms-secret';
  const timestamp = 1_800_000_000_000;
  const input = {
    timestamp: String(timestamp),
    sign: await hmacSha256Base64(secret, `${timestamp}\n${secret}`),
    from: 'com.eg.android.AlipayGphone',
    content: JSON.stringify({ title: '成功收款10.02元', msg: '支付宝收钱到账，收款备注：4096' }),
  };
  const parsed = await parseSmsForwarder(input, {
    sms_forwarder_secret: secret,
    sms_forwarder_time_tolerance: 300,
  }, timestamp / 1_000, 'alipay');
  assert.equal(parsed.amountFen, 1_002);
  assert.equal(parsed.remarkCode, '4096');
  assert.equal(parsed.platform, 'alipay');
  await assert.rejects(
    () => parseSmsForwarder({ ...input, from: 'com.tencent.mm' }, {
      sms_forwarder_secret: secret,
      sms_forwarder_time_tolerance: 300,
    }, timestamp / 1_000, 'alipay'),
    /非支付宝通知来源/u,
  );
});
test('SmsForwarder 裸通知地址用于探活，带投送参数时进入真实处理', () => {
  assert.equal(
    isSmsForwarderProbeRequest(new Request('https://worker.example/api/pay/8/notify')),
    true,
  );
  assert.equal(
    isSmsForwarderProbeRequest(new Request('https://worker.example/api/pay/8/notify?legacy=1')),
    true,
  );
  assert.equal(
    isSmsForwarderProbeRequest(new Request('https://worker.example/api/pay/8/notify?timestamp=1&sign=x')),
    false,
  );
  assert.equal(
    isSmsForwarderProbeRequest(new Request('https://worker.example/api/pay/8/notify', { method: 'POST' })),
    false,
  );
});
test('SmsForwarder 投送失败区分未匹配、验签失败、内容错误和内部错误', () => {
  assert.deepEqual(classifySmsForwarderDeliveryError(new Error('流水未匹配到支付单')), {
    httpStatus: 202,
    ok: true,
    accepted: true,
    confirmed: false,
    status: 'unmatched',
    message: '通知已通过验签，但未匹配到有效待支付订单。',
  });
  assert.equal(
    classifySmsForwarderDeliveryError(new Error('SmsForwarder 通知签名校验失败')).httpStatus,
    401,
  );
  assert.equal(
    classifySmsForwarderDeliveryError(new Error('通知内容未识别到收款金额')).status,
    'invalid_payload',
  );
  assert.equal(
    classifySmsForwarderDeliveryError(new Error('D1 unavailable')).status,
    'internal_error',
  );
});
test('watcher HTTPS 传输只接受签名 JSON，不接受自定义字段替代原 record', async () => {
  const secret = 'watcher-transport-test';
  const body = JSON.stringify({
    plugin_code: 'fubei_receipt',
    api_config_id: 7,
    record: { order_no: 'FUBEI-3', price: '10.00', paid_at: '2026-07-27 16:01:00' },
  });
  const timestamp = '1800000000';
  const path = '/api/pay/7/notify';
  const signature = await hmacSha256Base64(secret, `${timestamp}.POST.${path}.${body}`);
  const request = new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-watcher-timestamp': timestamp,
      'x-watcher-signature': `v1=${signature}`,
    },
    body,
  });
  const result = await readSignedWatcherPayload(request, secret, Number(timestamp));
  assert.equal(result.payload.record.order_no, 'FUBEI-3');
});
test('watcher 密钥轮换兼容期内接受旧传输密钥', async () => {
  const previousSecret = 'watcher-previous-key';
  const body = JSON.stringify({
    plugin_code: 'fubei_receipt',
    record: { order_no: 'FUBEI-OLD-KEY', price: '1.00' },
  });
  const timestamp = '1800000000';
  const path = '/api/pay/2/notify';
  const signature = await hmacSha256Base64(previousSecret, `${timestamp}.POST.${path}.${body}`);
  const request = new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-watcher-timestamp': timestamp,
      'x-watcher-signature': `v1=${signature}`,
    },
    body,
  });
  const result = await readSignedWatcherPayload(
    request,
    ['watcher-current-key', previousSecret],
    Number(timestamp),
  );
  assert.equal(result.payload.record.order_no, 'FUBEI-OLD-KEY');
});

test('密钥两端都去空白：Worker 和 watcher 必须归一化到同一个值', async () => {
  // 线上现象：watcher 报 "授权启动 HTTP 401"。
  // 起因是只给 watcher 加了 trim，Worker 侧没加——Worker Secret 里带着粘贴时
  // 多出来的换行时，两边算出来的签名就对不上，而错误只有一句 401。
  const { verifyStaticPollToken } = await import('../src/receipt-plugins.js');
  const token = 'poll-token-abc';
  const request = new Request(`https://worker.example/internal/receipt-poll?token=${token}`);
  // Worker Secret 带换行、请求里是干净值 —— 必须仍然认得。
  assert.equal(verifyStaticPollToken(request, `\n ${token} \n`), true);
  // 反过来也一样。
  const dirtyRequest = new Request(`https://worker.example/internal/receipt-poll?token=${encodeURIComponent(` ${token} `)}`);
  assert.equal(verifyStaticPollToken(dirtyRequest, token), true);
  // 去掉空白之后仍然不同的，照样要拒绝。
  assert.equal(verifyStaticPollToken(request, 'other-token'), false);
});
