/**
 * schema.sql 末尾的数据迁移：旧订单里内联的收款码图片换成占位符。
 *
 * 部署站升级时把整份 schema.sql 逐条重跑一遍，所以这条 UPDATE 必须可重复执行，
 * 而且任何一行数据都不能让它报错——它一失败，整个升级就停在"Worker 程序尚未更新"。
 * 这里在真 SQLite 上跑真文件，SQL 写错了就会炸。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const MARKER = '__edgepay_asset_v1__';
const IMAGE = `data:image/png;base64,${'Q'.repeat(200_000)}`;

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insert(db, paymentNo, metadataJson, { status = 'EXPIRED', createdAt = '2026-10-01T00:00:00.000Z' } = {}) {
  db.prepare(`
    INSERT INTO payment_attempts (
      payment_no, external_order_no, plugin_code, expected_amount_fen, status, expires_at,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'wxpay_receipt', 100, ?, ?, ?, ?, ?)
  `).run(paymentNo, `EXT-${paymentNo}`, status, createdAt, metadataJson, createdAt, createdAt);
}

const metadataOf = (db, paymentNo) => db.prepare(
  'SELECT metadata_json FROM payment_attempts WHERE payment_no = ?',
).get(paymentNo).metadata_json;

test('升级时把订单里内联的收款码换成占位符，其余字段和别的订单原样不动', () => {
  const db = database();
  const receipt = {
    channel_id: 2,
    personal_receipt: { receipt_amount: 666 },
    presentation: { pay_page: 'page', pay_params: { _page: 'receiptQrcode', amount: '6.66', qrcode_image: IMAGE } },
  };
  insert(db, 'p_legacy_paid', JSON.stringify(receipt), { status: 'PAID' });
  insert(db, 'p_legacy_paying', JSON.stringify(receipt), { status: 'PAYING' });
  // 付呗收款单给的是 https 图片链接，本来就小，也不是插件配置里那张图。
  const billMode = JSON.stringify({ presentation: { pay_params: { qrcode_image: 'https://oss.example.com/qr.png' } } });
  insert(db, 'p_bill', billMode);
  // 体积超过阈值但图片不在 pay_params 里：路径对不上就不碰。
  const elsewhere = JSON.stringify({ provider_result: { qrcode_image: IMAGE } });
  insert(db, 'p_elsewhere', elsewhere);
  // 坏 JSON 不能让整条语句（也就是整个升级）报错。
  const broken = `{"presentation":${JSON.stringify('x'.repeat(10_000))}`;
  insert(db, 'p_broken', broken);

  db.exec(SCHEMA);

  for (const paymentNo of ['p_legacy_paid', 'p_legacy_paying']) {
    const migrated = metadataOf(db, paymentNo);
    assert.ok(migrated.length < 1_000, `${paymentNo} 迁移后还有 ${migrated.length} 字符`);
    assert.deepEqual(JSON.parse(migrated), {
      ...receipt,
      presentation: { ...receipt.presentation, pay_params: { ...receipt.presentation.pay_params, qrcode_image: MARKER } },
    });
  }
  assert.equal(metadataOf(db, 'p_bill'), billMode);
  assert.equal(metadataOf(db, 'p_elsewhere'), elsewhere);
  assert.equal(metadataOf(db, 'p_broken'), broken);

  // 再跑一遍什么都不变。
  const before = db.prepare('SELECT payment_no, metadata_json FROM payment_attempts ORDER BY payment_no').all();
  db.exec(SCHEMA);
  assert.deepEqual(db.prepare('SELECT payment_no, metadata_json FROM payment_attempts ORDER BY payment_no').all(), before);
});

test('一次升级最多换 2000 行，先换最新的；剩下的下次升级接着换', () => {
  const db = database();
  const fat = JSON.stringify({ presentation: { pay_params: { qrcode_image: `data:image/png;base64,${'Q'.repeat(5_000)}` } } });
  for (let index = 0; index < 2_001; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
    insert(db, `p_${String(index).padStart(4, '0')}`, fat, { createdAt });
  }
  const inline = () => db.prepare(
    "SELECT payment_no FROM payment_attempts WHERE metadata_json LIKE '%data:image%' ORDER BY payment_no",
  ).all().map((row) => row.payment_no);

  db.exec(SCHEMA);
  assert.deepEqual(inline(), ['p_0000'], '最早的那一单留到下次');
  db.exec(SCHEMA);
  assert.deepEqual(inline(), []);
});
