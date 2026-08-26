/**
 * 通用管理表单字段。这些字段与具体收款平台无关（账号、密码、码牌图、分页大小之类），
 * 免费与付费插件都会用到，因此留在公开核心。
 *
 * 付费插件在私有仓库里编译时会把用到的字段整体打进自己的模块，
 * 所以这个文件必须保持零依赖，方便被单独 bundle。
 */

export const RECEIPT_QRCODE_FIELD = Object.freeze({
  key: 'receipt_qrcode_image', label: '码牌二维码', type: 'image',
});

/** 需要平台账号密码登录的收款插件的通用字段。 */
export const WATCHER_BASE_FIELDS = Object.freeze([
  { key: 'watcher_username', label: '平台登录账号', type: 'text' },
  { key: 'watcher_password', label: '平台登录密码', type: 'password', secret: true },
  {
    key: 'receipt_account_no', label: '商户号 / 收款账号标识', type: 'text',
    placeholder: '不知道可先留空，保存后查询最近流水',
    help: '用于限定商户范围；可从最近真实到账流水识别并回填。',
  },
  { key: 'receipt_merchant_name', label: '商户名称', type: 'text', placeholder: '选填' },
  {
    key: 'receipt_store_id', label: '门店 ID', type: 'text',
    placeholder: '不知道可先留空，保存后查询最近流水',
    help: '多门店时用于筛选；请填写平台流水实际返回的门店编号。',
  },
  {
    key: 'receipt_terminal_no', label: '收款终端号', type: 'text',
    placeholder: '不知道可先留空，保存后查询最近流水',
    help: '先让目标码牌真实收一笔小额款，再从最近流水复制终端号。',
  },
  {
    key: 'receipt_page_id', label: '流水页面 / 码牌 ID', type: 'text',
    placeholder: '一般留空；平台流水返回时可回填',
    help: '仅部分平台区分码牌或流水页面；没有返回值就保持空白。',
  },
  RECEIPT_QRCODE_FIELD,
  { key: 'receipt_watcher_page_size', label: '单次查询条数', type: 'number', min: 10, max: 500 },
]);

/** 打码平台账号。只有需要过图形验证码的平台才加这两项。 */
export const WATCHER_CAPTCHA_FIELDS = Object.freeze([
  { key: 'ttshitu_username', label: '图鉴账号', type: 'text' },
  { key: 'ttshitu_password', label: '图鉴密码', type: 'password', secret: true },
]);

/** 填了以后 Worker 可以直接查流水、无需 Docker 自动登录的凭据。 */
export const WATCHER_DIRECT_FIELDS = Object.freeze([
  { key: 'receipt_access_token', label: '平台 Access Token', type: 'password', secret: true },
  { key: 'receipt_cookie', label: '平台 Cookie', type: 'textarea', secret: true },
]);

/** 高级用法：直接覆盖流水接口地址与请求内容。 */
export const WATCHER_ADVANCED_FIELDS = Object.freeze([
  { key: 'receipt_query_url', label: '流水接口地址（高级）', type: 'text' },
  { key: 'receipt_query_method', label: '流水请求方法（高级）', type: 'select', options: [['GET', 'GET'], ['POST', 'POST']] },
  { key: 'receipt_query_headers', label: '附加请求头 JSON（高级）', type: 'textarea', secret: true },
  { key: 'receipt_query_body', label: '请求体 JSON（高级）', type: 'textarea', secret: true },
]);

/** 个人收款码（微信/支付宝个人码）共用的识别与对账字段。 */
export const PERSONAL_RECEIPT_FIELDS = Object.freeze([
  { key: 'receipt_match_mode', label: '识别模式', type: 'select', options: [['amount', '金额变动'], ['remark', '付款备注']] },
  { key: 'amount_offset_max', label: '金额偏移最大值（分）', type: 'number', min: 0, max: 99, placeholder: '默认 99，可留空' },
  { key: 'sms_forwarder_secret', label: 'SmsForwarder 密钥', type: 'password', secret: true },
  { key: 'sms_forwarder_time_tolerance', label: '通知时间容差（秒）', type: 'number', min: 30, max: 1800 },
]);
