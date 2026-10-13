import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClientPlugin } from '../client/adapter.mjs';
import { CLIENT_ACTIONS, createConnectionTransport, createController } from '../client/state.mjs';
import * as accountModule from '../client/state.mjs';

// Mounted synthetic Host React/Connection contracts, including the actual child panel.
// No browser, real GUI, installed profile, server, filesystem sync or native installation.
const account = { server: 'https://synthetic.example.test', username: 'synthetic-owner', loggedIn: true };
const candidate = { id: 'candidate-one', version: '0.10.0', commit: 'a'.repeat(40), checkedAt: '2026-03-01T12:00:00.000Z' };
const update = extra => ({ currentVersion: '0.9.0', supported: true, state: 'idle', restartRequired: false, ...extra });
const project = { id: 'workspace:legacy', projectId: 'legacy-cloud', label: 'LEGACY_SELECTED_ONLY', root: 'E:\\synthetic\\legacy', selected: true, available: true };
const status = extra => ({ revision: 4, ...account, autoSync: false, intervalMs: 60000, projects: [project], pending: 0, running: false, update: update(), ...extra });
const workspace = { id: 'workspace:pair', label: 'Synthetic workspace', root: 'E:\\synthetic\\pair', available: true };
const syncStatus = extra => ({ revision: 7, ...account, capability: 'supported', running: false, workspaces: [workspace], bindings: [], operations: [], ...extra });
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted secret echo' } });
const deferred = () => Promise.withResolvers();
const submit = form => form.props.onSubmit({ preventDefault() {} });
async function settle() { for (let i = 0; i < 60; ++i) await Promise.resolve(); }

function nodes(root) {
  if (!root || typeof root !== 'object') return [];
  return [root, ...nodes(root.rendered), ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)];
}
function text(root) {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (!root || typeof root !== 'object') return '';
  return [root.rendered, ...(root.props?.children ?? []), root.props?.footer].map(text).join(' ');
}
function find(root, predicate, label) { const found = nodes(root).find(predicate); assert.ok(found, `missing ${label}`); return found; }
const button = (root, label) => find(root, node => node.type === 'native:Button' && text(node).trim() === label, label);
const card = (root, name) => find(root, node => node.props?.['data-personal-sync'] === name, name);
const modal = (root, title) => find(root, node => node.type === 'native:Modal' && node.props.title === title, title);
const input = (root, suffix) => find(root, node => node.type === 'native:Input' && node.props.id?.endsWith(`-${suffix}`), suffix);
const form = root => find(root, node => node.type === 'form', 'form');
const panel = root => find(root, node => typeof node.type === 'function' && node.type.name === 'BidirectionalPanel', 'actual BidirectionalPanel');
const checkbox = (root, label) => find(root, node => node.type === 'native:Checkbox' && node.props.label === label, label);
const actions = page => page.calls.map(call => call.action);
function noLegacySurface(tree) {
  assert.equal(nodes(tree).some(node => ['legacy-actions', 'projects-summary', 'cloud-summary', 'recovery-result'].includes(node.props?.['data-personal-sync'])), false);
  assert.equal(nodes(tree).some(node => node.type === 'native:Modal' && /下载|管理同步项目|文件夹|导入安全会话/.test(node.props.title)), false);
  const targets = nodes(tree).filter(node => node.type === 'native:Button').map(node => text(node).trim());
  for (const label of ['管理', '选择项目', '选择下载项目', '管理下载项目', '保存位置', '下载所选', '确认下载', '查看下载进度', '选择此文件夹', '添加到DSH项目', '导入安全会话', '保存', '撤销更改', '全选可用项目', '全部取消']) assert.equal(targets.includes(label), false, label);
  assert.doesNotMatch(text(tree), /备份与恢复（高级）|仅同步所选项目|所选下载项目|待重试|LEGACY_SELECTED_ONLY|LEGACY_RESULT_ONLY/);
}

