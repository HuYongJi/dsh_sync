import test from 'node:test';
import assert from 'node:assert/strict';
import { BIDIRECTIONAL_ACTIONS, MAX_ONBOARDING_PROJECTS, createBidirectionalController, parseSyncStatus } from '../client/bidirectional-state.mjs';
import { createBidirectionalPanel } from '../client/bidirectional-panel.mjs';

// Synthetic controller and injected native React/control contracts, not real GUI integration.
// No profile, filesystem picker, cloud, network, browser file APIs or generated artifacts.
const identity = { server: 'https://synthetic.example.test', username: 'batch-owner', loggedIn: true };
const authority = { revision: 7, server: identity.server, username: identity.username };
const workspaces = Array.from({ length: 22 }, (_, i) => ({ id: `workspace:${i}`, label: `本地 ${i}`, root: `E:\\synthetic\\local-${i}`, available: true }));
const projects = Array.from({ length: 22 }, (_, i) => ({ projectId: `cloud-${i}`, label: `云端 ${i}`, legacy: i < 2 }));
const healthyBinding = { id: 'healthy-binding', workspaceId: workspaces[21].id, projectId: 'healthy-cloud', label: '健康项目', root: workspaces[21].root, enabled: true, state: 'idle' };
const summary = extra => ({ upload: 0, download: 0, delete: 0, conflicts: 0, blocked: 0, ...extra });
const aggregate = items => Object.fromEntries(Object.keys(summary()).map(key => [key, items.reduce((sum, item) => sum + item.summary[key], 0)]));
const status = extra => ({ ...authority, ...identity, capability: 'supported', workspaces, bindings: [], operations: [], ...extra });
const browser = extra => ({ id: 'browser-one', path: 'E:\\synthetic-parent', currentId: 'node-parent', crumbs: [{ id: 'node-drive', label: 'E:' }], directories: [{ id: 'node-child', label: '目标父目录' }], selectable: true, truncated: false, ...extra });
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted-secret', token: 'untrusted-secret' } });
const deferred = () => Promise.withResolvers();
async function settle() { for (let i = 0; i < 80; ++i) await Promise.resolve(); }
function clock() {
  const jobs = new Map(); let time = Date.now(), next = 0;
  return { jobs, now: () => time, advance: ms => { time += ms; }, setTimeout(fn, ms) { jobs.set(++next, { fn, ms }); return next; }, clearTimeout(id) { jobs.delete(id); }, run(ms) { const entry = [...jobs].find(([, job]) => job.ms === ms); assert.ok(entry, `missing timer ${ms}`); jobs.delete(entry[0]); entry[1].fn(); } };
}
function fixture(t, custom, options = {}) {
  const calls = [], time = clock(), plans = new Map(); let next = 0, nextPlan = 0, current = status(), selected = [], parent = 'E:\\synthetic-parent';
  const destination = () => ({ id: 'destination-one', parent, expiresAt: time.now() + 60000, items: selected.map(projectId => ({ projectId, label: projects.find(row => row.projectId === projectId)?.label ?? projectId, root: `${parent}\\new-${projectId}` })) });
  const makePlan = fields => { const plan = { id: `plan-${++nextPlan}`, expiresAt: time.now() + 60000, ...fields }; plans.set(plan.id, plan); return { plan }; };
  const batch = (requestId, plan, kind, extra = {}) => ({ id: requestId, kind, at: new Date(time.now()).toISOString(), state: 'running', ...(plan.parent ? { parent: plan.parent } : {}), items: plan.items.map((item, i) => ({ ...item, id: `item-${i}`, state: 'pending', phase: 'pending' })), ...extra });
  const env = { get current() { return current; }, set current(value) { current = value; }, time, destination, makePlan, plans, batch };
  function base(call) {
    const body = call.payload;
    if (call.action === 'syncstatus') return ok(current);
    if (call.action === 'syncprojects') { current = { ...current, capability: 'supported' }; return ok({ projects }); }
    if (call.action === 'syncclonepick') { selected = [...body.projectIds]; return ok({ browser: browser() }); }
    if (call.action === 'syncclonebrowse') { parent = 'E:\\synthetic-parent\\child'; return ok({ browser: browser({ path: parent, currentId: 'node-child', crumbs: [{ id: 'node-parent', label: '父目录' }], directories: [] }) }); }
    if (call.action === 'synccloneselect') return ok({ destination: destination() });
    if (call.action === 'synccloneplan') { const target = destination(), items = target.items.map(item => ({ ...item, summary: summary({ download: 2 }), migrationRequired: item.projectId === 'cloud-0' })); return ok(makePlan({ parent: target.parent, items, summary: aggregate(items) })); }
    if (call.action === 'syncpublishplan') {
      current = { ...current, capability: 'supported' };
      const items = body.workspaceIds.map((workspaceId, i) => { const row = current.workspaces.find(row => row.id === workspaceId); return { workspaceId, projectId: `fresh-${i}`, label: row.label, root: row.root, summary: summary({ upload: 3 }) }; });
      return ok(makePlan({ items, summary: aggregate(items) }));
    }
    if (['syncclonecommit', 'syncpublishcommit'].includes(call.action)) {
      const kind = call.action === 'syncclonecommit' ? 'clone' : 'publish';
      current = { ...current, onboarding: [...(current.onboarding ?? []), batch(body.requestId, plans.get(body.planId), kind)] };
      return ok({ accepted: true, operationId: body.requestId });
    }
    if (call.action === 'syncrun') {
      current = { ...current, operations: [...current.operations, { id: body.requestId, kind: 'run', state: 'succeeded', bindingId: body.bindingId }] };
      return ok({ accepted: true, operationId: body.requestId });
    }
    throw new Error(`unexpected action: ${call.action}`);
  }
  const connection = { rpc: { async call(channel, endpoint, payload, signal) { const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call); return custom ? custom(call, base, env) : base(call); } } };
  const controller = createBidirectionalController(connection, { ...time, crypto: { randomUUID: () => `a0000000-0000-4000-8000-${String(++next).padStart(12, '0')}` }, ...options });
  t.after(() => controller.dispose()); return { controller, connection, calls, time, env };
}
async function publish(f, count = 2) {
  await f.controller.refresh(); assert.equal(f.controller.openPublish(), true);
  for (let i = 0; i < count; ++i) assert.equal(f.controller.selectOnboarding(workspaces[i].id, true), true);
  assert.equal(await f.controller.planPublish(), true); return f.controller.getSnapshot().dialog.plan;
}
async function chooseClone(f, count = 2) {
  await f.controller.refresh(); assert.equal(await f.controller.openClone(), true);
  for (let i = 0; i < count; ++i) assert.equal(f.controller.selectOnboarding(projects[i].projectId, true), true);
  assert.equal(await f.controller.pickCloneParent(), true);
}
async function clone(f, count = 2) {
  await chooseClone(f, count); assert.equal(await f.controller.selectCloneParent(), true); assert.equal(await f.controller.planClone(), true); return f.controller.getSnapshot().dialog.plan;
}

