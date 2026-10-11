import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { assert, validateId, sha256 } from '../src/protocol.mjs';
import { atomicWrite, assertNoSymlinks } from '../src/files.mjs';
import { SyncClient, validateServerUrl, validatePasswordChange } from '../src/client.mjs';
import { LocalStore, newDeviceId } from '../src/local-store.mjs';
import { isExcluded } from '../src/snapshot.mjs';
import { exportProjectSessions, importProjectSessions } from './dsh-adapter.mjs';

export const CREDENTIAL_KEY = 'dsh-personal-sync/account';
export function normalizeConfig(value = {}) {
  const server = value.server ? validateServerUrl(value.server) : undefined;
  assert(Array.isArray(value.projects ?? []), 'Invalid project mappings');
  const projects = (value.projects || []).map(item => {
    validateId(item.id); assert(typeof item.root === 'string' && path.isAbsolute(item.root), 'Project roots must be absolute');
    return { id: item.id, root: path.resolve(item.root), ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}) };
  });
  assert(new Set(projects.map(item => item.id)).size === projects.length, 'Duplicate project mappings');
  const intervalMs = value.intervalMs ?? 60_000;
  assert(Number.isSafeInteger(intervalMs) && intervalMs >= 30_000 && intervalMs <= 24 * 60 * 60_000, 'Sync interval must be between 30 seconds and one day');
  assert(value.autoSync === undefined || typeof value.autoSync === 'boolean', 'autoSync must be boolean');
  return { server, projects, intervalMs, autoSync: value.autoSync === true, username: value.username, stateDir: path.resolve(value.stateDir || path.join(os.homedir(), '.dsh-sync')) };
}
const failure = (code, message) => Object.assign(new Error(message), { code });
async function revokeOwnedGrant(record) {
  if (!record?.token) return { remoteRevoked: true };
  try { return await new SyncClient({ ...record, timeoutMs: 5000 }).logout(); }
  catch { return { remoteRevoked: false }; } // A damaged owned origin must not trap local logout.
}

