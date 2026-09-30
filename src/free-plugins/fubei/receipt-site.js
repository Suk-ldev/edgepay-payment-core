/**
 * 付呗 b 站（新版商户后台 b.51fubei.com）的收款单接口。
 *
 * 所有请求都走 /api/gateway：表单里带 appid/content/method/version/sign，
 * content 是业务参数的 JSON 串。登录后要同时带 access-token 请求头和 JSID 会话 Cookie，
 * 缺一个都会返回 1003"请重新登录"。
 */

import { md5Hex } from '../../epay-v1.js';
import {
  BROWSER_USER_AGENT, CookieJar, fetchWithTimeout, formatShanghai, jsonResponse, safeText,
} from './shared.js';

const DEFAULT_RECEIPT_BASE_URL = 'https://b.51fubei.com';
const GATEWAY_APPID = 'CASHIER-DIGITAL';
const GATEWAY_VERSION = '1.0.0';
// 付呗前端写死的签名盐，不随请求发送。
const GATEWAY_SALT = 'fXchxBDq';
const SESSION_EXPIRED_CODE = '1003';
const PAYMENT_PAGE_SIZE = 100;
const PAYMENT_MAX_PAGES = 5;

/**
 * 与付呗前端一致：把 {appid, content, method, salt, version} 按键名排序后整体 JSON 化，
 * 去掉所有反斜杠再取 md5。这五个键按字母序写出来本身就是有序的。
 */
export async function gatewaySign(method, content) {
  const fields = {
    appid: GATEWAY_APPID, content, method, salt: GATEWAY_SALT, version: GATEWAY_VERSION,
  };
  return md5Hex(JSON.stringify(fields).replaceAll('\\', ''));
}

class FubeiGatewayError extends Error {
  constructor(method, result) {
    super(`付呗收款单接口 ${method} 失败：${safeText(result?.errorMsg ?? result?.message ?? '未知错误')}`);
    this.code = String(result?.errorCode ?? '');
  }
}

export class FubeiReceiptClient {
  /** session 是上次存下来的 {token, uid, cookies, store_id}，没有就首次调用时登录。 */
  constructor(config, session = {}, fetchImpl = null) {
    if (!config.watcher_username || !config.watcher_password) throw new Error('付呗账号或密码未配置');
    this.username = String(config.watcher_username);
    this.password = String(config.watcher_password);
    this.configuredStoreId = String(config.receipt_account_no ?? '').trim();
    this.baseUrl = String(config.fubei_receipt_base_url ?? DEFAULT_RECEIPT_BASE_URL).replace(/\/+$/u, '');
    this.token = String(session?.token ?? '');
    this.uid = session?.uid ?? null;
    this.storeId = String(session?.store_id ?? '');
    this.jar = new CookieJar(session?.cookies);
    this.fetchImpl = fetchImpl;
  }

  session() {
    return {
      token: this.token,
      uid: this.uid,
      store_id: this.storeId,
      cookies: this.jar.toJSON(),
      updated_at: new Date().toISOString(),
    };
  }