test('onboarding adds only seven bidirectional actions and no removed one-way RPCs', () => {
  assert.equal(MAX_ONBOARDING_PROJECTS, 20);
  for (const action of ['syncclonepick', 'syncclonebrowse', 'synccloneselect', 'synccloneplan', 'syncclonecommit', 'syncpublishplan', 'syncpublishcommit']) assert.ok(BIDIRECTIONAL_ACTIONS.includes(action));
  for (const action of ['projects', 'downloadpick', 'downloadbrowse', 'downloadselect', 'downloadstart', 'registerproject', 'restore', 'import', 'destinationpick']) assert.equal(BIDIRECTIONAL_ACTIONS.includes(action), false);
});

test('bounded onboarding status deeply allowlists identities, paths, safe phases and per-item outcomes', () => {
  const item = { id: 'item-one', projectId: 'cloud-one', workspaceId: 'workspace:one', bindingId: 'binding-one', label: '项目', root: 'E:\\parent\\child', state: 'failed', phase: 'untrusted-secret', errorCode: 'untrusted-secret', rawError: 'untrusted-secret' };
  const batch = { id: 'request-one', kind: 'clone', state: 'partial', at: new Date().toISOString(), parent: 'E:\\parent', items: [item], token: 'untrusted-secret' };
  const parsed = parseSyncStatus(status({ onboarding: [batch] }));
  assert.equal(parsed.onboarding[0].items[0].phase, 'unknown'); assert.equal(parsed.onboarding[0].items[0].errorCode, 'SYNC_FAILED');
  assert.equal(JSON.stringify(parsed).includes('untrusted-secret'), false);
  for (const value of [parsed.onboarding, parsed.onboarding[0], parsed.onboarding[0].items, parsed.onboarding[0].items[0]]) assert.ok(Object.isFrozen(value));
  for (const patch of [{ kind: 'restore' }, { state: 'rolled-back' }, { at: 'bad-date' }, { parent: 'E:\\elsewhere' }, { items: [] }, { items: [item, item] }, { items: [{ ...item, root: 'E:\\parent\\..\\escape' }] }, { items: [{ ...item, phase: 'unsafe\nphase' }] }, { items: Array.from({ length: 21 }, (_, i) => ({ ...item, id: `item-${i}`, root: `E:\\parent\\child-${i}` })) }]) assert.throws(() => parseSyncStatus(status({ onboarding: [{ ...batch, ...patch }] })), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseSyncStatus(status({ onboarding: Array.from({ length: 101 }, (_, i) => ({ ...batch, id: `batch-${i}` })) })), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(parseSyncStatus(status()).onboarding, []);
});

test('local checkbox selection has no cloud read, default choice, pairing or side effect; batch max20 enforced', async t => {
  const f = fixture(t); f.env.current = status({ capability: 'unknown' }); await f.controller.refresh(); const before = f.calls.length;
  assert.equal(f.controller.openPublish(), true); assert.deepEqual(f.controller.getSnapshot().dialog.selectedIds, []);
  assert.equal(await f.controller.planPublish(), false); assert.equal(f.controller.selectOnboarding('E:\\arbitrary', true), false);
  for (let i = 0; i < 20; ++i) assert.equal(f.controller.selectOnboarding(workspaces[i].id, true), true);
  assert.equal(f.controller.selectOnboarding(workspaces[20].id, true), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'SYNC_BATCH_LIMIT');
  assert.equal(f.calls.length, before); assert.equal(f.controller.selectOnboarding(workspaces[0].id, false), true); assert.equal(f.controller.selectOnboarding(workspaces[20].id, true), true);
  assert.equal(await f.controller.planPublish(), true); assert.equal(f.controller.getSnapshot().status.capability, 'supported');
  assert.deepEqual(f.calls.slice(before).map(row => row.action), ['syncpublishplan', 'syncstatus']);
  assert.deepEqual(Object.keys(f.calls.find(row => row.action === 'syncpublishplan').payload).sort(), [...Object.keys(authority), 'workspaceIds'].sort());
  const plan = f.controller.getSnapshot().dialog.plan; assert.equal(plan.items.length, 20); assert.ok(Object.isFrozen(plan.items[0].summary));
  f.controller.closeDialog(); assert.equal(await f.controller.confirmPublish(plan), false); assert.equal(f.calls.some(row => /commit$/.test(row.action)), false);
});

test('cloud catalog is lazy, same-identity/revision short-lived cache only, with explicit refresh', async t => {
  const f = fixture(t); await f.controller.refresh(); f.controller.openPublish(); f.controller.selectOnboarding(workspaces[0].id, true); await f.controller.reloadDialog(); f.controller.closeDialog();
  assert.ok(f.calls.every(row => row.action === 'syncstatus'));
  const before = f.calls.length; assert.equal(await f.controller.openClone(), true); assert.deepEqual(f.calls.slice(before).map(row => row.action), ['syncprojects']);
  assert.deepEqual(f.controller.getSnapshot().dialog.selectedIds, []); f.controller.closeDialog(); const cached = f.calls.length;
  assert.equal(await f.controller.openClone(), true); assert.equal(f.calls.length, cached); f.controller.closeDialog();
  f.time.advance(30001); assert.equal(await f.controller.openClone(), true); assert.equal(f.calls.filter(row => row.action === 'syncprojects').length, 2);
  const refreshAt = f.calls.length; assert.equal(await f.controller.reloadDialog(), true); assert.deepEqual(f.calls.slice(refreshAt).map(row => row.action), ['syncstatus', 'syncprojects']);
  f.env.current = status({ revision: 8 }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().projects.loaded, false); f.controller.closeDialog(); await f.controller.openClone();
  assert.equal(f.calls.filter(row => row.action === 'syncprojects').length, 4);
  f.controller.setIdentity({ ...identity, username: 'other' }); f.controller.setIdentity(identity); assert.equal(f.controller.getSnapshot().projects.items.length, 0); assert.equal(await f.controller.openClone(), false);
  await f.controller.refresh(); await f.controller.openClone(); assert.equal(f.calls.filter(row => row.action === 'syncprojects').length, 5);
});

test('cloud batch selects one Host parent and fresh children, never existing local association or paths in requests', async t => {
  const f = fixture(t); await chooseClone(f); const s = f.controller.getSnapshot(); assert.equal(s.dialog.stage, 'folder');
  assert.deepEqual(f.calls.find(row => row.action === 'syncclonepick').payload, { ...authority, projectIds: ['cloud-0', 'cloud-1'] });
  assert.equal(await f.controller.browseCloneParent('E:\\arbitrary'), false); assert.equal(await f.controller.browseCloneParent('node-child'), true);
  assert.deepEqual(f.calls.find(row => row.action === 'syncclonebrowse').payload, { ...authority, browserId: 'browser-one', nodeId: 'node-child' });
  assert.equal(await f.controller.selectCloneParent(), true); assert.equal(f.controller.getSnapshot().dialog.stage, 'destination');
  assert.deepEqual(f.calls.find(row => row.action === 'synccloneselect').payload, { ...authority, browserId: 'browser-one', nodeId: 'node-child' });
  assert.equal(f.calls.some(row => /commit$|mkdir|registerproject|pairplan/.test(row.action)), false);
  assert.equal(await f.controller.planClone(), true); const plan = f.controller.getSnapshot().dialog.plan;
  assert.equal(plan.items.length, 2); assert.equal(plan.parent, 'E:\\synthetic-parent\\child'); assert.notEqual(plan.items[0].root, plan.items[1].root);
  assert.deepEqual(f.calls.find(row => row.action === 'synccloneplan').payload, { ...authority, destinationId: 'destination-one' });
  assert.equal(await f.controller.confirmClone({ ...plan }), false); const writing = f.controller.confirmClone(plan); assert.equal(await f.controller.confirmClone(plan), false); assert.equal(await writing, true);
  const writes = f.calls.filter(row => row.action === 'syncclonecommit'); assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].payload).sort(), ['confirm', 'planId', 'requestId', ...Object.keys(authority)].sort());
  assert.equal(writes[0].payload.confirm, true); assert.equal(f.controller.getSnapshot().dialog.batch.items.length, 2);
  assert.equal(f.calls.some(row => row.action.startsWith('pair')), false);
});

