import assert from 'node:assert/strict';
import test from 'node:test';
import {
  receiptDiscoveryAccount,
  receiptDiscoveryFields,
  sanitizeReceiptDiscoveryRecords,
  unscopedReceiptConfig,
} from '../src/receipt-discovery.js';

test('最近流水发现只开放收款插件实际声明的编号字段', () => {
  assert.deepEqual(receiptDiscoveryFields({
    mode: 'channel-notify',
    adminFields: [
      { key: 'watcher_username', label: '账号' },
      { key: 'receipt_store_id', label: '门店 ID' },
      { key: 'receipt_terminal_no', label: '终端号' },
    ],
  }), [
    { key: 'receipt_store_id', label: '门店 ID' },
    { key: 'receipt_terminal_no', label: '终端号' },
  ]);
  assert.deepEqual(receiptDiscoveryFields({ mode: 'direct', adminFields: [] }), []);
});

test('最近流水查询清空可能填错的筛选编号但保留登录凭据', () => {
  const config = unscopedReceiptConfig({
    watcher_username: 'merchant',
    watcher_password: 'secret',
    receipt_account_no: 'M-1',
    receipt_store_id: 'S-1',
    receipt_terminal_no: 'T-1',
    receipt_page_id: 'P-1',
  });
  assert.equal(config.watcher_username, 'merchant');
  assert.equal(config.watcher_password, 'secret');
  assert.equal(config.receipt_account_no, '');
  assert.equal(config.receipt_store_id, '');
  assert.equal(config.receipt_terminal_no, '');
  assert.equal(config.receipt_page_id, '');
  assert.equal(receiptDiscoveryAccount('fubei_receipt', config).orders.length, 1);
});

test('最近流水结果只保留近五分钟的配置编号并按时间倒序', () => {
  const now = Date.parse('2026-08-26T05:00:00.000Z') / 1_000;
  const records = sanitizeReceiptDiscoveryRecords([
    {
      order_no: 'NEW-1', paid_at: now - 10, price: '0.01', pay_type: 'wxpay',
      merchant_no: 'M-1', store_id: 'S-1', terminal_no: 'T-1', page_id: 'P-1',
      merchant_name: '测试门店', remark: '不应返回的付款人信息',
    },
    { order_no: 'OLD-1', paid_at: now - 301, price: '1.00', pay_type: 'alipay', terminal_no: 'T-OLD' },
  ], now);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    order_no: 'NEW-1',
    paid_at: now - 10,
    price: '0.01',
    pay_type: 'wxpay',
    merchant_name: '测试门店',
    identifiers: {
      receipt_account_no: 'M-1',
      receipt_store_id: 'S-1',
      receipt_terminal_no: 'T-1',
      receipt_page_id: 'P-1',
    },
  });
});
