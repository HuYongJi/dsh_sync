import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, deriveView, parseCloudProjects, parseCheckpoints, parseRecovery, parseStatus } from '../client/state.mjs';
import { createClientPlugin } from '../client/adapter.mjs';

// Synthetic Connection and React contracts only; no installation/profile or live GUI changes.
const binding = { revision: 3, server: 'https://synthetic.example.test', username: 'synthetic-user' };
const checkpoint = { id: 'checkpoint-one', projectId: 'project-one', deviceId: 'device-one', parentId: null, createdAt: '2026-01-01T00:00:00.000Z', fileCount: 4, totalBytes: 100 };
const branch = { ...checkpoint, id: 'checkpoint-two', deviceId: 'device-two' };
const listing = { checkpoints: [checkpoint, branch], heads: [checkpoint.id, branch.id] };
const cloudProjects = { projects: [{ projectId: checkpoint.projectId, checkpointCount: 2, latestCreatedAt: checkpoint.createdAt }] };
const destination = 'E:\\synthetic\\restored-new';
const status = (extra = {}) => ({ ...binding, loggedIn: true, running: false, autoSync: false, pending: 0, intervalMs: 60000,
  projects: [{ id: 'workspace:known', projectId: checkpoint.projectId, label: '本机已知名称', root: 'E:\\synthetic\\known', selected: false, available: true }], ...extra });
const recovery = (extra = {}) => ({ id: 'older-request', kind: 'restore', state: 'succeeded', root: destination, checkpointId: checkpoint.id, sessionCount: 2, ...extra });
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted-password-and-token', details: { token: 'untrusted-password-and-token' } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 30; ++i) await Promise.resolve(); }
function timers() {
  let id = 0; const jobs = new Map();
  return { jobs, setTimeout(fn, ms) { jobs.set(++id, { fn, ms }); return id; }, clearTimeout(key) { jobs.delete(key); },
    run(ms) { const entry = [...jobs].find(([, job]) => job.ms === ms); assert.ok(entry, `missing timer ${ms}`); jobs.delete(entry[0]); entry[1].fn(); } };
}
function connection(handler) {
  const calls = [];
  return { calls, connection: { rpc: { async call(channel, endpoint, payload, signal) {
    const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call); return handler(call);
  } } } };
}
function setup(t, handler, options = {}) {
  const mock = connection(handler); const clock = timers();
  const controller = createController(mock.connection, { ...clock, ...options });
  t.after(() => controller.dispose()); return { ...mock, clock, controller };
}
async function select(controller) {
  await controller.refresh();
  controller.setCloudProject(checkpoint.projectId);
  await controller.loadCheckpoints();
  assert.equal(controller.getSnapshot().cloud.checkpointId, '');
  controller.selectCheckpoint(branch.id);
  controller.setDestination(destination);
}
const readOnlyHandler = call => ok(call.action === 'projects' ? cloudProjects : call.action === 'checkpoints' ? listing : call.action === 'destinationpick' ? { destination: { id: 'destination-one', root: destination, parent: 'E:\\synthetic' } } : status());

test('recovery public parsers deeply allowlist, freeze and discard raw names, manifests and secret fields', () => {
  const projects = parseCloudProjects({ ...cloudProjects, token: 'secret', projects: [{ ...cloudProjects.projects[0], name: 'secret', root: 'secret' }] });
  const checkpoints = parseCheckpoints({ ...listing, checkpoints: [{ ...checkpoint, files: [{ password: 'secret' }], sourceRoot: 'secret', token: 'secret' }], heads: [checkpoint.id] }, checkpoint.projectId);
  const parsed = parseRecovery(recovery({ kind: 'import', token: 'secret', error: 'secret', sessions: [{ sourceId: 'source-one', sessionId: 'new-one', outcome: 'imported', workspaceAttached: false, error: 'secret' }] }));
  for (const item of [projects, projects[0], checkpoints, checkpoints.checkpoints, checkpoints.checkpoints[0], checkpoints.heads, parsed, parsed.sessions, parsed.sessions[0]]) assert.equal(Object.isFrozen(item), true);
  assert.equal(JSON.stringify([projects, checkpoints, parsed]).includes('secret'), false);
  assert.equal(parseStatus(status({ recovery: parsed })).recovery.sessions[0].workspaceAttached, false);
  assert.equal(Object.hasOwn(parseStatus(status()), 'recovery'), false);
});

