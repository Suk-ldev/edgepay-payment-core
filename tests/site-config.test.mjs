import assert from 'node:assert/strict';
import test from 'node:test';
import { contactPublicConfig, normalizeSiteConfig } from '../src/index.js';

test('收银台设置默认使用 5 分钟并允许安全的客服链接 HTML', () => {
  assert.deepEqual(normalizeSiteConfig({
    merchant_name: '示例商户',
    cashier_footer_html: '<a class="cashier-footer-button" href="https://support.example">联系客服</a>',
  }), {
    merchant_name: '示例商户',
    order_expire_minutes: 5,
    cashier_footer_html: '<a class="cashier-footer-button" href="https://support.example">联系客服</a>',
    contact_enabled: true,
    contact_title: '添加我的企业微信与我联系吧',
    contact_qr_label: '手机微信扫码添加好友',
    contact_avatar_image: '',
    contact_qrcode_image: '',
  });
});

test('收银台底部 HTML 拒绝脚本、事件属性和内联样式', () => {
  for (const cashierFooterHtml of [
    '<script>alert(1)</script>',
    '<a href="#" onclick="alert(1)">联系</a>',
    '<a href="javascript:alert(1)">联系</a>',
    '<div style="background:red">联系</div>',
    '<iframe src="https://example.com"></iframe>',
  ]) {
    assert.throws(() => normalizeSiteConfig({
      merchant_name: '示例商户',
      order_expire_minutes: 5,
      cashier_footer_html: cashierFooterHtml,
    }), /危险|脚本|事件|内联样式/u);
  }
});

test('客服页设置只接受图片数据并只公开展示字段', () => {
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  const qrcode = 'data:image/webp;base64,UklGRg==';
  const config = normalizeSiteConfig({
    merchant_name: '示例商户',
    order_expire_minutes: 5,
    contact_enabled: true,
    contact_title: '添加我的微信',
    contact_qr_label: '扫码添加好友',
    contact_avatar_image: avatar,
    contact_qrcode_image: qrcode,
  });
  assert.deepEqual(contactPublicConfig(config), {
    enabled: true,
    title: '添加我的微信',
    qr_label: '扫码添加好友',
    avatar_image: avatar,
    qrcode_image: qrcode,
  });
  assert.throws(() => normalizeSiteConfig({
    ...config,
    contact_qrcode_image: 'https://example.com/tracking.png',
  }), /PNG|JPEG|WebP/u);
});