test('native picker cancellation/unavailability are actionable and no preview automatically submits', async t => {
  for (const result of [ok({ cancelled: true }), failure('SYNC_PICKER_UNAVAILABLE')]) {
    const f = fixture(t, (call, base) => call.action === 'syncclonepick' ? result : base(call)); await f.controller.refresh(); await f.controller.openClone(); f.controller.selectOnboarding('cloud-0', true);
    await f.controller.pickCloneParent(); const dialog = f.controller.getSnapshot().dialog; assert.equal(dialog.stage, 'choose'); assert.equal(dialog.destination, null); assert.equal(dialog.plan, null);
    assert.match(dialog.message || dialog.error.message, /取消|不可用/); assert.equal(f.calls.some(row => row.action === 'syncclonecommit'), false);
  }
  const native = fixture(t, (call, base, env) => { const result = base(call); return call.action === 'syncclonepick' ? ok({ destination: env.destination() }) : result; });
  await chooseClone(native); assert.equal(native.controller.getSnapshot().dialog.stage, 'destination'); assert.equal(native.calls.some(row => row.action === 'synccloneplan'), false);
  const unavailable = fixture(t, (call, base) => { const result = base(call); if (call.action === 'syncclonepick') result.value.browser.selectable = false; return result; });
  await chooseClone(unavailable); assert.equal(await unavailable.controller.selectCloneParent(), false); assert.equal(unavailable.calls.some(row => row.action === 'synccloneselect'), false);
});

