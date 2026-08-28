/**
 * 外部监听端在线状态。
 *
 * 以前这里只有一行 `watcher_presence`，谁调 `/api/watcher/snapshot` 就整个覆盖它。
 * 单个 Watcher 时没问题，但同时跑两个（比如官方镜像负责渠道流水、另一个进程负责
 * 个人收款）就会每一轮互相把对方声明的插件冲掉：Worker 一会儿以为渠道插件有人管，
 * 一会儿又以为没人管，于是重复轮询，后台的「最近流水查询」也会间歇性报
 * 「请先启动并确认 Watcher 已在线」。
 *
 * 现在每个实例各写各的行，读的时候取并集。
 */

export const PRESENCE_PREFIX = 'watcher_presence:';
/** 超过这个时长没再上报就算离线。 */
export const PRESENCE_TTL_MS = 120_000;
/** 写入节流：内容没变且刚写过就不再写。 */
const PRESENCE_THROTTLE_MS = 30_000;
/** 早就离线的实例行没有保留价值，顺手清掉，避免键无限增长。 */
export const PRESENCE_SWEEP_MS = 600_000;

export const WATCHER_KINDS = Object.freeze(['docker', 'yyb_bridge', 'android']);

const encoder = new TextEncoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 实例身份。
 *
 * 优先用调用方自报的实例 ID；没有就按声明的能力集分桶——能力集相同的实例对
 * 并集来说本来就等价，合用一行不影响结果。这样已经部署在外、不会自报身份的
 * 旧版 Watcher 不需要升级也能正确参与并集。
 */
export async function presenceKey(instanceId, capabilities) {
  const declared = String(instanceId ?? '').trim();
  if (/^[A-Za-z0-9._-]{1,64}$/u.test(declared)) return `${PRESENCE_PREFIX}id:${declared}`;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode([...capabilities].sort().join(',')));
  return `${PRESENCE_PREFIX}set:${hex(digest).slice(0, 32)}`;
}

/** 记录一个实例当前声明的插件能力。 */
export async function recordWatcherPresence(env, key, capabilities, now = Date.now(), details = {}) {
  const channelIds = [...new Set((details.channelIds ?? [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0))].sort((left, right) => left - right);
  const value = JSON.stringify({
    plugins: [...capabilities].map(String).sort(),
    ...(details.polling === false ? { polling: false } : {}),
    ...(String(details.kind ?? '').trim() ? { kind: String(details.kind).trim().slice(0, 32) } : {}),
    ...(channelIds.length ? { channel_ids: channelIds } : {}),
  });
  const updatedAt = new Date(now).toISOString();
  const throttleBefore = new Date(now - PRESENCE_THROTTLE_MS).toISOString();
  const sweepBefore = new Date(now - PRESENCE_SWEEP_MS).toISOString();
  await env.DB.prepare(`
    INSERT INTO runtime_settings (setting_key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_text = excluded.value_text,
      updated_at = excluded.updated_at
    WHERE runtime_settings.updated_at <= ? OR runtime_settings.value_text <> ?
  `).bind(key, value, updatedAt, throttleBefore, value).run();
  await env.DB.prepare(`
    DELETE FROM runtime_settings WHERE setting_key LIKE ? AND updated_at < ?
  `).bind(`${PRESENCE_PREFIX}%`, sweepBefore).run();
}

/**
 * 清空所有监听端在线状态。
 *
 * 管理员在后台手动触发：测试时临时加的设备（多开的模拟器等）删掉后，它那条
 * presence 行还会挂到 TTL 过期，让在线计数停在 1/2 之类的假数字。这里把整批
 * 清掉，仍在运行的监听端会在下一次上报时自己回来（Android 心跳约一分钟一次，
 * Docker/应用宝桥接各按自己的间隔），删掉的测试设备则不再出现。
 */
export async function clearWatcherPresence(env) {
  const result = await env.DB.prepare(`
    DELETE FROM runtime_settings WHERE setting_key = 'watcher_presence' OR setting_key LIKE ?
  `).bind(`${PRESENCE_PREFIX}%`).run();
  return Number(result?.meta?.changes ?? 0);
}

/**
 * 刚掉线的实例：上报过，停了超过存活窗口，但还没停到"早就不在了"。
 *
 * 判据必须是"上报过"：从没上报过的部署（根本没装 Watcher）不该被当成掉线，
 * 否则没用监听器的人会一直收到告警。
 *
 * 上界同样重要。清扫只发生在有实例上报时，监听器一直不回来就没人清它那一行；
 * 若不设上界，这一行会永远处于"刚掉线"状态，让 cron 每分钟都被唤醒去查一遍。
 * 限定成一段窗口之后，告警在掉线那几分钟发出，之后系统重新安静下来。
 */
export async function staleWatcherInstances(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`
    SELECT setting_key, value_text, updated_at FROM runtime_settings
    WHERE setting_key = 'watcher_presence' OR setting_key LIKE ?
  `).bind(`${PRESENCE_PREFIX}%`).all();
  const stale = [];
  for (const row of results ?? []) {
    const updatedAt = Date.parse(String(row?.updated_at ?? ''));
    if (!Number.isFinite(updatedAt)) continue;
    const silentMs = now - updatedAt;
    if (silentMs < PRESENCE_TTL_MS || silentMs > PRESENCE_SWEEP_MS) continue;
    let parsed;
    try { parsed = JSON.parse(String(row?.value_text ?? '')); } catch { continue; }
    stale.push({
      key: String(row.setting_key ?? '').replace(PRESENCE_PREFIX, ''),
      plugins: Array.isArray(parsed?.plugins) ? parsed.plugins.map(String) : [],
      kind: String(parsed?.kind ?? ''),
      channelIds: Array.isArray(parsed?.channel_ids)
        ? parsed.channel_ids.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
        : [],
      silentMs,
    });
  }
  return stale;
}

