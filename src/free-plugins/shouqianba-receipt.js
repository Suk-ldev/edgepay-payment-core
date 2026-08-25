/**
 * 收钱吧码牌收款（免费）。Worker 直接登录收钱吧商户平台查询流水，
 * 不需要部署 Docker Watcher。
 */

import { definePlugin } from '../plugin-api.js';
import { md5Hex } from '../epay-v1.js';
import { WATCHER_BASE_FIELDS, WATCHER_CAPTCHA_FIELDS } from '../admin-fields.js';
import {
  WorkerHttpSession, normalizeRows, queryWindow, rowsAt, text, valueAt,
} from '../core/poller-runtime.js';

const DEFAULT_SHOUQIANBA_BASE_URL = 'https://web-platforms-msp.shouqianba.com';

const SHOUQIANBA_DESCRIPTOR = {
  orderNo: ['order_sn', 'orderNo', 'trade_no'],
  payType: ['payway'],
  payTypeMap: { 2: 'alipay', 3: 'wxpay', '2': 'alipay', '3': 'wxpay' },
  amount: ['original_amount'],
  amountUnit: 'fen',
  paidAt: ['finish_time', 'pay_time', 'create_time', '_worker_paid_at'],
  merchant: ['store_sn', 'merchant_sn'],
  terminal: ['terminal_sn'],
  remark: ['order_sn', 'subject'],
  isSuccessful(row) {
    return ['2000', 'SUCCESS', 'PAID', '1'].includes(String(valueAt(row, ['status', 'trade_status'], '2000')).toUpperCase());
  },
};

export async function queryWorkerShouqianba(account, previousState = {}, fetchImpl = null) {
  const config = account.config ?? {};
  if (!config.watcher_username || !config.watcher_password) throw new Error('收钱吧账号或密码未配置');
  const session = new WorkerHttpSession(config.shouqianba_base_url ?? DEFAULT_SHOUQIANBA_BASE_URL, previousState, fetchImpl);
  let token = String(previousState.token ?? '');
  const login = async () => {
    const result = await session.json('/api/login/ucUser/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        origin: 'https://s.shouqianba.com',
        referer: 'https://s.shouqianba.com/login',
      },
      body: JSON.stringify({
        username: config.watcher_username,
        password: await md5Hex(String(config.watcher_password)),
        uc_device: {
          device_type: 2,
          default_device: 0,
          platform: '商户服务平台',
          device_fingerprint: '12340d18-e414-49cf-815a-66ab8ec1a480',
          device_name: '收钱吧商户平台',
          device_model: 'Windows',
          device_brand: 'Chrome',
        },
      }),
    }, '收钱吧登录');
    if (Number(result.code) !== 50000 || Number(result.data?.code) !== 50000) {
      throw new Error(`收钱吧登录失败：${text(result.message ?? result.msg ?? result.code)}`);
    }
    token = String(valueAt(result, ['data.mchUserTokenInfo.token'], ''));
    if (!token) throw new Error('收钱吧登录成功但未返回 token');
  };
  const refresh = async () => {
    if (!token) return login();
    const result = await session.json(`/api/login/ucUser/refreshToken?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '1',
    }, '收钱吧刷新登录态');
    if (Number(result.data?.status) === 0) return login();
    const refreshed = String(valueAt(result, ['data.token'], ''));
    if (refreshed) token = refreshed;
    else await login();
  };
  const query = async () => {
    const now = Math.floor(Date.now() / 1_000);
    const window = queryWindow(account.orders, now);
    const dateStart = Math.max(window.start, now - 300);
    const result = await session.json(`/api/transaction/findTransactions?client_version=7.0.0&token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        date_end: Number(`${now}999`),
        date_start: Number(`${dateStart}000`),
        page: 1,
        page_size: Math.min(500, Math.max(10, Number(config.receipt_watcher_page_size) || 100)),
        upayQueryType: 0,
        status: '2000',
        store_sn: String(config.receipt_store_id ?? ''),
        type: '30',
      }),
    }, '收钱吧账单');
    if (Number(result.code) !== 50000) throw new Error(`收钱吧账单查询失败：${text(result.message ?? result.msg ?? result.code)}`);
    const rows = rowsAt(result, ['data.records', 'data.rows']).map((row) => ({ ...row, _worker_paid_at: now }));
    return { rows, window: { start: dateStart, end: now } };
  };
  let result;
  try { if (!token) await login(); result = await query(); } catch { await refresh(); result = await query(); }
  const normalized = normalizeRows(result.rows, SHOUQIANBA_DESCRIPTOR, config);
  return {
    records: normalized.records,
    details: { ...normalized.stats, window: result.window },
    state: session.state({ token }),
  };
}

export const shouqianbaReceiptPlugin = definePlugin({
  manifest: {
    code: 'shouqianba_receipt',
    name: '收钱吧码牌收款',
    version: '1.0.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'channel-notify',
    runtime: 'hybrid',
    payTypes: ['alipay', 'wxpay'],
    required: ['watcher_username', 'watcher_password', 'receipt_qrcode_image'],
    adminFields: [...WATCHER_BASE_FIELDS, ...WATCHER_CAPTCHA_FIELDS],
    note: 'Worker 直接登录收钱吧商户平台并查询流水，不需要部署 Docker。',
  },

  pollReceipts({ account, state, fetchImpl }) {
    return queryWorkerShouqianba(account, state, fetchImpl);
  },
});
