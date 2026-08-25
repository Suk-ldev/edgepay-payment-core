import test from 'node:test';
import assert from 'node:assert/strict';
import { ePaySignContent, md5Hex, moneyToFen } from '../src/epay-v1.js';
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
