// Framework-free personal-sync state. Only the DSH Connection may carry requests.
export const RPC_CHANNEL = '/api';
export const RPC_PREFIX = 'dsh-personal-sync/';
export const CLIENT_ACTIONS = Object.freeze(['status', 'login', 'password', 'preferences', 'sync', 'logout', 'projects', 'checkpoints', 'restore', 'import', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']);

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
  CLOUD_BROWSE_UNSUPPORTED: '云端不支持项目浏览，请手动输入项目 ID',
  BAD_DESTINATION: '请输入 DSH Host 机器上的绝对路径',
  DESTINATION_EXISTS: '目标目录已存在，请选择全新目录',
  PROTECTED_DESTINATION: '目标目录受保护，不能下载到此处',
  CHECKPOINT_MISMATCH: '检查点与项目不匹配，请重新选择',
  RESTORE_FAILED: '下载未完成，目标目录可能不完整，请检查后使用新目录',
  IMPORT_FAILED: '导入未全部完成，请检查结果，勿重复导入',
  RECOVERY_UNAVAILABLE: '恢复功能或安全会话导入不可用',
  RECOVERY_LIMIT: '恢复记录达到限制，请检查已有结果',
  RECOVERY_UNCERTAIN: '请求结果未确认，请刷新状态；勿重复下载或导入',
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

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value.toLowerCase());
const validRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const absolutePath = value => text(value, 4096, false) && (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value));
const sameBinding = (a, b) => Boolean(a && b && a.revision === b.revision && a.server === b.server && a.username === b.username);
const bindingOf = status => freeze({ revision: status.revision, server: status.server, username: status.username });
function validateBinding(status, binding) {
  if (!status?.loggedIn || !status.server || !status.username) fail('NOT_LOGGED_IN');
  if (!binding || binding.server !== status.server || binding.username !== status.username) fail('ACCOUNT_MISMATCH');
  if (!integer(binding.revision) || binding.revision !== status.revision) fail('CONFIG_CONFLICT');
  return bindingOf(status);
}
function requiredDate(value) {
  if (typeof value !== 'string' || optionalDate(value) !== value || new Date(value).toISOString() !== value) fail('INVALID_RESPONSE');
  return value;
}

/** New remote surfaces retain no names, manifests, credentials or arbitrary error text. */
export function parseCloudProjects(value) {
  if (!isRecord(value) || !Array.isArray(value.projects) || value.projects.length > 20000) fail('INVALID_RESPONSE');
  const ids = new Set();
  return freeze(value.projects.map(item => {
    if (!isRecord(item) || !validId(item.projectId) || ids.has(item.projectId) || !integer(item.checkpointCount)) fail('INVALID_RESPONSE');
    ids.add(item.projectId);
    const latestCreatedAt = item.latestCreatedAt === null && item.checkpointCount === 0 ? null : requiredDate(item.latestCreatedAt);
    return freeze({ projectId: item.projectId, checkpointCount: item.checkpointCount, latestCreatedAt });
  }));
}
export function parseCheckpoints(value, projectId) {
  if (!validId(projectId) || !isRecord(value) || !Array.isArray(value.checkpoints) || value.checkpoints.length > 20000 || !Array.isArray(value.heads)) fail('INVALID_RESPONSE');
  const ids = new Set();
  const checkpoints = value.checkpoints.map(item => {
    if (!isRecord(item) || !validId(item.id) || ids.has(item.id) || item.projectId !== projectId || !validId(item.deviceId) || !(item.parentId === null || validId(item.parentId)) || item.parentId === item.id || !integer(item.fileCount) || !integer(item.totalBytes)) fail('INVALID_RESPONSE');
    ids.add(item.id);
    return freeze({ id: item.id, projectId, deviceId: item.deviceId, parentId: item.parentId, createdAt: requiredDate(item.createdAt), fileCount: item.fileCount, totalBytes: item.totalBytes });
  });
  if (value.heads.some(id => !validId(id) || !ids.has(id)) || new Set(value.heads).size !== value.heads.length) fail('INVALID_RESPONSE');
  return freeze({ checkpoints: freeze(checkpoints), heads: freeze([...value.heads]) });
}
export function parseRecovery(value) {
  if (!isRecord(value) || !validId(value.id) || !['restore', 'import'].includes(value.kind) || !['running', 'succeeded', 'failed'].includes(value.state) || !absolutePath(value.root)) fail('INVALID_RESPONSE');
  const result = { id: value.id, kind: value.kind, state: value.state, root: value.root };
  if (value.checkpointId !== undefined) { if (!validId(value.checkpointId)) fail('INVALID_RESPONSE'); result.checkpointId = value.checkpointId; }
  for (const key of ['sessionCount', 'importedCount', 'skippedCount', 'failedCount']) {
    if (value[key] !== undefined) { if (!integer(value[key])) fail('INVALID_RESPONSE'); result[key] = value[key]; }
  }
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== 'string' || !Object.hasOwn(MESSAGES, value.errorCode)) fail('INVALID_RESPONSE');
    result.errorCode = value.errorCode;
  }
  if (value.sessions !== undefined) {
    if (!Array.isArray(value.sessions) || value.sessions.length > 20000) fail('INVALID_RESPONSE');
    const sources = new Set();
    result.sessions = freeze(value.sessions.map(item => {
      if (!isRecord(item) || !validId(item.sourceId) || sources.has(item.sourceId) || !['imported', 'skipped', 'failed'].includes(item.outcome) || (item.sessionId !== undefined && !validId(item.sessionId)) || (item.workspaceAttached !== undefined && typeof item.workspaceAttached !== 'boolean')) fail('INVALID_RESPONSE');
      sources.add(item.sourceId);
      return freeze({ sourceId: item.sourceId, outcome: item.outcome, ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }), ...(item.workspaceAttached === undefined ? {} : { workspaceAttached: item.workspaceAttached }) });
    }));
  }
  return freeze(result);
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

