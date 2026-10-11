import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createController, deriveView, parseDownloadPlan, parseDownloadStatus } from '../client/state.mjs';

// Synthetic Connection contracts only: no real filesystem, network, profile, or GUI.
const binding = { revision: 8, server: 'https://synthetic.example.test', username: 'synthetic' };
const uuid = 'a0000000-0000-4000-8000-000000000008';
const projects = [1, 2].map(n => ({ projectId: `project-${n}`, label: `项目 ${n}`, sourceRoot: `E:\\synthetic\\source-${n}`, checkpointCount: 2, latestCreatedAt: '2099-01-01T00:00:00.000Z' }));
const update = { currentVersion: '0.8.0', supported: true, state: 'idle', restartRequired: false };
const status = (extra = {}) => ({ ...binding, loggedIn: true, running: false, autoSync: false, pending: 0, intervalMs: 60000, projects: [], update, ...extra });
const browser = { id: 'browser-one', currentId: 'node-parent', path: 'E:\\synthetic', crumbs: [{ id: 'node-parent', label: 'synthetic' }], directories: [{ id: 'node-child', label: 'downloads' }], selectable: false, truncated: false };
const nested = { ...browser, currentId: 'node-child', path: 'E:\\synthetic\\downloads', directories: [], selectable: true };
const planFor = (items, suffix = 'new') => ({ latest: true, parent: nested.path, destinations: items.map(({ projectId }, n) => ({ projectId, id: `destination-${n}`, label: `项目 ${n + 1}`, parent: nested.path, root: `${nested.path}\\${suffix}-${n}` })) });
const resultFor = (id, plan, checkpointId = 'host-last-successful-commit') => ({ id, latest: true, state: 'succeeded', completed: plan.destinations.length, total: plan.destinations.length,
  items: plan.destinations.map((row, n) => ({ projectId: row.projectId, checkpointId: `${checkpointId}-${n}`, restoreId: `restore-${n}`, root: row.root, label: row.label, state: 'succeeded', sessionCount: 2, canImport: true })) });
const ok = value => ({ ok: true, value });
const denied = code => ({ ok: false, error: { code, message: 'untrusted-secret', details: { token: 'untrusted-secret' } } });
const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
function fixture(t, custom) {
  const env = { current: status(), plan: null, commit: 'host-last-successful-commit' }, calls = [];
  const base = call => {
    if (call.action === 'status') return ok(env.current);
    if (call.action === 'projects') return ok({ projects });
    if (call.action === 'downloadpick') { env.plan = planFor(call.payload.items); return ok(env.plan); }
    if (call.action === 'downloadstart') { env.current = status({ download: resultFor(call.payload.requestId, env.plan, env.commit) }); return ok({ download: env.current.download }); }
    throw new Error(`unexpected ${call.action}`);
  };
  const connection = { rpc: { async call(channel, endpoint, payload, signal) {
    const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call);
    return custom ? custom(call, base, env) : base(call);
  } } };
  const controller = createController(connection, { crypto: { randomUUID: () => uuid } });
  t.after(() => controller.dispose());
  return { controller, calls, env };
}
async function select(f, ids = ['project-1', 'project-2']) {
  await f.controller.refresh(); await f.controller.browseProjects();
  for (const id of ids) assert.equal(await f.controller.addDownloadProject(id), true);
}
async function prepare(f, ids) { await select(f, ids); assert.equal(await f.controller.chooseDownloadDestination(), true); return f.controller.prepareDownload(); }
const noPins = value => assert.doesNotMatch(JSON.stringify(value), /checkpoint|heads|versionMode|versionId/);

test('latest selection immediately freezes descriptive catalog membership without any RPC or planning', async t => {
  const f = fixture(t); await f.controller.refresh(); await f.controller.browseProjects();
  const snapshot = f.controller.getSnapshot(), before = f.calls.length;
  const added = f.controller.addDownloadProject('project-1');
  const rows = f.controller.getSnapshot().downloadSelection;
  assert.equal(rows.length, 1); assert.equal(await added, true); assert.equal(f.calls.length, before);
  assert.deepEqual(rows[0], { projectId: projects[0].projectId, label: projects[0].label, sourceRoot: projects[0].sourceRoot });
  assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0])); assert.deepEqual(snapshot.downloadSelection, []);
  assert.equal(f.controller.getSnapshot().draft, snapshot.draft); assert.equal(f.controller.getSnapshot().downloadPlan, null);
  assert.equal(deriveView(f.controller.getSnapshot()).downloadResolved, true); assert.equal(f.controller.prepareDownload(), null);
  for (const id of ['project-1', 'not-in-catalog', '../escape', '__proto__']) assert.equal(await f.controller.addDownloadProject(id), false);
  assert.equal(f.calls.length, before); noPins(rows);
});

