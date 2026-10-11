import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, deriveView, parseDownloadPlan, parseDownloadStatus, parseStatus } from '../client/state.mjs';
import { createClientPlugin } from '../client/adapter.mjs';

// Synthetic Connection and React event contracts only, not a real GUI/focus integration claim.
const binding = { revision: 7, server: 'https://synthetic.example.test', username: 'synthetic' };
const stamp = '2026-01-01T00:00:00.000Z';
const project = n => ({ projectId: `project-${n}`, label: `项目 ${n}`, sourceRoot: `E:\\synthetic\\source-${n}`, checkpointCount: 2, latestCreatedAt: stamp });
const checkpoint = (n, id = `head-${n}`) => ({ id, projectId: `project-${n}`, deviceId: 'device-one', parentId: null, createdAt: stamp, fileCount: 3, totalBytes: 90 });
const catalog = [project(1), project(2), project(3)];
const status = (extra = {}) => ({ ...binding, loggedIn: true, running: false, autoSync: false, pending: 0, intervalMs: 60000,
  projects: [{ id: 'local-one', projectId: 'project-1', label: '本机项目', root: 'E:\\synthetic\\local', selected: true, available: true }], ...extra });
const planFor = items => ({ latest: true, parent: 'E:\\synthetic\\downloads', destinations: items.map((item, index) => ({ ...item, id: `destination-${index}`, root: `E:\\synthetic\\downloads\\new-${index}`, parent: 'E:\\synthetic\\downloads', label: `项目 ${index + 1}` })) });
const browser = { id: 'browser-one', path: 'E:\\synthetic', currentId: 'root-node', crumbs: [{ id: 'root-node', label: 'synthetic' }], directories: [{ id: 'child-node', label: 'downloads' }], selectable: false, truncated: false };
const nested = { ...browser, path: 'E:\\synthetic\\downloads', currentId: 'child-node', directories: [], selectable: true };
const batch = (id, plans, state = 'succeeded') => ({ id, latest: true, state, completed: state === 'running' ? 0 : plans.length, total: plans.length,
  items: plans.map((row, index) => ({ projectId: row.projectId, checkpointId: `host-commit-${index}`, restoreId: `restore-${index}`, root: row.root, label: row.label, state: state === 'running' ? 'pending' : 'succeeded', sessionCount: 2, canImport: state !== 'running' })) });
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted-secret', details: { token: 'untrusted-secret' } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
async function settle() { for (let i = 0; i < 50; ++i) await Promise.resolve(); }
function clock() { let id = 0; const jobs = new Map(); return { jobs, setTimeout(fn, ms) { jobs.set(++id, { fn, ms }); return id; }, clearTimeout(key) { jobs.delete(key); }, run(ms) { const entry = [...jobs].find(([, job]) => job.ms === ms); assert.ok(entry, `missing timer ${ms}`); jobs.delete(entry[0]); entry[1].fn(); } }; }
function fixture(t, custom, options = {}) {
  let current = status(), plans = [], sequence = 0;
  const calls = [], time = clock();
  const base = call => {
    if (call.action === 'status') return ok(current);
    if (call.action === 'projects') return ok({ projects: catalog });
    if (call.action === 'checkpoints') { const n = call.payload.projectId.split('-').at(-1); return ok({ checkpoints: [checkpoint(n, `old-${n}`), checkpoint(n)], heads: [`head-${n}`] }); }
    if (call.action === 'downloadpick') { const plan = planFor(call.payload.items); plans = plan.destinations; return ok(plan); }
    if (call.action === 'downloadstart') { current = status({ download: batch(call.payload.requestId, plans) }); return ok({ download: current.download }); }
    throw new Error(`unexpected ${call.action}`);
  };
  const connection = { rpc: { async call(channel, endpoint, payload, signal) { const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call); return custom ? custom(call, base, { get current() { return current; }, set current(value) { current = value; }, get plans() { return plans; } }) : base(call); } } };
  const controller = createController(connection, { ...time, crypto: { randomUUID: () => `a0000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` }, ...options });
  t.after(() => controller.dispose());
  return { controller, connection, calls, clock: time, get current() { return current; }, set current(value) { current = value; }, get plans() { return plans; } };
}
async function select(controller, ids = ['project-1', 'project-2']) { await controller.refresh(); await controller.browseProjects(); for (const id of ids) assert.equal(await controller.addDownloadProject(id), true); }

