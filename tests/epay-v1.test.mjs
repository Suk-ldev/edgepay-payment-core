import test from 'node:test';
import assert from 'node:assert/strict';
import { EPAY_PAYLOAD_MAX_BYTES, readBoundedText } from '../src/body-limits.js';
import { ePaySignContent, md5Hex, moneyToFen, readEpayPayload } from '../src/epay-v1.js';
import { safeWebhookUrl } from '../src/security.js';

test('ePay V1 签名原文保持原项目的排序和过滤规则', () => {
  const content = ePaySignContent({
    z: 'last', sign: 'ignore', sign_type: 'MD5', key: 'ignore', empty: '', nested: {},
    pid: '1000', money: '10.00', name: '测试', a: 'first', none: null,
  });
  assert.equal(content, 'a=first&money=10.00&name=测试&pid=1000&z=last');
});

test('MD5 在 Worker 与本地测试运行时保持相同结果', async () => {
  assert.equal(await md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(await md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(await md5Hex('测试'), 'db06c78d1e24cf708a14ce81c9b617ec');
});

test('ePay V1 金额按分精确处理', () => {
  assert.equal(moneyToFen('10.01'), 1001);
  assert.throws(() => moneyToFen('0.00'));
  assert.throws(() => moneyToFen('1.234'));
});

test('商户通知只接受公共 HTTPS 地址', () => {
  assert.equal(safeWebhookUrl('https://example.com/notify'), true);
  assert.equal(safeWebhookUrl('http://example.com/notify'), false);
  assert.equal(safeWebhookUrl('https://127.0.0.1/notify'), false);
});

test('ePay 请求体在读取前按 Content-Length 拒绝超限 body', async () => {
  const request = new Request('https://worker.example/submit.php', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(EPAY_PAYLOAD_MAX_BYTES + 1) },
    body: 'pid=1000',
  });
  await assert.rejects(() => readEpayPayload(request), /超过/u);
});

test('请求体没有 Content-Length 时仍按流式累计大小限制', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(EPAY_PAYLOAD_MAX_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const request = new Request('https://worker.example/submit.php', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  });
  await assert.rejects(() => readBoundedText(request, EPAY_PAYLOAD_MAX_BYTES, '测试请求体'), /超过/u);
});