test('recovery parsers reject malformed remote IDs, dates, counts, heads and secret error echoes', () => {
  for (const project of [null, { ...cloudProjects.projects[0], projectId: '../escape' }, { ...cloudProjects.projects[0], checkpointCount: -1 }, { ...cloudProjects.projects[0], latestCreatedAt: 'secret' }]) {
    assert.throws(() => parseCloudProjects({ projects: [project] }), error => error.code === 'INVALID_RESPONSE');
  }
  assert.throws(() => parseCloudProjects({ projects: [cloudProjects.projects[0], cloudProjects.projects[0]] }), /格式/);
  for (const patch of [{ id: '__proto__' }, { projectId: 'other-project' }, { parentId: checkpoint.id }, { parentId: '' }, { deviceId: 'secret/path' }, { createdAt: '2026-01-01' }, { fileCount: 1.5 }, { totalBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => parseCheckpoints({ checkpoints: [{ ...checkpoint, ...patch }], heads: [] }, checkpoint.projectId), error => error.code === 'INVALID_RESPONSE');
  }
  for (const heads of [['unknown'], [checkpoint.id, checkpoint.id], null]) assert.throws(() => parseCheckpoints({ checkpoints: [checkpoint], heads }, checkpoint.projectId), /格式/);
  for (const patch of [{ id: 'secret/path' }, { kind: 'upload' }, { state: 'done' }, { root: 'relative' }, { root: 'C:relative' }, { sessionCount: -1 }, { importedCount: -1 }, { errorCode: 'secret-token' }, { sessions: [{ sourceId: 'x', outcome: 'imported', sessionId: '../secret' }] }, { sessions: [{ sourceId: 'x', outcome: 'failed', workspaceAttached: 'false' }] }]) {
    assert.throws(() => parseRecovery(recovery(patch)), error => error.code === 'INVALID_RESPONSE');
  }
  assert.throws(() => parseStatus(status({ recovery: null })), /格式/);
});

test('recovery browse is explicit, saved-bound and old cloud manual project input works without projects success', async t => {
  const { controller, calls } = setup(t, call => call.action === 'projects' ? failure('CLOUD_BROWSE_UNSUPPORTED') : readOnlyHandler(call));
  await controller.refresh();
  assert.deepEqual(calls.map(call => call.action), ['status']);
  assert.equal(await controller.browseProjects(), false);
  assert.deepEqual(calls.at(-1).payload, binding);
  assert.equal(controller.getSnapshot().cloud.browseUnsupported, true);
  assert.equal(controller.getSnapshot().cloud.error.code, 'CLOUD_BROWSE_UNSUPPORTED');
  assert.equal(controller.setCloudProject(checkpoint.projectId), true);
  assert.equal(await controller.loadCheckpoints(), true);
  assert.deepEqual(calls.at(-1).payload, { ...binding, projectId: checkpoint.projectId });
  assert.equal(controller.getSnapshot().cloud.checkpoints.length, 2);
  assert.equal(controller.getSnapshot().cloud.checkpointId, '');
  assert.equal(controller.prepareRestore(), null);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-password'), false);
  assert.ok(calls.every(call => call.channel === '/api' && call.endpoint === `dsh-personal-sync/${call.action}`));
  assert.equal(calls.some(call => ['restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('recovery never automatically chooses a head or sends malformed IDs, paths or arbitrary import roots', async t => {
  const { controller, calls } = setup(t, readOnlyHandler);
  await controller.refresh();
  controller.setCloudProject('../bad');
  assert.equal(await controller.loadCheckpoints(), false);
  assert.equal(calls.length, 1);
  await select(controller);
  controller.selectCheckpoint('');
  assert.equal(controller.prepareRestore(), null);
  assert.equal(controller.selectCheckpoint('unknown'), false);
  controller.selectCheckpoint(checkpoint.id);
  for (const path of ['', 'relative', 'C:relative', '\\root-relative']) {
    controller.setDestination(path); assert.equal(controller.prepareRestore(), null); assert.equal(controller.getSnapshot().cloud.error.code, 'BAD_DESTINATION');
  }
  assert.equal(controller.prepareImport({ root: destination }), null);
  assert.equal(await controller.confirmRecovery({ kind: 'import', root: destination, restoreId: 'arbitrary' }), false);
  assert.equal(calls.some(call => ['restore', 'import'].includes(call.action)), false);
  for (const path of [destination, '/srv/synthetic/new', '\\\\synthetic-host\\share\\new']) {
    controller.setDestination(path); assert.ok(controller.prepareRestore()); controller.cancelRecoveryIntent();
  }
});

test('recovery UUID generation uses randomUUID, supports secure fallback, and fails closed for broken crypto', async t => {
  const uuid = 'a0000000-0000-4000-8000-000000000001';
  let generated = 0;
  const { controller } = setup(t, readOnlyHandler, { crypto: { randomUUID() { ++generated; return uuid; } } });
  await select(controller);
  const intent = controller.prepareRestore();
  assert.equal(intent.requestId, uuid);
  assert.equal(controller.prepareRestore(), intent);
  assert.equal(generated, 1);
  assert.equal(Object.isFrozen(intent), true);
  for (const crypto of [{}, { randomUUID: () => 'invalid' }, { randomUUID() { throw new Error('secret'); } }]) {
    const bad = setup(t, readOnlyHandler, { crypto }); await select(bad.controller);
    assert.equal(bad.controller.prepareRestore(), null); assert.equal(bad.controller.getSnapshot().cloud.error.code, 'BAD_REQUEST_ID');
  }
  const fallback = setup(t, readOnlyHandler, { crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } } });
  await select(fallback.controller);
  assert.match(fallback.controller.prepareRestore().requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('recovery restore consumes one confirmation, binds exact selection and polls Host completion without upload/import', async t => {
  let current = status(); const write = deferred();
  const { controller, calls, clock } = setup(t, call => call.action === 'restore' ? write.promise : call.action === 'status' ? ok(current) : readOnlyHandler(call));
  const close = controller.watch(); await settle(); await select(controller);
  const intent = controller.prepareRestore();
  const accepted = controller.confirmRecovery(intent);
  assert.equal(controller.getSnapshot().busy, 'restore');
  assert.equal(await controller.confirmRecovery(intent), false);
  assert.equal(controller.setDestination('/other/path'), false);
  assert.deepEqual(calls.at(-1).payload, { ...binding, projectId: checkpoint.projectId, checkpointId: branch.id, destination, confirm: true, requestId: intent.requestId });
  current = status({ running: true, recovery: recovery({ id: intent.requestId, state: 'running', checkpointId: branch.id }) });
  write.resolve(ok({ recovery: current.recovery })); assert.equal(await accepted, true);
  assert.equal(controller.getSnapshot().status.recovery.state, 'running');
  assert.equal(deriveView(controller.getSnapshot()).canRestore, false);
  assert.equal(deriveView(controller.getSnapshot()).canImport, false);
  current = status({ recovery: { ...current.recovery, state: 'succeeded' } });
  clock.run(3000); await settle();
  assert.equal(controller.getSnapshot().recoveryPending, null);
  assert.equal(deriveView(controller.getSnapshot()).canImport, true);
  assert.equal(controller.getSnapshot().draft.autoSync, false);
  assert.deepEqual(controller.getSnapshot().draft.projectIds, []);
  assert.equal(await controller.confirmRecovery(intent), false);
  assert.equal(calls.filter(call => call.action === 'restore').length, 1);
  assert.equal(calls.some(call => ['import', 'sync', 'preferences'].includes(call.action)), false);
  assert.equal(clock.jobs.size, 0); close();
});

test('recovery import is separately confirmed and bound solely to latest successful restore, showing durable partial results', async t => {
  let current = status({ recovery: recovery() });
  const { controller, calls } = setup(t, call => {
    if (call.action === 'import') {
      current = status({ recovery: recovery({ id: call.payload.requestId, kind: 'import', state: 'failed', importedCount: 1, skippedCount: 1, failedCount: 1, errorCode: 'IMPORT_FAILED',
        sessions: [{ sourceId: 'old-a', sessionId: 'new-a', outcome: 'imported', workspaceAttached: false }, { sourceId: 'old-b', outcome: 'skipped' }, { sourceId: 'old-c', outcome: 'failed' }] }) });
      return ok({ recovery: current.recovery });
    }
    return ok(current);
  });
  await controller.refresh();
  assert.equal(calls.length, 1);
  const intent = controller.prepareImport();
  assert.equal(calls.length, 1);
  assert.equal(await controller.confirmRecovery(intent), true);
  assert.deepEqual(calls.find(call => call.action === 'import').payload, { ...binding, restoreId: 'older-request', confirm: true, requestId: intent.requestId });
  const result = controller.getSnapshot().status.recovery;
  assert.equal(result.sessions[0].sessionId, 'new-a'); assert.equal(result.skippedCount, 1); assert.equal(result.failedCount, 1);
  assert.equal(controller.prepareImport(), null);
  assert.equal(await controller.confirmRecovery(intent), false);
  assert.equal(calls.filter(call => call.action === 'import').length, 1);
  assert.equal(calls.some(call => ['sync', 'preferences', 'restore'].includes(call.action)), false);
});

test('recovery page reopen reads persisted Host running/success state and stops polling on close', async t => {
  let current = status({ running: true, recovery: recovery({ state: 'running' }) });
  const { controller, clock, calls } = setup(t, () => ok(current));
  const close = controller.watch(); await settle();
  assert.equal(controller.getSnapshot().status.recovery.state, 'running');
  assert.equal(deriveView(controller.getSnapshot()).canBrowse, false);
  close(); assert.equal(clock.jobs.size, 0);
  current = status({ recovery: recovery() });
  const closeAgain = controller.watch(); await settle();
  assert.equal(controller.getSnapshot().status.recovery.state, 'succeeded');
  assert.equal(deriveView(controller.getSnapshot()).canImport, true);
  assert.equal(calls.every(call => call.action === 'status'), true);
  closeAgain();
});

test('recovery controls lock preferences/password/upload while keeping logout cancellation, unlike ordinary upload', async t => {
  let current = status({ running: true, autoSync: true, recovery: recovery({ state: 'running' }) });
  const { controller, calls } = setup(t, () => ok(current)); await controller.refresh();
  const view = deriveView(controller.getSnapshot());
  assert.equal(view.editable, false); assert.equal(view.canChangePassword, false); assert.equal(view.canSync, false); assert.equal(view.canLogout, true);
  assert.equal(await controller.browseProjects(), false);
  assert.equal(await controller.savePreferences(), false);
  assert.equal(await controller.changePassword(binding, { currentPassword: 'old', newPassword: 'new-password', confirmPassword: 'new-password' }), false);
  assert.equal(calls.length, 1);
  current = status({ running: true, autoSync: true }); await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).editable, true);
  assert.equal(controller.setAutoSync(false), true);
});

test('recovery stale account, revision and auth transitions clear browse/selection/path/intent immediately', async t => {
  for (const patch of [{ revision: 4 }, { server: 'https://other.example.test' }, { username: 'other' }, { loggedIn: false }]) {
    let current = status();
    const { controller, calls } = setup(t, call => call.action === 'status' ? ok(current) : readOnlyHandler(call));
    await select(controller); const intent = controller.prepareRestore();
    current = status(patch); await controller.refresh();
    const cloud = controller.getSnapshot().cloud;
    assert.equal(cloud.intent, null); assert.equal(cloud.projectId, ''); assert.equal(cloud.checkpointId, ''); assert.equal(cloud.destination, ''); assert.equal(cloud.projects.length, 0);
    assert.equal(await controller.confirmRecovery(intent), false);
    assert.equal(calls.some(call => call.action === 'restore'), false);
  }
});

test('recovery old confirmation never changes checkpoint/path and import intent rejects replaced restore', async t => {
  const { controller, calls } = setup(t, readOnlyHandler); await select(controller);
  let intent = controller.prepareRestore(); controller.setDestination('/srv/synthetic/other');
  assert.equal(await controller.confirmRecovery(intent), false);
  intent = controller.prepareRestore(); controller.selectCheckpoint(checkpoint.id);
  assert.equal(await controller.confirmRecovery(intent), false);
  intent = controller.prepareRestore(); controller.setCloudProject('other-project');
  assert.equal(await controller.confirmRecovery(intent), false);
  assert.equal(calls.some(call => call.action === 'restore'), false);
  let current = status({ recovery: recovery() });
  const other = setup(t, () => ok(current)); await other.controller.refresh();
  const importIntent = other.controller.prepareImport();
  current = status({ recovery: recovery({ id: 'newer-request' }) }); await other.controller.refresh();
  assert.equal(await other.controller.confirmRecovery(importIntent), false);
  assert.equal(other.calls.every(call => call.action === 'status'), true);
});

test('recovery timeout resolves through matching Host status, never late reply or mutation replay', async t => {
  let current = status(); const late = deferred();
  const { controller, calls, clock } = setup(t, call => {
    if (call.action === 'restore') { current = status({ running: true, recovery: recovery({ id: call.payload.requestId, state: 'running', checkpointId: branch.id }) }); return late.promise; }
    return call.action === 'status' ? ok(current) : readOnlyHandler(call);
  });
  const close = controller.watch(); await settle(); await select(controller);
  const intent = controller.prepareRestore(); const pending = controller.confirmRecovery(intent);
  clock.run(60000); assert.equal(await pending, false);
  assert.equal(calls.find(call => call.action === 'restore').signal.aborted, true);
  assert.equal(controller.getSnapshot().recoveryUncertain, false);
  assert.equal(controller.getSnapshot().status.recovery.state, 'running');
  late.resolve(ok({ recovery: recovery({ id: intent.requestId }) })); await settle();
  assert.equal(controller.getSnapshot().status.recovery.state, 'running');
  current = status({ recovery: { ...current.recovery, state: 'failed', errorCode: 'RESTORE_FAILED' } }); clock.run(3000); await settle();
  assert.equal(controller.getSnapshot().status.recovery.state, 'failed');
  assert.equal(controller.getSnapshot().recoveryPending, null);
  assert.equal(calls.filter(call => call.action === 'restore').length, 1); close();
});

test('recovery uncertain acceptance locks new intent and bounds automatic status reads; explicit refresh stays safe', async t => {
  const { controller, calls, clock } = setup(t, call => call.action === 'restore' ? Promise.reject(new Error('untrusted-password-and-token')) : readOnlyHandler(call));
  const close = controller.watch(); await settle(); await select(controller);
  const intent = controller.prepareRestore(); assert.equal(await controller.confirmRecovery(intent), false);
  assert.equal(controller.getSnapshot().recoveryUncertain, true);
  assert.equal(controller.getSnapshot().cloud.error.code, 'RECOVERY_UNCERTAIN');
  assert.equal(controller.prepareRestore(), null); assert.equal(controller.prepareImport(), null);
  for (let i = 0; i < 9; ++i) { clock.run(3000); await settle(); }
  assert.equal(clock.jobs.size, 0);
  await controller.refresh();
  assert.equal(await controller.confirmRecovery(intent), false);
  assert.equal(controller.getSnapshot().recoveryUncertain, true);
  assert.equal(calls.filter(call => call.action === 'restore').length, 1);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-password'), false); close();
});

test('recovery later status match clears uncertain warning without resubmitting an intent', async t => {
  let current = status();
  const { controller, calls, clock } = setup(t, call => call.action === 'restore' ? Promise.reject(new Error('unknown acceptance')) : call.action === 'status' ? ok(current) : readOnlyHandler(call));
  const close = controller.watch(); await settle(); await select(controller);
  const intent = controller.prepareRestore(); await controller.confirmRecovery(intent);
  assert.equal(controller.getSnapshot().recoveryUncertain, true);
  current = status({ recovery: recovery({ id: intent.requestId, checkpointId: branch.id }) });
  clock.run(3000); await settle();
  assert.equal(controller.getSnapshot().recoveryUncertain, false);
  assert.equal(controller.getSnapshot().cloud.error, null);
  assert.equal(controller.getSnapshot().recoveryPending, null);
  assert.equal(calls.filter(call => call.action === 'restore').length, 1); close();
});

test('recovery malformed acceptance is uncertain and malformed browse never leaves selectable cloud data', async t => {
  for (const result of [{ recovery: recovery({ errorCode: 'untrusted-password-and-token' }) }, { recovery: recovery({ id: 'wrong-request' }) }, { token: 'untrusted-password-and-token' }]) {
    const { controller } = setup(t, call => call.action === 'restore' ? ok(result) : readOnlyHandler(call));
    await select(controller); assert.equal(await controller.confirmRecovery(controller.prepareRestore()), false);
    assert.equal(controller.getSnapshot().recoveryUncertain, true);
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-password'), false);
  }
  const bad = setup(t, call => call.action === 'projects' ? ok({ projects: [{ token: 'untrusted-password-and-token' }] }) : call.action === 'checkpoints' ? ok({ ...listing, heads: ['unknown'] }) : ok(status()));
  await bad.controller.refresh(); assert.equal(await bad.controller.browseProjects(), false);
  assert.equal(bad.controller.getSnapshot().cloud.projects.length, 0);
  bad.controller.setCloudProject(checkpoint.projectId); assert.equal(await bad.controller.loadCheckpoints(), false);
  assert.equal(bad.controller.getSnapshot().cloud.checkpoints.length, 0);
  assert.equal(bad.controller.getSnapshot().cloud.error.code, 'INVALID_RESPONSE');
});

test('recovery known rejection is safely rendered and reconciled without duplicate writes', async t => {
  for (const code of ['BAD_DESTINATION', 'DESTINATION_EXISTS', 'PROTECTED_DESTINATION', 'RECOVERY_UNAVAILABLE', 'RECOVERY_LIMIT', 'CHECKPOINT_MISMATCH']) {
    const { controller, calls } = setup(t, call => call.action === 'restore' ? failure(code) : readOnlyHandler(call));
    await select(controller); const intent = controller.prepareRestore(); assert.equal(await controller.confirmRecovery(intent), false);
    assert.equal(controller.getSnapshot().cloud.error.code, code); assert.equal(controller.getSnapshot().recoveryUncertain, false);
    assert.equal(controller.getSnapshot().recoveryPending, null); assert.equal(calls.at(-1).action, 'status');
    assert.equal(await controller.confirmRecovery(intent), false); assert.equal(calls.filter(call => call.action === 'restore').length, 1);
  }
});

function mockReact() {
  const cells = []; let cursor = 0; let effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }, useId() { return 'mock-recovery'; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = value; }]; },
    useEffect(effect, deps) { const i = cursor++; if (!cells[i] || deps.some((value, at) => value !== cells[i].deps[at])) { const item = { deps, effect, cleanup: cells[i]?.cleanup }; cells[i] = item; effects.push(item); } },
  };
  return { React, render(Component, props) { cursor = 0; return Component(props); }, mount() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } }, unmount() { for (const cell of cells) cell?.cleanup?.(); } };
}
function nodes(root) { return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)]; }
function renderedText(root) { return typeof root === 'string' || typeof root === 'number' ? String(root) : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(renderedText).join(' '); }
function button(root, label) { const found = nodes(root).find(node => node.type === 'native:Button' && renderedText(node) === label); assert.ok(found, `missing ${label}`); return found; }
function modal(page, title) { return nodes(page.tree()).find(node => node.type === 'native:Modal' && node.props.title === title); }
function input(root, suffix) { const found = nodes(root).find(node => node.type === 'native:Input' && node.props.id === `mock-recovery-${suffix}`); assert.ok(found, suffix); return found; }
function pageSetup(t, handler) {
  const hooks = mockReact(); const mock = connection(handler); const cleanups = []; let slot;
  const primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const plugin = createClientPlugin(name => name === 'react' ? hooks.React : primitives);
  plugin.apply({ connection: mock.connection, effect(effect) { cleanups.push(effect()); }, on() {}, slots: { inject(_name, register) { register(); }, register(_spec, Component) { slot = { Component, props: _spec.inject() }; } } });
  t.after(() => { hooks.unmount(); cleanups.forEach(cleanup => cleanup?.()); });
  return { ...mock, ...hooks, controller: slot.props.controller, tree: () => hooks.render(slot.Component, slot.props) };
}
const managerTitle = '选择要下载的项目';
const reviewTitle = '确认下载所选项目';
const guiPlan = { latest: true, parent: 'E:\\synthetic', destinations: [{ id: 'destination-one', projectId: checkpoint.projectId, root: destination, parent: 'E:\\synthetic', label: '本机已知名称' }] };
const guiReads = call => call.action === 'downloadpick' ? ok(guiPlan) : readOnlyHandler(call);
const guiDownload = id => ({ id, latest: true, state: 'succeeded', completed: 1, total: 1, items: [{ projectId: checkpoint.projectId, checkpointId: branch.id, restoreId: 'batch-restore-one', root: destination, label: '本机已知名称', state: 'succeeded', sessionCount: 2, canImport: true }] });
async function browsePage(page) { await page.controller.refresh(); page.tree(); page.mount(); await settle(); button(page.tree(), '选择项目').props.onClick(); await settle(); return modal(page, managerTitle); }
async function addPageProject(page) {
  const search = nodes(modal(page, managerTitle)).find(node => node.props?.role === 'combobox'); search.props.onFocus();
  nodes(modal(page, managerTitle)).find(node => node.props?.role === 'option').props.onClick(); await settle();
}
async function selectPage(page) {
  await browsePage(page); await addPageProject(page);
  button(modal(page, managerTitle), '关闭').props.onClick();
  button(page.tree(), '保存位置').props.onClick(); await settle();
}