test('download selection includes only descriptive catalog projects, without reads or editing uploads', async t => {
  const { controller, calls } = fixture(t); await controller.refresh(); const upload = controller.getSnapshot().draft;
  assert.equal(await controller.addDownloadProject('project-1'), false);
  await controller.browseProjects(); assert.equal(await controller.addDownloadProject('../arbitrary'), false);
  assert.equal(await controller.addDownloadProject('project-1'), true);
  const row = controller.getSnapshot().downloadSelection[0];
  assert.deepEqual(row, { projectId: 'project-1', label: catalog[0].label, sourceRoot: catalog[0].sourceRoot });
  assert.ok(Object.isFrozen(row) && Object.isFrozen(controller.getSnapshot().downloadSelection));
  assert.equal(calls.some(call => call.action === 'checkpoints'), false);
  const before = calls.length; assert.equal(await controller.addDownloadProject('project-1'), false); assert.equal(calls.length, before);
  assert.equal(controller.getSnapshot().draft, upload); assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.removeDownloadProject('project-1'), true); assert.deepEqual(controller.getSnapshot().downloadSelection, []);
  assert.equal(controller.getSnapshot().draft, upload); assert.ok(calls.every(call => !['restore', 'downloadstart', 'preferences', 'sync', 'import'].includes(call.action)));
});

test('multiple or zero heads never require a client checkpoint read or choice', async t => {
  for (const heads of [['head-1', 'other-head'], []]) {
    const { controller, calls } = fixture(t, (call, base) => call.action === 'checkpoints' ? ok({ checkpoints: [checkpoint(1), checkpoint(1, 'other-head')], heads }) : base(call));
    await select(controller, ['project-1']);
    assert.equal(deriveView(controller.getSnapshot()).canChooseDownloadDestination, true);
    assert.equal(await controller.chooseDownloadDestination(), true);
    assert.equal(controller.setDownloadCheckpoint, undefined); assert.equal(controller.loadDownloadCheckpoints, undefined);
    assert.ok(calls.every(call => !['checkpoints', 'downloadstart'].includes(call.action)));
  }
});

test('selection cap is twenty distinct projects; remote emptiness is decided by Host', async t => {
  const { controller } = fixture(t, (call, base) => call.action === 'projects' ? ok({ projects: Array.from({ length: 21 }, (_, i) => project(i + 1)) }) : base(call));
  await select(controller, Array.from({ length: 20 }, (_, i) => `project-${i + 1}`));
  assert.equal(await controller.addDownloadProject('project-21'), false); assert.equal(controller.getSnapshot().downloadError.code, 'DOWNLOAD_LIMIT');
  assert.equal(controller.getSnapshot().downloadSelection.length, 20);
  const empty = fixture(t, (call, base) => call.action === 'downloadstart' ? failure('CLOUD_PROJECT_EMPTY') : base(call));
  await select(empty.controller, ['project-1']); assert.equal(empty.controller.prepareDownload(), null);
  await empty.controller.chooseDownloadDestination(); assert.equal(await empty.controller.confirmDownload(empty.controller.prepareDownload()), false);
  assert.equal(empty.controller.getSnapshot().downloadError.message, '云端暂无内容'); assert.equal(empty.controller.getSnapshot().downloadUncertain, false);
});

test('batch DTOs deeply allowlist/freeze and reject mismatches, duplicate plans, roots, errors and counts', () => {
  const selected = [{ projectId: 'project-1' }, { projectId: 'project-2' }];
  const raw = planFor(selected); const parsed = parseDownloadPlan({ ...raw, token: 'secret', destinations: raw.destinations.map(row => ({ ...row, token: 'secret' })) }, selected);
  const result = parseDownloadStatus({ ...batch('batch-one', parsed.destinations), token: 'secret' });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.destinations) && Object.isFrozen(parsed.destinations[0]) && Object.isFrozen(result.items[0]));
  assert.equal(JSON.stringify([parsed, result]).includes('secret'), false); assert.deepEqual(parseStatus(status({ download: result })).download, result);
  for (const patch of [{ projectId: 'foreign' }, { checkpointId: 'foreign' }, { id: '../escape' }, { root: raw.parent }, { root: raw.parent + '\\..' }, { root: raw.parent + '\\nested\\child' }, { parent: 'relative' }, { label: '' }]) {
    assert.throws(() => parseDownloadPlan({ ...raw, destinations: [{ ...raw.destinations[0], ...patch }, raw.destinations[1]] }, selected), { code: 'INVALID_RESPONSE' });
  }
  for (const key of ['projectId', 'id', 'root']) assert.throws(() => parseDownloadPlan({ ...raw, destinations: [raw.destinations[0], { ...raw.destinations[1], [key]: raw.destinations[0][key] }] }, selected), { code: 'INVALID_RESPONSE' });
  for (const patch of [{ completed: 0 }, { total: 21 }, { state: 'done' }, { items: null }, { id: '../escape' }]) assert.throws(() => parseDownloadStatus({ ...result, ...patch }), { code: 'INVALID_RESPONSE' });
  for (const patch of [{ canImport: 1 }, { state: 'pending' }, { sessionCount: -1 }, { restoreId: '../bad' }, { errorCode: 'untrusted-secret' }, { root: 'relative' }]) assert.throws(() => parseDownloadStatus({ ...result, items: [{ ...result.items[0], ...patch }, result.items[1]] }), { code: 'INVALID_RESPONSE' });
});

