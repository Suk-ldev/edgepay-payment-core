/**
 * 付呗收款（免费）。两种模式：
 * - 码牌：用户扫固定码牌手输金额，Worker 或 Docker 登录 e 站查流水，按金额偏移认领订单。
 * - 收款单（免输）：下单时 Worker 在 b 站建一张固定金额的收款单，按收款单号认领，只能由 Worker 跑。
 * 两种模式共用一份加密登录态：cookies 是 e 站会话，receipt_session 是 b 站会话。
 */

import { definePlugin } from '../../plugin-api.js';
import { RECEIPT_QRCODE_FIELD } from '../../admin-fields.js';
import { queryWorkerFubei } from './merchant-site.js';
import {
  billReceiptOf, isBillMode, matchBill, pollBills, prepareBill,
} from './bill-mode.js';

export { buildWorkerFubeiQuery, normalizeWorkerFubeiRecords, queryWorkerFubei } from './merchant-site.js';
export { gatewaySign } from './receipt-site.js';
export { normalizeBillPayments } from './bill-mode.js';

const PLATE_REQUIRED = ['watcher_username', 'watcher_password', 'receipt_terminal_no', 'receipt_qrcode_image'];
const BILL_REQUIRED = ['watcher_username', 'watcher_password'];

async function pollReceipts({ account, state = {}, fetchImpl }) {
  const orders = Array.isArray(account.orders) ? account.orders : [];
  const billOrders = orders.filter((order) => billReceiptOf(order));
  const plateOrders = orders.filter((order) => !billReceiptOf(order));
  let current = state;
  const records = [];
  const details = {};
  if (billOrders.length) {
    const bills = await pollBills({ account, orders: billOrders, state: current, fetchImpl });
    records.push(...bills.records);
    Object.assign(details, bills.details);
    current = bills.state;
  }
  if (plateOrders.length) {
    const plate = await queryWorkerFubei({ ...account, orders: plateOrders }, current, fetchImpl);
    records.push(...plate.records);
    Object.assign(details, plate.details);
    current = { ...current, ...plate.state };
  }
  return { records, state: current, details };
}