/**
 * 所有在线实例声明过的插件并集。
 *
 * 也读旧的单行 `watcher_presence`：升级后旧版 Watcher 还没重新上报的那一小段时间里
 * 仍然认它，免得刚部署完就出现一轮「所有 Watcher 都不在线」。它自己会随 TTL 过期。
 */
export async function onlineWatcherPlugins(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`
    SELECT value_text, updated_at FROM runtime_settings
    WHERE setting_key = 'watcher_presence' OR setting_key LIKE ?
  `).bind(`${PRESENCE_PREFIX}%`).all();
  const plugins = new Set();
  for (const row of results ?? []) {
    const updatedAt = Date.parse(String(row?.updated_at ?? ''));
    if (!Number.isFinite(updatedAt) || updatedAt < now - PRESENCE_TTL_MS) continue;
    let parsed;
    try { parsed = JSON.parse(String(row?.value_text ?? '')); } catch { continue; }
    if (!Array.isArray(parsed?.plugins) || parsed.polling === false) continue;
    for (const code of parsed.plugins) {
      const text = String(code ?? '').trim();
      if (text) plugins.add(text);
    }
  }
  return plugins;
}

/** Android 监听端按通道上报的最近在线状态，供管理台直接显示。 */
export async function watcherChannelPresence(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`
    SELECT value_text, updated_at FROM runtime_settings
    WHERE setting_key LIKE ?
  `).bind(`${PRESENCE_PREFIX}%`).all();
  const channels = new Map();
  for (const row of results ?? []) {
    const updatedAt = Date.parse(String(row?.updated_at ?? ''));
    if (!Number.isFinite(updatedAt)) continue;
    let parsed;
    try { parsed = JSON.parse(String(row?.value_text ?? '')); } catch { continue; }
    if (parsed?.kind !== 'android' || !Array.isArray(parsed.channel_ids)) continue;
    for (const rawId of parsed.channel_ids) {
      const channelId = Number(rawId);
      if (!Number.isSafeInteger(channelId) || channelId <= 0) continue;
      const previous = channels.get(channelId);
      if (previous && Date.parse(previous.last_seen_at) >= updatedAt) continue;
      channels.set(channelId, {
        status: now - updatedAt < PRESENCE_TTL_MS ? 'online' : 'offline',
        last_seen_at: new Date(updatedAt).toISOString(),
      });
    }
  }
  return channels;
}

