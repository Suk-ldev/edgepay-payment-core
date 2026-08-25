const pluginBody = document.querySelector('#plugins-body');
const channelBody = document.querySelector('#channels-body');
const orderBody = document.querySelector('#orders-body');
const orderFilters = document.querySelector('#order-filters');
const ordersSummary = document.querySelector('#orders-summary');
const ordersPageState = document.querySelector('#orders-page-state');
const ordersPrevPage = document.querySelector('#orders-prev-page');
const ordersNextPage = document.querySelector('#orders-next-page');
const ordersPageSize = document.querySelector('#orders-page-size');
const pluginEditor = document.querySelector('#plugin-editor');
const pluginFields = document.querySelector('#plugin-fields');
const pluginForm = document.querySelector('#plugin-form');
const pluginFilters = document.querySelector('#plugin-filters');
const channelFilters = document.querySelector('#channel-filters');
const notice = document.querySelector('#admin-notice');
const orderDetailDialog = document.querySelector('#order-detail-dialog');
const orderDetailBody = document.querySelector('#order-detail-body');
const orderActionDialog = document.querySelector('#order-action-dialog');
const orderActionForm = document.querySelector('#order-action-form');
const channelCreateDialog = document.querySelector('#channel-create-dialog');
const channelCreateForm = document.querySelector('#channel-create-form');
const channelTestDialog = document.querySelector('#channel-test-dialog');
const channelTestForm = document.querySelector('#channel-test-form');
const channelTestRecords = document.querySelector('#channel-test-records');
const channelTestResult = document.querySelector('#channel-test-result');
const siteForm = document.querySelector('#site-form');
const keyResultDialog = document.querySelector('#key-result-dialog');
const versionUpdateDialog = document.querySelector('#version-update-dialog');
const licensePurchaseUrl = `https://${atob('bGljZW5zZS5pbXN1ay5jbg==')}`;
const orderFloatingMenu = document.createElement('div');
orderFloatingMenu.className = 'ui-order-menu';
orderFloatingMenu.setAttribute('role', 'menu');
orderFloatingMenu.hidden = true;
document.body.append(orderFloatingMenu);

let pluginForms = [];
let pluginsState = [];
let channelsState = [];
let channelPluginsState = [];
let ordersState = [];
let orderPagination = { total: 0, page: 1, pageSize: 20, pageCount: 0 };
const orderQuery = {
  page: 1,
  page_size: 20,
  search_field: 'all',
  keyword: '',
  plugin_code: '',
  status: '',
  callback_status: '',
};
let activePluginCode = '';
let activeOrderAction = null;
let activeTestChannel = null;
let contactUrl = `${location.origin}/contact`;
let pollTriggerUrl = '';
let noticeTimer;
const pluginQuery = { keyword: '', status: 'licensed' };
const channelQuery = { keyword: '', status: '' };
const ADMIN_SECTIONS = Object.freeze({
  site: '收银台设置',
  plugins: '插件配置',
  channels: '通道管理',
  orders: '支付订单',
  keys: '密钥管理',
  docs: '使用文档',
});
const activeAdminSection = (() => {
  const key = location.pathname.replace(/^\/admin\/?/u, '').replace(/\/+$/u, '');
  return Object.hasOwn(ADMIN_SECTIONS, key) ? key : 'site';
})();

function text(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function modeName(plugin) {
  return {
    direct: '官方直连',
    worker: 'Worker 内置',
    self: '自监听',
    hybrid: 'Worker / Docker',
    docker: 'Docker 监听',
  }[plugin.runtime] ?? ({ direct: '官方直连', 'channel-notify': '通道通知' }[plugin.mode] ?? plugin.mode);
}

function dateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? text(value)
    : parsed.toLocaleString('zh-CN', { hour12: false });
}

