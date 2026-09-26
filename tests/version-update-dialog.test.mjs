/**
 * 后台升级提示的前端行为：有新版就弹；点"暂不升级"只在本次会话里压住这一个版本，
 * 会话里又发了更新的版本照样弹；查不到时不弹也不报错打断页面。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const snippet = script.slice(
  script.indexOf('const VERSION_UPDATE_SNOOZE_COOKIE'),
  script.indexOf('/**\n * 已购但没装进当前 Worker 的插件提示。'),
);

function browser() {
  const cookies = new Map();
  const elements = { '#version-update-message': { textContent: '' }, '#version-update-confirm': { onclick: null } };
  const dialog = {
    opened: 0,
    showModal() { this.opened += 1; },
    close() {},
  };
  let payload = null;
  const context = vm.createContext({
    console: { warn() {} },
    encodeURIComponent,
    decodeURIComponent,
    location: { assign() {} },
    versionUpdateDialog: dialog,
    document: {
      querySelector: (selector) => elements[selector],
      get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); },
      set cookie(text) {
        const [pair, ...attributes] = text.split('; ');
        assert.ok(!attributes.some((item) => /^(?:max-age|expires)=/iu.test(item)), '只能是会话级 Cookie');
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      },
    },
    request: async () => payload,
  });
  vm.runInContext(`${snippet}\nthis.checkVersionUpdate = checkVersionUpdate; this.dismissVersionUpdate = dismissVersionUpdate;`, context);
  return {
    dialog,
    elements,
    serve(next) { payload = next; },
    check: () => context.checkVersionUpdate(),
    dismiss: () => context.dismissVersionUpdate(),
    endSession: () => cookies.clear(),
  };
}

const update = (latest, current = '2.1.13') => ({
  ok: true, current_version: current, latest_version: latest, update_available: true, deploy_url: 'https://deploy.imsuk.cn/?mode=upgrade',
});

test('有新版本就弹，文案带上当前和最新版本', async () => {
  const page = browser();
  page.serve(update('2.1.14'));
  await page.check();
  assert.equal(page.dialog.opened, 1);
  assert.equal(page.elements['#version-update-message'].textContent, '当前版本 2.1.13，最新版本 2.1.14。');
});

test('暂不升级只压住本次会话里的这个版本', async () => {
  const page = browser();
  page.serve(update('2.1.14'));
  await page.check();
  page.dismiss();
  await page.check();
  assert.equal(page.dialog.opened, 1, '同一会话同一版本不再弹');

  page.serve(update('2.1.15'));
  await page.check();
  assert.equal(page.dialog.opened, 2, '会话里又出了更新的版本，照样弹');

  page.dismiss();
  page.endSession();
  await page.check();
  assert.equal(page.dialog.opened, 3, '关掉浏览器重新打开后台，没升级就还要提示');
});

test('已是最新或查不到时都不弹', async () => {
  const page = browser();
  page.serve({ ok: true, current_version: '2.1.14', latest_version: '2.1.14', update_available: false });
  await page.check();
  page.serve({ ok: false, current_version: '2.1.14', update_available: false, error: '读取最新版本失败' });
  await page.check();
  assert.equal(page.dialog.opened, 0);
});