test('invalid parent, roots, child substitutions and aggregate DTOs never authorize a write', async t => {
  const badDestinations = [value => { value.parent = 'relative'; }, value => { value.items[0].root = value.parent; }, value => { value.items[0].root = 'E:\\elsewhere\\child'; }, value => { value.items[0].root = `${value.parent}\\nested\\child`; }, value => { value.items[0].root = `${value.parent}\\..\\escape`; }, value => { value.items[0].root = `${value.parent}\\bad:stream`; }, value => { value.items[0].root = `${value.parent}\\child.`; }, value => { value.items[1].root = value.items[0].root.toUpperCase(); }, value => { value.items[0].projectId = 'not-selected'; }, value => { value.items.pop(); }, value => { value.parent = 'E:\\synthetic'; value.items[0].root = workspaces[0].root; }];
  for (const change of badDestinations) {
    const f = fixture(t, (call, base) => { const result = base(call); if (call.action === 'synccloneselect') change(result.value.destination); return result; }); await chooseClone(f);
    assert.equal(await f.controller.selectCloneParent(), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE'); assert.equal(f.controller.getSnapshot().dialog.plan, null);
  }
  for (const change of [plan => { plan.parent = 'E:\\outside'; }, plan => { plan.items[0].root += '-swapped'; }, plan => { plan.items[0].migrationRequired = 'yes'; }, plan => { plan.items[0].summary.upload = 1; }, plan => { plan.summary.download += 1; }, plan => { plan.items = [plan.items[0], plan.items[0]]; }]) {
    const f = fixture(t, (call, base) => { const result = base(call); if (call.action === 'synccloneplan') change(result.value.plan); return result; }); await chooseClone(f); await f.controller.selectCloneParent();
    assert.equal(await f.controller.planClone(), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE'); assert.equal(f.calls.some(row => /commit$/.test(row.action)), false);
  }
  for (const change of [plan => { plan.items[0].root = 'E:\\outside'; }, plan => { plan.items[0].workspaceId = 'not-selected'; }, plan => { plan.items[1].workspaceId = plan.items[0].workspaceId; }, plan => { plan.items[1].projectId = plan.items[0].projectId; }]) {
    const f = fixture(t, (call, base) => { const result = base(call); if (call.action === 'syncpublishplan') change(result.value.plan); return result; }); await f.controller.refresh(); f.controller.openPublish(); f.controller.selectOnboarding(workspaces[0].id, true); f.controller.selectOnboarding(workspaces[1].id, true);
    assert.equal(await f.controller.planPublish(), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE');
  }
});

test('clone legacy branches require explicit per-project choices using checkpoint IDs only', async t => {
  const f = fixture(t, (call, base) => call.action === 'synccloneplan' && !call.payload.primaryLegacyIds ? ok({ requiresLegacyChoice: true, choices: projects.slice(0, 2).map(row => ({ projectId: row.projectId, label: row.label, heads: [{ id: `${row.projectId}-a`, label: '分支 A' }, { id: `${row.projectId}-b`, label: '分支 B' }] })) }) : base(call));
  await chooseClone(f); await f.controller.selectCloneParent(); await f.controller.planClone(); assert.equal(f.controller.getSnapshot().dialog.stage, 'legacy'); assert.deepEqual(f.controller.getSnapshot().dialog.primaryLegacyIds, []);
  assert.equal(f.controller.selectCloneLegacy('cloud-0', 'cloud-1-a'), false); assert.equal(await f.controller.planClone(), false);
  assert.equal(f.controller.selectCloneLegacy('cloud-0', 'cloud-0-b'), true); assert.equal(await f.controller.planClone(), false); assert.equal(f.controller.selectCloneLegacy('cloud-1', 'cloud-1-a'), true);
  assert.equal(await f.controller.planClone(), true); assert.deepEqual(f.calls.filter(row => row.action === 'synccloneplan').at(-1).payload, { ...authority, destinationId: 'destination-one', primaryLegacyIds: [{ projectId: 'cloud-0', checkpointId: 'cloud-0-b' }, { projectId: 'cloud-1', checkpointId: 'cloud-1-a' }] });
  assert.equal(f.calls.some(row => row.action === 'syncclonecommit'), false);
});

test('lost ACK reconciles original batch request only, exposes partial results, never retries or changes request ID', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncclonecommit' ? Promise.reject(new Error('untrusted-secret')) : base(call));
  const stop = f.controller.watch(); await settle(); const plan = await clone(f); assert.equal(await f.controller.confirmClone(plan), false);
  const requestId = f.calls.find(row => row.action === 'syncclonecommit').payload.requestId; assert.equal(f.controller.getSnapshot().uncertain, true);
  for (const batch of [f.env.batch('different-request', plan, 'clone', { state: 'succeeded', items: plan.items.map((item, i) => ({ ...item, id: `other-${i}`, state: 'succeeded', phase: 'complete' })) }), f.env.batch(requestId, plan, 'publish')]) {
    if (batch.kind === 'publish') delete batch.parent;
    f.env.current = status({ onboarding: [batch] }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().pending[0].requestId, requestId); assert.equal(f.controller.getSnapshot().uncertain, true);
  }
  f.controller.closeDialog(); assert.equal(await f.controller.openClone(), false); assert.equal(await f.controller.confirmClone(plan), false);
  const completed = f.env.batch(requestId, plan, 'clone', { state: 'partial', items: plan.items.map((item, i) => ({ ...item, id: `item-${i}`, state: i ? 'failed' : 'succeeded', phase: i ? 'failed' : 'complete', ...(i ? { errorCode: 'untrusted-secret', error: 'untrusted-secret' } : { workspaceId: 'created-workspace', bindingId: 'created-binding' }) })) });
  f.env.current = status({ onboarding: [completed] }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().pending.length, 0); assert.match(f.controller.getSnapshot().notice, /部分项目完成/);
  assert.equal(f.controller.openOnboardingStatus(requestId), true); assert.equal(f.controller.getSnapshot().dialog.batch.items[1].errorCode, 'SYNC_FAILED'); assert.equal(f.controller.back(), false); assert.equal(await f.controller.reloadDialog(), false);
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret'), false); assert.equal(f.calls.filter(row => row.action === 'syncclonecommit').length, 1); stop();
});

test('terminal unknown registration consumes original intent but permits unrelated healthy work and fresh explicit consent', async t => {
  for (const batchState of ['partial', 'uncertain']) for (const lostAck of [false, true]) {
    const f = fixture(t, (call, base) => lostAck && call.action === 'syncclonecommit' ? Promise.reject(new Error('lost ACK')) : base(call));
    const stop = f.controller.watch(); await settle(); const plan = await clone(f); await f.controller.confirmClone(plan); const requestId = f.calls.find(row => row.action === 'syncclonecommit').payload.requestId;
    const terminal = f.env.batch(requestId, plan, 'clone', { state: batchState, items: plan.items.map((item, i) => ({ ...item, id: `item-${i}`, state: i ? 'uncertain' : 'succeeded', phase: i ? 'registering' : 'complete', ...(i ? { errorCode: 'PROJECT_REGISTRATION_UNCERTAIN' } : {}) })) });
    f.env.current = status({ revision: 8, bindings: [healthyBinding], onboarding: [terminal] }); await f.controller.refresh();
    let snapshot = f.controller.getSnapshot(); assert.equal(snapshot.uncertain, false); assert.equal(snapshot.pending.length, 0); assert.equal(snapshot.error, null); assert.equal(snapshot.dialog.stage, 'uncertain'); assert.equal(snapshot.dialog.batch.items[1].state, 'uncertain');
    assert.equal(snapshot.dialog.batch.items[1].errorCode, 'PROJECT_REGISTRATION_UNCERTAIN'); assert.ok([...f.time.jobs.values()].every(job => job.ms === 10000));
    assert.equal(await f.controller.confirmClone(plan), false); assert.equal(await f.controller.planClone(), false); assert.equal(f.controller.back(), false); assert.equal(await f.controller.reloadDialog(), false); assert.equal(await f.controller.loadProjects(), false);
    f.controller.closeDialog(); const before = f.calls.length; assert.equal(f.controller.openOnboardingStatus(requestId), true); assert.equal(f.calls.length, before); assert.equal(f.controller.getSnapshot().dialog.stage, 'uncertain');
    assert.equal(await f.controller.run(healthyBinding.id), true); assert.equal(f.calls.filter(row => row.action === 'syncrun').length, 1); assert.equal(f.controller.getSnapshot().dialog.stage, 'uncertain');
    assert.equal(f.controller.openPublish(), true); assert.deepEqual(f.controller.getSnapshot().dialog.selectedIds, []); assert.equal(f.calls.some(row => row.action === 'syncpublishcommit'), false);
    assert.equal(f.controller.selectOnboarding(workspaces[2].id, true), true); assert.equal(await f.controller.planPublish(), true); const freshPlan = f.controller.getSnapshot().dialog.plan;
    assert.equal(await f.controller.confirmClone(plan), false); assert.equal(await f.controller.confirmPublish(freshPlan), true);
    snapshot = f.controller.getSnapshot(); assert.equal(snapshot.status.onboarding.find(row => row.id === requestId).items[1].state, 'uncertain'); assert.equal(snapshot.pending.some(row => row.requestId === requestId), false);
    assert.equal(f.calls.filter(row => row.action === 'syncclonecommit').length, 1); assert.equal(f.calls.filter(row => row.action === 'syncclonepick').length, 1); assert.equal(f.calls.filter(row => row.action === 'syncpublishcommit').length, 1); stop();
  }
});

test('unmatched lost ACK, active onboarding ambiguity and engine uncertainty retain global safety guards', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncclonecommit' ? Promise.reject(new Error('lost ACK')) : base(call));
  const plan = await clone(f); await f.controller.confirmClone(plan); const requestId = f.calls.find(row => row.action === 'syncclonecommit').payload.requestId;
  const terminal = f.env.batch(requestId, plan, 'clone', { state: 'uncertain', items: plan.items.map((item, i) => ({ ...item, id: `item-${i}`, state: i ? 'uncertain' : 'succeeded', phase: i ? 'registering' : 'complete' })) });
  for (const wrong of [{ ...terminal, id: 'other-request' }, { ...terminal, kind: 'publish', parent: undefined }]) {
    f.env.current = status({ bindings: [healthyBinding], onboarding: [wrong] }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending[0].requestId, requestId); assert.equal(await f.controller.run(healthyBinding.id), false);
  }
  for (const activeState of ['running', 'uncertain']) {
    f.env.current = status({ bindings: [healthyBinding], onboarding: [{ ...terminal, state: activeState, items: terminal.items.map((item, i) => i ? item : { ...item, state: 'running', phase: 'downloading' }) }] });
    await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending.length, 1); assert.equal(await f.controller.run(healthyBinding.id), false); assert.equal(f.controller.openPublish(), false);
  }
  f.env.current = status({ bindings: [healthyBinding], onboarding: [terminal] }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().pending.length, 0); assert.equal(f.controller.getSnapshot().uncertain, false);
  for (const patch of [{ operations: [{ id: 'engine-unknown', kind: 'run', state: 'uncertain', bindingId: healthyBinding.id }] }, { bindings: [{ ...healthyBinding, state: 'uncertain' }] }]) {
    f.env.current = status({ bindings: [healthyBinding], onboarding: [terminal], ...patch }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(await f.controller.run(healthyBinding.id), false);
  }
  assert.equal(f.calls.filter(row => row.action === 'syncclonecommit').length, 1); assert.equal(f.calls.some(row => row.action === 'syncrun'), false);
});

test('late folder/plan reads after close, identity, revision or unmount cannot resurrect authority', async t => {
  for (const action of ['syncclonepick', 'synccloneselect', 'synccloneplan', 'syncpublishplan']) for (const change of ['close', 'identity', 'revision', 'unmount']) {
    const late = deferred(); let held = false;
    const f = fixture(t, (call, base) => held && call.action === action ? late.promise : base(call)); const stop = f.controller.watch(); await settle();
    if (action === 'syncpublishplan') { f.controller.openPublish(); f.controller.selectOnboarding(workspaces[0].id, true); }
    else { await f.controller.openClone(); f.controller.selectOnboarding('cloud-0', true); if (action !== 'syncclonepick') await f.controller.pickCloneParent(); if (action === 'synccloneplan') await f.controller.selectCloneParent(); }
    held = true; const pending = ({ syncclonepick: f.controller.pickCloneParent, synccloneselect: f.controller.selectCloneParent, synccloneplan: f.controller.planClone, syncpublishplan: f.controller.planPublish })[action](); const request = f.calls.at(-1);
    if (change === 'close') f.controller.closeDialog(); else if (change === 'identity') f.controller.setIdentity({ ...identity, username: 'other' }); else if (change === 'revision') { f.env.current = status({ revision: 8 }); await f.controller.refresh(); } else stop();
    assert.equal(await pending, false); assert.equal(request.signal.aborted, true); late.resolve(ok({ cancelled: true })); await settle(); assert.equal(f.controller.getSnapshot().dialog?.plan ?? null, null); assert.equal(f.controller.getSnapshot().dialog?.destination ?? null, null); stop();
  }
});

test('stale and expired confirmations, changed local roots, and blocked previews cannot write', async t => {
  for (const kind of ['clone', 'publish']) {
    for (const patch of [{ revision: 8 }, { username: 'other' }, { loggedIn: false }]) {
      const f = fixture(t), plan = await (kind === 'clone' ? clone(f) : publish(f)); f.env.current = status(patch); await f.controller.refresh(); assert.equal(await (kind === 'clone' ? f.controller.confirmClone(plan) : f.controller.confirmPublish(plan)), false); assert.equal(f.calls.some(row => /commit$/.test(row.action)), false);
    }
    const expired = fixture(t), plan = await (kind === 'clone' ? clone(expired) : publish(expired)); expired.time.advance(60001); assert.equal(await (kind === 'clone' ? expired.controller.confirmClone(plan) : expired.controller.confirmPublish(plan)), false);
  }
  const f = fixture(t), plan = await publish(f); f.env.current = status({ workspaces: workspaces.map((row, i) => i ? row : { ...row, root: 'E:\\changed' }) }); await f.controller.refresh(); assert.equal(await f.controller.confirmPublish(plan), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'SYNC_ROOT_CHANGED');
  const blocked = fixture(t, (call, base) => { const result = base(call); if (call.action === 'synccloneplan') { result.value.plan.items[0].summary.blocked = 1; result.value.plan.summary.blocked = 1; } return result; });
  const blockedPlan = await clone(blocked); assert.equal(await blocked.controller.confirmClone(blockedPlan), false); assert.equal(blocked.controller.getSnapshot().dialog.error.code, 'SYNC_BLOCKED');
});

test('cloud max20, stale destination expiry and Host picker failures stay explicit and read-only', async t => {
  const f = fixture(t); await f.controller.refresh(); await f.controller.openClone();
  for (let i = 0; i < 20; ++i) assert.equal(f.controller.selectOnboarding(projects[i].projectId, true), true);
  assert.equal(f.controller.selectOnboarding(projects[20].projectId, true), false); assert.equal(f.controller.getSnapshot().dialog.selectedIds.length, 20);
  await f.controller.pickCloneParent(); await f.controller.selectCloneParent(); f.time.advance(60001); assert.equal(await f.controller.planClone(), false);
  assert.equal(f.controller.getSnapshot().dialog.error.code, 'SYNC_DESTINATION_EXPIRED'); assert.equal(f.controller.getSnapshot().dialog.destination, null); assert.equal(f.calls.some(row => row.action === 'synccloneplan'), false);
  for (const code of ['DIRECTORY_PICKER_UNAVAILABLE', 'DIRECTORY_PICKER_FAILED', 'DIRECTORY_PICKER_EXPIRED', 'BAD_DESTINATION', 'DESTINATION_CHANGED']) {
    const failed = fixture(t, (call, base) => call.action === 'syncclonepick' ? failure(code) : base(call)); await failed.controller.refresh(); await failed.controller.openClone(); failed.controller.selectOnboarding('cloud-0', true); assert.equal(await failed.controller.pickCloneParent(), false);
    assert.equal(failed.controller.getSnapshot().dialog.error.code, code); assert.equal(failed.controller.getSnapshot().uncertain, false); assert.equal(JSON.stringify(failed.controller.getSnapshot()).includes('untrusted-secret'), false);
  }
});

test('malformed batch receipt, timeout and bounded missing history never replay; unmount does not cancel Host write', async t => {
  for (const kind of ['clone', 'publish']) {
    const action = kind === 'clone' ? 'syncclonecommit' : 'syncpublishcommit';
    const f = fixture(t, (call, base) => call.action === action ? ok({ accepted: true, operationId: 'other-request' }) : base(call));
    const stop = f.controller.watch(); await settle(); const plan = await (kind === 'clone' ? clone(f) : publish(f));
    assert.equal(await (kind === 'clone' ? f.controller.confirmClone(plan) : f.controller.confirmPublish(plan)), false);
    for (let i = 0; i < 9; ++i) { f.time.run(3000); await settle(); }
    assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pollStopped, true); assert.equal(f.time.jobs.size, 0);
    const requestId = f.calls.find(row => row.action === action).payload.requestId;
    f.env.current = status({ revision: 8, onboarding: [f.env.batch(requestId, plan, kind, { state: 'succeeded', items: plan.items.map((item, i) => ({ ...item, id: `result-${i}`, state: 'succeeded', phase: 'complete' })) })] });
    await f.controller.refresh(); assert.equal(f.controller.getSnapshot().dialog.stage, 'progress'); assert.equal(f.controller.getSnapshot().dialog.error, null); assert.equal(f.controller.getSnapshot().dialog.stale, false); assert.equal(f.controller.getSnapshot().pending.length, 0); assert.equal(f.calls.filter(row => row.action === action).length, 1); stop();
  }
  const late = deferred(), f = fixture(t, (call, base) => call.action === 'syncpublishcommit' ? late.promise : base(call)); const stop = f.controller.watch(); await settle(); const plan = await publish(f), writing = f.controller.confirmPublish(plan), request = f.calls.at(-1);
  stop(); assert.equal(request.signal.aborted, false); late.resolve(ok({ accepted: true, operationId: request.payload.requestId })); assert.equal(await writing, true); assert.equal(f.calls.at(-1).action, 'syncpublishcommit'); assert.equal(f.time.jobs.size, 0);
  const timeout = fixture(t, (call, base) => call.action === 'syncclonepick' ? new Promise(() => {}) : base(call)); await timeout.controller.refresh(); await timeout.controller.openClone(); timeout.controller.selectOnboarding('cloud-0', true);
  const waiting = timeout.controller.pickCloneParent(); timeout.time.run(60000); assert.equal(await waiting, false); assert.equal(timeout.controller.getSnapshot().dialog.error.code, 'TIMEOUT');
});

