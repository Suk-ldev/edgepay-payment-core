const content = document.querySelector('#contact-content');
const unavailable = document.querySelector('#contact-unavailable');
const avatar = document.querySelector('#contact-avatar');
const title = document.querySelector('#contact-title');
const qrLabel = document.querySelector('#contact-qr-label');
const qrcode = document.querySelector('#contact-qrcode');

function showUnavailable() {
  content.hidden = true;
  unavailable.hidden = false;
}

async function loadContact() {
  try {
    const response = await fetch('/api/contact', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const config = payload?.config ?? {};
    if (!config.enabled || !config.qrcode_image) {
      showUnavailable();
      return;
    }
    const pageTitle = String(config.title ?? '').trim() || '添加我的企业微信与我联系吧';
    avatar.src = String(config.avatar_image ?? '').trim() || '/contact/default-avatar.png';
    title.textContent = pageTitle;
    qrLabel.textContent = String(config.qr_label ?? '').trim() || '手机微信扫码添加好友';
    qrcode.src = String(config.qrcode_image);
    document.title = pageTitle;
    unavailable.hidden = true;
    content.hidden = false;
  } catch {
    showUnavailable();
  }
}

loadContact();
