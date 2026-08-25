const allowedTags = new Set([
  'a', 'b', 'br', 'button', 'div', 'em', 'h2', 'h3', 'i', 'img',
  'li', 'ol', 'p', 'small', 'span', 'strong', 'ul',
]);
const globalAttributes = new Set(['aria-label', 'class', 'title']);
const tagAttributes = {
  a: new Set(['href', 'rel', 'target']),
  button: new Set(['type']),
  img: new Set(['alt', 'height', 'src', 'width']),
};

function safeUrl(value, image = false) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (image && /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/iu.test(text)) return text;
  try {
    const url = new URL(text, location.origin);
    return ['http:', 'https:', 'mailto:', 'tel:', 'tencent:', 'weixin:'].includes(url.protocol)
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function safeFooterFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  for (const element of [...template.content.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (!globalAttributes.has(name) && !tagAttributes[tag]?.has(name)) element.removeAttribute(attribute.name);
    }
    if (tag === 'a') {
      const href = safeUrl(element.getAttribute('href'));
      if (href) element.setAttribute('href', href);
      else element.removeAttribute('href');
      if (element.getAttribute('target') === '_blank') element.setAttribute('rel', 'noopener noreferrer');
      else element.removeAttribute('target');
    }
    if (tag === 'img') {
      const src = safeUrl(element.getAttribute('src'), true);
      if (src) element.setAttribute('src', src);
      else element.remove();
    }
    if (tag === 'button') element.setAttribute('type', 'button');
  }
  return template.content;
}

function cashierConfigEndpoint() {
  const cashier = location.pathname.match(/^\/cashier\/([^/]+)$/u);
  if (cashier) return `/api/cashier/context?biz_no=${encodeURIComponent(decodeURIComponent(cashier[1]))}`;
  const payment = location.pathname.match(/^\/payment\/(p_[a-z0-9]+)$/u);
  if (payment) return `/api/cashier/pay-order?pay_no=${encodeURIComponent(payment[1])}`;
  return '';
}

async function loadCashierCustomization() {
  const endpoint = cashierConfigEndpoint();
  if (!endpoint) return;
  const response = await fetch(endpoint, { credentials: 'same-origin' });
  if (!response.ok) return;
  const payload = await response.json();
  const config = payload?.data?.public_config ?? {};
  if (config.title) document.title = String(config.title);
  const html = String(config.cashier_footer_html ?? '').trim();
  if (!html) return;

  const footer = document.createElement('section');
  footer.id = 'cashier-custom-footer';
  footer.className = 'cashier-custom-footer';
  footer.setAttribute('aria-label', '商户扩展信息');
  footer.append(safeFooterFragment(html));

  const mount = () => {
    const container = document.querySelector('.page-container');
    if (container && footer.parentElement !== container) container.append(footer);
  };
  mount();
  const observer = new MutationObserver(mount);
  observer.observe(document.querySelector('#app'), { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30_000);
}

loadCashierCustomization().catch(() => {});