export const fubeiReceiptPlugin = definePlugin({
  manifest: {
    code: 'fubei_receipt',
    name: '付呗收款',
    version: '1.1.0',
    apiVersion: 1,
    tier: 'FREE',
    mode: 'channel-notify',
    runtime: 'hybrid',
    runtimeLabel: '码牌 Watcher + Worker，免输 Worker',
    payTypes: ['alipay', 'wxpay'],
    required: PLATE_REQUIRED,
    adminFields: [
      { key: 'watcher_username', label: '平台登录账号', type: 'text' },
      { key: 'watcher_password', label: '平台登录密码', type: 'password', secret: true },
      {
        key: 'receipt_bill_mode', label: '收款方式', type: 'select', defaultValue: 'plate',
        options: [['plate', '码牌（用户手输金额）'], ['bill', '收款单（免输金额，仅 Worker）']],
        help: '收款单模式下每笔订单自动在付呗建一张固定金额的收款单，不需要码牌、终端号，也不做金额偏移。',
      },
      {
        key: 'receipt_terminal_no', label: '收款终端号', type: 'text',
        placeholder: '不知道可先留空，保存后查询最近流水',
        help: '码牌模式必填。先让目标付呗码牌真实收一笔小额款，再从最近流水复制设备编号。',
      },
      {
        key: 'receipt_account_no', label: '门店 ID / 收款账号标识', type: 'text',
        placeholder: '选填，可从最近流水识别',
        help: '单门店通常可留空；多门店时填写流水中的门店编号。收款单模式会在这个门店下建单。',
      },
      { key: 'merchant_name', label: '码牌商户名', type: 'text', placeholder: '选填，用于区分多码牌' },
      { key: 'receipt_match_mode', label: '识别模式', type: 'select', options: [['amount', '金额变动'], ['remark', '付款备注']] },
      { key: 'amount_offset_max', label: '金额偏移最大值（分）', type: 'number', min: 0, max: 99, placeholder: '默认 99，可留空' },
      RECEIPT_QRCODE_FIELD,
    ],
    // 付呗登录态失效后要重新走一遍登录页 + 表单登录，比其它平台慢，租约给到 90 秒。
    poll: { leaseSeconds: 90, cooldownSeconds: 5 },
    note: 'Worker 直接登录付呗并查询流水；码牌模式也可交给 Docker，收款单模式每笔订单自动建单、只由 Worker 处理。登录态加密保存在 D1。',
    docs: `
      <p><strong>先选收款方式。</strong>"码牌"是用户扫固定码牌、手动输入金额；"收款单"是每笔订单自动在付呗建一张固定金额的收款单，用户扫码后不用输金额。</p>
      <h4>收款单模式（免输金额）</h4>
      <ol>
        <li>填写付呗商户后台的登录账号和<strong>原始密码</strong>，收款方式选"收款单"。不需要上传码牌、也不需要终端号。</li>
        <li>账号下只有一个门店可以不填门店 ID；多个门店时在"门店 ID"里填要收款的门店，保存时报错信息会列出可选门店。</li>
        <li>每笔订单会建一张只能付一笔、到订单过期时间自动截止的收款单，收银台展示付呗的收款码。微信必须<strong>扫码</strong>进入付款，直接打开链接会提示授权错误。</li>
        <li>这个模式只由 Worker 处理：下单时建单，之后轮询付款记录，按收款单号认领订单。部署了 Docker 也不会交给 Docker。</li>
        <li>首次使用前，请先用该账号在付呗新版后台登录一次，确认不需要签署协议或重置密码。</li>
      </ol>
      <h4>码牌模式</h4>
      <p><strong>终端号不用去猜，也不要填平台订单号。</strong>本插件可以从付呗最近成功流水里读取设备编号和门店编号，并直接回填配置。</p>
      <ol>
        <li>打开“插件配置 → 付呗收款”，先填写付呗商户后台的登录账号和<strong>原始密码</strong>。终端号暂时留空，点击保存；显示“配置未完整”是正常的。</li>
        <li>用准备接入的那块付呗码牌真实收一笔容易辨认的小额款，等付呗商户后台显示交易成功。不要用未支付订单，也不要只生成二维码。</li>
        <li>在付款后的 5 分钟内回到插件编辑区，点击“查询最近流水”。这次查询会故意忽略当前填写的终端号和门店号，避免错号把真实流水过滤掉。</li>
        <li>按到账时间、金额和支付方式找到刚才那笔，核对后点击右侧“填入编号”。流水里的 <code>device_no</code> 会填入“收款终端号”，<code>store_id</code> 会填入“门店 ID / 收款账号标识”；<code>order_sn</code> 是交易单号，不能当终端号。</li>
        <li>核对回填结果，上传这块码牌的实际二维码，选择识别模式并再次保存，然后启用插件。</li>
        <li>到“通道管理”新增通道。微信选择 <code>wxpay</code>，支付宝选择 <code>alipay</code>；两种都收时分别建立两个通道，再各做一笔小额测试。</li>
      </ol>
      <p>“查询最近流水”没有结果时：确认付款确实成功且发生在近 5 分钟内；确认登录账号能在付呗后台看到该门店流水；如提示登录失败，先在付呗后台检查密码、设备验证或风控状态，再重新保存账号密码。</p>
      <p>运行位置：码牌模式 Worker 可直接查询，部署了 Docker 时由 Docker 优先；收款单模式只在 Worker 运行。系统自动维护登录态并加密保存在 D1，不需要手工复制 Cookie、Token。</p>
    `,
  },

  missingFields(config) {
    const required = isBillMode(config) ? BILL_REQUIRED : PLATE_REQUIRED;
    return required.filter((key) => !config[key]);
  },

  workerOnly(config) {
    return isBillMode(config);
  },

  // 码牌模式返回 null，由核心生成通用收款码（金额偏移/付款备注）。
  prepareReceipt(context) {
    return isBillMode(context.config) ? prepareBill(context) : null;
  },

  // 码牌流水没有收款单号，matchBill 会返回 null，交回核心按金额匹配。
  matchReceipt(context) {
    return matchBill(context);
  },

  pollReceipts,
});
