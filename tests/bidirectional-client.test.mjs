import test from 'node:test';
import assert from 'node:assert/strict';
import { createBidirectionalController, parseSyncStatus, parseSyncProjects, parseSyncArchives, canRepairBinding, STORAGE_GIB, MAX_STORAGE_GIB, validateStorageLimit } from '../client/bidirectional-state.mjs';
import { createBidirectionalPanel } from '../client/bidirectional-panel.mjs';
import { projectFolderMetadata } from '../src/client.mjs';

// Synthetic RPC and native React/control event contracts only, not real GUI/focus integration.
const identity = { server: 'https://synthetic.example.test', username: 'synthetic', loggedIn: true };
const workspaces = [{ id: 'workspace:one', label: '本机项目', root: 'E:\\synthetic\\one', available: true }, { id: 'workspace:two', label: '待配对项目', root: 'E:\\synthetic\\two', available: true }];
const binding = { id: 'binding-one', workspaceId: workspaces[0].id, projectId: 'cloud-one', label: '已配对项目', root: workspaces[0].root, enabled: true, state: 'idle', pendingUpload: 2, pendingDownload: 3, conflicts: 1, recycleCount: 1 };
const status = extra => ({ revision: 7, ...identity, capability: 'supported', running: false, workspaces, bindings: [binding], operations: [], ...extra });
const catalog = [{ projectId: 'cloud-one', label: '云端项目', legacy: false }, { projectId: 'cloud-legacy', label: '旧版项目', legacy: true }];
const conflicts = [{ id: 'conflict-one', path: 'source/file.txt', variants: [{ id: 'variant-one', label: '本机版本', deleted: false, size: 12 }, { id: 'variant-two', label: '云端删除', deleted: true, size: 0 }] }];
const recycled = [{ id: 'recycle-one', path: 'source/old.txt', size: 8, reason: 'replaced' }];
const archiveRows = [
  { id: 'archive-new', label: '待核对的会话归档', state: 'available', sessions: 3, assets: 2 },
  { id: 'archive-imported', label: '已导入的会话归档', state: 'imported', sessions: 1, assets: 0, sessionIds: ['session-already'] },
  { id: 'archive-uncertain', label: '未确认的会话归档', state: 'uncertain', sessions: 1, assets: 1, sessionIds: ['session-possible'] },
];
const archiveBinding = { ...binding, archives: 3, skippedArchives: 2, warningCode: 'SYNC_ARCHIVES_SKIPPED' };
const repairBinding = { ...binding, enabled: true, state: 'blocked', errorCode: 'SYNC_APPLY_INCOMPLETE' };
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted-secret', token: 'untrusted-secret' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function settle() { for (let index = 0; index < 80; ++index) await Promise.resolve(); }
function clock() {
  let next = 0, current = Date.now(); const jobs = new Map();
  return { jobs, now: () => current, advance(ms) { current += ms; }, setTimeout(fn, ms) { jobs.set(++next, { fn, ms }); return next; }, clearTimeout(key) { jobs.delete(key); }, run(ms) { const entry = [...jobs].find(([, job]) => job.ms === ms); assert.ok(entry, `missing timer ${ms}`); jobs.delete(entry[0]); entry[1].fn(); } };
}
function fixture(t, custom, options = {}) {
  const calls = [], time = clock(); let current = status(), sequence = 0, planSequence = 0;
  const makePlan = (root, fields) => ({ plan: { id: `plan-${++planSequence}`, expiresAt: new Date(time.now() + 60000).toISOString(), root, ...fields } });
  const env = { get current() { return current; }, set current(value) { current = value; }, time, makePlan };
  function base(call) {
    const body = call.payload;
    if (call.action === 'syncstatus') return ok(current);
    if (call.action === 'syncprojects') return ok({ projects: catalog });
    if (call.action === 'pairplan') return ok(makePlan(workspaces.find(row => row.id === body.workspaceId).root, { projectId: body.projectId ?? 'cloud-new', label: '预览项目', summary: { upload: 2, download: 3, delete: 1, conflicts: 1, blocked: 0 } }));
    if (call.action === 'syncconflicts') return ok({ conflicts });
    if (call.action === 'syncrecycle') return ok({ items: recycled });
    if (call.action === 'syncarchives') return ok({ archives: archiveRows, counts: { total: 3, imported: 1, uncertain: 1 } });
    if (call.action === 'syncarchiveplan') return ok(makePlan(binding.root, { label: '待核对的会话归档', eligibility: 'unchecked', counts: { sessions: 3, events: 12, assets: 2, files: 4 } }));
    if (call.action === 'syncrepairplan') return ok(makePlan(binding.root, { paths: ['source/missing.txt', 'source/edited.txt'], summary: { restore: 1, conflicts: 1, unchanged: 2 } }));
    if (call.action === 'syncresolveplan') return ok(makePlan(binding.root, { paths: ['source/file.txt', 'source/file.local-copy.txt'], summary: '保留双方版本并解除该冲突' }));
    if (call.action === 'syncrestoreplan') return ok(makePlan(binding.root, { target: binding.root + '\\source\\old.restored.txt' }));
    if (call.action === 'syncpause') { current = { ...current, revision: current.revision + 1, bindings: current.bindings.map(row => row.id === body.bindingId ? { ...row, enabled: body.enabled, state: body.enabled ? 'idle' : 'paused' } : row) }; return ok(current); }
    if (call.action === 'syncsettings') { current = { ...current, revision: current.revision + 1, storage: { ...current.storage, limitBytes: body.quotaBytes, verified: false } }; return ok(current); }
    if (['paircommit', 'syncrun', 'syncresolve', 'syncrestore', 'syncarchiveimport', 'syncrepair'].includes(call.action)) {
      current = { ...current, running: true, operations: [...current.operations, { id: body.requestId, kind: call.action, state: 'running', ...(body.bindingId ? { bindingId: body.bindingId } : {}) }] };
      return ok({ accepted: true, operationId: body.requestId });
    }
    throw new Error(`unexpected ${call.action}`);
  }
  const connection = { rpc: { async call(channel, endpoint, payload, signal) { const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call); return custom ? custom(call, base, env) : base(call); } } };
  const controller = createBidirectionalController(connection, { ...time, crypto: { randomUUID: () => `a0000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` }, ...options });
  t.after(() => controller.dispose()); return { controller, connection, calls, clock: time, env };
}
async function pair(controller, existing = null) { await controller.refresh(); await controller.openPair(); assert.equal(controller.selectWorkspace(workspaces[1].id), true); assert.equal(controller.selectProject(existing), true); assert.equal(await controller.planPair(), true); return controller.getSnapshot().dialog.plan; }

test('sync DTOs deep allowlist/freeze and never retain secrets or arbitrary error bodies', () => {
  const parsed = parseSyncStatus({ ...status(), token: 'untrusted-secret', bindings: [{ ...binding, secret: 'untrusted-secret', errorCode: 'arbitrary-secret' }], operations: [{ id: 'op-one', kind: 'untrusted-secret', state: 'failed', errorCode: 'untrusted-secret', password: 'untrusted-secret' }] });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.workspaces) && Object.isFrozen(parsed.bindings[0]) && Object.isFrozen(parsed.operations[0]));
  assert.equal(parsed.bindings[0].errorCode, 'SYNC_FAILED'); assert.equal(parsed.operations[0].kind, 'unknown');
  assert.equal(JSON.stringify(parsed).includes('untrusted-secret'), false);
  const projects = parseSyncProjects({ projects: [{ ...catalog[0], password: 'untrusted-secret' }] }); assert.equal(JSON.stringify(projects).includes('untrusted-secret'), false);
  for (const patch of [{ revision: -1 }, { server: 'https://name:password@example.test' }, { capability: 'new-unknown-state' }, { bindings: [{ ...binding, pendingUpload: -1 }] }, { operations: [{ id: 'x', state: 'done' }] }, { workspaces: [workspaces[0], workspaces[0]] }]) assert.throws(() => parseSyncStatus(status(patch)), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(parseSyncStatus({ revision: 0, loggedIn: false }).bindings, []);
});

test('historical source hints retain v1 path compatibility without relaxing local roots or pairing authority', async t => {
  const hints = ['/old/work/../repo', '/old/./repo', '/old/work\\..\\repo', 'C:\\old\\work\\..\\repo', '\\\\server\\share\\old\\..\\repo'];
  const projects = hints.map((sourceRoot, index) => ({ projectId: `history-${index}`, ...projectFolderMetadata(sourceRoot), legacy: true }));
  assert.deepEqual(parseSyncProjects({ projects }).projects.map(row => row.sourceRoot), hints);
  assert.throws(() => parseSyncStatus(status({ workspaces: [{ ...workspaces[0], root: hints[0] }] })), { code: 'INVALID_RESPONSE' });
  const f = fixture(t, (call, base) => call.action === 'syncprojects' ? ok({ projects }) : base(call));
  const plan = await pair(f.controller, projects[0].projectId);
  assert.equal(plan.root, workspaces[1].root);
  assert.deepEqual(f.calls.find(call => call.action === 'pairplan').payload, { revision: 7, server: identity.server, username: identity.username, workspaceId: workspaces[1].id, projectId: projects[0].projectId });
  assert.equal(f.calls.some(call => call.action === 'paircommit'), false);
});

test('first-run unknown capability requires explicit catalog probe then fresh supported syncstatus before planning', async t => {
  const f = fixture(t, (call, base, env) => { if (call.action === 'syncprojects') env.current = { ...env.current, capability: 'supported' }; return base(call); });
  f.env.current = status({ capability: 'unknown', bindings: [] });
  const stop = f.controller.watch(); await settle(); await f.controller.refresh();
  assert.ok(f.calls.every(call => call.action === 'syncstatus')); assert.equal(f.controller.getSnapshot().status.capability, 'unknown');
  assert.equal(await f.controller.run(binding.id), false); const before = f.calls.length;
  assert.equal(await f.controller.openPair(), true);
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['syncprojects', 'syncstatus']);
  assert.equal(f.controller.getSnapshot().status.capability, 'supported'); assert.equal(f.controller.getSnapshot().status.revision, 7);
  assert.equal(f.controller.getSnapshot().dialog.workspaceId, ''); assert.equal(f.controller.getSnapshot().dialog.projectChoice, '');
  f.controller.selectWorkspace(workspaces[1].id); f.controller.selectProject(null); assert.equal(await f.controller.planPair(), true);
  assert.equal(f.calls.some(call => ['paircommit', 'syncrun'].includes(call.action)), false); stop();
});