export function createController(ctx, initialConfig, { exportSessions = exportProjectSessions, importSessions = importProjectSessions, credentialKey = CREDENTIAL_KEY, allowLegacyCli = true } = {}) {
  let config = normalizeConfig(initialConfig), initializer = async () => {}, rootAdmission = async () => {}, captureExclusions = async () => [], identityPersister;
  const store = new LocalStore(config.stateDir), lifetime = new AbortController(), scheduled = new Set();
  const reauthMarker = path.join(store.directory, `reauth-${sha256(credentialKey).slice(0, 24)}.json`);
  async function requiresReauthentication() {
    try { await fs.lstat(reauthMarker); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function clearReauthMarker() {
    if (!(await requiresReauthentication())) return;
    await assertNoSymlinks(reauthMarker);
    await fs.unlink(reauthMarker); // Only this profile-owned, exactly identified marker.
  }
  let stopped = false, mutating = false, batchRunning = false, active = null, activeAbort, mutationTask = null, generation = 0, lastResult = null;
  const ready = async () => { assert(!stopped, 'Plugin is stopped'); await initializer(); lifetime.signal.throwIfAborted(); };
  async function account() {
    if (await requiresReauthentication()) throw failure('NOT_LOGGED_IN', '请重新登录');
    const native = await ctx.credentials.readRecord(credentialKey), local = await store.config();
    if (local?.reauthRequired === true) throw failure('NOT_LOGGED_IN', '请重新登录');
    if (native !== undefined && (native?.kind !== 'grant' || !native.payload || typeof native.payload !== 'object' || Array.isArray(native.payload))) throw failure('ACCOUNT_MISMATCH', '原生登录记录无效，请重新登录');
    const value = native !== undefined ? native.payload : (allowLegacyCli ? local : undefined);
    if (!value?.token || !value?.server || !value?.deviceId) throw failure('NOT_LOGGED_IN', '请先在设置 → 个人云同步中登录');
    if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.username !== 'string' || !value.username || !Number.isFinite(Date.parse(value.expiresAt))) throw failure('ACCOUNT_MISMATCH', '登录记录无效，请重新登录');
    const server = validateServerUrl(value.server); validateId(value.deviceId);
    if ((config.server && server !== config.server) || (config.username !== undefined && value.username !== config.username) || !local || local.server !== server || local.username !== value.username || local.deviceId !== value.deviceId) throw failure('ACCOUNT_MISMATCH', '账号、本机身份与同步设置不一致，请重新登录');
    return { server, username: value.username, token: value.token, deviceId: value.deviceId, expiresAt: value.expiresAt };
  }
  function project(id) {
    const selected = config.projects.find(item => item.id === id);
    assert(selected, '项目未在插件配置 projects 中显式授权'); return { ...selected };
  }
  function replaceConfiguration(next) {
    const normalized = normalizeConfig({ ...config, ...next });
    assert(normalized.stateDir === store.directory, 'Cannot change stateDir at runtime');
    config = normalized;
  }
  function clearScheduled() { for (const handle of scheduled) clearImmediate(handle); scheduled.clear(); }
  async function mutate(action) {
    await ready();
    if (mutating) throw failure('BUSY', '另一项设置操作尚未完成，请稍后重试');
    mutating = true; generation++; clearScheduled(); activeAbort?.abort();
    const operation = (async () => {
      await active?.catch(() => {}); lifetime.signal.throwIfAborted();
      return store.exclusive(async () => { lifetime.signal.throwIfAborted(); return action(); });
    })();
    mutationTask = operation;
    try { return await operation; }
    finally { mutating = false; if (mutationTask === operation) mutationTask = null; }
  }
  async function assertIdentity(server, username, deviceId) {
    const old = await store.config(), pending = await store.pending();
    assert(!pending.length || pending.every(item => item.deviceId === deviceId), '待上传队列属于另一个设备，请先处理队列');
    const hasHistory = pending.length || Object.keys((await store.state()).projects).length;
    if (hasHistory && old?.server && (old.server !== server || old.username !== username)) {
      throw failure('ACCOUNT_BOUND', '已有同步历史绑定原账号；更换账号需使用独立 stateDir，旧记录不会被自动转发');
    }
  }
  async function loginWithinMutation({ server, username, password, signal }, { commit, persistIdentity } = {}) {
    server = validateServerUrl(server);
    assert(typeof username === 'string' && username.trim().length > 0 && Buffer.byteLength(username) <= 128 && !/[\x00-\x1f\x7f]/.test(username), 'Invalid username');
    assert(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 1024, 'Invalid password');
    const oldLocal = await store.config(), oldNative = await ctx.credentials?.readRecord?.(credentialKey);
    const recovering = oldLocal?.reauthRequired === true || await requiresReauthentication();
    const deviceId = oldLocal?.deviceId || newDeviceId();
    await assertIdentity(server, username, deviceId);
    const requestSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const client = new SyncClient({ server, signal: requestSignal });
    const result = await client.login({ username, password, deviceId });
    const record = { kind: 'grant', payload: { server, username, deviceId, ...result } };
    let committed = false, identitySaved = false, rollbackPreferences;
    try {
      requestSignal.throwIfAborted();
      if (commit) await commit(record);
      else await ctx.credentials.modifyRecord(credentialKey, async () => record);
      committed = true; requestSignal.throwIfAborted();
      await store.saveConfig({ server, username, deviceId }); identitySaved = true;
      requestSignal.throwIfAborted();
      rollbackPreferences = await (persistIdentity || identityPersister)?.({ server, username }, { pauseAutoSync: recovering });
      requestSignal.throwIfAborted();
      // Removing the intent is the final local commit point, after all fresh grant writes.
      // Do not revive an old grant on a later cancellation once this point was admitted.
      if (recovering) await clearReauthMarker();
      replaceConfiguration({ server, username, ...(recovering ? { autoSync: false } : {}) });
    } catch (error) {
      // If independent stores cannot all commit, fail closed and revoke the new grant.
      if (typeof rollbackPreferences === 'function') await rollbackPreferences().catch(() => { config.autoSync = false; });
      if (identitySaved) await store.saveConfig(oldLocal || {}).catch(() => {});
      if (committed) {
        try {
          if (oldNative) await ctx.credentials.modifyRecord(credentialKey, async current => current?.payload?.token === result.token ? oldNative : undefined);
          else if ((await ctx.credentials.readRecord(credentialKey))?.payload?.token === result.token) await ctx.credentials.deleteRecord(credentialKey);
        } catch { config.autoSync = false; }
      }
      await new SyncClient({ server, token: result.token, timeoutMs: 5000 }).logout();
      throw error;
    }
    // A replaced local grant need not remain usable until its original expiry.
    const seen = new Set([result.token]); let oldGrantsRevoked = true;
    for (const old of [oldNative?.kind === 'grant' ? oldNative.payload : undefined, oldLocal]) {
      if (!old?.token || seen.has(old.token)) continue;
      seen.add(old.token); oldGrantsRevoked = (await revokeOwnedGrant(old)).remoteRevoked && oldGrantsRevoked;
    }
    return { server, username, expiresAt: result.expiresAt, ...(oldGrantsRevoked ? {} : { warning: '新登录已成功，旧令牌撤销未确认' }) };
  }
  async function invalidateLocalCredentials(server, username, persistLogout) {
    config.autoSync = false;
    let cleanupFailed = false;
    try { await ctx.credentials.deleteRecord(credentialKey); } catch { cleanupFailed = true; }
    try {
      const local = await store.config();
      await store.saveConfig({ server, username, ...(local?.deviceId ? { deviceId: local.deviceId } : {}), reauthRequired: true });
    } catch { cleanupFailed = true; }
    try { await persistLogout?.(); } catch { cleanupFailed = true; }
    // The intent marker is deliberately retained even when another store cannot be written.
    return cleanupFailed;
  }
  async function changePasswordWithinMutation(input, { beforeChange, persistLogout } = {}) {
    await beforeChange?.();
    const server = validateServerUrl(input.server), { username, currentPassword, newPassword } = validatePasswordChange(input);
    if (server !== config.server || username !== config.username) throw failure('ACCOUNT_MISMATCH', '账号已变更');
    const local = await store.config();
    if (local?.server && (local.server !== server || local.username !== username)) throw failure('ACCOUNT_MISMATCH', '本机账号不一致');
    if (local?.deviceId !== undefined) validateId(local.deviceId);
    const signal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const hadMarker = await requiresReauthentication();
    // Durable intent precedes the irreversible remote operation. It contains no password/token.
    await atomicWrite(reauthMarker, JSON.stringify({ version: 1, server, username, startedAt: new Date().toISOString() }));
    let sent = false;
    try {
      signal.throwIfAborted();
      sent = true;
      await new SyncClient({ server, signal }).changePassword({ username, currentPassword, newPassword });
    } catch (error) {
      if (!sent || error.definitive === true) {
        if (!hadMarker) {
          try { await clearReauthMarker(); }
          catch { throw failure('SETTINGS_FAILED', '请重新登录'); }
        }
        throw error;
      }
      await invalidateLocalCredentials(server, username, persistLogout);
      throw failure('PASSWORD_CHANGE_UNCERTAIN', '结果未确认，请重新登录');
    }
    // A confirmed cloud password change cannot be rolled back by a local cancellation.
    const cleanupFailed = await invalidateLocalCredentials(server, username, persistLogout);
    return { changed: true, ...(cleanupFailed ? { warning: '密码已修改，本机清理未完成' } : {}) };
  }
  async function push(id) {
    await ready();
    if (mutating || active) throw failure('BUSY', '同步或设置操作正在进行');
    const mapping = project(id), epoch = generation, abort = new AbortController(); activeAbort = abort;
    const operation = (async () => {
      try {
        const result = await store.exclusive(async () => {
          await rootAdmission(mapping);
          assert(generation === epoch && !mutating, 'Sync selection changed');
          const credentials = await account(), client = new SyncClient({ ...credentials, signal: AbortSignal.any([lifetime.signal, abort.signal]) });
          const validatedQueues = new Set();
          const preflight = async manifest => {
            client.signal.throwIfAborted();
            await rootAdmission(mapping);
            assert(generation === epoch && !mutating, 'Sync selection changed');
            const current = await account();
            if (current.server !== credentials.server || current.username !== credentials.username || current.deviceId !== credentials.deviceId || current.token !== credentials.token) throw failure('ACCOUNT_MISMATCH', '登录身份在同步期间变更，已停止上传');
            const excluded = (await captureExclusions(mapping)).map(value => value.toLowerCase());
            const validationKey = `${manifest.id}:${JSON.stringify(excluded)}`;
            if (!validatedQueues.has(validationKey)) {
              for (const file of manifest.files) {
                if (!file.path.startsWith('project/')) continue;
                const relative = file.path.slice(8), folded = relative.toLowerCase();
                if (isExcluded(relative) || excluded.some(value => folded === value || folded.startsWith(`${value}/`))) throw failure('PROTECTED_QUEUE', '旧检查点含当前禁止上传的路径，已保留在本机，请先处理旧队列');
              }
              validatedQueues.add(validationKey);
            }
            client.signal.throwIfAborted();
          };
          const flushOptions = { root: mapping.root, deviceId: credentials.deviceId, beforeUpload: preflight, beforeCommit: preflight };
          const retried = await store.flush(client, id, flushOptions);
          const exported = await exportSessions(ctx, mapping.root);
          client.signal.throwIfAborted();
          if (exported.skipped.some(item => /active|busy|running|pending|incomplete/i.test(item.reason))) return { projectId: id, deferred: true, skippedSessions: exported.skipped, retried };
          const captured = await store.capture({ root: mapping.root, projectId: id, deviceId: credentials.deviceId, signal: client.signal, sessions: exported.sessions, assets: exported.assets, excludedPaths: await captureExclusions(mapping), beforeQueue: async () => {
            client.signal.throwIfAborted(); assert(epoch === generation, 'Sync selection changed');
            await rootAdmission(mapping); await exported.verifyUnchanged?.();
          } });
          const uploaded = await store.flush(client, id, flushOptions);
          return { projectId: id, checkpointId: captured.queuedId, unchanged: captured.unchanged, uploaded: [...retried, ...uploaded], skippedFiles: captured.skipped, skippedSessions: exported.skipped };
        });
        lastResult = { at: new Date().toISOString(), results: [result] }; return result;
      } catch (error) { lastResult = { at: new Date().toISOString(), error: error.message, errorCode: error.code }; throw error; }
      finally { activeAbort = undefined; }
    })();
    active = operation;
    try { return await operation; } finally { if (active === operation) active = null; }
  }
  const controller = {
    get config() { return config; }, store, credentialKey,
    setInitializer(value) { initializer = value; },
    setRootAdmission(value) { rootAdmission = value; },
    setCaptureExclusions(value) { captureExclusions = value; },
    setIdentityPersister(value) { identityPersister = value; },
    replaceConfiguration,
    mutate,
    login(input, options) { return mutate(() => loginWithinMutation(input, options)); },
    async changePassword(input, options) {
      validatePasswordChange(input);
      let confirmed, operationFailure;
      try {
        return await mutate(async () => {
          try { confirmed = await changePasswordWithinMutation(input, options); return confirmed; }
          catch (error) { operationFailure = error; throw error; }
        });
      } catch (error) {
        // A lock-release failure must not turn a confirmed cloud commit into a false refusal.
        if (confirmed?.changed === true) return { ...confirmed, warning: '密码已修改，本机清理未完成' };
        if (operationFailure?.code === 'PASSWORD_CHANGE_UNCERTAIN') throw operationFailure;
        throw error;
      }
    },
    async authorize(session) {
      await ready(); assert(config.server, '请先在设置中填写 HTTPS server');
      return mutate(async () => {
        const old = await store.config(), deviceId = old?.deviceId || newDeviceId();
        const username = config.username || await session.prompt({ kind: 'text', message: '同步账号用户名', signal: session.signal });
        await assertIdentity(config.server, username, deviceId);
        const password = await session.prompt({ kind: 'secret', message: `输入 ${config.server} 的同步密码（不发送给模型）`, signal: session.signal });
        session.signal.throwIfAborted();
        return loginWithinMutation({ server: config.server, username, password, signal: session.signal }, { commit: record => session.commit(record) });
      });
    },
    push,
    async tick() {
      await ready(); if (mutating || batchRunning || active) return;
      batchRunning = true; const epoch = generation, results = [];
      try {
        for (const item of [...config.projects]) {
          if (stopped || epoch !== generation || mutating) break;
          try { results.push(await push(item.id)); }
          catch (error) { results.push({ projectId: item.id, error: error.message, errorCode: error.code }); }
        }
        if (results.length) lastResult = { at: new Date().toISOString(), results };
        return lastResult;
      } finally { batchRunning = false; }
    },
    schedulePush(id) {
      project(id); assert(!stopped, 'Plugin is stopped');
      const handle = setImmediate(() => {
        scheduled.delete(handle); if (!stopped) void push(id).catch(() => {});
      });
      scheduled.add(handle); return { scheduled: true, next: '命令结束后执行同步，请用设置页或 /sync-status 查看结果。' };
    },
    async scheduleSelected(workspaceId) {
      await ready();
      if (mutating || active || batchRunning || scheduled.size) throw failure('BUSY', '同步或设置操作正在进行');
      const credentials = await account();
      if (Date.parse(credentials.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '登录已过期，请重新登录');
      if (workspaceId !== undefined) {
        const mapping = config.projects.find(item => item.workspaceId === workspaceId);
        assert(mapping, 'Project is not selected'); return controller.schedulePush(mapping.id);
      }
      assert(config.projects.length > 0, 'No projects selected');
      const handle = setImmediate(() => { scheduled.delete(handle); if (!stopped) void controller.tick().catch(() => {}); });
      scheduled.add(handle); return { scheduled: true };
    },
    async status() {
      await ready(); await store.init();
      let loggedIn = false, expiresAt, reauthRequired = true;
      try { reauthRequired = await requiresReauthentication() || (await store.config())?.reauthRequired === true; } catch {}
      try { const record = await account(); expiresAt = record.expiresAt; loggedIn = Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now(); } catch {}
      return { server: config.server, username: config.username, loggedIn, reauthRequired, ...(expiresAt ? { expiresAt } : {}), autoSync: !reauthRequired && config.autoSync, intervalMs: config.intervalMs, projects: config.projects, pending: (await store.pending()).length, running: Boolean(active || batchRunning || scheduled.size), lastResult };
    },
    async list(id) { await ready(); validateId(id); return new SyncClient({ ...await account(), signal: lifetime.signal }).list(id); },
    async restore(id, destination) {
      await ready(); assert(typeof destination === 'string' && path.isAbsolute(destination), '恢复目录必须是绝对路径且尚不存在');
      return mutate(async () => {
        const result = await store.restore(new SyncClient({ ...await account(), signal: lifetime.signal }), id, destination);
        return { root: result.root, sessionIds: result.sessionIds, next: '检查新目录内容后执行 /sync-import；不会自动执行恢复的项目。' };
      });
    },
    async import(root) {
      await ready(); assert(typeof root === 'string' && path.isAbsolute(root), 'Import root must be absolute');
      const { readJson, assertNoSymlinks } = await import('../src/files.mjs');
      const manifestFile = await assertNoSymlinks(path.join(root, '.dsh-sync', 'manifest.json'));
      return mutate(async () => importSessions(ctx, { manifest: await readJson(manifestFile), root }));
    },
    async logout({ persistLogout } = {}) {
      return mutate(async () => {
        const native = await ctx.credentials.readRecord(credentialKey), local = await store.config();
        const records = [native?.kind === 'grant' ? native.payload : undefined, local].filter(value => value?.token);
        const seen = new Set(), results = [];
        for (const record of records) {
          if (seen.has(record.token)) continue;
          seen.add(record.token); results.push(await revokeOwnedGrant(record));
        }
        await ctx.credentials.deleteRecord(credentialKey);
        if (local) { delete local.token; delete local.expiresAt; await store.saveConfig(local); }
        config.autoSync = false; await persistLogout?.();
        const remoteRevoked = results.every(result => result.remoteRevoked);
        return { loggedOut: true, remoteRevoked, ...(remoteRevoked ? {} : { warning: '远端撤销未确认' }) };
      });
    },
    stop() { stopped = true; generation++; lifetime.abort(); activeAbort?.abort(); clearScheduled(); },
    async drain() { await Promise.allSettled([active, mutationTask].filter(Boolean)); },
  };
  return controller;
}