function newCloud() {
  return freeze({ binding: null, projects: freeze([]), projectId: '', checkpoints: freeze([]), heads: freeze([]), checkpointId: '', destination: '', loaded: false, browseUnsupported: false, error: null, intent: null });
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
    ...(lastResult === undefined ? {} : { lastResult }),
    ...(value.recovery === undefined ? {} : { recovery: parseRecovery(value.recovery) }),
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
  const recovering = status?.recovery?.state === 'running' || Boolean(state.recoveryPending);
  const updater = state.update ?? status?.update;
  // Host 'uncertain' with a known terminal request means installation settled, not that rollback occurred.
  const settledUncertain = updater?.state === 'uncertain' && updater.restartRequired === true && Boolean(updater.requestId) && !state.updatePendingId;
  const updaterBusy = updateRunning(updater) || Boolean(state.updatePendingId) || (state.updateUncertain === true && !settledUncertain);
  const restartRequired = updater?.restartRequired === true;
  const updateBlocked = updaterBusy || restartRequired || state.updateUncertain === true;
  const editable = !locked && !state.conflict && !recovering && !updateBlocked;
  const canBrowse = !locked && !status?.running && !recovering && !updateBlocked && Boolean(status?.loggedIn && status.server && status.username);
  const canRecover = canBrowse && !status.running && !recovering && !state.scheduled && !state.conflict && !state.dirty;
  const selectedAvailable = status?.projects.filter(project => project.selected && project.available).length ?? 0;
  return freeze({ locked, editable, recovering, canBrowse, canRecover, updaterBusy, restartRequired, updateBlocked,
    updateError: state.updateError?.message ?? (updater?.errorCode ? MESSAGES[updater.errorCode] : ''),
    canCheckUpdate: !locked && !updateBlocked && updater?.supported !== false && updater?.state !== 'checking',
    canUpdate: !locked && !updateBlocked && !state.updateError && !recovering && !status?.running && !state.scheduled && !state.dirty && !state.conflict && updater?.supported === true && updater.state === 'available' && Boolean(updater.candidate),
    // A local read must not hide cancellation; cancellation invalidates the read before writing.
    canCancelUpdate: !state.busy && updateRunning(updater) && updater.state !== 'cancelling' && updater.errorCode !== 'UPDATE_CANCEL_TOO_LATE' && state.updateError?.code !== 'UPDATE_CANCEL_TOO_LATE' && Boolean(state.updatePendingId && state.updatePendingId === updater.requestId),
    canRestore: canRecover && Boolean(state.cloud?.checkpointId && absolutePath(state.cloud.destination)),
    canImport: canRecover && status?.recovery?.kind === 'restore' && status.recovery.state === 'succeeded' && status.recovery.sessionCount !== 0,
    recoveryError: status?.recovery?.errorCode ? MESSAGES[status.recovery.errorCode] : '',
    canLogin: !locked && !status?.running && !recovering && !updateBlocked, canLogout: !locked && !updaterBusy && Boolean(status?.loggedIn),
    canChangePassword: !locked && !recovering && !updateBlocked && !state.passwordUncertain && Boolean(status?.server && status?.username),
    canSave: editable && state.dirty, canSync: !locked && !recovering && !updateBlocked && Boolean(status?.loggedIn) && !status?.running && !state.scheduled && !state.dirty && !state.conflict && selectedAvailable > 0,
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
    ready: false, busy: null, error: null, notice: '', scheduled: false, passwordUncertain: false,
    cloud: newCloud(), recoveryPending: null, recoveryUncertain: false,
    update: null, updateIntent: null, updatePendingId: null, updateUncertain: false, updateError: null });
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
  let uncertainChecks = 0;
  let updateUncertainChecks = 0;
  const update = patch => {
    if (disposed) return;
    state = freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const clearPoll = () => { if (pollTimer !== undefined) clearTimer(pollTimer); pollTimer = undefined; };
  const invalidateRefresh = () => { ++generation; refreshAbort?.abort(); refreshAbort = undefined; };
  function queuePoll() {
    clearPoll();
    if (disposed || !watchers || state.busy || state.refreshing) return;
    if (state.updateUncertain && updateUncertainChecks >= 10) return; // Manual read only after bounded reconciliation.
    if (updateRunning(state.update) || state.update?.state === 'checking' || state.updateUncertain || state.updatePendingId) {
      pollTimer = setTimer(() => { pollTimer = undefined; void refreshUpdate(); }, pollMs);
      return;
    }
    const recoveryWork = (state.recoveryPending && (!state.recoveryUncertain || uncertainChecks < 10)) || state.status?.recovery?.state === 'running';
    if (disposed || !watchers || state.busy || state.refreshing || (!recoveryWork && (state.error || !state.status?.loggedIn)) || !(recoveryWork || state.status?.running || state.status?.pending || state.scheduled)) return;
    const delay = recoveryWork || state.status.running || state.scheduled ? pollMs : Math.max(10000, pollMs);
    pollTimer = setTimer(() => { pollTimer = undefined; void refresh(); }, delay);
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
    const changed = state.status && (!sameBinding(status, state.status) || status.loggedIn !== state.status.loggedIn);
    let recoveryPending = changed ? null : state.recoveryPending;
    let recoveryUncertain = changed ? false : state.recoveryUncertain;
    if (recoveryPending && status.recovery?.id === recoveryPending.requestId) {
      if (status.recovery.kind !== recoveryPending.kind || (recoveryPending.kind === 'restore' && status.recovery.checkpointId !== undefined && status.recovery.checkpointId !== recoveryPending.checkpointId)) fail('INVALID_RESPONSE');
      recoveryUncertain = false;
      if (status.recovery.state !== 'running') recoveryPending = null;
    }
    let cloud = changed ? newCloud() : state.cloud;
    if (!recoveryUncertain && cloud.error?.code === 'RECOVERY_UNCERTAIN') cloud = freeze({ ...cloud, error: null });
    if (cloud.intent?.kind === 'import' && (status.recovery?.id !== cloud.intent.restoreId || status.recovery?.kind !== 'restore' || status.recovery?.state !== 'succeeded' || status.recovery?.root !== cloud.intent.root)) cloud = freeze({ ...cloud, intent: null });
    const updater = status.update ? updatePatch(status.update) : {};
    const latestUpdate = updater.update ?? state.update;
    if (latestUpdate) status = freeze({ ...status, update: latestUpdate });
    update({ status, draft, dirty: isDirty(status, draft), conflict, ready: true, loading: false, scheduled,
      cloud, recoveryPending, recoveryUncertain, ...updater,
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
    if (state.recoveryUncertain) ++uncertainChecks;
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
    const view = deriveView(state);
    if (view.updaterBusy) return report(new SettingsClientError('BUSY'));
    if (view.restartRequired && action !== 'logout') return report(new SettingsClientError('UPDATE_RESTART_REQUIRED'));
    if ((state.status.recovery?.state === 'running' || state.recoveryPending) && ['login', 'password', 'preferences', 'sync'].includes(action)) return report(new SettingsClientError('BUSY'));
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
  const cloudUpdate = patch => update({ cloud: freeze({ ...state.cloud, ...patch }) });
  const cloudReport = error => { cloudUpdate({ error: publicError(error), intent: null }); return false; };
  function cloudEditable() { return deriveView(state).canBrowse && !state.recoveryPending; }
  async function browse(action) {
    if (!deriveView(state).canBrowse) return false;
    let binding, projectId;
    try {
      binding = validateBinding(state.status, bindingOf(state.status));
      projectId = state.cloud.projectId;
      if (action === 'checkpoints' && !validId(projectId)) fail('BAD_REQUEST');
    } catch (error) { return cloudReport(error); }
    invalidateRefresh(); clearPoll();
    const abort = new AbortController(); active = abort;
    if (action === 'projects') update({ cloud: freeze({ ...newCloud(), binding }) });
    else cloudUpdate({ binding, checkpoints: freeze([]), heads: freeze([]), checkpointId: '', loaded: false, intent: null, error: null });
    update({ busy: action });
    let needsStatus = false;
    try {
      const result = await withDeadline(action, action === 'projects' ? binding : { ...binding, projectId }, abort);
      if (disposed || !sameBinding(state.status, binding)) return false;
      if (action === 'projects') cloudUpdate({ projects: parseCloudProjects(result) });
      else cloudUpdate({ ...parseCheckpoints(result, projectId), loaded: true });
      return true;
    } catch (error) {
      if (!disposed) {
        const safe = publicError(error);
        if (['ACCOUNT_MISMATCH', 'CONFIG_CONFLICT', 'NOT_LOGGED_IN'].includes(safe.code)) {
          update({ cloud: newCloud() }); needsStatus = true;
        }
        cloudUpdate({ error: safe, browseUnsupported: action === 'projects' && safe.code === 'CLOUD_BROWSE_UNSUPPORTED' });
      }
      return false;
    } finally {
      active = undefined;
      if (!disposed) { update({ busy: null }); if (needsStatus) await refresh(); else queuePoll(); }
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
  function prepareRecovery(kind) {
    if (!deriveView(state).canRecover) return null;
    try {
      const binding = validateBinding(state.status, kind === 'restore' ? state.cloud.binding : bindingOf(state.status));
      let fields;
      if (kind === 'restore') {
        const cloud = state.cloud;
        if (!cloud.checkpoints.some(item => item.id === cloud.checkpointId && item.projectId === cloud.projectId)) fail('CHECKPOINT_MISMATCH');
        if (!absolutePath(cloud.destination)) fail('BAD_DESTINATION');
        fields = { projectId: cloud.projectId, checkpointId: cloud.checkpointId, destination: cloud.destination };
      } else {
        if (!deriveView(state).canImport) fail('RECOVERY_UNAVAILABLE');
        fields = { restoreId: state.status.recovery.id, root: state.status.recovery.root };
      }
      const prior = state.cloud.intent;
      // Opening the same confirmation twice does not create a new request identity.
      if (prior?.kind === kind && sameBinding(prior, binding) && Object.entries(fields).every(([key, value]) => prior[key] === value)) return prior;
      const intent = freeze({ kind, ...binding, ...fields, requestId: requestId() });
      cloudUpdate({ intent, error: null });
      return intent;
    } catch (error) { cloudReport(error); return null; }
  }
  async function confirmRecovery(intent) {
    if (!intent || intent !== state.cloud.intent || !deriveView(state).canRecover) return false;
    let payload;
    try {
      const binding = validateBinding(state.status, intent);
      if (!validRequestId(intent.requestId)) fail('BAD_REQUEST_ID');
      if (intent.kind === 'restore') {
        if (intent.projectId !== state.cloud.projectId || intent.checkpointId !== state.cloud.checkpointId || intent.destination !== state.cloud.destination || !state.cloud.checkpoints.some(item => item.id === intent.checkpointId)) fail('CHECKPOINT_MISMATCH');
        payload = { ...binding, projectId: intent.projectId, checkpointId: intent.checkpointId, destination: intent.destination, confirm: true, requestId: intent.requestId };
      } else {
        if (!deriveView(state).canImport || intent.restoreId !== state.status.recovery.id || intent.root !== state.status.recovery.root) fail('RECOVERY_UNAVAILABLE');
        payload = { ...binding, restoreId: intent.restoreId, confirm: true, requestId: intent.requestId };
      }
    } catch (error) { return cloudReport(error); }
    invalidateRefresh(); clearPoll();
    const abort = new AbortController(); active = abort;
    cloudUpdate({ intent: null, error: null });
    uncertainChecks = 0;
    update({ busy: intent.kind, recoveryPending: intent, recoveryUncertain: false, error: null, notice: '' });
    let accepted = false;
    try {
      const result = await withDeadline(intent.kind, payload, abort);
      if (disposed) return false;
      const recovery = parseRecovery(result?.recovery);
      if (recovery.id !== intent.requestId || recovery.kind !== intent.kind || (recovery.checkpointId !== undefined && intent.kind === 'restore' && recovery.checkpointId !== intent.checkpointId)) fail('INVALID_RESPONSE');
      update({ status: freeze({ ...state.status, recovery, running: recovery.state === 'running' }),
        recoveryPending: recovery.state === 'running' ? intent : null });
      accepted = true;
    } catch (error) {
      if (!disposed) {
        const safe = publicError(error);
        const rejected = ['BAD_REQUEST', 'BAD_DESTINATION', 'DESTINATION_EXISTS', 'PROTECTED_DESTINATION', 'CHECKPOINT_MISMATCH', 'RECOVERY_UNAVAILABLE', 'RECOVERY_LIMIT', 'CONFIG_CONFLICT', 'ACCOUNT_MISMATCH', 'NOT_LOGGED_IN', 'BUSY', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_DEPLOYED', 'RATE_LIMITED'].includes(safe.code);
        update({ recoveryPending: rejected ? null : intent, recoveryUncertain: !rejected });
        cloudUpdate({ error: rejected ? safe : publicError(new SettingsClientError('RECOVERY_UNCERTAIN')) });
        if (['CONFIG_CONFLICT', 'ACCOUNT_MISMATCH', 'NOT_LOGGED_IN'].includes(safe.code)) update({ cloud: newCloud() });
      }
    } finally {
      active = undefined;
      if (!disposed) {
        update({ busy: null });
        // Acceptance and transport failures are reconciled only by reads, never replayed.
        await refresh({ discardDraft: false });
        if (!state.recoveryUncertain && state.cloud.error?.code === 'RECOVERY_UNCERTAIN') cloudUpdate({ error: null });
      }
    }
    return accepted;
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
    checkUpdate, prepareUpdate, confirmUpdate, cancelUpdate, refreshUpdate,
    cancelUpdateIntent() { update({ updateIntent: null }); },
    browseProjects: () => browse('projects'),
    loadCheckpoints: () => browse('checkpoints'),
    setCloudProject(projectId) {
      if (!cloudEditable() || !text(projectId, 100)) return false;
      cloudUpdate({ binding: bindingOf(state.status), projectId, checkpoints: freeze([]), heads: freeze([]), checkpointId: '', loaded: false, intent: null, error: null });
      return true;
    },
    selectCheckpoint(id) {
      if (!cloudEditable() || (id !== '' && !state.cloud.checkpoints.some(item => item.id === id))) return false;
      cloudUpdate({ checkpointId: id, intent: null, error: null }); return true;
    },
    setDestination(destination) {
      if (!cloudEditable() || !text(destination, 4096)) return false;
      cloudUpdate({ destination, intent: null, error: null }); return true;
    },
    prepareRestore: () => prepareRecovery('restore'),
    prepareImport: () => prepareRecovery('import'),
    confirmRecovery,
    cancelRecoveryIntent() { cloudUpdate({ intent: null }); },
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
          update({ refreshing: false, loading: !state.status, updateIntent: null });
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