  async post(method, payload) {
    const content = JSON.stringify(payload);
    const body = new URLSearchParams({
      appid: GATEWAY_APPID,
      content,
      method,
      version: GATEWAY_VERSION,
      sign: await gatewaySign(method, content),
    });
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded',
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      'user-agent': BROWSER_USER_AGENT,
    };
    if (this.token) headers['access-token'] = this.token;
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/gateway`,
      { method: 'POST', headers, body: body.toString() },
      this.fetchImpl,
    );
    this.jar.absorb(response);
    const result = await jsonResponse(response, `付呗收款单接口 ${method}`);
    if (result?.success !== true) throw new FubeiGatewayError(method, result);
    return result.data ?? {};
  }

  async login() {
    this.token = '';
    this.uid = null;
    this.jar.clear();
    const data = await this.post('com.fshows.lifecircle.college.login', {
      username: this.username,
      subusername: '',
      password: await md5Hex(this.password.trim()),
      code: '',
      userAgent: BROWSER_USER_AGENT,
      cookie: '',
    });
    // 这几种情况付呗前端会先把人带去签协议/改密码/选关联账号，不会发 token。
    if (Number(data.hasSignedProtocol) === 2) throw new Error('付呗要求先签署服务协议，请用该账号在付呗后台登录一次完成签署');
    if (Number(data.hasPwReset) === 1) throw new Error('付呗要求先重置登录密码，请在付呗后台改密后更新插件配置');
    if (!data.accessToken) throw new Error('付呗收款单登录失败：未返回登录凭证，请确认该账号能直接登录付呗新版后台');
    this.token = String(data.accessToken);
    this.uid = data.uid ?? null;
  }

  /**
   * 调一个需要登录的接口。只有 1003（会话失效）才重登重试一次——
   * 建单不是幂等的，别的业务错误重试只会多建一张单。
   * payload 传函数，因为重登后 uid 才可能有值。
   */
  async call(method, payload) {
    if (!this.token) await this.login();
    try {
      return await this.post(method, payload());
    } catch (error) {
      if (error?.code !== SESSION_EXPIRED_CODE) throw error;
      await this.login();
      return this.post(method, payload());
    }
  }

  /** 收款门店：优先用配置里的门店 ID；没填且账号只有一个门店就用它，结果缓存进会话。 */
  async resolveStoreId() {
    if (this.configuredStoreId) return Number(this.configuredStoreId);
    if (this.storeId) return Number(this.storeId);
    const data = await this.call('receipt.web.store.list', () => ({}));
    const stores = Array.isArray(data.storeList) ? data.storeList : [];
    if (stores.length !== 1) {
      const listed = stores.map((store) => `${store.storeId}（${safeText(store.storeName, 30)}）`).join('、');
      throw new Error(stores.length
        ? `付呗账号下有多个门店，请在"门店 ID"里填写要收款的门店：${listed}`
        : '付呗账号下没有可用门店，无法创建收款单');
    }
    this.storeId = String(stores[0].storeId);
    return Number(this.storeId);
  }

  /** 建一张固定金额、只能付一笔的收款单。 */
  async createBill({ storeId, amountFen, title }) {
    const data = await this.call('receipt.web.receipt.add', () => ({
      mobileCheck: 0,
      needUerPay: 1,
      storeId,
      reuseCustomerFormValue: 0,
      receiptTitle: title,
      receiptExplain: '',
      receiptRichText: '',
      isLimit: 1,
      limitCount: 1,
      receiptType: 1,
      receiptMoney: Number((amountFen / 100).toFixed(2)),
      receiptItem: [],
      receiptCreateType: 2,
      receiptForm: [],
      templateCreateType: 0,
    }));
    const receiptId = String(data.receiptId ?? '').trim();
    if (!receiptId) throw new Error('付呗收款单创建失败：未返回收款单号');
    return receiptId;
  }

  /**
   * 设截止时间，到点付呗自己关单。建单接口会忽略截止时间参数，只能建完再改。
   * 订单过期后不管 Worker 还轮不轮询，这张单都不能再付。
   */
  async setDeadline(receiptId, deadlineSeconds) {
    await this.call('receipt.web.receipt.order.update', () => ({
      receiptId,
      receiptIsLong: 2,
      receiptEndTimeStr: formatShanghai(deadlineSeconds),
      receiptSource: 1,
    }));
  }

  /** 收款单的二维码图片。必须展示这张图：付呗的链接在微信里直接打开会卡在公众号授权。 */
  async billQrcode(receiptId) {
    const data = await this.call('receipt.web.receipt.share', () => ({ receiptId }));
    const image = String(data?.qrcode?.posterUrl ?? '').trim();
    if (!/^https:\/\//u.test(image)) throw new Error('付呗收款单未返回收款码图片');
    return image;
  }

  async closeBill(receiptId) {
    await this.call('receipt.web.receipt.close', () => ({ receiptId }));
  }

  /** 时间窗内所有收款单的付款记录（跨收款单、跨门店）。 */
  async billPayments(startSeconds, endSeconds) {
    const rows = [];
    for (let page = 1; page <= PAYMENT_MAX_PAGES; page += 1) {
      const data = await this.call('receipt.web.find.receipt.statistics.list', () => ({
        startTime: formatShanghai(startSeconds),
        endTime: formatShanghai(endSeconds),
        storeId: -1,
        payType: -1,
        payOrderNo: '',
        receiptTitle: [],
        uid: this.uid,
        tradeStatus: -1,
        withPermission: true,
        printStatus: '',
        pageSize: PAYMENT_PAGE_SIZE,
        page,
      }));
      const list = Array.isArray(data.list) ? data.list : [];
      rows.push(...list);
      if (list.length < PAYMENT_PAGE_SIZE) break;
    }
    return rows;
  }
}