test('upgrade-required discovery stays actionable and explicitly reprobes an upgraded server', async t => {
  let upgraded = false;
  const f = fixture(t, (call, base, env) => {
    if (call.action === 'syncprojects') { if (!upgraded) return failure('SYNC_CLIENT_UPGRADE_REQUIRED'); env.current = { ...env.current, capability: 'supported' }; }
    return base(call);
  });
  f.env.current = status({ capability: 'upgrade-required' }); await f.controller.refresh();
  assert.equal(await f.controller.openPair(), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'SYNC_CLIENT_UPGRADE_REQUIRED');
  assert.equal(f.controller.getSnapshot().dialog.stage, 'choose'); assert.equal(await f.controller.planPair(), false);
  upgraded = true; assert.equal(await f.controller.reloadDialog(), true); assert.equal(f.controller.getSnapshot().status.capability, 'supported');
  f.controller.selectWorkspace(workspaces[1].id); f.controller.selectProject(null); assert.equal(await f.controller.planPair(), true);
  assert.equal(f.calls.filter(call => call.action === 'syncprojects').length, 2);
});

test('post-discovery revision changes retain descriptive choices but revoke old catalog and plan authority', async t => {
  let changeRevision = false;
  const f = fixture(t, (call, base, env) => { if (call.action === 'syncprojects' && changeRevision) { env.current = { ...env.current, revision: 8 }; changeRevision = false; } return base(call); });
  const oldPlan = await pair(f.controller); changeRevision = true;
  assert.equal(await f.controller.loadProjects(), false); const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.status.revision, 8); assert.equal(snapshot.projects.loaded, false); assert.equal(snapshot.dialog.workspaceId, workspaces[1].id); assert.equal(snapshot.dialog.projectChoice, 'new'); assert.equal(snapshot.dialog.plan, null);
  assert.equal(await f.controller.confirmPair(oldPlan), false); assert.equal(await f.controller.planPair(), false);
  assert.equal(await f.controller.loadProjects(), true); assert.equal(await f.controller.planPair(), true); assert.equal(f.controller.getSnapshot().dialog.plan.identity.revision, 8);
});

test('actual Host sync codes display safely; known pre-admission rejection stays actionable', async t => {
  const codes = ['SYNC_PLAN_CHANGED', 'SYNC_MANAGED_PROJECT', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_MIGRATION_REQUIRED', 'SYNC_ROOT_CHANGED', 'SYNC_POLICY_CHANGED', 'SYNC_LOCAL_CHANGED', 'SYNC_QUOTA', 'SYNC_INTEGRITY', 'SYNC_PROJECT_CORRUPT', 'SYNC_METADATA_UNSAFE', 'SYNC_VOLUME_CHANGED', 'SYNC_NOT_IDLE', 'SYNC_BINDING_MISMATCH', 'SYNC_JOURNAL_CORRUPT', 'SYNC_STRUCTURAL_CONFLICT', 'SYNC_UNTRACKED_DELETE', 'SYNC_REMOTE_BLOB_MISSING', 'SYNC_APPLY_INCOMPLETE', 'SYNC_CONFLICT_CHANGED', 'SYNC_CANCELLED', 'SYNC_REPLAN_REQUIRED', 'SYNC_DESTINATION_UNAVAILABLE', 'SERVER_UNAVAILABLE', 'AUTH_RENEWAL_UNCERTAIN'];
  for (const code of codes) {
    const parsed = parseSyncStatus(status({ operations: [{ id: 'safe-op', kind: 'pair', state: 'failed', errorCode: code, error: 'untrusted-secret' }] }));
    assert.equal(parsed.operations[0].errorCode, code); assert.equal(JSON.stringify(parsed).includes('untrusted-secret'), false);
  }
  for (const code of ['SYNC_PLAN_CHANGED', 'SYNC_MANAGED_PROJECT', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_ROOT_CHANGED', 'SYNC_POLICY_CHANGED', 'SYNC_NOT_IDLE', 'SYNC_STRUCTURAL_CONFLICT', 'SYNC_CONFLICT_CHANGED', 'SYNC_QUOTA']) {
    const f = fixture(t, (call, base) => call.action === 'paircommit' ? failure(code) : base(call)), plan = await pair(f.controller);
    assert.equal(await f.controller.confirmPair(plan), false); assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().dialog.stage, 'choose'); assert.equal(f.controller.getSnapshot().dialog.error.code, code);
  }
  for (const code of ['AUTH_RENEWAL_UNCERTAIN', 'SYNC_APPLY_INCOMPLETE', 'SYNC_JOURNAL_CORRUPT', 'SYNC_CANCELLED']) {
    const f = fixture(t, (call, base) => call.action === 'paircommit' ? failure(code) : base(call)), plan = await pair(f.controller);
    await f.controller.confirmPair(plan); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.calls.filter(call => call.action === 'paircommit').length, 1);
  }
});

test('pair wizard is inert, explicit choices only, and uses sync revision with opaque Host ids', async t => {
  const f = fixture(t); await f.controller.refresh(); assert.equal(await f.controller.openPair(), true);
  const dialog = f.controller.getSnapshot().dialog; assert.equal(dialog.workspaceId, ''); assert.equal(dialog.projectChoice, ''); assert.equal(dialog.plan, null);
  assert.equal(await f.controller.planPair(), false); assert.equal(f.controller.selectWorkspace('E:\\arbitrary'), false); assert.equal(f.controller.selectProject('arbitrary'), false);
  f.controller.selectWorkspace(workspaces[1].id); f.controller.selectProject(null); assert.equal(await f.controller.planPair(), true);
  const payload = f.calls.find(call => call.action === 'pairplan').payload;
  assert.deepEqual(payload, { revision: 7, server: identity.server, username: identity.username, workspaceId: workspaces[1].id, projectId: null });
  assert.ok(f.calls.every(call => call.channel === '/api' && call.endpoint === `dsh-personal-sync/${call.action}`));
  assert.equal(f.calls.some(call => ['paircommit', 'syncrun', 'syncpause'].includes(call.action)), false);
  assert.equal(f.controller.getSnapshot().dialog.plan.root, workspaces[1].root);
  f.controller.closeDialog(); assert.equal(f.calls.some(call => call.action === 'paircommit'), false);
});

test('pair confirmation consumes exact plan once, sends only opaque plan and request ids', async t => {
  const f = fixture(t), plan = await pair(f.controller);
  assert.equal(await f.controller.confirmPair({ ...plan }), false);
  const accepted = f.controller.confirmPair(plan); assert.equal(await f.controller.confirmPair(plan), false); assert.equal(await accepted, true);
  const writes = f.calls.filter(call => call.action === 'paircommit'); assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].payload).sort(), ['confirm', 'planId', 'requestId', 'revision', 'server', 'username'].sort());
  assert.equal(writes[0].payload.confirm, true); assert.equal(writes[0].payload.planId, plan.id);
  assert.equal(f.controller.getSnapshot().dialog.stage, 'progress'); assert.equal(f.controller.getSnapshot().dialog.plan, null);
  assert.equal(await f.controller.confirmPair(plan), false); assert.ok(Object.isFrozen(plan.summary));
});

test('legacy multihead choice is explicit, no automatic primary selection', async t => {
  const f = fixture(t, (call, base) => call.action === 'pairplan' && !call.payload.primaryLegacyId ? ok({ requiresLegacyChoice: true, choices: [{ id: 'legacy-a', label: '主机 A' }, { id: 'legacy-b', label: '主机 B' }] }) : base(call));
  await f.controller.refresh(); await f.controller.openPair(); f.controller.selectWorkspace(workspaces[1].id); f.controller.selectProject('cloud-legacy'); await f.controller.planPair();
  assert.equal(f.controller.getSnapshot().dialog.stage, 'legacy'); assert.equal(f.controller.getSnapshot().dialog.primaryLegacyId, null);
  assert.equal(f.controller.selectLegacy('not-issued'), false); f.controller.selectLegacy('legacy-b'); await f.controller.planPair();
  assert.equal(f.calls.filter(call => call.action === 'pairplan').at(-1).payload.primaryLegacyId, 'legacy-b');
  assert.equal(f.controller.getSnapshot().dialog.stage, 'review'); assert.equal(f.calls.some(call => call.action === 'paircommit'), false);
});

test('revision/account/auth changes revoke plans, catalog authority and stale captured handlers', async t => {
  for (const change of [{ revision: 8 }, { username: 'other' }, { loggedIn: false }]) {
    const f = fixture(t), plan = await pair(f.controller); f.env.current = status(change); await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().dialog?.plan ?? null, null);
    assert.equal(await f.controller.confirmPair(plan), false); assert.equal(f.calls.some(call => call.action === 'paircommit'), false);
  }
  const f = fixture(t), plan = await pair(f.controller);
  f.controller.setIdentity({ ...identity, username: 'changed', revision: 999 });
  assert.equal(await f.controller.confirmPair(plan), false); assert.equal(f.controller.getSnapshot().ready, false);
  assert.equal(f.calls.some(call => call.action === 'paircommit'), false);
});

test('expired, blocked and mismatched plan roots cannot authorize mutations', async t => {
  const f = fixture(t), plan = await pair(f.controller); f.clock.advance(60001);
  assert.equal(await f.controller.confirmPair(plan), false); assert.equal(f.controller.getSnapshot().dialog.error.code, 'SYNC_PLAN_EXPIRED');
  const blocked = fixture(t, (call, base) => { const result = base(call); if (call.action === 'pairplan') result.value.plan.summary.blocked = 1; return result; });
  const blockedPlan = await pair(blocked.controller); assert.equal(await blocked.controller.confirmPair(blockedPlan), false); assert.equal(blocked.controller.getSnapshot().dialog.error.code, 'SYNC_BLOCKED');
  const wrong = fixture(t, (call, base) => { const result = base(call); if (call.action === 'pairplan') result.value.plan.root = 'E:\\other'; return result; });
  await wrong.controller.refresh(); await wrong.controller.openPair(); wrong.controller.selectWorkspace(workspaces[1].id); wrong.controller.selectProject(null);
  assert.equal(await wrong.controller.planPair(), false); assert.equal(wrong.controller.getSnapshot().dialog.plan, null);
  assert.equal(wrong.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE');
});

test('definite write rejection returns to actionable selection, unknown write only reconciles status', async t => {
  for (const code of ['BUSY', 'SYNC_PLAN_STALE', 'UPDATE_RESTART_REQUIRED']) {
    const f = fixture(t, (call, base) => call.action === 'paircommit' ? failure(code) : base(call)); const plan = await pair(f.controller);
    assert.equal(await f.controller.confirmPair(plan), false); const snap = f.controller.getSnapshot();
    assert.equal(snap.dialog.stage, 'choose'); assert.equal(snap.dialog.workspaceId, workspaces[1].id); assert.equal(snap.dialog.plan, null); assert.equal(snap.uncertain, false); assert.equal(snap.dialog.error.code, code);
    assert.equal(JSON.stringify(snap).includes('untrusted-secret'), false);
    assert.equal(await f.controller.confirmPair(plan), false); assert.equal(await f.controller.planPair(), true);
  }
  const f = fixture(t, (call, base) => call.action === 'paircommit' ? Promise.reject(new Error('untrusted-secret')) : base(call));
  const stop = f.controller.watch(); await settle(); const plan = await pair(f.controller); await f.controller.confirmPair(plan);
  assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().dialog.stage, 'uncertain');
  for (let index = 0; index < 9; ++index) { f.clock.run(3000); await settle(); }
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.controller.getSnapshot().pollStopped, true);
  assert.equal(await f.controller.confirmPair(plan), false); assert.equal(await f.controller.planPair(), false);
  const write = f.calls.find(call => call.action === 'paircommit');
  f.env.current = status({ operations: [{ id: write.payload.requestId, kind: 'pair', state: 'succeeded' }] }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().pending.length, 0);
  assert.equal(f.calls.filter(call => call.action === 'paircommit').length, 1); assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret'), false); stop();
});

