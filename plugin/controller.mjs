import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assert, validateId, validateManifest, sha256, MAX_FILES, MAX_MANIFEST_BYTES } from '../src/protocol.mjs';
import { atomicWrite, assertNoSymlinks, readStableFile } from '../src/files.mjs';
import { SyncClient, validateServerUrl, validatePasswordChange, projectFolderMetadata } from '../src/client.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { LocalStore, newDeviceId } from '../src/local-store.mjs';
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
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RENEW_BEFORE_MS = 5 * 60_000;
const RENEWABLE_FIELDS = ['familyId', 'serverId', 'refreshToken', 'refreshExpiresAt', 'absoluteExpiresAt'];
const canonicalDate = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function authorizationEpoch(value) {
  const epoch = value?.authorizationEpoch === undefined ? 0 : value.authorizationEpoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw failure('ACCOUNT_MISMATCH', '登录记录无效，请重新登录');
  return epoch;
}
function nextAuthorizationEpoch(...values) {
  const epoch = Math.max(...values.map(authorizationEpoch));
  if (epoch === Number.MAX_SAFE_INTEGER) throw failure('ACCOUNT_MISMATCH', '登录记录无效，请重新登录');
  return epoch + 1;
}
function grantIdentity(value, { native = true } = {}) {
  if (!value?.token || !value?.server || !value?.deviceId) throw failure('NOT_LOGGED_IN', '请先在设置 → 个人云同步中登录');
  try {
    assert(typeof value.token === 'string' && TOKEN.test(value.token) && typeof value.username === 'string' && value.username.length > 0 && Buffer.byteLength(value.username) <= 128 && !/[\x00-\x1f\x7f]/.test(value.username) && canonicalDate(value.expiresAt), 'Invalid grant');
    const server = validateServerUrl(value.server), deviceId = validateId(value.deviceId), epoch = authorizationEpoch(value);
    const identity = { server, username: value.username, token: value.token, deviceId, expiresAt: value.expiresAt, authorizationEpoch: epoch, authEpoch: epoch };
    if (RENEWABLE_FIELDS.some(key => Object.hasOwn(value, key))) {
      assert(native && typeof value.refreshToken === 'string' && TOKEN.test(value.refreshToken) && typeof value.familyId === 'string' && TOKEN.test(value.familyId), 'Invalid renewable grant');
      const serverId = validateId(value.serverId);
      assert(canonicalDate(value.refreshExpiresAt) && canonicalDate(value.absoluteExpiresAt) && Date.parse(value.expiresAt) <= Date.parse(value.refreshExpiresAt) && Date.parse(value.refreshExpiresAt) <= Date.parse(value.absoluteExpiresAt), 'Invalid grant expiry');
      Object.assign(identity, { serverId, familyId: value.familyId, refreshToken: value.refreshToken, refreshExpiresAt: value.refreshExpiresAt, absoluteExpiresAt: value.absoluteExpiresAt });
    }
    return Object.freeze(identity);
  } catch { throw failure('ACCOUNT_MISMATCH', '登录记录无效，请重新登录'); }
}
async function revokeOwnedGrant(record) {
  if (!record?.token) return { remoteRevoked: true };
  try {
    if (record.refreshToken) {
      const identity = grantIdentity(record);
      await new SyncV2Client({ ...identity, timeoutMs: 5000 }).revokeGrant(identity);
      return { remoteRevoked: true };
    }
    return await new SyncClient({ ...record, timeoutMs: 5000 }).logout();
  } catch { return { remoteRevoked: false }; } // Unknown/used refresh proof does not prove that a family was revoked.
}