test('new DTOs reject unissued browser capabilities, parent substitution and revoked catalog delivery', async t => {
  for (const patch of [{ currentId: 'E:\\forged-path' }, { directories: [{ id: 'not/opaque', label: 'forged' }] }, { path: 'relative-parent' }, { crumbs: [{ id: 'same', label: 'a' }, { id: 'same', label: 'b' }] }]) {
    const f = fixture(t, (call, base) => { const result = base(call); if (call.action === 'syncclonepick') Object.assign(result.value.browser, patch); return result; }); await f.controller.refresh(); await f.controller.openClone(); f.controller.selectOnboarding('cloud-0', true); assert.equal(await f.controller.pickCloneParent(), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE');
  }
  const changed = fixture(t, (call, base) => { const result = base(call); if (call.action === 'synccloneselect') { result.value.destination.parent = 'E:\\substituted'; result.value.destination.items = result.value.destination.items.map(item => ({ ...item, root: `E:\\substituted\\${item.projectId}` })); } return result; });
  await chooseClone(changed); assert.equal(await changed.controller.selectCloneParent(), false); assert.equal(changed.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE');
  const late = deferred(), revoked = fixture(t, (call, base) => call.action === 'syncprojects' ? late.promise : base(call)); await revoked.controller.refresh(); const loading = revoked.controller.openClone(), request = revoked.calls.at(-1);
  revoked.env.current = status({ loggedIn: false }); await revoked.controller.refresh(); assert.equal(await loading, false); assert.equal(request.signal.aborted, true); late.resolve(ok({ projects })); await settle(); assert.equal(revoked.controller.getSnapshot().projects.items.length, 0); assert.equal(revoked.controller.getSnapshot().dialog, null);
});

function hooks() {
  const cells = []; let cursor = 0, effects = [];
  const React = { createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; }, useSyncExternalStore(_subscribe, snapshot) { return snapshot(); }, useId() { return 'mock-batch'; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; }, useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = value; }]; },
    useEffect(effect, deps) { const index = cursor++; if (!cells[index] || deps.some((value, at) => value !== cells[index].deps[at])) { const item = { deps, effect, cleanup: cells[index]?.cleanup }; cells[index] = item; effects.push(item); } } };
  return { React, render(Component, props) { cursor = 0; return Component(props); }, mount() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } }, unmount() { for (const cell of cells) cell?.cleanup?.(); } };
}
function nodes(root) { return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)]; }
function text(root) { return typeof root === 'string' || typeof root === 'number' ? String(root) : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(text).join(' '); }
function button(root, label) { const result = nodes(root).find(row => row.type === 'native:Button' && text(row) === label); assert.ok(result, `missing ${label}`); return result; }
function checkbox(root, label) { const result = nodes(root).find(row => row.type === 'native:Checkbox' && row.props.label === label); assert.ok(result, `missing ${label}`); return result; }
function modal(p) { return nodes(p.tree()).find(row => row.type === 'native:Modal'); }
function page(t, custom) {
  const f = fixture(t, custom), react = hooks(), primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const Component = createBidirectionalPanel(react.React, primitives), props = { connection: f.connection, identity };
  t.after(() => react.unmount()); return { ...f, ...react, props, tree: () => react.render(Component, props) };
}
async function mount(p) { p.tree(); p.mount(); await settle(); p.tree(); p.mount(); await settle(); }