test('stale-revision rejection reloads syncstatus before catalog and preserves descriptive selection', async t => {
  const f = fixture(t, (call, base, env) => { if (call.action !== 'paircommit') return base(call); env.current = status({ revision: 8 }); return failure('CONFIG_CONFLICT'); });
  const plan = await pair(f.controller); await f.controller.confirmPair(plan);
  assert.equal(f.controller.getSnapshot().status.revision, 7);
  const before = f.calls.length; assert.equal(await f.controller.reloadDialog(), true);
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['syncstatus', 'syncprojects', 'syncstatus']);
  assert.equal(f.calls.slice(before).find(call => call.action === 'syncprojects').payload.revision, 8); assert.equal(f.controller.getSnapshot().dialog.workspaceId, workspaces[1].id);
  assert.equal(await f.controller.planPair(), true); assert.equal(f.controller.getSnapshot().dialog.plan.identity.revision, 8);
});

test('malformed accepted reply and lost ack remain uncertain until matching request operation', async t => {
  const f = fixture(t, (call, base, env) => {
    if (call.action !== 'paircommit') return base(call);
    env.current = status({ operations: [{ id: 'some-other-request', kind: 'pair', state: 'succeeded' }] });
    return ok({ accepted: true, operationId: 'some-other-request', token: 'untrusted-secret' });
  });
  const plan = await pair(f.controller); assert.equal(await f.controller.confirmPair(plan), false);
  assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending.length, 1);
  const requestId = f.calls.find(call => call.action === 'paircommit').payload.requestId;
  f.env.current = status({ operations: [{ id: requestId, kind: 'pair', state: 'running' }] }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().pending.length, 1);
});

test('immediate pause needs no Save, uses latest sync revision, and survives prior uncertain run', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncrun' ? Promise.reject(new Error('lost ack')) : base(call));
  await f.controller.refresh(); assert.equal(await f.controller.run(binding.id), false); assert.equal(f.controller.getSnapshot().uncertain, true);
  assert.equal(await f.controller.setEnabled(binding.id, false), true);
  assert.deepEqual(f.calls.find(call => call.action === 'syncpause').payload, { revision: 7, server: identity.server, username: identity.username, bindingId: binding.id, enabled: false });
  assert.equal(f.controller.getSnapshot().status.bindings[0].enabled, false); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending.length, 1);
  assert.equal(f.calls.some(call => call.action === 'preferences'), false);
});

test('unknown pause checks desired state at a strictly newer revision and never replays', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncpause' ? Promise.reject(new Error('lost ack')) : base(call));
  await f.controller.refresh(); await f.controller.setEnabled(binding.id, false);
  assert.equal(f.controller.getSnapshot().uncertain, true);
  f.env.current = status({ bindings: [{ ...binding, enabled: false }] }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, true);
  f.env.current = status({ revision: 8, bindings: [{ ...binding, enabled: false }] }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.calls.filter(call => call.action === 'syncpause').length, 1);
});

test('conflict and recycle flows use issued items, default both, read-only plans and exact confirmations', async t => {
  const f = fixture(t); await f.controller.refresh(); await f.controller.openConflicts(binding.id);
  assert.equal(f.controller.selectConflict('arbitrary'), false); f.controller.selectConflict('conflict-one'); assert.equal(f.controller.getSnapshot().dialog.choice, 'both');
  assert.equal(await f.controller.planResolution(), true); let plan = f.controller.getSnapshot().dialog.plan;
  assert.deepEqual(f.calls.find(call => call.action === 'syncresolveplan').payload, { revision: 7, server: identity.server, username: identity.username, bindingId: binding.id, conflictId: 'conflict-one', choice: 'both' });
  assert.equal(f.calls.some(call => call.action === 'syncresolve'), false); f.controller.setConflictChoice('remote'); assert.equal(await f.controller.confirmResolution(plan), false);
  await f.controller.planResolution(); plan = f.controller.getSnapshot().dialog.plan; assert.equal(plan.choice, 'remote'); assert.equal(await f.controller.confirmResolution(plan), true);
  f.controller.closeDialog(); await f.controller.openRecycle(binding.id); assert.equal(f.controller.selectRecycle('E:\\arbitrary'), false); f.controller.selectRecycle('recycle-one'); await f.controller.planRestore();
  plan = f.controller.getSnapshot().dialog.plan; assert.ok(plan.target.endsWith('old.restored.txt')); assert.equal(f.calls.some(call => call.action === 'syncrestore'), false);
  assert.equal(await f.controller.confirmRestore(plan), true); assert.deepEqual(Object.keys(f.calls.find(call => call.action === 'syncrestore').payload).sort(), ['revision', 'server', 'username', 'planId', 'requestId', 'confirm'].sort());
});

test('Host-issued long recycle handles remain opaque and membership guarded', async t => {
  const itemId = 'x'.repeat(100) + '_99999';
  const f = fixture(t, (call, base) => call.action === 'syncrecycle' ? ok({ items: [{ ...recycled[0], id: itemId }] }) : base(call));
  await f.controller.refresh(); assert.equal(await f.controller.openRecycle(binding.id), true);
  assert.equal(f.controller.selectRecycle('not-issued'), false); assert.equal(f.controller.selectRecycle(itemId), true);
  assert.equal(await f.controller.planRestore(), true); assert.equal(f.calls.find(call => call.action === 'syncrestoreplan').payload.itemId, itemId);
});

test('read-only plans reject uncontained restore target and stale item responses', async t => {
  const wrong = fixture(t, (call, base) => { const result = base(call); if (call.action === 'syncrestoreplan') result.value.plan.target = 'E:\\outside\\file'; return result; });
  await wrong.controller.refresh(); await wrong.controller.openRecycle(binding.id); wrong.controller.selectRecycle('recycle-one'); assert.equal(await wrong.controller.planRestore(), false);
  assert.equal(wrong.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE');
  for (const mode of ['close', 'revision', 'dispose']) {
    const late = deferred(), f = fixture(t, (call, base) => call.action === 'syncconflicts' ? late.promise : base(call)); await f.controller.refresh(); const pending = f.controller.openConflicts(binding.id), call = f.calls.at(-1);
    if (mode === 'close') f.controller.closeDialog(); else if (mode === 'dispose') f.controller.dispose(); else { f.env.current = status({ revision: 8 }); await f.controller.refresh(); }
    assert.equal(await pending, false); assert.equal(call.signal.aborted, true);
    late.resolve(ok({ conflicts })); await settle(); assert.equal(f.controller.getSnapshot().dialog?.items.length ?? 0, 0);
  }
});

test('mounted polling is 3s active / 10s enabled idle, bounded failures; closing only stops reads', async t => {
  const f = fixture(t); await f.controller.refresh(); assert.equal(f.clock.jobs.size, 0);
  const stop = f.controller.watch(); await settle(); assert.ok([...f.clock.jobs.values()].some(job => job.ms === 10000));
  await f.controller.run(binding.id); assert.ok([...f.clock.jobs.values()].some(job => job.ms === 3000));
  stop(); assert.equal(f.clock.jobs.size, 0); assert.equal(f.calls.some(call => /cancel/.test(call.action)), false);
  const stopAgain = f.controller.watch(); await settle(); assert.equal(f.controller.getSnapshot().status.running, true); stopAgain();
  let failReads = false; const bad = fixture(t, (call, base) => call.action === 'syncstatus' && failReads ? failure('SERVER_UNREACHABLE') : base(call)); const close = bad.controller.watch(); await settle(); failReads = true;
  for (let index = 0; index < 3; ++index) { bad.clock.run(10000); await settle(); }
  assert.equal(bad.clock.jobs.size, 0); assert.equal(bad.controller.getSnapshot().pollStopped, true); close();
});

test('timeout and unmount ignore late read replies; unmount does not abort an accepted Host write', async t => {
  const late = deferred(), f = fixture(t, (call, base) => call.action === 'pairplan' ? late.promise : base(call)); const stop = f.controller.watch(); await settle(); await f.controller.openPair(); f.controller.selectWorkspace(workspaces[1].id); f.controller.selectProject(null);
  const pending = f.controller.planPair(), call = f.calls.at(-1); stop(); assert.equal(await pending, false); assert.equal(call.signal.aborted, true);
  late.resolve(ok(f.env.makePlan(workspaces[1].root, { projectId: 'cloud-new', label: 'late', summary: { upload: 0, download: 0, delete: 0, conflicts: 0, blocked: 0 } }))); await settle(); assert.equal(f.controller.getSnapshot().dialog, null);
  const writeLate = deferred(), other = fixture(t, (call, base) => call.action === 'paircommit' ? writeLate.promise : base(call)); const close = other.controller.watch(); await settle(); const plan = await pair(other.controller), writing = other.controller.confirmPair(plan), write = other.calls.at(-1);
  close(); assert.equal(write.signal.aborted, false); writeLate.resolve(ok({ accepted: true, operationId: write.payload.requestId })); assert.equal(await writing, true);
  assert.equal(other.calls.at(-1).action, 'paircommit'); assert.equal(other.clock.jobs.size, 0);
  const timeout = fixture(t, (call, base) => call.action === 'syncprojects' ? new Promise(() => {}) : base(call)); await timeout.controller.refresh(); const loading = timeout.controller.openPair(); timeout.clock.run(60000); assert.equal(await loading, false); assert.equal(timeout.controller.getSnapshot().dialog.error.code, 'TIMEOUT');
});

test('Host-persisted uncertainty on reopening blocks new writes and bounds read reconciliation', async t => {
  const f = fixture(t); f.env.current = status({ operations: [{ id: 'prior-request', kind: 'sync', state: 'uncertain' }], bindings: [{ ...binding, state: 'uncertain' }] });
  const stop = f.controller.watch(); await settle(); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(await f.controller.run(binding.id), false);
  for (let index = 0; index < 10; ++index) { f.clock.run(3000); await settle(); }
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.controller.getSnapshot().pollStopped, true);
  f.env.current = status(); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, false);
  stop();
});

test('accepted receipt with missing operation history stops bounded polling rather than fabricating completion', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncrun' ? ok({ accepted: true, operationId: call.payload.requestId }) : base(call));
  const stop = f.controller.watch(); await settle(); await f.controller.run(binding.id);
  for (let index = 0; index < 9; ++index) { f.clock.run(3000); await settle(); }
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending.length, 1);
  assert.equal(f.calls.filter(call => call.action === 'syncrun').length, 1); stop();
});

