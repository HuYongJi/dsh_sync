// Account and native-updater state only. Project operations belong to the bidirectional controller.
export const RPC_CHANNEL = '/api';
export const RPC_PREFIX = 'dsh-personal-sync/';
export const CLIENT_ACTIONS = Object.freeze(['status', 'login', 'password', 'logout', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']);

const MESSAGES = Object.freeze({
  BAD_SERVER: '服务器地址无效',
  BAD_USERNAME: '账号无效',
  BAD_PASSWORD: '密码无效或超过1024字节',
  BAD_REQUEST: '请求无效',
  INVALID_RESPONSE: '状态格式不兼容，请升级插件',
  NOT_DEPLOYED: '此宿主尚未启用个人云同步服务',
  CONNECTION_UNAVAILABLE: 'DSH 连接不可用',
  AUTH_REQUIRED: 'DSH 授权已失效',
  FORBIDDEN: '请求被拒绝',
  NOT_LOGGED_IN: '请先登录',
  AUTH_RENEWAL_UNCERTAIN: '续期结果未确认，请重新登录',
  SYNC_CLIENT_UPGRADE_REQUIRED: '请先升级同步服务器',
  SYNC_MANAGED_PROJECT: '此项目已启用双向同步，请使用双向同步操作',
  LOGIN_FAILED: '登录失败，请检查账号和密码',
  INVALID_CREDENTIALS: '账号或密码错误',
  CURRENT_PASSWORD_INVALID: '当前密码错误',
  PASSWORD_TOO_WEAK: '新密码至少8位',
  PASSWORD_TOO_LONG: '新密码不能超过1024字节',
  PASSWORD_CONFIRM_MISMATCH: '两次新密码不一致',
  PASSWORD_UNCHANGED: '新旧密码不能相同',
  PASSWORD_CHANGE_UNSUPPORTED: '请先升级同步服务器',
  PASSWORD_CHANGE_REJECTED: '修改未通过验证',
  PASSWORD_CHANGE_UNCERTAIN: '结果未确认，请重新登录',
  CONFIG_CONFLICT: '配置已变更，请刷新并重新选择',
  CONFLICT: '状态冲突，请刷新',
  BUSY: '正在处理其他操作',
  SERVICE_UNAVAILABLE: '同步服务不可用',
  SERVER_UNAVAILABLE: '无法连接同步服务器',
  ACCOUNT_BOUND: '同步记录已绑定其他账号',
  ACCOUNT_MISMATCH: '服务器或账号已变更',
  SETTINGS_CORRUPT: '同步设置损坏',
  SETTINGS_FAILED: '同步设置保存失败',
  SERVER_UNREACHABLE: '无法连接同步服务器',
  DISPOSED: '插件已停用，请刷新',
  REQUEST_TOO_LARGE: '请求过大',
  UNSUPPORTED_MEDIA_TYPE: '请求格式不兼容',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  TIMEOUT: '请求超时，请刷新状态',
  REQUEST_FAILED: '请求失败，请刷新状态',
  BAD_REQUEST_ID: '无法生成安全请求 ID，请升级浏览器',
  UPDATE_UNAVAILABLE: '此宿主不支持原生插件更新，请检查 DSH Plugins',
  UPDATE_UNMANAGED: '此插件未由原生插件管理器管理，请检查 DSH Plugins',
  UPDATE_CHECK_FAILED: '检查更新失败，请稍后手动重试',
  UPDATE_INVALID_METADATA: '更新元数据无效，未允许安装',
  UPDATE_CHECK_REQUIRED: '请重新检查更新后再确认',
  UPDATE_NOT_NEWER: '候选版本不比运行版本新，请重新检查更新',
  UPDATE_BUILD_APPROVAL_REQUIRED: '原生安装需要脚本审批，请在 DSH Plugins 中手动检查',
  UPDATE_INCOMPATIBLE: '版本不兼容，请在 DSH Plugins 中手动检查',
  UPDATE_FAILED: '更新未完成，请在 DSH Plugins 中手动检查',
  UPDATE_UNCERTAIN: '更新结果未确认，请核对更新状态，勿重复安装',
  UPDATE_CANCEL_TOO_LATE: '已无法取消；这不表示回滚，请核对状态并检查 DSH Plugins',
  UPDATE_RESTART_REQUIRED: '插件文件可能已变更，请重启 DSH 后刷新页面（仅刷新无效）',
});

export class SettingsClientError extends Error {
  constructor(code) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'REQUEST_FAILED';
    super(MESSAGES[known]);
    this.name = 'SettingsClientError';
    this.code = known;
  }
}
const fail = code => { throw new SettingsClientError(code); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const utf8Length = value => new TextEncoder().encode(value).length;
const freeze = value => Object.freeze(value);

/** Validate an origin, not a route or credentials-bearing URL. Host revalidates it. */
export function normalizeServer(value) {
  if (typeof value !== 'string') fail('BAD_SERVER');
  const input = value.trim();
  if (!input || input.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(input)) fail('BAD_SERVER');
  let url;
  try { url = new URL(input); } catch { fail('BAD_SERVER'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' || input.includes('?') || input.includes('#')) fail('BAD_SERVER');
  return url.origin;
}

/** Password is returned solely for the one outgoing request, never for a store. */
export function validateLogin({ server, username, password, remember } = {}) {
  const origin = normalizeServer(server);
  const account = typeof username === 'string' ? username.trim() : '';
  if (!text(account, 128, false) || utf8Length(account) > 128) fail('BAD_USERNAME');
  if (typeof password !== 'string' || password.length === 0 || utf8Length(password) > 1024) fail('BAD_PASSWORD');
  if (remember !== undefined && typeof remember !== 'boolean') fail('BAD_REQUEST');
  return { server: origin, username: account, password, ...(remember === undefined ? {} : { remember }) };
}

/** The destination is a snapshot of saved Host identity, never the editable login form. */
export function validatePasswordChange(status, binding, { currentPassword, newPassword, confirmPassword } = {}) {
  if (!status?.server || !status.username || !isRecord(binding) || binding.server !== status.server || binding.username !== status.username) fail('ACCOUNT_MISMATCH');
  if (!integer(binding.revision) || binding.revision !== status.revision) fail('CONFIG_CONFLICT');
  if (typeof currentPassword !== 'string' || !currentPassword.length || utf8Length(currentPassword) > 1024) fail('BAD_PASSWORD');
  if (typeof newPassword !== 'string' || [...newPassword].length < 8) fail('PASSWORD_TOO_WEAK');
  if (utf8Length(newPassword) > 1024) fail('PASSWORD_TOO_LONG');
  if (newPassword !== confirmPassword) fail('PASSWORD_CONFIRM_MISMATCH');
  if (newPassword === currentPassword) fail('PASSWORD_UNCHANGED');
  return { revision: binding.revision, server: status.server, username: status.username, currentPassword, newPassword };
}

function optionalDate(value) {
  if (value === undefined || value === null) return undefined;
  if (!text(value, 64, false) || !Number.isFinite(Date.parse(value))) fail('INVALID_RESPONSE');
  return value;
}
function optionalText(value, max = 1024) {
  if (value === undefined || value === null) return undefined;
  if (!text(value, max)) fail('INVALID_RESPONSE');
  return value;
}

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value.toLowerCase());
const validRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function requiredDate(value) {
  if (typeof value !== 'string' || optionalDate(value) !== value || new Date(value).toISOString() !== value) fail('INVALID_RESPONSE');
  return value;
}

const UPDATE_STATES = freeze(['idle', 'checking', 'available', 'up-to-date', 'installing', 'cancelling', 'restart-required', 'cancelled', 'failed', 'uncertain']);
const UPDATE_ERRORS = freeze(['UPDATE_UNAVAILABLE', 'UPDATE_UNMANAGED', 'UPDATE_CHECK_FAILED', 'UPDATE_INVALID_METADATA', 'UPDATE_CHECK_REQUIRED', 'UPDATE_NOT_NEWER', 'UPDATE_BUILD_APPROVAL_REQUIRED', 'UPDATE_INCOMPATIBLE', 'UPDATE_FAILED', 'UPDATE_UNCERTAIN', 'UPDATE_CANCEL_TOO_LATE', 'UPDATE_RESTART_REQUIRED', 'BAD_REQUEST', 'BUSY', 'DISPOSED', 'RATE_LIMITED']);
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(part => integer(Number(part)));
const newerVersion = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  const index = left.findIndex((part, at) => part !== right[at]);
  return index !== -1 && left[index] > right[index];
};
const updateRunning = value => ['installing', 'cancelling'].includes(value?.state);
const matchesUpdate = (intent, value) => Boolean(intent && value && intent.currentVersion === value.currentVersion && intent.candidateId === value.candidate?.id && intent.version === value.candidate.version && intent.commit === value.candidate.commit);

/** Only typed public metadata is retained. Native logs, specs, paths and credentials never enter state. */
export function parseUpdateStatus(value) {
  if (!isRecord(value) || !validVersion(value.currentVersion) || typeof value.supported !== 'boolean' || !UPDATE_STATES.includes(value.state) || typeof value.restartRequired !== 'boolean') fail('INVALID_RESPONSE');
  const result = { currentVersion: value.currentVersion, supported: value.supported, state: value.state, restartRequired: value.restartRequired };
  if (value.installedVersion !== undefined) {
    if (!validVersion(value.installedVersion)) fail('INVALID_RESPONSE');
    result.installedVersion = value.installedVersion;
  }
  if (value.requestId !== undefined) {
    if (!validId(value.requestId)) fail('INVALID_RESPONSE');
    result.requestId = value.requestId;
  }
  if (value.errorCode !== undefined) {
    if (!UPDATE_ERRORS.includes(value.errorCode)) fail('INVALID_RESPONSE');
    result.errorCode = value.errorCode;
  }
  if (value.candidate !== undefined) {
    const item = value.candidate;
    if (!isRecord(item) || !validId(item.id) || !validVersion(item.version) || !newerVersion(item.version, value.currentVersion) || typeof item.commit !== 'string' || !/^[0-9a-f]{40}$/.test(item.commit)) fail('INVALID_RESPONSE');
    result.candidate = freeze({ id: item.id, version: item.version, commit: item.commit, checkedAt: requiredDate(item.checkedAt) });
  }
  if ((value.state === 'available' && !result.candidate) || (updateRunning(value) && !result.requestId) || (value.state === 'restart-required' && !value.restartRequired)) fail('INVALID_RESPONSE');
  return freeze(result);
}

/** Only account and updater metadata survive this boundary. Legacy status fields are ignored. */
export function parseStatus(value) {
  if (!isRecord(value) || !integer(value.revision) || typeof value.loggedIn !== 'boolean' || (value.running !== undefined && typeof value.running !== 'boolean')) fail('INVALID_RESPONSE');
  const server = value.server ?? '';
  const username = value.username ?? '';
  if (!text(server, 2048) || !text(username, 128)) fail('INVALID_RESPONSE');
  if (server) { try { normalizeServer(server); } catch { fail('INVALID_RESPONSE'); } }
  const expiresAt = optionalDate(value.expiresAt);
  if (value.authState !== undefined && !['reauth-required', 'renewable', 'legacy', 'signed-out'].includes(value.authState)) fail('INVALID_RESPONSE');
  if (value.reauthRequired !== undefined && typeof value.reauthRequired !== 'boolean') fail('INVALID_RESPONSE');
  const warning = optionalText(value.warning);
  return freeze({ revision: value.revision, server, username, loggedIn: value.loggedIn, running: value.running === true,
    ...(expiresAt === undefined ? {} : { expiresAt }), ...(warning === undefined ? {} : { warning }),
    ...(value.authState === undefined ? {} : { authState: value.authState }),
    ...(value.reauthRequired === undefined ? {} : { reauthRequired: value.reauthRequired }),
    ...(value.update === undefined ? {} : { update: parseUpdateStatus(value.update) }) });
}

function publicError(error) {
  // Never display transport exception text or arbitrary server error bodies: they may echo input.
  if (error instanceof SettingsClientError) return freeze({ code: error.code, message: error.message });
  const match = /^transport failure for \/api\/dsh-personal-sync\/[a-z]+: HTTP (\d{3})$/.exec(typeof error?.message === 'string' ? error.message : '');
  const code = ({ 400: 'BAD_REQUEST', 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_DEPLOYED', 409: 'CONFLICT', 503: 'SERVICE_UNAVAILABLE' })[match?.[1]] ?? 'REQUEST_FAILED';
  return freeze({ code, message: MESSAGES[code] });
}
function hostError(value) {
  const aliases = { 'gateway/not-found': 'NOT_DEPLOYED', 'gateway/not-implemented': 'NOT_DEPLOYED', 'gateway/unavailable': 'SERVICE_UNAVAILABLE', 'gateway/bad-request': 'BAD_REQUEST', 'gateway/unauthorized': 'AUTH_REQUIRED', 'gateway/forbidden': 'FORBIDDEN' };
  const code = typeof value?.code === 'string' ? value.code : '';
  return new SettingsClientError(Object.hasOwn(aliases, code) ? aliases[code] : code);
}

/** No global fetch fallback: DSH chooses the carrier, origin and authentication. */
export function createConnectionTransport(connection) {
  return async (action, payload, signal) => {
    if (!CLIENT_ACTIONS.includes(action)) fail('BAD_REQUEST');
    if (typeof connection?.rpc?.call !== 'function') fail('CONNECTION_UNAVAILABLE');
    const result = await connection.rpc.call(RPC_CHANNEL, RPC_PREFIX + action, payload, signal);
    if (!isRecord(result) || typeof result.ok !== 'boolean') fail('INVALID_RESPONSE');
    if (!result.ok) throw hostError(result.error);
    return result.value;
  };
}

export function deriveView(state) {
  const status = state.status;
  const locked = !state.ready || state.loading || state.refreshing || Boolean(state.busy);
  const updater = state.update ?? status?.update;
  // A known terminal task may have changed plugin files; it permits logout, never another install.
  const settledUncertain = updater?.state === 'uncertain' && updater.restartRequired === true && Boolean(updater.requestId) && !state.updatePendingId;
  const updaterBusy = updateRunning(updater) || Boolean(state.updatePendingId) || (state.updateUncertain === true && !settledUncertain);
  const restartRequired = updater?.restartRequired === true;
  const updateBlocked = updaterBusy || restartRequired || state.updateUncertain === true;
  return freeze({ locked, updaterBusy, restartRequired, updateBlocked,
    updateError: state.updateError?.message ?? (updater?.errorCode ? MESSAGES[updater.errorCode] : ''),
    canCheckUpdate: !locked && !updateBlocked && updater?.supported !== false && updater?.state !== 'checking',
    canUpdate: !locked && !updateBlocked && !state.updateError && !status?.running && updater?.supported === true && updater.state === 'available' && Boolean(updater.candidate),
    // A read cannot hide cancellation; cancelling invalidates that read before writing.
    canCancelUpdate: !state.busy && updateRunning(updater) && updater.state !== 'cancelling' && updater.errorCode !== 'UPDATE_CANCEL_TOO_LATE' && state.updateError?.code !== 'UPDATE_CANCEL_TOO_LATE' && Boolean(state.updatePendingId && state.updatePendingId === updater.requestId),
    canLogin: !locked && !status?.running && !updateBlocked,
    canLogout: !locked && !updaterBusy && Boolean(status?.loggedIn),
    canChangePassword: !locked && !updateBlocked && !state.passwordUncertain && Boolean(status?.server && status?.username) });
}

/** A subscribable, immutable state store; it never owns or persists a password. */
export function createController(connection, options = {}) {
  const request = createConnectionTransport(connection);
  const setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const pollMs = Math.max(1000, options.pollMs ?? 3000);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 60000);
  let state = freeze({ status: null, loading: true, refreshing: false, ready: false, busy: null, error: null, notice: '', passwordUncertain: false,
    update: null, updateIntent: null, updatePendingId: null, updateUncertain: false, updateError: null });
  const listeners = new Set();
  let disposed = false, watchers = 0, pollTimer, expiryTimer, expiryReadKey, rejectedAuth, active, refreshAbort;
  let generation = 0, updateUncertainChecks = 0;
  const update = patch => {
    if (disposed) return;
    state = freeze({ ...state, ...patch });
    queueExpiry();
    for (const listener of listeners) listener();
  };
  const clearPoll = () => { if (pollTimer !== undefined) clearTimer(pollTimer); pollTimer = undefined; };
  const clearExpiry = () => { if (expiryTimer !== undefined) clearTimer(expiryTimer); expiryTimer = undefined; };
  const authFailure = code => code === 'NOT_LOGGED_IN' || code === 'AUTH_RENEWAL_UNCERTAIN';
  const sameAuthIdentity = (a, b) => Boolean(a && b && a.server === b.server && a.username === b.username);
  const expiryKey = status => JSON.stringify([status.server, status.username, Date.parse(status.expiresAt)]);
  function rememberAuthRejection(code, status = state.status) {
    if (!status) return;
    const previous = sameAuthIdentity(rejectedAuth, status) ? rejectedAuth : undefined;
    const expiresAt = previous?.expiresAt && (!status.expiresAt || Date.parse(previous.expiresAt) > Date.parse(status.expiresAt)) ? previous.expiresAt : status.expiresAt;
    rejectedAuth = { server: status.server, username: status.username, expiresAt, code };
  }
  function signedOut(status) {
    return status && freeze({ ...status, loggedIn: false, reauthRequired: true, authState: 'reauth-required' });
  }
  function markAuthRejected(code) {
    rememberAuthRejection(code);
    clearPoll();
    update({ status: signedOut(state.status), notice: '', error: publicError(new SettingsClientError(code)) });
  }
  function queueExpiry() {
    clearExpiry();
    if (disposed || !watchers || !state.ready || state.busy || state.refreshing || !state.status?.loggedIn || !state.status.expiresAt) return;
    const key = expiryKey(state.status);
    if (key === expiryReadKey) return;
    // Browser/Node timers overflow above 2^31-1. Long-lived grants use local-only
    // wakeups until their deadline, never blanket idle status polling.
    const remaining = Date.parse(state.status.expiresAt) - now();
    expiryTimer = setTimer(() => {
      expiryTimer = undefined;
      if (disposed || !watchers || state.busy || state.refreshing || !state.status?.loggedIn || expiryKey(state.status) !== key) { queueExpiry(); return; }
      if (Date.parse(state.status.expiresAt) > now()) { queueExpiry(); return; }
      expiryReadKey = key;
      markAuthRejected('NOT_LOGGED_IN');
      void refresh();
    }, Math.max(1, Math.min(remaining, 2_147_483_647)));
  }
  const invalidateRefresh = () => { ++generation; refreshAbort?.abort(); refreshAbort = undefined; };
  function queuePoll() {
    clearPoll();
    if (disposed || !watchers || state.busy || state.refreshing) return;
    if (state.updateUncertain && updateUncertainChecks >= 10) return;
    if (updateRunning(state.update) || state.update?.state === 'checking' || state.updateUncertain || state.updatePendingId) {
      pollTimer = setTimer(() => { pollTimer = undefined; void refreshUpdate(); }, pollMs);
    } else if (state.ready && state.status?.running && !rejectedAuth && !state.passwordUncertain) {
      // The Host busy flag includes v2 work. Reconcile that read-only guard until
      // idle; legacy queues/preferences never trigger polling or a mutation.
      pollTimer = setTimer(() => {
        pollTimer = undefined;
        if (!disposed && watchers && state.ready && !state.busy && !state.refreshing && state.status?.running) void refresh();
      }, pollMs);
    }
  }
  function updatePatch(incoming) {
    const runtimeChanged = state.update && incoming.currentVersion !== state.update.currentVersion;
    // Native install may have changed files even on cancellation/failure. Only a new runtime clears this latch.
    const value = !runtimeChanged && state.update?.restartRequired && !incoming.restartRequired ? freeze({ ...incoming, restartRequired: true }) : incoming;
    let updatePendingId = runtimeChanged ? null : state.updatePendingId;
    let updateUncertain = runtimeChanged ? false : state.updateUncertain;
    let updateError = runtimeChanged ? null : state.updateError;
    if (!updatePendingId || value.requestId === updatePendingId) {
      updatePendingId = updateRunning(value) ? value.requestId : null;
      updateUncertain = value.state === 'uncertain';
      if (!updateUncertain) {
        updateUncertainChecks = 0;
        if (updateError?.code === 'UPDATE_UNCERTAIN') updateError = null;
      }
    } else {
      // A different/missing task cannot acknowledge our write or authorize cancelling somebody else's task.
      updateUncertain = true;
      updateError = publicError(new SettingsClientError('UPDATE_UNCERTAIN'));
    }
    if (runtimeChanged) updateUncertainChecks = 0;
    const updateIntent = value.supported && value.state === 'available' && !value.restartRequired && matchesUpdate(state.updateIntent, value) ? state.updateIntent : null;
    return { update: value, updateIntent, updatePendingId, updateUncertain, updateError };
  }
  function acceptUpdate(value) {
    const patch = updatePatch(value);
    update({ ...patch, ...(state.status ? { status: freeze({ ...state.status, update: patch.update }) } : {}) });
  }
  function acceptStatus(status) {
    const hostPaused = status.reauthRequired === true || status.authState === 'reauth-required' || (status.loggedIn && status.authState === 'signed-out');
    const expired = status.loggedIn && status.expiresAt && Date.parse(status.expiresAt) <= now();
    if (hostPaused || expired) {
      if (expired) expiryReadKey = expiryKey(status); // This read already reconciled that deadline.
      rememberAuthRejection(sameAuthIdentity(rejectedAuth, status) ? rejectedAuth.code : 'NOT_LOGGED_IN', status);
    } else if (rejectedAuth && status.loggedIn) {
      // Revision changes alone are not authentication proof. Without
      // an older known expiry, only explicit login can restore the same identity.
      const newExpiry = status.expiresAt && rejectedAuth.expiresAt && Date.parse(status.expiresAt) > Date.parse(rejectedAuth.expiresAt) && Date.parse(status.expiresAt) > now();
      if (!sameAuthIdentity(rejectedAuth, status) || newExpiry) rejectedAuth = undefined;
    }
    if (sameAuthIdentity(rejectedAuth, status)) status = signedOut(status);
    // A late/stale status must not revive tokens after an uncertain password write.
    if (state.passwordUncertain) status = freeze({ ...status, loggedIn: false });
    const updater = status.update ? updatePatch(status.update) : {};
    const latestUpdate = updater.update ?? state.update;
    if (latestUpdate) status = freeze({ ...status, update: latestUpdate });
    update({ status, ready: true, loading: false, ...updater,
      error: sameAuthIdentity(rejectedAuth, status) ? publicError(new SettingsClientError(rejectedAuth.code)) : null });
  }
  async function withDeadline(action, body, abort) {
    let timedOut = false;
    let onAbort;
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => reject(new SettingsClientError(timedOut ? 'TIMEOUT' : 'REQUEST_FAILED'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimer(() => { timedOut = true; abort.abort(); }, timeoutMs);
    try {
      if (abort.signal.aborted) fail('REQUEST_FAILED');
      // Do not depend on the carrier honoring cancellation or delivering a late result.
      const result = await Promise.race([request(action, body, abort.signal), cancelled]);
      if (timedOut) fail('TIMEOUT');
      return result;
    } catch (error) {
      if (timedOut) fail('TIMEOUT');
      throw error;
    } finally {
      clearTimer(timer);
      abort.signal.removeEventListener('abort', onAbort);
    }
  }
  async function refresh() {
    if (disposed || state.busy) return false;
    clearPoll();
    invalidateRefresh();
    const current = generation;
    const abort = new AbortController();
    refreshAbort = abort;
    update({ refreshing: true });
    try {
      const result = await withDeadline('status', {}, abort);
      if (disposed || current !== generation) return false;
      acceptStatus(parseStatus(result));
      return true;
    } catch (error) {
      if (!disposed && current === generation) update({ error: publicError(error), ready: false, loading: false });
      return false;
    } finally {
      if (!disposed && current === generation) { refreshAbort = undefined; update({ refreshing: false }); queuePoll(); }
    }
  }
  function report(error) { update({ error: publicError(error), notice: '' }); return false; }
  function guardAction(action) {
    if (disposed || !state.ready || state.busy || state.loading || state.refreshing) return false;
    const view = deriveView(state);
    if (view.updaterBusy) return report(new SettingsClientError('BUSY'));
    if (view.restartRequired && action !== 'logout') return report(new SettingsClientError('UPDATE_RESTART_REQUIRED'));
    if (state.status.running && action === 'login') return report(new SettingsClientError('BUSY'));
    if (action === 'logout' && !state.status.loggedIn) return false;
    return true;
  }
  function markPasswordUncertain() {
    update({ status: state.status && freeze({ ...state.status, loggedIn: false }), passwordUncertain: true, ready: false, notice: '' });
  }
  async function reconcilePasswordFailure(error) {
    const safe = publicError(error);
    const rejected = ['CURRENT_PASSWORD_INVALID', 'PASSWORD_TOO_WEAK', 'PASSWORD_TOO_LONG', 'PASSWORD_UNCHANGED',
      'PASSWORD_CHANGE_UNSUPPORTED', 'PASSWORD_CHANGE_REJECTED', 'BAD_PASSWORD', 'BAD_REQUEST', 'CONFIG_CONFLICT',
      'ACCOUNT_MISMATCH', 'BUSY', 'NOT_DEPLOYED', 'AUTH_REQUIRED', 'FORBIDDEN', 'RATE_LIMITED', 'SERVER_UNREACHABLE'].includes(safe.code);
    const notice = rejected ? safe : publicError(new SettingsClientError('PASSWORD_CHANGE_UNCERTAIN'));
    if (!rejected) markPasswordUncertain();
    update({ ready: false, error: notice });
    // Exactly one read after a failed mutation, never a replay of the password write.
    const recovery = new AbortController();
    active = recovery;
    try {
      const result = await withDeadline('status', {}, recovery);
      if (disposed) return;
      acceptStatus(parseStatus(result));
    } catch {
      if (!disposed) markPasswordUncertain();
    }
    if (!disposed) update({ error: notice });
  }
  async function reconcileAuthFailure(safe) {
    markAuthRejected(safe.code); // Show an empty sign-in form before the read settles.
    const recovery = new AbortController(); active = recovery;
    try {
      const result = await withDeadline('status', {}, recovery);
      if (!disposed) acceptStatus(parseStatus(result));
    } catch {
      if (!disposed) update({ ready: false });
    }
    if (!disposed) update({ error: safe });
  }
  async function mutate(action, body) {
    if (!guardAction(action)) return false;
    invalidateRefresh(); clearPoll();
    const abort = new AbortController(); active = abort;
    update({ busy: action, error: null, notice: '' });
    try {
      const result = await withDeadline(action, body, abort);
      if (disposed) return false;
      if (abort.signal.aborted) fail('REQUEST_FAILED');
      const next = parseStatus(result);
      // Older hosts must not acknowledge a password change while keeping its grant/automatic uploader live.
      if (action === 'password' && (next.loggedIn || result.autoSync === true)) fail('INVALID_RESPONSE');
      if (action === 'login' && next.loggedIn && next.reauthRequired !== true && next.authState !== 'reauth-required' && next.authState !== 'signed-out') { rejectedAuth = undefined; expiryReadKey = undefined; }
      if (action === 'login' || action === 'password') update({ passwordUncertain: false });
      acceptStatus(next);
      update({ notice: action === 'login' ? '已登录' : action === 'password' ? '密码已修改，请重新登录' : '已退出登录' });
      return true;
    } catch (error) {
      if (!disposed && action === 'password') await reconcilePasswordFailure(error);
      else if (!disposed && (!abort.signal.aborted || (error instanceof SettingsClientError && error.code === 'TIMEOUT'))) {
        const safe = publicError(error);
        if (authFailure(safe.code)) await reconcileAuthFailure(safe);
        else update({ error: safe, ready: !['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_DEPLOYED', 'CONNECTION_UNAVAILABLE', 'INVALID_RESPONSE', 'TIMEOUT'].includes(safe.code) });
      }
      return false;
    } finally {
      active = undefined;
      if (!disposed) { update({ busy: null }); queuePoll(); }
    }
  }
  function requestId() {
    const crypto = options.crypto ?? globalThis.crypto;
    let id;
    try {
      if (typeof crypto?.randomUUID === 'function') id = crypto.randomUUID();
      else if (typeof crypto?.getRandomValues === 'function') {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    } catch { fail('BAD_REQUEST_ID'); }
    if (!validRequestId(id)) fail('BAD_REQUEST_ID');
    return id;
  }
  const updateReport = error => { update({ updateError: publicError(error), updateIntent: null }); return false; };
  async function refreshUpdate() {
    if (disposed || state.busy) return false;
    clearPoll(); invalidateRefresh();
    const current = generation;
    const abort = new AbortController(); refreshAbort = abort;
    update({ refreshing: true });
    if (state.updateUncertain) ++updateUncertainChecks;
    try {
      const result = await withDeadline('updatestatus', {}, abort);
      if (disposed || current !== generation) return false;
      acceptUpdate(parseUpdateStatus(result?.update));
      return true;
    } catch (error) {
      if (!disposed && current === generation) {
        const uncertain = Boolean(state.updatePendingId || updateRunning(state.update) || state.updateUncertain);
        update({ updateUncertain: uncertain, updateError: publicError(uncertain ? new SettingsClientError('UPDATE_UNCERTAIN') : error) });
      }
      return false;
    } finally {
      if (!disposed && current === generation) { refreshAbort = undefined; update({ refreshing: false }); queuePoll(); }
    }
  }
  async function checkUpdate() {
    if (disposed || !deriveView(state).canCheckUpdate) return false;
    invalidateRefresh(); clearPoll();
    const abort = new AbortController(); active = abort;
    update({ busy: 'checkupdate', updateIntent: null, updateError: null });
    try {
      const result = await withDeadline('checkupdate', {}, abort);
      if (disposed) return false;
      const next = parseUpdateStatus(result?.update);
      acceptUpdate(next);
      return ['available', 'up-to-date'].includes(next.state);
    } catch (error) {
      if (!disposed) updateReport(error);
      return false;
    } finally {
      active = undefined;
      if (!disposed) { update({ busy: null }); queuePoll(); }
    }
  }
  function prepareUpdate() {
    if (disposed || !deriveView(state).canUpdate) return null;
    if (matchesUpdate(state.updateIntent, state.update)) return state.updateIntent;
    try {
      const { candidate, currentVersion } = state.update;
      const intent = freeze({ candidateId: candidate.id, version: candidate.version, commit: candidate.commit, currentVersion, requestId: requestId() });
      update({ updateIntent: intent, updateError: null });
      return intent;
    } catch (error) { updateReport(error); return null; }
  }
  async function updateMutation(action, intent) {
    // The caller's live, consumed intent is the only authority; caller-provided extra fields never cross Connection.
    const id = intent.requestId;
    invalidateRefresh(); clearPoll();
    const abort = new AbortController(); active = abort;
    updateUncertainChecks = 0;
    update({ busy: action, refreshing: false, updateIntent: null, updatePendingId: id, updateUncertain: false, updateError: null });
    let accepted = false;
    try {
      const payload = action === 'installupdate' ? { candidateId: intent.candidateId, requestId: id, confirm: true } : { requestId: id };
      const result = await withDeadline(action, payload, abort);
      if (disposed) return false;
      const next = parseUpdateStatus(result?.update);
      if (next.requestId !== id || !['installing', 'cancelling', 'restart-required', 'cancelled', 'failed', 'uncertain'].includes(next.state)) fail('INVALID_RESPONSE');
      acceptUpdate(next);
      accepted = ['installing', 'cancelling', 'restart-required'].includes(next.state) && !next.errorCode;
    } catch (error) {
      if (!disposed) {
        const safe = publicError(error);
        const rejected = action === 'installupdate' && ['BAD_REQUEST', 'BUSY', 'DISPOSED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_DEPLOYED', 'UPDATE_UNAVAILABLE', 'UPDATE_UNMANAGED', 'UPDATE_CHECK_REQUIRED', 'UPDATE_NOT_NEWER', 'UPDATE_INVALID_METADATA', 'UPDATE_INCOMPATIBLE', 'UPDATE_RESTART_REQUIRED'].includes(safe.code);
        update({ updatePendingId: rejected ? null : id, updateUncertain: !rejected,
          updateError: rejected || safe.code === 'UPDATE_CANCEL_TOO_LATE' ? safe : publicError(new SettingsClientError('UPDATE_UNCERTAIN')) });
        if (safe.code === 'UPDATE_RESTART_REQUIRED' && state.update) acceptUpdate(freeze({ ...state.update, restartRequired: true }));
      }
    } finally {
      active = undefined;
      if (!disposed) {
        update({ busy: null });
        // Acceptance, native failures and response loss are reconciled by local reads only, never mutation replay.
        await refreshUpdate();
      }
    }
    return accepted;
  }
  function confirmUpdate(intent) {
    if (disposed || !intent || intent !== state.updateIntent || !deriveView(state).canUpdate || !matchesUpdate(intent, state.update)) return Promise.resolve(false);
    return updateMutation('installupdate', intent);
  }
  function cancelUpdate() {
    if (disposed || !deriveView(state).canCancelUpdate) return Promise.resolve(false);
    return updateMutation('cancelupdate', { requestId: state.updatePendingId });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    refreshIfWatching() { return watchers > 0 ? refresh() : Promise.resolve(false); },
    watch() {
      if (disposed) return () => {};
      ++watchers;
      if (watchers === 1) void refresh();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (--watchers === 0) {
          clearPoll(); clearExpiry(); invalidateRefresh();
          update({ refreshing: false, loading: !state.status, updateIntent: null });
        }
      };
    },
    checkUpdate, prepareUpdate, confirmUpdate, cancelUpdate, refreshUpdate,
    cancelUpdateIntent() { update({ updateIntent: null }); },
    async login(input) {
      if (!guardAction('login')) return false;
      try { return await mutate('login', validateLogin(input)); }
      catch (error) { return report(error); }
    },
    changePassword(binding, input) {
      if (!guardAction('password')) return Promise.resolve(false);
      if (state.passwordUncertain) return Promise.resolve(report(new SettingsClientError('PASSWORD_CHANGE_UNCERTAIN')));
      try { return mutate('password', validatePasswordChange(state.status, binding, input)); }
      catch (error) { return Promise.resolve(report(error)); }
    },
    cancelPasswordChange() {
      if (state.busy === 'password') active?.abort();
    },
    logout: () => mutate('logout', {}),
    dispose() {
      disposed = true;
      clearPoll(); clearExpiry(); invalidateRefresh(); active?.abort(); listeners.clear();
      state = freeze({ ...state, busy: null, refreshing: false });
    },
  };
}