test('mounted inventories are hidden until one entry opens its checkbox popup; local supports batch without cloud reads', async t => {
  const p = page(t); await mount(p); assert.equal(modal(p).props.open, false); assert.equal(nodes(p.tree()).some(row => row.type === 'native:Checkbox'), false);
  assert.equal(nodes(p.tree()).some(row => ['本机工作区列表', '云端项目列表'].includes(row.props?.['aria-label'])), false);
  button(p.tree(), '本地项目→同步到云端').props.onClick(); assert.equal(modal(p).props.open, true);
  assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Input').length, 1); assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Checkbox' && row.props.checked).length, 0);
  for (let i = 0; i < 20; ++i) checkbox(modal(p), workspaces[i].label).props.onChange(true);
  assert.equal(checkbox(modal(p), workspaces[20].label).props.disabled, true); checkbox(modal(p), workspaces[20].label).props.onChange(true);
  assert.match(text(modal(p)), /已选择 20 \/ 20/); assert.ok(p.calls.every(row => row.action === 'syncstatus'));
  button(modal(p), '预览变更').props.onClick(); await settle(); assert.equal(modal(p).props.title, '确认启用双向同步'); assert.match(text(modal(p)), /20 个项目/); assert.match(text(modal(p)), /部分失败不会回滚/);
  assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Input').length, 0); assert.equal(p.calls.find(row => row.action === 'syncpublishplan').payload.workspaceIds.length, 20);
  button(modal(p), '确认并启用').props.onClick(); await settle(); assert.equal(nodes(modal(p)).filter(row => row.props?.['data-onboarding-item']).length, 20); assert.equal(p.calls.filter(row => row.action === 'syncpublishcommit').length, 1);
  assert.equal(p.calls.some(row => ['syncprojects', 'pairplan', 'paircommit'].includes(row.action)), false);
});