/** Each function component owns separate hook cells; commit mounts nested effects and refs. */
function mountedReact() {
  const instances = new Map(), attached = new Map();
  let active, effects = [], id = 0;
  const cell = (kind, initial) => {
    const index = active.cursor++;
    return active.cells[index] ??= { kind, value: initial() };
  };
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useRef(value) { return cell('ref', () => ({ current: value })).value; },
    useState(value) { const item = cell('state', () => value); return [item.value, next => { item.value = typeof next === 'function' ? next(item.value) : next; }]; },
    useId() { return cell('id', () => `synthetic-${++id}`).value; },
    useSyncExternalStore(subscribe, getSnapshot) { React.useEffect(() => subscribe(() => {}), [subscribe]); return getSnapshot(); },
    useEffect(effect, deps) {
      const item = cell('effect', () => ({ deps: null, cleanup: undefined })).value;
      if (!item.deps || deps.some((value, at) => value !== item.deps[at])) {
        item.deps = deps;
        effects.push(() => { item.cleanup?.(); item.cleanup = effect(); });
      }
    },
  };
  function render(node, path) {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      let instance = instances.get(path);
      if (!instance) { instance = { cells: [], cursor: 0 }; instances.set(path, instance); }
      instance.cursor = 0; const previous = active; active = instance;
      const rendered = node.type(node.props); active = previous;
      return { ...node, rendered: render(rendered, `${path}/component`) };
    }
    return { ...node, props: { ...node.props, children: node.props.children.map((child, index) => render(child, `${path}/${index}`)), ...(node.props.footer ? { footer: render(node.props.footer, `${path}/footer`) } : {}) } };
  }
  return {
    React, instances,
    tree(Component, props) {
      const tree = render(React.createElement(Component, props), 'root');
      const live = new Set();
      for (const node of nodes(tree)) {
        const ref = node.props?.ref;
        if (!ref || node.type !== 'native:Input') continue;
        live.add(ref);
        if (!attached.has(ref)) attached.set(ref, { value: '', focusCount: 0, focus() { ++this.focusCount; } });
        ref.current = attached.get(ref);
      }
      for (const [ref] of attached) if (!live.has(ref)) { ref.current = null; attached.delete(ref); }
      return tree;
    },
    commit() { const pending = effects; effects = []; for (const effect of pending) effect(); },
    unmount() { for (const instance of instances.values()) for (const item of instance.cells) if (item.kind === 'effect') { item.value.cleanup?.(); item.value.cleanup = undefined; } },
  };
}
function setup(t, { current = status(), synced = syncStatus(), handle } = {}) {
  const hooks = mountedReact(), calls = [], required = [], cleanups = [], events = new Map();
  const env = { current, synced };
  const connection = { rpc: { async call(channel, endpoint, payload, signal) {
    const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call);
    assert.equal(channel, '/api'); assert.equal(endpoint, `dsh-personal-sync/${call.action}`);
    if (handle) { const result = handle(call, env); if (result !== undefined) return result; }
    if (call.action === 'status') return ok(env.current);
    if (call.action === 'syncstatus') return ok(env.synced);
    throw new Error(`Unexpected public action: ${call.action}`);
  } } };
  const primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const plugin = createClientPlugin(name => { required.push(name); if (name === 'react') return hooks.React; assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives'); return primitives; });
  let slot;
  plugin.apply({ connection, effect(fn) { cleanups.push(fn()); }, on(name, handler) { events.set(name, handler); }, slots: {
    inject(name, register) { assert.equal(name, 'settings.section'); register(); },
    register(spec, Component) { slot = { spec, Component, props: spec.inject() }; },
  } });
  const page = { ...hooks, env, calls, required, connection, events, slot, plugin, controller: slot.props.controller, tree: () => hooks.tree(slot.Component, slot.props),
    async flush() { let tree; for (let index = 0; index < 8; index++) { tree = this.tree(); hooks.commit(); await settle(); } return this.tree(); },
  };
  t.after(() => { hooks.unmount(); cleanups.forEach(cleanup => cleanup?.()); });
  return page;
}
function fillPasswords(root, values = [' synthetic current ', ' synthetic new password ', ' synthetic new password ']) {
  const fields = nodes(root).filter(node => node.type === 'native:Input' && node.props.type === 'password');
  assert.equal(fields.length, values.length);
  return fields.map((field, index) => {
    for (const key of ['value', 'defaultValue', 'onChange']) assert.equal(Object.hasOwn(field.props, key), false);
    assert.equal(field.props.autoComplete, 'off');
    const element = field.props.ref.current; element.value = values[index]; return element;
  });
}
const cleared = elements => elements.forEach(element => assert.equal(element.value, ''));

test('public account transport exposes only auth/status/updater actions and rejects removed one-way RPC names', async () => {
  assert.deepEqual(CLIENT_ACTIONS, ['status', 'login', 'password', 'logout', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']);
  assert.equal(Object.isFrozen(CLIENT_ACTIONS), true);
  const calls = [];
  const transport = createConnectionTransport({ rpc: { async call(...args) { calls.push(args); return ok({}); } } });
  for (const action of ['preferences', 'sync', 'projects', 'checkpoints', 'destinationpick', 'destinationbrowse', 'destinationselect', 'restore', 'import', 'downloadpick', 'downloadbrowse', 'downloadselect', 'downloadstart', 'registerproject']) {
    await assert.rejects(() => transport(action, {}), { code: 'BAD_REQUEST' }, action);
  }
  assert.equal(calls.length, 0, 'removed actions must fail before crossing the Host connection');
});

test('account controller has no legacy method/parser/state backdoor or automatic work from old records', async t => {
  const calls = [], timers = new Map(); let timerId = 0;
  const controller = createController({ rpc: { async call(_channel, endpoint) { calls.push(endpoint); return ok(status({ autoSync: true, pending: 99, projects: 'obsolete-format', download: { state: 'running' }, recovery: null })); } } }, {
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  t.after(() => controller.dispose());
  assert.deepEqual(Object.keys(controller).sort(), ['getSnapshot', 'subscribe', 'refresh', 'refreshIfWatching', 'watch', 'checkUpdate', 'prepareUpdate', 'confirmUpdate', 'cancelUpdate', 'refreshUpdate', 'cancelUpdateIntent', 'login', 'changePassword', 'cancelPasswordChange', 'logout', 'dispose'].sort());
  for (const name of ['validatePreferences', 'filterProjects', 'parseCloudProjects', 'parseCheckpoints', 'parseRecovery', 'parseProjectRegistration', 'parseDestination', 'parseDirectoryBrowser', 'parseDownloadPlan', 'parseDownloadStatus']) assert.equal(Object.hasOwn(accountModule, name), false, name);
  assert.equal(calls.length, 0);
  const stop = controller.watch(); await settle();
  assert.deepEqual(calls, ['dsh-personal-sync/status']); assert.equal(timers.size, 0);
  const snapshot = controller.getSnapshot();
  for (const name of ['draft', 'dirty', 'conflict', 'scheduled', 'cloud', 'downloadSelection', 'downloadIntent', 'recoveryPending', 'downloadPending', 'registrationResults']) assert.equal(Object.hasOwn(snapshot, name), false, name);
  for (const name of ['autoSync', 'projects', 'pending', 'download', 'recovery', 'intervalMs', 'lastResult']) assert.equal(Object.hasOwn(snapshot.status, name), false, name);
  assert.equal(snapshot.ready, true); stop(); assert.equal(timers.size, 0);
});

test('watched account busy guard reconciles v2 work completion without reviving legacy polling or writes', async t => {
  const calls = [], timers = new Map(); let timerId = 0, running = true;
  const controller = createController({ rpc: { async call(_channel, endpoint) {
    calls.push(endpoint);
    return ok(status({ running, autoSync: true, pending: 99, update: update({ state: 'available', candidate }) }));
  } } }, {
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  t.after(() => controller.dispose());
  const stop = controller.watch(); await settle();
  assert.equal(accountModule.deriveView(controller.getSnapshot()).canUpdate, false);
  assert.equal(accountModule.deriveView(controller.getSnapshot()).canLogin, false);
  assert.deepEqual(calls, ['dsh-personal-sync/status']); assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0]; assert.equal(timer.ms, 3000);
  running = false; timers.delete(id); timer.fn(); await settle();
  assert.equal(accountModule.deriveView(controller.getSnapshot()).canUpdate, true);
  assert.equal(accountModule.deriveView(controller.getSnapshot()).canLogin, true);
  assert.deepEqual(calls, ['dsh-personal-sync/status', 'dsh-personal-sync/status']);
  assert.equal(timers.size, 0, 'an idle account with old queued uploads must not keep polling');
  stop();
});

test('account busy reconciliation stops on read failure and unmount, without retrying mutations', async t => {
  for (const mode of ['read-failure', 'unmount']) {
    const calls = [], timers = new Map(); let timerId = 0;
    const controller = createController({ rpc: { async call(_channel, endpoint) {
      calls.push(endpoint);
      if (calls.length > 1) throw new Error('synthetic read failure');
      return ok(status({ running: true }));
    } } }, {
      setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    });
    t.after(() => controller.dispose());
    const stop = controller.watch(); await settle();
    assert.equal(timers.size, 1); const [id, timer] = [...timers][0];
    if (mode === 'unmount') stop();
    timers.delete(id); timer.fn(); await settle();
    assert.equal(timers.size, 0);
    assert.equal(calls.length, mode === 'unmount' ? 1 : 2);
    assert.ok(calls.every(endpoint => endpoint === 'dsh-personal-sync/status'));
    if (mode === 'read-failure') assert.equal(controller.getSnapshot().ready, false);
    stop();
  }
});

// The call allowlist also proves removal of dead handlers, not just visually hidden cards.
test('settings source has only auth/status/update controller calls and Host controls, with no old layout helpers', async () => {
  const source = await readFile(new URL('../client/adapter.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(/\r?\n/)[0], "import { createController, deriveView } from './state.mjs';");
  assert.doesNotMatch(source, /filterProjects|folderIcon|IconFolder|projectManagerOpen|cloudOpen|downloadSelection|downloadIntent|registrationControl|recoveryResult|legacy-actions|summaryList/);
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|sessionStorage|dangerouslySetInnerHTML|innerHTML|display:\s*['"]none/);
  const allowed = new Set(['subscribe', 'getSnapshot', 'watch', 'cancelPasswordChange', 'login', 'changePassword', 'logout', 'refresh', 'prepareUpdate', 'checkUpdate', 'cancelUpdateIntent', 'confirmUpdate', 'dispose', 'refreshIfWatching']);
  for (const [, method] of source.matchAll(/\bcontroller\.(\w+)/g)) assert.ok(allowed.has(method), `unexpected legacy method ${method}`);
});

test('mounted settings read local status only and expose exactly account, actual bidirectional panel and updater', async t => {
  const page = setup(t, { current: status({ loggedIn: false }), synced: syncStatus({ loggedIn: false }) });
  assert.equal(page.calls.length, 0); page.tree(); assert.equal(page.calls.length, 0);
  const tree = await page.flush();
  assert.deepEqual(page.required, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.deepEqual(page.plugin.inject, ['slots', 'connection']); assert.equal(page.slot.spec.id, 'dsh-personal-sync');
  assert.deepEqual(tree.rendered.props.children.filter(node => node && (node.type === 'section' || typeof node.type === 'function')).map(node => typeof node.type === 'function' ? node.type.name : node.props['data-personal-sync']), ['account-summary', 'BidirectionalPanel', 'update-summary']);
  assert.equal(panel(tree).props.connection, page.connection);
  assert.deepEqual(panel(tree).props.identity, { ...account, loggedIn: false });
  assert.equal(nodes(tree).filter(node => node.props?.['data-personal-sync'] === 'bidirectional').length, 1);
  assert.ok(actions(page).includes('status')); assert.ok(actions(page).includes('syncstatus'));
  assert.ok(page.calls.every(call => ['status', 'syncstatus'].includes(call.action) && Object.keys(call.payload).length === 0));
  noLegacySurface(tree);
  assert.equal(nodes(card(tree, 'account-summary')).filter(node => node.type === 'native:Checkbox').length, 1);
  assert.equal(nodes(card(tree, 'account-summary')).some(node => node.type === 'native:Switch'), false);
  const before = page.calls.length; page.events.get('connection/reset')(); await page.flush();
  assert.ok(page.calls.length > before); assert.ok(actions(page).every(action => ['status', 'syncstatus'].includes(action)));
});

test('legacy autoSync true, selections, queue, recovery and unknown status data cannot revive one-way UI or writes', async t => {
  const legacy = status({ autoSync: true, pending: 43, lastResult: { at: '2026-03-01T12:00:00.000Z', ok: true, message: 'LEGACY_RESULT_ONLY' },
    recovery: { id: 'old-restore', kind: 'restore', state: 'succeeded', root: 'E:\\synthetic\\old-restore', sessionCount: 3 },
    download: { id: 'old-download', state: 'succeeded', completed: 1, total: 1, items: [{ projectId: 'old-cloud', checkpointId: 'old-checkpoint', restoreId: 'old-restore', root: 'E:\\synthetic\\old-download', label: 'OLD_DOWNLOAD_ONLY', state: 'succeeded', canImport: true, sessionCount: 3 }] },
    legacyUploadEnabled: true, oldBackupActions: ['upload', 'restore'], selectedCount: 9, token: 'never-display-secret' });
  const page = setup(t, { current: legacy });
  let tree = await page.flush();
  assert.equal(Object.hasOwn(page.controller.getSnapshot().status, 'autoSync'), false, 'legacy records stay on the Host, not in the account client');
  assert.equal(legacy.autoSync, true, 'reading must not rewrite old Host records');
  noLegacySurface(tree);
  assert.doesNotMatch(text(tree), /OLD_DOWNLOAD_ONLY|old-restore|old-download|never-display-secret/);
  assert.doesNotMatch(text(card(tree, 'account-summary')), /项目|待上传|待下载|待重试|已选择|43|队列/);
  assert.equal(nodes(tree).some(node => node.type === 'native:Switch'), false);
  assert.equal(button(tree, '检查更新').props.disabled, false);
  button(tree, '刷新').props.onClick(); tree = await page.flush(); noLegacySurface(tree);
  assert.ok(actions(page).every(action => ['status', 'syncstatus'].includes(action)));
});

test('the sole project flow mounts and completes bidirectional preview/confirmation through the original panel', async t => {
  const page = setup(t, { handle(call, env) {
    if (call.action === 'syncprojects') return ok({ projects: [] });
    if (call.action === 'pairplan') return ok({ plan: { id: 'pair-plan', root: workspace.root, projectId: 'new-cloud', label: workspace.label, expiresAt: new Date(Date.now() + 60000).toISOString(), summary: { upload: 1, download: 0, delete: 0, conflicts: 0, blocked: 0 } } });
    if (call.action === 'paircommit') { env.synced = syncStatus({ operations: [{ id: call.payload.requestId, kind: 'pair', state: 'succeeded' }] }); return ok({ accepted: true, operationId: call.payload.requestId }); }
  } });
  await page.flush(); button(page.tree(), '配对项目').props.onClick(); await page.flush();
  let dialog = modal(page.tree(), '配对同步项目');
  assert.equal(checkbox(dialog, workspace.label).props.checked, false);
  assert.equal(checkbox(dialog, '创建新的云端项目').props.checked, false);
  checkbox(dialog, workspace.label).props.onChange(true);
  checkbox(modal(page.tree(), '配对同步项目'), '创建新的云端项目').props.onChange(true);
  button(page.tree(), '预览变更').props.onClick(); await page.flush();
  dialog = modal(page.tree(), '确认启用双向同步'); assert.equal(dialog.props.open, true);
  assert.equal(actions(page).includes('paircommit'), false);
  const confirm = button(dialog, '确认并启用').props.onClick; confirm(); confirm(); await page.flush();
  assert.equal(actions(page).filter(action => action === 'paircommit').length, 1);
  assert.ok(actions(page).includes('pairplan'));
  assert.ok(actions(page).every(action => ['status', 'syncstatus', 'syncprojects', 'pairplan', 'paircommit'].includes(action)));
  noLegacySurface(page.tree());
});

test('optional remember, uncontrolled login, readonly connected server and confirmed logout still work without legacy calls', async t => {
  for (const remember of [false, true]) {
    const page = setup(t, { current: status({ loggedIn: false }), synced: syncStatus({ loggedIn: false }), handle(call, env) {
      if (call.action === 'login' || call.action === 'logout') { env.current = status({ revision: env.current.revision + 1, loggedIn: call.action === 'login' }); env.synced = syncStatus({ loggedIn: env.current.loggedIn }); return ok(env.current); }
    } });
    await page.flush();
    const rememberControl = find(page.tree(), node => node.props?.['data-personal-sync'] === 'remember-device', 'remember');
    assert.equal(rememberControl.props.checked, false); if (remember) rememberControl.props.onChange(true);
    const tree = page.tree(), elements = fillPasswords(card(tree, 'account-summary'), [' exact synthetic login ']);
    submit(form(card(tree, 'account-summary'))); cleared(elements); await page.flush();
    assert.deepEqual(page.calls.find(call => call.action === 'login').payload, { server: account.server, username: account.username, password: ' exact synthetic login ', ...(remember ? { remember: true } : {}) });
    const connected = card(page.tree(), 'account-summary');
    assert.equal(nodes(connected).some(node => node.type === 'native:Input'), false);
    assert.equal(text(find(connected, node => node.props['aria-label'] === '已连接服务器', 'readonly server')).trim(), account.server);
    assert.match(text(connected), /synthetic-owner/);
    button(connected, '退出登录').props.onClick(); const logoutModal = modal(page.tree(), '退出登录？');
    assert.equal(logoutModal.props.open, true); assert.equal(actions(page).includes('logout'), false);
    const confirm = button(logoutModal, '退出登录').props.onClick; confirm(); confirm(); await page.flush();
    assert.deepEqual(page.calls.find(call => call.action === 'logout').payload, {});
    assert.equal(actions(page).filter(action => action === 'logout').length, 1);
    assert.equal(input(card(page.tree(), 'account-summary'), 'password').props.ref.current.value, '');
    assert.equal(find(page.tree(), node => node.props?.['data-personal-sync'] === 'remember-device', 'remember').props.checked, false);
    assert.ok(actions(page).every(action => ['status', 'syncstatus', 'login', 'logout'].includes(action)));
    noLegacySurface(page.tree());
  }
});

test('password form preserves saved identity, local validation, uncontrolled secrets and one explicit non-replayed write', async t => {
  const pending = deferred();
  const page = setup(t, { current: status({ loggedIn: false }), synced: syncStatus({ loggedIn: false }), handle(call) { if (call.action === 'password') return pending.promise; } });
  await page.flush();
  input(page.tree(), 'server').props.onChange({ target: { value: 'https://typed.example.test' } });
  input(page.tree(), 'username').props.onChange({ target: { value: 'typed-owner' } });
  button(page.tree(), '修改密码').props.onClick();
  let dialog = modal(page.tree(), '修改密码');
  let elements = fillPasswords(dialog, ['old synthetic password', 'new synthetic password', 'mismatch synthetic password']);
  submit(form(dialog)); cleared(elements); await page.flush();
  assert.equal(actions(page).includes('password'), false); assert.match(text(modal(page.tree(), '修改密码')), /两次新密码不一致/);
  dialog = modal(page.tree(), '修改密码'); elements = fillPasswords(dialog);
  submit(form(dialog)); submit(form(dialog)); cleared(elements);
  assert.deepEqual(page.calls.find(call => call.action === 'password').payload, { revision: 4, server: account.server, username: account.username, currentPassword: ' synthetic current ', newPassword: ' synthetic new password ' });
  assert.equal(actions(page).filter(action => action === 'password').length, 1);
  assert.doesNotMatch(JSON.stringify(page.controller.getSnapshot()), /synthetic current|synthetic new password|mismatch synthetic password/);
  for (const instance of page.instances.values()) for (const cell of instance.cells.filter(cell => cell.kind === 'state')) assert.doesNotMatch(JSON.stringify(cell.value), /synthetic current|synthetic new password/);
  pending.resolve(ok(status({ revision: 5, loggedIn: false }))); await page.flush();
  assert.equal(modal(page.tree(), '修改密码').props.open, false); assert.match(text(page.tree()), /密码已修改，请重新登录/);
  assert.equal(button(page.tree(), '登录').props.disabled, false);
  assert.ok(actions(page).every(action => ['status', 'syncstatus', 'password'].includes(action)));
});

test('secrets clear immediately on destination/dirty/identity/runtime/logout/blur/unmount and stale dialogs cannot target a new account', async t => {
  const page = setup(t, { current: status({ loggedIn: false }), synced: syncStatus({ loggedIn: false }) });
  await page.flush();
  let element = fillPasswords(card(page.tree(), 'account-summary'), ['synthetic login secret'])[0];
  input(page.tree(), 'username').props.onChange({ target: { value: 'dirty login destination' } }); cleared([element]);
  button(page.tree(), '修改密码').props.onClick();
  let dialog = modal(page.tree(), '修改密码'), elements = fillPasswords(dialog);
  input(page.tree(), 'server').props.onChange({ target: { value: 'https://dirty.example.test' } }); cleared(elements);
  assert.equal(modal(page.tree(), '修改密码').props.open, false);
  assert.ok(actions(page).every(action => ['status', 'syncstatus'].includes(action)));
  for (const patch of [{ server: 'https://next.example.test' }, { username: 'next-owner' }, { revision: 8 }, { update: update({ currentVersion: '0.9.1' }) }]) {
    button(page.tree(), '修改密码').props.onClick(); dialog = modal(page.tree(), '修改密码'); elements = fillPasswords(dialog);
    const staleSubmit = form(dialog);
    page.env.current = { ...page.env.current, ...patch }; await page.controller.refresh(); cleared(elements);
    await page.flush(); assert.equal(modal(page.tree(), '修改密码').props.open, false);
    button(page.tree(), '修改密码').props.onClick(); elements = fillPasswords(modal(page.tree(), '修改密码'));
    submit(staleSubmit); cleared(elements); assert.equal(actions(page).includes('password'), false);
    modal(page.tree(), '修改密码').props.onClose();
  }
  page.env.current = status({ revision: 9 }); page.env.synced = syncStatus(); await page.controller.refresh(); await page.flush();
  button(page.tree(), '修改密码').props.onClick(); elements = fillPasswords(modal(page.tree(), '修改密码'));
  button(card(page.tree(), 'account-summary'), '退出登录').props.onClick(); cleared(elements);
  const staleLogout = button(modal(page.tree(), '退出登录？'), '退出登录').props.onClick;
  page.env.current = status({ revision: 10, username: 'other-owner' }); await page.controller.refresh(); await page.flush();
  button(card(page.tree(), 'account-summary'), '退出登录').props.onClick(); staleLogout();
  assert.equal(actions(page).includes('logout'), false);
  button(page.tree(), '修改密码').props.onClick(); dialog = modal(page.tree(), '修改密码'); elements = fillPasswords(dialog);
  form(dialog).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); cleared(elements);
  elements = fillPasswords(dialog); page.unmount(); cleared(elements);
  assert.equal(actions(page).includes('password'), false);
});

test('uncertain password result restores empty login and only reconciles status, never replays on reset or stale submit', async t => {
  const page = setup(t, { handle(call) { if (call.action === 'password') return failure('PASSWORD_CHANGE_UNCERTAIN'); } });
  await page.flush(); button(page.tree(), '修改密码').props.onClick();
  const dialog = modal(page.tree(), '修改密码'), elements = fillPasswords(dialog), stale = form(dialog);
  submit(stale); cleared(elements); await page.flush();
  assert.equal(page.controller.getSnapshot().status.loggedIn, false);
  assert.match(text(page.tree()), /结果未确认，请重新登录/);
  assert.equal(input(page.tree(), 'password').props.ref.current.value, '');
  submit(stale); page.events.get('connection/reset')(); await page.flush();
  assert.equal(actions(page).filter(action => action === 'password').length, 1);
  assert.ok(actions(page).every(action => ['status', 'syncstatus', 'password'].includes(action)));
  assert.equal(page.controller.getSnapshot().status.loggedIn, false);
});

test('bidirectional auth recovery refreshes the account card without credential replay and retains the explicit login CTA', async t => {
  let accountReads = 0;
  const page = setup(t, { synced: syncStatus({ loggedIn: false }), handle(call, env) {
    if (call.action === 'status') return ok(++accountReads === 1 ? env.current : status({ loggedIn: false, reauthRequired: true, authState: 'reauth-required' }));
  } });
  await page.flush();
  assert.ok(accountReads >= 2, 'the actual child requests a parent status read after rejecting the saved identity');
  assert.equal(page.controller.getSnapshot().status.loggedIn, false);
  assert.equal(button(page.tree(), '登录').props.disabled, false);
  const secret = input(page.tree(), 'password').props.ref.current; secret.value = 'unsent recovery secret';
  const before = page.calls.length; button(page.tree(), '前往登录').props.onClick(); await page.flush();
  assert.equal(secret.value, ''); assert.ok(secret.focusCount > 0);
  assert.ok(page.calls.length > before); assert.ok(actions(page).every(action => ['status', 'syncstatus'].includes(action)));
});

test('native updater keeps explicit fixed-candidate confirmation, duplicate/stale guards, approval errors and restart gates', async t => {
  const pending = deferred();
  const page = setup(t, { handle(call, env) {
    if (call.action === 'checkupdate') { env.current = { ...env.current, update: update({ state: 'available', candidate }) }; return ok({ update: env.current.update }); }
    if (call.action === 'updatestatus') return ok({ update: env.current.update });
    if (call.action === 'installupdate') return pending.promise;
  } });
  await page.flush(); button(page.tree(), '检查更新').props.onClick(); await page.flush();
  assert.deepEqual(page.calls.find(call => call.action === 'checkupdate').payload, {});
  button(page.tree(), '手动更新').props.onClick();
  let dialog = modal(page.tree(), '确认更新插件？'); assert.equal(dialog.props.open, true);
  assert.equal(page.controller.getSnapshot().updateIntent.commit, candidate.commit);
  assert.equal(text(dialog).includes(candidate.commit), false);
  const oldConfirm = button(dialog, '确认更新').props.onClick;
  page.env.current = { ...page.env.current, update: update({ state: 'available', candidate: { ...candidate, id: 'candidate-next', commit: 'b'.repeat(40) } }) };
  await page.controller.refresh(); await page.flush(); oldConfirm(); await settle();
  assert.equal(actions(page).includes('installupdate'), false);
  button(page.tree(), '手动更新').props.onClick(); dialog = modal(page.tree(), '确认更新插件？');
  const pinned = page.controller.getSnapshot().updateIntent;
  assert.equal(pinned.commit, 'b'.repeat(40));
  const confirm = button(dialog, '确认更新').props.onClick; confirm(); confirm();
  assert.deepEqual(page.calls.find(call => call.action === 'installupdate').payload, { candidateId: 'candidate-next', requestId: pinned.requestId, confirm: true });
  page.env.current = { ...page.env.current, update: update({ state: 'installing', restartRequired: true, requestId: pinned.requestId, candidate: page.env.current.update.candidate }) };
  pending.resolve(ok({ update: page.env.current.update })); await page.flush();
  assert.equal(button(page.tree(), '更新中…').props.disabled, true);
  for (const label of ['修改密码', '退出登录']) assert.equal(button(card(page.tree(), 'account-summary'), label).props.disabled, true);
  page.env.current = { ...page.env.current, update: { ...page.env.current.update, state: 'failed', errorCode: 'UPDATE_BUILD_APPROVAL_REQUIRED' } };
  button(page.tree(), '刷新').props.onClick(); await page.flush();
  assert.match(text(page.tree()), /原生安装需要脚本审批/); assert.match(text(page.tree()), /请重启 DSH/);
  assert.equal(button(page.tree(), '待重启').props.disabled, true);
  assert.equal(button(card(page.tree(), 'account-summary'), '退出登录').props.disabled, false);
  assert.equal(button(card(page.tree(), 'account-summary'), '修改密码').props.disabled, true);
  assert.equal(actions(page).filter(action => action === 'installupdate').length, 1);
  assert.ok(actions(page).every(action => ['status', 'syncstatus', 'checkupdate', 'updatestatus', 'installupdate'].includes(action)));
  noLegacySurface(page.tree());
});