test('returning to a cached account never revives authority without a new syncstatus read', async t => {
  const f = fixture(t); f.controller.setIdentity(identity); await f.controller.refresh();
  f.controller.setIdentity({ ...identity, loggedIn: false }); f.controller.setIdentity(identity);
  assert.equal(f.controller.getSnapshot().ready, false); assert.equal(await f.controller.run(binding.id), false);
  await f.controller.refresh(); assert.equal(f.controller.getSnapshot().ready, true); assert.equal(await f.controller.run(binding.id), true);
});

test('unknown write is not reconciled by the right request ID with the wrong operation kind', async t => {
  const f = fixture(t, (call, base, env) => {
    if (call.action !== 'paircommit') return base(call);
    env.current = status({ operations: [{ id: call.payload.requestId, kind: 'restore', state: 'succeeded' }] });
    throw new Error('lost ack');
  });
  const plan = await pair(f.controller); await f.controller.confirmPair(plan);
  assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending.length, 1);
});

test('secure request ID fallback works and broken crypto fails before writing', async t => {
  const fallback = fixture(t, null, { crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } } }); const plan = await pair(fallback.controller); assert.equal(await fallback.controller.confirmPair(plan), true);
  assert.match(fallback.calls.find(call => call.action === 'paircommit').payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const bad = fixture(t, null, { crypto: {} }); const badPlan = await pair(bad.controller); assert.equal(await bad.controller.confirmPair(badPlan), false); assert.equal(bad.controller.getSnapshot().dialog.error.code, 'BAD_REQUEST_ID'); assert.equal(bad.calls.some(call => call.action === 'paircommit'), false);
});

async function archivePlan(controller) {
  await controller.refresh(); assert.equal(await controller.openArchives(binding.id), true);
  assert.equal(controller.selectArchive('archive-new'), true); assert.equal(await controller.planArchiveImport(), true);
  return controller.getSnapshot().dialog.plan;
}
async function repairPlan(controller) {
  await controller.refresh(); assert.equal(controller.openRepair(binding.id), true);
  assert.equal(await controller.planRepair(), true); return controller.getSnapshot().dialog.plan;
}

test('archive and import-result DTOs deeply allowlist counts, warnings and readonly new IDs', () => {
  const parsed = parseSyncStatus(status({ bindings: [{ ...archiveBinding, warning: 'untrusted-secret' }], operations: [{ id: 'import-one', kind: 'import', state: 'failed', bindingId: binding.id, importedCount: 1, skippedCount: 2, failedCount: 1, sessionIds: ['new-session'], errorCode: 'SYNC_IMPORT_UNCERTAIN', token: 'untrusted-secret' }] }));
  assert.equal(parsed.bindings[0].archives, 3); assert.equal(parsed.bindings[0].skippedArchives, 2); assert.equal(parsed.bindings[0].warningCode, 'SYNC_ARCHIVES_SKIPPED');
  assert.deepEqual(parsed.operations[0].sessionIds, ['new-session']); assert.ok(Object.isFrozen(parsed.operations[0].sessionIds)); assert.equal(parsed.operations[0].importedCount, 1);
  const archives = parseSyncArchives({ archives: archiveRows.map(row => ({ ...row, payload: 'untrusted-secret' })), counts: { total: 3, imported: 1, uncertain: 1, password: 'untrusted-secret' } });
  assert.ok(Object.isFrozen(archives.archives[1].sessionIds) && Object.isFrozen(archives.counts)); assert.equal(JSON.stringify([parsed, archives]).includes('untrusted-secret'), false);
  for (const patch of [{ importedCount: -1 }, { failedCount: null }, { sessionIds: ['../bad'] }, { sessionIds: ['same', 'same'] }]) assert.throws(() => parseSyncStatus(status({ operations: [{ id: 'bad-op', kind: 'import', state: 'failed', ...patch }] })), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseSyncStatus(status({ bindings: [{ ...archiveBinding, archives: -1 }] })), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseSyncArchives({ archives: archiveRows, counts: { total: 3, imported: 3, uncertain: 1 } }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseSyncArchives({ archives: [{ ...archiveRows[0], state: 'ready' }], counts: { total: 1, imported: 0, uncertain: 0 } }), { code: 'INVALID_RESPONSE' });
  assert.equal(Object.hasOwn(parseSyncStatus(status()).operations[0] ?? {}, 'importedCount'), false);
});

test('paused binding archive import is explicit, eligibility unchecked, and never enables file sync', async t => {
  const f = fixture(t); f.env.current = status({ bindings: [{ ...archiveBinding, enabled: false, state: 'paused' }] });
  await f.controller.refresh(); const before = f.calls.length; assert.equal(await f.controller.openArchives(binding.id), true);
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['syncarchives']); assert.equal(f.controller.getSnapshot().dialog.selectedId, '');
  assert.equal(f.controller.selectArchive('archive-imported'), false); assert.equal(f.controller.selectArchive('archive-uncertain'), false); assert.equal(f.controller.selectArchive('not-issued'), false);
  assert.equal(f.controller.selectArchive('archive-new'), true); assert.equal(await f.controller.planArchiveImport(), true);
  const plan = f.controller.getSnapshot().dialog.plan; assert.equal(plan.eligibility, 'unchecked'); assert.equal(plan.counts.sessions, 3); assert.ok(Object.isFrozen(plan.counts));
  assert.equal(f.calls.some(call => call.action === 'syncarchiveimport'), false);
  assert.equal(await f.controller.confirmArchiveImport({ ...plan }), false);
  const submitted = f.controller.confirmArchiveImport(plan); assert.equal(await f.controller.confirmArchiveImport(plan), false); assert.equal(await submitted, true);
  const writes = f.calls.filter(call => call.action === 'syncarchiveimport'); assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].payload).sort(), ['revision', 'server', 'username', 'planId', 'requestId', 'confirm'].sort());
  assert.equal(f.calls.some(call => call.action === 'syncpause'), false); assert.equal(f.controller.getSnapshot().status.bindings[0].enabled, false);
  f.controller.closeDialog(); assert.equal(await f.controller.openArchives(binding.id), true); assert.equal(f.controller.selectArchive('archive-new'), false, 'in-memory import admission latch must defeat stale available catalog');
});

test('archive plan revealing already-imported or uncertain eligibility is readonly and nonrepeatable', async t => {
  for (const eligibility of ['imported', 'uncertain']) {
    const f = fixture(t, (call, base) => { const result = base(call); if (call.action === 'syncarchiveplan') Object.assign(result.value.plan, { eligibility, sessionIds: ['already-created'] }); return result; });
    const plan = await archivePlan(f.controller); assert.equal(plan.eligibility, eligibility); assert.deepEqual(plan.sessionIds, ['already-created']);
    assert.equal(await f.controller.confirmArchiveImport(plan), false); f.controller.back(); assert.equal(f.controller.selectArchive('archive-new'), false);
    assert.equal(f.calls.some(call => call.action === 'syncarchiveimport'), false);
  }
});

test('terminal partial native import preserves IDs, allows other file work, and prohibits archive replay', async t => {
  const f = fixture(t, (call, base, env) => {
    if (call.action !== 'syncarchiveimport') return base(call);
    env.current = status({ bindings: [archiveBinding], operations: [{ id: call.payload.requestId, kind: 'import', state: 'failed', bindingId: binding.id, importedCount: 1, skippedCount: 1, failedCount: 1, sessionIds: ['created-before-failure'], errorCode: 'SYNC_IMPORT_UNCERTAIN' }] });
    return ok({ accepted: true, operationId: call.payload.requestId });
  });
  const plan = await archivePlan(f.controller); assert.equal(await f.controller.confirmArchiveImport(plan), true);
  const snapshot = f.controller.getSnapshot(); assert.equal(snapshot.pending.length, 0); assert.equal(snapshot.uncertain, false); assert.equal(snapshot.status.operations[0].importedCount, 1); assert.deepEqual(snapshot.status.operations[0].sessionIds, ['created-before-failure']);
  assert.equal(snapshot.dialog.items.find(row => row.id === 'archive-new').state, 'uncertain'); assert.equal(await f.controller.confirmArchiveImport(plan), false);
  f.controller.closeDialog(); await f.controller.openArchives(binding.id); assert.equal(f.controller.selectArchive('archive-new'), false);
  assert.equal(f.calls.filter(call => call.action === 'syncarchiveimport').length, 1); assert.equal(await f.controller.run(binding.id), true, 'native terminal uncertainty must not quarantine unrelated file sync');
});

test('unknown native-import ACK only reconciles status and keeps archive nonrepeatable after failed terminal result', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncarchiveimport' ? Promise.reject(new Error('untrusted-secret')) : base(call));
  const stop = f.controller.watch(); await settle(); const plan = await archivePlan(f.controller); assert.equal(await f.controller.confirmArchiveImport(plan), false);
  assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(await f.controller.planArchiveImport(), false);
  const requestId = f.calls.find(call => call.action === 'syncarchiveimport').payload.requestId;
  f.env.current = status({ operations: [{ id: requestId, kind: 'import', state: 'failed', importedCount: 1, failedCount: 1, sessionIds: ['unknown-created'], errorCode: 'SYNC_IMPORT_UNCERTAIN' }] });
  f.clock.run(3000); await settle(); assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().pending.length, 0); assert.equal(f.controller.getSnapshot().dialog.operationId, requestId);
  f.controller.closeDialog(); await f.controller.openArchives(binding.id); assert.equal(f.controller.selectArchive('archive-new'), false); assert.equal(f.calls.filter(call => call.action === 'syncarchiveimport').length, 1); stop();
});

test('archive identity changes, epoch admission rejection, expiry and close cannot revive old consent', async t => {
  for (const change of [{ revision: 8 }, { username: 'other' }, { loggedIn: false }]) {
    const f = fixture(t), plan = await archivePlan(f.controller); f.env.current = status(change); await f.controller.refresh();
    assert.equal(await f.controller.confirmArchiveImport(plan), false); assert.equal(f.calls.some(call => call.action === 'syncarchiveimport'), false);
  }
  const expired = fixture(t), plan = await archivePlan(expired.controller); expired.clock.advance(60001); assert.equal(await expired.controller.confirmArchiveImport(plan), false);
  const epoch = fixture(t, (call, base) => call.action === 'syncarchiveimport' ? failure('ACCOUNT_MISMATCH') : base(call)), epochPlan = await archivePlan(epoch.controller);
  assert.equal(await epoch.controller.confirmArchiveImport(epochPlan), false); assert.equal(epoch.controller.getSnapshot().uncertain, false); assert.equal(epoch.controller.getSnapshot().dialog.stage, 'choose');
  assert.equal(await epoch.controller.planArchiveImport(), true, 'definite pre-admission rejection permits explicit fresh planning, not old write replay');
  const closed = fixture(t), closedPlan = await archivePlan(closed.controller); closed.controller.closeDialog(); assert.equal(await closed.controller.confirmArchiveImport(closedPlan), false);
  assert.equal(closed.calls.some(call => call.action === 'syncarchiveimport'), false);
});

