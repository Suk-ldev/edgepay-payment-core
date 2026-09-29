// 首页：支付方式和信号图都按 /api/home 返回的真实通道渲染，HTML 里不写死任何平台。
// 接口只给支付方式，不给插件名——用哪家收单平台是商户不想公开的经营细节。

const SVG_NS = 'http://www.w3.org/2000/svg';
const HUB = { x: 350, y: 250 };
const TARGET = { x: 570, y: 250 };
const SOURCE_X = 26;
const MAX_SOURCES = 4;

const CARD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg>';
const METHOD_STYLES = {
  alipay: { tone: '#1677ff', glyph: '支', desc: '扫码或唤起支付宝付款' },
  wxpay: { tone: '#07c160', glyph: '微', desc: '扫码或在微信内付款' },
  usdt: { tone: '#26a17b', glyph: '₮', desc: 'USDT 链上转账，确认后自动入账' },
  bank: { tone: '#7c5cff', svg: CARD_ICON, desc: '银行卡与境外支付' },
};

const PLACEHOLDERS = {
  loading: { title: '正在读取通道', meta: '稍等片刻' },
  idle: { title: '等待开通', meta: '后台启用插件并添加通道后显示' },
  error: { title: '暂时无法读取', meta: '稍后刷新页面再试' },
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function methodStyle(method) {
  return METHOD_STYLES[method.code] ?? { tone: '#5b8dff', glyph: String(method.name ?? '?').slice(0, 1), desc: '' };
}

function methodIcon(method) {
  const style = methodStyle(method);
  const icon = element('span', 'method-icon');
  icon.setAttribute('aria-hidden', 'true');
  if (style.svg) icon.innerHTML = style.svg;
  else icon.textContent = style.glyph;
  return { icon, tone: style.tone };
}

function channelText(method) {
  return `${Number(method.channel_count) || 0} 条通道`;
}

function setStatus(state, text) {
  const pill = document.querySelector('.status-pill');
  pill.dataset.state = state;
  document.querySelector('#home-status').textContent = text;
  const live = document.querySelector('#stage-live');
  live.dataset.state = state;
  live.textContent = { live: 'LIVE', idle: 'IDLE', error: 'UNKNOWN' }[state] ?? 'SYNCING';
}

function sourceRows(count) {
  if (count <= 1) return [HUB.y];
  const gap = Math.min(140, 340 / (count - 1));
  return Array.from({ length: count }, (_, index) => HUB.y + ((index - ((count - 1) / 2)) * gap));
}

function packet(path, className, delay) {
  const dot = svg('circle', { r: 3.2, class: className, cx: 0, cy: 0 });
  dot.append(svg('animateMotion', {
    dur: '2.8s', begin: `${-delay}s`, repeatCount: 'indefinite', path,
  }));
  return dot;
}

/**
 * 画信号图：每种支付方式一条线汇进核心，再由核心走到商户回调。
 * 一种都没开通时画一条虚线占位（placeholder 说明原因），不假装有通道在跑。
 */
function renderStage(sources, placeholder = null) {
  const live = sources.length > 0;
  const canvas = document.querySelector('#stage-canvas');
  const board = document.querySelector('#stage-svg');
  board.replaceChildren();
  canvas.querySelectorAll('.source-chip').forEach((chip) => chip.remove());

  const rows = sourceRows(Math.max(1, sources.length));
  const trunk = `M${HUB.x} ${HUB.y} H${TARGET.x}`;
  (live ? sources : [placeholder ?? PLACEHOLDERS.loading]).forEach((source, index) => {
    const y = rows[index];
    const path = `M${SOURCE_X} ${y} H190 C270 ${y} 270 ${HUB.y} ${HUB.x} ${HUB.y}`;
    board.append(svg('path', { d: path, class: live ? 'trace' : 'trace ghost' }));
    board.append(svg('circle', { cx: SOURCE_X, cy: y, r: 6, class: live ? 'dot-source' : 'dot-source ghost' }));
    if (live && !reducedMotion) board.append(packet(path, 'packet', index * 0.7));

    const chip = element('div', live ? 'source-chip' : 'source-chip ghost');
    chip.style.top = `${(y / 500) * 100}%`;
    chip.style.animationDelay = `${index * 0.08}s`;
    chip.append(element('strong', '', source.title), element('small', '', source.meta));
    canvas.append(chip);
  });

  board.append(svg('path', { d: trunk, class: live ? 'trace trunk' : 'trace ghost' }));
  if (live && !reducedMotion) board.append(packet(trunk, 'packet settled', 0.4));
  board.append(svg('circle', { cx: HUB.x, cy: HUB.y, r: 22, class: 'hub-ring' }));
  board.append(svg('circle', { cx: HUB.x, cy: HUB.y, r: 22, class: 'hub-core' }));
  board.append(svg('circle', { cx: TARGET.x, cy: TARGET.y, r: 8, class: 'target-core' }));
}

function stageSources(methods) {
  const sources = methods.map((method) => ({ title: method.name, meta: `${channelText(method)}在线` }));
  if (sources.length <= MAX_SOURCES) return sources;
  const rest = sources.length - (MAX_SOURCES - 1);
  return [...sources.slice(0, MAX_SOURCES - 1), { title: `另外 ${rest} 种方式`, meta: '详见下方支付方式' }];
}

function renderHeroMethods(methods) {
  const list = document.querySelector('#hero-methods');
  list.replaceChildren(...methods.map((method) => {
    const item = element('li');
    const { icon, tone } = methodIcon(method);
    item.style.setProperty('--tone', tone);
    item.append(icon, element('span', '', method.name));
    return item;
  }));
}

function renderMethods(methods) {
  const grid = document.querySelector('#method-grid');
  grid.replaceChildren(...methods.map((method, index) => {
    const card = element('article', 'method-card');
    const { icon, tone } = methodIcon(method);
    card.style.setProperty('--tone', tone);
    card.style.animationDelay = `${index * 0.06}s`;

    const heading = element('div', 'method-heading');
    heading.append(element('h3', '', method.name));
    const { desc } = methodStyle(method);
    if (desc) heading.append(element('p', '', desc));

    const foot = element('p', 'method-foot');
    foot.append(element('i'), element('span', '', `${channelText(method)}在线`));
    card.append(icon, heading, foot);
    return card;
  }));
}

function renderMethodsMessage(title, text) {
  const box = element('div', 'method-empty');
  box.append(element('strong', '', title), element('p', '', text));
  document.querySelector('#method-grid').replaceChildren(box);
}

function applyMerchant(name) {
  const merchant = String(name ?? '').trim();
  if (!merchant) return;
  document.querySelectorAll('[data-merchant-name]').forEach((node) => { node.textContent = merchant; });
  document.title = `${merchant} · 支付网关`;
}

async function loadHome() {
  try {
    const response = await fetch('/api/home', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const methods = Array.isArray(data.methods) ? data.methods : [];
    applyMerchant(data.merchant_name);
    if (!methods.length) {
      setStatus('idle', '暂未开放收款通道');
      renderStage([], PLACEHOLDERS.idle);
      renderHeroMethods([]);
      renderMethodsMessage('还没有开放的支付方式', '管理员在后台启用插件并添加支付通道后，这里会自动列出。');
      return;
    }
    setStatus('live', `${Number(data.channel_count) || methods.length} 条收款通道运行中`);
    renderStage(stageSources(methods));
    renderHeroMethods(methods);
    renderMethods(methods);
  } catch {
    setStatus('error', '收款通道状态暂不可用');
    renderStage([], PLACEHOLDERS.error);
    renderMethodsMessage('暂时无法读取支付方式', '请稍后刷新页面再试。');
  }
}

function setupEndpoints() {
  const origin = window.location.origin;
  document.querySelectorAll('[data-origin]').forEach((node) => { node.textContent = origin; });
  document.querySelectorAll('[data-copy]').forEach((button) => {
    if (!navigator.clipboard) {
      button.hidden = true;
      return;
    }
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`${origin}${button.dataset.copy}`);
        button.dataset.copied = '';
        button.textContent = '已复制';
        setTimeout(() => {
          delete button.dataset.copied;
          button.textContent = '复制';
        }, 1600);
      } catch {
        button.textContent = '复制失败';
        setTimeout(() => { button.textContent = '复制'; }, 1600);
      }
    });
  });
}

document.querySelector('#footer-year').textContent = String(new Date().getFullYear());
setupEndpoints();
renderStage([]);
loadHome();
