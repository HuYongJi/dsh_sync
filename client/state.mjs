// Framework-free personal-sync state. Only the DSH Connection may carry requests.
export const RPC_CHANNEL = '/api';
export const RPC_PREFIX = 'dsh-personal-sync/';
export const CLIENT_ACTIONS = Object.freeze(['status', 'login', 'password', 'preferences', 'sync', 'logout']);

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
  PROJECT_NOT_SELECTED: '请先保存项目选择',
  PROJECTS_UNAVAILABLE: '项目列表不可用',
  PROTECTED_QUEUE: '受保护队列已保留，不会上传',
  SETTINGS_CORRUPT: '同步设置损坏',
  SETTINGS_FAILED: '同步设置保存失败',
  SERVER_UNREACHABLE: '无法连接同步服务器',
  DISPOSED: '插件已停用，请刷新',
  REQUEST_TOO_LARGE: '请求过大',
  UNSUPPORTED_MEDIA_TYPE: '请求格式不兼容',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  PROJECT_UNAVAILABLE: '项目不可用',
  UNKNOWN_PROJECT: '项目已变更，请刷新',
  NO_PROJECTS: '请先选择并保存可用项目',
  UNSAVED_CHANGES: '请先保存或撤销更改',
  TIMEOUT: '请求超时，请刷新状态',
  REQUEST_FAILED: '请求失败，请刷新状态',
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
export function validateLogin({ server, username, password } = {}) {
  const origin = normalizeServer(server);
  const account = typeof username === 'string' ? username.trim() : '';
  if (!text(account, 128, false) || utf8Length(account) > 128) fail('BAD_USERNAME');
  if (typeof password !== 'string' || password.length === 0 || utf8Length(password) > 1024) fail('BAD_PASSWORD');
  return { server: origin, username: account, password };
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

/** Allowlist the public contract. Extra fields (including credentials) are discarded. */
export function parseStatus(value) {
  if (!isRecord(value) || !integer(value.revision) || typeof value.loggedIn !== 'boolean' || typeof value.running !== 'boolean' || !integer(value.pending) || !integer(value.intervalMs) || value.intervalMs < 1 || (value.autoSync !== undefined && typeof value.autoSync !== 'boolean') || !Array.isArray(value.projects) || value.projects.length > 20000) fail('INVALID_RESPONSE');
  const server = value.server ?? '';
  const username = value.username ?? '';
  if (!text(server, 2048) || !text(username, 128)) fail('INVALID_RESPONSE');
  if (server) { try { normalizeServer(server); } catch { fail('INVALID_RESPONSE'); } }
  const ids = new Set();
  const projects = value.projects.map(project => {
    if (!isRecord(project) || !text(project.id, 4096, false) || !text(project.label, 1024, false) || !text(project.root, 4096, false) || typeof project.selected !== 'boolean' || typeof project.available !== 'boolean' || ids.has(project.id)) fail('INVALID_RESPONSE');
    ids.add(project.id);
    const projectId = optionalText(project.projectId, 4096);
    const warning = optionalText(project.warning);
    return freeze({ id: project.id, label: project.label, root: project.root, selected: project.selected, available: project.available,
      ...(projectId === undefined ? {} : { projectId }), ...(warning === undefined ? {} : { warning }) });
  });
  const expiresAt = optionalDate(value.expiresAt);
  const warning = optionalText(value.warning);
  let lastResult;
  if (value.lastResult !== undefined && value.lastResult !== null) {
    const result = value.lastResult;
    if (!isRecord(result) || typeof result.ok !== 'boolean' || !text(result.message, 2048)) fail('INVALID_RESPONSE');
    const at = optionalDate(result.at);
    if (!at) fail('INVALID_RESPONSE');
    lastResult = freeze({ at, ok: result.ok, message: result.message });
  }
  return freeze({ revision: value.revision, server, username, loggedIn: value.loggedIn, autoSync: value.autoSync === true,
    intervalMs: value.intervalMs, projects: freeze(projects), pending: value.pending, running: value.running,
    ...(expiresAt === undefined ? {} : { expiresAt }), ...(warning === undefined ? {} : { warning }),
    ...(lastResult === undefined ? {} : { lastResult }) });
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

function newDraft(status) {
  return freeze({ revision: status?.revision ?? 0, autoSync: status?.autoSync ?? false,
    projectIds: freeze(status ? status.projects.filter(project => project.selected).map(project => project.id) : []) });
}
function isDirty(status, draft) {
  if (!status) return false;
  const selected = status.projects.filter(project => project.selected).map(project => project.id);
  return status.autoSync !== draft.autoSync || selected.length !== draft.projectIds.length || selected.some(id => !draft.projectIds.includes(id));
}

/** IDs are opaque: only membership in the latest Host list permits submission. */
export function validatePreferences(status, draft) {
  if (!status || !isRecord(draft) || !integer(draft.revision) || typeof draft.autoSync !== 'boolean' || !Array.isArray(draft.projectIds)) fail('BAD_REQUEST');
  if (draft.revision !== status.revision) fail('CONFIG_CONFLICT');
  const byId = new Map(status.projects.map(project => [project.id, project]));
  const ids = new Set();
  for (const id of draft.projectIds) {
    const project = byId.get(id);
    if (!project || ids.has(id)) fail('UNKNOWN_PROJECT');
    if (!project.available && !project.selected) fail('PROJECT_UNAVAILABLE');
    ids.add(id);
  }
  if (draft.autoSync && !status.loggedIn && !status.autoSync) fail('NOT_LOGGED_IN');
  return { revision: draft.revision, autoSync: draft.autoSync, projectIds: [...ids] };
}

export function filterProjects(projects, search = '') {
  const query = String(search).trim().toLocaleLowerCase();
  return query ? projects.filter(project => `${project.label}\n${project.root}`.toLocaleLowerCase().includes(query)) : projects;
}

export function deriveView(state) {
  const status = state.status;
  const locked = !state.ready || state.loading || state.refreshing || Boolean(state.busy);
  // Preferences/logout are safety controls: Host aborts and joins active work before committing them.
  const editable = !locked && !state.conflict;
  const selectedAvailable = status?.projects.filter(project => project.selected && project.available).length ?? 0;
  return freeze({ locked, editable, canLogin: !locked && !status?.running, canLogout: !locked && Boolean(status?.loggedIn),
    canChangePassword: !locked && !state.passwordUncertain && Boolean(status?.server && status?.username),
    canSave: editable && state.dirty, canSync: !locked && Boolean(status?.loggedIn) && !status?.running && !state.scheduled && !state.dirty && !state.conflict && selectedAvailable > 0,
    selectedAvailable, selectedCount: state.draft.projectIds.length });
}

/** A subscribable, immutable state store; it never owns or persists a password. */
export function createController(connection, options = {}) {
  const request = createConnectionTransport(connection);
  const setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const pollMs = Math.max(1000, options.pollMs ?? 3000);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 60000);
  let state = freeze({ status: null, draft: newDraft(), dirty: false, conflict: false, loading: true, refreshing: false,
    ready: false, busy: null, error: null, notice: '', scheduled: false, passwordUncertain: false });
  const listeners = new Set();
  let disposed = false;
  let watchers = 0;
  let pollTimer;
  let active;
  let refreshAbort;
  let generation = 0;
  let scheduledChecks = 0;
  let scheduledBaseline;
  let observedWork = false;
  const update = patch => {
    if (disposed) return;
    state = freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const clearPoll = () => { if (pollTimer !== undefined) clearTimer(pollTimer); pollTimer = undefined; };
  const invalidateRefresh = () => { ++generation; refreshAbort?.abort(); refreshAbort = undefined; };
  function queuePoll() {
    clearPoll();
    if (disposed || !watchers || state.busy || state.refreshing || state.error || !state.status?.loggedIn || !(state.status.running || state.status.pending || state.scheduled)) return;
    const delay = state.status.running || state.scheduled ? pollMs : Math.max(10000, pollMs);
    pollTimer = setTimer(() => { pollTimer = undefined; void refresh(); }, delay);
  }
  function acceptStatus(status, resetDraft = false) {
    // A late/stale status must not revive tokens after an uncertain password write.
    if (state.passwordUncertain) status = freeze({ ...status, loggedIn: false, autoSync: false });
    let draft = state.draft;
    let conflict = state.conflict;
    if (!state.status || resetDraft || !state.dirty) {
      draft = newDraft(status);
      conflict = false;
    } else {
      if (draft.revision !== status.revision) conflict = true;
      const permitted = new Set(status.projects.filter(project => project.available || project.selected).map(project => project.id));
      draft = freeze({ ...draft, projectIds: freeze(draft.projectIds.filter(id => permitted.has(id))) });
    }
    if (state.passwordUncertain && draft.autoSync) draft = freeze({ ...draft, autoSync: false });
    let scheduled = state.scheduled;
    if (scheduled) {
      // Pending checkpoints can remain offline or deselected; they are not an active job.
      observedWork ||= status.running;
      ++scheduledChecks;
      if (!status.loggedIn || status.lastResult?.at !== scheduledBaseline || (observedWork && !status.running) || scheduledChecks >= 10) scheduled = false;
    }
    update({ status, draft, dirty: isDirty(status, draft), conflict, ready: true, loading: false, scheduled,
      error: conflict ? publicError(new SettingsClientError('CONFIG_CONFLICT')) : null });
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
  async function refresh({ discardDraft = state.conflict } = {}) {
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
      acceptStatus(parseStatus(result), discardDraft);
      return true;
    } catch (error) {
      if (!disposed && current === generation) update({ error: publicError(error), ready: false, loading: false });
      return false;
    } finally {
      if (!disposed && current === generation) { refreshAbort = undefined; update({ refreshing: false }); queuePoll(); }
    }
  }
  function editDraft(patch) {
    const draft = freeze({ ...state.draft, ...patch });
    update({ draft, dirty: isDirty(state.status, draft), notice: '', error: null });
  }
  function report(error) { update({ error: publicError(error), notice: '' }); return false; }
  function guardAction(action) {
    if (disposed || !state.ready || state.busy || state.loading || state.refreshing) return false;
    if (state.status.running && (action === 'login' || action === 'sync')) return report(new SettingsClientError('BUSY'));
    if (action === 'sync' && !state.status.loggedIn) return report(new SettingsClientError('NOT_LOGGED_IN'));
    return true;
  }
  function markPasswordUncertain() {
    const status = state.status && freeze({ ...state.status, loggedIn: false, autoSync: false });
    const draft = freeze({ ...state.draft, autoSync: false });
    update({ status, draft, dirty: isDirty(status, draft), passwordUncertain: true, scheduled: false, ready: false, notice: '' });
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
    if (!disposed) update({ error: notice, conflict: safe.code === 'CONFIG_CONFLICT' || state.conflict });
  }
  async function mutate(action, body) {
    if (!guardAction(action)) return false;
    invalidateRefresh();
    clearPoll();
    const abort = new AbortController();
    active = abort;
    update({ busy: action, error: null, notice: '' });
    let succeeded = false;
    try {
      const result = await withDeadline(action, body, abort);
      if (disposed) return false;
      if (abort.signal.aborted) fail('REQUEST_FAILED');
      if (action === 'sync' && result?.scheduled === true) {
        scheduledChecks = 0;
        observedWork = false;
        scheduledBaseline = state.status?.lastResult?.at;
        update({ scheduled: true, notice: '同步请求已提交' });
      } else {
        const next = parseStatus(result);
        if (action === 'password' && (next.loggedIn || next.autoSync)) fail('INVALID_RESPONSE');
        const resetDraft = ['preferences', 'logout', 'password'].includes(action) || (action === 'login' && state.passwordUncertain);
        if (action === 'login' || action === 'password') update({ passwordUncertain: false });
        acceptStatus(next, resetDraft);
        if (['preferences', 'logout', 'password'].includes(action)) update({ scheduled: false });
        update({ notice: action === 'login' ? '已登录'
          : action === 'password' ? '密码已修改，请重新登录'
            : action === 'logout' ? '已退出登录'
              : action === 'preferences' ? '已保存' : '状态已更新' });
      }
      succeeded = true;
      return true;
    } catch (error) {
      if (!disposed && action === 'password') await reconcilePasswordFailure(error);
      else if (!disposed && (!abort.signal.aborted || (error instanceof SettingsClientError && error.code === 'TIMEOUT'))) {
        const safe = publicError(error);
        update({ error: safe, conflict: safe.code === 'CONFIG_CONFLICT' || state.conflict,
          ready: !['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_DEPLOYED', 'CONNECTION_UNAVAILABLE', 'INVALID_RESPONSE', 'TIMEOUT'].includes(safe.code) });
      }
      return false;
    } finally {
      active = undefined;
      if (!disposed) {
        update({ busy: null });
        if (action === 'sync' && succeeded) await refresh();
        else queuePoll();
      }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    refreshIfWatching() { if (watchers > 0) return refresh({ discardDraft: false }); return Promise.resolve(false); },
    watch() {
      if (disposed) return () => {};
      ++watchers;
      if (watchers === 1) void refresh();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (--watchers === 0) {
          clearPoll();
          invalidateRefresh();
          update({ refreshing: false, loading: !state.status });
        }
      };
    },
    setProject(id, selected) {
      if (!deriveView(state).editable || typeof selected !== 'boolean') return false;
      const project = state.status.projects.find(item => item.id === id);
      if (!project) return report(new SettingsClientError('UNKNOWN_PROJECT'));
      const ids = new Set(state.draft.projectIds);
      if (selected && !project.available && !ids.has(id)) return report(new SettingsClientError('PROJECT_UNAVAILABLE'));
      if (selected) ids.add(id); else ids.delete(id);
      editDraft({ projectIds: freeze([...ids]) });
      return true;
    },
    selectVisible(search, selected) {
      if (!deriveView(state).editable || typeof selected !== 'boolean') return false;
      const ids = new Set(state.draft.projectIds);
      for (const project of filterProjects(state.status.projects, search)) {
        if (selected && project.available) ids.add(project.id);
        if (!selected) ids.delete(project.id);
      }
      editDraft({ projectIds: freeze([...ids]) });
      return true;
    },
    setAutoSync(enabled) {
      if (!deriveView(state).editable || typeof enabled !== 'boolean') return false;
      if (enabled && !state.status.loggedIn && !state.draft.autoSync) return report(new SettingsClientError('NOT_LOGGED_IN'));
      editDraft({ autoSync: enabled });
      return true;
    },
    discardChanges() {
      if (!deriveView(state).editable) return false;
      update({ draft: newDraft(state.status), dirty: false, error: null, notice: '' });
      return true;
    },
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
    async savePreferences() {
      if (!guardAction('preferences')) return false;
      if (state.conflict) return report(new SettingsClientError('CONFIG_CONFLICT'));
      try { return await mutate('preferences', validatePreferences(state.status, state.draft)); }
      catch (error) { return report(error); }
    },
    async sync(projectId) {
      if (!guardAction('sync')) return false;
      if (state.conflict) return report(new SettingsClientError('CONFIG_CONFLICT'));
      if (state.dirty) return report(new SettingsClientError('UNSAVED_CHANGES'));
      if (state.scheduled) return report(new SettingsClientError('BUSY'));
      const selected = state.status.projects.filter(project => project.selected && project.available);
      if (!selected.length) return report(new SettingsClientError('NO_PROJECTS'));
      if (projectId !== undefined && !selected.some(project => project.id === projectId)) return report(new SettingsClientError('UNKNOWN_PROJECT'));
      return mutate('sync', projectId === undefined ? {} : { projectId });
    },
    logout: () => mutate('logout', {}),
    dispose() {
      disposed = true;
      clearPoll();
      invalidateRefresh();
      active?.abort();
      listeners.clear();
      state = freeze({ ...state, busy: null, refreshing: false });
    },
  };
}