test('latest selection ignores legacy cached multihead snapshots and their device timestamps', async t => {
  const f = fixture(t, (call, base) => call.action === 'checkpoints' ? ok({ checkpoints: ['old-a', 'old-b'].map((id, n) => ({ id, projectId: 'project-1', deviceId: `device-${n}`, parentId: null, createdAt: `${n ? '2099' : '2020'}-01-01T00:00:00.000Z`, fileCount: 999, totalBytes: 999999 })), heads: ['old-a', 'old-b'] }) : base(call));
  await f.controller.refresh(); await f.controller.browseProjects();
  f.controller.setCloudProject('project-1'); await f.controller.loadCheckpoints();
  const before = f.calls.length; await f.controller.addDownloadProject('project-1');
  assert.equal(f.calls.length, before); assert.equal(f.controller.getSnapshot().cloud.heads.length, 2);
  assert.equal(deriveView(f.controller.getSnapshot()).canChooseDownloadDestination, true);
  await f.controller.chooseDownloadDestination(); const intent = f.controller.prepareDownload();
  assert.equal(intent.latest, true); noPins(intent);
  assert.equal(await f.controller.confirmDownload(intent), true);
  assert.equal(f.controller.getSnapshot().status.download.items[0].checkpointId, 'host-last-successful-commit-0');
  assert.equal(f.calls.filter(call => call.action === 'checkpoints').length, 1);
});

test('latest pick browse select and start have exact unpinned payloads; writes require separate consent', async t => {
  const f = fixture(t, (call, base, env) => {
    if (call.action === 'downloadpick') { env.plan = planFor(call.payload.items); return ok({ latest: true, browser }); }
    if (call.action === 'downloadbrowse') return ok({ latest: true, browser: nested });
    if (call.action === 'downloadselect') return ok(env.plan);
    return base(call);
  });
  await select(f); assert.deepEqual(f.calls.map(call => call.action), ['status', 'projects']);
  await f.controller.chooseDownloadDestination(); assert.deepEqual(f.calls.at(-1).payload, { ...binding, latest: true, items: [{ projectId: 'project-1' }, { projectId: 'project-2' }] });
  await f.controller.browseDownloadDestination('node-child'); assert.deepEqual(f.calls.at(-1).payload, { ...binding, latest: true, browserId: browser.id, nodeId: 'node-child' });
  await f.controller.selectDownloadDestination(); assert.deepEqual(f.calls.at(-1).payload, { ...binding, latest: true, browserId: browser.id, nodeId: 'node-child' });
  assert.equal(f.calls.some(call => call.action === 'downloadstart'), false);
  const intent = f.controller.prepareDownload(); assert.equal(f.controller.prepareDownload(), intent);
  assert.deepEqual(Object.keys(intent).sort(), ['binding', 'items', 'kind', 'latest', 'plan', 'requestId']);
  assert.deepEqual(intent.binding, binding); assert.ok(Object.isFrozen(intent.binding) && Object.isFrozen(intent.items) && Object.isFrozen(intent.items[0])); noPins(intent);
  await f.controller.confirmDownload(intent); assert.equal(await f.controller.confirmDownload(intent), false);
  assert.deepEqual(f.calls.find(call => call.action === 'downloadstart').payload, { ...binding, latest: true, items: [{ projectId: 'project-1', destinationId: 'destination-0' }, { projectId: 'project-2', destinationId: 'destination-1' }], requestId: uuid, confirm: true });
  assert.equal(f.calls.some(call => ['restore', 'checkpoints', 'import', 'preferences', 'sync'].includes(call.action)), false);
});