function showNotice(message, state = 'ok') {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.dataset.state = state;
  notice.classList.add('visible');
  noticeTimer = setTimeout(() => notice.classList.remove('visible'), 3200);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401) {
    location.replace('/admin/login');
    throw new Error('unauthorized');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const VERSION_UPDATE_SNOOZE_COOKIE = 'edgepay_version_update_snoozed';

function versionUpdateSnoozed() {
  return document.cookie.split('; ').includes(`${VERSION_UPDATE_SNOOZE_COOKIE}=1`);
}

function snoozeVersionUpdate() {
  // 会话级 Cookie：不设 Max-Age/Expires，浏览器关闭即失效，本次会话内不再弹升级提醒。
  document.cookie = `${VERSION_UPDATE_SNOOZE_COOKIE}=1; path=/; SameSite=Lax`;
}

function dismissVersionUpdate() {
  snoozeVersionUpdate();
  versionUpdateDialog.close();
}

async function checkVersionUpdate() {
  if (versionUpdateSnoozed()) return;
  try {
    const payload = await request('/admin/api/version');
    if (!payload.ok || !payload.update_available) return;
    document.querySelector('#version-update-message').textContent = `当前版本 ${payload.current_version}，最新版本 ${payload.latest_version}。`;
    document.querySelector('#version-update-confirm').onclick = () => location.assign(payload.deploy_url);
    versionUpdateDialog.showModal();
  } catch (error) {
    if (error.message === 'unauthorized') throw error;
  }
}

/**
 * 已购但没装进当前 Worker 的插件提示。
 *
 * 按权益出货之后，插件代码是部署时按 License 挑进包里的：撤销权益会在缓存 TTL 内
 * 立即失效，但**新买的插件要回 Deploy 站升级一次才会进包**。这里把这一步显式提示出来，
 * 并把域名带过去，避免客户买完在管理台里找不到而误以为没生效。
 */
function renderPendingInstall(pending, upgradeUrl, license) {
  const host = document.querySelector('#plugins-pending-install');
  if (!host) return;
  if (!pending.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  const names = pending.map((item) => text(item.name || item.code)).join('、');
  let link = '';
  if (upgradeUrl) {
    const url = new URL(upgradeUrl);
    // 只带域名，License 由客户在部署站自己粘贴，不放进管理台生成的链接里。
    if (license.domain) url.searchParams.set('domain', license.domain);
    url.searchParams.set('action', 'upgrade');
    link = `<a class="ui-button" href="${text(url.toString())}" target="_blank" rel="noopener">前往 Deploy 站升级</a>`;
  }
  host.hidden = false;
  host.innerHTML = `<div class="ui-alert ui-alert-warn">
    <div>
      <strong>你有 ${pending.length} 个已购插件尚未安装</strong>
      <p>${names}。这些插件已在你的授权里，但当前 Worker 里还没有它们的代码，需要重新部署一次才会生效。</p>
    </div>
    ${link}
  </div>`;
}

/** 插件运营文档。付费插件的文档随插件下发，所以只渲染当前实际装载的那些。 */
function renderPluginDocs(plugins) {
  const host = document.querySelector('#plugin-docs-dynamic');
  if (!host) return;
  const documented = plugins.filter((plugin) => plugin.docs);
  host.innerHTML = documented.map((plugin) => `<details data-plugin-doc="${text(plugin.code)}">
    <summary>${text(plugin.name)}（${text(plugin.code)}）</summary>
    <div class="ui-doc-body">${plugin.docs}</div>
  </details>`).join('');
  // 插件文档里预留的回调地址位（<code id="docs-xxx-webhook">）按当前域名填上。
  // 以前是给 PayPal/Stripe 各写一行硬编码，现在对任何带这种占位的插件都生效。
  for (const slot of host.querySelectorAll('[id^="docs-"][id$="-webhook"]')) {
    slot.textContent = `${location.origin}/api/pay/{通道ID}/notify`;
  }
}

function renderPlugins(plugins = pluginsState) {
  pluginsState = plugins;
  const keyword = pluginQuery.keyword.toLowerCase();
  const filtered = plugins.filter((plugin) => {
    const matchesKeyword = !keyword || [
      plugin.name,
      plugin.code,
      ...(plugin.payTypes ?? []),
    ].some((value) => String(value).toLowerCase().includes(keyword));
    const matchesStatus = !pluginQuery.status
      || (pluginQuery.status === 'licensed' && plugin.licensed)
      || (pluginQuery.status === 'unlicensed' && !plugin.licensed)
      || (pluginQuery.status === 'enabled' && plugin.licensed && plugin.enabled)
      || (pluginQuery.status === 'disabled' && plugin.licensed && !plugin.enabled)
      || (pluginQuery.status === 'incomplete' && plugin.licensed && !plugin.configured);
    return matchesKeyword && matchesStatus;
  });
  pluginBody.innerHTML = filtered.length ? filtered.map((plugin) => `<tr class="${plugin.licensed ? '' : 'ui-plugin-unlicensed'}">
    <td><strong>${text(plugin.name)}</strong><small>${text(plugin.code)}</small></td>
    <td>${text(plugin.payTypes.join(' / '))}</td>
    <td>${text(modeName(plugin))}</td>
    <td>${plugin.licensed ? `
      <label class="ui-plugin-toggle">
        <input type="checkbox" data-toggle-plugin="${text(plugin.code)}" ${plugin.enabled ? 'checked' : ''} />
        <span>${plugin.enabled ? '已启用' : '已停用'}</span>
      </label>
      <small class="${plugin.configured ? '' : 'danger-text'}">${plugin.configured ? '配置完整' : `缺少 ${text(plugin.missingFields.join('、'))}`}</small>
    ` : '<span class="ui-state missing">未购买</span><small>购买后才会开放配置和启用操作</small>'}</td>
    <td class="ui-description">${text(plugin.note)}</td>
    <td>${plugin.licensed
      ? `<button class="ui-row-action" type="button" data-edit-plugin="${text(plugin.code)}">配置</button>`
      : `<a class="ui-row-action" href="${licensePurchaseUrl}" target="_blank" rel="noopener">购买</a>`}</td>
  </tr>`).join('') : '<tr><td class="ui-empty" colspan="6">没有符合条件的插件</td></tr>';
}

function setImageUploadValue(container, value, previewFallback = '') {
  if (!container) return;
  const normalized = String(value ?? '');
  const input = container.querySelector('input[type="hidden"]');
  const image = container.querySelector('.ui-image-preview img');
  input.value = normalized;
  image.src = normalized || previewFallback;
  image.closest('.ui-image-preview').classList.toggle('empty', !image.src);
}

function renderSiteConfig(config, nextContactUrl = contactUrl, nextPollTriggerUrl = pollTriggerUrl) {
  contactUrl = String(nextContactUrl || `${location.origin}/contact`);
  pollTriggerUrl = String(nextPollTriggerUrl || '');
  document.querySelector('#site-merchant-name').value = String(config?.merchant_name ?? 'EdgePay');
  document.querySelector('#site-order-expire-minutes').value = String(config?.order_expire_minutes ?? 5);
  document.querySelector('#site-cashier-footer-html').value = String(config?.cashier_footer_html ?? '');
  document.querySelector('#site-contact-enabled').checked = Boolean(config?.contact_enabled);
  document.querySelector('#site-contact-title').value = String(config?.contact_title ?? '添加我的企业微信与我联系吧');
  document.querySelector('#site-contact-qr-label').value = String(config?.contact_qr_label ?? '手机微信扫码添加好友');
  document.querySelector('#site-contact-url').value = contactUrl;
  document.querySelector('#site-contact-open').href = contactUrl;
  document.querySelector('#docs-contact-url').textContent = contactUrl;
  document.querySelector('#docs-wechat-notify').textContent = `${location.origin}/api/pay/{通道ID}/notify`;
  const pollTriggerText = pollTriggerUrl || '尚未配置轮询触发 Token';
  document.querySelector('#docs-receipt-poll').textContent = pollTriggerText;
  const activePollUrl = document.querySelector('#docs-receipt-poll-active');
  if (activePollUrl) activePollUrl.textContent = pollTriggerText;
  setImageUploadValue(
    siteForm.querySelector('[data-image-upload="contact_avatar_image"]'),
    config?.contact_avatar_image,
    '/contact/default-avatar.png',
  );
  setImageUploadValue(
    siteForm.querySelector('[data-image-upload="contact_qrcode_image"]'),
    config?.contact_qrcode_image,
  );
}

async function saveSiteConfig(event) {
  event.preventDefault();
  const button = document.querySelector('#save-site');
  const data = new FormData(siteForm);
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const response = await request('/admin/api/site', {
      method: 'PUT',
      body: JSON.stringify({
        merchant_name: data.get('merchant_name'),
        order_expire_minutes: Number(data.get('order_expire_minutes')),
        cashier_footer_html: data.get('cashier_footer_html'),
        contact_enabled: data.get('contact_enabled') === 'on',
        contact_title: data.get('contact_title'),
        contact_qr_label: data.get('contact_qr_label'),
        contact_avatar_image: data.get('contact_avatar_image'),
        contact_qrcode_image: data.get('contact_qrcode_image'),
      }),
    });
    renderSiteConfig(response.config, response.contact_url, response.poll_trigger_url);
    showNotice('收银台设置已保存');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '保存收银台设置';
  }
}

function renderChannels(channels) {
  channelsState = channels.map((channel) => ({ ...channel }));
  channelBody.innerHTML = channels.map((channel) => `<tr data-channel-id="${text(channel.id)}">
    <td><strong>#${text(channel.id)}</strong></td>
    <td>${text(channel.name)}</td>
    <td><small>${text(channel.plugin_code)}</small></td>
    <td><label class="ui-inline-field ui-channel-pay-type-field"><span class="sr-only">通道 ${text(channel.id)} 支付方式</span><select class="channel-pay-type">${(channel.available_pay_types ?? channel.pay_types).map((payType) => `<option value="${text(payType)}" ${channel.pay_types[0] === payType ? 'selected' : ''}>${text(payType)}</option>`).join('')}</select></label></td>
    <td><label class="ui-inline-field"><span class="sr-only">通道 ${text(channel.id)} 权重</span><input class="channel-weight" type="number" min="0" max="100000" step="1" value="${text(channel.weight)}" /></label><small>相同类型按权重随机</small></td>
    <td><label class="ui-inline-field ui-inline-field--expire"><span class="sr-only">通道 ${text(channel.id)} 订单有效期</span><input class="channel-expire" type="number" min="1" max="1440" step="1" value="${channel.order_expire_minutes == null ? '' : text(channel.order_expire_minutes)}" placeholder="继承全局" /></label><small>${channel.order_expire_minutes == null ? '继承收银台设置' : '分钟'}</small></td>
    <td><label class="ui-channel-toggle"><input class="channel-enabled" type="checkbox" ${channel.enabled ? 'checked' : ''} /><span>${channel.enabled ? '启用' : '停用'}</span></label>${channel.plugin_enabled ? '' : '<small class="danger-text">插件已停用</small>'}</td>
    <td><button class="ui-row-action" type="button" data-test-channel="${text(channel.id)}" ${channel.enabled && channel.plugin_enabled ? '' : 'disabled'}>测试</button></td>
  </tr>`).join('');
  applyChannelFilters();
}

function channelRowsState() {
  return channelsState.map((channel) => {
    const row = channelBody.querySelector(`[data-channel-id="${CSS.escape(String(channel.id))}"]`);
    if (!row) throw new Error(`通道 #${channel.id} 无法读取`);
    const expireValue = row.querySelector('.channel-expire').value.trim();
    const payType = row.querySelector('.channel-pay-type').value;
    if (!payType) throw new Error(`通道 #${channel.id} 必须选择支付方式`);
    return {
      ...channel,
      pay_types: [payType],
      weight: Number(row.querySelector('.channel-weight').value),
      order_expire_minutes: expireValue === '' ? null : Number(expireValue),
      enabled: row.querySelector('.channel-enabled').checked,
    };
  });
}

function selectedChannelCreatePlugin() {
  const code = document.querySelector('#channel-create-plugin').value;
  return channelPluginsState.find((plugin) => plugin.code === code) ?? null;
}

function syncChannelCreatePayTypes({ suggestName = false } = {}) {
  const plugin = selectedChannelCreatePlugin();
  const payTypeSelect = document.querySelector('#channel-create-pay-type');
  const previous = payTypeSelect.value;
  payTypeSelect.innerHTML = (plugin?.pay_types ?? [])
    .map((payType) => `<option value="${text(payType)}">${text(payType)}</option>`)
    .join('');
  if ((plugin?.pay_types ?? []).includes(previous)) payTypeSelect.value = previous;
  if (suggestName && plugin && !document.querySelector('#channel-create-name').value.trim()) {
    document.querySelector('#channel-create-name').value = `${plugin.name} · ${payTypeSelect.value}`;
  }
}

function openChannelCreate() {
  if (!channelPluginsState.length) {
    showNotice('没有可用于创建通道的支付插件', 'error');
    return;
  }
  channelCreateForm.reset();
  const pluginSelect = document.querySelector('#channel-create-plugin');
  pluginSelect.innerHTML = channelPluginsState.map((plugin) => (
    `<option value="${text(plugin.code)}">${text(plugin.name)}${plugin.enabled ? '' : '（插件已停用）'}</option>`
  )).join('');
  pluginSelect.value = (channelPluginsState.find((plugin) => plugin.enabled) ?? channelPluginsState[0]).code;
  document.querySelector('#channel-create-name').value = '';
  syncChannelCreatePayTypes({ suggestName: true });
  channelCreateDialog.showModal();
}

async function createChannel(event) {
  event.preventDefault();
  const data = new FormData(channelCreateForm);
  const plugin = selectedChannelCreatePlugin();
  const payType = String(data.get('pay_type') ?? '');
  if (!plugin || !plugin.pay_types.includes(payType)) {
    showNotice('请选择插件支持的支付方式', 'error');
    return;
  }
  const current = channelRowsState();
  const nextId = Math.max(0, ...current.map((channel) => Number(channel.id) || 0)) + 1;
  const nextSort = Math.max(-1, ...current.map((channel) => Number(channel.sort) || 0)) + 1;
  const expireValue = String(data.get('order_expire_minutes') ?? '').trim();
  const created = {
    id: nextId,
    name: String(data.get('name') ?? '').trim(),
    plugin_code: plugin.code,
    pay_types: [payType],
    weight: Number(data.get('weight')),
    order_expire_minutes: expireValue === '' ? null : Number(expireValue),
    enabled: data.get('enabled') === 'on',
    sort: nextSort,
  };
  const button = document.querySelector('#channel-create-submit');
  button.disabled = true;
  button.textContent = '正在新增…';
  try {
    const response = await request('/admin/api/channels', {
      method: 'PUT',
      body: JSON.stringify({ channels: [...current, created] }),
    });
    channelPluginsState = response.plugins ?? channelPluginsState;
    renderChannels(response.results);
    channelCreateDialog.close();
    showNotice(`支付通道 #${nextId} 已新增`);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '新增通道';
  }
}

function applyChannelFilters() {
  const keyword = channelQuery.keyword.toLowerCase();
  for (const row of channelBody.querySelectorAll('[data-channel-id]')) {
    const channel = channelsState.find((candidate) => String(candidate.id) === row.dataset.channelId);
    if (!channel) continue;
    const matchesKeyword = !keyword || [
      channel.id,
      channel.name,
      channel.plugin_code,
      ...(channel.pay_types ?? []),
    ].some((value) => String(value).toLowerCase().includes(keyword));
    const matchesStatus = !channelQuery.status
      || (channelQuery.status === 'enabled' && channel.enabled && channel.plugin_enabled)
      || (channelQuery.status === 'disabled' && !channel.enabled)
      || (channelQuery.status === 'plugin_disabled' && !channel.plugin_enabled);
    row.hidden = !matchesKeyword || !matchesStatus;
  }
}

function channelTestStatus(status) {
  return {
    PAYING: '待支付',
    PAID: '成功',
    FAILED: '失败',
    EXPIRED: '超时',
    CLOSED: '关闭',
    PENDING: '待创建',
  }[status] ?? status;
}

function renderChannelTestRecords(records) {
  channelTestRecords.innerHTML = records.length ? records.map((record) => `<tr>
    <td><strong>${text(record.external_order_no)}</strong><small>${text(record.payment_no)}</small></td>
    <td><strong class="ui-order-amount">¥${text(record.money)}</strong></td>
    <td><span class="ui-state status-${text(String(record.status).toLowerCase())}">${text(channelTestStatus(record.status))}</span>${record.provider_error ? `<small class="danger-text">${text(record.provider_error)}</small>` : ''}</td>
    <td>${dateTime(record.created_at)}</td>
    <td><a class="ui-channel-test-link" href="${text(record.payment_page_path)}" target="_blank" rel="noopener">打开支付页</a></td>
  </tr>`).join('') : '<tr><td colspan="5" class="ui-empty">当前通道暂无测试记录</td></tr>';
}

async function loadChannelTestRecords(channelId) {
  channelTestRecords.innerHTML = '<tr><td colspan="5" class="ui-empty">正在读取测试记录…</td></tr>';
  try {
    const payload = await request(`/admin/api/channels/${encodeURIComponent(channelId)}/test-records`);
    renderChannelTestRecords(payload.results ?? []);
  } catch (error) {
    channelTestRecords.innerHTML = `<tr><td colspan="5" class="ui-empty">${text(error.message)}</td></tr>`;
  }
}

function syncChannelTestProductFields() {
  const isWechat = activeTestChannel?.plugin_code === 'wechat_api';
  const wechatProduct = document.querySelector('#channel-test-wechat-product').value;
  document.querySelector('#channel-test-wechat-product-field').hidden = !isWechat;
  document.querySelector('#channel-test-wechat-openid-field').hidden = !isWechat
    || !['auto', 'mp'].includes(wechatProduct);
  document.querySelector('#channel-test-wechat-mini-openid-field').hidden = !isWechat
    || wechatProduct !== 'mini';

  const isAlipay = activeTestChannel?.plugin_code === 'alipay_api';
  const alipayProduct = document.querySelector('#channel-test-alipay-product').value;
  document.querySelector('#channel-test-alipay-product-field').hidden = !isAlipay;
  document.querySelector('#channel-test-alipay-auth-code-field').hidden = !isAlipay
    || alipayProduct !== 'pos';
  document.querySelector('#channel-test-alipay-mini-app-id-field').hidden = !isAlipay
    || alipayProduct !== 'mini';
  document.querySelector('#channel-test-alipay-buyer-open-id-field').hidden = !isAlipay
    || alipayProduct !== 'mini';
  document.querySelector('#channel-test-alipay-buyer-id-field').hidden = !isAlipay
    || alipayProduct !== 'mini';
}

function openChannelTest(channel) {
  activeTestChannel = channel;
  document.querySelector('#channel-test-title').textContent = `测试通道 · ${channel.name}`;
  document.querySelector('#channel-test-id').value = channel.id;
  document.querySelector('#channel-test-pay-type').innerHTML = channel.pay_types
    .map((payType) => `<option value="${text(payType)}">${text(payType)}</option>`)
    .join('');
  document.querySelector('#channel-test-money').value = '1.00';
  document.querySelector('#channel-test-name').value = '支付测试';
  document.querySelector('#channel-test-device').value = 'auto';
  document.querySelector('#channel-test-wechat-product').value = 'auto';
  document.querySelector('#channel-test-wechat-openid').value = '';
  document.querySelector('#channel-test-wechat-mini-openid').value = '';
  document.querySelector('#channel-test-alipay-product').value = 'auto';
  document.querySelector('#channel-test-alipay-auth-code').value = '';
  document.querySelector('#channel-test-alipay-mini-app-id').value = '';
  document.querySelector('#channel-test-alipay-buyer-open-id').value = '';
  document.querySelector('#channel-test-alipay-buyer-id').value = '';
  document.querySelector('#channel-test-notify-url').value = '';
  document.querySelector('#channel-test-return-url').value = '';
  syncChannelTestProductFields();
  channelTestResult.hidden = true;
  channelTestResult.innerHTML = '';
  channelTestDialog.showModal();
  loadChannelTestRecords(channel.id);
  requestAnimationFrame(() => document.querySelector('#channel-test-money').focus());
}

function closeChannelTest() {
  channelTestDialog.close();
  activeTestChannel = null;
}

async function createChannelTest(event) {
  event.preventDefault();
  if (!activeTestChannel) return;
  const submit = document.querySelector('#channel-test-submit');
  const pendingWindow = window.open('', `channel_test_${activeTestChannel.id}_${Date.now()}`);
  if (pendingWindow) {
    pendingWindow.document.title = '正在创建测试订单';
    pendingWindow.document.body.textContent = '正在创建测试订单，请稍候…';
  }
  submit.disabled = true;
  submit.textContent = '正在创建…';
  channelTestResult.hidden = true;
  try {
    const data = new FormData(channelTestForm);
    const payload = await request(`/admin/api/channels/${encodeURIComponent(activeTestChannel.id)}/test`, {
      method: 'POST',
      body: JSON.stringify({
        money: data.get('money'),
        name: data.get('name'),
        pay_type: data.get('pay_type'),
        device: data.get('device'),
        wechat_product: data.get('wechat_product'),
        alipay_product: data.get('alipay_product'),
        openid: data.get('openid'),
        mini_openid: data.get('mini_openid'),
        auth_code: data.get('auth_code'),
        sub_appid: data.get('sub_appid'),
        buyer_open_id: data.get('buyer_open_id'),
        buyer_id: data.get('buyer_id'),
        notify_url: data.get('notify_url'),
        return_url: data.get('return_url'),
      }),
    });
    if (pendingWindow) {
      pendingWindow.opener = null;
      pendingWindow.location.replace(payload.payment_page_url);
    }
    channelTestResult.innerHTML = `<strong>测试订单已创建</strong><span>${text(payload.external_order_no)} · ¥${text(payload.money)}</span><a href="${text(payload.payment_page_url)}" target="_blank" rel="noopener">打开支付页</a>${pendingWindow ? '' : '<small>浏览器拦截了新窗口，请点击上方链接。</small>'}`;
    channelTestResult.hidden = false;
    showNotice('测试订单已创建，支付页已打开');
    await Promise.all([loadChannelTestRecords(activeTestChannel.id), load({ keepEditor: Boolean(activePluginCode) })]);
  } catch (error) {
    if (pendingWindow) pendingWindow.close();
    showNotice(error.message, 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = '生成测试订单';
  }
}

function orderStateClass(prefix, value) {
  return `${prefix}-${String(value || 'none').toLowerCase().replaceAll('_', '-')}`;
}

function renderOrderPluginOptions(plugins = []) {
  const select = document.querySelector('#order-plugin-filter');
  const selected = select.value || orderQuery.plugin_code;
  select.innerHTML = '<option value="">全部插件</option>'
    + plugins.map((plugin) => `<option value="${text(plugin.code)}">${text(plugin.name)}</option>`).join('');
  select.value = selected;
}

function renderOrderPagination(payload) {
  orderPagination = {
    total: Number(payload.total ?? 0),
    page: Number(payload.page ?? 1),
    pageSize: Number(payload.page_size ?? 20),
    pageCount: Number(payload.page_count ?? 0),
  };
  orderQuery.page = orderPagination.page;
  orderQuery.page_size = orderPagination.pageSize;
  ordersSummary.textContent = orderPagination.total
    ? `共 ${orderPagination.total} 笔订单，当前显示第 ${orderPagination.page} 页`
    : '没有符合条件的订单';
  ordersPageState.textContent = orderPagination.pageCount
    ? `第 ${orderPagination.page} / ${orderPagination.pageCount} 页`
    : '第 0 / 0 页';
  ordersPageSize.value = String(orderPagination.pageSize);
  ordersPrevPage.disabled = orderPagination.page <= 1;
  ordersNextPage.disabled = orderPagination.pageCount === 0
    || orderPagination.page >= orderPagination.pageCount;
}

function renderOrders(payload) {
  const orders = payload.results ?? [];
  ordersState = orders;
  renderOrderPluginOptions(payload.plugins);
  renderOrderPagination(payload);
  orderBody.innerHTML = orders.length ? orders.map((order) => {
    const enabledActions = (order.actions ?? []).filter((action) => action.enabled);
    const menu = enabledActions.length
      ? `<button class="ui-order-more-button" type="button" data-order-menu="${text(order.payment_no)}" aria-haspopup="menu" aria-expanded="false">更多</button>`
      : '';
    return `<tr>
      <td><strong>${text(order.external_order_no)}${order.is_test_order ? '<span class="ui-test-order-tag">测试</span>' : ''}</strong><small>${text(order.payment_no)}</small></td>
      <td><strong>${text(order.plugin_name)}</strong><small>${text(order.plugin_code)}</small></td>
      <td><strong class="ui-order-amount">¥${text(order.amount_text)}</strong></td>
      <td><span class="ui-state status-${String(order.status).toLowerCase()}">${text(order.status_text)}</span>${order.is_frozen ? '<small class="ui-frozen-note">已冻结</small>' : ''}</td>
      <td><span class="ui-state ${orderStateClass('callback', order.callback_status)}">${text(order.callback_status_text)}</span></td>
      <td><strong>${text(order.callback_times)}</strong><small>${order.callback?.kind === 'listener' ? '监听事件' : '上游回调'}</small></td>
      <td><span class="ui-state ${orderStateClass('notify', order.notify_status)}">${text(order.notify_status_text)}</span><small>${Number(order.notify_attempts) ? `${text(order.notify_attempts)} 次尝试` : (order.has_notify_url ? '尚未尝试' : '未配置地址')}</small></td>
      <td><strong>${text(order.listener_source?.label || '尚未确认')}</strong>${order.listener_source?.code ? `<small>${text(order.listener_source.code)}</small>` : ''}</td>
      <td><strong>¥${text(order.refundable_amount_text)}</strong>${Number(order.reserved_refund_fen) > 0 ? `<small>已退 / 占用 ¥${(Number(order.reserved_refund_fen) / 100).toFixed(2)}</small>` : ''}</td>
      <td>${dateTime(order.created_at)}</td>
      <td><div class="ui-order-actions"><button class="ui-order-view" type="button" data-view-order="${text(order.payment_no)}">查看</button>${menu}</div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="11" class="ui-empty">暂无订单</td></tr>';
}

function orderRequestPath() {
  const search = new URLSearchParams();
  Object.entries(orderQuery).forEach(([key, value]) => {
    if (value !== '') search.set(key, String(value));
  });
  return `/admin/api/orders?${search.toString()}`;
}

async function loadOrders() {
  ordersSummary.textContent = '正在读取订单…';
  const payload = await request(orderRequestPath());
  renderOrders(payload);
}

function closeOrderMenu() {
  orderFloatingMenu.hidden = true;
  orderFloatingMenu.innerHTML = '';
  document.querySelectorAll('[data-order-menu][aria-expanded="true"]').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

function openOrderMenu(button, order) {
  const actions = (order.actions ?? []).filter((action) => action.enabled);
  orderFloatingMenu.innerHTML = actions.map((action) => `<button type="button" role="menuitem" class="${action.danger ? 'danger' : ''}" data-order-action="${text(action.code)}" data-payment-no="${text(order.payment_no)}">${text(action.label)}</button>`).join('');
  orderFloatingMenu.hidden = false;
  orderFloatingMenu.style.visibility = 'hidden';
  const trigger = button.getBoundingClientRect();
  const menu = orderFloatingMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - menu.width - 8, trigger.right - menu.width));
  const below = trigger.bottom + 5;
  const top = below + menu.height <= window.innerHeight - 8
    ? below
    : Math.max(8, trigger.top - menu.height - 5);
  orderFloatingMenu.style.left = `${left}px`;
  orderFloatingMenu.style.top = `${top}px`;
  orderFloatingMenu.style.visibility = 'visible';
  button.setAttribute('aria-expanded', 'true');
}

function refundStatusName(status) {
  return {
    CREATED: '待创建',
    PROCESSING: '处理中',
    SUCCEEDED: '成功',
    FAILED: '失败',
    CLOSED: '关闭',
  }[status] ?? status;
}

function detailEmpty(message) {
  return `<p class="ui-dialog-empty">${text(message)}</p>`;
}

function detailJson(value, label = '查看数据') {
  const meaningful = value && typeof value === 'object' && Object.keys(value).length;
  if (!meaningful) return '';
  return `<details class="ui-detail-json"><summary>${text(label)}</summary><pre>${text(JSON.stringify(value, null, 2))}</pre></details>`;
}

function detailState(status, label) {
  return `<span class="ui-state ${orderStateClass('detail', status)}">${text(label || status || '未知')}</span>`;
}

function renderReceiptEvents(events, kind) {
  const listener = kind === 'listener';
  if (!events.length) return detailEmpty(listener ? '暂无收款监听记录' : '暂无上游回调记录');
  return `<div class="ui-detail-list">${events.map((event) => `<article>
    <div><strong>${text(event.source?.label || (listener ? '收款监听' : '上游回调'))}</strong>${detailState(event.state, event.state_text)}</div>
    <small>${text(event.event_id)} · 接收 ${dateTime(event.received_at)}${event.processed_at ? ` · 完成 ${dateTime(event.processed_at)}` : ''}</small>
    <dl class="ui-event-meta">
      <div><dt>金额</dt><dd>${event.amount_fen ? `¥${text(event.amount_text)}` : '—'}</dd></div>
      <div><dt>上游流水</dt><dd>${text(event.provider_trade_no || '—')}</dd></div>
      ${event.reason ? `<div><dt>处理说明</dt><dd>${text(event.reason)}</dd></div>` : ''}
    </dl>
    ${detailJson(event.payload, '查看脱敏请求数据')}
  </article>`).join('')}</div>`;
}

function renderNotificationTasks(tasks) {
  if (!tasks.length) return detailEmpty('当前订单尚未生成商户通知任务');
  return `<div class="ui-detail-list">${tasks.map((task) => `<article>
    <div><strong>${text(task.notify_url)}</strong>${detailState(task.status, task.status_text)}</div>
    <small>已尝试 ${text(task.attempts)} 次 · 创建 ${dateTime(task.created_at)}${task.sent_at ? ` · 送达 ${dateTime(task.sent_at)}` : ` · 下次 ${dateTime(task.next_attempt_at)}`}</small>
    ${task.last_error ? `<p class="danger-text">${text(task.last_error)}</p>` : ''}
    ${detailJson(task.payload, '查看脱敏通知参数')}
  </article>`).join('')}</div>`;
}

function renderTimeline(events) {
  if (!events.length) return detailEmpty('暂无订单时间线');
  return `<ol class="ui-order-timeline">${events.map((event) => `<li data-event-type="${text(event.type)}">
    <time>${dateTime(event.at)}</time>
    <div>
      <span class="ui-timeline-type">${text(event.type_text)}</span>
      <strong>${text(event.title)}</strong>
      ${detailState(event.status, event.status_text)}
      ${event.description ? `<p>${text(event.description)}</p>` : ''}
      ${event.source_no ? `<small>${text(event.source_no)}</small>` : ''}
    </div>
  </li>`).join('')}</ol>`;
}

function renderOrderDetails(payload) {
  const order = payload.order;
  const refunds = payload.refunds ?? [];
  const operations = payload.operations ?? [];
  const receiptEvents = payload.receipt_events ?? [];
  const callbackEvents = payload.callback_events ?? [];
  const notificationTasks = payload.notification_tasks ?? [];
  const timeline = payload.timeline ?? [];
  const listenerSource = order.listener_source ?? {};
  const tabs = [
    ['overview', '概览', ''],
    ['timeline', '时间线', timeline.length],
    ['listener', '收款监听', receiptEvents.length],
    ['callback', '上游回调', callbackEvents.length],
    ['notification', '商户通知', notificationTasks.length],
    ['refund', '退款', refunds.length],
    ['operation', '操作记录', operations.length],
  ];
  return `<nav class="ui-detail-tabs" role="tablist" aria-label="订单详情分区">
    ${tabs.map(([key, label, count], index) => `<button type="button" role="tab" data-order-tab="${key}" aria-selected="${index === 0 ? 'true' : 'false'}">${label}${count === '' ? '' : `<span>${text(count)}</span>`}</button>`).join('')}
  </nav>
  <section class="ui-detail-panel" data-order-panel="overview" role="tabpanel">
    <div class="ui-detail-grid">
      <section><span>商户订单</span><strong>${text(order.external_order_no)}</strong><small>${text(order.payment_no)}</small></section>
      <section><span>支付通道</span><strong>${text(order.plugin_name)}</strong><small>${text(order.plugin_code)}</small></section>
      <section><span>支付金额</span><strong>¥${text(order.amount_text)}</strong><small>可退 ¥${text(order.refundable_amount_text)}</small></section>
      <section><span>订单状态</span><strong>${text(order.status_text)}${order.is_frozen ? ' · 已冻结' : ''}</strong><small>${order.paid_at ? dateTime(order.paid_at) : `有效至 ${dateTime(order.expires_at)}`}</small></section>
      <section><span>回调状态</span><strong>${text(order.callback_status_text)}</strong><small>累计 ${text(order.callback_times)} 次</small></section>
      <section><span>商户通知</span><strong>${text(order.notify_status_text)}</strong><small>${text(order.notify_attempts)} 次尝试</small></section>
    </div>
    <section class="ui-detail-section">
      <h3>订单链路</h3>
      <dl>
        <div><dt>上游流水</dt><dd>${text(order.provider_trade_no || '—')}</dd></div>
        <div><dt>监听来源</dt><dd>${text(listenerSource.label || '尚未确认')}${listenerSource.received_at ? ` · ${dateTime(listenerSource.received_at)}` : ''}</dd></div>
        ${order.provider_callback_url ? `<div><dt>上游回调地址</dt><dd>${text(order.provider_callback_url)}</dd></div>` : ''}
        <div><dt>通知地址</dt><dd>${text(order.notify_url || '未配置')}</dd></div>
        ${order.notify_last_error ? `<div><dt>通知错误</dt><dd class="danger-text">${text(order.notify_last_error)}</dd></div>` : ''}
        ${order.freeze_reason ? `<div><dt>冻结原因</dt><dd class="danger-text">${text(order.freeze_reason)}</dd></div>` : ''}
      </dl>
    </section>
    <section class="ui-detail-danger-zone">
      <div><strong>删除订单</strong><p>同时删除这笔订单的回调、通知、退款和操作记录，释放 D1 空间。</p></div>
      <button type="button" data-delete-order="${text(order.payment_no)}">删除订单</button>
    </section>
  </section>
  <section class="ui-detail-panel" data-order-panel="timeline" role="tabpanel" hidden>${renderTimeline(timeline)}</section>
  <section class="ui-detail-panel" data-order-panel="listener" role="tabpanel" hidden>${renderReceiptEvents(receiptEvents, 'listener')}</section>
  <section class="ui-detail-panel" data-order-panel="callback" role="tabpanel" hidden>${renderReceiptEvents(callbackEvents, 'callback')}</section>
  <section class="ui-detail-panel" data-order-panel="notification" role="tabpanel" hidden>${renderNotificationTasks(notificationTasks)}</section>
  <section class="ui-detail-panel" data-order-panel="refund" role="tabpanel" hidden>
    ${refunds.length ? `<div class="ui-detail-list">${refunds.map((refund) => `<article><div><strong>¥${text(refund.refund_amount_text)}</strong>${detailState(refund.status, `${refund.method === 'API' ? 'API 退款' : '手动退款'} · ${refundStatusName(refund.status)}`)}</div><small>${text(refund.refund_no)} · ${dateTime(refund.created_at)}</small>${refund.last_error ? `<p class="danger-text">${text(refund.last_error)}</p>` : ''}${detailJson(refund.provider_result, '查看脱敏通道结果')}</article>`).join('')}</div>` : detailEmpty('暂无退款记录')}
  </section>
  <section class="ui-detail-panel" data-order-panel="operation" role="tabpanel" hidden>
    ${operations.length ? `<div class="ui-detail-list">${operations.map((operation) => `<article><div><strong>${text(operation.result_message || operation.action)}</strong>${detailState(operation.result_status, operation.result_status === 'success' ? '成功' : operation.result_status)}</div><small>${dateTime(operation.created_at)}${operation.reason ? ` · ${text(operation.reason)}` : ''}</small>${detailJson(operation.result, '查看脱敏操作结果')}</article>`).join('')}</div>` : detailEmpty('暂无后台操作记录')}
  </section>`;
}

function activateOrderDetailTab(name) {
  orderDetailBody.querySelectorAll('[data-order-tab]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.orderTab === name));
  });
  orderDetailBody.querySelectorAll('[data-order-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.orderPanel !== name;
  });
}

async function openOrderDetails(paymentNo) {
  orderDetailBody.innerHTML = '<p class="ui-dialog-loading">正在读取订单…</p>';
  orderDetailDialog.showModal();
  try {
    orderDetailBody.innerHTML = renderOrderDetails(await request(`/admin/api/orders/${encodeURIComponent(paymentNo)}`));
  } catch (error) {
    orderDetailBody.innerHTML = `<p class="ui-dialog-empty">${text(error.message)}</p>`;
  }
}

function actionSummary(order, action) {
  const prefix = `${order.external_order_no} · ¥${order.amount_text}`;
  const messages = {
    manual_success: `${prefix}。确认已实际收款后，将订单补为成功并通知商户。`,
    api_refund: `${prefix}。退款会立即请求原支付通道，提交后不可撤销。`,
    manual_refund: `${prefix}。仅登记已经在线下完成的退款，不会调用支付通道。`,
    freeze: `${prefix}。冻结后将禁止补单、查单、重新通知和退款。`,
    unfreeze: `${prefix}。解冻后恢复订单后台操作。`,
  };
  return messages[action.code] ?? `${prefix}。确认执行“${action.label}”？`;
}

function openOrderAction(order, action) {
  activeOrderAction = { order, action };
  document.querySelector('#order-action-title').textContent = action.label;
  document.querySelector('#order-action-summary').textContent = actionSummary(order, action);
  const amountField = document.querySelector('#order-action-amount-field');
  const reasonField = document.querySelector('#order-action-reason-field');
  const money = document.querySelector('#order-action-money');
  const reason = document.querySelector('#order-action-reason');
  amountField.hidden = !action.requires_amount;
  reasonField.hidden = !action.requires_reason;
  money.required = Boolean(action.requires_amount);
  reason.required = Boolean(action.requires_reason);
  money.value = action.requires_amount ? order.refundable_amount_text : '';
  reason.value = '';
  document.querySelector('#order-action-remaining').textContent = action.requires_amount
    ? `当前最多可退 ¥${order.refundable_amount_text}`
    : '';
  const submit = document.querySelector('#order-action-submit');
  submit.textContent = `确认${action.label}`;
  submit.classList.toggle('danger', Boolean(action.danger));
  orderActionDialog.showModal();
  requestAnimationFrame(() => (action.requires_amount ? money : reason).focus());
}

async function runOrderAction(order, action, body = {}) {
  const response = await request(`/admin/api/orders/${encodeURIComponent(order.payment_no)}/${encodeURIComponent(action.code)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  showNotice(response.message);
  await load({ keepEditor: Boolean(activePluginCode) });
}

function optionMarkup(field, selectedValue) {
  return (field.options ?? []).map(([value, label]) => {
    return `<option value="${text(value)}" ${String(selectedValue) === String(value) ? 'selected' : ''}>${text(label)}</option>`;
  }).join('');
}

function imageUploadMarkup(field, inputId) {
  const value = String(field.value ?? '');
  const image = value
    ? `<img src="${text(value)}" alt="${text(field.label)}预览" />`
    : '<img alt="" />';
  return `<div class="ui-config-field ui-config-wide">
    <span>${text(field.label)}</span>
    <div class="ui-image-upload" data-image-upload="${text(field.key)}" data-image-kind="qrcode">
      <div class="ui-image-preview ui-qrcode-preview ${value ? '' : 'empty'}">${image}</div>
      <input id="${inputId}" name="${text(field.key)}" type="hidden" value="${text(value)}" />
      <input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" />
      <div><button type="button" data-upload-image>上传图片</button><button type="button" data-remove-image>${field.placeholder ? '恢复默认' : '移除'}</button></div>
    </div>
    <small>支持 PNG、JPEG、WebP；上传后会在浏览器内压缩并显示预览。</small>
  </div>`;
}

function fieldMarkup(field) {
  const inputId = `plugin-field-${field.key}`;
  const configuredNote = field.secret && field.configured ? '<small>已配置，留空保留原值</small>' : '';
  if (field.type === 'image') return imageUploadMarkup(field, inputId);
  if (field.type === 'textarea') {
    return `<label class="ui-config-field ui-config-wide" for="${inputId}"><span>${text(field.label)}</span><textarea id="${inputId}" name="${text(field.key)}" rows="4" ${field.secret ? 'autocomplete="new-password"' : ''} placeholder="${field.secret && field.configured ? '已配置，留空不修改' : text(field.placeholder ?? '')}">${field.secret ? '' : text(field.value)}</textarea>${configuredNote}</label>`;
  }
  if (field.type === 'select') {
    return `<label class="ui-config-field" for="${inputId}"><span>${text(field.label)}</span><select id="${inputId}" name="${text(field.key)}">${optionMarkup(field, field.value)}</select></label>`;
  }
  if (field.type === 'multiselect') {
    const selected = new Set(Array.isArray(field.value) ? field.value.map(String) : []);
    return `<fieldset class="ui-config-field ui-config-wide"><legend>${text(field.label)}</legend><div class="ui-option-row">${(field.options ?? []).map(([value, label]) => `<label><input type="checkbox" name="${text(field.key)}" value="${text(value)}" ${selected.has(String(value)) ? 'checked' : ''} /><span>${text(label)}</span></label>`).join('')}</div></fieldset>`;
  }
  const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
  const bounds = `${field.min !== undefined ? ` min="${text(field.min)}"` : ''}${field.max !== undefined ? ` max="${text(field.max)}"` : ''}`;
  return `<label class="ui-config-field" for="${inputId}"><span>${text(field.label)}</span><input id="${inputId}" name="${text(field.key)}" type="${type}" value="${field.secret ? '' : text(field.value)}" placeholder="${field.secret && field.configured ? '已配置，留空不修改' : text(field.placeholder ?? '')}"${bounds} ${field.secret ? 'autocomplete="new-password"' : ''} />${configuredNote}</label>`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片'));
    };
    image.src = url;
  });
}

function canvasDataUrl(image, kind, maximumEdge) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (kind === 'avatar') {
    const edge = Math.min(maximumEdge, image.naturalWidth, image.naturalHeight);
    const crop = Math.min(image.naturalWidth, image.naturalHeight);
    canvas.width = edge;
    canvas.height = edge;
    context.drawImage(
      image,
      (image.naturalWidth - crop) / 2,
      (image.naturalHeight - crop) / 2,
      crop,
      crop,
      0,
      0,
      edge,
      edge,
    );
    return canvas.toDataURL('image/webp', 0.86);
  }
  const scale = Math.min(1, maximumEdge / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

async function imageFileToDataUrl(file, kind) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  }
  if (file.size > 8_000_000) throw new Error('原图不能超过 8 MB');
  const image = await loadImage(file);
  const limits = kind === 'avatar' ? [320, 256, 192] : [900, 720, 560, 420];
  const maxLength = kind === 'avatar' ? 280_000 : 580_000;
  for (const edge of limits) {
    const value = canvasDataUrl(image, kind, edge);
    if (value.length <= maxLength) return value;
  }
  throw new Error('图片压缩后仍然过大，请换一张更小的图片');
}

async function handleImageFile(input) {
  const container = input.closest('[data-image-upload]');
  const uploadButton = container.querySelector('[data-upload-image]');
  const file = input.files?.[0];
  if (!file) return;
  uploadButton.disabled = true;
  uploadButton.textContent = '处理中…';
  try {
    const value = await imageFileToDataUrl(file, container.dataset.imageKind || 'qrcode');
    setImageUploadValue(container, value);
    showNotice('图片已载入，保存配置后生效');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    input.value = '';
    uploadButton.disabled = false;
    uploadButton.textContent = container.dataset.imageKind === 'avatar' ? '上传头像' : '上传图片';
  }
}

function openPluginEditor(pluginCode) {
  const form = pluginForms.find((candidate) => candidate.code === pluginCode);
  if (!form) return;
  activePluginCode = pluginCode;
  document.querySelector('#plugin-editor-title').textContent = `编辑 ${form.name}`;
  pluginFields.innerHTML = form.fields.map(fieldMarkup).join('');
  pluginEditor.hidden = false;
  pluginEditor.classList.remove('entering');
  requestAnimationFrame(() => pluginEditor.classList.add('entering'));
  pluginEditor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closePluginEditor() {
  pluginEditor.hidden = true;
  activePluginCode = '';
}

async function savePlugin(event) {
  event.preventDefault();
  const form = pluginForms.find((candidate) => candidate.code === activePluginCode);
  if (!form) return;
  const values = {};
  const data = new FormData(pluginForm);
  for (const field of form.fields) {
    values[field.key] = field.type === 'multiselect' ? data.getAll(field.key) : (data.get(field.key) ?? '');
  }
  const button = pluginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const response = await request('/admin/api/plugins', {
      method: 'PUT',
      body: JSON.stringify({ plugin_code: activePluginCode, values }),
    });
    pluginForms = pluginForms.map((candidate) => candidate.code === activePluginCode ? response.form : candidate);
    showNotice(`${response.form.name} 配置已保存`);
    await load({ keepEditor: true });
    openPluginEditor(activePluginCode);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '保存插件配置';
  }
}

async function setPluginEnabled(pluginCode, enabled, input) {
  input.disabled = true;
  try {
    const response = await request('/admin/api/plugins', {
      method: 'PUT',
      body: JSON.stringify({ plugin_code: pluginCode, enabled }),
    });
    pluginForms = pluginForms.map((candidate) => candidate.code === pluginCode ? response.form : candidate);
    pluginsState = pluginsState.map((candidate) => candidate.code === pluginCode ? response.plugin : candidate);
    renderPlugins();
    showNotice(`${response.plugin.name}已${enabled ? '启用' : '停用'}`);
  } catch (error) {
    input.checked = !enabled;
    input.disabled = false;
    showNotice(error.message, 'error');
  }
}

async function saveChannels() {
  const button = document.querySelector('#save-channels');
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const channels = channelRowsState();
    const response = await request('/admin/api/channels', {
      method: 'PUT',
      body: JSON.stringify({ channels }),
    });
    channelPluginsState = response.plugins ?? channelPluginsState;
    renderChannels(response.results);
    showNotice('通道支付方式、权重、有效期与启用状态已保存');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '保存通道路由';
  }
}

