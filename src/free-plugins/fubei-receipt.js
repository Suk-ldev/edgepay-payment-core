/**
 * 付呗码牌收款（免费）。Worker 直接登录付呗商户后台查询流水，
 * 登录态加密保存在 D1，不需要部署 Docker Watcher。
 */

import { definePlugin } from '../plugin-api.js';
import { md5Hex } from '../epay-v1.js';
import { RECEIPT_QRCODE_FIELD } from '../admin-fields.js';

const DEFAULT_FUBEI_BASE_URL = 'https://e.51fubei.com';
const REQUEST_TIMEOUT_MS = 12_000;

function safeText(value, maximum = 160) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').slice(0, maximum);
}

function epochSeconds(value) {
  if (typeof value === 'number' || /^\d+$/u.test(String(value ?? '').trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

function formatShanghai(seconds) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(seconds * 1_000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function moneyToFen(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(text)) return null;
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^-/, '');
  const [integer, fraction = ''] = unsigned.split('.', 2);
  return sign * ((Number(integer) * 100) + Number(fraction.padEnd(2, '0')));
}

async function fetchWithTimeout(url, options = {}, fetchImpl = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (fetchImpl) return await fetchImpl(url, { ...options, signal: controller.signal });
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时：${new URL(url).origin}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}返回的不是 JSON：${safeText(text, 80)}`);
  }
}

function parseSetCookie(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const first = text.split(';', 1)[0];
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  return [first.slice(0, separator).trim(), first.slice(separator + 1).trim()];
}

function responseSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const combined = response.headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=)/u);
}

class CookieJar {
  constructor(entries = []) {
    this.values = new Map(Array.isArray(entries) ? entries : []);
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorb(response) {
    for (const value of responseSetCookies(response)) {
      const entry = parseSetCookie(value);
      if (entry) this.values.set(...entry);
    }
  }

  clear() {
    this.values.clear();
  }

  toJSON() {
    return [...this.values];
  }
}

function formHeaders(origin, referer, cookie = '') {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin,
    referer,
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
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

function fubeiPayType(value) {
  const numeric = Number(value);
  if (numeric === 1) return 'wxpay';
  if (numeric === 2) return 'alipay';
  return '';
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

export const fubeiReceiptPlugin = definePlugin({
  manifest: {
    code: 'fubei_receipt',
    name: '付呗码牌收款',
    version: '1.0.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'channel-notify',
    runtime: 'hybrid',
    payTypes: ['alipay', 'wxpay'],
    required: ['watcher_username', 'watcher_password', 'receipt_terminal_no', 'receipt_qrcode_image'],
    adminFields: [
      { key: 'watcher_username', label: '平台登录账号', type: 'text' },
      { key: 'watcher_password', label: '平台登录密码', type: 'password', secret: true },
      {
        key: 'receipt_terminal_no', label: '收款终端号', type: 'text',
        placeholder: '不知道可先留空，保存后查询最近流水',
        help: '先让目标付呗码牌真实收一笔小额款，再从最近流水复制设备编号。',
      },
      {
        key: 'receipt_account_no', label: '门店 ID / 收款账号标识', type: 'text',
        placeholder: '选填，可从最近流水识别',
        help: '单门店通常可留空；多门店时填写流水中的门店编号。',
      },
      { key: 'merchant_name', label: '码牌商户名', type: 'text', placeholder: '选填，用于区分多码牌' },
      { key: 'receipt_match_mode', label: '识别模式', type: 'select', options: [['amount', '金额变动'], ['remark', '付款备注']] },
      { key: 'amount_offset_max', label: '金额偏移最大值（分）', type: 'number', min: 0, max: 99, placeholder: '默认 99，可留空' },
      RECEIPT_QRCODE_FIELD,
    ],
    // 付呗登录态失效后要重新走一遍登录页 + 表单登录，比其它平台慢，租约给到 90 秒。
    poll: { leaseSeconds: 90, cooldownSeconds: 5 },
    note: 'Worker 直接登录付呗并查询流水；登录态加密保存在 D1，不需要部署 Docker。',
  },

  pollReceipts({ account, state, fetchImpl }) {
    return queryWorkerFubei(account, state, fetchImpl);
  },
});