test('latest plan parser rejects downgrade markers and pinned overrides rather than stripping them', () => {
  const selected = [{ projectId: 'project-1' }, { projectId: 'project-2' }], plan = planFor(selected);
  assert.deepEqual(parseDownloadPlan(plan, selected), plan);
  for (const latest of [undefined, false, null, 1, 'true']) assert.throws(() => parseDownloadPlan({ ...plan, latest }, selected), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseDownloadPlan(without(plan, 'latest'), selected), { code: 'INVALID_RESPONSE' });
  for (const key of ['checkpointId', 'checkpoint', 'checkpoints', 'heads', 'versionMode', 'versionId']) {
    assert.throws(() => parseDownloadPlan({ ...plan, [key]: undefined }, selected), { code: 'INVALID_RESPONSE' });
    assert.throws(() => parseDownloadPlan({ ...plan, destinations: plan.destinations.map(row => ({ ...row, [key]: 'old' })) }, selected), { code: 'INVALID_RESPONSE' });
    assert.throws(() => parseDownloadPlan(plan, selected.map(row => ({ ...row, [key]: 'old' }))), { code: 'INVALID_RESPONSE' });
  }
  for (const rows of [[], [selected[0], selected[0]], [{ projectId: '../bad' }, selected[1]], [{ projectId: 'foreign' }, selected[1]]]) assert.throws(() => parseDownloadPlan(plan, rows), { code: 'INVALID_RESPONSE' });
  for (const patch of [{ projectId: 'foreign' }, { root: plan.parent }, { root: `${plan.parent}\\..` }, { root: `${plan.parent}\\nested\\child` }, { id: 'constructor' }, { label: 'bad\nlabel' }]) assert.throws(() => parseDownloadPlan({ ...plan, destinations: [{ ...plan.destinations[0], ...patch }, plan.destinations[1]] }, selected), { code: 'INVALID_RESPONSE' });
});

test('generic download status permits old records but optional latest is strictly true', async t => {
  const latest = resultFor(uuid, planFor([{ projectId: 'project-1' }]));
  const old = without(latest, 'latest'); assert.deepEqual(parseDownloadStatus(old), old);
  assert.equal(parseDownloadStatus(latest).latest, true);
  for (const marker of [false, null, undefined, 'true', 1]) assert.throws(() => parseDownloadStatus({ ...latest, latest: marker }), { code: 'INVALID_RESPONSE' });
  const f = fixture(t); f.env.current = status({ download: old }); await f.controller.refresh();
  assert.deepEqual(f.controller.getSnapshot().status.download, old); assert.equal(f.controller.getSnapshot().downloadUncertain, false);
  assert.ok(f.controller.prepareDownloadImport(old.items[0].restoreId)); assert.equal(f.calls.some(call => call.action === 'downloadstart'), false);
});

test('old or pinned Host pick replies fail closed with no pinned fallback or writes', async t => {
  const selected = [{ projectId: 'project-1' }], plan = planFor(selected);
  const replies = [without(plan, 'latest'), { ...plan, latest: false }, { browser }, { latest: true, browser, checkpointId: 'old' }, { latest: true, browser: { ...browser, checkpointId: 'old' } }, { ...plan, destinations: plan.destinations.map(row => ({ ...row, checkpointId: 'old' })) }];
  for (const reply of replies) {
    const f = fixture(t, (call, base) => call.action === 'downloadpick' ? ok(reply) : base(call)); await select(f, ['project-1']);
    assert.equal(await f.controller.chooseDownloadDestination(), false);
    assert.equal(f.controller.getSnapshot().downloadPlan, null); assert.equal(f.controller.getSnapshot().downloadBrowser, null);
    assert.equal(f.controller.getSnapshot().downloadError.code, 'INVALID_RESPONSE'); assert.match(f.controller.getSnapshot().downloadError.message, /升级/);
    assert.equal(f.controller.prepareDownload(), null); assert.equal(f.calls.some(call => ['destinationpick', 'checkpoints', 'restore', 'downloadstart'].includes(call.action)), false);
  }
});

test('latest browser continuations cannot downgrade their browser or plan DTOs', async t => {
  for (const action of ['downloadbrowse', 'downloadselect']) {
    const f = fixture(t, (call, base) => {
      if (call.action === 'downloadpick') return ok({ latest: true, browser: nested });
      if (call.action === action) return ok(action === 'downloadbrowse' ? { browser: nested } : without(planFor([{ projectId: 'project-1' }]), 'latest'));
      return base(call);
    });
    await select(f, ['project-1']); await f.controller.chooseDownloadDestination();
    const outcome = action === 'downloadbrowse' ? await f.controller.browseDownloadDestination(nested.currentId) : await f.controller.selectDownloadDestination();
    assert.equal(outcome, false); assert.equal(f.controller.getSnapshot().downloadBrowser, null); assert.equal(f.controller.getSnapshot().downloadPlan, null);
    assert.equal(f.controller.getSnapshot().downloadError.code, 'INVALID_RESPONSE'); noPins(f.calls.at(-1).payload);
  }
});

