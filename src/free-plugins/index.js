/**
 * 随程序本体公开的免费插件。付费插件不在这个仓库里，
 * 由私有商业仓库编译成独立模块，在部署时按 License 权益拼装进 Worker。
 */

import { alipayApiPlugin } from './alipay-api.js';
import { alipayReceiptPlugin } from './alipay-receipt.js';
import { fubeiReceiptPlugin } from './fubei-receipt.js';
import { shouqianbaReceiptPlugin } from './shouqianba-receipt.js';
import { wechatApiPlugin } from './wechat-api.js';
import { wxpayReceiptPlugin } from './wxpay-receipt.js';

export const freePlugins = Object.freeze([
  wxpayReceiptPlugin,
  alipayReceiptPlugin,
  alipayApiPlugin,
  wechatApiPlugin,
  shouqianbaReceiptPlugin,
  fubeiReceiptPlugin,
]);

export const FREE_PLUGIN_CODES = Object.freeze(freePlugins.map((plugin) => plugin.manifest.code));

export {
  alipayApiPlugin, alipayReceiptPlugin, fubeiReceiptPlugin,
  shouqianbaReceiptPlugin, wechatApiPlugin, wxpayReceiptPlugin,
};
