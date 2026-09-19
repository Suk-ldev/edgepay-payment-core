import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('快速切换编辑目标时，较晚返回的旧请求不会覆盖新表单', async () => {
  const pending = new Map();
  const rendered = [];
  const context = vm.createContext({
    pluginEditorSequence: 0,
    pluginForms: [],
    request: (url) => new Promise((resolve) => pending.set(url, resolve)),
    renderPluginEditor: (form) => rendered.push(form.code),
    showNotice() {},
  });
  vm.runInContext(script.slice(script.indexOf('async function openPluginEditor('), script.indexOf('function renderPluginEditor(')), context);
  const firstButton = { disabled: false };
  const secondButton = { disabled: false };
  const first = context.openPluginEditor('wxpay_receipt', firstButton);
  const second = context.openPluginEditor('fubei_receipt', secondButton);
  pending.get('/admin/api/plugins?plugin_code=fubei_receipt')({ form: { code: 'fubei_receipt' } });
  await second;
  pending.get('/admin/api/plugins?plugin_code=wxpay_receipt')({ form: { code: 'wxpay_receipt' } });
  await first;
  assert.deepEqual(rendered, ['fubei_receipt']);
  assert.equal(firstButton.disabled, false);
  assert.equal(secondButton.disabled, false);
});

test('响应正文卡住时也会超时并给出明确错误', async () => {
  let expire;
  let timerCleared = false;
  let bodyStarted;
  const readingBody = new Promise((resolve) => { bodyStarted = resolve; });
  const context = vm.createContext({
    AbortController,
    setTimeout(callback) { expire = callback; return 1; },
    clearTimeout() { timerCleared = true; },
    async fetch(_path, { signal }) {
      return {
        status: 200,
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          bodyStarted();
        }),
      };
    },
  });
  vm.runInContext(script.slice(script.indexOf('async function request('), script.indexOf('const VERSION_UPDATE_SNOOZE_COOKIE')), context);
  const request = context.request('/admin/api/plugins?view=summary');
  await readingBody;
  expire();
  await assert.rejects(request, /请求超时，请稍后重试/u);
  assert.equal(timerCleared, true);
});
