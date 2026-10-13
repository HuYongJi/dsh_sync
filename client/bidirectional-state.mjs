// Framework-free v2 GUI state. The authenticated DSH Connection is the only carrier.
export const BIDIRECTIONAL_ACTIONS = Object.freeze(['syncstatus', 'syncprojects', 'syncclonepick', 'syncclonebrowse', 'synccloneselect', 'synccloneplan', 'syncclonecommit', 'syncpublishplan', 'syncpublishcommit', 'pairplan', 'paircommit', 'syncpause', 'syncrun', 'syncconflicts', 'syncresolveplan', 'syncresolve', 'syncrecycle', 'syncrestoreplan', 'syncrestore', 'syncarchives', 'syncarchiveplan', 'syncarchiveimport', 'syncrepairplan', 'syncrepair', 'syncsettings']);
const WRITE_ACTIONS = new Set(['syncclonecommit', 'syncpublishcommit', 'paircommit', 'syncrun', 'syncpause', 'syncresolve', 'syncrestore', 'syncarchiveimport', 'syncrepair', 'syncsettings']);
export const MAX_ONBOARDING_PROJECTS = 20;
const isOnboarding = kind => kind === 'clone' || kind === 'publish';
const onboardingKind = action => ({ syncclonecommit: 'clone', syncpublishcommit: 'publish' })[action];
export const STORAGE_GIB = 1024 ** 3;
export const MAX_STORAGE_GIB = 1024;
const REPAIR_CODES = new Set(['SYNC_LOCAL_CHANGED', 'SYNC_REPLAN_REQUIRED', 'SYNC_APPLY_INCOMPLETE', 'SYNC_REPAIR_INCOMPLETE']);
export function canRepairBinding(binding) { return Boolean(binding?.enabled && binding.repairable !== false && binding.state === 'blocked' && REPAIR_CODES.has(binding.errorCode)); }
const MESSAGES = Object.freeze({
  INVALID_RESPONSE: '状态格式不兼容，请升级插件', CONNECTION_UNAVAILABLE: 'DSH 连接不可用',
  NOT_DEPLOYED: '此宿主尚未启用双向同步', AUTH_REQUIRED: 'DSH 授权已失效', FORBIDDEN: '请求被拒绝', NOT_LOGGED_IN: '请先在账号卡片登录',
  CONFIG_CONFLICT: '状态已变更，请刷新并重新预览', ACCOUNT_MISMATCH: '服务器或账号已变更', BUSY: '正在处理其他操作，请稍后重试',
  SERVER_UNREACHABLE: '无法连接同步服务器', SERVER_UNAVAILABLE: '无法连接同步服务器', SERVICE_UNAVAILABLE: '同步服务不可用',
  BAD_REQUEST: '请求无效，请重新选择', BAD_REQUEST_ID: '无法生成安全请求 ID，请升级浏览器', RATE_LIMITED: '请求过于频繁，请稍后再试',
  TIMEOUT: '请求超时，请核对状态', REQUEST_FAILED: '请求失败，请刷新状态', DISPOSED: '页面已关闭，请重新打开',
  UPDATE_RESTART_REQUIRED: '插件已更新，请重启 DSH 后再同步', UPDATE_UNCERTAIN: '插件更新结果未确认，请先核对更新状态',
  SYNC_UPGRADE_REQUIRED: '请升级同步服务器后使用双向同步', SYNC_UNSUPPORTED: '请升级同步服务器后使用双向同步',
  SYNC_PLAN_EXPIRED: '预览已过期，请重新预览', SYNC_PLAN_STALE: '内容已变更，请重新预览', SYNC_PLAN_REQUIRED: '请先预览并确认',
  SYNC_REFRESH_REQUIRED: '请刷新列表后重新选择', SYNC_SELECTION_REQUIRED: '请选择本机工作区和云端项目',
  SYNC_PROJECT_UNAVAILABLE: '项目不可用，请检查工作区', SYNC_BINDING_NOT_FOUND: '配对已变更，请刷新',
  SYNC_BLOCKED: '存在受保护或不兼容的路径，请先处理阻止项', SYNC_CONFLICT: '项目存在冲突，请保留副本并核对',
  SYNC_CONFLICT_NOT_FOUND: '冲突已变更，请刷新列表', SYNC_RECYCLE_NOT_FOUND: '回收记录已变更，请刷新列表',
  SYNC_DESTINATION_EXISTS: '恢复位置已有内容，请重新预览', SYNC_LEGACY_HEAD_MISMATCH: '云端历史内容已变更，请重新预览',
  SYNC_HEAD_MISMATCH: '云端内容已变更，请重新预览', SYNC_LIMIT: '项目达到安全限制，请先检查内容',
  SYNC_UNCERTAIN: '结果未确认，仅核对状态；不要重复提交', SYNC_FAILED: '操作未完成，请核对项目状态',
  AUTH_RENEWAL_UNCERTAIN: '登录续期结果未确认，请重新登录',
  SYNC_PLAN_CHANGED: '项目或设置已变更，请重新预览', SYNC_MANAGED_PROJECT: '此项目已使用双向同步，请在双向同步中管理',
  SYNC_CLIENT_UPGRADE_REQUIRED: '请升级同步服务器和各端插件后开启双向同步', SYNC_MIGRATION_REQUIRED: '请先完成项目的双向同步连接',
  SYNC_ROOT_CHANGED: '项目目录已变更，已停止写入', SYNC_POLICY_CHANGED: '排除规则已变更，请重新核对',
  SYNC_LOCAL_CHANGED: '本机内容已变更，已保留双方内容', SYNC_QUOTA: '同步存储达到安全上限，请检查回收副本和队列',
  SYNC_INTEGRITY: '内容校验失败，未覆盖本机文件', SYNC_PROJECT_CORRUPT: '云端项目校验失败，请检查服务器存储',
  SYNC_METADATA_UNSAFE: '同步元数据路径不安全，已停止写入', SYNC_VOLUME_CHANGED: '项目包含不同磁盘的挂载点，已停止写入',
  SYNC_NOT_IDLE: '项目任务正在运行，等待空闲后应用更新', SYNC_BINDING_MISMATCH: '同步绑定已变更，请重新核对授权',
  SYNC_JOURNAL_CORRUPT: '同步事务记录损坏，已停止自动操作', SYNC_STRUCTURAL_CONFLICT: '文件与目录或大小写冲突，请先调整冲突路径',
  SYNC_UNTRACKED_DELETE: '无法证明删除来源，已保留本机文件', SYNC_REMOTE_BLOB_MISSING: '云端缺少已记录的内容，请检查存储',
  SYNC_APPLY_INCOMPLETE: '本机应用尚未完成，请核对任务结果', SYNC_CONFLICT_CHANGED: '冲突已变化，请重新选择',
  SYNC_CANCELLED: '操作已停止，已完成内容与回收副本保留', SYNC_REPLAN_REQUIRED: '中断的事务需要核对，未自动重复写入',
  SYNC_DESTINATION_UNAVAILABLE: '无法规划安全的新副本路径',
  SYNC_BATCH_LIMIT: '每次最多选择20个项目', SYNC_BATCH_SELECTION_REQUIRED: '请至少选择一个项目',
  SYNC_PICKER_UNAVAILABLE: '宿主目录选择不可用，请检查宿主权限后重试', SYNC_DESTINATION_REQUIRED: '请在宿主选择父目录',
  SYNC_DESTINATION_EXPIRED: '父目录选择已过期，请重新选择', SYNC_REGISTRATION_UNCERTAIN: '工作区注册结果未确认，仅核对状态，不要向同一目录重复提交',
  DIRECTORY_PICKER_UNAVAILABLE: '宿主目录选择不可用，请检查宿主权限后重试', DIRECTORY_PICKER_FAILED: '宿主目录读取失败，请重新选择父目录',
  DIRECTORY_PICKER_EXPIRED: '宿主目录选择已过期，请重新选择父目录', BAD_DESTINATION: '父目录位置不安全，请在宿主重新选择',
  DESTINATION_CHANGED: '父目录已变化，请重新选择并预览', DESTINATION_EXISTS: '目标位置已存在，请重新选择父目录并预览',
  CLOUD_PROJECT_EMPTY: '云端项目没有可同步的内容，请选择其他项目', PROJECT_REGISTRATION_UNCERTAIN: '工作区注册结果未确认，仅核对状态，不要向同一目录重复提交',
  PROTECTED_DESTINATION: '此目录受保护，请在宿主选择其他父目录', SYNC_CATALOG_CHANGED: '云端列表已变化，请刷新列表后重新选择',
  SYNC_ARCHIVES_UNSUPPORTED: '此宿主仅支持文件同步，会话归档暂不可用', SYNC_ARCHIVES_SKIPPED: '部分会话归档已延后，文件同步不受影响',
  SYNC_IMPORT_UNCERTAIN: '部分会话可能已写入，请核对新会话 ID，不要重复导入', SYNC_IMPORT_SKIPPED: '部分会话不支持安全导入，已跳过',
  SYNC_IMPORT_UNATTACHED: '会话已写入但未关联项目，请核对新会话 ID，不要重复导入',
  SYNC_REPAIR_INCOMPLETE: '上次核对尚未完成，请重新预览当前状态', SYNC_REPAIR_UNAVAILABLE: '没有需要核对的中断事务',
  SYNC_REPAIR_CHANGED: '文件或事务已变化，请重新预览', SYNC_REPAIR_EXPIRED: '核对预览已过期，请重新预览',
  SYNC_COMMIT_UNCERTAIN: '云端提交仍未确认，请先核对同步状态', SYNC_REQUEST_CONFLICT: '请求记录不一致，请重新预览',
  ACCOUNT_BOUND: '账号已绑定同步记录', PROJECT_UNAVAILABLE: '项目不可用', PROJECTS_UNAVAILABLE: '项目列表不可用', PROJECT_NOT_SELECTED: '项目未选择',
  SETTINGS_CORRUPT: '设置损坏，自动同步已停止', SETTINGS_FAILED: '设置保存失败', REQUEST_TOO_LARGE: '请求过大', UNSUPPORTED_MEDIA_TYPE: '请求格式无效',
});
const DEFINITE = new Set(['NOT_DEPLOYED', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_LOGGED_IN', 'CONFIG_CONFLICT', 'ACCOUNT_MISMATCH', 'BUSY', 'BAD_REQUEST', 'RATE_LIMITED', 'UPDATE_RESTART_REQUIRED', 'UPDATE_UNCERTAIN', 'SYNC_UPGRADE_REQUIRED', 'SYNC_UNSUPPORTED', 'SYNC_PLAN_EXPIRED', 'SYNC_PLAN_STALE', 'SYNC_PLAN_REQUIRED', 'SYNC_REFRESH_REQUIRED', 'SYNC_SELECTION_REQUIRED', 'SYNC_PROJECT_UNAVAILABLE', 'SYNC_BINDING_NOT_FOUND', 'SYNC_BLOCKED', 'SYNC_CONFLICT', 'SYNC_CONFLICT_NOT_FOUND', 'SYNC_RECYCLE_NOT_FOUND', 'SYNC_DESTINATION_EXISTS', 'SYNC_LEGACY_HEAD_MISMATCH', 'SYNC_HEAD_MISMATCH', 'SYNC_LIMIT']);
// These Host failures are pre-admission identity/plan/path/quota rejections.
// Integrity/transaction/apply/cancellation/renewal failures deliberately stay
// uncertain for writes: a mapped display code is NOT proof of no side effects.
for (const code of ['SYNC_PLAN_CHANGED', 'SYNC_MANAGED_PROJECT', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_MIGRATION_REQUIRED', 'SYNC_ROOT_CHANGED', 'SYNC_POLICY_CHANGED', 'SYNC_LOCAL_CHANGED', 'SYNC_QUOTA', 'SYNC_METADATA_UNSAFE', 'SYNC_VOLUME_CHANGED', 'SYNC_NOT_IDLE', 'SYNC_BINDING_MISMATCH', 'SYNC_STRUCTURAL_CONFLICT', 'SYNC_CONFLICT_CHANGED', 'SYNC_DESTINATION_UNAVAILABLE', 'ACCOUNT_BOUND', 'PROJECT_UNAVAILABLE', 'PROJECTS_UNAVAILABLE', 'PROJECT_NOT_SELECTED', 'REQUEST_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE']) DEFINITE.add(code);
DEFINITE.add('SYNC_ARCHIVES_UNSUPPORTED');
for (const code of ['DIRECTORY_PICKER_UNAVAILABLE', 'DIRECTORY_PICKER_FAILED', 'DIRECTORY_PICKER_EXPIRED', 'BAD_DESTINATION', 'DESTINATION_CHANGED', 'DESTINATION_EXISTS', 'CLOUD_PROJECT_EMPTY', 'PROTECTED_DESTINATION', 'SYNC_CATALOG_CHANGED']) DEFINITE.add(code);
const BINDING_STATES = ['idle', 'scanning', 'offline', 'uploading', 'applying', 'deferred', 'conflicted', 'blocked', 'uncertain', 'synced', 'paused', 'needs-login'];
const OP_STATES = ['running', 'succeeded', 'failed', 'uncertain'];
const OP_KINDS = ['pair', 'run', 'sync', 'resolve', 'restore', 'import', 'repair', 'paircommit', 'syncrun', 'syncresolve', 'syncrestore', 'syncarchiveimport', 'syncrepair'];
const freeze = Object.freeze;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, maximum = 4096, empty = false) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0) && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value.toLowerCase());
const opaque = value => text(value, 4096);
const absolute = value => text(value) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) && value.replaceAll('\\', '/').split('/').every(part => part !== '.' && part !== '..');
// Match v1 projectFolderMetadata's display contract, not local-root authority.
// Dot segments and POSIX backslash characters in historical hints are harmless text.
const sourceHint = value => text(value) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
const pathKey = value => /^[A-Za-z]:|^\\\\/.test(value) ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : value.replace(/\/+$/, '');
const relative = value => text(value, 1024) && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const accountEqual = (a, b) => Boolean(a && b && a.server === b.server && a.username === b.username);
const identityEqual = (a, b) => accountEqual(a, b) && a.revision === b.revision;
const identityOf = value => freeze({ revision: value.revision, server: value.server, username: value.username });
// A terminal onboarding result consumes the original intent even if an individual
// registration remains unknown. Preserve that readonly result, not a global lock
// on unrelated healthy projects. Missing receipts and active ambiguity still lock.
const terminalOnboarding = batch => ['succeeded', 'partial', 'failed', 'uncertain'].includes(batch.state) && batch.items.every(item => ['succeeded', 'failed', 'uncertain'].includes(item.state));
const uncertainOnboarding = batch => batch.state === 'uncertain' || batch.items.some(item => item.state === 'uncertain');
const hostUncertain = status => Boolean(status?.operations.some(item => item.state === 'uncertain') || status?.bindings.some(item => item.state === 'uncertain') || status?.onboarding.some(batch => !terminalOnboarding(batch) && uncertainOnboarding(batch)));
const operationKinds = { paircommit: ['pair', 'paircommit'], syncrun: ['run', 'sync', 'syncrun'], syncresolve: ['resolve', 'syncresolve'], syncrestore: ['restore', 'syncrestore'], syncarchiveimport: ['import', 'syncarchiveimport'], syncrepair: ['repair', 'syncrepair'] };
const errorCode = value => typeof value === 'string' && Object.hasOwn(MESSAGES, value) ? value : 'SYNC_FAILED';
export class BidirectionalClientError extends Error {
  constructor(code, definite = false) { const safe = Object.hasOwn(MESSAGES, code) ? code : 'SYNC_FAILED'; super(MESSAGES[safe]); this.name = 'BidirectionalClientError'; this.code = safe; this.definite = definite; }
}
const fail = code => { throw new BidirectionalClientError(code); };
const check = condition => { if (!condition) fail('INVALID_RESPONSE'); };
const publicError = error => freeze({ code: error instanceof BidirectionalClientError ? error.code : 'REQUEST_FAILED', message: error instanceof BidirectionalClientError ? error.message : MESSAGES.REQUEST_FAILED });
export const bidirectionalMessage = code => MESSAGES[errorCode(code)];
function origin(value) {
  if (value === '') return '';
  check(text(value, 2048) && !/[\s\\]/u.test(value));
  let url; try { url = new URL(value); } catch { fail('INVALID_RESPONSE'); }
  check((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
  return url.origin;
}
function rows(value, parser, limit = 20000) {
  check(Array.isArray(value) && value.length <= limit);
  const seen = new Set();
  return freeze(value.map(item => { check(record(item)); const result = parser(item), key = result.id ?? result.projectId; check(!seen.has(key)); seen.add(key); return freeze(result); }));
}
function count(value) { check(integer(value ?? 0)); return value ?? 0; }
function date(value) { if (value === undefined || value === null) return undefined; check(text(value, 64) && Number.isFinite(Date.parse(value))); return value; }
function optionalError(value) { return value === undefined || value === null ? {} : { errorCode: errorCode(value) }; }
function parseStorage(value) {
  check(record(value) && integer(value.limitBytes) && value.limitBytes > 0 && typeof value.verified === 'boolean' && (value.usedBytes === undefined || integer(value.usedBytes)));
  return freeze({ limitBytes: value.limitBytes, ...(value.usedBytes === undefined ? {} : { usedBytes: value.usedBytes }), verified: value.verified });
}
export function validateStorageLimit(quotaBytes) {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < STORAGE_GIB || quotaBytes > MAX_STORAGE_GIB * STORAGE_GIB || quotaBytes % STORAGE_GIB !== 0) fail('BAD_REQUEST');
  return quotaBytes;
}
function sessionIds(value) {
  check(Array.isArray(value) && value.length <= 20000 && value.every(id) && new Set(value).size === value.length);
  return freeze([...value]);
}
function importResult(value) {
  const result = {};
  for (const key of ['importedCount', 'skippedCount', 'failedCount']) if (value[key] !== undefined) { check(integer(value[key])); result[key] = value[key]; }
  if (value.sessionIds !== undefined) result.sessionIds = sessionIds(value.sessionIds);
  return result;
}

const BATCH_STATES = ['running', 'succeeded', 'partial', 'failed', 'uncertain'];
const ITEM_STATES = ['pending', 'running', 'succeeded', 'failed', 'uncertain'];
const BATCH_PHASES = ['pending', 'accepted', 'mkdir-started', 'root-owned', 'migration-committing', 'migration-complete', 'downloading', 'downloaded', 'registering', 'registered', 'publishing', 'paired', 'complete', 'interrupted'];
function safeRoot(value) {
  if (!absolute(value)) return false;
  const normalized = value.replaceAll('\\', '/'), windows = /^[A-Za-z]:|^\\\\/.test(value);
  if (windows && (/[<>"|?*]/u.test(value) || normalized.slice(/^[A-Za-z]:/.test(value) ? 2 : 0).includes(':'))) return false;
  return !windows || normalized.split('/').every(part => !part || !/[. ]$/.test(part));
}
function freshChild(parent, root) {
  if (!safeRoot(parent) || !safeRoot(root)) return false;
  const prefix = `${pathKey(parent)}/`, target = pathKey(root);
  return target.startsWith(prefix) && target.length > prefix.length && !target.slice(prefix.length).includes('/');
}
function expiry(value, now) {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  check(Number.isSafeInteger(result) && result > 0);
  if (result <= now()) fail('SYNC_PLAN_EXPIRED');
  return result;
}
function syncSummary(value) {
  check(record(value)); const result = {};
  for (const key of ['upload', 'download', 'delete', 'conflicts', 'blocked']) { check(integer(value[key])); result[key] = value[key]; }
  return freeze(result);
}
function batchSummary(value, items) {
  const result = syncSummary(value);
  for (const key of Object.keys(result)) check(result[key] === items.reduce((sum, item) => sum + item.summary[key], 0));
  return result;
}
function parseOnboarding(value) {
  return rows(value, batch => {
    check(id(batch.id) && isOnboarding(batch.kind) && BATCH_STATES.includes(batch.state) && date(batch.at));
    check(batch.parent === undefined || (batch.kind === 'clone' && safeRoot(batch.parent)));
    const items = rows(batch.items, item => {
      check(id(item.id) && text(item.label, 1024) && safeRoot(item.root) && ITEM_STATES.includes(item.state) && typeof item.phase === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.phase));
      check(item.projectId === undefined || id(item.projectId)); check(item.workspaceId === undefined || opaque(item.workspaceId)); check(item.bindingId === undefined || id(item.bindingId));
      if (batch.parent !== undefined) check(freshChild(batch.parent, item.root));
      return { id: item.id, label: item.label, root: item.root, state: item.state, phase: BATCH_PHASES.includes(item.phase) ? item.phase : 'unknown',
        ...(item.projectId === undefined ? {} : { projectId: item.projectId }), ...(item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }), ...(item.bindingId === undefined ? {} : { bindingId: item.bindingId }), ...optionalError(item.errorCode) };
    }, MAX_ONBOARDING_PROJECTS);
    check(items.length > 0 && new Set(items.map(item => pathKey(item.root))).size === items.length);
    if (batch.state === 'succeeded') check(items.every(item => item.state === 'succeeded'));
    if (['succeeded', 'partial', 'failed'].includes(batch.state)) check(!items.some(item => ['pending', 'running'].includes(item.state)));
    return { id: batch.id, kind: batch.kind, state: batch.state, at: batch.at, ...(batch.parent === undefined ? {} : { parent: batch.parent }), items };
  }, 100);
}
function parseBrowser(value) {
  check(record(value) && id(value.id) && safeRoot(value.path) && id(value.currentId) && typeof value.selectable === 'boolean' && typeof value.truncated === 'boolean');
  const parseNode = item => { check(id(item.id) && text(item.label, 1024)); return { id: item.id, label: item.label }; };
  return freeze({ id: value.id, path: value.path, currentId: value.currentId, crumbs: rows(value.crumbs, parseNode, 256), directories: rows(value.directories, parseNode, 2000), selectable: value.selectable, truncated: value.truncated });
}
function parseDestination(value, projectIds, now, workspaces) {
  check(record(value) && id(value.id) && safeRoot(value.parent));
  const items = rows(value.items, item => {
    check(id(item.projectId) && projectIds.includes(item.projectId) && text(item.label, 1024) && freshChild(value.parent, item.root));
    check(!workspaces.some(workspace => pathKey(workspace.root) === pathKey(item.root)));
    return { projectId: item.projectId, label: item.label, root: item.root };
  }, MAX_ONBOARDING_PROJECTS);
  check(items.length === projectIds.length && items.length > 0 && new Set(items.map(item => pathKey(item.root))).size === items.length);
  return freeze({ id: value.id, parent: value.parent, expiresAt: expiry(value.expiresAt, now), items });
}

/** Deep allowlist: credentials, arbitrary exception bodies and unknown DTO fields never survive. */
export function parseSyncStatus(value) {
  check(record(value) && integer(value.revision) && typeof value.loggedIn === 'boolean');
  const server = origin(value.server ?? ''), username = value.username ?? '';
  check(text(username, 128, true) && (!value.loggedIn || (server && username)));
  const capability = value.capability ?? 'unknown'; check(['unknown', 'supported', 'upgrade-required'].includes(capability));
  check(value.running === undefined || typeof value.running === 'boolean');
  const workspaces = rows(value.workspaces ?? [], item => {
    check(opaque(item.id) && text(item.label, 1024) && absolute(item.root) && (item.available === undefined || typeof item.available === 'boolean'));
    return { id: item.id, label: item.label, root: item.root, available: item.available === true };
  });
  const bindings = rows(value.bindings ?? [], item => {
    check(id(item.id) && opaque(item.workspaceId) && id(item.projectId) && text(item.label, 1024) && absolute(item.root));
    check((item.enabled === undefined || typeof item.enabled === 'boolean') && (item.repairable === undefined || typeof item.repairable === 'boolean') && BINDING_STATES.includes(item.state ?? 'idle'));
    return { id: item.id, workspaceId: item.workspaceId, projectId: item.projectId, label: item.label, root: item.root, enabled: item.enabled === true, state: item.state ?? 'idle', ...(item.repairable === undefined ? {} : { repairable: item.repairable }), pendingUpload: count(item.pendingUpload), pendingDownload: count(item.pendingDownload), conflicts: count(item.conflicts), recycleCount: count(item.recycleCount), archives: count(item.archives), skippedArchives: count(item.skippedArchives), ...(item.warningCode === undefined ? {} : { warningCode: errorCode(item.warningCode) }), ...(date(item.lastCheckedAt) ? { lastCheckedAt: item.lastCheckedAt } : {}), ...(date(item.lastSyncedAt) ? { lastSyncedAt: item.lastSyncedAt } : {}), ...optionalError(item.errorCode) };
  });
  const operations = rows(value.operations ?? [], item => {
    check(id(item.id) && OP_STATES.includes(item.state) && (item.bindingId === undefined || id(item.bindingId)) && (item.requestId === undefined || id(item.requestId)));
    return { id: item.id, kind: OP_KINDS.includes(item.kind) ? item.kind : 'unknown', state: item.state, ...(item.bindingId === undefined ? {} : { bindingId: item.bindingId }), ...(item.requestId === undefined ? {} : { requestId: item.requestId }), ...importResult(item), ...optionalError(item.errorCode) };
  });
  return freeze({ revision: value.revision, server, username, loggedIn: value.loggedIn, capability, running: value.running === true, workspaces, bindings, operations, onboarding: parseOnboarding(value.onboarding ?? []), ...(value.storage === undefined ? {} : { storage: parseStorage(value.storage) }), ...(value.warning === undefined ? {} : { warning: errorCode(value.warning) }) });
}
export function parseSyncProjects(value) {
  check(record(value) && (value.partial === undefined || typeof value.partial === 'boolean'));
  return freeze({ projects: rows(value.projects, item => {
    check(id(item.projectId) && text(item.label, 1024) && (item.legacy === undefined || typeof item.legacy === 'boolean'));
    const metadata = {};
    // Cloud source paths are display/search hints only. Pairing sends the issued
    // project ID and registered local workspace ID, never a remote filesystem path.
    if (item.sourceRoot !== undefined) { check(sourceHint(item.sourceRoot)); metadata.sourceRoot = item.sourceRoot; }
    if (item.checkpointCount !== undefined) { check(integer(item.checkpointCount) && item.checkpointCount <= 1_000_000); metadata.checkpointCount = item.checkpointCount; }
    if (item.latestCreatedAt !== undefined) { check(date(item.latestCreatedAt)); metadata.latestCreatedAt = item.latestCreatedAt; }
    return { projectId: item.projectId, label: item.label, legacy: item.legacy === true, ...metadata };
  }), partial: value.partial === true });
}
export function parseSyncArchives(value) {
  check(record(value) && record(value.counts));
  const archives = rows(value.archives, item => {
    check(id(item.id) && text(item.label, 1024) && ['available', 'imported', 'uncertain'].includes(item.state) && integer(item.sessions) && integer(item.assets));
    return { id: item.id, label: item.label, state: item.state, sessions: item.sessions, assets: item.assets, ...(item.sessionIds === undefined ? {} : { sessionIds: sessionIds(item.sessionIds) }) };
  });
  const counts = {};
  for (const key of ['total', 'imported', 'uncertain']) { check(integer(value.counts[key])); counts[key] = value.counts[key]; }
  check(counts.total >= archives.length && counts.imported + counts.uncertain <= counts.total);
  return freeze({ archives, counts: freeze(counts) });
}
function parseItems(value, kind) {
  check(record(value));
  return rows(kind === 'conflicts' ? value.conflicts : value.items, item => {
    check((kind === 'recycle' ? text(item.id, 256) : id(item.id)) && relative(item.path));
    if (kind === 'recycle') { check(['deleted', 'replaced'].includes(item.reason)); return { id: item.id, path: item.path, size: count(item.size), reason: item.reason }; }
    const variants = rows(item.variants, variant => { check(id(variant.id) && text(variant.label, 1024) && typeof variant.deleted === 'boolean'); return { id: variant.id, label: variant.label, deleted: variant.deleted, size: count(variant.size) }; }, 256);
    check(variants.length >= 2); return { id: item.id, path: item.path, variants };
  });
}
function planBase(value, root, binding, now) {
  check(record(value) && id(value.id) && absolute(value.root) && pathKey(value.root) === pathKey(root));
  const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  check(Number.isSafeInteger(expiresAt) && expiresAt > 0);
  if (expiresAt <= now()) fail('SYNC_PLAN_EXPIRED');
  return { id: value.id, root: value.root, expiresAt, identity: binding };
}
function uuid(crypto) {
  let value;
  try {
    if (typeof crypto?.randomUUID === 'function') value = crypto.randomUUID();
    else if (typeof crypto?.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
      value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch { fail('BAD_REQUEST_ID'); }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '')) fail('BAD_REQUEST_ID');
  return value;
}
const emptyProjects = () => freeze({ items: freeze([]), loaded: false, partial: false, identity: null, loadedAt: 0 });

/**
 * Controller lifecycle: subscribe/getSnapshot, watch()->stop, refresh, dispose,
 * setIdentity({server,username,loggedIn}) (never a legacy revision).
 * Onboarding: openPublish (local only) / openClone (explicit cached discovery),
 * selectOnboarding(id,checked), planPublish or pickCloneParent/browseCloneParent/
 * selectCloneParent/selectCloneLegacy/planClone, then confirmPublish/confirmClone.
 * Exact plans authorize independent batches, never all-or-nothing rollback.
 * Pair (internal compatibility only): openPair/loadProjects/selectWorkspace(id)/selectProject(id|null)/
 * selectLegacy(id)/planPair/confirmPair(exactPlan). null explicitly creates cloud;
 * undefined clears cloud selection, '' clears workspace. No automatic selection.
 * Daily: setEnabled(bindingId,boolean), run(bindingId).
 * Advanced: setStorageLimit(quotaBytes), exact integer GiB1..1024. No project,
 * archive or GC consent is implied. Unknown outcome reconciles only a strictly
 * newer same-account status with the exact desired limit; never replays.
 * Conflicts: openConflicts/selectConflict/setConflictChoice/planResolution/confirmResolution.
 * Recycle: openRecycle/selectRecycle/planRestore/confirmRestore.
 * Archives: openArchives/selectArchive/planArchiveImport/confirmArchiveImport;
 * imports remain separate from file-sync enabling, including paused bindings.
 * Repair: openRepair/planRepair/confirmRepair, only specifically repairable blocks.
 * Shared: reloadDialog/back/closeDialog. All writes consume exact opaque plans.
 * Snapshot {status,ready,refreshing,busy,error,notice,projects,dialog,pending:[],
 * uncertain,pollStopped}. Pending IDs correlate Host operations.id=requestId.
 * stop/dispose cancel READ delivery only; no Host job cancellation or write replay.
 */
export function createBidirectionalController(connection, options = {}) {
  const setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis), clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const now = options.now ?? Date.now, activePollMs = Math.max(1000, options.activePollMs ?? 3000), idlePollMs = Math.max(10000, options.idlePollMs ?? 10000), timeoutMs = Math.max(1000, options.timeoutMs ?? 60000);
  const maxPollErrors = Math.max(1, options.maxPollErrors ?? 3), maxUncertainChecks = Math.max(1, options.maxUncertainChecks ?? 10);
  const projectCacheMs = Math.min(30000, Math.max(0, options.projectCacheMs ?? 30000));
  let state = freeze({ status: null, ready: false, refreshing: false, busy: null, error: null, notice: '', projects: emptyProjects(), dialog: null, pending: freeze([]), uncertain: false, pollStopped: false });
  let external = null, disposed = false, watchers = 0, readAllowed = true, pollTimer, expiryTimer, refreshAbort, dialogAbort, refreshGeneration = 0, dialogGeneration = 0, failures = 0, uncertainChecks = 0, pauseSequence = 0;
  const listeners = new Set(), attemptedImports = new Map();
  const archiveKey = (identity, bindingId, archiveId) => JSON.stringify([identity.server, identity.username, bindingId, archiveId]);
  const importAttempt = (identity, bindingId, archiveId) => attemptedImports.get(archiveKey(identity, bindingId, archiveId));
  const guardedArchives = (items, identity, bindingId) => freeze(items.map(item => {
    const attempt = importAttempt(identity, bindingId, item.id);
    if (item.state !== 'available' || !attempt) return item;
    return freeze({ ...item, state: attempt.state, ...(attempt.sessionIds ? { sessionIds: attempt.sessionIds } : {}) });
  }));
  const emit = patch => { if (disposed) return; state = freeze({ ...state, ...patch }); for (const listener of listeners) listener(); };
  const patchDialog = patch => { if (state.dialog) emit({ dialog: freeze({ ...state.dialog, ...patch }) }); };
  const clearPoll = () => { if (pollTimer !== undefined) clearTimer(pollTimer); pollTimer = undefined; };
  const clearExpiry = () => { if (expiryTimer !== undefined) clearTimer(expiryTimer); expiryTimer = undefined; };
  const cancelRefresh = () => { ++refreshGeneration; refreshAbort?.abort(); refreshAbort = undefined; };
  const cancelDialogRead = () => { ++dialogGeneration; dialogAbort?.abort(); dialogAbort = undefined; if (state.busy && !WRITE_ACTIONS.has(state.busy)) emit({ busy: null }); };
  const report = (code, local = false) => { const error = publicError(code instanceof Error ? code : new BidirectionalClientError(code)); if (local && state.dialog) patchDialog({ error }); else emit({ error }); return false; };
  const accountVisible = () => !external || (accountEqual(external, state.status) && external.loggedIn === state.status?.loggedIn);
  function ready({ pause = false, discovery = false } = {}) {
    if (disposed || !state.ready || !state.status || !accountVisible() || state.busy) return false;
    if (!pause && (state.uncertain || state.refreshing)) return false;
    if (!pause && !state.status.loggedIn) return report('NOT_LOGGED_IN');
    if (!pause && !discovery && state.status.capability !== 'supported') return report('SYNC_UPGRADE_REQUIRED');
    return true;
  }
  function expirePlan() {
    clearExpiry(); const plan = state.dialog?.plan;
    if (!plan || !watchers) return;
    expiryTimer = setTimer(() => { expiryTimer = undefined; if (state.dialog?.plan === plan) patchDialog({ plan: null, stage: 'choose', error: publicError(new BidirectionalClientError('SYNC_PLAN_EXPIRED')) }); }, Math.min(2147483647, Math.max(0, plan.expiresAt - now())));
    expiryTimer?.unref?.();
  }
  function queuePoll() {
    clearPoll();
    const stopped = failures >= maxPollErrors || ((state.pending.length > 0 || state.uncertain) && uncertainChecks >= maxUncertainChecks);
    if (state.pollStopped !== stopped) emit({ pollStopped: stopped });
    if (disposed || !watchers || !readAllowed || state.busy || state.refreshing || stopped) return;
    const active = state.pending.length > 0 || state.uncertain || state.status?.running || state.status?.onboarding.some(item => item.state === 'running') || state.status?.operations.some(item => ['running', 'uncertain'].includes(item.state)) || state.status?.bindings.some(item => ['scanning', 'uploading', 'applying'].includes(item.state));
    const enabled = state.status?.bindings.some(item => item.enabled);
    if (!active && (!enabled || !state.status?.loggedIn || !accountVisible())) return;
    pollTimer = setTimer(() => { pollTimer = undefined; void refresh({ automatic: true }); }, active ? activePollMs : idlePollMs); pollTimer?.unref?.();
  }
  async function call(action, payload, abort) {
    let timedOut = false, rejectAbort;
    const cancelled = new Promise((_resolve, reject) => { rejectAbort = () => reject(new BidirectionalClientError(timedOut ? 'TIMEOUT' : 'REQUEST_FAILED')); abort.signal.addEventListener('abort', rejectAbort, { once: true }); });
    const timer = setTimer(() => { timedOut = true; abort.abort(); }, timeoutMs); timer?.unref?.();
    try {
      if (!BIDIRECTIONAL_ACTIONS.includes(action) || typeof connection?.rpc?.call !== 'function') fail('CONNECTION_UNAVAILABLE');
      if (abort.signal.aborted) fail('REQUEST_FAILED');
      const result = await Promise.race([connection.rpc.call('/api', `dsh-personal-sync/${action}`, payload, abort.signal), cancelled]);
      check(record(result) && typeof result.ok === 'boolean');
      if (!result.ok) {
        const aliases = { 'gateway/not-found': 'NOT_DEPLOYED', 'gateway/not-implemented': 'NOT_DEPLOYED', 'gateway/unavailable': 'SERVICE_UNAVAILABLE', 'gateway/unauthorized': 'AUTH_REQUIRED', 'gateway/forbidden': 'FORBIDDEN', 'gateway/bad-request': 'BAD_REQUEST' };
        const code = aliases[result.error?.code] ?? errorCode(result.error?.code);
        throw new BidirectionalClientError(code, DEFINITE.has(code));
      }
      return result.value;
    } finally { clearTimer(timer); abort.signal.removeEventListener('abort', rejectAbort); }
  }
  function invalidateAuthority(stale = true) {
    cancelDialogRead(); clearExpiry();
    if (state.dialog) patchDialog({ plan: null, identity: null, stale, ...(isOnboarding(state.dialog.kind) ? { selectedIds: freeze([]), browser: null, destination: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]) } : {}), stage: ['progress', 'uncertain'].includes(state.dialog.stage) ? state.dialog.stage : 'choose' });
    emit({ projects: freeze({ ...state.projects, loaded: false, identity: null }) });
  }
  function acceptStatus(status) {
    const old = state.status, changedAccount = old && !accountEqual(old, status), changedAuthority = old && (!identityEqual(old, status) || old.loggedIn !== status.loggedIn);
    if (old && accountEqual(old, status) && status.revision < old.revision) fail('INVALID_RESPONSE');
    if (changedAuthority || !status.loggedIn) invalidateAuthority();
    if (changedAccount || !status.loggedIn) emit({ dialog: null, projects: emptyProjects() });
    let notice = state.notice;
    const pending = [];
    for (const item of state.pending) {
      if (!accountEqual(item.identity, status)) continue;
      if (item.action === 'syncpause') {
        if (status.revision > item.identity.revision && status.bindings.some(row => row.id === item.bindingId && row.enabled === item.enabled)) { notice = item.enabled ? '已恢复自动同步' : '已暂停自动同步'; continue; }
        pending.push(item); continue;
      }
      if (item.action === 'syncsettings') {
        if (status.revision > item.identity.revision && status.storage?.limitBytes === item.quotaBytes) { notice = '存储上限已保存；不会自动删除内容'; continue; }
        pending.push(item); continue;
      }
      const batchKind = onboardingKind(item.action);
      if (batchKind) {
        // Batch IDs are the original client request IDs, including after a lost ACK.
        // Never correlate by project/path or invent a replacement request.
        const batch = status.onboarding.find(row => row.id === item.requestId && row.kind === batchKind);
        if (!batch) { pending.push(uncertainChecks >= maxUncertainChecks ? freeze({ ...item, uncertain: true }) : item); continue; }
        if (state.dialog?.requestId === item.requestId && state.dialog.kind === batchKind) patchDialog({ operationId: batch.id, batch });
        if (terminalOnboarding(batch)) {
          notice = uncertainOnboarding(batch) ? '部分项目结果仍未确认，不会重复提交；其他项目可独立操作' : batch.state === 'succeeded' ? '各项目已独立完成，已启用双向同步' : batch.state === 'partial' ? '部分项目完成；失败项目未回滚已完成项目，请逐项核对' : '项目未完成，请逐项核对；不会自动重试';
          continue;
        }
        pending.push(freeze({ ...item, operationId: batch.id, uncertain: uncertainOnboarding(batch) }));
        continue;
      }
      const operation = status.operations.find(op => (op.id === item.requestId || op.requestId === item.requestId) && operationKinds[item.action]?.includes(op.kind) && (!item.bindingId || !op.bindingId || op.bindingId === item.bindingId));
      if (!operation) { pending.push(uncertainChecks >= maxUncertainChecks ? freeze({ ...item, uncertain: true }) : item); continue; }
      if (state.dialog?.requestId === item.requestId) patchDialog({ operationId: operation.id });
      if (item.action === 'syncarchiveimport' && item.archiveId) {
        const key = archiveKey(item.identity, item.bindingId, item.archiveId), prior = attemptedImports.get(key);
        attemptedImports.set(key, freeze({ ...prior, requestId: item.requestId, state: operation.state === 'succeeded' && operation.errorCode !== 'SYNC_IMPORT_UNCERTAIN' && !operation.failedCount ? 'imported' : 'uncertain', ...importResult(operation) }));
      }
      if (['succeeded', 'failed'].includes(operation.state)) { notice = operation.state === 'succeeded' ? '操作已完成' : bidirectionalMessage(operation.errorCode ?? 'SYNC_FAILED'); continue; }
      pending.push(freeze({ ...item, operationId: operation.id, uncertain: operation.state === 'uncertain' }));
    }
    const uncertain = pending.some(item => item.uncertain) || hostUncertain(status);
    const observedPending = pending.length > 0 && pending.every(item => item.operationId && (onboardingKind(item.action) ? status.onboarding.some(batch => batch.id === item.requestId && batch.kind === onboardingKind(item.action) && batch.state === 'running') : status.operations.some(op => op.id === item.operationId && op.state === 'running')));
    if (!uncertain && (!pending.length || observedPending)) uncertainChecks = 0;
    const error = uncertain ? publicError(new BidirectionalClientError('SYNC_UNCERTAIN')) : state.error?.code === 'SYNC_UNCERTAIN' ? null : state.error;
    emit({ status, ready: !external || (accountEqual(external, status) && external.loggedIn === status.loggedIn), pending: freeze(pending), uncertain, notice, error });
    if (isOnboarding(state.dialog?.kind) && state.dialog.requestId) {
      const batch = status.onboarding.find(item => item.id === state.dialog.requestId && item.kind === state.dialog.kind);
      if (batch) patchDialog({ batch, identity: identityOf(status), stale: false, error: null, stage: uncertainOnboarding(batch) ? 'uncertain' : 'progress' });
    }
    if (state.dialog?.kind === 'archives') {
      const items = guardedArchives(state.dialog.items, identityOf(status), state.dialog.bindingId);
      patchDialog({ items, ...(state.dialog.stage === 'choose' && !items.some(item => item.id === state.dialog.selectedId && item.state === 'available') ? { selectedId: '' } : {}) });
    }
    if (state.dialog?.kind === 'repair' && state.dialog.plan && !canRepairBinding(status.bindings.find(item => item.id === state.dialog.bindingId))) { clearExpiry(); patchDialog({ plan: null, stage: 'choose', stale: true }); }
    if (state.dialog?.stage === 'uncertain' && !uncertain && !(isOnboarding(state.dialog.kind) && state.dialog.batch && uncertainOnboarding(state.dialog.batch))) patchDialog({ stage: 'progress', error: null });
  }
  async function refresh({ automatic = false } = {}) {
    if (disposed || (automatic && !readAllowed) || WRITE_ACTIONS.has(state.busy)) return false;
    clearPoll(); cancelRefresh();
    if (!automatic) { failures = 0; uncertainChecks = 0; }
    const generation = refreshGeneration, abort = new AbortController(); refreshAbort = abort; emit({ refreshing: true });
    if (state.pending.length > 0 || state.uncertain) ++uncertainChecks;
    try {
      const result = parseSyncStatus(await call('syncstatus', {}, abort));
      if (disposed || generation !== refreshGeneration) return false;
      acceptStatus(result); failures = 0;
      if (!state.uncertain) emit({ error: null });
      return true;
    } catch (error) {
      if (!disposed && generation === refreshGeneration) { ++failures; invalidateAuthority(); emit({ ready: false, error: publicError(error) }); }
      return false;
    } finally { if (!disposed && generation === refreshGeneration) { refreshAbort = undefined; emit({ refreshing: false }); queuePoll(); } }
  }
  function setIdentity(value) {
    try {
      check(record(value) && typeof value.loggedIn === 'boolean' && text(value.username ?? '', 128, true));
      const incoming = freeze({ server: origin(value.server ?? ''), username: value.username ?? '', loggedIn: value.loggedIn });
      if (!external || !accountEqual(external, incoming) || external.loggedIn !== incoming.loggedIn) {
        external = incoming; cancelRefresh(); invalidateAuthority();
        // An account-card transition is not a fresh syncstatus authorization,
        // even if it returns to a previously cached identity before the read settles.
        emit({ ready: false, refreshing: false, dialog: null, projects: emptyProjects(), error: null }); queuePoll();
      }
      return true;
    } catch { external = freeze({ server: '', username: '', loggedIn: false }); cancelRefresh(); invalidateAuthority(); emit({ ready: false, dialog: null, error: publicError(new BidirectionalClientError('ACCOUNT_MISMATCH')) }); return false; }
  }
  async function dialogRead(action, payload, accept) {
    if (!ready({ discovery: action === 'syncprojects' || ['syncpublishplan', 'syncclonepick', 'syncclonebrowse', 'synccloneselect', 'synccloneplan'].includes(action) }) || !state.dialog) return false;
    clearPoll(); cancelDialogRead(); const generation = dialogGeneration, abort = new AbortController(), bound = identityOf(state.status), dialog = state.dialog;
    dialogAbort = abort; emit({ busy: action }); patchDialog({ error: null });
    try {
      const value = await call(action, { ...bound, ...payload }, abort);
      if (disposed || generation !== dialogGeneration || !state.dialog || state.dialog.kind !== dialog.kind || !identityEqual(bound, state.status) || !accountVisible()) return false;
      accept(value, bound); return true;
    } catch (error) {
      if (!disposed && generation === dialogGeneration) {
        const stage = dialog.kind === 'clone' && state.dialog?.browser && ['syncclonebrowse', 'synccloneselect'].includes(action) ? 'folder' : dialog.kind === 'clone' && state.dialog?.destination && action === 'synccloneplan' ? (state.dialog.legacyChoices.length ? 'legacy' : 'destination') : 'choose';
        patchDialog({ plan: null, stage, error: publicError(error) });
      }
      return false;
    }
    finally { if (!disposed && generation === dialogGeneration) { dialogAbort = undefined; emit({ busy: null }); expirePlan(); queuePoll(); } }
  }
  async function loadProjects({ force = true } = {}) {
    const kind = state.dialog?.kind;
    if (!['pair', 'clone'].includes(kind) || (kind === 'clone' && ['progress', 'uncertain'].includes(state.dialog.stage)) || !ready({ discovery: true })) return false;
    if (kind === 'clone' && !force && state.projects.loaded && identityEqual(state.projects.identity, state.status) && now() - state.projects.loadedAt < projectCacheMs) return true;
    const needsStatus = kind === 'pair' || state.status.capability !== 'supported';
    const pending = dialogRead('syncprojects', {}, (value, identity) => {
      const parsed = parseSyncProjects(value); emit({ projects: freeze({ items: parsed.projects, loaded: true, partial: parsed.partial, identity, loadedAt: now() }) });
      patchDialog({ identity, stale: false, plan: null, ...(kind === 'clone' ? { selectedIds: freeze(state.dialog.selectedIds.filter(projectId => parsed.projects.some(item => item.projectId === projectId) && !state.status.bindings.some(item => item.projectId === projectId))), browser: null, destination: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]), stage: 'choose' } : {}), ...(state.dialog.projectId && !parsed.projects.some(item => item.projectId === state.dialog.projectId) ? { projectChoice: '', projectId: null } : {}) });
    });
    const generation = dialogGeneration, loaded = await pending;
    if (disposed || !readAllowed || generation !== dialogGeneration || state.dialog?.kind !== kind) return false;
    // Catalog discovery is explicit. Known capability avoids a redundant status read;
    // first discovery must reconcile Host's newly persisted capability, not guess it.
    const unsupported = ['SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_UPGRADE_REQUIRED', 'SYNC_UNSUPPORTED'].includes(state.dialog.error?.code);
    if ((loaded && needsStatus) || unsupported) {
      if (!await refresh({ automatic: true }) || state.dialog?.kind !== kind) return false;
      if (!state.projects.loaded || !identityEqual(state.projects.identity, state.status)) return false;
    }
    return loaded;
  }
  async function openPair() {
    if (!ready({ discovery: true })) return false;
    closeDialog(); emit({ dialog: freeze({ kind: 'pair', stage: 'choose', identity: identityOf(state.status), stale: false, workspaceId: '', projectChoice: '', projectId: null, primaryLegacyId: null, legacyChoices: freeze([]), plan: null, error: null }) });
    return loadProjects();
  }
  function openOnboarding(kind) {
    if (!ready({ discovery: true })) return false;
    closeDialog(); emit({ dialog: freeze({ kind, stage: 'choose', identity: identityOf(state.status), stale: false, selectedIds: freeze([]), browser: null, destination: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]), plan: null, batch: null, error: null, message: '' }) });
    return true;
  }
  function openPublish() { return openOnboarding('publish'); }
  async function openClone() { return openOnboarding('clone') ? loadProjects({ force: false }) : false; }
  const availableWorkspace = workspaceId => state.status?.workspaces.find(row => row.id === workspaceId && row.available && !state.status.bindings.some(binding => binding.workspaceId === row.id));
  function selectOnboarding(value, checked) {
    const dialog = state.dialog;
    if (!isOnboarding(dialog?.kind) || dialog.stage !== 'choose' || dialog.stale || !identityEqual(dialog.identity, state.status) || !ready({ discovery: true }) || typeof checked !== 'boolean') return false;
    if (dialog.kind === 'publish' ? !availableWorkspace(value) : !state.projects.loaded || !identityEqual(state.projects.identity, state.status) || !state.projects.items.some(row => row.projectId === value) || state.status.bindings.some(row => row.projectId === value)) return false;
    const selectedIds = dialog.selectedIds.filter(item => item !== value);
    if (checked) selectedIds.push(value);
    if (selectedIds.length > MAX_ONBOARDING_PROJECTS) return report('SYNC_BATCH_LIMIT', true);
    clearExpiry(); patchDialog({ selectedIds: freeze(selectedIds), plan: null, browser: null, destination: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]), error: null, message: '' });
    return true;
  }
  function validOnboarding(kind) {
    const dialog = state.dialog;
    if (dialog?.kind !== kind || !ready({ discovery: true }) || ['progress', 'uncertain'].includes(dialog.stage)) return false;
    if (dialog.stale || !identityEqual(dialog.identity, state.status)) return report('SYNC_REFRESH_REQUIRED', true);
    if (!dialog.selectedIds.length) return report('SYNC_BATCH_SELECTION_REQUIRED', true);
    if (dialog.selectedIds.length > MAX_ONBOARDING_PROJECTS) return report('SYNC_BATCH_LIMIT', true);
    return true;
  }
  async function planPublish() {
    if (!validOnboarding('publish')) return false;
    const dialog = state.dialog, needsStatus = state.status.capability !== 'supported';
    const workspaces = dialog.selectedIds.map(availableWorkspace);
    if (workspaces.some(item => !item)) return report('SYNC_PROJECT_UNAVAILABLE', true);
    const result = await dialogRead('syncpublishplan', { workspaceIds: [...dialog.selectedIds] }, (value, identity) => {
      check(record(value) && record(value.plan)); const source = value.plan;
      check(id(source.id));
      const items = rows(source.items, item => {
        const workspace = workspaces.find(row => row.id === item.workspaceId);
        check(workspace && id(item.projectId) && text(item.label, 1024) && safeRoot(item.root) && pathKey(item.root) === pathKey(workspace.root));
        check(!state.status.bindings.some(row => row.projectId === item.projectId) && !state.projects.items.some(row => row.projectId === item.projectId));
        return { workspaceId: workspace.id, projectId: item.projectId, label: item.label, root: item.root, summary: syncSummary(item.summary) };
      }, MAX_ONBOARDING_PROJECTS);
      check(items.length === workspaces.length && new Set(items.map(item => item.workspaceId)).size === items.length && new Set(items.map(item => pathKey(item.root))).size === items.length);
      patchDialog({ stage: 'review', stale: false, plan: freeze({ kind: 'publish', id: source.id, expiresAt: expiry(source.expiresAt, now), identity, items, summary: batchSummary(source.summary, items) }) });
    });
    if (!result || !needsStatus) return result;
    const plan = state.dialog?.plan;
    return await refresh({ automatic: true }) && state.dialog?.plan === plan && identityEqual(plan?.identity, state.status) && state.status.capability === 'supported';
  }
  function acceptDestination(value, identity) {
    check(record(value));
    const alternatives = [value.cancelled === true, value.browser !== undefined, value.destination !== undefined].filter(Boolean).length;
    check(alternatives === 1);
    if (value.cancelled === true) { patchDialog({ stage: 'choose', browser: null, destination: null, plan: null, message: '已取消目录选择，尚未创建目录或工作区。' }); return; }
    if (value.browser !== undefined) { patchDialog({ identity, browser: parseBrowser(value.browser), destination: null, plan: null, stage: 'folder', message: '' }); return; }
    const destination = parseDestination(value.destination, state.dialog.selectedIds, now, state.status.workspaces);
    patchDialog({ identity, browser: null, destination, plan: null, stage: 'destination', message: '' });
  }
  async function pickCloneParent() {
    if (!validOnboarding('clone')) return false;
    if (!state.projects.loaded || !identityEqual(state.projects.identity, state.status)) return report('SYNC_REFRESH_REQUIRED', true);
    clearExpiry(); patchDialog({ browser: null, destination: null, plan: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]), message: '' });
    return dialogRead('syncclonepick', { projectIds: [...state.dialog.selectedIds] }, acceptDestination);
  }
  async function browseCloneParent(nodeId) {
    if (!validOnboarding('clone')) return false;
    const browser = state.dialog.browser;
    if (!browser || ![...browser.crumbs, ...browser.directories].some(item => item.id === nodeId)) return false;
    return dialogRead('syncclonebrowse', { browserId: browser.id, nodeId }, acceptDestination);
  }
  async function selectCloneParent() {
    if (!validOnboarding('clone')) return false;
    const browser = state.dialog.browser;
    if (!browser?.selectable) return report('SYNC_DESTINATION_UNAVAILABLE', true);
    return dialogRead('synccloneselect', { browserId: browser.id, nodeId: browser.currentId }, (value, identity) => {
      if (record(value?.destination)) check(safeRoot(value.destination.parent) && pathKey(value.destination.parent) === pathKey(browser.path));
      acceptDestination(value, identity);
    });
  }
  function selectCloneLegacy(projectId, checkpointId) {
    if (!validOnboarding('clone') || state.dialog.stage !== 'legacy') return false;
    if (!state.dialog.legacyChoices.some(row => row.projectId === projectId && row.heads.some(head => head.id === checkpointId))) return false;
    patchDialog({ primaryLegacyIds: freeze([...state.dialog.primaryLegacyIds.filter(row => row.projectId !== projectId), freeze({ projectId, checkpointId })]), error: null }); return true;
  }
  async function planClone() {
    if (!validOnboarding('clone')) return false;
    const dialog = state.dialog, destination = dialog.destination;
    if (!destination) return report('SYNC_DESTINATION_REQUIRED', true);
    if (destination.expiresAt <= now()) { patchDialog({ destination: null, browser: null, plan: null, stage: 'choose' }); return report('SYNC_DESTINATION_EXPIRED', true); }
    if (dialog.legacyChoices.some(row => !dialog.primaryLegacyIds.some(choice => choice.projectId === row.projectId))) return report('SYNC_BATCH_SELECTION_REQUIRED', true);
    return dialogRead('synccloneplan', { destinationId: destination.id, ...(dialog.primaryLegacyIds.length ? { primaryLegacyIds: dialog.primaryLegacyIds } : {}) }, (value, identity) => {
      check(record(value));
      if (value.requiresLegacyChoice === true) {
        check(!value.plan);
        const choices = rows(value.choices, item => {
          check(dialog.selectedIds.includes(item.projectId) && text(item.label, 1024));
          const heads = rows(item.heads, head => { check(id(head.id) && text(head.label, 1024)); return { id: head.id, label: head.label }; }, 256);
          check(heads.length > 1); return { projectId: item.projectId, label: item.label, heads };
        }, MAX_ONBOARDING_PROJECTS);
        check(choices.length > 0); patchDialog({ legacyChoices: choices, primaryLegacyIds: freeze([]), plan: null, stage: 'legacy' }); return;
      }
      const source = value.plan; check(record(source) && id(source.id) && safeRoot(source.parent) && pathKey(source.parent) === pathKey(destination.parent));
      const items = rows(source.items, item => {
        const target = destination.items.find(row => row.projectId === item.projectId);
        check(target && text(item.label, 1024) && freshChild(source.parent, item.root) && pathKey(item.root) === pathKey(target.root) && typeof item.migrationRequired === 'boolean');
        const summary = syncSummary(item.summary); check(summary.upload === 0 && summary.delete === 0);
        return { projectId: target.projectId, label: item.label, root: item.root, summary, migrationRequired: item.migrationRequired };
      }, MAX_ONBOARDING_PROJECTS);
      check(items.length === destination.items.length);
      patchDialog({ stage: 'review', plan: freeze({ kind: 'clone', id: source.id, identity, expiresAt: expiry(source.expiresAt, now), parent: source.parent, items, summary: batchSummary(source.summary, items) }) });
    });
  }
  function openOnboardingStatus(batchId) {
    if (disposed || !state.ready || !accountVisible() || state.busy || !state.status?.loggedIn) return false;
    const batch = state.status.onboarding.find(item => item.id === batchId);
    if (!batch) return false;
    closeDialog(); emit({ dialog: freeze({ kind: batch.kind, stage: uncertainOnboarding(batch) ? 'uncertain' : 'progress', identity: identityOf(state.status), stale: false, requestId: batch.id, operationId: batch.id, batch, plan: null, error: null }) }); return true;
  }
  function editDialog(patch) {
    if (!ready() || !state.dialog || ['progress', 'uncertain'].includes(state.dialog.stage)) return false;
    cancelDialogRead(); clearExpiry(); patchDialog({ ...patch, plan: null, stage: 'choose', error: null }); return true;
  }
  function selectWorkspace(value) {
    if (state.dialog?.kind !== 'pair' || (value !== '' && !state.status?.workspaces.some(row => row.id === value && row.available))) return false;
    return editDialog({ workspaceId: value, primaryLegacyId: null, legacyChoices: freeze([]) });
  }
  function selectProject(value) {
    if (state.dialog?.kind !== 'pair' || (value !== null && value !== undefined && (!state.projects.loaded || !identityEqual(state.projects.identity, state.status) || !state.projects.items.some(row => row.projectId === value)))) return false;
    return editDialog({ projectChoice: value === undefined ? '' : value === null ? 'new' : 'existing', projectId: value ?? null, primaryLegacyId: null, legacyChoices: freeze([]) });
  }
  function selectLegacy(value) {
    if (state.dialog?.kind !== 'pair' || !state.dialog.legacyChoices.some(row => row.id === value)) return false;
    return editDialog({ primaryLegacyId: value });
  }
  async function planPair() {
    const dialog = state.dialog;
    if (dialog?.kind !== 'pair' || !ready()) return false;
    const workspace = state.status.workspaces.find(row => row.id === dialog.workspaceId && row.available);
    if (!workspace || !dialog.projectChoice) return report('SYNC_SELECTION_REQUIRED', true);
    if (!state.projects.loaded || !identityEqual(state.projects.identity, state.status)) return report('SYNC_REFRESH_REQUIRED', true);
    const payload = { workspaceId: workspace.id, projectId: dialog.projectId, ...(dialog.primaryLegacyId ? { primaryLegacyId: dialog.primaryLegacyId } : {}) };
    return dialogRead('pairplan', payload, (value, identity) => {
      check(record(value));
      if (value.requiresLegacyChoice === true) {
        check(dialog.projectChoice === 'existing' && !value.plan);
        const choices = rows(value.choices, item => { check(id(item.id) && text(item.label, 1024)); return { id: item.id, label: item.label }; }); check(choices.length > 1);
        patchDialog({ identity, legacyChoices: choices, primaryLegacyId: null, stage: 'legacy', plan: null }); return;
      }
      const plan = value.plan, base = planBase(plan, workspace.root, identity, now);
      check(id(plan.projectId) && text(plan.label, 1024) && (dialog.projectChoice === 'new' || plan.projectId === dialog.projectId) && record(plan.summary));
      const summary = {}; for (const key of ['upload', 'download', 'delete', 'conflicts', 'blocked']) { check(integer(plan.summary[key])); summary[key] = plan.summary[key]; }
      patchDialog({ identity, stale: false, stage: 'review', plan: freeze({ ...base, kind: 'pair', workspaceId: workspace.id, projectId: plan.projectId, label: plan.label, summary: freeze(summary) }) });
    });
  }
  async function openItems(kind, bindingId) {
    if (!ready() || !state.status.bindings.some(row => row.id === bindingId)) return false;
    closeDialog(); emit({ dialog: freeze({ kind, stage: 'choose', bindingId, identity: identityOf(state.status), stale: false, items: freeze([]), loaded: false, selectedId: '', choice: 'both', plan: null, error: null, ...(kind === 'archives' ? { counts: null } : {}) }) });
    return loadItems();
  }
  async function loadItems() {
    const dialog = state.dialog; if (!dialog || !['conflicts', 'recycle', 'archives'].includes(dialog.kind)) return false;
    if (!state.status?.bindings.some(row => row.id === dialog.bindingId)) return report('SYNC_BINDING_NOT_FOUND', true);
    const action = { conflicts: 'syncconflicts', recycle: 'syncrecycle', archives: 'syncarchives' }[dialog.kind];
    return dialogRead(action, { bindingId: dialog.bindingId }, (value, identity) => {
      const parsed = dialog.kind === 'archives' ? parseSyncArchives(value) : null;
      const items = parsed ? guardedArchives(parsed.archives, identity, dialog.bindingId) : parseItems(value, dialog.kind);
      patchDialog({ identity, stale: false, items, loaded: true, selectedId: items.some(row => row.id === dialog.selectedId && (dialog.kind !== 'archives' || row.state === 'available')) ? dialog.selectedId : '', plan: null, stage: 'choose', ...(parsed ? { counts: parsed.counts } : {}) });
    });
  }
  async function reloadDialog() {
    if (!state.dialog || state.busy || ['progress', 'uncertain'].includes(state.dialog.stage)) return false;
    const kind = state.dialog.kind, bindingId = state.dialog.bindingId;
    // A stale revision must first be replaced by syncstatus; retrying a catalog
    // read with the rejected old revision would strand the wizard in a loop.
    if (!await refresh() || state.dialog?.kind !== kind || state.dialog.bindingId !== bindingId) return false;
    if (kind === 'repair') { patchDialog({ identity: identityOf(state.status), stale: false, plan: null, stage: 'choose', error: null }); return true; }
    if (isOnboarding(kind)) {
      patchDialog({ identity: identityOf(state.status), stale: false, ...(kind === 'publish' ? { selectedIds: freeze(state.dialog.selectedIds.filter(value => availableWorkspace(value))) } : {}), browser: null, destination: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]), plan: null, stage: 'choose', error: null, message: '' });
      return kind === 'clone' ? loadProjects({ force: true }) : true;
    }
    return kind === 'pair' ? loadProjects() : loadItems();
  }
  function selectItem(kind, value) {
    const dialog = state.dialog;
    if (dialog?.kind !== kind || !dialog.loaded || dialog.stale || !identityEqual(dialog.identity, state.status) || !dialog.items.some(row => row.id === value && (kind !== 'archives' || row.state === 'available'))) return false;
    if (kind === 'archives' && importAttempt(dialog.identity, dialog.bindingId, value)) return false;
    return editDialog({ selectedId: value, choice: 'both' });
  }
  function setConflictChoice(value) { return state.dialog?.kind === 'conflicts' && ['local', 'remote', 'both'].includes(value) ? editDialog({ choice: value }) : false; }
  async function planItem(kind) {
    const dialog = state.dialog;
    if (dialog?.kind !== kind || !ready()) return false;
    const binding = state.status.bindings.find(row => row.id === dialog.bindingId);
    if (!binding || !dialog.loaded || dialog.stale || !identityEqual(dialog.identity, state.status) || !dialog.items.some(row => row.id === dialog.selectedId)) return report('SYNC_REFRESH_REQUIRED', true);
    const payload = kind === 'conflicts' ? { bindingId: binding.id, conflictId: dialog.selectedId, choice: dialog.choice } : { bindingId: binding.id, itemId: dialog.selectedId };
    return dialogRead(kind === 'conflicts' ? 'syncresolveplan' : 'syncrestoreplan', payload, (value, identity) => {
      check(record(value)); const plan = value.plan, base = planBase(plan, binding.root, identity, now);
      if (kind === 'conflicts') {
        check(Array.isArray(plan.paths) && plan.paths.length <= 512 && plan.paths.every(item => text(item)) && text(plan.summary, 2048));
        patchDialog({ stage: 'review', plan: freeze({ ...base, kind, bindingId: binding.id, conflictId: dialog.selectedId, choice: dialog.choice, paths: freeze([...plan.paths]), summary: plan.summary }) });
      } else {
        check(absolute(plan.target) && pathKey(plan.target).startsWith(`${pathKey(binding.root)}/`) && pathKey(plan.target) !== pathKey(binding.root));
        patchDialog({ stage: 'review', plan: freeze({ ...base, kind, bindingId: binding.id, itemId: dialog.selectedId, target: plan.target }) });
      }
    });
  }
  async function planArchiveImport() {
    const dialog = state.dialog;
    if (dialog?.kind !== 'archives' || !ready()) return false;
    const binding = state.status.bindings.find(row => row.id === dialog.bindingId), archive = dialog.items.find(item => item.id === dialog.selectedId);
    if (!binding || !dialog.loaded || dialog.stale || !identityEqual(dialog.identity, state.status) || archive?.state !== 'available' || importAttempt(dialog.identity, dialog.bindingId, dialog.selectedId)) return report('SYNC_REFRESH_REQUIRED', true);
    return dialogRead('syncarchiveplan', { bindingId: binding.id, archiveId: archive.id }, (value, identity) => {
      check(record(value)); const plan = value.plan, base = planBase(plan, binding.root, identity, now);
      check(text(plan.label, 1024) && ['unchecked', 'imported', 'uncertain'].includes(plan.eligibility) && record(plan.counts));
      const counts = {};
      for (const key of ['sessions', 'events', 'assets', 'files']) { check(integer(plan.counts[key])); counts[key] = plan.counts[key]; }
      const ids = plan.sessionIds === undefined ? undefined : sessionIds(plan.sessionIds);
      if (plan.eligibility !== 'unchecked') {
        attemptedImports.set(archiveKey(identity, binding.id, archive.id), freeze({ state: plan.eligibility, ...(ids ? { sessionIds: ids } : {}) }));
        patchDialog({ items: guardedArchives(state.dialog.items, identity, binding.id) });
      }
      patchDialog({ stage: 'review', plan: freeze({ ...base, kind: 'archives', bindingId: binding.id, archiveId: archive.id, label: plan.label, eligibility: plan.eligibility, counts: freeze(counts), ...(ids ? { sessionIds: ids } : {}) }) });
    });
  }
  function openRepair(bindingId) {
    if (!ready() || !canRepairBinding(state.status.bindings.find(row => row.id === bindingId))) return false;
    closeDialog(); emit({ dialog: freeze({ kind: 'repair', stage: 'choose', bindingId, identity: identityOf(state.status), stale: false, plan: null, error: null }) });
    return true;
  }
  async function planRepair() {
    const dialog = state.dialog;
    if (dialog?.kind !== 'repair' || !ready()) return false;
    const binding = state.status.bindings.find(row => row.id === dialog.bindingId);
    if (!canRepairBinding(binding) || dialog.stale || !identityEqual(dialog.identity, state.status)) return report('SYNC_REFRESH_REQUIRED', true);
    return dialogRead('syncrepairplan', { bindingId: binding.id }, (value, identity) => {
      check(record(value)); const plan = value.plan, base = planBase(plan, binding.root, identity, now);
      check(Array.isArray(plan.paths) && plan.paths.length <= 20000 && plan.paths.every(relative) && new Set(plan.paths).size === plan.paths.length && record(plan.summary));
      const summary = {};
      for (const key of ['restore', 'conflicts', 'unchanged']) { check(integer(plan.summary[key])); summary[key] = plan.summary[key]; }
      patchDialog({ stage: 'review', plan: freeze({ ...base, kind: 'repair', bindingId: binding.id, paths: freeze([...plan.paths]), summary: freeze(summary) }) });
    });
  }
  function replacePending(localId, patch) { const pending = freeze(state.pending.map(item => item.localId === localId ? freeze({ ...item, ...patch }) : item)); emit({ pending, uncertain: pending.some(item => item.uncertain) || hostUncertain(state.status) }); }
  async function write(action, payload, { plan = null, bindingId, enabled, quotaBytes } = {}) {
    const pause = action === 'syncpause' && enabled === false;
    if (!ready({ pause })) return false;
    if (plan && (state.dialog?.plan !== plan || !identityEqual(plan.identity, state.status) || plan.expiresAt <= now())) {
      if (state.dialog?.plan === plan) { clearExpiry(); patchDialog({ plan: null, stage: 'choose' }); }
      return report('SYNC_PLAN_EXPIRED', true);
    }
    const identity = identityOf(state.status), requestId = payload.requestId, localId = requestId ?? `${action}-${++pauseSequence}`;
    cancelRefresh(); clearPoll(); cancelDialogRead(); clearExpiry();
    const pending = freeze({ localId, action, identity, requestId: requestId ?? null, operationId: null, ...(bindingId ? { bindingId } : {}), ...(plan?.kind === 'archives' ? { archiveId: plan.archiveId } : {}), ...(enabled === undefined ? {} : { enabled }), ...(quotaBytes === undefined ? {} : { quotaBytes }), uncertain: false });
    if (plan?.kind === 'archives') attemptedImports.set(archiveKey(identity, bindingId, plan.archiveId), freeze({ state: 'uncertain', requestId }));
    emit({ busy: action, refreshing: false, error: null, pending: freeze([...state.pending, pending]) });
    if (plan) patchDialog({ plan: null, error: null, requestId, ...(isOnboarding(plan.kind) ? { submittedItems: plan.items, parent: plan.parent, stage: 'progress' } : {}), ...(plan.kind === 'archives' ? { items: guardedArchives(state.dialog.items, identity, bindingId) } : {}) });
    let accepted = false;
    try {
      const value = await call(action, { ...identity, ...payload }, new AbortController());
      if (disposed) return false;
      if (action === 'syncpause' || action === 'syncsettings') {
        const status = parseSyncStatus(value);
        check(accountEqual(status, identity) && status.revision > identity.revision && (action === 'syncsettings' ? status.storage?.limitBytes === quotaBytes : status.bindings.some(row => row.id === bindingId && row.enabled === enabled)));
        acceptStatus(status);
      } else {
        check(record(value) && value.accepted === true && value.operationId === requestId);
        replacePending(localId, { operationId: value.operationId }); emit({ notice: '请求已提交，关闭窗口后宿主仍会继续处理' });
        if (plan && state.dialog?.kind === plan.kind) patchDialog({ stage: 'progress', operationId: value.operationId });
      }
      accepted = true; return true;
    } catch (error) {
      if (disposed) return false;
      if (error instanceof BidirectionalClientError && error.definite) {
        if (plan?.kind === 'archives') {
          const key = archiveKey(identity, bindingId, plan.archiveId);
          if (attemptedImports.get(key)?.requestId === requestId) attemptedImports.delete(key);
          if (state.dialog?.kind === 'archives') patchDialog({ items: freeze(state.dialog.items.map(item => item.id === plan.archiveId ? freeze({ ...item, state: 'available' }) : item)) });
        }
        const remaining = freeze(state.pending.filter(item => item.localId !== localId)); emit({ pending: remaining, uncertain: remaining.some(item => item.uncertain) || hostUncertain(state.status), error: publicError(error) });
        if (plan && state.dialog?.kind === plan.kind) patchDialog({ stage: 'choose', plan: null, error: publicError(error) });
      } else {
        replacePending(localId, { uncertain: true }); emit({ error: publicError(new BidirectionalClientError('SYNC_UNCERTAIN')) });
        if (plan && state.dialog?.kind === plan.kind) patchDialog({ stage: 'uncertain', plan: null, error: publicError(new BidirectionalClientError('SYNC_UNCERTAIN')) });
      }
      return false;
    } finally {
      if (!disposed) {
        emit({ busy: null });
        if (readAllowed && (accepted || state.uncertain)) await refresh({ automatic: true }); else queuePoll();
      }
    }
  }
  async function confirm(kind, action, plan) {
    if (!plan || state.dialog?.kind !== kind || state.dialog.plan !== plan || !ready()) return false;
    if ((kind === 'pair' || isOnboarding(kind)) && plan.summary.blocked > 0) return report('SYNC_BLOCKED', true);
    if (kind === 'publish' && plan.items.some(item => { const workspace = availableWorkspace(item.workspaceId); return !workspace || pathKey(workspace.root) !== pathKey(item.root); })) return report('SYNC_ROOT_CHANGED', true);
    if (kind === 'clone' && plan.items.some(item => state.status.workspaces.some(workspace => pathKey(workspace.root) === pathKey(item.root)))) return report('SYNC_DESTINATION_EXISTS', true);
    if (plan.bindingId) {
      const binding = state.status.bindings.find(item => item.id === plan.bindingId);
      if (!binding || pathKey(binding.root) !== pathKey(plan.root)) return report('SYNC_ROOT_CHANGED', true);
      if (kind === 'repair' && !canRepairBinding(binding)) return report('SYNC_REFRESH_REQUIRED', true);
    }
    if (kind === 'archives' && (plan.eligibility !== 'unchecked' || importAttempt(plan.identity, plan.bindingId, plan.archiveId) || !state.dialog.items.some(item => item.id === plan.archiveId && item.state === 'available'))) return report(plan.eligibility === 'uncertain' ? 'SYNC_IMPORT_UNCERTAIN' : 'SYNC_IMPORT_SKIPPED', true);
    try { return await write(action, { planId: plan.id, requestId: uuid(options.crypto ?? globalThis.crypto), confirm: true }, { plan, bindingId: plan.bindingId }); }
    catch (error) { return report(error, true); }
  }
  async function setEnabled(bindingId, enabled) {
    if (typeof enabled !== 'boolean' || !state.status?.bindings.some(row => row.id === bindingId && row.enabled !== enabled)) return false;
    return write('syncpause', { bindingId, enabled }, { bindingId, enabled });
  }
  async function setStorageLimit(quotaBytes) {
    try { validateStorageLimit(quotaBytes); } catch (error) { return report(error); }
    if (!ready() || !state.status.storage || state.status.storage.limitBytes === quotaBytes) return false;
    return write('syncsettings', { quotaBytes }, { quotaBytes });
  }
  async function run(bindingId) {
    if (!ready() || !state.status.bindings.some(row => row.id === bindingId)) return false;
    try { return await write('syncrun', { bindingId, requestId: uuid(options.crypto ?? globalThis.crypto) }, { bindingId }); }
    catch (error) { return report(error); }
  }
  function back() {
    if (!state.dialog || state.busy || state.uncertain || ['progress', 'uncertain'].includes(state.dialog.stage)) return false;
    clearExpiry(); patchDialog({ plan: null, stage: 'choose', error: null, ...(isOnboarding(state.dialog.kind) ? { browser: null, destination: null, legacyChoices: freeze([]), primaryLegacyIds: freeze([]), message: '' } : {}) }); return true;
  }
  function closeDialog() { cancelDialogRead(); clearExpiry(); emit({ dialog: null }); queuePoll(); }
  function watch() {
    if (disposed) return () => {};
    ++watchers; readAllowed = true;
    if (watchers === 1) { void refresh(); expirePlan(); }
    let closed = false;
    return () => {
      if (closed) return; closed = true; --watchers;
      if (!watchers) { readAllowed = false; clearPoll(); clearExpiry(); cancelRefresh(); cancelDialogRead(); emit({ refreshing: false, dialog: null }); }
    };
  }
  function dispose() { if (disposed) return; readAllowed = false; clearPoll(); clearExpiry(); cancelRefresh(); cancelDialogRead(); disposed = true; listeners.clear(); }
  return freeze({ subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => state, watch, refresh, dispose, setIdentity,
    openPublish, openClone, selectOnboarding, planPublish, pickCloneParent, browseCloneParent, selectCloneParent, selectCloneLegacy, planClone, openOnboardingStatus,
    confirmPublish: plan => confirm('publish', 'syncpublishcommit', plan), confirmClone: plan => confirm('clone', 'syncclonecommit', plan),
    openPair, loadProjects, selectWorkspace, selectProject, selectLegacy, planPair, confirmPair: plan => confirm('pair', 'paircommit', plan),
    setEnabled, setStorageLimit, run, openConflicts: bindingId => openItems('conflicts', bindingId), selectConflict: value => selectItem('conflicts', value), setConflictChoice,
    planResolution: () => planItem('conflicts'), confirmResolution: plan => confirm('conflicts', 'syncresolve', plan),
    openRecycle: bindingId => openItems('recycle', bindingId), selectRecycle: value => selectItem('recycle', value), planRestore: () => planItem('recycle'), confirmRestore: plan => confirm('recycle', 'syncrestore', plan),
    openArchives: bindingId => openItems('archives', bindingId), selectArchive: value => selectItem('archives', value), planArchiveImport, confirmArchiveImport: plan => confirm('archives', 'syncarchiveimport', plan),
    openRepair, planRepair, confirmRepair: plan => confirm('repair', 'syncrepair', plan),
    reloadDialog, back, closeDialog });
}