test('latest ACK must match mode request projects and exact roots, with no replay on ambiguity', async t => {
  const mutations = [
    value => without(value, 'latest'), value => ({ ...value, latest: false }), value => ({ ...value, id: 'other-request' }),
    value => ({ ...value, items: value.items.map(row => ({ ...row, projectId: 'foreign' })) }),
    value => ({ ...value, items: value.items.map(row => ({ ...row, root: row.root.toLowerCase() })) }),
  ];
  for (const mutate of mutations) {
    const f = fixture(t, (call, base, env) => call.action === 'downloadstart' ? ok({ download: mutate(resultFor(call.payload.requestId, env.plan)) }) : base(call));
    const intent = await prepare(f, ['project-1']); assert.equal(await f.controller.confirmDownload(intent), false);
    assert.equal(f.controller.getSnapshot().downloadUncertain, true); assert.equal(f.controller.getSnapshot().downloadPending, intent);
    assert.equal(f.controller.prepareDownload(), null); assert.equal(await f.controller.confirmDownload(intent), false);
    assert.equal(f.calls.filter(call => call.action === 'downloadstart').length, 1); assert.equal(f.controller.getSnapshot().downloadPlan, null);
  }
  const f = fixture(t, (call, base, env) => call.action === 'downloadstart' ? ok({ latest: false, download: resultFor(uuid, env.plan) }) : base(call));
  assert.equal(await f.controller.confirmDownload(await prepare(f)), false); assert.equal(f.controller.getSnapshot().downloadUncertain, true);
});

test('Host may commit new content after planning and ACK its actual checkpoint without invalidating consent', async t => {
  const f = fixture(t); const intent = await prepare(f);
  const snapshot = f.controller.getSnapshot(), planned = intent.plan;
  f.env.commit = 'new-commit-after-planning'; assert.equal(await f.controller.confirmDownload(intent), true);
  assert.equal(f.controller.getSnapshot().status.download.items[0].checkpointId, 'new-commit-after-planning-0');
  assert.equal(f.controller.getSnapshot().downloadUncertain, false); assert.equal(f.controller.getSnapshot().downloadPending, null);
  assert.equal(snapshot.downloadPlan, planned); assert.equal(snapshot.downloadSelection, f.controller.getSnapshot().downloadSelection); noPins(intent);
  assert.equal(f.calls.filter(call => call.action === 'downloadstart').length, 1);
});

test('lost latest ACK reconciles only latest project/root status, not a cached GUI checkpoint or old-mode record', async t => {
  const f = fixture(t, (call, base) => call.action === 'downloadstart' ? Promise.reject(new Error('untrusted-secret')) : base(call));
  const intent = await prepare(f, ['project-1']); await f.controller.confirmDownload(intent);
  const actual = resultFor(intent.requestId, intent.plan, 'new-actual-commit');
  for (const stale of [without(actual, 'latest'), { ...actual, items: actual.items.map(row => ({ ...row, root: row.root + '-other' })) }, { ...actual, items: actual.items.map(row => ({ ...row, projectId: 'foreign' })) }]) {
    f.env.current = status({ download: stale }); assert.equal(await f.controller.refresh(), false);
    assert.equal(f.controller.getSnapshot().downloadPending, intent); assert.equal(f.controller.getSnapshot().downloadUncertain, true);
  }
  f.env.current = status({ download: actual }); assert.equal(await f.controller.refresh(), true);
  assert.equal(f.controller.getSnapshot().downloadPending, null); assert.equal(f.controller.getSnapshot().downloadUncertain, false);
  assert.equal(f.controller.getSnapshot().status.download.items[0].checkpointId, 'new-actual-commit-0');
  assert.equal(f.calls.filter(call => call.action === 'downloadstart').length, 1); assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /untrusted-secret/);
});

test('latest consent keeps immutable snapshots and rejects removed/re-added selection or replaced plan identity', async t => {
  const f = fixture(t); const first = await prepare(f);
  assert.throws(() => { first.items[0].root = 'E:\\other'; }, TypeError);
  assert.throws(() => { first.plan.destinations[0].id = 'other'; }, TypeError);
  f.env.plan.destinations[0].root = 'E:\\untrusted'; assert.notEqual(first.plan.destinations[0].root, f.env.plan.destinations[0].root);
  assert.equal(await f.controller.confirmDownload({ ...first }), false);
  await f.controller.chooseDownloadDestination(); assert.equal(f.controller.getSnapshot().downloadIntent, null);
  assert.equal(await f.controller.confirmDownload(first), false);
  const second = f.controller.prepareDownload(); f.controller.removeDownloadProject('project-1'); await f.controller.addDownloadProject('project-1');
  assert.equal(f.controller.getSnapshot().downloadPlan, null); assert.equal(await f.controller.confirmDownload(second), false);
  assert.equal(f.calls.some(call => call.action === 'downloadstart'), false);
});