function renderKeys(keys = {}) {
  for (const code of ['epay', 'watcher']) {
    const card = document.querySelector(`[data-key-card="${code}"]`);
    const state = keys[code] ?? {};
    card.querySelector('.ui-key-state').textContent = state.configured ? '已配置' : '未配置';
    card.querySelector('.ui-key-state').classList.toggle('missing', !state.configured);
    card.querySelector('[data-key-fingerprint]').textContent = state.fingerprint ? `sha256:${state.fingerprint}` : '—';
    card.querySelector('[data-key-rotated]').textContent = dateTime(state.rotated_at);
    card.querySelector('[data-key-previous]').textContent = state.previous_valid_until
      ? dateTime(state.previous_valid_until)
      : '无';
    card.querySelector('[data-rotate-key]').disabled = !state.configured;
    card.querySelector('[data-revoke-key]').disabled = !state.previous_valid_until;
  }
}

async function refreshKeys() {
  const payload = await request('/admin/api/keys');
  renderKeys(payload.keys);
}

async function rotateKey(code, button) {
  const label = code === 'epay' ? 'ePay V1 商户密钥' : 'Watcher 传输密钥';
  if (!confirm(`确认轮换${label}？旧密钥只保留 30 分钟兼容期。`)) return;
  button.disabled = true;
  try {
    const payload = await request('/admin/api/keys', {
      method: 'POST',
      body: JSON.stringify({ action: 'rotate', key: code }),
    });
    document.querySelector('#key-result-title').textContent = `${label}已轮换`;
    document.querySelector('#key-result-value').value = payload.result.value;
    document.querySelector('#key-result-note').textContent = code === 'epay'
      ? `请在 ${dateTime(payload.result.previous_valid_until)} 前更新所有 ePay 调用端。`
      : `请在 ${dateTime(payload.result.previous_valid_until)} 前更新 Docker Watcher 的 TRANSPORT_KEY 并重启容器。`;
    keyResultDialog.showModal();
    await refreshKeys();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function revokePreviousKey(code, button) {
  if (!confirm('确认立即撤销旧密钥？仍使用旧密钥的调用端会马上失败。')) return;
  button.disabled = true;
  try {
    await request('/admin/api/keys', {
      method: 'POST',
      body: JSON.stringify({ action: 'revoke_previous', key: code }),
    });
    await refreshKeys();
    showNotice('旧密钥已撤销');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function copyValue(value, successMessage = '已复制') {
  const normalized = String(value ?? '');
  if (!normalized) return;
  try {
    await navigator.clipboard.writeText(normalized);
  } catch {
    const input = document.createElement('textarea');
    input.value = normalized;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  showNotice(successMessage);
}

function applyAdminSection() {
  for (const section of document.querySelectorAll('.ui-admin-main > .ui-section')) {
    section.hidden = section.id !== activeAdminSection;
  }
  for (const link of document.querySelectorAll('[data-section-link]')) {
    const selected = link.dataset.sectionLink === activeAdminSection;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const title = ADMIN_SECTIONS[activeAdminSection];
  document.querySelector('#admin-page-title').textContent = title;
  document.title = `${title} · EdgePay 管理后台`;
}

async function load({ keepEditor = false } = {}) {
  try {
    if (activeAdminSection === 'site' || activeAdminSection === 'docs') {
      const site = await request('/admin/api/site');
      renderSiteConfig(site.config, site.contact_url, site.poll_trigger_url);
    } else if (activeAdminSection === 'plugins') {
      const plugins = await request('/admin/api/plugins');
      pluginForms = plugins.forms;
      pluginsState = plugins.results;
      renderPlugins(plugins.results);
      renderPendingInstall(plugins.pending_install ?? [], plugins.upgrade_url ?? '', plugins.license ?? {});
      renderPluginDocs(plugins.results);
      if (!keepEditor) closePluginEditor();
    } else if (activeAdminSection === 'channels') {
      const channels = await request('/admin/api/channels');
      channelPluginsState = channels.plugins ?? [];
      renderChannels(channels.results);
    } else if (activeAdminSection === 'orders') {
      await loadOrders();
    } else if (activeAdminSection === 'keys') {
      const keys = await request('/admin/api/keys');
      renderKeys(keys.keys);
    }
  } catch (error) {
    if (error.message !== 'unauthorized') {
      if (activeAdminSection === 'plugins') {
        pluginBody.innerHTML = '<tr><td colspan="6" class="ui-empty">无法加载配置</td></tr>';
      } else if (activeAdminSection === 'channels') {
        channelBody.innerHTML = '<tr><td colspan="8" class="ui-empty">无法加载通道</td></tr>';
      } else if (activeAdminSection === 'orders') {
        orderBody.innerHTML = '<tr><td colspan="11" class="ui-empty">无法加载订单</td></tr>';
        ordersSummary.textContent = '订单读取失败';
      }
      showNotice(error.message, 'error');
    }
  }
}

pluginBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-edit-plugin]');
  if (button) openPluginEditor(button.dataset.editPlugin);
});
pluginBody.addEventListener('change', (event) => {
  const input = event.target.closest('[data-toggle-plugin]');
  if (input) setPluginEnabled(input.dataset.togglePlugin, input.checked, input);
});
pluginFilters.addEventListener('input', () => {
  const data = new FormData(pluginFilters);
  pluginQuery.keyword = String(data.get('keyword') ?? '').trim();
  pluginQuery.status = String(data.get('status') ?? '').trim();
  renderPlugins();
});
pluginFilters.addEventListener('change', () => {
  const data = new FormData(pluginFilters);
  pluginQuery.keyword = String(data.get('keyword') ?? '').trim();
  pluginQuery.status = String(data.get('status') ?? '').trim();
  renderPlugins();
});
pluginFilters.addEventListener('submit', (event) => {
  event.preventDefault();
});
for (const eventName of ['input', 'change']) {
  channelFilters.addEventListener(eventName, () => {
    const data = new FormData(channelFilters);
    channelQuery.keyword = String(data.get('keyword') ?? '').trim();
    channelQuery.status = String(data.get('status') ?? '').trim();
    applyChannelFilters();
  });
}
channelFilters.addEventListener('submit', (event) => {
  event.preventDefault();
});
document.addEventListener('click', (event) => {
  const uploadButton = event.target.closest('[data-upload-image]');
  if (uploadButton) {
    uploadButton.closest('[data-image-upload]').querySelector('input[type="file"]').click();
    return;
  }
  const removeButton = event.target.closest('[data-remove-image]');
  if (removeButton) {
    const container = removeButton.closest('[data-image-upload]');
    const fallback = container.dataset.imageKind === 'avatar' ? '/contact/default-avatar.png' : '';
    setImageUploadValue(container, '', fallback);
    showNotice('图片已移除，保存配置后生效');
    return;
  }
  const rotateButton = event.target.closest('[data-rotate-key]');
  if (rotateButton) {
    rotateKey(rotateButton.dataset.rotateKey, rotateButton);
    return;
  }
  const revokeButton = event.target.closest('[data-revoke-key]');
  if (revokeButton) {
    revokePreviousKey(revokeButton.dataset.revokeKey, revokeButton);
    return;
  }
  if (event.target.closest('[data-copy-contact-url]')) {
    copyValue(contactUrl, '客服页地址已复制');
    return;
  }
  if (event.target.closest('[data-copy-key-result]')) {
    copyValue(document.querySelector('#key-result-value').value, '新密钥已复制');
    return;
  }
  if (event.target.closest('[data-copy-doc="wechat-notify"]')) {
    copyValue(`${location.origin}/api/pay/{通道ID}/notify`, '通知地址模板已复制');
    return;
  }
  if (event.target.closest('[data-copy-doc="receipt-poll"]')) {
    copyValue(pollTriggerUrl, 'Worker 监听触发地址已复制');
    return;
  }
  if (!orderFloatingMenu.contains(event.target) && !event.target.closest('[data-order-menu]')) closeOrderMenu();
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-image-upload] input[type="file"]')) handleImageFile(event.target);
});
channelBody.addEventListener('change', (event) => {
  if (event.target.classList.contains('channel-pay-type')) {
    const row = event.target.closest('[data-channel-id]');
    const channel = channelsState.find((candidate) => String(candidate.id) === row.dataset.channelId);
    if (channel) channel.pay_types = [event.target.value];
    applyChannelFilters();
    return;
  }
  if (event.target.classList.contains('channel-enabled')) {
    event.target.nextElementSibling.textContent = event.target.checked ? '启用' : '停用';
    const row = event.target.closest('[data-channel-id]');
    const channel = channelsState.find((candidate) => String(candidate.id) === row.dataset.channelId);
    if (channel) channel.enabled = event.target.checked;
    row.querySelector('[data-test-channel]').disabled = !event.target.checked || !channel?.plugin_enabled;
    applyChannelFilters();
  }
});
channelBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-test-channel]');
  if (!button || button.disabled) return;
  const channel = channelsState.find((candidate) => String(candidate.id) === button.dataset.testChannel);
  if (channel) openChannelTest(channel);
});
orderBody.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-view-order]');
  if (viewButton) {
    await openOrderDetails(viewButton.dataset.viewOrder);
    return;
  }
  const menuButton = event.target.closest('[data-order-menu]');
  if (!menuButton) return;
  const order = ordersState.find((candidate) => candidate.payment_no === menuButton.dataset.orderMenu);
  if (!order) return;
  const alreadyOpen = menuButton.getAttribute('aria-expanded') === 'true';
  closeOrderMenu();
  if (!alreadyOpen) openOrderMenu(menuButton, order);
});
orderDetailBody.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-order-tab]');
  if (tab) {
    activateOrderDetailTab(tab.dataset.orderTab);
    return;
  }
  const deleteButton = event.target.closest('[data-delete-order]');
  if (!deleteButton || !confirm('确认删除这笔订单及全部关联记录？此操作不可撤销。')) return;
  deleteButton.disabled = true;
  try {
    const payload = await request(`/admin/api/orders/${encodeURIComponent(deleteButton.dataset.deleteOrder)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    });
    orderDetailDialog.close();
    showNotice(payload.message);
    await loadOrders();
  } catch (error) {
    deleteButton.disabled = false;
    showNotice(error.message, 'error');
  }
});
orderFloatingMenu.addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-order-action]');
  if (!actionButton) return;
  const order = ordersState.find((candidate) => candidate.payment_no === actionButton.dataset.paymentNo);
  const action = order?.actions?.find((candidate) => candidate.code === actionButton.dataset.orderAction);
  if (!order || !action?.enabled) return;
  closeOrderMenu();
  if (action.requires_reason || action.requires_amount || action.confirm) {
    openOrderAction(order, action);
    return;
  }
  actionButton.disabled = true;
  try {
    await runOrderAction(order, action);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    actionButton.disabled = false;
  }
});
orderActionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeOrderAction) return;
  const { order, action } = activeOrderAction;
  const submit = document.querySelector('#order-action-submit');
  const body = {};
  if (action.requires_amount) body.money = document.querySelector('#order-action-money').value.trim();
  if (action.requires_reason) body.reason = document.querySelector('#order-action-reason').value.trim();
  submit.disabled = true;
  submit.textContent = '正在处理…';
  try {
    await runOrderAction(order, action, body);
    orderActionDialog.close();
    activeOrderAction = null;
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    submit.disabled = false;
    if (activeOrderAction) submit.textContent = `确认${action.label}`;
  }
});
window.addEventListener('resize', closeOrderMenu);
window.addEventListener('scroll', closeOrderMenu, true);
pluginForm.addEventListener('submit', savePlugin);
siteForm.addEventListener('submit', saveSiteConfig);
channelTestForm.addEventListener('submit', createChannelTest);
channelCreateForm.addEventListener('submit', createChannel);
document.querySelector('#open-channel-create').addEventListener('click', openChannelCreate);
document.querySelector('#channel-create-plugin').addEventListener('change', () => {
  document.querySelector('#channel-create-name').value = '';
  syncChannelCreatePayTypes({ suggestName: true });
});
document.querySelector('#channel-create-pay-type').addEventListener('change', () => {
  const plugin = selectedChannelCreatePlugin();
  const name = document.querySelector('#channel-create-name');
  if (plugin && (!name.value.trim() || name.value.startsWith(`${plugin.name} · `))) {
    name.value = `${plugin.name} · ${document.querySelector('#channel-create-pay-type').value}`;
  }
});
for (const button of document.querySelectorAll('[data-close-channel-create]')) {
  button.addEventListener('click', () => channelCreateDialog.close());
}
document.querySelector('#channel-test-wechat-product').addEventListener('change', syncChannelTestProductFields);
document.querySelector('#channel-test-alipay-product').addEventListener('change', syncChannelTestProductFields);
document.querySelector('#channel-test-history-refresh').addEventListener('click', () => {
  if (activeTestChannel) loadChannelTestRecords(activeTestChannel.id);
});
document.querySelector('#plugin-editor-close').addEventListener('click', closePluginEditor);
document.querySelector('#save-channels').addEventListener('click', saveChannels);
document.querySelector('#refresh').addEventListener('click', async () => {
  try {
    await loadOrders();
    showNotice('订单数据已刷新');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});
orderFilters.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(orderFilters);
  orderQuery.search_field = String(data.get('search_field') || 'all');
  orderQuery.keyword = String(data.get('keyword') || '').trim();
  orderQuery.plugin_code = String(data.get('plugin_code') || '');
  orderQuery.status = String(data.get('status') || '');
  orderQuery.callback_status = String(data.get('callback_status') || '');
  orderQuery.page = 1;
  try {
    await loadOrders();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});
document.querySelector('#order-filter-reset').addEventListener('click', async () => {
  orderFilters.reset();
  Object.assign(orderQuery, {
    page: 1,
    search_field: 'all',
    keyword: '',
    plugin_code: '',
    status: '',
    callback_status: '',
  });
  try {
    await loadOrders();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});
ordersPrevPage.addEventListener('click', async () => {
  if (orderPagination.page <= 1) return;
  orderQuery.page = orderPagination.page - 1;
  try {
    await loadOrders();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});
ordersNextPage.addEventListener('click', async () => {
  if (orderPagination.page >= orderPagination.pageCount) return;
  orderQuery.page = orderPagination.page + 1;
  try {
    await loadOrders();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});
ordersPageSize.addEventListener('change', async () => {
  orderQuery.page_size = Number(ordersPageSize.value);
  orderQuery.page = 1;
  try {
    await loadOrders();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});
document.querySelectorAll('[data-close-order-detail]').forEach((button) => {
  button.addEventListener('click', () => orderDetailDialog.close());
});
document.querySelectorAll('[data-close-order-action]').forEach((button) => {
  button.addEventListener('click', () => {
    orderActionDialog.close();
    activeOrderAction = null;
  });
});
document.querySelectorAll('[data-close-channel-test]').forEach((button) => {
  button.addEventListener('click', closeChannelTest);
});
document.querySelectorAll('[data-confirm-key-saved]').forEach((button) => {
  button.addEventListener('click', () => keyResultDialog.close());
});
keyResultDialog.addEventListener('cancel', (event) => event.preventDefault());
document.querySelectorAll('[data-close-version-update]').forEach((button) => {
  button.addEventListener('click', dismissVersionUpdate);
});
versionUpdateDialog.addEventListener('cancel', snoozeVersionUpdate);
[orderDetailDialog, orderActionDialog, channelTestDialog, versionUpdateDialog].forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
      if (dialog === orderActionDialog) activeOrderAction = null;
      if (dialog === channelTestDialog) activeTestChannel = null;
      if (dialog === versionUpdateDialog) snoozeVersionUpdate();
    }
  });
});
applyAdminSection();
checkVersionUpdate();
load();