test('mounted cloud multi-picker uses opaque native browse rows and one parent with fresh multi-child review', async t => {
  const p = page(t); await mount(p); button(p.tree(), '云端项目→同步到本地').props.onClick(); await settle();
  assert.equal(p.calls.filter(row => row.action === 'syncprojects').length, 1); assert.equal(nodes(modal(p)).some(row => row.props?.['aria-label'] === '本机工作区列表'), false);
  checkbox(modal(p), '云端 0').props.onChange(true); checkbox(modal(p), '云端 1').props.onChange(true);
  assert.equal(checkbox(modal(p), '云端 0').props.checked, true); assert.equal(checkbox(modal(p), '云端 1').props.checked, true); assert.match(text(modal(p)), /已选择 2 \/ 20/);
  button(modal(p), '选择宿主父目录').props.onClick(); await settle(); assert.equal(modal(p).props.title, '选择宿主父目录'); assert.match(text(modal(p)), /浏览和选择均不创建目录/);
  assert.ok(nodes(modal(p)).filter(row => row.type === 'native:Input').every(row => row.props.type === 'search'));
  button(modal(p), '目标父目录').props.onClick(); await settle(); button(modal(p), '使用此父目录').props.onClick(); await settle();
  assert.equal(modal(p).props.title, '确认新建位置'); assert.match(text(modal(p)), /new-cloud-0/); assert.match(text(modal(p)), /new-cloud-1/); assert.equal(p.calls.some(row => /commit$/.test(row.action)), false);
  button(modal(p), '预览变更').props.onClick(); await settle(); assert.equal(modal(p).props.title, '确认启用双向同步'); assert.match(text(modal(p)), /不关联已有工作区/);
  assert.match(text(modal(p)), /下载 4/); assert.equal(p.calls.some(row => row.action.startsWith('pair')), false);
});