test('one parent picker plans only chosen projects; cancellation preserves valid plans and changes invalidate them', async t => {
  let cancel = false;
  const { controller, calls } = fixture(t, (call, base) => call.action === 'downloadpick' && cancel ? ok({ cancelled: true }) : base(call));
  await select(controller); await controller.chooseDownloadDestination(); const plan = controller.getSnapshot().downloadPlan;
  assert.deepEqual(calls.at(-1).payload, { ...binding, latest: true, items: [{ projectId: 'project-1' }, { projectId: 'project-2' }] });
  assert.ok(Object.isFrozen(plan)); cancel = true; assert.equal(await controller.chooseDownloadDestination(), false); assert.equal(controller.getSnapshot().downloadPlan, plan);
  const intent = controller.prepareDownload(); await controller.addDownloadProject('project-3'); assert.equal(controller.getSnapshot().downloadPlan, null);
  assert.equal(await controller.confirmDownload(intent), false); assert.equal(calls.some(call => call.action === 'downloadstart'), false);
  cancel = false; await controller.chooseDownloadDestination(); controller.removeDownloadProject('project-2'); assert.equal(controller.getSnapshot().downloadPlan, null);
});

test('batch browser enforces issued IDs, selectable folder and stale native reply rejection', async t => {
  const { controller, calls } = fixture(t, (call, base) => call.action === 'downloadpick' ? ok({ latest: true, browser }) : call.action === 'downloadbrowse' ? ok({ latest: true, browser: nested }) : call.action === 'downloadselect' ? ok(planFor([{ projectId: 'project-1' }])) : base(call));
  await select(controller, ['project-1']); await controller.chooseDownloadDestination();
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false); assert.equal(await controller.selectDownloadDestination(), false);
  const before = calls.length; assert.equal(await controller.browseDownloadDestination('E:\\arbitrary'), false); assert.equal(calls.length, before);
  assert.equal(await controller.browseDownloadDestination('child-node'), true); assert.deepEqual(calls.at(-1).payload, { ...binding, latest: true, browserId: browser.id, nodeId: 'child-node' });
  assert.equal(await controller.selectDownloadDestination(), true); assert.equal(controller.getSnapshot().downloadBrowser, null);
  for (const patch of [{ revision: 8 }, { username: 'changed' }, { loggedIn: false }, { update: { currentVersion: '0.7.1', supported: true, state: 'installing', requestId: 'update-one', restartRequired: true } }]) {
    const late = deferred(); const f = fixture(t, (call, base) => call.action === 'downloadpick' ? late.promise : base(call)); await select(f.controller, ['project-1']);
    const pending = f.controller.chooseDownloadDestination(), request = f.calls.at(-1); f.current = status(patch); await f.controller.refresh();
    assert.equal(request.signal.aborted, true); assert.equal(await pending, false); late.resolve(ok(planFor([{ projectId: 'project-1' }]))); await settle(); assert.equal(f.controller.getSnapshot().downloadPlan, null);
  }
});

