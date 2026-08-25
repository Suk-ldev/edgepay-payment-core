/**
 * 插件运行上下文。核心层调用任何插件方法时都传入统一形状的对象，
 * 插件不直接 import 核心内部模块——这样付费插件才能被单独编译成独立模块，
 * 在部署时按 License 权益拼装进 Worker。
 *
 * helpers 是这份 ABI 的一部分：增删字段必须抬升 PLUGIN_API_VERSION。
 */

import {
  WorkerHttpSession, bytesToBase64, epochSeconds, fetchWithTimeout, formatShanghai,
  mapPayType, moneyToFen as rowAmountToFen, normalizeRows, queryWindow, rowsAt,
  splitSetCookie, text, valueAt,
} from './poller-runtime.js';
import { appendQuery, fenToMoney, md5Hex } from '../epay-v1.js';
import {
  closestPayment, decimalToInteger, hmacSha256Base64, moneyTextToFen, paidAtIso,
  paidAtTimestamp, paymentWindowMatches,
} from '../receipt-plugins.js';

/** 提供给插件的通用工具集。只放与平台无关的东西。 */
export const pluginHelpers = Object.freeze({
  // HTTP / Cookie 会话
  WorkerHttpSession,
  fetchWithTimeout,
  splitSetCookie,
  // 流水解析
  normalizeRows,
  queryWindow,
  valueAt,
  rowsAt,
  mapPayType,
  rowAmountToFen,
  // 时间与金额
  epochSeconds,
  formatShanghai,
  paidAtIso,
  paidAtTimestamp,
  fenToMoney,
  moneyTextToFen,
  decimalToInteger,
  // 流水与订单的时间窗匹配
  paymentWindowMatches,
  closestPayment,
  // 编码与摘要
  bytesToBase64,
  md5Hex,
  hmacSha256Base64,
  // 杂项
  appendQuery,
  text,
});

/**
 * 组装一次插件调用的上下文。runtime 由 createPaymentWorker 建立，
 * 携带注册表、授权门与构建信息。
 */
export function pluginContext(runtime, { env, config = {}, ...rest }) {
  return Object.freeze({
    env,
    config,
    helpers: pluginHelpers,
    buildInfo: runtime.buildInfo,
    ...rest,
  });
}