test('repair opens an inert explanation only for enabled known-repairable blocks and requires final consent', async t => {
  const f = fixture(t); f.env.current = status({ bindings: [repairBinding] }); await f.controller.refresh(); const before = f.calls.length;
  assert.equal(f.controller.openRepair(binding.id), true); assert.equal(f.calls.length, before); assert.equal(f.controller.getSnapshot().dialog.plan, null);
  assert.equal(await f.controller.planRepair(), true); const plan = f.controller.getSnapshot().dialog.plan;
  assert.deepEqual(plan.summary, { restore: 1, conflicts: 1, unchanged: 2 }); assert.deepEqual(plan.paths, ['source/missing.txt', 'source/edited.txt']); assert.ok(Object.isFrozen(plan.paths));
  assert.equal(f.calls.some(call => call.action === 'syncrepair'), false); assert.equal(await f.controller.confirmRepair({ ...plan }), false);
  const accepted = f.controller.confirmRepair(plan); assert.equal(await f.controller.confirmRepair(plan), false); assert.equal(await accepted, true);
  assert.equal(f.calls.filter(call => call.action === 'syncrepair').length, 1); assert.equal(f.calls.some(call => call.action === 'syncpause'), false);
  for (const row of [{ ...repairBinding, enabled: false }, { ...repairBinding, errorCode: 'SYNC_ROOT_CHANGED' }, { ...repairBinding, errorCode: 'SYNC_JOURNAL_CORRUPT' }, { ...repairBinding, errorCode: 'NOT_LOGGED_IN' }, { ...repairBinding, state: 'synced' }]) {
    assert.equal(canRepairBinding(row), false); const no = fixture(t); no.env.current = status({ bindings: [row] }); await no.controller.refresh(); assert.equal(no.controller.openRepair(binding.id), false); assert.equal(no.calls.some(call => call.action === 'syncrepairplan'), false);
  }
});

test('repair rejects unsafe paths, changed root/status/identity and definite failures stay actionable', async t => {
  const bad = fixture(t, (call, base) => { const result = base(call); if (call.action === 'syncrepairplan') result.value.plan.paths = ['../escape']; return result; }); bad.env.current = status({ bindings: [repairBinding] }); await bad.controller.refresh(); bad.controller.openRepair(binding.id);
  assert.equal(await bad.controller.planRepair(), false); assert.equal(bad.controller.getSnapshot().dialog.error.code, 'INVALID_RESPONSE');
  for (const change of [{ ...repairBinding, root: 'E:\\changed' }, { ...repairBinding, enabled: false }, { ...repairBinding, errorCode: 'SYNC_ROOT_CHANGED' }]) {
    const f = fixture(t); f.env.current = status({ bindings: [repairBinding] }); const plan = await repairPlan(f.controller); f.env.current = status({ bindings: [change] }); await f.controller.refresh();
    assert.equal(await f.controller.confirmRepair(plan), false); assert.equal(f.calls.some(call => call.action === 'syncrepair'), false);
  }
  const rejected = fixture(t, (call, base) => call.action === 'syncrepair' ? failure('SYNC_PLAN_CHANGED') : base(call)); rejected.env.current = status({ bindings: [repairBinding] });
  const plan = await repairPlan(rejected.controller); assert.equal(await rejected.controller.confirmRepair(plan), false); assert.equal(rejected.controller.getSnapshot().dialog.stage, 'choose'); assert.equal(rejected.controller.getSnapshot().uncertain, false); assert.equal(await rejected.controller.planRepair(), true);
});

test('unknown repair write is bounded status-only reconciliation with no replay', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncrepair' ? Promise.reject(new Error('lost repair ack')) : base(call)); f.env.current = status({ bindings: [repairBinding] });
  const stop = f.controller.watch(); await settle(); const plan = await repairPlan(f.controller); assert.equal(await f.controller.confirmRepair(plan), false); assert.equal(f.controller.getSnapshot().uncertain, true);
  for (let index = 0; index < 9; ++index) { f.clock.run(3000); await settle(); }
  assert.equal(f.clock.jobs.size, 0); assert.equal(await f.controller.confirmRepair(plan), false); assert.equal(f.calls.filter(call => call.action === 'syncrepair').length, 1); stop();
});

test('optional storage DTO is deeply allowlisted and never invents verification or usage', () => {
  assert.equal(Object.hasOwn(parseSyncStatus(status()), 'storage'), false);
  const parsed = parseSyncStatus(status({ storage: { limitBytes: 10 * STORAGE_GIB, usedBytes: 11 * STORAGE_GIB, verified: true, root: 'untrusted-secret', credentials: { token: 'untrusted-secret' } } }));
  assert.deepEqual(parsed.storage, { limitBytes: 10 * STORAGE_GIB, usedBytes: 11 * STORAGE_GIB, verified: true }); assert.ok(Object.isFrozen(parsed.storage)); assert.equal(JSON.stringify(parsed).includes('untrusted-secret'), false);
  assert.deepEqual(parseSyncStatus(status({ storage: { limitBytes: STORAGE_GIB, verified: false } })).storage, { limitBytes: STORAGE_GIB, verified: false });
  for (const storage of [null, {}, { limitBytes: 0, verified: true }, { limitBytes: -1, verified: true }, { limitBytes: NaN, verified: false }, { limitBytes: 1.5, verified: false }, { limitBytes: Number.MAX_SAFE_INTEGER + 1, verified: true }, { limitBytes: STORAGE_GIB, verified: 1 }, { limitBytes: STORAGE_GIB, usedBytes: -1, verified: false }, { limitBytes: STORAGE_GIB, usedBytes: null, verified: false }]) assert.throws(() => parseSyncStatus(status({ storage })), { code: 'INVALID_RESPONSE' });
});

test('quota mutation validates exact integer GiB bytes without coercion and remains optional', async t => {
  const f = fixture(t); f.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await f.controller.refresh();
  for (const value of [undefined, null, String(STORAGE_GIB), 0, 1, STORAGE_GIB - 1, STORAGE_GIB + 1, 1.5 * STORAGE_GIB, (MAX_STORAGE_GIB + 1) * STORAGE_GIB, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateStorageLimit(value), { code: 'BAD_REQUEST' }); assert.equal(await f.controller.setStorageLimit(value), false);
  }
  assert.equal(f.calls.some(call => call.action === 'syncsettings'), false);
  assert.equal(validateStorageLimit(STORAGE_GIB), STORAGE_GIB); assert.equal(await f.controller.setStorageLimit(STORAGE_GIB), true);
  const before = f.calls.length; assert.equal(await f.controller.setStorageLimit(STORAGE_GIB), false); assert.equal(f.calls.length, before);
  assert.equal(await f.controller.setStorageLimit(MAX_STORAGE_GIB * STORAGE_GIB), true); assert.equal(f.controller.getSnapshot().status.storage.limitBytes, MAX_STORAGE_GIB * STORAGE_GIB);
  const old = fixture(t); await old.controller.refresh(); assert.equal(await old.controller.setStorageLimit(STORAGE_GIB), false); assert.equal(old.calls.some(call => call.action === 'syncsettings'), false);
});

test('quota save uses current sync identity/CAS, no operation ID, and never changes project consent', async t => {
  const f = fixture(t, null, { crypto: { randomUUID() { assert.fail('quota settings must not mint a task request ID'); } } }); f.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, usedBytes: 0, verified: true } });
  f.controller.setIdentity({ ...identity, revision: 999 }); await f.controller.refresh();
  const before = f.controller.getSnapshot().status.bindings;
  assert.equal(await f.controller.setStorageLimit(20 * STORAGE_GIB), true);
  const call = f.calls.find(call => call.action === 'syncsettings'); assert.deepEqual(call.payload, { revision: 7, server: identity.server, username: identity.username, quotaBytes: 20 * STORAGE_GIB });
  const current = f.controller.getSnapshot(); assert.equal(current.status.revision, 8); assert.equal(current.status.storage.limitBytes, 20 * STORAGE_GIB); assert.deepEqual(current.status.bindings, before); assert.equal(current.pending.length, 0); assert.equal(current.status.operations.length, 0);
  assert.ok(f.calls.every(call => ['syncstatus', 'syncsettings'].includes(call.action)));
  for (const extra of [{ loggedIn: false }, { capability: 'unknown' }, { capability: 'upgrade-required' }]) {
    const blocked = fixture(t); blocked.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false }, ...extra }); await blocked.controller.refresh(); assert.equal(await blocked.controller.setStorageLimit(20 * STORAGE_GIB), false); assert.equal(blocked.calls.some(call => call.action === 'syncsettings'), false);
  }
});

test('quota writes serialize, invalidate stale project plans, and definite CAS rejection is not unknown', async t => {
  const late = deferred(), f = fixture(t, (call, base) => call.action === 'syncsettings' ? late.promise : base(call)); f.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await f.controller.refresh();
  const writing = f.controller.setStorageLimit(20 * STORAGE_GIB); assert.equal(f.controller.getSnapshot().busy, 'syncsettings'); assert.equal(await f.controller.setStorageLimit(30 * STORAGE_GIB), false); assert.equal(await f.controller.refresh(), false);
  f.env.current = status({ revision: 8, storage: { limitBytes: 20 * STORAGE_GIB, verified: false } }); late.resolve(ok(f.env.current)); assert.equal(await writing, true); assert.equal(f.calls.filter(call => call.action === 'syncsettings').length, 1);
  const planned = fixture(t); planned.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); const plan = await pair(planned.controller); await planned.controller.setStorageLimit(20 * STORAGE_GIB); assert.equal(planned.controller.getSnapshot().dialog.plan, null); assert.equal(await planned.controller.confirmPair(plan), false); assert.equal(planned.calls.some(call => call.action === 'paircommit'), false);
  const rejected = fixture(t, (call, base) => call.action === 'syncsettings' ? failure('CONFIG_CONFLICT') : base(call)); rejected.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await rejected.controller.refresh();
  assert.equal(await rejected.controller.setStorageLimit(20 * STORAGE_GIB), false); assert.equal(rejected.controller.getSnapshot().uncertain, false); assert.equal(rejected.controller.getSnapshot().pending.length, 0); assert.equal(rejected.controller.getSnapshot().error.code, 'CONFIG_CONFLICT');
});