test('confirmation atomically submits one whole batch, no individual restore loops or automatic imports', async t => {
  const f = fixture(t); await select(f.controller); await f.controller.chooseDownloadDestination(); const intent = f.controller.prepareDownload();
  assert.equal(f.controller.prepareDownload(), intent); assert.ok(Object.isFrozen(intent.items[0]));
  assert.equal(await f.controller.confirmDownload({ ...intent }), false);
  const pending = f.controller.confirmDownload(intent); assert.equal(await f.controller.confirmDownload(intent), false); assert.equal(await pending, true);
  const writes = f.calls.filter(call => call.action === 'downloadstart'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].payload, { ...binding, latest: true, items: intent.items.map(({ projectId, destinationId }) => ({ projectId, destinationId })), requestId: intent.requestId, confirm: true });
  assert.equal(f.controller.getSnapshot().status.download.state, 'succeeded'); assert.equal(f.controller.getSnapshot().downloadPlan, null);
  assert.equal(f.controller.getSnapshot().draft.autoSync, false); assert.deepEqual(f.controller.getSnapshot().draft.projectIds, ['local-one']);
  assert.equal(f.calls.some(call => ['restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('accepted Host batch survives closing watchers and reopening reads progress without resubmission', async t => {
  const f = fixture(t, (call, base, env) => { if (call.action !== 'downloadstart') return base(call); env.current = status({ download: batch(call.payload.requestId, env.plans, 'running') }); return ok({ download: env.current.download }); });
  const stop = f.controller.watch(); await settle(); await select(f.controller); await f.controller.chooseDownloadDestination(); await f.controller.confirmDownload(f.controller.prepareDownload());
  assert.equal(deriveView(f.controller.getSnapshot()).canSync, false); assert.equal(deriveView(f.controller.getSnapshot()).canLogout, true);
  f.controller.closeDownloadBrowser(); stop(); assert.equal(f.clock.jobs.size, 0);
  f.current = status({ download: { ...f.current.download, state: 'succeeded', completed: 2, items: f.current.download.items.map(row => ({ ...row, state: 'succeeded', canImport: true })) } });
  const again = f.controller.watch(); await settle(); assert.equal(f.controller.getSnapshot().status.download.state, 'succeeded'); again();
  assert.equal(f.calls.filter(call => call.action === 'downloadstart').length, 1);
});

test('unknown batch acceptance is read-reconciled with bounded polling and never replayed', async t => {
  const f = fixture(t, (call, base) => call.action === 'downloadstart' ? Promise.reject(new Error('untrusted-secret')) : base(call));
  const stop = f.controller.watch(); await settle(); await select(f.controller); await f.controller.chooseDownloadDestination(); const intent = f.controller.prepareDownload();
  assert.equal(await f.controller.confirmDownload(intent), false); assert.equal(f.controller.getSnapshot().downloadUncertain, true); assert.equal(f.controller.prepareDownload(), null);
  for (let i = 0; i < 9; ++i) { f.clock.run(3000); await settle(); }
  assert.equal(f.clock.jobs.size, 0); assert.equal(await f.controller.confirmDownload(intent), false);
  f.current = status({ download: batch(intent.requestId, f.plans) }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().downloadUncertain, false); assert.equal(f.controller.getSnapshot().downloadPending, null); assert.equal(f.controller.getSnapshot().downloadError, null);
  assert.equal(f.calls.filter(call => call.action === 'downloadstart').length, 1); assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret'), false); stop();
});

test('definite batch rejection/expired plans clear authorization and never retry', async t => {
  for (const code of ['DIRECTORY_PICKER_EXPIRED', 'DESTINATION_CHANGED', 'DESTINATION_EXISTS', 'DOWNLOAD_LIMIT']) {
    const f = fixture(t, (call, base) => call.action === 'downloadstart' ? failure(code) : base(call)); await select(f.controller); await f.controller.chooseDownloadDestination();
    const intent = f.controller.prepareDownload(); assert.equal(await f.controller.confirmDownload(intent), false);
    assert.equal(f.controller.getSnapshot().downloadUncertain, false); assert.equal(f.controller.getSnapshot().downloadPlan, null); assert.equal(f.controller.getSnapshot().downloadError.code, code);
    assert.equal(await f.controller.confirmDownload(intent), false); assert.equal(f.calls.filter(call => call.action === 'downloadstart').length, 1);
  }
});

test('settled per-project import needs explicit immutable consent and reports durable partial session IDs', async t => {
  const f = fixture(t, (call, base, env) => {
    if (call.action !== 'import') return base(call);
    const row = env.current.download.items.find(item => item.restoreId === call.payload.restoreId);
    const recovery = { id: call.payload.requestId, kind: 'import', state: 'failed', root: row.root, importedCount: 1, skippedCount: 0, failedCount: 1, errorCode: 'IMPORT_FAILED', sessions: [{ sourceId: 'old-one', sessionId: 'new-one', outcome: 'imported', workspaceAttached: false }, { sourceId: 'old-two', outcome: 'failed' }] };
    env.current = status({ download: { ...env.current.download, items: env.current.download.items.map(item => item === row ? { ...item, canImport: false, importResult: recovery } : item) }, recovery });
    return ok({ recovery });
  });
  await select(f.controller); await f.controller.chooseDownloadDestination(); await f.controller.confirmDownload(f.controller.prepareDownload());
  assert.equal(f.calls.some(call => call.action === 'import'), false); assert.equal(f.controller.prepareDownloadImport('arbitrary'), null);
  const row = f.controller.getSnapshot().status.download.items[0]; const intent = f.controller.prepareDownloadImport(row.restoreId);
  assert.equal(await f.controller.confirmDownloadImport({ ...intent, root: 'E:\\other' }), false);
  assert.equal(await f.controller.confirmDownloadImport(intent), true); assert.equal(await f.controller.confirmDownloadImport(intent), false);
  assert.deepEqual(f.calls.find(call => call.action === 'import').payload, { ...binding, restoreId: row.restoreId, requestId: intent.requestId, confirm: true });
  const result = f.controller.getSnapshot().status.download.items[0]; assert.equal(result.canImport, false); assert.equal(result.importResult.sessions[0].sessionId, 'new-one');
  assert.equal(f.controller.prepareDownloadImport(row.restoreId), null); assert.ok(f.controller.prepareDownloadImport('restore-1'));
});

test('catalog refresh preserves descriptive choices while selection changes invalidate exact planned roots', async t => {
  const f = fixture(t); await select(f.controller, ['project-1']); await f.controller.chooseDownloadDestination();
  const selected = f.controller.getSnapshot().downloadSelection, plan = f.controller.getSnapshot().downloadPlan;
  await f.controller.browseProjects(); assert.equal(f.controller.getSnapshot().downloadSelection, selected);
  assert.equal(f.controller.getSnapshot().downloadPlan, plan); assert.equal(deriveView(f.controller.getSnapshot()).canChooseDownloadDestination, true);
  const intent = f.controller.prepareDownload(); f.controller.removeDownloadProject('project-1'); await f.controller.addDownloadProject('project-1');
  assert.equal(f.controller.getSnapshot().downloadPlan, null); assert.equal(await f.controller.confirmDownload(intent), false);
  assert.equal(f.calls.some(call => ['checkpoints', 'downloadstart'].includes(call.action)), false);
});

test('batch picker timeout, close, unmount and disposal abort late delivery without restoring authorization', async t => {
  for (const mode of ['timeout', 'close', 'unmount', 'dispose']) {
    const late = deferred(); const f = fixture(t, (call, base) => call.action === 'downloadpick' ? late.promise : base(call));
    const stop = f.controller.watch(); await settle(); await select(f.controller, ['project-1']);
    const pending = f.controller.chooseDownloadDestination(), request = f.calls.at(-1);
    if (mode === 'timeout') f.clock.run(60000); else if (mode === 'close') f.controller.closeDownloadBrowser(); else if (mode === 'unmount') stop(); else f.controller.dispose();
    assert.equal(await pending, false); assert.equal(request.signal.aborted, true);
    late.resolve(ok(planFor([{ projectId: 'project-1' }]))); await settle(); assert.equal(f.controller.getSnapshot().downloadPlan, null);
    assert.equal(f.calls.some(call => ['downloadstart', 'restore'].includes(call.action)), false); stop();
  }
});

test('batch picker TTL/malformed replies clear previous plans rather than reflecting untrusted DTO fields', async t => {
  for (const result of [failure('DIRECTORY_PICKER_EXPIRED'), failure('DESTINATION_CHANGED'), ok({ cancelled: false }), ok({ ...planFor([{ projectId: 'foreign' }]), browser }), ok({ browser: { ...browser, id: 'constructor' } })]) {
    let second = false; const f = fixture(t, (call, base) => call.action === 'downloadpick' && second ? result : base(call));
    await select(f.controller, ['project-1']); await f.controller.chooseDownloadDestination(); assert.ok(f.controller.getSnapshot().downloadPlan);
    second = true; assert.equal(await f.controller.chooseDownloadDestination(), false); assert.equal(f.controller.getSnapshot().downloadPlan, null);
    assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret'), false);
  }
});

test('lost per-item import response stays nonrepeatable until matching durable item result appears', async t => {
  const f = fixture(t, (call, base) => call.action === 'import' ? Promise.reject(new Error('untrusted-secret')) : base(call));
  const stop = f.controller.watch(); await settle(); await select(f.controller); await f.controller.chooseDownloadDestination(); await f.controller.confirmDownload(f.controller.prepareDownload());
  const row = f.controller.getSnapshot().status.download.items[0], intent = f.controller.prepareDownloadImport(row.restoreId);
  assert.equal(await f.controller.confirmDownloadImport(intent), false); assert.equal(f.controller.getSnapshot().downloadUncertain, true);
  assert.equal(f.controller.prepareDownloadImport(row.restoreId), null); assert.equal(await f.controller.confirmDownloadImport(intent), false);
  const importResult = { id: intent.requestId, kind: 'import', state: 'failed', root: row.root, importedCount: 1, failedCount: 1, errorCode: 'IMPORT_FAILED', sessions: [{ sourceId: 'old', sessionId: 'new', outcome: 'imported' }] };
  f.current = status({ download: { ...f.current.download, items: f.current.download.items.map(item => item.restoreId === row.restoreId ? { ...item, canImport: false, importResult } : item) } });
  f.clock.run(3000); await settle(); assert.equal(f.controller.getSnapshot().downloadUncertain, false); assert.equal(f.controller.getSnapshot().downloadPending, null);
  assert.equal(f.controller.getSnapshot().status.download.items[0].importResult.sessions[0].sessionId, 'new'); assert.equal(f.calls.filter(call => call.action === 'import').length, 1); stop();
});

test('download finalization warning is strictly allowlisted and never relabels verified files as failed', async t => {
  const plans = planFor([{ projectId: 'project-1' }]).destinations;
  const completed = batch('batch-warning', plans);
  const warned = parseDownloadStatus({ ...completed, warningCode: 'DOWNLOAD_FINALIZATION_FAILED', warning: 'untrusted-secret' });
  assert.equal(warned.state, 'succeeded'); assert.equal(warned.warningCode, 'DOWNLOAD_FINALIZATION_FAILED'); assert.ok(Object.isFrozen(warned));
  assert.equal(JSON.stringify(warned).includes('untrusted-secret'), false);
  for (const warningCode of ['untrusted-secret', 'IMPORT_FAILED', null, 1]) assert.throws(() => parseDownloadStatus({ ...completed, warningCode }), { code: 'INVALID_RESPONSE' });
  const f = fixture(t); f.current = status({ download: warned }); await f.controller.refresh(); assert.equal(deriveView(f.controller.getSnapshot()).downloadWarning, '文件已下载，状态清理未完成');
});

function hooks() {
  const cells = []; let cursor = 0, effects = [];
  const React = { createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; }, useSyncExternalStore(_subscribe, snapshot) { return snapshot(); }, useId() { return 'mock-download'; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; }, useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = value; }]; },
    useEffect(effect, deps) { const i = cursor++; if (!cells[i] || deps.some((value, at) => value !== cells[i].deps[at])) { const item = { deps, effect, cleanup: cells[i]?.cleanup }; cells[i] = item; effects.push(item); } } };
  return { React, render(Component, props) { cursor = 0; return Component(props); }, mount() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } }, unmount() { for (const cell of cells) cell?.cleanup?.(); } };
}
function nodes(root) { return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)]; }
function text(root) { return typeof root === 'string' || typeof root === 'number' ? String(root) : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(text).join(' '); }
function button(root, label) { const node = nodes(root).find(item => item.type === 'native:Button' && text(item) === label); assert.ok(node, `missing ${label}`); return node; }
function page(t, custom) {
  const f = fixture(t, custom), react = hooks(), cleanups = []; let slot;
  const primitive = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  createClientPlugin(name => name === 'react' ? react.React : primitive).apply({ connection: f.connection, effect(fn) { cleanups.push(fn()); }, on() {}, slots: { inject(_name, fn) { fn(); }, register(spec, Component) { slot = { Component, props: spec.inject() }; } } });
  t.after(() => { react.unmount(); cleanups.forEach(fn => fn?.()); });
  return { ...f, ...react, controller: slot.props.controller, tree: () => react.render(slot.Component, slot.props) };
}
const manager = p => nodes(p.tree()).find(node => node.type === 'native:Modal' && node.props.title === '选择要下载的项目');
const combo = p => nodes(manager(p)).find(node => node.props?.role === 'combobox');
const key = (name, extra = {}) => ({ key: name, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
async function open(p) { p.tree(); p.mount(); await settle(); button(p.tree(), '选择项目').props.onClick(); await settle(); }

test('selection manager is positive chosen-list above searchable add; arrows/Enter select while Tab never does', async t => {
  const p = page(t); await open(p);
  assert.match(text(manager(p)), /尚未选择项目/); assert.equal(nodes(manager(p)).some(node => node.props?.role === 'option'), false);
  assert.equal(combo(p).props['aria-expanded'], false); combo(p).props.onFocus();
  assert.equal(nodes(manager(p)).filter(node => node.props?.role === 'option').length, 3);
  const down = key('ArrowDown'); combo(p).props.onKeyDown(down); assert.equal(down.prevented, true);
  assert.match(combo(p).props['aria-activedescendant'], /project-1$/);
  const tab = key('Tab'); combo(p).props.onKeyDown(tab); assert.equal(tab.prevented, false); assert.deepEqual(p.controller.getSnapshot().downloadSelection, []);
  combo(p).props.onKeyDown(key('ArrowDown')); combo(p).props.onKeyDown(key('Enter')); await settle();
  assert.equal(p.controller.getSnapshot().downloadSelection[0].projectId, 'project-1'); assert.doesNotMatch(text(manager(p)), /版本|检查点|分支/);
  assert.equal(nodes(manager(p)).some(node => node.type === 'native:Checkbox'), false); assert.equal(nodes(manager(p)).some(node => node.type === 'input' && node.props.type === 'radio'), false);
  combo(p).props.onFocus(); assert.equal(nodes(manager(p)).filter(node => node.props?.role === 'option').length, 2);
  const chosen = nodes(manager(p)).find(node => node.props?.['aria-label'] === '已选择的下载项目'); assert.match(text(chosen), /项目 1/);
  button(manager(p), '移除').props.onClick({}); await settle(); assert.equal(p.controller.getSnapshot().downloadSelection.length, 0);
  assert.deepEqual(p.controller.getSnapshot().draft.projectIds, ['local-one']); assert.equal(p.calls.some(call => ['downloadstart', 'restore', 'preferences', 'sync'].includes(call.action)), false);
});

test('combobox filters, pointer-selects, keeps ordinary editing keys and closes Escape before Modal with IME protection', async t => {
  const p = page(t); await open(p); combo(p).props.onChange({ target: { value: '2' } });
  const option = nodes(manager(p)).find(node => node.props?.role === 'option'); assert.match(text(option), /项目 2/);
  const pointer = key(''); option.props.onPointerDown(pointer); assert.equal(pointer.prevented, true);
  for (const name of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) { const event = key(name); combo(p).props.onKeyDown(event); assert.equal(event.prevented, false); }
  combo(p).props.onKeyDown(key('ArrowDown')); combo(p).props.onCompositionStart(); combo(p).props.onKeyDown(key('Enter')); assert.equal(p.controller.getSnapshot().downloadSelection.length, 0);
  const imeEscape = key('Escape'); manager(p).props.onKeyDownCapture(imeEscape); assert.equal(imeEscape.prevented, true); assert.equal(combo(p).props['aria-expanded'], true);
  combo(p).props.onCompositionEnd(); combo(p).props.onKeyDown(key('Enter')); assert.equal(p.controller.getSnapshot().downloadSelection.length, 0); combo(p).props.onKeyUp();
  const escape = key('Escape'); manager(p).props.onKeyDownCapture(escape); assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.equal(manager(p).props.open, true); assert.equal(combo(p).props['aria-expanded'], false);
  const outer = key('Escape'); manager(p).props.onKeyDownCapture(outer); assert.equal(outer.prevented, false);
  combo(p).props.onFocus(); nodes(manager(p)).find(node => node.props?.role === 'option').props.onClick(); await settle(); assert.equal(p.controller.getSnapshot().downloadSelection[0].projectId, 'project-2');
  button(manager(p), '完成').props.onClick(); assert.equal(manager(p).props.open, false); assert.equal(p.controller.getSnapshot().downloadSelection.length, 1);
});

test('dropdown DOM stays bounded at100, highlights never reference filtered-out IDs, and empty results explain state', async t => {
  const p = page(t, (call, base) => call.action === 'projects' ? ok({ projects: Array.from({ length: 150 }, (_, i) => project(i + 1)) }) : base(call)); await open(p);
  combo(p).props.onFocus(); assert.equal(nodes(manager(p)).filter(node => node.props?.role === 'option').length, 100); assert.match(text(manager(p)), /前100项/);
  combo(p).props.onKeyDown(key('ArrowDown')); combo(p).props.onChange({ target: { value: 'not-found' } });
  assert.equal(combo(p).props['aria-activedescendant'], undefined); assert.match(text(manager(p)), /无匹配项目/);
});

test('already-focused Input click reopens suggestions; reopen resets interrupted IME and refreshes catalog without dropping choices', async t => {
  const p = page(t); await open(p); combo(p).props.onClick(); assert.equal(combo(p).props['aria-expanded'], true);
  combo(p).props.onKeyDown(key('ArrowDown')); combo(p).props.onKeyDown(key('Enter')); await settle(); assert.equal(p.controller.getSnapshot().downloadSelection.length, 1);
  assert.equal(combo(p).props['aria-expanded'], false); combo(p).props.onClick(); assert.equal(combo(p).props['aria-expanded'], true);
  combo(p).props.onCompositionStart(); button(manager(p), '完成').props.onClick();
  const before = p.calls.filter(call => call.action === 'projects').length;
  nodes(p.tree()).find(node => node.props?.['aria-label'] === '管理下载项目').props.onClick(); await settle();
  assert.equal(p.calls.filter(call => call.action === 'projects').length, before + 1); assert.equal(p.controller.getSnapshot().downloadSelection.length, 1);
  combo(p).props.onKeyDown(key('ArrowDown')); combo(p).props.onKeyDown(key('Enter')); await settle(); assert.equal(p.controller.getSnapshot().downloadSelection.length, 2);
});

test('chosen rows contain only folder labels/removal and duplicate-name disambiguation; review has no stale totals', async t => {
  const duplicate = [1, 2].map(n => ({ ...project(n), label: '同名文件夹' }));
  const p = page(t, (call, base) => call.action === 'projects' ? ok({ projects: duplicate }) : base(call)); await open(p);
  const chooseFirst = async () => { combo(p).props.onFocus(); nodes(manager(p)).find(node => node.props?.role === 'option').props.onClick(); await settle(); };
  await chooseFirst(); let chosen = nodes(manager(p)).find(node => node.props?.['aria-label'] === '已选择的下载项目');
  assert.equal(text(chosen).includes(duplicate[0].sourceRoot), false);
  await chooseFirst(); chosen = nodes(manager(p)).find(node => node.props?.['aria-label'] === '已选择的下载项目');
  for (const row of duplicate) assert.ok(text(chosen).includes(row.sourceRoot));
  assert.deepEqual(nodes(chosen).filter(node => node.type === 'native:Button').map(text), ['移除', '移除']);
  assert.doesNotMatch(text(chosen), /版本|检查点|分支|个文件|字节|2026/);
  assert.equal(p.calls.some(call => ['checkpoints', 'downloadpick', 'downloadstart'].includes(call.action)), false);
  button(manager(p), '完成').props.onClick(); button(p.tree(), '保存位置').props.onClick(); await settle();
  button(p.tree(), '下载所选').props.onClick();
  const review = nodes(p.tree()).find(node => node.type === 'native:Modal' && node.props.title === '确认下载所选项目');
  const intent = p.controller.getSnapshot().downloadIntent;
  assert.match(text(review), /将下载 2 个项目/); assert.match(text(review), /下载云端最新内容/);
  for (const item of intent.items) { assert.ok(text(review).includes(item.label)); assert.ok(text(review).includes(item.root)); }
  assert.doesNotMatch(text(review), /版本|检查点|分支|个文件|字节|2026/);
  assert.equal(nodes(review).some(node => node.props?.type === 'radio'), false);
  assert.equal(p.calls.some(call => ['checkpoints', 'downloadstart', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('catalog failure stays concise and does not show perpetual loading when search is focused', async t => {
  const p = page(t, (call, base) => call.action === 'projects' ? failure('SERVER_UNREACHABLE') : base(call)); await open(p); combo(p).props.onFocus();
  assert.match(text(manager(p)), /无法连接同步服务器/); assert.doesNotMatch(text(manager(p)), /读取中|untrusted-secret|版本|检查点/);
  assert.equal(nodes(manager(p)).some(node => node.props?.role === 'option'), false);
  assert.equal(p.calls.some(call => ['checkpoints', 'downloadpick', 'downloadstart'].includes(call.action)), false);
});

test('outside pointer and focus-out close only suggestions and add completion does not steal outside focus', async t => {
  const p = page(t); await open(p);
  combo(p).props.onFocus(); const handlers = new Map(), outsideControl = {}; let focused = 0;
  const doc = { activeElement: outsideControl, body: {}, addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); } };
  const wrapper = nodes(manager(p)).find(node => node.props?.ref && node.props.onBlur);
  wrapper.props.ref.current = { ownerDocument: doc, contains: target => target === wrapper };
  combo(p).props.ref.current = { ownerDocument: doc, focus() { ++focused; } };
  p.mount(); assert.equal(typeof handlers.get('pointerdown'), 'function');
  handlers.get('pointerdown')({ target: outsideControl }); assert.equal(combo(p).props['aria-expanded'], false); assert.equal(manager(p).props.open, true);
  combo(p).props.onClick(); nodes(manager(p)).find(node => node.props?.role === 'option').props.onClick();
  await settle(); assert.equal(focused, 0); assert.equal(p.calls.some(call => call.action === 'checkpoints'), false);
  combo(p).props.onClick(); wrapper.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: outsideControl }); assert.equal(combo(p).props['aria-expanded'], false); assert.equal(manager(p).props.open, true);
});
