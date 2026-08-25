const codeButton = document.querySelector('#captcha-code');
const input = document.querySelector('#captcha-input');
const form = document.querySelector('.ui-login-form');
const error = document.querySelector('#login-error');
const password = document.querySelector('#admin-password');
const passwordToggle = document.querySelector('#password-toggle');
function refreshCaptcha() { codeButton.querySelector('img').src = `/admin/captcha?refresh=${Date.now()}`; }
function showError(message = '账号、密码或验证码不正确') {
  error.textContent = message;
  error.classList.add('visible');
  error.setAttribute('aria-hidden', 'false');
}
codeButton.addEventListener('click', refreshCaptcha);
passwordToggle.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  passwordToggle.setAttribute('aria-pressed', String(visible));
  passwordToggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  password.focus({ preventScroll: true });
});
const search = new URLSearchParams(location.search);
const locked = Number(search.get('locked') ?? 0);
const remaining = Number(search.get('remaining') ?? -1);
if (locked > 0) showError(`登录失败次数过多，请在 ${Math.max(1, Math.ceil(locked / 60))} 分钟后重试`);
else if (search.get('error')) showError(remaining >= 0 ? `账号、密码或验证码不正确，还可尝试 ${remaining} 次` : undefined);
form.addEventListener('submit', () => { if (!input.value.trim()) showError(); });