test('unknown quota ACK only reconciles newer revision plus exact desired limit, never blindly repeats', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncsettings' ? Promise.reject(new Error('untrusted-secret')) : base(call)); f.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } });
  const stop = f.controller.watch(); await settle(); assert.equal(await f.controller.setStorageLimit(20 * STORAGE_GIB), false);
  assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.controller.getSnapshot().pending[0].quotaBytes, 20 * STORAGE_GIB); assert.equal(f.controller.getSnapshot().pending[0].requestId, null);
  assert.equal(await f.controller.setStorageLimit(20 * STORAGE_GIB), false); assert.equal(await f.controller.setStorageLimit(30 * STORAGE_GIB), false);
  for (let index = 0; index < 9; ++index) { f.clock.run(3000); await settle(); }
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.controller.getSnapshot().pollStopped, true);
  f.env.current = status({ storage: { limitBytes: 20 * STORAGE_GIB, verified: false } }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, true, 'same revision cannot confirm setting');
  f.env.current = status({ revision: 8, storage: { limitBytes: 30 * STORAGE_GIB, verified: false } }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, true, 'different new limit cannot acknowledge our setting');
  f.env.current = status({ revision: 9, storage: { limitBytes: 20 * STORAGE_GIB, verified: false } }); await f.controller.refresh(); assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().pending.length, 0);
  assert.equal(f.calls.filter(call => call.action === 'syncsettings').length, 1); assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret'), false); stop();
});

test('uncertain quota setting coexists with immediate safety pause without discarding either outcome', async t => {
  const f = fixture(t, (call, base) => call.action === 'syncsettings' ? Promise.reject(new Error('lost quota ack')) : base(call)); f.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await f.controller.refresh();
  await f.controller.setStorageLimit(20 * STORAGE_GIB); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(await f.controller.setEnabled(binding.id, false), true);
  assert.equal(f.controller.getSnapshot().status.bindings[0].enabled, false); assert.equal(f.controller.getSnapshot().pending.length, 1); assert.equal(f.controller.getSnapshot().pending[0].action, 'syncsettings'); assert.equal(f.controller.getSnapshot().uncertain, true);
  f.env.current = status({ revision: 9, storage: { limitBytes: 20 * STORAGE_GIB, verified: false }, bindings: [{ ...binding, enabled: false, state: 'paused' }] }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().uncertain, false); assert.equal(f.controller.getSnapshot().status.bindings[0].enabled, false); assert.equal(f.calls.filter(call => call.action === 'syncsettings').length, 1); assert.equal(f.calls.filter(call => call.action === 'syncpause').length, 1);
});

test('malformed quota acknowledgment cannot authorize a different limit/account or legacy response', async t => {
  for (const reply of [status({ revision: 8 }), status({ revision: 8, storage: { limitBytes: 30 * STORAGE_GIB, verified: false } }), status({ storage: { limitBytes: 20 * STORAGE_GIB, verified: false } }), status({ revision: 8, username: 'other', storage: { limitBytes: 20 * STORAGE_GIB, verified: false } })]) {
    const f = fixture(t, (call, base) => call.action === 'syncsettings' ? ok(reply) : base(call)); f.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await f.controller.refresh();
    assert.equal(await f.controller.setStorageLimit(20 * STORAGE_GIB), false); assert.equal(f.controller.getSnapshot().uncertain, true); assert.equal(f.calls.filter(call => call.action === 'syncsettings').length, 1);
  }
});

function hooks() {
  const cells = []; let cursor = 0, effects = [];
  const React = { createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; }, useSyncExternalStore(_subscribe, snapshot) { return snapshot(); }, useId() { return 'mock-bidirectional'; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; }, useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = value; }]; },
    useEffect(effect, deps) { const index = cursor++; if (!cells[index] || deps.some((value, at) => value !== cells[index].deps[at])) { const item = { deps, effect, cleanup: cells[index]?.cleanup }; cells[index] = item; effects.push(item); } } };
  return { React, render(Component, props) { cursor = 0; return Component(props); }, mount() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } }, remountEffects() { for (const cell of cells) if (cell?.effect) { cell.cleanup?.(); cell.cleanup = cell.effect(); } }, unmount() { for (const cell of cells) cell?.cleanup?.(); } };
}
function nodes(root) { return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)]; }
function renderedText(root) { return typeof root === 'string' || typeof root === 'number' ? String(root) : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(renderedText).join(' '); }
function button(root, label) { const result = nodes(root).find(row => row.type === 'native:Button' && renderedText(row) === label); assert.ok(result, `missing ${label}`); return result; }
function checkbox(root, label) { const result = nodes(root).find(row => row.type === 'native:Checkbox' && row.props.label === label); assert.ok(result, `missing checkbox ${label}`); return result; }
function modal(p) { return nodes(p.tree()).find(row => row.type === 'native:Modal'); }
function page(t, custom, account = identity) {
  const f = fixture(t, custom), react = hooks(), primitive = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const Component = createBidirectionalPanel(react.React, primitive); let authCalls = 0;
  const props = { connection: f.connection, identity: { ...account, revision: 999 }, onAuthenticationRequired: () => { authCalls++; } };
  t.after(() => react.unmount()); return { ...f, ...react, props, tree: () => react.render(Component, props), get authCalls() { return authCalls; } };
}
async function mount(p) { p.tree(); p.mount(); await settle(); p.tree(); p.mount(); await settle(); }
async function openPair(p) { await mount(p); button(p.tree(), '配对项目').props.onClick(); await settle(); }
async function selectPair(p) { await openPair(p); checkbox(modal(p), '待配对项目').props.onChange(true); checkbox(modal(p), '创建新的云端项目').props.onChange(true); button(modal(p), '预览变更').props.onClick(); await settle(); }

test('cloud project metadata remains optional, readonly, validated and deeply allowlisted', async t => {
  const row = { ...catalog[1], sourceRoot: 'E:\\synthetic\\archived', checkpointCount: 3, latestCreatedAt: '2026-01-02T03:04:05.000Z' };
  const parsed = parseSyncProjects({ projects: [{ ...row, token: 'untrusted-secret', internalPath: 'untrusted-secret' }] });
  assert.deepEqual(parsed.projects[0], row); assert.ok(Object.isFrozen(parsed.projects[0])); assert.equal(JSON.stringify(parsed).includes('untrusted-secret'), false);
  for (const patch of [{ sourceRoot: 'relative/path' }, { sourceRoot: 'https://example.test/path' }, { sourceRoot: 'E:\\bad\npath' }, { checkpointCount: -1 }, { checkpointCount: 1_000_001 }, { latestCreatedAt: 'not-a-date' }]) assert.throws(() => parseSyncProjects({ projects: [{ ...row, ...patch }] }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(parseSyncProjects({ projects: catalog }).projects, catalog, 'old Host responses remain compatible');
  const f = fixture(t, (call, base) => call.action === 'syncprojects' ? ok({ projects: [row] }) : base(call));
  await f.controller.refresh(); await f.controller.openPair(); f.controller.selectWorkspace(workspaces[1].id); f.controller.selectProject(row.projectId); await f.controller.planPair();
  const payload = f.calls.find(call => call.action === 'pairplan').payload;
  assert.equal(payload.projectId, row.projectId); assert.equal(Object.hasOwn(payload, 'sourceRoot'), false); assert.equal(JSON.stringify(payload).includes(row.sourceRoot), false);
});

test('cloud choices use separate full-width rows with neutral labels, source hints and same-name details', async t => {
  const rows = [
    { projectId: 'cloud-source-a', label: 'source', legacy: true, sourceRoot: 'E:\\synthetic\\original-a\\source', checkpointCount: 2, latestCreatedAt: '2026-01-02T03:04:05.000Z' },
    { projectId: 'cloud-source-b', label: 'source', legacy: true, sourceRoot: 'E:\\synthetic\\original-b\\source', checkpointCount: 4 },
    { projectId: 'cloud-current', label: '当前项目', legacy: false },
  ];
  const p = page(t, (call, base) => call.action === 'syncprojects' ? ok({ projects: rows }) : base(call)); await openPair(p);
  let list = nodes(modal(p)).find(node => node.props?.['aria-label'] === '云端项目列表');
  assert.equal(list.props.style.display, 'flex'); assert.equal(list.props.style.flexDirection, 'column');
  assert.equal(list.props.children.length, 3); assert.ok(list.props.children.every(row => row.type === 'div' && row.props.style.width === '100%' && row.props.style.minWidth === 0));
  const first = list.props.children[0], second = list.props.children[1];
  assert.equal(checkbox(first, 'source').props.checked, false); assert.equal(checkbox(second, 'source').props.checked, false);
  assert.match(renderedText(first), /已保存 2 个版本/); assert.ok(renderedText(first).includes(rows[0].sourceRoot));
  assert.match(renderedText(second), /区分同名项目/); assert.ok(renderedText(second).includes(rows[1].projectId));
  assert.doesNotMatch(renderedText(modal(p)), /历史备份|旧版|单向上传|双向项目/);
  assert.match(renderedText(modal(p)), /已有云端内容会保留/);
  checkbox(second, 'source').props.onChange(true); await settle();
  list = nodes(modal(p)).find(node => node.props?.['aria-label'] === '云端项目列表');
  assert.equal(checkbox(list.props.children[0], 'source').props.checked, false); assert.equal(checkbox(list.props.children[1], 'source').props.checked, true);
  assert.ok(p.calls.every(call => ['syncstatus', 'syncprojects'].includes(call.action)), 'selection cannot migrate, delete or upload');
  nodes(modal(p)).find(row => row.props?.['aria-label'] === '搜索云端项目').props.onChange({ target: { value: 'original-b' } });
  list = nodes(modal(p)).find(node => node.props?.['aria-label'] === '云端项目列表'); assert.equal(list.props.children.length, 1); assert.equal(list.props.children[0].props['data-cloud-project-id'], rows[1].projectId);
});

test('pairing historical data discloses its write-fence consequence only in explicit review', async t => {
  const rows = [{ projectId: 'historical-project', label: '现有云端项目', legacy: true }];
  const p = page(t, (call, base) => call.action === 'syncprojects' ? ok({ projects: rows }) : base(call)); await openPair(p);
  checkbox(modal(p), '待配对项目').props.onChange(true); checkbox(modal(p), '现有云端项目').props.onChange(true);
  assert.doesNotMatch(renderedText(modal(p)), /旧版|单向上传/);
  button(modal(p), '预览变更').props.onClick(); await settle();
  assert.match(renderedText(modal(p)), /历史内容会保留/);
  assert.match(renderedText(modal(p)), /旧客户端将不能再向此项目追加备份/);
  assert.equal(p.calls.some(call => call.action === 'paircommit'), false);
});

test('native panel starts compact and inert, delegates login and never stores secrets', async t => {
  const p = page(t); await mount(p);
  assert.equal(modal(p).props.open, false); assert.equal(nodes(p.tree()).some(row => row.type === 'native:Input'), false);
  assert.ok(p.calls.every(call => call.action === 'syncstatus')); assert.match(renderedText(p.tree()), /双向同步|不自动清理/);
  const signedOut = page(t, (call, base) => call.action === 'syncstatus' ? ok(status({ loggedIn: false })) : base(call), { ...identity, loggedIn: false }); await mount(signedOut);
  button(signedOut.tree(), '前往登录').props.onClick(); assert.equal(signedOut.authCalls, 1); assert.equal(button(signedOut.tree(), '配对项目').props.disabled, true);
  assert.equal(signedOut.calls.some(call => call.action === 'login'), false);
});

test('native storage editor is optional, collapsed, explicit and rejects input coercion', async t => {
  const absent = page(t); await mount(absent); assert.equal(nodes(absent.tree()).some(row => row.props?.['data-personal-sync'] === 'storage-limit'), false);
  const p = page(t); p.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, usedBytes: 3.5 * STORAGE_GIB, verified: true } }); await mount(p);
  const section = () => nodes(p.tree()).find(row => row.props?.['data-personal-sync'] === 'storage-limit');
  const input = () => nodes(section()).find(row => row.type === 'native:Input');
  assert.equal(section().type, 'details'); assert.equal(section().props.open, undefined); assert.match(renderedText(section()), /共享上限：10 GiB/); assert.match(renderedText(section()), /最近核对使用：3.5 GiB/); assert.match(renderedText(section()), /包含队列、归档缓存和回收副本；达到上限暂停，不自动删除/);
  assert.equal(input().props.type, 'number'); assert.equal(input().props.min, 1); assert.equal(input().props.max, 1024); assert.equal(input().props.value, '10'); assert.equal(button(section(), '保存上限').props.disabled, true);
  for (const value of ['', '0', '-1', '1025', '1.5', '1e2', ' 20', '020']) {
    input().props.onChange({ target: { value } }); assert.equal(input().props.value, value); assert.equal(button(section(), '保存上限').props.disabled, true); button(section(), '保存上限').props.onClick();
  }
  assert.equal(p.calls.some(call => call.action === 'syncsettings'), false);
  input().props.onChange({ target: { value: '20' } }); assert.equal(button(section(), '保存上限').props.disabled, false); const save = button(section(), '保存上限').props.onClick; save(); save(); await settle();
  assert.equal(p.calls.filter(call => call.action === 'syncsettings').length, 1); assert.match(renderedText(section()), /共享上限：20 GiB/); assert.equal(input().props.value, '20'); assert.equal(button(section(), '保存上限').props.disabled, true);
  assert.ok(p.calls.every(call => ['syncstatus', 'syncsettings'].includes(call.action)));
});

