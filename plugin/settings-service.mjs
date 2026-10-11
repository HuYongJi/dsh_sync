import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, readStableFile, assertNoSymlinks } from '../src/files.mjs';
import { sha256, validateId, validateManifest, MAX_MANIFEST_BYTES } from '../src/protocol.mjs';
import { validateServerUrl, validatePasswordChange } from '../src/client.mjs';
import { validateRestoreDestination } from '../src/snapshot.mjs';

export const MAX_PROJECTS = 200;
export const settingsFailure = (code, message) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rootKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const validWorkspaceId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const requireValue = (condition, message = '设置参数不正确') => { if (!condition) throw settingsFailure('BAD_REQUEST', message); };
export function credentialKeyForProfile(profileDir) {
  requireValue(typeof profileDir === 'string' && path.isAbsolute(profileDir), '缺少当前 profile 目录');
  return `dsh-personal-sync/account-${sha256(rootKey(profileDir)).slice(0, 24)}`;
}
function exact(value, fields) { return object(value) && Object.keys(value).every(key => fields.includes(key)); }
async function readBoundedJson(filename, maximum = 1024 * 1024) {
  try { await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  // Once a named object exists, a broken redirect or a racing disappearance is
  // corruption, not permission to resurrect the install-time defaults.
  return JSON.parse((await readStableFile(filename, maximum)).bytes.toString('utf8'));
}
function validatePreferences(input) {
  requireValue(exact(input, ['version', 'revision', 'server', 'username', 'autoSync', 'intervalMs', 'bindings', 'selected']), '保存的同步设置无效');
  requireValue(input.version === 1 && Number.isSafeInteger(input.revision) && input.revision >= 0, '保存的同步设置版本无效');
  requireValue(input.server === undefined || typeof input.server === 'string');
  if (input.server) validateServerUrl(input.server);
  requireValue(input.username === undefined || typeof input.username === 'string' && input.username.length <= 128);
  requireValue(typeof input.autoSync === 'boolean' && Number.isSafeInteger(input.intervalMs) && input.intervalMs >= 30_000 && input.intervalMs <= 86_400_000);
  requireValue(Array.isArray(input.bindings) && input.bindings.length <= 1000 && Array.isArray(input.selected) && input.selected.length <= MAX_PROJECTS);
  const ids = new Set();
  const bindings = input.bindings.map(item => {
    requireValue(exact(item, ['workspaceId', 'projectId', 'root']) && validWorkspaceId(item.workspaceId) && !ids.has(item.workspaceId)); ids.add(item.workspaceId);
    validateId(item.projectId); requireValue(typeof item.root === 'string' && path.isAbsolute(item.root) && item.root.length <= 4096 && !/[\x00-\x1f\x7f]/.test(item.root));
    return { workspaceId: item.workspaceId, projectId: item.projectId, root: path.resolve(item.root) };
  });
  requireValue(new Set(input.selected).size === input.selected.length && input.selected.every(id => validWorkspaceId(id) && ids.has(id)));
  const selectedBindings = bindings.filter(item => input.selected.includes(item.workspaceId));
  requireValue(new Set(selectedBindings.map(item => item.projectId)).size === selectedBindings.length, '同一云端项目不能同时映射多个本机目录');
  return { version: 1, revision: input.revision, ...(input.server ? { server: validateServerUrl(input.server) } : {}), ...(input.username !== undefined ? { username: input.username } : {}), autoSync: input.autoSync, intervalMs: input.intervalMs, bindings, selected: [...input.selected] };
}
function summarizeLastResult(value) {
  if (!value) return undefined;
  const results = Array.isArray(value.results) ? value.results : [];
  const failed = Boolean(value.error) || results.some(item => item.error);
  const deferred = results.filter(item => item.deferred).length;
  const committed = results.reduce((count, item) => count + (item.uploaded?.length ?? item.retried?.length ?? 0), 0);
  const conflicts = results.flatMap(item => item.uploaded || []).filter(item => item.conflict).length;
  const skipped = results.reduce((count, item) => count + (item.skippedFiles?.length || 0) + (item.skippedSessions?.length || 0), 0);
  const protectedQueue = value.errorCode === 'PROTECTED_QUEUE' || results.some(item => item.errorCode === 'PROTECTED_QUEUE');
  const message = protectedQueue ? '受保护路径已暂停' : failed ? '同步未完成' : deferred ? `已延后 ${deferred} 个项目` : `提交 ${committed} 个检查点${conflicts ? ` · 冲突 ${conflicts}` : ''}${skipped ? ` · 跳过 ${skipped}` : ''}`;
  return { at: value.at, ok: !failed, message };
}

/** Settings are plugin-owned, non-secret and profile-scoped; never edit the Host's profile patch. */
export function createSettingsService(ctx, controller, { profileDir, dshHome } = {}) {
  requireValue(typeof profileDir === 'string' && path.isAbsolute(profileDir), '缺少当前 profile 目录');
  const filename = path.join(controller.store.directory, `preferences-${sha256(rootKey(profileDir)).slice(0, 24)}.json`);
  const base = { ...controller.config, projects: controller.config.projects.map(item => ({ ...item })) };
  const protectedRoots = [...new Set([profileDir, dshHome, controller.store.directory].filter(Boolean).map(rootKey))];
  async function protectCanonicalRoots() {
    for (const directory of [profileDir, dshHome, controller.store.directory].filter(Boolean)) {
      try { const real = rootKey(await fs.realpath(directory)); if (!protectedRoots.includes(real)) protectedRoots.push(real); }
      catch (error) { if (error.code !== 'ENOENT') throw settingsFailure('SETTINGS_CORRUPT', '无法确认 DSH 受保护目录'); }
    }
  }
  const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  function protectedExclusions(root) {
    const key = rootKey(root);
    if (protectedRoots.some(item => isInside(key, item))) throw settingsFailure('PROJECT_UNAVAILABLE', 'DSH 配置、账号和同步状态目录不能作为同步项目');
    return protectedRoots.filter(item => isInside(item, key)).map(item => path.relative(key, item).split(path.sep).join('/'));
  }
  let preferences, loading;
  const registry = () => {
    const value = ctx.workspaceRegistry || ctx.get?.('workspaceRegistry');
    if (!value || typeof value.list !== 'function' || typeof value.get !== 'function') throw settingsFailure('PROJECTS_UNAVAILABLE', '当前宿主未提供项目列表');
    return value;
  };
  function listedWorkspaces() {
    const entries = registry().list();
    if (!Array.isArray(entries)) throw settingsFailure('PROJECTS_UNAVAILABLE', '当前宿主项目列表不可用');
    // Native entities are projected to known non-secret fields; never expose sessionIds.
    return entries.filter(item => validWorkspaceId(item.id) && typeof item.path === 'string' && item.path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(item.path) && path.isAbsolute(item.path)).map(item => ({ id: item.id, root: path.resolve(item.path), label: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 200).replace(/[\x00-\x1f\x7f]/g, ' ') : path.basename(item.path) || item.path }));
  }
  function seed() {
    const workspaces = listedWorkspaces();
    const bindings = base.projects.map(item => ({ workspaceId: workspaces.find(workspace => rootKey(workspace.root) === rootKey(item.root))?.id || `legacy:${item.id}`, projectId: item.id, root: item.root }));
    return validatePreferences({ version: 1, revision: 0, ...(base.server ? { server: base.server } : {}), ...(base.username ? { username: base.username } : {}), autoSync: base.autoSync, intervalMs: base.intervalMs, bindings, selected: bindings.map(item => item.workspaceId) });
  }
  function apply(value) {
    preferences = value;
    controller.replaceConfiguration({ server: value.server, username: value.username, autoSync: value.autoSync, intervalMs: value.intervalMs, projects: value.bindings.filter(item => value.selected.includes(item.workspaceId)).map(item => ({ id: item.projectId, workspaceId: item.workspaceId, root: item.root })) });
  }
  async function initialize() {
    if (loading) return loading;
    loading = (async () => {
      await controller.store.init();
      await protectCanonicalRoots();
      let saved;
      try { saved = await readBoundedJson(filename); if (saved !== undefined) saved = validatePreferences(saved); }
      catch { throw settingsFailure('SETTINGS_CORRUPT', '同步设置无法安全读取，已停止自动同步；请先检查本机状态目录'); }
      apply(saved !== undefined ? saved : preferences || seed());
    })();
    try { await loading; } finally { loading = undefined; }
  }
  async function persist(value) {
    const normalized = validatePreferences(value), text = JSON.stringify(normalized, null, 2);
    requireValue(Buffer.byteLength(text) <= 1024 * 1024, '同步设置过大');
    await atomicWrite(filename, text); apply(normalized);
  }
  async function available(root) {
    try { protectedExclusions(root); await assertNoSymlinks(root); return (await fs.stat(root)).isDirectory(); } catch { return false; }
  }
  async function projectRows() {
    const current = listedWorkspaces(), selected = new Set(preferences.selected), result = [];
    const byId = new Map(current.map(item => [item.id, item]));
    for (const item of current) {
      const binding = preferences.bindings.find(saved => saved.workspaceId === item.id);
      const moved = binding && rootKey(binding.root) !== rootKey(item.root);
      const usable = !moved && await available(item.root);
      result.push({ id: item.id, label: item.label, root: item.root, selected: selected.has(item.id), available: Boolean(usable), ...(binding ? { projectId: binding.projectId } : {}), ...(!usable ? { warning: moved ? '目录已变更' : '目录不可用' } : {}) });
    }
    for (const id of preferences.selected) {
      if (byId.has(id)) continue;
      const item = preferences.bindings.find(binding => binding.workspaceId === id);
      result.push({ id, label: path.basename(item.root) || item.root, root: item.root, projectId: item.projectId, selected: true, available: false, warning: '项目已移除' });
    }
    return result;
  }
  async function cloudId(workspace, bindings) {
    const known = bindings.find(item => item.workspaceId === workspace.id && rootKey(item.root) === rootKey(workspace.root));
    if (known) return known.projectId;
    // A recreated workspace ID is a new consent boundary. Never adopt an old queue
    // merely because its directory spelling matches; explicit restored metadata is different.
    const restored = await readBoundedJson(path.join(workspace.root, '.dsh-sync', 'manifest.json'), MAX_MANIFEST_BYTES * 2);
    if (restored) return validateManifest(restored).projectId;
    return `project-${randomUUID()}`;
  }
  function recoveryBinding(input, fields) {
    requireValue(exact(input, ['revision', 'server', 'username', ...fields]) && Number.isSafeInteger(input.revision) && input.revision >= 0 && typeof input.server === 'string' && input.server.length <= 2048 && typeof input.username === 'string' && input.username.length > 0 && Buffer.byteLength(input.username) <= 128 && !/[\x00-\x1f\x7f]/.test(input.username));
    let server;
    try { server = validateServerUrl(input.server); } catch { throw settingsFailure('BAD_REQUEST', '服务器无效'); }
    requireValue(server === input.server);
    return async () => {
      await initialize();
      if (input.revision !== preferences.revision) throw settingsFailure('CONFIG_CONFLICT', '设置已变更');
      if (server !== preferences.server || input.username !== preferences.username) throw settingsFailure('ACCOUNT_MISMATCH', '账号已变更');
    };
  }
  async function admitDestination(destination, options) {
    // All registered roots are protected, not just the selected upload set.
    const roots = [...protectedRoots, ...listedWorkspaces().map(item => item.root), ...preferences.bindings.map(item => item.root)];
    return validateRestoreDestination(destination, roots, options);
  }
  const service = {
    filename,
    initialize,
    async admit(mapping) {
      // Called under the operation lock, including immediately before queueing a snapshot.
      await initialize();
      const selected = preferences.bindings.find(item => item.projectId === mapping.id && preferences.selected.includes(item.workspaceId));
      if (!selected || rootKey(selected.root) !== rootKey(mapping.root)) throw settingsFailure('PROJECT_NOT_SELECTED', '该项目已取消同步');
      const workspace = registry().get(selected.workspaceId);
      if (!workspace || typeof workspace.path !== 'string' || rootKey(workspace.path) !== rootKey(mapping.root) || !(await available(mapping.root))) throw settingsFailure('PROJECT_UNAVAILABLE', '项目目录已失效或变更，不会上传旧队列');
    },
    async status() {
      await initialize();
      const snapshot = preferences, projects = await projectRows(), state = await controller.status();
      if (snapshot.revision !== preferences.revision || snapshot.server !== preferences.server || snapshot.username !== preferences.username) throw settingsFailure('CONFIG_CONFLICT', '设置已变更');
      return { revision: snapshot.revision, server: snapshot.server || '', username: snapshot.username || '', loggedIn: state.loggedIn, ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}), autoSync: state.reauthRequired ? false : snapshot.autoSync, intervalMs: snapshot.intervalMs, projects, pending: state.pending, running: state.running, ...(state.recovery ? { recovery: state.recovery } : {}), ...(state.lastResult ? { lastResult: summarizeLastResult(state.lastResult) } : {}) };
    },
    async login(input, signal) {
      requireValue(exact(input, ['server', 'username', 'password']) && typeof input.server === 'string' && input.server.length <= 2048 && typeof input.username === 'string' && typeof input.password === 'string');
      const server = validateServerUrl(input.server.trim()), username = input.username.trim();
      await initialize();
      const result = await controller.login({ server, username, password: input.password, signal });
      return { ...await service.status(), ...(result.warning ? { warning: result.warning } : {}) };
    },
    async password(input, signal) {
      requireValue(exact(input, ['revision', 'server', 'username', 'currentPassword', 'newPassword']) && Number.isSafeInteger(input.revision) && input.revision >= 0 && typeof input.server === 'string' && input.server.length <= 2048 && typeof input.username === 'string');
      const server = validateServerUrl(input.server), secrets = validatePasswordChange(input);
      const checkBinding = async () => {
        await initialize();
        if (input.revision !== preferences.revision) throw settingsFailure('CONFIG_CONFLICT', '设置已变更');
        if (!preferences.server || server !== preferences.server || input.username !== preferences.username) throw settingsFailure('ACCOUNT_MISMATCH', '账号已变更');
      };
      await checkBinding();
      const before = await service.status();
      let result;
      try {
        result = await controller.changePassword({ server, ...secrets, signal }, {
          beforeChange: checkBinding,
          persistLogout: async () => persist({ ...preferences, revision: preferences.revision + 1, autoSync: false }),
        });
      } finally { secrets.currentPassword = ''; secrets.newPassword = ''; }
      let status, warning = result.warning;
      try { status = await service.status(); }
      catch { status = before; warning = '密码已修改，请重新登录'; }
      const { expiresAt, ...publicStatus } = status;
      return { ...publicStatus, loggedIn: false, autoSync: false, passwordChanged: true, ...(warning ? { warning } : {}) };
    },
    async savePreferences(input, signal) {
      requireValue(exact(input, ['revision', 'autoSync', 'projectIds']) && Number.isSafeInteger(input.revision) && input.revision >= 0 && typeof input.autoSync === 'boolean' && Array.isArray(input.projectIds) && input.projectIds.length <= MAX_PROJECTS && input.projectIds.every(validWorkspaceId) && new Set(input.projectIds).size === input.projectIds.length);
      await initialize();
      await controller.mutate(async () => {
        signal?.throwIfAborted();
        await initialize();
        if (input.revision !== preferences.revision) throw settingsFailure('CONFIG_CONFLICT', '设置已在其他窗口更新，请刷新后重新选择');
        if (input.autoSync && !(await controller.status()).loggedIn) throw settingsFailure('NOT_LOGGED_IN', '请先登录，再开启自动同步');
        const current = listedWorkspaces(), byId = new Map(current.map(item => [item.id, item])), bindings = preferences.bindings.map(item => ({ ...item }));
        for (const id of input.projectIds) {
          const workspace = byId.get(id), prior = bindings.find(item => item.workspaceId === id);
          const alreadySelected = preferences.selected.includes(id);
          if (!workspace || !(await available(workspace.root))) {
            if (alreadySelected && prior) continue; // Keep a dormant selection, never newly authorize it.
            throw settingsFailure('PROJECT_UNAVAILABLE', '所选项目不存在或目录不可安全读取，请刷新项目列表');
          }
          if (prior && rootKey(prior.root) !== rootKey(workspace.root)) throw settingsFailure('PROJECT_UNAVAILABLE', '项目根目录已变更，不允许静默重映射');
          if (!prior) {
            requireValue(bindings.length < 1000, '已记录的项目映射过多');
            bindings.push({ workspaceId: id, projectId: await cloudId(workspace, bindings), root: workspace.root });
          }
        }
        signal?.throwIfAborted();
        await persist({ ...preferences, revision: preferences.revision + 1, autoSync: input.autoSync, bindings, selected: [...input.projectIds] });
      });
      return service.status();
    },
    async projects(input, signal) {
      const checkBinding = recoveryBinding(input, []); await checkBinding();
      return controller.browse('projects', undefined, { checkBinding, signal });
    },
    async checkpoints(input, signal) {
      const checkBinding = recoveryBinding(input, ['projectId']); validateId(input.projectId); await checkBinding();
      return controller.browse('checkpoints', input.projectId, { checkBinding, signal });
    },
    async restore(input, signal) {
      const checkBinding = recoveryBinding(input, ['projectId', 'checkpointId', 'destination', 'confirm', 'requestId']);
      validateId(input.projectId); validateId(input.checkpointId); validateId(input.requestId); requireValue(input.confirm === true);
      if (typeof input.destination !== 'string' || !path.isAbsolute(input.destination) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(input.destination)) || input.destination.length > 4096 || /[\x00-\x1f\x7f]/.test(input.destination)) throw settingsFailure('BAD_DESTINATION', '恢复目录无效');
      await checkBinding();
      return controller.startRecovery('restore', { requestId: input.requestId, projectId: input.projectId, checkpointId: input.checkpointId, destination: input.destination }, { checkBinding, admitDestination, signal });
    },
    async import(input, signal) {
      const checkBinding = recoveryBinding(input, ['restoreId', 'confirm', 'requestId']);
      validateId(input.restoreId); validateId(input.requestId); requireValue(input.confirm === true); await checkBinding();
      return controller.startRecovery('import', { requestId: input.requestId, restoreId: input.restoreId }, { checkBinding, signal });
    },
    async sync(input = {}) {
      requireValue(exact(input, ['projectId']) && (input.projectId === undefined || validWorkspaceId(input.projectId)));
      await initialize(); return controller.scheduleSelected(input.projectId);
    },
    async logout(input = {}) {
      requireValue(exact(input, [])); await initialize();
      const result = await controller.logout({ persistLogout: async () => persist({ ...preferences, revision: preferences.revision + 1, autoSync: false }) });
      return { ...await service.status(), ...(result.warning ? { warning: result.warning } : {}) };
    },
  };
  controller.setInitializer(initialize); controller.setRootAdmission(mapping => service.admit(mapping));
  controller.setCaptureExclusions(mapping => protectedExclusions(mapping.root));
  controller.setRestoreAdmission(admitDestination);
  controller.setIdentityPersister(async (identity, { pauseAutoSync = false } = {}) => {
    const before = preferences;
    const changed = before.server !== identity.server || before.username !== identity.username;
    await persist({ ...before, ...identity, revision: before.revision + 1, autoSync: changed || pauseAutoSync ? false : before.autoSync });
    return async () => persist({ ...before, revision: preferences.revision + 1 });
  });
  return service;
}