test('remounted terminal unknown history stays readonly without blocking explicit healthy operations', async t => {
  const history = { id: 'original-clone-request', kind: 'clone', state: 'uncertain', at: new Date().toISOString(), parent: 'E:\\synthetic-parent', items: [
    { id: 'completed-item', projectId: 'cloud-0', label: '已完成的项目', root: 'E:\\synthetic-parent\\complete', state: 'succeeded', phase: 'complete' },
    { id: 'unknown-item', projectId: 'cloud-1', label: '注册未确认的项目', root: 'E:\\synthetic-parent\\unknown', state: 'uncertain', phase: 'registering', errorCode: 'PROJECT_REGISTRATION_UNCERTAIN' },
  ] };
  const first = page(t); first.env.current = status({ bindings: [healthyBinding], onboarding: [history] }); await mount(first);
  button(first.tree(), '查看批次结果').props.onClick(); assert.match(text(modal(first)), /不要向同一位置重复提交/); first.unmount(); await settle();
  const reopened = page(t); reopened.env.current = first.env.current; await mount(reopened);
  assert.ok(reopened.calls.every(row => row.action === 'syncstatus')); assert.equal(button(reopened.tree(), '立即同步').props.disabled, false); assert.equal(button(reopened.tree(), '本地项目→同步到云端').props.disabled, false); assert.equal(button(reopened.tree(), '云端项目→同步到本地').props.disabled, false);
  const before = reopened.calls.length; button(reopened.tree(), '查看批次结果').props.onClick(); await settle(); assert.equal(reopened.calls.length, before);
  assert.equal(nodes(modal(reopened)).filter(row => row.props?.['data-onboarding-item']).length, 2); assert.match(text(modal(reopened)), /工作区注册结果未确认/); assert.match(text(modal(reopened)), /不要向同一位置重复提交/);
  assert.equal(nodes(modal(reopened)).some(row => row.type === 'native:Button' && /重试|预览变更|返回修改|确认并启用/.test(text(row))), false);
  button(modal(reopened), '核对状态').props.onClick(); await settle(); assert.match(text(modal(reopened)), /工作区注册结果未确认/); assert.ok(reopened.calls.every(row => row.action === 'syncstatus'));
  modal(reopened).props.onClose(); button(reopened.tree(), '立即同步').props.onClick(); await settle(); assert.equal(reopened.calls.filter(row => row.action === 'syncrun').length, 1);
  button(reopened.tree(), '查看批次结果').props.onClick(); assert.match(text(modal(reopened)), /注册未确认的项目/); modal(reopened).props.onClose();
  button(reopened.tree(), '本地项目→同步到云端').props.onClick(); assert.equal(nodes(modal(reopened)).filter(row => row.type === 'native:Checkbox' && row.props.checked).length, 0);
  checkbox(modal(reopened), workspaces[2].label).props.onChange(true); button(modal(reopened), '预览变更').props.onClick(); await settle(); assert.equal(modal(reopened).props.title, '确认启用双向同步'); assert.equal(button(modal(reopened), '确认并启用').props.disabled, false);
  assert.equal(reopened.calls.some(row => ['syncclonepick', 'syncclonecommit', 'syncpublishcommit', 'syncprojects'].includes(row.action)), false);
});

test('mounted partial outcomes display each project safely and reopen status without catalog or replay', async t => {
  const p = page(t, (call, base, env) => {
    if (call.action !== 'syncpublishcommit') return base(call);
    const plan = env.plans.get(call.payload.planId); env.current = status({ onboarding: [env.batch(call.payload.requestId, plan, 'publish', { state: 'partial', items: plan.items.map((item, i) => ({ ...item, id: `item-${i}`, state: i ? 'failed' : 'succeeded', phase: i ? 'untrusted-secret' : 'complete', ...(i ? { errorCode: 'untrusted-secret', error: 'untrusted-secret' } : {}) })) })] });
    return ok({ accepted: true, operationId: call.payload.requestId });
  });
  await mount(p); button(p.tree(), '本地项目→同步到云端').props.onClick(); checkbox(modal(p), '本地 0').props.onChange(true); checkbox(modal(p), '本地 1').props.onChange(true); button(modal(p), '预览变更').props.onClick(); await settle(); button(modal(p), '确认并启用').props.onClick(); await settle();
  assert.match(text(modal(p)), /部分项目已完成/); assert.match(text(modal(p)), /已完成/); assert.match(text(modal(p)), /未完成/); assert.doesNotMatch(text(modal(p)), /untrusted-secret/); assert.equal(nodes(modal(p)).filter(row => row.props?.['data-onboarding-item']).length, 2);
  modal(p).props.onClose(); const before = p.calls.length; button(p.tree(), '查看批次结果').props.onClick(); await settle(); assert.equal(p.calls.length, before); assert.match(text(modal(p)), /部分项目已完成/);
  assert.equal(nodes(modal(p)).some(row => row.type === 'native:Button' && /重试|确认并启用|预览变更/.test(text(row))), false); assert.equal(p.calls.filter(row => row.action === 'syncpublishcommit').length, 1);
});
