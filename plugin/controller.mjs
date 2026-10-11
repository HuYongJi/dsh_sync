import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { assert, validateId, validateManifest, sha256, MAX_FILES, MAX_MANIFEST_BYTES } from '../src/protocol.mjs';
import { atomicWrite, assertNoSymlinks, readStableFile } from '../src/files.mjs';
import { SyncClient, validateServerUrl, validatePasswordChange, projectFolderMetadata } from '../src/client.mjs';
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

export function createController(ctx, initialConfig, { exportSessions = exportProjectSessions, importSessions = importProjectSessions, credentialKey = CREDENTIAL_KEY, allowLegacyCli = true, maxRecoveryRequests = 1000 } = {}) {
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
  assert(Number.isSafeInteger(maxRecoveryRequests) && maxRecoveryRequests > 0 && maxRecoveryRequests <= 10_000, 'Invalid recovery limit');
  const recoveryIds = new Map();
  let recoveryTask = null, recoveryAbort, latestRecovery, latestRestore;
  let restoreAdmission = async () => {};
  let stopped = false, mutating = false, batchRunning = false, active = null, activeAbort, mutationTask = null, generation = 0, lastResult = null;
  let updateRunning = false, updateRestartRequired = false;
  function updateAdmission(allowAfterUpdate = false) {
    if (updateRunning) throw failure('BUSY', '插件更新进行中');
    if (updateRestartRequired && !allowAfterUpdate) throw failure('UPDATE_RESTART_REQUIRED', '插件文件可能已变更，请先重启 DSH');
  }
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
  async function mutate(action, { cancelRecovery = false, requireIdle = false, allowAfterUpdate = false } = {}) {
    await ready(); updateAdmission(allowAfterUpdate);
    if (mutating || (recoveryTask && !cancelRecovery) || (requireIdle && (active || batchRunning || scheduled.size))) throw failure('BUSY', '另一项操作尚未完成，请稍后重试');
    mutating = true; generation++; clearScheduled(); activeAbort?.abort();
    if (cancelRecovery) recoveryAbort?.abort();
    const operation = (async () => {
      await Promise.allSettled([active, cancelRecovery ? recoveryTask : null].filter(Boolean)); lifetime.signal.throwIfAborted();
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
    await ready(); updateAdmission();
    if (mutating || active || recoveryTask) throw failure('BUSY', '同步或设置操作正在进行');
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
  const sameAccount = (a, b) => a && b && ['server', 'username', 'deviceId', 'token'].every(key => a[key] === b[key]);
  const publicRecovery = job => structuredClone(job.value);
  // One trusted read boundary for cloud browsing and Host chooser calls. Never nest mutate.
  function readAccount(action, { checkBinding, signal } = {}) {
    return mutate(async () => {
      const requestSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      requestSignal.throwIfAborted(); await checkBinding();
      const identity = await account();
      const check = async () => {
        requestSignal.throwIfAborted(); await checkBinding();
        if (!sameAccount(identity, await account())) throw failure('ACCOUNT_MISMATCH', '账号已变更');
        if (Date.parse(identity.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '请重新登录');
        requestSignal.throwIfAborted();
      };
      await check();
      const value = await action({ identity, client: new SyncClient({ ...identity, signal: requestSignal }), signal: requestSignal, check });
      await check(); return value;
    }, { requireIdle: true });
  }
  async function cloudProjects({ client, check }, knownProjects) {
    const known = await knownProjects?.() || [], byId = new Map();
    for (const item of known) { validateId(item.projectId); if (!byId.has(item.projectId)) byId.set(item.projectId, item); }
    let result, legacy = false, partial = false;
    try { result = await client.projects(); }
    catch (error) {
      await check();
      if (error.code !== 'CLOUD_BROWSE_UNSUPPORTED') throw error;
      if (!byId.size) throw failure('CLOUD_BROWSE_UNSUPPORTED', '请更新同步服务器');
      legacy = true; partial = byId.size > 200;
      result = { projects: [...byId.values()].slice(0, 200).map(item => ({ projectId: item.projectId })) };
    }
    const projects = [];
    for (const item of result.projects) {
      await check();
      let row = item;
      try {
        if (!item.label || !item.checkpointCount) {
          legacy = true;
          const catalog = await client.list(item.projectId); await check();
          if (!catalog.checkpoints.length) continue;
          const last = catalog.checkpoints.at(-1);
          row = { projectId: item.projectId, checkpointCount: catalog.checkpoints.length, latestCreatedAt: catalog.checkpoints.reduce((value, entry) => Date.parse(entry.createdAt) > Date.parse(value) ? entry.createdAt : value, catalog.checkpoints[0].createdAt) };
          try {
            const manifest = await client.getCheckpoint(last.id); await check();
            if (manifest.projectId !== item.projectId) throw failure('CHECKPOINT_MISMATCH');
            Object.assign(row, projectFolderMetadata(manifest.sourceRoot));
          } catch (error) {
            await check(); if (error.status === 401) throw error;
            const knownLabel = byId.get(item.projectId)?.label;
            if (!knownLabel) throw error;
            row.label = knownLabel; partial = true;
          }
        }
        projects.push({ projectId: row.projectId, label: row.label, ...(row.sourceRoot !== undefined ? { sourceRoot: row.sourceRoot } : {}), checkpointCount: row.checkpointCount, latestCreatedAt: row.latestCreatedAt });
      } catch (error) {
        await check(); if (error.status === 401) throw error;
        partial = true;
      }
    }
    return { projects, ...(legacy ? { legacy: true } : {}), ...(partial ? { partial: true } : {}) };
  }
  function importSummary(result, manifest) {
    const sessions = [], known = new Set(manifest.sessionIds), seen = new Set(), reported = new Set();
    for (const [field, outcome] of [['imported', 'imported'], ['skipped', 'skipped'], ['failed', 'failed']]) {
      assert(Array.isArray(result?.[field]) && result[field].length <= MAX_FILES * 2, 'Invalid import result');
      for (const entry of result[field]) {
        const sourceId = validateId(outcome === 'imported' ? entry?.sourceId : entry?.id);
        assert(known.has(sourceId), 'Unknown import source');
        const sessionId = entry.sessionId === undefined ? undefined : validateId(entry.sessionId);
        if (outcome === 'imported') assert(sessionId && typeof entry.workspaceAttached === 'boolean', 'Invalid imported session');
        const key = `${outcome}:${sourceId}:${sessionId || ''}`;
        if (seen.has(key)) continue; seen.add(key); reported.add(sourceId);
        sessions.push({ sourceId, ...(sessionId ? { sessionId } : {}), outcome, ...(outcome === 'imported' ? { workspaceAttached: entry.workspaceAttached } : {}) });
      }
    }
    assert(manifest.sessionIds.every(id => reported.has(id)), 'Incomplete import result');
    return { importedCount: sessions.filter(item => item.outcome === 'imported').length, skippedCount: sessions.filter(item => item.outcome === 'skipped').length, failedCount: sessions.filter(item => item.outcome === 'failed').length, sessions };
  }
  function recoveryError(error, kind) {
    const safe = new Set(['NOT_LOGGED_IN', 'ACCOUNT_MISMATCH', 'CONFIG_CONFLICT', 'BAD_DESTINATION', 'DESTINATION_EXISTS', 'DESTINATION_CHANGED', 'DIRECTORY_PICKER_EXPIRED', 'PROTECTED_DESTINATION', 'CHECKPOINT_MISMATCH', 'RECOVERY_UNAVAILABLE', 'BUSY']);
    if (stopped) return 'DISPOSED';
    if (safe.has(error?.code)) return error.code;
    if (error?.status === 401) return 'NOT_LOGGED_IN';
    if (error?.code === 'EEXIST' && kind === 'restore') return 'DESTINATION_EXISTS';
    return kind === 'restore' ? 'RESTORE_FAILED' : 'IMPORT_FAILED';
  }
  async function startRecovery(kind, input, { checkBinding, admitDestination, signal, resolveDestination } = {}) {
    await ready(); updateAdmission(); await checkBinding(); signal?.throwIfAborted();
    const credentials = await account();
    await checkBinding(); signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    if (Date.parse(credentials.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '请重新登录');
    const fingerprint = JSON.stringify({ kind, ...input });
    const prior = recoveryIds.get(input.requestId);
    if (prior) {
      if (!sameAccount(prior.identity, credentials)) throw failure('RECOVERY_UNAVAILABLE', '恢复请求不可用');
      if (prior.fingerprint !== fingerprint) throw failure('BAD_REQUEST', '请求 ID 已使用');
      return { recovery: publicRecovery(prior) };
    }
    updateAdmission();
    if (mutating || active || batchRunning || scheduled.size || recoveryTask) throw failure('BUSY', '另一项操作尚未完成');
    if (recoveryIds.size >= maxRecoveryRequests) throw failure('RECOVERY_LIMIT', '恢复请求已达上限');
    const restored = latestRestore;
    if (kind === 'import' && (!restored || restored.value.id !== input.restoreId || restored.consumed || !sameAccount(restored.identity, credentials))) throw failure('RECOVERY_UNAVAILABLE', '没有可导入的本次恢复');
    // Resolve opaque plans only AFTER duplicate requests have returned their original outcome.
    // Resolution is synchronous; do not open an admission race between the busy check and reservation.
    const destinationPlan = kind === 'restore' ? resolveDestination?.(credentials) : undefined;
    const destination = destinationPlan?.root ?? input.destination;
    const job = { identity: credentials, fingerprint, value: { id: input.requestId, kind, state: 'running', root: kind === 'restore' ? destination : restored.value.root, checkpointId: kind === 'restore' ? input.checkpointId : restored.value.checkpointId, ...(kind === 'import' ? { sessionCount: restored.value.sessionCount } : {}) } };
    recoveryIds.set(input.requestId, job); latestRecovery = job;
    const abort = new AbortController(); recoveryAbort = abort;
    const taskSignal = AbortSignal.any([lifetime.signal, abort.signal]);
    // Page-request cancellation is intentionally not linked after acceptance.
    const operation = Promise.resolve().then(async () => {
      let completedRestore;
      try {
        await store.exclusive(async () => {
          const check = async () => {
            taskSignal.throwIfAborted(); await checkBinding();
            if (!sameAccount(credentials, await account())) throw failure('ACCOUNT_MISMATCH', '账号已变更');
            taskSignal.throwIfAborted();
          };
          await check();
          if (kind === 'restore') {
            await destinationPlan?.check(); await admitDestination(destination);
            let reserved = false;
            const result = await store.restore(new SyncClient({ ...credentials, signal: taskSignal }), input.checkpointId, destination, {
              projectId: input.projectId, signal: taskSignal,
              beforeWrite: async () => { await check(); await destinationPlan?.check({ reserved }); await admitDestination(destination, { reserved }); reserved = true; taskSignal.throwIfAborted(); },
            });
            job.value.sessionCount = result.sessionIds.length;
            job.manifest = result.manifest; completedRestore = job;
          } else {
            // Consume before invoking the native adapter: a partial/durable import must
            // not be replayed with a fresh request ID after an ambiguous failure.
            restored.consumed = true;
            const filename = await assertNoSymlinks(path.join(restored.value.root, '.dsh-sync', 'manifest.json'));
            const manifest = validateManifest(JSON.parse((await readStableFile(filename, MAX_MANIFEST_BYTES * 2)).bytes.toString('utf8')));
            assert(JSON.stringify(manifest) === JSON.stringify(restored.manifest), 'Restored manifest changed');
            await check();
            const result = await importSessions(ctx, { manifest, root: restored.value.root });
            Object.assign(job.value, importSummary(result, manifest));
            await check(); // Keep counts/IDs even if logout/disposal happened mid-adapter.
            if (job.value.skippedCount || job.value.failedCount || job.value.sessions.some(item => item.outcome === 'imported' && !item.workspaceAttached)) throw failure('IMPORT_FAILED', '导入未全部完成');
          }
        });
        job.value.state = 'succeeded';
        if (completedRestore) {
          if (latestRestore) delete latestRestore.manifest;
          latestRestore = completedRestore;
        }
      } catch (error) { job.value.state = 'failed'; job.value.errorCode = recoveryError(error, kind); }
    }).finally(() => {
      if (kind === 'import' && restored.consumed) delete restored.manifest;
      if (recoveryTask === operation) { recoveryTask = null; recoveryAbort = undefined; }
    });
    recoveryTask = operation;
    return { recovery: publicRecovery(job) };
  }
  const controller = {
    get config() { return config; }, store, credentialKey,
    setInitializer(value) { initializer = value; },
    setRootAdmission(value) { rootAdmission = value; },
    setCaptureExclusions(value) { captureExclusions = value; },
    setRestoreAdmission(value) { restoreAdmission = value; },
    startRecovery,
    readAccount,
    async browse(kind, projectId, { checkBinding, signal, knownProjects } = {}) {
      return readAccount(context => kind === 'projects' ? cloudProjects(context, knownProjects) : context.client.list(projectId), { checkBinding, signal });
    },
    setIdentityPersister(value) { identityPersister = value; },
    replaceConfiguration,
    mutate,
    // Only admission/acceptance is under the shared mutation lock. Native work is
    // Host-owned; a permanent write barrier remains after it starts, even on failure.
    markUpdateRestartRequired() { updateRestartRequired = true; },
    runUpdate(action) {
      return mutate(() => action({
        begin() {
          lifetime.signal.throwIfAborted(); updateAdmission();
          updateRunning = true; updateRestartRequired = true;
        },
        settled() { updateRunning = false; },
      }), { requireIdle: true });
    },
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
      await ready(); if (updateRestartRequired || updateRunning || mutating || batchRunning || active || recoveryTask) return;
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
      updateAdmission(); project(id); assert(!stopped, 'Plugin is stopped');
      if (recoveryTask || mutating) throw failure('BUSY', '另一项操作尚未完成');
      const handle = setImmediate(() => {
        scheduled.delete(handle); if (!stopped) void push(id).catch(() => {});
      });
      scheduled.add(handle); return { scheduled: true, next: '命令结束后执行同步，请用设置页或 /sync-status 查看结果。' };
    },
    async scheduleSelected(workspaceId) {
      await ready(); updateAdmission();
      if (mutating || active || batchRunning || scheduled.size || recoveryTask) throw failure('BUSY', '同步或设置操作正在进行');
      const credentials = await account();
      if (Date.parse(credentials.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '登录已过期，请重新登录');
      if (workspaceId !== undefined) {
        const mapping = config.projects.find(item => item.workspaceId === workspaceId);
        assert(mapping, 'Project is not selected'); return controller.schedulePush(mapping.id);
      }
      updateAdmission();
      assert(config.projects.length > 0, 'No projects selected');
      const handle = setImmediate(() => { scheduled.delete(handle); if (!stopped) void controller.tick().catch(() => {}); });
      scheduled.add(handle); return { scheduled: true };
    },
    async status() {
      await ready(); await store.init();
      const epoch = generation, pending = (await store.pending()).length;
      let loggedIn = false, expiresAt, identity, reauthRequired = true;
      try { reauthRequired = await requiresReauthentication() || (await store.config())?.reauthRequired === true; } catch {}
      try { const record = await account(); identity = record; expiresAt = record.expiresAt; loggedIn = Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now(); } catch {}
      return { server: config.server, username: config.username, loggedIn, reauthRequired, ...(expiresAt ? { expiresAt } : {}), autoSync: !reauthRequired && config.autoSync, intervalMs: config.intervalMs, projects: config.projects, pending, running: Boolean(updateRunning || active || batchRunning || scheduled.size || recoveryTask), lastResult, ...(latestRecovery && loggedIn && !mutating && epoch === generation && sameAccount(latestRecovery.identity, identity) ? { recovery: publicRecovery(latestRecovery) } : {}) };
    },
    async list(id) { await ready(); validateId(id); return new SyncClient({ ...await account(), signal: lifetime.signal }).list(id); },
    async restore(id, destination) {
      await ready(); assert(typeof destination === 'string' && path.isAbsolute(destination), '恢复目录必须是绝对路径且尚不存在');
      return mutate(async () => {
        await restoreAdmission(destination);
        let reserved = false;
        const result = await store.restore(new SyncClient({ ...await account(), signal: lifetime.signal }), id, destination, { beforeWrite: async () => { await restoreAdmission(destination, { reserved }); reserved = true; } });
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
        if (latestRestore) delete latestRestore.manifest;
        latestRestore = undefined;
        const remoteRevoked = results.every(result => result.remoteRevoked);
        return { loggedOut: true, remoteRevoked, ...(remoteRevoked ? {} : { warning: '远端撤销未确认' }) };
      }, { cancelRecovery: true, allowAfterUpdate: true });
    },
    stop() { stopped = true; generation++; lifetime.abort(); activeAbort?.abort(); recoveryAbort?.abort(); clearScheduled(); },
    async drain() { await Promise.allSettled([active, mutationTask, recoveryTask].filter(Boolean)); },
  };
  return controller;
}