test('latest plans and consent invalidate on all binding runtime and update-barrier changes', async t => {
  for (const patch of [{ revision: 9 }, { server: 'https://changed.example.test' }, { username: 'changed' }, { loggedIn: false }, { update: { ...update, currentVersion: '0.8.1' } }, { update: { ...update, state: 'installing', requestId: 'update-one', restartRequired: true } }, { update: { ...update, state: 'restart-required', restartRequired: true } }]) {
    const f = fixture(t); const intent = await prepare(f);
    f.env.current = status(patch); await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().downloadPlan, null); assert.equal(f.controller.getSnapshot().downloadIntent, null);
    assert.equal(await f.controller.confirmDownload(intent), false); assert.equal(f.calls.some(call => call.action === 'downloadstart'), false);
    if (['revision', 'server', 'username', 'loggedIn'].some(key => Object.hasOwn(patch, key))) assert.deepEqual(f.controller.getSnapshot().downloadSelection, []);
  }
});

test('latest empty and mismatch errors are concise public failures, never technical history instructions', async t => {
  for (const [code, message] of [['CLOUD_PROJECT_EMPTY', '云端暂无内容'], ['CHECKPOINT_MISMATCH', '云端内容与项目不匹配']]) {
    const f = fixture(t, (call, base) => call.action === 'downloadstart' ? denied(code) : base(call));
    const intent = await prepare(f); assert.equal(await f.controller.confirmDownload(intent), false);
    assert.deepEqual(f.controller.getSnapshot().downloadError, { code, message }); assert.equal(f.controller.getSnapshot().downloadUncertain, false);
    assert.equal(f.controller.getSnapshot().downloadPlan, null); assert.equal(await f.controller.confirmDownload(intent), false);
    assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /untrusted-secret/);
  }
});

test('latest partial downloads retain per-item safe import consent independent of mode and actual checkpoint', async t => {
  const f = fixture(t, (call, base, env) => {
    if (call.action !== 'import') return base(call);
    const row = env.current.download.items.find(item => item.restoreId === call.payload.restoreId);
    const recovery = { id: call.payload.requestId, kind: 'import', state: 'succeeded', root: row.root, importedCount: 1, skippedCount: 0, failedCount: 0 };
    env.current = status({ download: { ...env.current.download, items: env.current.download.items.map(item => item === row ? { ...item, canImport: false, importResult: recovery } : item) } });
    return ok({ recovery });
  });
  const completed = resultFor('previous-batch', planFor(projects));
  f.env.current = status({ download: { ...completed, state: 'partial', items: [completed.items[0], { ...completed.items[1], state: 'failed', canImport: false, errorCode: 'RESTORE_FAILED' }] } });
  await f.controller.refresh(); assert.equal(f.controller.prepareDownloadImport('restore-1'), null);
  const intent = f.controller.prepareDownloadImport('restore-0'); assert.ok(intent); assert.equal(Object.hasOwn(intent, 'latest'), false);
  assert.equal(f.calls.some(call => call.action === 'import'), false); assert.equal(await f.controller.confirmDownloadImport(intent), true);
  assert.deepEqual(f.calls.find(call => call.action === 'import').payload, { ...binding, restoreId: 'restore-0', requestId: uuid, confirm: true });
  assert.equal(await f.controller.confirmDownloadImport(intent), false); assert.equal(f.controller.getSnapshot().status.download.items[1].state, 'failed');
});

test('adapter removes download history controls and totals without changing Host module entry', async () => {
  const source = await readFile(new URL('../client/adapter.mjs', import.meta.url), 'utf8');
  assert.equal(source.slice(0, source.indexOf('\n')), "import { createController, deriveView, filterProjects } from './state.mjs';");
  assert.doesNotMatch(source, /expandedVersion|versionLabel|downloadTotals|bytesLabel|loadDownloadCheckpoints|setDownloadCheckpoint|checkpointId|row\.heads|row\.checkpoints|需选择版本|检查点|刷新版本|分支选择|type: 'radio'/);
  assert.match(source, /下载云端最新内容/); assert.match(source, /onCompositionStart/); assert.match(source, /data-download-remove/);
  assert.doesNotMatch(source, /\bfetch\s*\(|showDirectoryPicker|localStorage|sessionStorage/);
});
