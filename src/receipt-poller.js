/**
 * Worker 侧收款轮询的通用编排：抢租约 → 读登录态 → 调插件查流水 → 存登录态 → 释放租约。
 *
 * 这里不认识任何具体收款平台。平台登录、请求签名、Cookie/Token 处理、流水解析
 * 全部在插件的 pollReceipts 里，核心只负责调度和状态保管。
 */

import { pluginSupportsWorkerPoll } from './plugin-api.js';
import { pluginContext } from './core/plugin-context.js';
import { readEncryptedJsonSetting, writeEncryptedJsonSetting } from './runtime-settings.js';

const POLLER_STATE_PREFIX = 'receipt_poller_state:';

/** 这个插件此刻能否由 Worker 自己轮询（而不是等 Docker Watcher 投递）。 */
export function workerPollerAvailable(registry, pluginCode, config = {}) {
  const plugin = registry.get(pluginCode);
  return plugin ? pluginSupportsWorkerPoll(plugin, config) : false;
}

function encryptionSecret(env) {
  return String(env.CONFIG_ENCRYPTION_KEY ?? env.ADMIN_TOKEN ?? '');
}

export async function acquirePollLease(env, pluginCode, leaseSeconds, now = new Date()) {
  const settingKey = `poll_lease:${pluginCode}`;
  const token = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + (leaseSeconds * 1_000)).toISOString();
  const valueText = JSON.stringify({
    token,
    state: 'running',
    started_at: now.toISOString(),
    expires_at: expiresAt,
  });
  const result = await env.DB.prepare(`
    INSERT INTO runtime_settings (setting_key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_text = excluded.value_text,
      updated_at = excluded.updated_at
    WHERE runtime_settings.updated_at <= ?
  `).bind(settingKey, valueText, expiresAt, now.toISOString()).run();
  return {
    acquired: Number(result.meta?.changes ?? 0) === 1,
    settingKey,
    token,
    valueText,
  };
}

export async function releasePollLease(env, lease, cooldownSeconds, state = 'idle') {
  const now = new Date();
  const nextAt = new Date(now.getTime() + (Math.max(0, cooldownSeconds) * 1_000)).toISOString();
  const valueText = JSON.stringify({
    token: '',
    state,
    finished_at: now.toISOString(),
    next_at: nextAt,
  });
  await env.DB.prepare(`
    UPDATE runtime_settings
    SET value_text = ?, updated_at = ?
    WHERE setting_key = ? AND value_text = ?
  `).bind(valueText, nextAt, lease.settingKey, lease.valueText).run();
}

export async function pollReceiptAccount(runtime, env, account, options = {}) {
  const pluginCode = String(account?.plugin_code ?? '');
  const orders = Array.isArray(account?.orders) ? account.orders : [];
  if (!orders.length) return { plugin_code: pluginCode, status: 'idle', records: [], details: {} };

  const plugin = runtime.registry.requireHook(pluginCode, 'pollReceipts');
  await runtime.authorizePlugin({ plugin, operation: 'pollReceipts', env });

  const { leaseSeconds, cooldownSeconds, stateless } = plugin.manifest.poll;
  const lease = await acquirePollLease(env, pluginCode, leaseSeconds);
  if (!lease.acquired) {
    return { plugin_code: pluginCode, status: 'busy', records: [], details: {} };
  }

  let releaseState = 'idle';
  try {
    const stateKey = `${POLLER_STATE_PREFIX}${pluginCode}`;
    const stored = stateless
      ? {}
      : await readEncryptedJsonSetting(env, stateKey, encryptionSecret(env), {});
    const result = await plugin.pollReceipts(pluginContext(runtime, {
      env,
      config: account.config ?? {},
      account,
      state: stored,
      fetchImpl: options.fetchImpl ?? null,
    }));
    if (!stateless && result.state && JSON.stringify(result.state) !== JSON.stringify(stored)) {
      await writeEncryptedJsonSetting(env, stateKey, encryptionSecret(env), result.state);
    }
    return { plugin_code: pluginCode, status: 'ok', ...result };
  } catch (error) {
    releaseState = 'error';
    throw error;
  } finally {
    await releasePollLease(
      env,
      lease,
      releaseState === 'error' ? 5 : cooldownSeconds,
      releaseState,
    );
  }
}