/**
 * 管理台系统状态页使用的监听端汇总。
 *
 * 新版监听端会直接写入 kind；已部署的应用宝桥接器实例 ID 固定以
 * `yyb-bridge-` 开头，因此旧版本也能立即被正确归类。更早的普通 Watcher
 * 没有 kind 和实例 ID，按 Docker Watcher 处理。
 */
export async function watcherSystemStatus(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`
    SELECT setting_key, value_text, updated_at FROM runtime_settings
    WHERE setting_key = 'watcher_presence' OR setting_key LIKE ?
  `).bind(`${PRESENCE_PREFIX}%`).all();
  const groups = Object.fromEntries(WATCHER_KINDS.map((kind) => [kind, {
    status: 'unknown',
    total_instances: 0,
    online_instances: 0,
    last_seen_at: '',
    plugins: [],
    channel_ids: [],
  }]));
  const pluginSets = Object.fromEntries(WATCHER_KINDS.map((kind) => [kind, new Set()]));
  const channelSets = Object.fromEntries(WATCHER_KINDS.map((kind) => [kind, new Set()]));

  for (const row of results ?? []) {
    const updatedAt = Date.parse(String(row?.updated_at ?? ''));
    if (!Number.isFinite(updatedAt)) continue;
    let parsed;
    try { parsed = JSON.parse(String(row?.value_text ?? '')); } catch { continue; }
    if (!Array.isArray(parsed?.plugins)) continue;
    const key = String(row?.setting_key ?? '').replace(PRESENCE_PREFIX, '');
    const declaredKind = String(parsed?.kind ?? '').trim();
    const kind = WATCHER_KINDS.includes(declaredKind)
      ? declaredKind
      : (/^id:yyb-bridge-/u.test(key) ? 'yyb_bridge' : (parsed?.polling === false ? 'android' : 'docker'));
    const group = groups[kind];
    group.total_instances += 1;
    if (now - updatedAt < PRESENCE_TTL_MS) group.online_instances += 1;
    if (!group.last_seen_at || Date.parse(group.last_seen_at) < updatedAt) {
      group.last_seen_at = new Date(updatedAt).toISOString();
    }
    for (const code of parsed.plugins) {
      const plugin = String(code ?? '').trim();
      if (plugin) pluginSets[kind].add(plugin);
    }
    for (const rawId of Array.isArray(parsed.channel_ids) ? parsed.channel_ids : []) {
      const channelId = Number(rawId);
      if (Number.isSafeInteger(channelId) && channelId > 0) channelSets[kind].add(channelId);
    }
  }

  for (const kind of WATCHER_KINDS) {
    const group = groups[kind];
    if (group.online_instances > 0) {
      group.status = group.online_instances === group.total_instances ? 'online' : 'partial';
    } else if (group.total_instances > 0) {
      group.status = 'offline';
    }
    group.plugins = [...pluginSets[kind]].sort();
    group.channel_ids = [...channelSets[kind]].sort((left, right) => left - right);
  }
  return groups;
}

/** 仍在存活窗口内的实例键。用于恢复后把它那条掉线静默期清掉。 */
export async function liveWatcherInstances(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`
    SELECT setting_key, updated_at FROM runtime_settings
    WHERE setting_key = 'watcher_presence' OR setting_key LIKE ?
  `).bind(`${PRESENCE_PREFIX}%`).all();
  const live = [];
  for (const row of results ?? []) {
    const updatedAt = Date.parse(String(row?.updated_at ?? ''));
    if (!Number.isFinite(updatedAt) || now - updatedAt >= PRESENCE_TTL_MS) continue;
    live.push(String(row.setting_key ?? '').replace(PRESENCE_PREFIX, ''));
  }
  return live;
}