test('recovery GUI stays compact/inert and uses positive latest-only chosen rows and readonly Host destination', async t => {
  const page = pageSetup(t, guiReads); await page.controller.refresh();
  assert.equal(nodes(page.tree()).some(node => node.type === 'native:Input'), false);
  assert.equal(nodes(page.tree()).some(node => node.type === 'native:Checkbox'), false);
  assert.equal(page.calls.every(call => call.action === 'status'), true);
  await browsePage(page); assert.match(renderedText(modal(page, managerTitle)), /尚未选择项目/);
  await addPageProject(page); const browse = modal(page, managerTitle);
  assert.match(renderedText(browse), /本机已知名称/);
  assert.equal(nodes(browse).some(node => node.type === 'input' && node.props.type === 'radio'), false);
  assert.equal(button(page.tree(), '保存位置').props.disabled, false);
  assert.doesNotMatch(renderedText(browse), /版本|检查点|分支|设备|project-one|手动输入|绝对路径|字节/);
  assert.equal(page.calls.some(call => call.action === 'checkpoints'), false);
  button(modal(page, managerTitle), '关闭').props.onClick();
  button(page.tree(), '保存位置').props.onClick(); await settle(); assert.equal(button(page.tree(), '下载所选').props.disabled, false);
  button(page.tree(), '下载所选').props.onClick(); const confirm = modal(page, reviewTitle); assert.equal(confirm.props.open, true);
  assert.ok(renderedText(confirm).includes('本机已知名称')); assert.ok(renderedText(confirm).includes(destination));
  assert.equal(page.controller.getSnapshot().downloadIntent.latest, true);
  assert.equal(Object.hasOwn(page.controller.getSnapshot().downloadIntent.items[0], 'checkpointId'), false);
  assert.match(renderedText(confirm), /下载云端最新内容/); assert.doesNotMatch(renderedText(confirm), /版本|检查点|分支|个文件|字节|2026/);
  assert.equal(page.calls.some(call => ['downloadstart', 'restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
  button(confirm, '关闭').props.onClick(); assert.equal(modal(page, reviewTitle).props.open, false);
});

test('recovery GUI old unsupported cloud gives concise upgrade error without a manual ID workflow', async t => {
  const page = pageSetup(t, call => call.action === 'projects' ? failure('CLOUD_BROWSE_UNSUPPORTED') : guiReads(call));
  const browse = await browsePage(page); assert.match(renderedText(browse), /请更新同步服务器/);
  assert.doesNotMatch(renderedText(browse), /手动输入|项目 ID/);
  assert.equal(nodes(browse).filter(node => node.type === 'native:Input').length, 1);
  assert.equal(button(page.tree(), '下载所选').props.disabled, true);
  assert.equal(page.calls.some(call => ['checkpoints', 'restore', 'downloadstart'].includes(call.action)), false);
});

test('recovery GUI confirmation rejects stale selection handlers and submits one Host batch then separate per-item import', async t => {
  let current = status();
  const page = pageSetup(t, call => {
    if (call.action === 'downloadstart') { current = status({ download: guiDownload(call.payload.requestId) }); return ok({ download: current.download }); }
    if (call.action === 'import') {
      const result = recovery({ id: call.payload.requestId, kind: 'import', importedCount: 2, skippedCount: 0, failedCount: 0 });
      current = status({ recovery: result, download: { ...current.download, items: current.download.items.map(row => ({ ...row, canImport: false, importResult: result })) } });
      return ok({ recovery: result });
    }
    return call.action === 'status' ? ok(current) : guiReads(call);
  });
  await selectPage(page); button(page.tree(), '下载所选').props.onClick();
  const old = button(modal(page, reviewTitle), '确认下载').props.onClick;
  page.controller.removeDownloadProject(checkpoint.projectId); await page.controller.addDownloadProject(checkpoint.projectId); old(); await settle();
  assert.equal(page.calls.some(call => call.action === 'downloadstart'), false);
  button(page.tree(), '保存位置').props.onClick(); await settle(); button(page.tree(), '下载所选').props.onClick();
  const confirm = button(modal(page, reviewTitle), '确认下载').props.onClick; confirm(); confirm(); await settle();
  assert.equal(page.calls.filter(call => call.action === 'downloadstart').length, 1);
  assert.equal(page.calls.some(call => ['restore', 'import', 'preferences', 'sync'].includes(call.action)), false);
  assert.match(renderedText(modal(page, '下载进度')), /下载完成/);
  button(modal(page, '下载进度'), '关闭').props.onClick(); assert.match(renderedText(page.tree()), /下载完成/);
  button(page.tree(), '查看下载进度').props.onClick(); await settle();
  button(modal(page, '下载进度'), '导入安全会话').props.onClick();
  const importConfirm = modal(page, '导入安全会话？'); assert.equal(importConfirm.props.open, true); assert.ok(renderedText(importConfirm).includes(destination));
  assert.equal(page.calls.some(call => call.action === 'import'), false);
  button(importConfirm, '确认导入').props.onClick(); await settle();
  assert.equal(page.calls.filter(call => call.action === 'import').length, 1);
  assert.equal(page.calls.find(call => call.action === 'import').payload.restoreId, 'batch-restore-one');
  assert.match(renderedText(modal(page, '下载进度')), /已导入 2 · 已跳过 0 · 失败 0/);
});

test('recovery GUI displays running work on reopen and never fabricates missing import counts', async t => {
  const page = pageSetup(t, () => ok(status({ running: true, recovery: recovery({ kind: 'import', state: 'running' }) })));
  await page.controller.refresh();
  assert.match(renderedText(page.tree()), /导入进行中…/);
  assert.match(renderedText(page.tree()), /已导入 未确认 · 已跳过 未确认 · 失败 未确认/);
  assert.equal(button(page.tree(), '选择项目').props.disabled, true);
  assert.equal(button(page.tree(), '立即同步').props.disabled, true);
  assert.equal(button(page.tree(), '修改密码').props.disabled, true);
  assert.equal(button(page.tree(), '退出登录').props.disabled, false);
  assert.equal(nodes(page.tree()).find(node => node.type === 'native:Switch').props.disabled, true);
  assert.equal(page.calls.every(call => call.action === 'status'), true);
});

test('recovery GUI clears an open confirmation on account change and renders partial durable IDs and safe failure guidance', async t => {
  let current = status();
  const page = pageSetup(t, call => call.action === 'status' ? ok(current) : guiReads(call));
  await selectPage(page); button(page.tree(), '下载所选').props.onClick();
  const old = button(modal(page, reviewTitle), '确认下载').props.onClick;
  current = status({ revision: 4, username: 'other' }); await page.controller.refresh(); old(); await settle();
  assert.equal(modal(page, reviewTitle).props.open, false);
  assert.equal(page.calls.some(call => ['restore', 'downloadstart'].includes(call.action)), false);
  current = status({ recovery: recovery({ kind: 'import', state: 'failed', importedCount: 1, skippedCount: 1, failedCount: 1, errorCode: 'IMPORT_FAILED',
    sessions: [{ sourceId: 'old-a', sessionId: 'new-a', outcome: 'imported', workspaceAttached: false }, { sourceId: 'old-b', outcome: 'skipped' }, { sourceId: 'old-c', outcome: 'failed' }] }) });
  await page.controller.refresh();
  assert.match(renderedText(page.tree()), /old-a → new-a/); assert.match(renderedText(page.tree()), /old-b → 无新会话 ID · 已跳过/);
  assert.match(renderedText(page.tree()), /未关联工作区/); assert.match(renderedText(page.tree()), /勿重复导入/);
  current = status({ recovery: recovery({ state: 'failed', errorCode: 'DESTINATION_EXISTS' }) }); await page.controller.refresh();
  assert.match(renderedText(page.tree()), /目标目录已存在/); assert.match(renderedText(page.tree()), /目录可能不完整/);
});