test('native quota usage is shown only when verified and never fabricates missing bytes', async t => {
  for (const storage of [{ limitBytes: 10 * STORAGE_GIB, usedBytes: 3 * STORAGE_GIB, verified: false }, { limitBytes: 10 * STORAGE_GIB, verified: true }]) {
    const p = page(t); p.env.current = status({ storage }); await mount(p);
    const section = nodes(p.tree()).find(row => row.props?.['data-personal-sync'] === 'storage-limit'); assert.match(renderedText(section), /最近核对使用：尚未核对/);
  }
  const zero = page(t); zero.env.current = status({ storage: { limitBytes: STORAGE_GIB, usedBytes: 0, verified: true } }); await mount(zero);
  assert.match(renderedText(nodes(zero.tree()).find(row => row.props?.['data-personal-sync'] === 'storage-limit')), /最近核对使用：0 GiB/);
});

test('quota draft consent is revision/account bound and stale save handlers cannot write', async t => {
  const p = page(t); p.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await mount(p);
  const input = () => nodes(p.tree()).find(row => row.type === 'native:Input' && row.props['aria-label'] === '存储上限 GiB');
  input().props.onChange({ target: { value: '20' } }); const old = button(p.tree(), '保存上限').props.onClick;
  p.env.current = status({ revision: 8, storage: { limitBytes: 15 * STORAGE_GIB, verified: false } }); button(p.tree(), '刷新状态').props.onClick(); await settle(); old(); await settle();
  assert.equal(p.calls.some(call => call.action === 'syncsettings'), false); assert.equal(button(p.tree(), '保存上限').props.disabled, true); assert.match(renderedText(p.tree()), /重新输入上限/);
  input().props.onChange({ target: { value: '20' } }); button(p.tree(), '保存上限').props.onClick(); await settle(); assert.equal(p.calls.find(call => call.action === 'syncsettings').payload.revision, 8);
  input().props.onChange({ target: { value: '30' } }); const priorAccount = button(p.tree(), '保存上限').props.onClick;
  p.props.identity = { ...identity, server: 'https://other.example.test' }; p.tree(); priorAccount(); await settle(); assert.equal(p.calls.filter(call => call.action === 'syncsettings').length, 1);
});

test('native uncertain quota save disables quota replay but leaves immediate pause available', async t => {
  const p = page(t, (call, base) => call.action === 'syncsettings' ? Promise.reject(new Error('lost quota ack')) : base(call)); p.env.current = status({ storage: { limitBytes: 10 * STORAGE_GIB, verified: false } }); await mount(p);
  nodes(p.tree()).find(row => row.type === 'native:Input' && row.props['aria-label'] === '存储上限 GiB').props.onChange({ target: { value: '20' } }); button(p.tree(), '保存上限').props.onClick(); await settle();
  assert.equal(button(p.tree(), '保存上限').props.disabled, true); const pause = nodes(p.tree()).find(row => row.type === 'native:Switch'); assert.equal(pause.props.disabled, false); pause.props.onChange(false); await settle();
  assert.equal(nodes(p.tree()).find(row => row.type === 'native:Switch').props.checked, false); assert.equal(p.calls.filter(call => call.action === 'syncsettings').length, 1); assert.equal(p.calls.filter(call => call.action === 'syncpause').length, 1); assert.match(renderedText(p.tree()), /结果未确认/);
});

test('native archive modal is explicit on paused files, readonly for claimed archives, and requires separate consent', async t => {
  const p = page(t); p.env.current = status({ bindings: [{ ...archiveBinding, enabled: false, state: 'paused' }] }); await mount(p);
  assert.match(renderedText(p.tree()), /会话归档 3 · 延后 2/); assert.match(renderedText(p.tree()), /部分会话归档已延后/);
  button(p.tree(), '会话').props.onClick(); await settle(); assert.equal(modal(p).props.title, '会话归档');
  assert.match(renderedText(modal(p)), /不会启用文件同步/); assert.match(renderedText(modal(p)), /session-already|session-possible/);
  assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Checkbox').length, 1);
  assert.equal(button(modal(p), '预览导入').props.disabled, true); checkbox(modal(p), archiveRows[0].label).props.onChange(true);
  button(modal(p), '预览导入').props.onClick(); await settle(); assert.equal(modal(p).props.title, '确认导入安全会话');
  assert.match(renderedText(modal(p)), /会话 3 · 事件 12 · 资源 2 · 文件 4/); assert.match(renderedText(modal(p)), /归档不等于全部可续接/); assert.match(renderedText(modal(p)), /支持情况将在导入时检查/);
  assert.equal(p.calls.some(call => call.action === 'syncarchiveimport'), false);
  const confirm = button(modal(p), '确认导入新会话').props.onClick; confirm(); confirm(); await settle();
  assert.equal(p.calls.filter(call => call.action === 'syncarchiveimport').length, 1); assert.equal(p.calls.some(call => call.action === 'syncpause'), false);
});

test('native partial import failure displays new IDs/counts after closing and never offers duplicate import', async t => {
  const p = page(t, (call, base, env) => {
    if (call.action !== 'syncarchiveimport') return base(call);
    env.current = status({ bindings: [archiveBinding], operations: [{ id: call.payload.requestId, kind: 'import', state: 'failed', bindingId: binding.id, importedCount: 2, skippedCount: 1, failedCount: 1, sessionIds: ['created-one', 'created-two'], errorCode: 'SYNC_IMPORT_UNCERTAIN', token: 'untrusted-secret' }] });
    return ok({ accepted: true, operationId: call.payload.requestId });
  });
  p.env.current = status({ bindings: [archiveBinding] }); await mount(p); button(p.tree(), '会话').props.onClick(); await settle(); checkbox(modal(p), archiveRows[0].label).props.onChange(true); button(modal(p), '预览导入').props.onClick(); await settle(); button(modal(p), '确认导入新会话').props.onClick(); await settle();
  assert.match(renderedText(modal(p)), /已导入 2 · 跳过 1 · 失败 1/); assert.match(renderedText(modal(p)), /created-one/); assert.match(renderedText(modal(p)), /created-two/); assert.match(renderedText(modal(p)), /不要重复导入/); assert.doesNotMatch(renderedText(modal(p)), /untrusted-secret/);
  modal(p).props.onClose(); assert.match(renderedText(p.tree()), /created-one/); assert.equal(button(p.tree(), '配对项目').props.disabled, false);
  button(p.tree(), '会话').props.onClick(); await settle(); assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Checkbox').length, 0); assert.equal(button(modal(p), '预览导入').props.disabled, true);
  assert.equal(p.calls.filter(call => call.action === 'syncarchiveimport').length, 1);
});

test('native repair modal previews retained paths and only confirms known enabled blocked transactions', async t => {
  const p = page(t); p.env.current = status({ bindings: [repairBinding] }); await mount(p);
  const before = p.calls.length; button(p.tree(), '核对中断事务').props.onClick(); await settle(); assert.equal(modal(p).props.title, '核对中断事务'); assert.equal(p.calls.length, before);
  assert.match(renderedText(modal(p)), /保留新的本机修改和旧备份/); button(modal(p), '预览变更').props.onClick(); await settle();
  assert.equal(modal(p).props.title, '确认修复中断事务'); assert.match(renderedText(modal(p)), /可安全补回 1 · 保留冲突 1 · 未改变 2/); assert.match(renderedText(modal(p)), /source\/missing.txt/);
  assert.equal(p.calls.some(call => call.action === 'syncrepair'), false); modal(p).props.onClose(); assert.equal(p.calls.some(call => call.action === 'syncrepair'), false);
  button(p.tree(), '核对中断事务').props.onClick(); button(modal(p), '预览变更').props.onClick(); await settle(); const confirm = button(modal(p), '确认修复并继续').props.onClick; confirm(); confirm(); await settle();
  assert.equal(p.calls.filter(call => call.action === 'syncrepair').length, 1);
  const corrupt = page(t); corrupt.env.current = status({ bindings: [{ ...repairBinding, errorCode: 'SYNC_ROOT_CHANGED' }] }); await mount(corrupt);
  assert.equal(nodes(corrupt.tree()).some(row => row.type === 'native:Button' && renderedText(row) === '核对中断事务'), false);
});

test('native import result never fabricates missing counts and unsafe archive plans remain readonly', async t => {
  const p = page(t, (call, base) => { const result = base(call); if (call.action === 'syncarchiveplan') Object.assign(result.value.plan, { eligibility: 'uncertain', sessionIds: ['native-maybe'] }); return result; });
  p.env.current = status({ bindings: [archiveBinding], operations: [{ id: 'terminal-native', kind: 'import', state: 'failed', bindingId: binding.id, sessionIds: ['prior-id'], errorCode: 'SYNC_IMPORT_UNCERTAIN' }] }); await mount(p);
  assert.match(renderedText(p.tree()), /已导入 未确认 · 跳过 未确认 · 失败 未确认/);
  button(p.tree(), '会话').props.onClick(); await settle(); checkbox(modal(p), archiveRows[0].label).props.onChange(true); button(modal(p), '预览导入').props.onClick(); await settle();
  assert.equal(button(modal(p), '确认导入新会话').props.disabled, true); assert.match(renderedText(modal(p)), /native-maybe/); assert.match(renderedText(modal(p)), /不允许重复导入/);
  button(modal(p), '确认导入新会话').props.onClick(); await settle(); assert.equal(p.calls.some(call => call.action === 'syncarchiveimport'), false);
});

