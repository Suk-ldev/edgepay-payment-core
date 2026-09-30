/**
 * 付呗 e 站（商户后台 e.51fubei.com）：账号密码登录 + 交易流水查询。
 * 码牌模式靠它按金额认领订单；插件编辑区的"查询最近流水"也走这里。
 */

import { md5Hex } from '../../epay-v1.js';
import {
  BROWSER_USER_AGENT, CookieJar, epochSeconds, fetchWithTimeout, formatShanghai, fubeiPayType,
  jsonResponse, moneyToFen, safeText,
} from './shared.js';

const DEFAULT_FUBEI_BASE_URL = 'https://e.51fubei.com';

function formHeaders(origin, referer, cookie = '') {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin,
    referer,
    'user-agent': BROWSER_USER_AGENT,
    'x-requested-with': 'XMLHttpRequest',
    ...(cookie ? { cookie } : {}),
  };
}

export function buildWorkerFubeiQuery(orders, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const created = orders
    .map((order) => epochSeconds(order.created_at ?? order.request_at))
    .filter((value) => value !== null);
  const earliest = created.length ? Math.min(...created) : nowSeconds - 300;
  const window = {
    start: Math.max(nowSeconds - 86_400, earliest - 300),
    end: nowSeconds + 60,
  };
  const values = {
    draw: '5',
    'order[0][column]': '6',
    'order[0][dir]': 'desc',
    start: '0',
    length: '100',
    'search[value]': '',
    'search[regex]': 'false',
    'storeId[]': '',
    switchOff: '1',
    time: '2',
    start_time: formatShanghai(window.start),
    end_time: formatShanghai(window.end),
    'pay_status[]': '2',
    store_id: '',
    pay_type: '',
    searchcashier: '',
    type: '',
    order_type: '1',
    searchkey: '',
    device_no: '',
    index: '0',
  };
  const columnNames = [
    'create_time', 'trade_no', 'store_name', 'pay_type',
    'shishou', 'pay_status', 'pay_status', 'pay_status',
  ];
  for (let index = 0; index < columnNames.length; index += 1) {
    values[`columns[${index}][data]`] = String(index);
    values[`columns[${index}][name]`] = columnNames[index];
    values[`columns[${index}][searchable]`] = 'false';
    values[`columns[${index}][orderable]`] = 'false';
    values[`columns[${index}][search][value]`] = '';
    values[`columns[${index}][search][regex]`] = 'false';
  }
  return { body: new URLSearchParams(values).toString(), window };
}

export function normalizeWorkerFubeiRecords(rows, terminalNo = '') {
  const terminal = String(terminalNo ?? '').trim();
  const stats = {
    raw: Array.isArray(rows) ? rows.length : 0,
    successful: 0,
    terminal: 0,
    normalized: 0,
  };
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.pay_status ?? '') !== '1' || String(row?.type ?? '1') !== '1') continue;
    stats.successful += 1;
    const deviceNo = String(row?.device_no ?? '').trim();
    if (terminal && deviceNo !== terminal) continue;
    stats.terminal += 1;
    const orderNo = String(row?.order_sn ?? row?.trade_no ?? '').trim();
    const payType = fubeiPayType(row?.pay_type);
    const amountFen = moneyToFen(row?.order_sumprice);
    const paidAt = epochSeconds(row?.pay_time ?? row?.create_time);
    if (!orderNo || !payType || !Number.isSafeInteger(amountFen) || amountFen <= 0 || paidAt === null) continue;
    records.push({
      order_no: orderNo.slice(0, 64),
      pay_type: payType,
      price: (amountFen / 100).toFixed(2),
      paid_at: paidAt,
      channel: deviceNo || String(row?.store_id ?? ''),
      merchant_no: String(row?.store_id ?? ''),
      store_id: String(row?.store_id ?? ''),
      terminal_no: deviceNo,
      merchant_name: String(row?.store_name ?? row?.merchant_name ?? ''),
      merchant_order_no: String(row?.merchant_order_sn ?? ''),
    });
    stats.normalized += 1;
  }
  return { records, stats };
}

class WorkerFubeiClient {
  constructor(config, cookieEntries, fetchImpl) {
    if (!config.watcher_username || !config.watcher_password) throw new Error('付呗账号或密码未配置');
    this.username = String(config.watcher_username);
    this.password = String(config.watcher_password);
    this.baseUrl = String(config.fubei_base_url ?? DEFAULT_FUBEI_BASE_URL).replace(/\/+$/u, '');
    this.jar = new CookieJar(cookieEntries);
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    const response = await fetchWithTimeout(
      `${this.baseUrl}${pathname}`,
      { ...options, headers },
      this.fetchImpl,
    );
    this.jar.absorb(response);
    return response;
  }

  async login() {
    this.jar.clear();
    const loginPage = await this.request('/Index/Login/index', {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!loginPage.ok) throw new Error(`付呗登录页 HTTP ${loginPage.status}`);
    await loginPage.arrayBuffer();
    const body = new URLSearchParams({
      username: this.username,
      password: await md5Hex(this.password),
      latitude: '',
      longitude: '',
      isAgree: '1',
      verifyCode: '',
      isOem: '2',
      isStopLogin: '1',
    }).toString();
    const response = await this.request('/Login/handle', {
      method: 'POST',
      headers: formHeaders(this.baseUrl, `${this.baseUrl}/Index/Login/index`, this.jar.header()),
      body,
    });
    const result = await jsonResponse(response, '付呗登录');
    if (Number(result.status) !== 1) {
      throw new Error(`付呗登录失败：${safeText(result.msg ?? result.message ?? '未知错误')}`);
    }
  }

  async queryOnce(orders) {
    const { body, window } = buildWorkerFubeiQuery(orders);
    const response = await this.request('/User/NewFundManagement/tradestats', {
      method: 'POST',
      headers: formHeaders(
        this.baseUrl,
        `${this.baseUrl}/User/NewFundManagement/tradestats`,
        this.jar.header(),
      ),
      body,
    });
    const result = await jsonResponse(response, '付呗账单');
    if (result.status !== 'ok' || !Array.isArray(result.data)) {
      throw new Error(`付呗登录态失效或账单查询失败：${safeText(result.msg ?? result.message ?? result.status)}`);
    }
    return { rows: result.data, window };
  }

  async query(orders) {
    try {
      return await this.queryOnce(orders);
    } catch {
      await this.login();
      return this.queryOnce(orders);
    }
  }
}

/**
 * 查一轮 e 站流水。state 只认 cookies 一项；调用方负责把它并回插件的整份登录态，
 * 别把收款单模式的会话冲掉。
 */
export async function queryWorkerFubei(account, state = {}, fetchImpl = null) {
  const config = account.config ?? {};
  const terminal = String(config.receipt_terminal_no ?? '').trim();
  const client = new WorkerFubeiClient(config, state.cookies, fetchImpl);
  const { rows, window } = await client.query(account.orders);
  const { records, stats } = normalizeWorkerFubeiRecords(rows, terminal);
  return {
    records,
    state: {
      cookies: client.jar.toJSON(),
      updated_at: new Date().toISOString(),
    },
    details: {
      ...stats,
      window_start: new Date(window.start * 1_000).toISOString(),
      window_end: new Date(window.end * 1_000).toISOString(),
    },
  };
}