export function createController(ctx, initialConfig, { exportSessions = exportProjectSessions, importSessions = importProjectSessions, credentialKey = CREDENTIAL_KEY, allowLegacyCli = true, maxRecoveryRequests = 1000 } = {}) {
  let config = normalizeConfig(initialConfig), initializer = async () => {}, rootAdmission = async () => {}, captureExclusions = async () => [], additionalIdentityAdmission = async () => {}, identityPersister;
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
  const recoveryIds = new Map(), registrations = new Map();
  const recoveryFile = path.join(store.directory, `recovery-${sha256(credentialKey).slice(0, 24)}.json`);
  const MAX_RECOVERY_BYTES = 16 * 1024 * 1024;
  let recoveryLoaded = false, recoveryLoading;
  let recoveryTask = null, recoveryAbort, latestRecovery, latestRestore;
  let downloadTask = null, downloadAbort, latestDownload;
  const batchRestores = new Map();
  function clearBatchRestores() {
    for (const restored of batchRestores.values()) restored.batchItem.canImport = false;
    batchRestores.clear();
  }
  let restoreAdmission = async () => {};
  let stopped = false, mutating = false, batchRunning = false, active = null, activeAbort, mutationTask = null, generation = 0, lastResult = null;
  let updateRunning = false, updateRestartRequired = false;
  function updateAdmission(allowAfterUpdate = false) {
    if (updateRunning) throw failure('BUSY', '插件更新进行中');
    if (updateRestartRequired && !allowAfterUpdate) throw failure('UPDATE_RESTART_REQUIRED', '插件文件可能已变更，请先重启 DSH');
  }
  const ready = async () => { assert(!stopped, 'Plugin is stopped'); await initializer(); lifetime.signal.throwIfAborted(); };
  async function checkedAccount(native, local) {
    if (await requiresReauthentication() || local?.reauthRequired === true) throw failure('NOT_LOGGED_IN', '请重新登录');
    if (native !== undefined && (native?.kind !== 'grant' || !native.payload || typeof native.payload !== 'object' || Array.isArray(native.payload))) throw failure('ACCOUNT_MISMATCH', '原生登录记录无效，请重新登录');
    const identity = grantIdentity(native !== undefined ? native.payload : (allowLegacyCli ? local : undefined), { native: native !== undefined });
    if ((config.server && identity.server !== config.server) || (config.username !== undefined && identity.username !== config.username) || !local || local.server !== identity.server || local.username !== identity.username || local.deviceId !== identity.deviceId || authorizationEpoch(local) !== identity.authorizationEpoch) throw failure('ACCOUNT_MISMATCH', '账号、本机身份与同步设置不一致，请重新登录');
    return identity;
  }
  async function account() {
    if (await requiresReauthentication()) throw failure('NOT_LOGGED_IN', '请重新登录');
    return checkedAccount(await ctx.credentials.readRecord(credentialKey), await store.config());
  }
  async function writeReauthMarker(identity, reason) {
    await atomicWrite(reauthMarker, JSON.stringify({ version: 1, server: identity.server, username: identity.username, authorizationEpoch: identity.authorizationEpoch, reason, startedAt: new Date().toISOString() }));
  }
  async function pauseAuthorization(identity) {
    config.autoSync = false;
    // The pre-request marker is authoritative even if this secondary write fails.
    try { await writeReauthMarker(identity, 'AUTH_REAUTH_REQUIRED'); } catch {}
    try { await store.saveConfig({ server: identity.server, username: identity.username, deviceId: identity.deviceId, authorizationEpoch: identity.authorizationEpoch, reauthRequired: true }); } catch {}
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
    if (mutating || ((recoveryTask || downloadTask) && !cancelRecovery) || (requireIdle && (active || batchRunning || scheduled.size))) throw failure('BUSY', '另一项操作尚未完成，请稍后重试');
    mutating = true; generation++; clearScheduled(); activeAbort?.abort();
    if (cancelRecovery) { recoveryAbort?.abort(); downloadAbort?.abort(); }
    const operation = (async () => {
      await Promise.allSettled([active, cancelRecovery ? recoveryTask : null, cancelRecovery ? downloadTask : null].filter(Boolean)); lifetime.signal.throwIfAborted();
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
    await additionalIdentityAdmission({ server, username, deviceId });
  }
  async function loginWithinMutation({ server, username, password, signal, remember = false }, { commit, persistIdentity } = {}) {
    assert(typeof remember === 'boolean', 'remember must be boolean');
    server = validateServerUrl(server);
    assert(typeof username === 'string' && username.trim().length > 0 && Buffer.byteLength(username) <= 128 && !/[\x00-\x1f\x7f]/.test(username), 'Invalid username');
    assert(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 1024, 'Invalid password');
    const oldLocal = await store.config(), oldNative = await ctx.credentials?.readRecord?.(credentialKey);
    const recovering = oldLocal?.reauthRequired === true || await requiresReauthentication();
    const deviceId = oldLocal?.deviceId || newDeviceId();
    await assertIdentity(server, username, deviceId);
    const requestSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const client = remember ? new SyncV2Client({ server, signal: requestSignal }) : new SyncClient({ server, signal: requestSignal });
    if (remember && !await client.supportsV2()) throw failure('SYNC_CLIENT_UPGRADE_REQUIRED', '请先升级同步服务器');
    requestSignal.throwIfAborted();
    const result = await (remember ? client.loginRenewable({ username, password, deviceId }) : client.login({ username, password, deviceId }));
    let epoch = nextAuthorizationEpoch(oldLocal, oldNative?.payload), previousNative = oldNative;
    const record = { kind: 'grant', payload: { server, username, deviceId, ...result, authorizationEpoch: epoch } };
    grantIdentity(record.payload);
    let committed = false, identitySaved = false, rollbackPreferences;
    try {
      requestSignal.throwIfAborted();
      if (commit) await commit(record);
      else await ctx.credentials.modifyRecord(credentialKey, async current => {
        requestSignal.throwIfAborted();
        previousNative = current;
        epoch = nextAuthorizationEpoch(oldLocal, current?.payload);
        return { ...record, payload: { ...record.payload, authorizationEpoch: epoch } };
      });
      committed = true; requestSignal.throwIfAborted();
      await store.saveConfig({ server, username, deviceId, authorizationEpoch: epoch }); identitySaved = true;
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
          if (previousNative) await ctx.credentials.modifyRecord(credentialKey, async current => current?.payload?.token === result.token ? previousNative : undefined);
          else if ((await ctx.credentials.readRecord(credentialKey))?.payload?.token === result.token) await ctx.credentials.deleteRecord(credentialKey);
        } catch { config.autoSync = false; }
      }
      await revokeOwnedGrant({ server, username, deviceId, ...result, authorizationEpoch: epoch });
      throw error;
    }
    // A replaced local grant need not remain usable until its original expiry.
    const seen = new Set([result.token]); let oldGrantsRevoked = true;
    for (const old of [previousNative?.kind === 'grant' ? previousNative.payload : undefined, oldLocal]) {
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
      await store.saveConfig({ server, username, ...(local?.deviceId ? { deviceId: local.deviceId } : {}), authorizationEpoch: nextAuthorizationEpoch(local), reauthRequired: true });
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
  // Host timer only: never call this from status or nest it in another mutation.
  async function renewAuthorization() {
    await ready();
    if (updateRunning || updateRestartRequired || mutating || active || batchRunning || scheduled.size || recoveryTask || downloadTask) return { renewed: false, reason: 'busy' };
    let intent = false, identity, remoteRejected = false;
    try {
      return await mutate(async () => {
        let observed;
        try { observed = await account(); }
        catch (error) { if (error.code === 'NOT_LOGGED_IN') return { renewed: false, reason: 'reauth-required' }; throw error; }
        if (!observed.refreshToken) return { renewed: false, reason: 'not-renewable' };
        let renewed, skipped = 'not-due';
        // The SDK owns process-shared read/decide/replace exclusion. No network
        // request uses a refresh proof read before this native lock was acquired.
        await ctx.credentials.modifyRecord(credentialKey, async current => {
          lifetime.signal.throwIfAborted();
          identity = await checkedAccount(current, await store.config());
          if (!sameAccount(observed, identity)) throw failure('ACCOUNT_MISMATCH', '账号已变更');
          if (identity.token !== observed.token) { skipped = 'already-renewed'; return undefined; }
          const now = Date.now();
          if (Date.parse(identity.refreshExpiresAt) <= now || Date.parse(identity.absoluteExpiresAt) <= now) {
            await writeReauthMarker(identity, 'AUTH_EXPIRED'); intent = true; remoteRejected = true;
            throw failure('NOT_LOGGED_IN', '请重新登录');
          }
          if (Date.parse(identity.expiresAt) - now > RENEW_BEFORE_MS) return undefined;
          await writeReauthMarker(identity, 'AUTH_RENEWAL_PENDING'); intent = true;
          lifetime.signal.throwIfAborted();
          let result;
          try { result = await new SyncV2Client({ ...identity, signal: lifetime.signal }).refreshGrant(identity); }
          catch (error) { remoteRejected = error.httpStatus === 401; throw error; }
          const next = grantIdentity({ server: identity.server, username: identity.username, deviceId: identity.deviceId, ...result, authorizationEpoch: identity.authorizationEpoch });
          if (!sameAccount(identity, next) || next.absoluteExpiresAt !== identity.absoluteExpiresAt || next.token === identity.token || next.refreshToken === identity.refreshToken || Date.parse(next.expiresAt) <= Date.now()) throw failure('AUTH_RENEWAL_UNCERTAIN', '续期结果未确认，请重新登录');
          lifetime.signal.throwIfAborted();
          const { authEpoch: _alias, ...payload } = next;
          renewed = next;
          return { kind: 'grant', payload };
        });
        if (!renewed) return { renewed: false, reason: skipped };
        // A successful callback is not a durable write. Clear intent only after
        // modifyRecord resolves and a fresh native read confirms its current grant.
        const saved = await ctx.credentials.readRecord(credentialKey);
        if (saved?.kind !== 'grant' || !sameGrant(renewed, grantIdentity(saved.payload))) throw failure('AUTH_RENEWAL_UNCERTAIN', '续期结果未确认，请重新登录');
        lifetime.signal.throwIfAborted();
        await clearReauthMarker();
        return { renewed: true, expiresAt: renewed.expiresAt };
      }, { requireIdle: true });
    } catch (error) {
      if (intent) {
        await pauseAuthorization(identity);
        if (remoteRejected) throw Object.assign(failure('NOT_LOGGED_IN', '登录已失效，请重新登录'), { status: 401, httpStatus: 401 });
        throw failure('AUTH_RENEWAL_UNCERTAIN', '续期结果未确认，请重新登录');
      }
      if (error.code === 'BUSY') return { renewed: false, reason: 'busy' };
      if (error.code === 'NOT_LOGGED_IN') return { renewed: false, reason: 'reauth-required' };
      if (error.code === 'ACCOUNT_MISMATCH') throw failure('ACCOUNT_MISMATCH', '账号已变更，请重新登录');
      throw failure('SETTINGS_FAILED', '无法确认本机登录状态');
    }
  }
  async function push(id) {
    await ready(); updateAdmission();
    if (mutating || active || recoveryTask || downloadTask) throw failure('BUSY', '同步或设置操作正在进行');
    const mapping = project(id), epoch = generation, abort = new AbortController(); activeAbort = abort;
    const operation = (async () => {
      const uploaded = [], outcomes = [], progress = { projectId: id };
      try {
        const result = await store.exclusive(async () => {
          await rootAdmission(mapping);
          assert(generation === epoch && !mutating, 'Sync selection changed');
          const credentials = await account(), client = new SyncClient({ ...credentials, signal: AbortSignal.any([lifetime.signal, abort.signal]) });
          const preflight = async () => {
            client.signal.throwIfAborted();
            await rootAdmission(mapping);
            assert(generation === epoch && !mutating, 'Sync selection changed');
            const current = await account();
            if (!sameGrant(credentials, current)) throw failure('ACCOUNT_MISMATCH', '登录身份在同步期间变更，已停止上传');
            if (Date.parse(current.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '登录已过期，请重新登录');
            client.signal.throwIfAborted();
          };
          const flushOptions = { root: mapping.root, deviceId: credentials.deviceId, beforeFlush: preflight, beforeUpload: preflight, beforeCommit: preflight, getExcludedPaths: () => captureExclusions(mapping) };
          const flush = async () => {
            try {
              const confirmed = await store.flush(client, id, flushOptions);
              uploaded.push(...confirmed);
              outcomes.push(...confirmed.map(item => ({ id: item.id, projectId: id, status: 'committed', phase: 'complete' })));
              return confirmed;
            } catch (error) {
              uploaded.push(...(error.results || [])); outcomes.push(...(error.outcomes || [])); throw error;
            }
          };
          // Local admission may block an unsafe OLD queue without rewriting it.
          // Never let a network retry prevent this tick's idle checkpoint capture.
          await preflight(); await store.validatePending(client, id, flushOptions);
          const exported = await exportSessions(ctx, mapping.root);
          client.signal.throwIfAborted();
          if (exported.skipped.some(item => /active|busy|running|pending|incomplete/i.test(item.reason))) {
            progress.deferred = true;
            return { projectId: id, deferred: true, skippedSessions: exported.skipped, retried: await flush() };
          }
          const capture = async () => store.capture({ root: mapping.root, projectId: id, deviceId: credentials.deviceId, signal: client.signal, sessions: exported.sessions, assets: exported.assets, excludedPaths: await captureExclusions(mapping), beforeQueue: async () => {
            await preflight(); await exported.verifyUnchanged?.();
          } });
          let captured;
          try { captured = await capture(); }
          catch (error) {
            if (error.code !== 'QUEUE_FULL') throw error;
            // At the bounded spool limit only, free durable queue capacity first.
            // An offline failure keeps all 100 immutable checkpoints intact.
            await flush(); captured = await capture();
          }
          Object.assign(progress, { checkpointId: captured.queuedId, unchanged: captured.unchanged });
          await flush();
          return { ...progress, uploaded, skippedFiles: captured.skipped, skippedSessions: exported.skipped };
        });
        lastResult = { at: new Date().toISOString(), results: [result] }; return result;
      } catch (error) {
        const report = { ...progress, uploaded: structuredClone(uploaded), outcomes: structuredClone(outcomes), error: '同步未完成', errorCode: error.code };
        error.results = structuredClone(uploaded); error.outcomes = structuredClone(outcomes); error.syncResult = report;
        lastResult = { at: new Date().toISOString(), error: report.error, errorCode: report.errorCode, results: [report] }; throw error;
      } finally { activeAbort = undefined; }
    })();
    active = operation;
    try { return await operation; } finally { if (active === operation) active = null; }
  }
  // Completed results survive a legitimate rotation, not an explicit new login.
  const sameAccount = (a, b) => Boolean(a && b && ['server', 'username', 'deviceId', 'authorizationEpoch'].every(key => a[key] === b[key]) &&
    (a.familyId && b.familyId ? a.familyId === b.familyId && a.serverId === b.serverId : !a.familyId && !b.familyId && a.token === b.token));
  // Active operations must never adopt a new bearer midway through their effects.
  const sameGrant = (a, b) => sameAccount(a, b) && ['token', 'expiresAt', 'refreshToken', 'refreshExpiresAt', 'absoluteExpiresAt'].every(key => a[key] === b[key]);

  // Host-only pause hook. Safe inside operation.lock; deliberately no mutate()
  // or store.exclusive() nesting. A stale actor must not pause a replacement grant.
  async function requireSyncReauthentication({ expectedIdentity } = {}) {
    let result;
    // Native exclusion also prevents a cross-process replacement between checking
    // an actor's proof and publishing its local pause. No credential is rewritten.
    await ctx.credentials.modifyRecord(credentialKey, async native => {
      let identity;
      try { identity = await checkedAccount(native, await store.config()); }
      catch (error) {
        if (error.code === 'NOT_LOGGED_IN' && (await requiresReauthentication() || (await store.config())?.reauthRequired === true)) { result = { reauthRequired: true }; return undefined; }
        throw error;
      }
      if (expectedIdentity && !sameGrant(expectedIdentity, identity)) { result = { reauthRequired: false }; return undefined; }
      await writeReauthMarker(identity, 'AUTH_REVOKED');
      await pauseAuthorization(identity);
      result = { reauthRequired: true };
      return undefined;
    });
    return result;
  }
  async function syncAccount() {
    await ready(); updateAdmission();
    const epoch = generation, identity = await account();
    lifetime.signal.throwIfAborted(); updateAdmission();
    if (epoch !== generation) throw failure('ACCOUNT_MISMATCH', '账号已变更');
    return identity;
  }
  async function runSyncOperation(action, { checkBinding = async () => {}, signal } = {}) {
    await ready(); updateAdmission();
    if (typeof action !== 'function' || typeof checkBinding !== 'function') throw failure('BAD_REQUEST', '无效同步操作');
    if (mutating || active || batchRunning || scheduled.size || recoveryTask || downloadTask) throw failure('BUSY', '同步或设置操作正在进行');
    const epoch = generation, abort = new AbortController();
    const requestSignal = AbortSignal.any([lifetime.signal, abort.signal, ...(signal ? [signal] : [])]);
    const guard = () => {
      requestSignal.throwIfAborted(); updateAdmission();
      if (generation !== epoch || mutating) throw failure('CONFIG_CONFLICT', '同步设置已变更');
    };
    activeAbort = abort;
    const operation = Promise.resolve().then(async () => {
      try {
        return await store.exclusive(async () => {
          guard();
          const identity = await account(); guard();
          const check = async () => {
            guard(); await checkBinding(); guard();
            const current = await account(); guard();
            if (!sameGrant(identity, current)) throw failure('ACCOUNT_MISMATCH', '登录身份在同步期间变更，已停止同步');
            if (Date.parse(current.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '登录已过期，请重新登录');
          };
          await check();
          // The bidirectional service supplies root/consent/policy checks. This
          // Host-only boundary does NOT authorize roots from legacy projects.
          const value = await action(Object.freeze({ identity, signal: requestSignal, check }));
          await check(); return value;
        });
      } catch (error) {
        if (error?.status === 401 || error?.httpStatus === 401) throw Object.assign(failure('NOT_LOGGED_IN', '登录已失效，请重新登录'), { status: 401, httpStatus: 401 });
        throw error;
      } finally { if (activeAbort === abort) activeAbort = undefined; }
    });
    active = operation;
    try { return await operation; } finally { if (active === operation) active = null; }
  }
  const publicRecovery = job => structuredClone(job.value);
  // One trusted read boundary for cloud browsing and Host chooser calls. Never nest mutate.
  function readAccount(action, { checkBinding, signal } = {}) {
    return mutate(async () => {
      const requestSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      requestSignal.throwIfAborted(); await checkBinding();
      const identity = await account();
      const check = async () => {
        requestSignal.throwIfAborted(); await checkBinding();
        if (!sameGrant(identity, await account())) throw failure('ACCOUNT_MISMATCH', '账号已变更');
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
    try { result = await client.projects(); partial ||= result.partial === true; }
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
    if (kind === 'import' && error?.code === 'CHECKPOINT_MISMATCH') return 'IMPORT_FAILED';
    if (safe.has(error?.code)) return error.code;
    if (error?.status === 401) return 'NOT_LOGGED_IN';
    if (error?.code === 'EEXIST' && kind === 'restore') return 'DESTINATION_EXISTS';
    return kind === 'restore' ? 'RESTORE_FAILED' : 'IMPORT_FAILED';
  }
  function publicDownload(job) {
    const { id, state, completed, total } = job.value;
    return { id, state, completed, total, ...(job.value.latest ? { latest: true } : {}), ...(job.value.warningCode ? { warningCode: job.value.warningCode } : {}), items: job.value.items.map(item => ({
      projectId: item.projectId, checkpointId: item.checkpointId, restoreId: item.restoreId, root: item.root, label: item.label, state: item.state, canImport: item.canImport,
      ...(item.sessionCount !== undefined ? { sessionCount: item.sessionCount } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}),
      ...(item.importResult ? { importResult: structuredClone(item.importResult) } : {}),
    })) };
  }
  function recoveryIdentity(identity) {
    return { server: identity.server, username: identity.username, deviceId: identity.deviceId, authorizationEpoch: identity.authorizationEpoch,
      ...(identity.familyId ? { familyId: identity.familyId, serverId: identity.serverId } : { tokenDigest: sha256(identity.token) }) };
  }
  const sameRecoveryAccount = (saved, current) => Boolean(saved && current && JSON.stringify(saved) === JSON.stringify(recoveryIdentity(current)));
  const historyFailure = () => failure('RECOVERY_STATE_CORRUPT', '恢复记录无法安全读取，请检查本机状态');
  const recordObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const historyText = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const historyRoot = value => historyText(value) && path.isAbsolute(value) && path.resolve(value) === value;
  const historyInteger = value => Number.isSafeInteger(value) && value >= 0;
  const historyHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const historyCodes = new Set(['NOT_LOGGED_IN', 'ACCOUNT_MISMATCH', 'CONFIG_CONFLICT', 'BAD_DESTINATION', 'DESTINATION_EXISTS', 'DESTINATION_CHANGED', 'DIRECTORY_PICKER_EXPIRED', 'PROTECTED_DESTINATION', 'CHECKPOINT_MISMATCH', 'RECOVERY_UNAVAILABLE', 'BUSY', 'DISPOSED', 'RESTORE_FAILED', 'IMPORT_FAILED', 'DOWNLOAD_CANCELLED', 'DOWNLOAD_FINALIZATION_FAILED', 'RECOVERY_UNCERTAIN', 'PROJECT_REGISTRATION_UNCERTAIN']);
  function historyAssert(condition) { if (!condition) throw historyFailure(); }
  function historyExact(value, required, optional = []) {
    historyAssert(recordObject(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  }
  function historyId(value) { try { return validateId(value); } catch { throw historyFailure(); } }
  function validateRecoveryIdentity(value) {
    const renewable = recordObject(value) && Object.hasOwn(value, 'familyId');
    historyExact(value, ['server', 'username', 'deviceId', 'authorizationEpoch', ...(renewable ? ['familyId', 'serverId'] : ['tokenDigest'])]);
    historyAssert(historyText(value.username, 128) && historyInteger(value.authorizationEpoch));
    try { historyAssert(validateServerUrl(value.server) === value.server); } catch { throw historyFailure(); }
    historyId(value.deviceId);
    if (renewable) { historyAssert(typeof value.familyId === 'string' && TOKEN.test(value.familyId)); historyId(value.serverId); }
    else historyAssert(historyHash(value.tokenDigest));
    return { server: value.server, username: value.username, deviceId: value.deviceId, authorizationEpoch: value.authorizationEpoch,
      ...(renewable ? { familyId: value.familyId, serverId: value.serverId } : { tokenDigest: value.tokenDigest }) };
  }
  function validateRootIdentity(value) {
    historyExact(value, ['dev', 'ino', 'birthtimeNs']);
    historyAssert(Object.values(value).every(item => typeof item === 'string' && /^\d{1,40}$/.test(item)));
    return { ...value };
  }
  function validateRecoveryValue(value) {
    historyExact(value, ['id', 'kind', 'state', 'root', 'checkpointId'], ['sessionCount', 'importedCount', 'skippedCount', 'failedCount', 'sessions', 'errorCode', 'interrupted']);
    historyId(value.id); historyId(value.checkpointId);
    historyAssert(['restore', 'import'].includes(value.kind) && ['running', 'succeeded', 'failed'].includes(value.state) && historyRoot(value.root));
    for (const key of ['sessionCount', 'importedCount', 'skippedCount', 'failedCount']) if (value[key] !== undefined) historyAssert(historyInteger(value[key]) && value[key] <= MAX_FILES * 2);
    if (value.errorCode !== undefined) historyAssert(historyCodes.has(value.errorCode));
    if (value.interrupted !== undefined) historyAssert(value.interrupted === true);
    if (value.sessions !== undefined) {
      historyAssert(Array.isArray(value.sessions) && value.sessions.length <= MAX_FILES * 2);
      for (const item of value.sessions) {
        historyExact(item, ['sourceId', 'outcome'], ['sessionId', 'workspaceAttached']); historyId(item.sourceId);
        if (item.sessionId !== undefined) historyId(item.sessionId);
        historyAssert(['imported', 'skipped', 'failed'].includes(item.outcome) && (item.workspaceAttached === undefined || typeof item.workspaceAttached === 'boolean'));
        if (item.outcome === 'imported') historyAssert(item.sessionId !== undefined && typeof item.workspaceAttached === 'boolean');
      }
    }
    return structuredClone(value);
  }
  function validateDownloadValue(value) {
    historyExact(value, ['id', 'state', 'completed', 'total', 'items'], ['latest', 'warningCode']); historyId(value.id);
    historyAssert(['running', 'succeeded', 'partial', 'failed'].includes(value.state) && historyInteger(value.total) && value.total > 0 && value.total <= 20 && Array.isArray(value.items) && value.items.length === value.total);
    historyAssert(value.latest === undefined || value.latest === true);
    historyAssert(value.warningCode === undefined || value.warningCode === 'DOWNLOAD_FINALIZATION_FAILED');
    const ids = new Set(), roots = new Set(), projects = new Set();
    for (const item of value.items) {
      historyExact(item, ['projectId', 'checkpointId', 'restoreId', 'root', 'label', 'state', 'canImport'], ['sessionCount', 'errorCode', 'importResult']);
      for (const key of ['projectId', 'checkpointId', 'restoreId']) historyId(item[key]);
      historyAssert(historyRoot(item.root) && historyText(item.label, 1024) && !ids.has(item.restoreId) && !roots.has(pathKey(item.root)) && !projects.has(item.projectId));
      ids.add(item.restoreId); roots.add(pathKey(item.root)); projects.add(item.projectId);
      historyAssert(['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(item.state) && typeof item.canImport === 'boolean');
      historyAssert(item.sessionCount === undefined || historyInteger(item.sessionCount) && item.sessionCount <= MAX_FILES);
      historyAssert(!item.canImport || item.state === 'succeeded' && item.sessionCount > 0);
      if (item.errorCode !== undefined) historyAssert(historyCodes.has(item.errorCode));
      if (item.importResult !== undefined) { validateRecoveryValue(item.importResult); historyAssert(item.importResult.kind === 'import' && item.importResult.root === item.root && !item.canImport); }
    }
    const completed = value.items.filter(item => ['succeeded', 'failed', 'cancelled'].includes(item.state)).length;
    const successes = value.items.filter(item => item.state === 'succeeded').length;
    historyAssert(value.completed === completed && (value.state === 'running' || completed === value.total));
    historyAssert(value.state !== 'succeeded' || successes === value.total);
    historyAssert(value.state !== 'partial' || successes > 0 && successes < value.total);
    historyAssert(value.state !== 'failed' || successes === 0);
    return structuredClone(value);
  }
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  function snapshotRecovery() {
    return { version: 1, profile: sha256(credentialKey), latestRecoveryId: latestRecovery?.value.id ?? null, latestDownloadId: latestDownload?.value.id ?? null, latestRestoreId: latestRestore?.value.id ?? null,
      records: [...recoveryIds.values()].map(job => ({ identity: job.identity, fingerprint: job.fingerprint, value: job.value, ...(job.restoreId ? { restoreId: job.restoreId } : {}), ...(job.allocations ? { allocations: job.allocations } : {}) })),
      restores: [...(latestRestore ? [latestRestore] : []), ...batchRestores.values()].map(restored => ({ identity: restored.identity, projectId: restored.projectId, digest: restored.digest, rootIdentity: restored.rootIdentity, consumed: restored.consumed === true, value: { id: restored.value.id, root: restored.value.root, checkpointId: restored.value.checkpointId, sessionCount: restored.value.sessionCount }, ...(restored.batchId ? { batchId: restored.batchId } : {}) })),
      registrations: [...registrations.values()] };
  }
  function decodeRecovery(input) {
    historyExact(input, ['version', 'profile', 'latestRecoveryId', 'latestDownloadId', 'latestRestoreId', 'records', 'restores', 'registrations']);
    historyAssert(input.version === 1 && input.profile === sha256(credentialKey) && Array.isArray(input.records) && Array.isArray(input.restores) && Array.isArray(input.registrations) && input.records.length + input.registrations.length <= maxRecoveryRequests && input.restores.length <= 21);
    const records = new Map(), restores = new Map(), registered = new Map();
    for (const entry of input.records) {
      historyExact(entry, ['identity', 'fingerprint', 'value'], ['allocations', 'restoreId']); historyAssert(historyHash(entry.fingerprint));
      const value = entry.value?.kind ? validateRecoveryValue(entry.value) : validateDownloadValue(entry.value);
      historyAssert(!records.has(value.id));
      const job = { identity: validateRecoveryIdentity(entry.identity), fingerprint: entry.fingerprint, value };
      if (value.kind === 'import') job.restoreId = historyId(entry.restoreId);
      else historyAssert(entry.restoreId === undefined);
      if (entry.allocations !== undefined) {
        historyAssert(value.kind === 'import' && Array.isArray(entry.allocations) && entry.allocations.length <= MAX_FILES);
        const sources = new Set(), targets = new Set();
        job.allocations = entry.allocations.map(item => { historyExact(item, ['sourceId', 'sessionId']); historyId(item.sourceId); historyId(item.sessionId); historyAssert(!sources.has(item.sourceId) && !targets.has(item.sessionId) && item.sourceId !== item.sessionId); sources.add(item.sourceId); targets.add(item.sessionId); return { ...item }; });
      }
      records.set(value.id, job);
    }
    for (const entry of input.restores) {
      historyExact(entry, ['identity', 'projectId', 'digest', 'rootIdentity', 'consumed', 'value'], ['batchId']); historyId(entry.projectId);
      historyAssert(historyHash(entry.digest) && typeof entry.consumed === 'boolean');
      historyExact(entry.value, ['id', 'root', 'checkpointId', 'sessionCount']); historyId(entry.value.id); historyId(entry.value.checkpointId);
      historyAssert(historyRoot(entry.value.root) && historyInteger(entry.value.sessionCount) && entry.value.sessionCount <= MAX_FILES && !restores.has(entry.value.id));
      const identity = validateRecoveryIdentity(entry.identity), rootIdentity = validateRootIdentity(entry.rootIdentity);
      const owner = entry.batchId === undefined ? records.get(entry.value.id) : records.get(historyId(entry.batchId));
      const completed = entry.batchId === undefined ? owner?.value : owner?.value.items?.find(item => item.restoreId === entry.value.id);
      historyAssert(completed?.state === 'succeeded' && completed.root === entry.value.root && completed.checkpointId === entry.value.checkpointId && completed.sessionCount === entry.value.sessionCount && JSON.stringify(owner.identity) === JSON.stringify(identity));
      const imports = [...records.values()].filter(job => job.restoreId === entry.value.id && JSON.stringify(job.identity) === JSON.stringify(identity));
      historyAssert(imports.length === (entry.consumed ? 1 : 0));
      if (entry.batchId) {
        historyAssert(completed.canImport === (!entry.consumed && entry.value.sessionCount > 0));
        historyAssert(!entry.consumed || completed.importResult?.id === imports[0].value.id);
      }
      restores.set(entry.value.id, { identity, projectId: entry.projectId, digest: entry.digest, rootIdentity, consumed: entry.consumed, value: { ...entry.value }, ...(entry.batchId ? { batchId: entry.batchId, batchItem: completed } : {}) });
    }
    for (const item of input.registrations) {
      historyExact(item, ['requestId', 'restoreId', 'identity', 'root', 'state', 'rootIdentity', 'manifestDigest', 'projectId', 'checkpointId', 'sessionCount'], ['workspaceId']); historyId(item.requestId); historyId(item.restoreId); historyId(item.projectId); historyId(item.checkpointId);
      validateRootIdentity(item.rootIdentity); historyAssert(historyHash(item.manifestDigest) && historyInteger(item.sessionCount) && item.sessionCount <= MAX_FILES);
      historyAssert(!records.has(item.requestId) && !registered.has(item.requestId) && historyRoot(item.root) && ['pending', 'succeeded', 'unknown'].includes(item.state));
      if (item.workspaceId !== undefined) historyAssert(historyText(item.workspaceId, 256));
      historyAssert(item.state !== 'succeeded' || item.workspaceId !== undefined);
      registered.set(item.requestId, { ...item, identity: validateRecoveryIdentity(item.identity) });
    }
    for (const key of ['latestRecoveryId', 'latestDownloadId', 'latestRestoreId']) historyAssert(input[key] === null || typeof input[key] === 'string');
    historyAssert(input.latestRecoveryId === null || records.get(input.latestRecoveryId)?.value.kind);
    historyAssert(input.latestDownloadId === null || records.get(input.latestDownloadId)?.value.items);
    historyAssert(input.latestRestoreId === null || restores.has(input.latestRestoreId) && !restores.get(input.latestRestoreId).batchId);
    historyAssert([...restores.values()].every(item => item.batchId ? item.batchId === input.latestDownloadId : item.value.id === input.latestRestoreId));
    return { records, restores, registered, latestRecoveryId: input.latestRecoveryId, latestDownloadId: input.latestDownloadId, latestRestoreId: input.latestRestoreId };
  }
  function installRecovery(decoded, interrupted = false) {
    if (interrupted) for (const job of decoded.records.values()) {
      if (job.value.state !== 'running') continue;
      if (job.value.kind) {
        job.value.state = 'failed'; job.value.interrupted = true;
        job.value.errorCode = job.value.kind === 'import' ? 'RECOVERY_UNCERTAIN' : 'RESTORE_FAILED';
        if (job.value.kind === 'import') {
          job.value.sessions ??= [];
          for (const item of job.allocations ?? []) if (!job.value.sessions.some(row => row.sourceId === item.sourceId)) job.value.sessions.push({ ...item, outcome: 'failed' });
          countImportResults(job.value);
        }
      } else {
        for (const item of job.value.items) if (item.state === 'pending' || item.state === 'running') { item.state = 'cancelled'; item.errorCode = 'DOWNLOAD_CANCELLED'; item.canImport = false; }
        finishDownload(job);
      }
    }
    if (interrupted) for (const item of decoded.registered.values()) if (item.state === 'pending') item.state = 'unknown';
    recoveryIds.clear(); for (const [id, job] of decoded.records) recoveryIds.set(id, job);
    registrations.clear(); for (const [id, value] of decoded.registered) registrations.set(id, value);
    batchRestores.clear();
    for (const [id, item] of decoded.restores) if (item.batchId) {
      // Import progress in the standalone record is authoritative after a crash.
      const imported = [...recoveryIds.values()].find(job => job.value.kind === 'import' && job.value.root === item.value.root && item.batchItem.importResult?.id === job.value.id);
      if (imported) item.batchItem.importResult = imported.value;
      item.batchItem.canImport = !item.consumed && item.value.sessionCount > 0;
      batchRestores.set(id, item);
    }
    latestRecovery = recoveryIds.get(decoded.latestRecoveryId); latestDownload = recoveryIds.get(decoded.latestDownloadId); latestRestore = decoded.restores.get(decoded.latestRestoreId);
    recoveryLoaded = true;
  }
  async function loadRecoveryHistory(force = false) {
    if (recoveryLoaded && !force) return;
    if (recoveryLoading) return recoveryLoading;
    recoveryLoading = (async () => {
      let raw;
      try { await fs.lstat(recoveryFile); }
      catch (error) { if (error.code === 'ENOENT') { recoveryLoaded = true; return; } throw historyFailure(); }
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readStableFile(await assertNoSymlinks(recoveryFile), MAX_RECOVERY_BYTES)).bytes)); installRecovery(decodeRecovery(raw), true); }
      catch { throw historyFailure(); }
    })();
    try { await recoveryLoading; } finally { recoveryLoading = undefined; }
  }
  async function persistRecovery() {
    const snapshot = snapshotRecovery(); decodeRecovery(snapshot);
    const bytes = JSON.stringify(snapshot);
    if (Buffer.byteLength(bytes) > MAX_RECOVERY_BYTES) throw failure('RECOVERY_LIMIT', '恢复记录达到大小限制');
    await atomicWrite(recoveryFile, bytes);
  }
  async function rootIdentity(root) {
    await assertNoSymlinks(root);
    const info = await fs.lstat(root, { bigint: true });
    if (!info.isDirectory()) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
    return { dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
  }
  async function verifyRestored(restored, check = async () => {}, verifyFiles = false) {
    await check();
    if (JSON.stringify(await rootIdentity(restored.value.root)) !== JSON.stringify(restored.rootIdentity)) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
    try { await fs.lstat(path.join(restored.value.root, '.dsh-sync', 'INCOMPLETE')); throw failure('CHECKPOINT_MISMATCH', '恢复目录尚未完成'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const filename = await assertNoSymlinks(path.join(restored.value.root, '.dsh-sync', 'manifest.json'));
    const manifest = validateManifest(JSON.parse((await readStableFile(filename, MAX_MANIFEST_BYTES * 2)).bytes.toString('utf8')));
    if (manifest.id !== restored.value.checkpointId || manifest.projectId !== restored.projectId || sha256(JSON.stringify(manifest)) !== restored.digest) throw failure('CHECKPOINT_MISMATCH', '恢复清单已变更');
    // Native import verifies every archive/resource it consumes itself. Project
    // registration additionally verifies every restored file before exposing a root.
    for (const item of verifyFiles ? manifest.files : []) {
      await check();
      const relative = item.path.startsWith('project/') ? item.path.slice(8) : `.dsh-sync/${item.path}`;
      const { bytes } = await readStableFile(await assertNoSymlinks(path.join(restored.value.root, ...relative.split('/'))), item.size);
      if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw failure('CHECKPOINT_MISMATCH', '恢复内容已变更');
    }
    if (JSON.stringify(await rootIdentity(restored.value.root)) !== JSON.stringify(restored.rootIdentity)) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
    await check(); return manifest;
  }
  function finishDownload(job) {
    job.value.completed = job.value.items.filter(item => ['succeeded', 'failed', 'cancelled'].includes(item.state)).length;
    const successes = job.value.items.filter(item => item.state === 'succeeded').length;
    job.value.state = job.value.completed === job.value.total ? successes === job.value.total ? 'succeeded' : successes > 0 ? 'partial' : 'failed' : 'running';
  }
  function countImportResults(value) {
    for (const [field, outcome] of [['importedCount', 'imported'], ['skippedCount', 'skipped'], ['failedCount', 'failed']]) value[field] = (value.sessions ?? []).filter(item => item.outcome === outcome).length;
  }
  async function startDownload(input, { checkBinding, admitDestination, signal, resolveDestinations } = {}) {
    await ready(); await loadRecoveryHistory(); updateAdmission(); await checkBinding(); signal?.throwIfAborted();
    const credentials = await account();
    await checkBinding(); signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    if (Date.parse(credentials.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '请重新登录');
    const fingerprint = sha256(JSON.stringify({ kind: 'download', ...input })), prior = recoveryIds.get(input.requestId);
    if (prior) {
      if (!sameRecoveryAccount(prior.identity, credentials)) throw failure('RECOVERY_UNAVAILABLE', '下载请求不可用');
      if (prior.fingerprint !== fingerprint) throw failure('BAD_REQUEST', '请求 ID 已使用');
      return { download: publicDownload(prior) };
    }
    updateAdmission();
    if (mutating || active || batchRunning || scheduled.size || recoveryTask || downloadTask) throw failure('BUSY', '另一项操作尚未完成');
    if (recoveryIds.size + registrations.size >= maxRecoveryRequests) throw failure('RECOVERY_LIMIT', '恢复请求已达上限');
    // Synchronous opaque-plan resolution and a task reservation precede any await.
    // The shared filesystem lock then validates ALL roots before acknowledging ANY.
    const destinations = resolveDestinations(credentials);
    assert(destinations.length === input.items.length && destinations.length > 0 && destinations.length <= 20, 'Invalid download selection');
    const abort = new AbortController(), epoch = generation;
    downloadAbort = abort;
    const taskSignal = AbortSignal.any([lifetime.signal, abort.signal]);
    const admissionSignal = signal ? AbortSignal.any([taskSignal, signal]) : taskSignal;
    let accept, refuse, accepted = false, job;
    const admission = new Promise((resolve, reject) => { accept = resolve; refuse = reject; });
    const check = async () => {
      const guardSignal = accepted ? taskSignal : admissionSignal;
      guardSignal.throwIfAborted(); await checkBinding();
      if (!sameGrant(credentials, await account())) throw failure('ACCOUNT_MISMATCH', '账号已变更');
      if (Date.parse(credentials.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '请重新登录');
      if (epoch !== generation) throw failure('CONFIG_CONFLICT', '设置已变更');
      guardSignal.throwIfAborted();
    };
    const stopCode = error => {
      if (taskSignal.aborted || stopped || error?.name === 'AbortError') return 'DOWNLOAD_CANCELLED';
      if (error?.status === 401 || error?.httpStatus === 401) return 'NOT_LOGGED_IN';
      if (error?.status === 403 || error?.httpStatus === 403) return 'ACCOUNT_MISMATCH';
      return ['NOT_LOGGED_IN', 'ACCOUNT_MISMATCH', 'CONFIG_CONFLICT', 'SETTINGS_CORRUPT', 'DISPOSED'].includes(error?.code) ? error.code : undefined;
    };
    function cancelRemaining(code) {
      for (const item of job.value.items) if (item.state === 'pending' || item.state === 'running') { item.state = 'cancelled'; item.errorCode = code; job.value.completed++; }
    }
    const operation = Promise.resolve().then(async () => {
      try {
        await store.exclusive(async () => {
          await loadRecoveryHistory(true);
          await check(); signal?.throwIfAborted();
          const previous = recoveryIds.get(input.requestId);
          if (previous) {
            if (!sameRecoveryAccount(previous.identity, credentials) || previous.fingerprint !== fingerprint) throw failure('RECOVERY_UNAVAILABLE', '下载请求不可用');
            job = previous; accepted = true; accept({ download: publicDownload(job) }); return;
          }
          if (registrations.has(input.requestId) || recoveryIds.size + registrations.size >= maxRecoveryRequests) throw failure('RECOVERY_LIMIT', '恢复请求已达上限');
          if (input.latest === true) {
            // Plans authorize project + exact root, not a historical point. Resolve
            // again at click admission under the shared job/account/operation lock.
            const client = new SyncClient({ ...credentials, signal: admissionSignal });
            for (const destination of destinations) {
              await check();
              const manifest = await client.latestCheckpoint(destination.projectId);
              await check();
              destination.checkpointId = manifest.id; // Retain IDs only, not twenty manifests.
            }
          }
          // Recheck every parent/root after potentially slow latest reads, before ACK.
          for (const destination of destinations) { await destination.check(); await admitDestination(destination.root); await check(); signal?.throwIfAborted(); }
          await check(); signal?.throwIfAborted();
          // A slow local admission is still a NEW request: expiry/provider checks
          // apply until this synchronous acceptance point, never afterwards.
          resolveDestinations(credentials);
          job = { identity: recoveryIdentity(credentials), fingerprint, value: { id: input.requestId, ...(input.latest === true ? { latest: true } : {}), state: 'running', completed: 0, total: destinations.length, items: destinations.map(item => ({ projectId: item.projectId, checkpointId: item.checkpointId, restoreId: randomUUID(), root: item.root, label: item.label, state: 'pending', canImport: false })) } };
          clearBatchRestores(); recoveryIds.set(input.requestId, job); latestDownload = job;
          await persistRecovery(); await check(); admissionSignal.throwIfAborted();
          resolveDestinations(credentials); // Revalidate TTL/provider after the durable admission write.
          admissionSignal.throwIfAborted();
          accepted = true; accept({ download: publicDownload(job) });
          // Page AbortSignal deliberately stops applying at this commit point.
          const client = new SyncClient({ ...credentials, signal: taskSignal });
          for (const [index, destination] of destinations.entries()) {
            const item = job.value.items[index];
            try {
              await check(); item.state = 'running'; await persistRecovery();
              await destination.check(); await admitDestination(item.root);
              let reserved = false;
              const result = await store.restore(client, item.checkpointId, item.root, {
                projectId: item.projectId, signal: taskSignal,
                beforeWrite: async () => { await check(); await destination.check({ reserved }); await admitDestination(item.root, { reserved }); reserved = true; taskSignal.throwIfAborted(); },
              });
              const manifest = validateManifest(result.manifest), digest = sha256(JSON.stringify(manifest));
              item.sessionCount = manifest.sessionIds.length; item.state = 'succeeded'; item.canImport = item.sessionCount > 0;
              batchRestores.set(item.restoreId, { identity: recoveryIdentity(credentials), projectId: item.projectId, digest, rootIdentity: await rootIdentity(item.root), consumed: false, batchId: job.value.id, value: { id: item.restoreId, root: item.root, checkpointId: item.checkpointId, sessionCount: item.sessionCount }, batchItem: item });
              job.value.completed++; await persistRecovery();
            } catch (error) {
              if (batchRestores.has(item.restoreId)) {
                // Verified files are real even if persisting their outcome failed.
                job.value.warningCode = 'DOWNLOAD_FINALIZATION_FAILED'; cancelRemaining('DOWNLOAD_CANCELLED'); break;
              }
              if (item.state === 'succeeded') item.state = 'running';
              // Integrity/path failures are local to one destination. Permission,
              // revision and cancellation failures stop every remaining selection.
              let cancellation = stopCode(error);
              if (!cancellation) { try { await check(); } catch (guardError) { cancellation = stopCode(guardError) || 'DOWNLOAD_CANCELLED'; } }
              if (cancellation) { cancelRemaining(cancellation); break; }
              item.state = 'failed'; item.errorCode = recoveryError(error, 'restore'); job.value.completed++; await persistRecovery();
            }
          }
          finishDownload(job); await persistRecovery();
        });
      } catch (error) {
        if (!accepted) {
          if (job) { cancelRemaining(stopCode(error) || 'DOWNLOAD_CANCELLED'); finishDownload(job); }
          refuse(error);
        } else {
          // A lock-release/finalization failure cannot erase verified file outcomes,
          // nor claim clean completion. Report only a constant, never the raw error.
          job.value.warningCode = 'DOWNLOAD_FINALIZATION_FAILED';
          cancelRemaining(stopCode(error) || 'DOWNLOAD_CANCELLED');
        }
      } finally {
        if (accepted) {
          const successes = job.value.items.filter(item => item.state === 'succeeded').length;
          job.value.state = successes === job.value.total ? 'succeeded' : successes > 0 ? 'partial' : 'failed';
        }
      }
    }).finally(() => { if (downloadTask === operation) { downloadTask = null; downloadAbort = undefined; } });
    downloadTask = operation;
    return admission;
  }
  async function startRecovery(kind, input, { checkBinding, admitDestination, signal, resolveDestination } = {}) {
    await ready(); await loadRecoveryHistory(); updateAdmission(); await checkBinding(); signal?.throwIfAborted();
    const credentials = await account();
    await checkBinding(); signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    if (Date.parse(credentials.expiresAt) <= Date.now()) throw failure('NOT_LOGGED_IN', '请重新登录');
    const fingerprint = sha256(JSON.stringify({ kind, ...input })), prior = recoveryIds.get(input.requestId);
    if (prior) {
      if (!sameRecoveryAccount(prior.identity, credentials)) throw failure('RECOVERY_UNAVAILABLE', '恢复请求不可用');
      if (prior.fingerprint !== fingerprint) throw failure('BAD_REQUEST', '请求 ID 已使用');
      return { recovery: publicRecovery(prior) };
    }
    updateAdmission();
    if (mutating || active || batchRunning || scheduled.size || recoveryTask || downloadTask) throw failure('BUSY', '另一项操作尚未完成');
    if (recoveryIds.size + registrations.size >= maxRecoveryRequests) throw failure('RECOVERY_LIMIT', '恢复请求已达上限');
    let restored = batchRestores.get(input.restoreId) ?? latestRestore;
    const eligible = () => restored && restored.value.id === input.restoreId && !restored.consumed && restored.value.sessionCount > 0 && sameRecoveryAccount(restored.identity, credentials);
    if (kind === 'import' && !eligible()) throw failure('RECOVERY_UNAVAILABLE', '没有可导入的本次恢复');
    const destinationPlan = kind === 'restore' ? resolveDestination?.(credentials) : undefined;
    const destination = destinationPlan?.root ?? input.destination;
    const abort = new AbortController(); recoveryAbort = abort;
    const taskSignal = AbortSignal.any([lifetime.signal, abort.signal]);
    const admissionSignal = signal ? AbortSignal.any([taskSignal, signal]) : taskSignal;
    let accept, refuse, accepted = false, job;
    const admission = new Promise((resolve, reject) => { accept = resolve; refuse = reject; });
    const operation = Promise.resolve().then(async () => {
      try {
        await store.exclusive(async () => {
          await loadRecoveryHistory(true);
          const check = async () => {
            const guard = accepted ? taskSignal : admissionSignal;
            guard.throwIfAborted(); await checkBinding();
            if (!sameGrant(credentials, await account())) throw failure('ACCOUNT_MISMATCH', '账号已变更');
            guard.throwIfAborted();
          };
          await check();
          const previous = recoveryIds.get(input.requestId);
          if (previous) {
            if (!sameRecoveryAccount(previous.identity, credentials) || previous.fingerprint !== fingerprint) throw failure('RECOVERY_UNAVAILABLE', '恢复请求不可用');
            job = previous; accepted = true; accept({ recovery: publicRecovery(job) }); return;
          }
          if (registrations.has(input.requestId) || recoveryIds.size + registrations.size >= maxRecoveryRequests) throw failure('RECOVERY_LIMIT', '恢复请求已达上限');
          restored = batchRestores.get(input.restoreId) ?? latestRestore;
          if (kind === 'import' && !eligible()) throw failure('RECOVERY_UNAVAILABLE', '没有可导入的本次恢复');
          job = { identity: recoveryIdentity(credentials), fingerprint, value: { id: input.requestId, kind, state: 'running', root: kind === 'restore' ? destination : restored.value.root, checkpointId: kind === 'restore' ? input.checkpointId : restored.value.checkpointId, ...(kind === 'import' ? { sessionCount: restored.value.sessionCount } : {}) } };
          recoveryIds.set(input.requestId, job); latestRecovery = job;
          if (kind === 'import') {
            restored.consumed = true; job.restoreId = input.restoreId; job.allocations = [];
            if (restored.batchItem) { restored.batchItem.canImport = false; restored.batchItem.importResult = job.value; }
          }
          // The consumed intent and request id must survive a crash BEFORE ACK or
          // any native write. Restart reports unknown; it never replays this call.
          await persistRecovery(); await check(); admissionSignal.throwIfAborted();
          if (kind === 'restore' && resolveDestination && resolveDestination(credentials).root !== destination) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
          admissionSignal.throwIfAborted();
          accepted = true; accept({ recovery: publicRecovery(job) });
          try {
            if (kind === 'restore') {
              await destinationPlan?.check(); await admitDestination(destination); await check();
              let reserved = false;
              const result = await store.restore(new SyncClient({ ...credentials, signal: taskSignal }), input.checkpointId, destination, {
                projectId: input.projectId, signal: taskSignal,
                beforeWrite: async () => { await check(); await destinationPlan?.check({ reserved }); await admitDestination(destination, { reserved }); reserved = true; taskSignal.throwIfAborted(); },
              });
              const manifest = validateManifest(result.manifest), stamp = await rootIdentity(result.root);
              job.value.sessionCount = manifest.sessionIds.length; job.value.state = 'succeeded';
              latestRestore = { identity: recoveryIdentity(credentials), projectId: input.projectId, digest: sha256(JSON.stringify(manifest)), rootIdentity: stamp, consumed: false, value: { id: job.value.id, root: result.root, checkpointId: input.checkpointId, sessionCount: manifest.sessionIds.length } };
            } else {
              const importCheck = async () => {
                await check();
                if (JSON.stringify(await rootIdentity(restored.value.root)) !== JSON.stringify(restored.rootIdentity)) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
                taskSignal.throwIfAborted();
              };
              const manifest = await verifyRestored(restored, importCheck);
              const result = await importSessions(ctx, { manifest, root: restored.value.root, signal: taskSignal, check: importCheck,
                allocateSessionId: async sourceId => {
                  await importCheck();
                  if (!manifest.sessionIds.includes(sourceId) || job.allocations.some(item => item.sourceId === sourceId)) throw failure('IMPORT_FAILED', '会话导入身份无效');
                  const sessionId = `import-${randomUUID()}`;
                  job.allocations.push({ sourceId, sessionId }); await persistRecovery(); return sessionId;
                },
                onResult: async result => {
                  if (!manifest.sessionIds.includes(result.sourceId)) throw failure('IMPORT_FAILED', '会话导入结果无效');
                  const partial = importSummary(result, { sessionIds: [result.sourceId] });
                  job.value.sessions = [...(job.value.sessions ?? []).filter(item => item.sourceId !== result.sourceId), ...partial.sessions];
                  countImportResults(job.value); await persistRecovery();
                },
              });
              Object.assign(job.value, importSummary(result, manifest));
              await check();
              if (job.value.skippedCount || job.value.failedCount || job.value.sessions.some(item => item.outcome === 'imported' && !item.workspaceAttached)) throw failure('IMPORT_FAILED', '导入未全部完成');
              job.value.state = 'succeeded';
            }
          } catch (error) {
            job.value.state = 'failed'; job.value.errorCode = recoveryError(error, kind);
            if (kind === 'import') {
              job.value.sessions ??= [];
              for (const item of job.allocations) if (!job.value.sessions.some(row => row.sourceId === item.sourceId)) job.value.sessions.push({ ...item, outcome: 'failed' });
              countImportResults(job.value);
            }
          }
          await persistRecovery();
        });
      } catch (error) {
        if (!accepted) {
          if (job) { job.value.state = 'failed'; job.value.errorCode = recoveryError(error, kind); }
          refuse(error);
        } else if (job) {
          if (job.value.state === 'running' || kind === 'import') job.value.state = 'failed';
          job.value.errorCode = 'RECOVERY_UNCERTAIN';
        }
      }
    }).finally(() => { if (recoveryTask === operation) { recoveryTask = null; recoveryAbort = undefined; } });
    recoveryTask = operation;
    return admission;
  }
  function publicRegistration(value) {
    return { restoreId: value.restoreId, requestId: value.requestId, root: value.root, registered: value.state === 'succeeded',
      ...(value.workspaceId ? { workspaceId: value.workspaceId } : {}),
      ...(value.state === 'succeeded' ? {} : { uncertain: true, errorCode: 'PROJECT_REGISTRATION_UNCERTAIN' }) };
  }
  async function registerProject({ restoreId, requestId }, { checkBinding = async () => {}, signal, admitRoot = async () => {} } = {}) {
    historyId(restoreId); historyId(requestId);
    await ready(); await loadRecoveryHistory();
    return runSyncOperation(async ({ identity, check }) => {
      await loadRecoveryHistory(true); await check();
      let entry = registrations.get(requestId);
      if (entry && (entry.restoreId !== restoreId || !sameRecoveryAccount(entry.identity, identity))) throw failure('RECOVERY_UNAVAILABLE', '登记请求不可用');
      const restored = entry ? { identity: entry.identity, projectId: entry.projectId, digest: entry.manifestDigest, rootIdentity: entry.rootIdentity, value: { id: entry.restoreId, root: entry.root, checkpointId: entry.checkpointId, sessionCount: entry.sessionCount } }
        : batchRestores.get(restoreId) ?? (latestRestore?.value.id === restoreId ? latestRestore : undefined);
      if (!restored || !sameRecoveryAccount(restored.identity, identity)) throw failure('RECOVERY_UNAVAILABLE', '没有可登记的已完成恢复');
      await verifyRestored(restored, check, true); await admitRoot(restored.value.root); await check();
      const registry = ctx.workspaceRegistry || ctx.get?.('workspaceRegistry');
      if (!registry || typeof registry.list !== 'function' || typeof registry.create !== 'function') throw failure('PROJECTS_UNAVAILABLE', '当前宿主未提供项目登记');
      const existingWorkspace = () => {
        const rows = registry.list();
        if (!Array.isArray(rows)) throw failure('PROJECTS_UNAVAILABLE', '无法确认项目列表');
        const found = rows.find(item => typeof item?.path === 'string' && path.isAbsolute(item.path) && pathKey(item.path) === pathKey(restored.value.root));
        if (found && !historyText(found.id, 256)) throw failure('PROJECTS_UNAVAILABLE', '无法确认项目身份');
        return found;
      };
      const existing = existingWorkspace();
      if (entry) {
        // Unknown effects can be confirmed by a readonly native lookup, never by
        // replaying create(). A removed registration is not silently recreated.
        if (existing && (!entry.workspaceId || entry.workspaceId === existing.id)) { entry.state = 'succeeded'; entry.workspaceId = existing.id; await persistRecovery(); }
        else if (!existing) { entry.state = 'unknown'; await persistRecovery(); }
        return publicRegistration(entry);
      }
      if (recoveryIds.has(requestId) || recoveryIds.size + registrations.size >= maxRecoveryRequests) throw failure('RECOVERY_LIMIT', '恢复请求已达上限');
      const previousRoot = [...registrations.values()].find(item => sameRecoveryAccount(item.identity, identity) && pathKey(item.root) === pathKey(restored.value.root));
      if (previousRoot) {
        if (existing && (!previousRoot.workspaceId || existing.id === previousRoot.workspaceId)) { previousRoot.state = 'succeeded'; previousRoot.workspaceId = existing.id; }
        else previousRoot.state = 'unknown';
        entry = { ...structuredClone(previousRoot), requestId, restoreId };
        registrations.set(requestId, entry); await persistRecovery(); return publicRegistration(entry);
      }
      entry = { requestId, restoreId, identity: recoveryIdentity(identity), root: restored.value.root, state: 'pending', rootIdentity: { ...restored.rootIdentity }, manifestDigest: restored.digest, projectId: restored.projectId, checkpointId: restored.value.checkpointId, sessionCount: restored.value.sessionCount };
      registrations.set(requestId, entry); await persistRecovery();
      try {
        await verifyRestored(restored, check, true); await admitRoot(entry.root); await check();
        if (JSON.stringify(await rootIdentity(entry.root)) !== JSON.stringify(entry.rootIdentity)) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
        const workspace = existing ?? await registry.create(entry.root); // Registration ONLY: no sessions, agents or sync selection.
        if (!workspace || !historyText(workspace.id, 256) || typeof workspace.path !== 'string' || pathKey(workspace.path) !== pathKey(entry.root)) throw failure('PROJECT_REGISTRATION_UNCERTAIN', '项目登记结果未确认');
        entry.workspaceId = workspace.id;
        if (JSON.stringify(await rootIdentity(entry.root)) !== JSON.stringify(entry.rootIdentity)) throw failure('DESTINATION_CHANGED', '恢复目录已变更');
        await check(); entry.state = 'succeeded'; await persistRecovery();
      } catch {
        entry.state = 'unknown';
        try { await persistRecovery(); } catch { /* Durable pending intent still forbids replay. */ }
      }
      return publicRegistration(entry);
    }, { checkBinding, signal });
  }
  const controller = {
    get config() { return config; }, store, credentialKey,
    setInitializer(value) { initializer = value; },
    setRootAdmission(value) { rootAdmission = value; },
    setCaptureExclusions(value) { captureExclusions = value; },
    setRestoreAdmission(value) { restoreAdmission = value; },
    startRecovery,
    startDownload,
    registerProject,
    readAccount,
    // Host-only methods: never expose these internal grants over an RPC route.
    syncAccount,
    runSyncOperation,
    renewAuthorization,
    requireSyncReauthentication,
    async browse(kind, projectId, { checkBinding, signal, knownProjects } = {}) {
      return readAccount(context => kind === 'projects' ? cloudProjects(context, knownProjects) : context.client.list(projectId), { checkBinding, signal });
    },
    setIdentityPersister(value) { identityPersister = value; },
    setAdditionalIdentityAdmission(value) { assert(typeof value === 'function', 'Invalid identity admission'); additionalIdentityAdmission = value; },
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
      await ready(); if (updateRestartRequired || updateRunning || mutating || batchRunning || active || recoveryTask || downloadTask) return;
      batchRunning = true; const epoch = generation, results = [];
      try {
        for (const item of [...config.projects]) {
          if (stopped || epoch !== generation || mutating) break;
          try { results.push(await push(item.id)); }
          catch (error) { results.push(error.syncResult || { projectId: item.id, error: '同步未完成', errorCode: error.code }); }
        }
        if (results.length) lastResult = { at: new Date().toISOString(), results };
        return lastResult;
      } finally { batchRunning = false; }
    },
    schedulePush(id) {
      updateAdmission(); project(id); assert(!stopped, 'Plugin is stopped');
      if (recoveryTask || downloadTask || mutating) throw failure('BUSY', '另一项操作尚未完成');
      const handle = setImmediate(() => {
        scheduled.delete(handle); if (!stopped) void push(id).catch(() => {});
      });
      scheduled.add(handle); return { scheduled: true, next: '命令结束后执行同步，请用设置页或 /sync-status 查看结果。' };
    },
    async scheduleSelected(workspaceId) {
      await ready(); updateAdmission();
      if (mutating || active || batchRunning || scheduled.size || recoveryTask || downloadTask) throw failure('BUSY', '同步或设置操作正在进行');
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
    // Read-only account projection for v2 admission and the current account UI.
    // Legacy queue/recovery inventories are not authentication evidence: do not
    // decode them on every catalog response or account-status poll.
    async accountStatus() {
      await ready(); await store.init();
      let loggedIn = false, expiresAt, identity, reauthRequired = true;
      try { reauthRequired = await requiresReauthentication() || (await store.config())?.reauthRequired === true; } catch {}
      try { const record = await account(); identity = record; expiresAt = record.expiresAt; loggedIn = Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now(); } catch {}
      const authState = reauthRequired ? 'reauth-required' : loggedIn ? (identity.refreshToken ? 'renewable' : 'legacy') : 'signed-out';
      return { server: config.server, username: config.username, loggedIn, reauthRequired, authState, ...(expiresAt ? { expiresAt } : {}), running: Boolean(updateRunning || active || batchRunning || scheduled.size || recoveryTask || downloadTask) };
    },
    async status() {
      await ready(); await store.init(); await loadRecoveryHistory();
      const epoch = generation, pending = (await store.pending()).length;
      let loggedIn = false, expiresAt, identity, reauthRequired = true;
      try { reauthRequired = await requiresReauthentication() || (await store.config())?.reauthRequired === true; } catch {}
      try { const record = await account(); identity = record; expiresAt = record.expiresAt; loggedIn = Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now(); } catch {}
      const authState = reauthRequired ? 'reauth-required' : loggedIn ? (identity.refreshToken ? 'renewable' : 'legacy') : 'signed-out';
      return { server: config.server, username: config.username, loggedIn, reauthRequired, authState, ...(expiresAt ? { expiresAt } : {}), autoSync: !reauthRequired && config.autoSync, intervalMs: config.intervalMs, projects: config.projects, pending, running: Boolean(updateRunning || active || batchRunning || scheduled.size || recoveryTask || downloadTask), lastResult, ...(latestRecovery && loggedIn && !mutating && epoch === generation && sameRecoveryAccount(latestRecovery.identity, identity) ? { recovery: publicRecovery(latestRecovery) } : {}), ...(latestDownload && loggedIn && !mutating && epoch === generation && sameRecoveryAccount(latestDownload.identity, identity) ? { download: publicDownload(latestDownload) } : {}) };
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
        const epoch = nextAuthorizationEpoch(local, native?.payload);
        config.autoSync = false;
        // Local revocation remains durable if remote or native cleanup is damaged.
        await atomicWrite(reauthMarker, JSON.stringify({ version: 1, authorizationEpoch: epoch, reason: 'LOGGED_OUT', startedAt: new Date().toISOString() }));
        const records = [native?.kind === 'grant' ? native.payload : undefined, local].filter(value => value?.token);
        const seen = new Set(), results = [];
        for (const record of records) {
          if (seen.has(record.token)) continue;
          seen.add(record.token); results.push(await revokeOwnedGrant(record));
        }
        await ctx.credentials.deleteRecord(credentialKey);
        await store.saveConfig({ server: config.server || local?.server, username: config.username ?? local?.username, ...(local?.deviceId ? { deviceId: local.deviceId } : {}), authorizationEpoch: epoch, reauthRequired: true });
        await persistLogout?.();
        if (latestRestore) delete latestRestore.digest;
        latestRestore = undefined; clearBatchRestores();
        const remoteRevoked = results.every(result => result.remoteRevoked);
        return { loggedOut: true, remoteRevoked, ...(remoteRevoked ? {} : { warning: '远端撤销未确认' }) };
      }, { cancelRecovery: true, allowAfterUpdate: true });
    },
    stop() { stopped = true; generation++; lifetime.abort(); activeAbort?.abort(); recoveryAbort?.abort(); downloadAbort?.abort(); clearScheduled(); },
    async drain() { await Promise.allSettled([active, mutationTask, recoveryTask, downloadTask].filter(Boolean)); },
  };
  return controller;
}