test('fresh same-account revocation requests parent readonly auth refresh once and offers manual retry', async t => {
  const p = page(t); await mount(p); assert.equal(p.authCalls, 0);
  p.env.current = status({ loggedIn: false }); button(p.tree(), '刷新状态').props.onClick(); await settle(); p.tree(); p.mount(); await settle();
  assert.equal(p.authCalls, 1); assert.equal(button(p.tree(), '重新登录').props.disabled, undefined); assert.match(renderedText(p.tree()), /不会自动重发凭据/);
  for (let index = 0; index < 2; ++index) { button(p.tree(), '刷新状态').props.onClick(); await settle(); p.tree(); p.mount(); await settle(); }
  assert.equal(p.authCalls, 1); button(p.tree(), '重新登录').props.onClick(); assert.equal(p.authCalls, 2);
  assert.equal(p.calls.some(call => ['login', 'password'].includes(call.action)), false);
  const changed = page(t); await selectPair(changed); const oldConfirm = button(modal(changed), '确认并启用').props.onClick;
  changed.env.current = status({ server: 'https://other.example.test', loggedIn: false }); button(changed.tree(), '刷新状态').props.onClick(); await settle(); changed.tree(); changed.mount(); await settle(); oldConfirm(); await settle();
  assert.equal(changed.authCalls, 0); assert.equal(changed.calls.some(call => call.action === 'paircommit'), false);
});

test('confirmed same-account revocation still requests readonly auth recovery while an earlier write is uncertain', async t => {
  const p = page(t, (call, base) => call.action === 'syncrun' ? Promise.reject(new Error('lost ack')) : base(call)); await mount(p);
  button(p.tree(), '立即同步').props.onClick(); await settle();
  p.env.current = status({ loggedIn: false }); button(p.tree(), '刷新状态').props.onClick(); await settle(); p.tree(); p.mount(); await settle();
  assert.equal(p.authCalls, 1); assert.match(renderedText(p.tree()), /重新登录/);
  assert.equal(p.calls.filter(call => call.action === 'syncrun').length, 1); assert.equal(p.calls.some(call => call.action === 'login'), false);
});

test('failed readonly parent auth callback never loops and explicit relogin CTA remains usable', async t => {
  const p = page(t); let callbacks = 0; p.props.onAuthenticationRequired = () => { callbacks++; return Promise.reject(new Error('synthetic parent read failure')); };
  await mount(p); p.env.current = status({ loggedIn: false }); button(p.tree(), '刷新状态').props.onClick(); await settle(); p.tree(); p.mount(); await settle(); assert.equal(callbacks, 1);
  button(p.tree(), '刷新状态').props.onClick(); await settle(); p.tree(); p.mount(); await settle(); assert.equal(callbacks, 1);
  button(p.tree(), '重新登录').props.onClick(); await settle(); assert.equal(callbacks, 2); assert.equal(p.calls.some(call => call.action === 'login'), false);
});

test('native first-run and upgraded-server buttons explicitly discover capability without mount probes', async t => {
  const p = page(t, (call, base, env) => { if (call.action === 'syncprojects') env.current = { ...env.current, capability: 'supported' }; return base(call); });
  p.env.current = status({ capability: 'unknown', bindings: [] }); await mount(p);
  assert.ok(p.calls.every(call => call.action === 'syncstatus')); assert.equal(button(p.tree(), '连接项目').props.disabled, false);
  button(p.tree(), '连接项目').props.onClick(); await settle(); assert.equal(modal(p).props.open, true);
  assert.equal(button(p.tree(), '配对项目').props.disabled, false); assert.equal(p.calls.filter(call => call.action === 'syncprojects').length, 1);
  checkbox(modal(p), '待配对项目').props.onChange(true); checkbox(modal(p), '创建新的云端项目').props.onChange(true);
  button(modal(p), '预览变更').props.onClick(); await settle(); assert.equal(modal(p).props.title, '确认启用双向同步');
  const old = page(t, (call, base) => call.action === 'syncprojects' ? failure('SYNC_CLIENT_UPGRADE_REQUIRED') : base(call)); old.env.current = status({ capability: 'upgrade-required' }); await mount(old);
  assert.equal(button(old.tree(), '重新检查连接').props.disabled, false); button(old.tree(), '重新检查连接').props.onClick(); await settle();
  assert.match(renderedText(modal(old)), /升级同步服务器和各端插件/); assert.equal(button(modal(old), '刷新列表').props.disabled, false);
});

test('native wizard shows two explicit lists, no preselection, read-only counts/root then final enable', async t => {
  const p = page(t); await openPair(p);
  assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Checkbox' && row.props.checked).length, 0);
  assert.equal(button(modal(p), '预览变更').props.disabled, true);
  assert.equal(nodes(modal(p)).filter(row => row.type === 'native:Input').length, 2);
  checkbox(modal(p), '待配对项目').props.onChange(true); checkbox(modal(p), '创建新的云端项目').props.onChange(true);
  button(modal(p), '预览变更').props.onClick(); await settle(); assert.equal(modal(p).props.title, '确认启用双向同步');
  assert.ok(renderedText(modal(p)).includes(workspaces[1].root)); assert.match(renderedText(modal(p)), /上传 2 · 下载 3 · 删除 1 · 冲突 1 · 阻止 0/); assert.match(renderedText(modal(p)), /会话日志仅归档/);
  assert.equal(p.calls.some(call => call.action === 'paircommit'), false);
  const submit = button(modal(p), '确认并启用').props.onClick; submit(); submit(); await settle(); assert.equal(p.calls.filter(call => call.action === 'paircommit').length, 1);
  assert.equal(p.calls.find(call => call.action === 'paircommit').payload.revision, 7); assert.equal(modal(p).props.title, '核对同步结果');
  modal(p).props.onClose(); assert.equal(modal(p).props.open, false); assert.equal(p.calls.some(call => /cancel/.test(call.action)), false);
});

test('native pause acts immediately, no Save button; conflict preserve-both and recycle final targets are visible', async t => {
  const p = page(t); await mount(p);
  const toggle = nodes(p.tree()).find(row => row.type === 'native:Switch'); toggle.props.onChange(false); await settle();
  assert.equal(p.calls.filter(call => call.action === 'syncpause').length, 1); assert.equal(nodes(p.tree()).some(row => row.type === 'native:Button' && renderedText(row) === '保存'), false);
  button(p.tree(), '冲突').props.onClick(); await settle(); checkbox(modal(p), conflicts[0].path).props.onChange(true);
  assert.equal(checkbox(modal(p), '保留双方（默认）').props.checked, true); assert.match(renderedText(modal(p)), /删除版本/);
  button(modal(p), '预览变更').props.onClick(); await settle(); assert.match(renderedText(modal(p)), /保留双方|source\/file.local-copy.txt/); assert.equal(p.calls.some(call => call.action === 'syncresolve'), false);
  modal(p).props.onClose(); button(p.tree(), '回收站').props.onClick(); await settle(); checkbox(modal(p), recycled[0].path).props.onChange(true); button(modal(p), '预览变更').props.onClick(); await settle();
  assert.equal(modal(p).props.title, '确认恢复文件'); assert.match(renderedText(modal(p)), /old.restored.txt/); assert.equal(p.calls.some(call => call.action === 'syncrestore'), false);
});

test('native definite rejection remains actionable; stale account handler cannot write', async t => {
  const rejected = page(t, (call, base) => call.action === 'paircommit' ? failure('BUSY') : base(call)); await selectPair(rejected); button(modal(rejected), '确认并启用').props.onClick(); await settle();
  assert.equal(modal(rejected).props.title, '配对同步项目'); assert.equal(button(modal(rejected), '预览变更').props.disabled, false); assert.match(renderedText(modal(rejected)), /稍后重试/); assert.doesNotMatch(renderedText(modal(rejected)), /untrusted-secret/);
  const stale = page(t); await selectPair(stale); const handler = button(modal(stale), '确认并启用').props.onClick;
  stale.props.identity = { ...identity, username: 'different' }; stale.tree(); handler(); await settle();
  assert.equal(stale.calls.some(call => call.action === 'paircommit'), false);
});

test('native large pairing list remains searchable beyond the bounded first page', async t => {
  const many = Array.from({ length: 201 }, (_, index) => ({ ...binding, id: `binding-${index}`, label: `配对 ${index}` }));
  const p = page(t, (call, base) => call.action === 'syncstatus' ? ok(status({ bindings: many })) : base(call)); await mount(p);
  assert.equal(nodes(p.tree()).filter(row => row.props?.['data-binding-id']).length, 200);
  const input = nodes(p.tree()).find(row => row.type === 'native:Input' && row.props['aria-label'] === '搜索已配对项目');
  input.props.onChange({ target: { value: '配对 200' } }); assert.equal(nodes(p.tree()).filter(row => row.props?.['data-binding-id']).length, 1); assert.match(renderedText(p.tree()), /配对 200/);
});

test('native effect remount keeps read watcher alive without an extra write or disposed controller', async t => {
  const p = page(t); await mount(p); p.remountEffects(); await settle();
  assert.equal(button(p.tree(), '配对项目').props.disabled, false);
  button(p.tree(), '配对项目').props.onClick(); await settle(); assert.equal(modal(p).props.open, true);
  assert.ok(p.calls.every(call => ['syncstatus', 'syncprojects'].includes(call.action)));
});

test('native search is bounded and ordinary keyboard/IME editing never selects or submits', async t => {
  const p = page(t, (call, base) => call.action === 'syncprojects' ? ok({ projects: Array.from({ length: 150 }, (_, index) => ({ projectId: `project-${index}`, label: `项目 ${index}`, legacy: false })) }) : base(call)); await openPair(p);
  assert.match(renderedText(modal(p)), /前100项/);
  const input = nodes(modal(p)).find(row => row.type === 'native:Input' && row.props['aria-label'] === '搜索云端项目');
  assert.equal(input.props.onKeyDown, undefined); input.props.onCompositionStart();
  const event = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  modal(p).props.onKeyDownCapture(event); assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(modal(p).props.open, true);
  input.props.onCompositionEnd(); input.props.onKeyUp(); const next = { ...event, prevented: false, stopped: false }; modal(p).props.onKeyDownCapture(next); assert.equal(next.prevented, false);
  input.props.onChange({ target: { value: 'not-found' } }); assert.match(renderedText(modal(p)), /暂无匹配/);
  assert.equal(p.calls.some(call => ['pairplan', 'paircommit'].includes(call.action)), false);
});
