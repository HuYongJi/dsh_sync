import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { createSyncEngine } from '../src/sync-engine.mjs';
import { createSyncApplier } from '../src/sync-local.mjs';
import { sha256 } from '../src/protocol.mjs';

const base = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url))), projectId = 'repair-project';
const password = 'synthetic-repair-loopback-password';
async function fixture(t, initial = { 'a.txt': 'old-A', 'b.txt': 'old-B' }) {
  await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'sync-repair-'));
  const server = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`, requests = [];
  server.on('request', req => requests.push({ method: req.method, url: req.url }));
  t.after(async () => { await closeSyncServer(server); assert.equal(path.dirname(directory), base); assert.match(path.basename(directory), /^sync-repair-[A-Za-z0-9]+$/); assert.equal(await fs.realpath(directory), directory); await fs.rm(directory, { recursive: true, force: true }); });
  async function device(id, files = {}) {
    const root = path.join(directory, `root-${id}`), stateDir = path.join(directory, `state-${id}`); await fs.mkdir(root);
    for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(root, name), bytes);
    const client = new SyncV2Client({ server: url }), grant = await client.loginRenewable({ username: 'owner', password, deviceId: id });
    const options = { directory: stateDir, root, bindingId: `binding-${id}`, projectId, accountIdentity: { server: url, serverId: grant.serverId, username: 'owner', deviceId: id, authorizationEpoch: 0 }, getClient: async () => client };
    const make = patch => createSyncEngine({ ...options, ...patch }), engine = make();
    return { root, client, engine, make, options, state: async () => JSON.parse(await fs.readFile(engine.filename, 'utf8')) };
  }
  const a = await device('a', initial), b = await device('b'); await a.engine.run(); await b.engine.run();
  async function remote() { const head = await a.client.syncHead(projectId); return { head, manifest: await a.client.syncCheckpoint(projectId, head.id, head.manifestDigest) }; }
  return { directory, server, requests, a, b, remote, device };
}
const write = (d, name, bytes) => fs.writeFile(path.join(d.root, name), bytes);
const text = (d, name) => fs.readFile(path.join(d.root, name), 'utf8');
const journalPath = (d, id) => path.join(d.root, '.dsh-sync', 'v2', d.options.bindingId, 'transactions', id, 'journal.json');
const backupPath = (d, id, index = 0) => path.join(d.root, '.dsh-sync', 'v2', d.options.bindingId, 'transactions', id, 'backup', String(index));
async function incoming(f, { partialPublish = false, afterFirst = false, beforeMoveRace = false } = {}) {
  await write(f.a, 'a.txt', 'new-A'); if (afterFirst) await write(f.a, 'b.txt', 'new-B'); await f.a.engine.run();
  let faulted = false;
  const engine = f.b.make({ fault: async (phase, _journal, item) => {
    if (faulted) return;
    if (beforeMoveRace && phase === 'before-preserve') { faulted = true; await write(f.b, item.path, 'racing actual bytes'); return; }
    if (partialPublish && phase === 'before-publish') { faulted = true; await write(f.b, item.path, 'partial'); throw new Error('synthetic interrupted publish'); }
    if (afterFirst && phase === 'after-operation' || !partialPublish && !afterFirst && !beforeMoveRace && phase === 'after-preserve') { faulted = true; throw new Error('synthetic interrupted apply'); }
  } });
  const result = await engine.run(); assert.equal(result.state, 'blocked'); return (await f.b.state()).pending.requestId;
}
const writes = f => f.requests.filter(item => item.method === 'PUT' || item.url.endsWith('/commits')).length;

test('repair retires a blocked apply atomically, preserves verified bases and newer edits, then unrelated files continue', async t => {
  const f = await fixture(t), oldId = await incoming(f, { afterFirst: true }); await write(f.b, 'b.txt', 'newer B edit');
  assert.equal((await f.b.make().run()).errorCode, 'SYNC_LOCAL_CHANGED');
  const oldJournal = await fs.readFile(journalPath(f.b, oldId), 'utf8'), engine = f.b.make(), plan = await engine.prepareReplan();
  assert.deepEqual(plan.summary, { restore: 0, conflicts: 1, unchanged: 2 }); assert.equal(await text(f.b, 'b.txt'), 'newer B edit');
  assert.equal(await fs.readFile(journalPath(f.b, oldId), 'utf8'), oldJournal, 'preview must not rewrite the original journal');
  const networkWrites = writes(f), requestId = randomUUID(), result = await engine.confirmReplan({ planId: plan.id, requestId });
  assert.equal(result.state, 'replanned'); assert.equal(writes(f), networkWrites); const repaired = await f.b.state();
  assert.equal(repaired.pending, null); assert.equal(repaired.pendingRepair, null); assert.equal(repaired.retired.at(-1).requestId, oldId);
  assert.equal(repaired.bases.find(item => item.path === 'a.txt').state.hash, sha256('new-A'));
  assert.equal(repaired.bases.find(item => item.path === 'b.txt').state.hash, sha256('old-B'));
  assert.equal(await text(f.b, 'b.txt'), 'newer B edit'); assert.equal(await fs.readFile(journalPath(f.b, oldId), 'utf8'), oldJournal);
  await write(f.b, 'other.txt', 'unrelated'); assert.equal((await f.b.make().run()).state, 'conflicted');
  const cloud = await f.remote(); assert.ok(cloud.manifest.conflicts.some(item => item.path === 'b.txt')); assert.ok(cloud.manifest.files.some(item => item.path === 'other.txt'));
  assert.deepEqual(await f.b.make().confirmReplan({ planId: plan.id, requestId }), result, 'duplicate confirmation never rewinds newer engine progress');
});

test('repair of a policy-retired apply restores a custom-ignored missing primary locally without upload or old-policy revival', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f);
  await write(f.b, '.dsh-syncignore', 'a.txt\n'); assert.equal((await f.b.make().run()).errorCode, 'SYNC_REPLAN_REQUIRED');
  const oldJournal = await fs.readFile(journalPath(f.b, oldId), 'utf8'), plan = await f.b.make().prepareReplan();
  assert.equal(plan.paths[0].action, 'restore'); assert.equal(plan.paths[0].excluded, true); assert.equal(plan.paths[0].protected, false);
  const networkWrites = writes(f); await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() });
  assert.equal(writes(f), networkWrites); assert.equal(await text(f.b, 'a.txt'), 'old-A');
  await write(f.b, 'other.txt', 'other'); assert.equal((await f.b.make().run()).state, 'synced');
  const cloud = await f.remote(); assert.equal(cloud.manifest.files.find(item => item.path === 'a.txt').hash, sha256('new-A'));
  assert.equal(await text(f.b, 'a.txt'), 'old-A'); assert.equal(await fs.readFile(journalPath(f.b, oldId), 'utf8'), oldJournal);
  await write(f.b, '.dsh-syncignore', ''); await f.b.make().run();
  assert.equal(await fs.readFile(journalPath(f.b, oldId), 'utf8'), oldJournal); assert.ok((await f.b.state()).retired.some(item => item.requestId === oldId));
});

test('repair preserves publish taint when the remote returned to B, forcing conflict instead of publishing a truncated file cleanly', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f, { partialPublish: true });
  await write(f.a, 'a.txt', 'old-A'); await f.a.engine.run(); // R == common base B.
  const plan = await f.b.make().prepareReplan(); assert.equal(plan.paths[0].ambiguous, true); assert.equal(plan.paths[0].action, 'keep');
  await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() });
  assert.equal((await f.b.state()).bases[0].ambiguous, true); assert.equal(await text(f.b, 'a.txt'), 'partial');
  assert.equal(await fs.readFile(backupPath(f.b, oldId), 'utf8'), 'old-A');
  assert.equal((await f.b.make().run()).state, 'conflicted'); const cloud = await f.remote();
  assert.equal(cloud.manifest.files[0].hash, sha256('old-A')); assert.equal(cloud.manifest.conflicts.length, 1);
  assert.ok(cloud.manifest.conflicts[0].variants.some(item => item?.hash === sha256('partial'))); assert.equal(await text(f.b, 'a.txt'), 'partial');
});

test('repair ambiguity clears only after a verified local/remote match', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f, { partialPublish: true }); await write(f.a, 'a.txt', 'old-A'); await f.a.engine.run();
  const plan = await f.b.make().prepareReplan(); await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() });
  await write(f.b, 'a.txt', 'old-A'); const head = (await f.remote()).head.id;
  assert.equal((await f.b.make().run()).state, 'synced'); assert.equal((await f.b.state()).bases[0].ambiguous, undefined); assert.equal((await f.remote()).head.id, head);
});

test('repair preview is read-only and observe-mode confirmation verifies committed proof without looking up a nonexistent receipt', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), original = await fs.readFile(journalPath(f.b, oldId), 'utf8');
  t.mock.method(f.b.client, 'syncReceipt', async () => assert.fail('an observation has no client commit request receipt'));
  const plan = await f.b.make().prepareReplan(); assert.equal(plan.summary.restore, 1);
  await assert.rejects(fs.stat(path.join(f.b.root, 'a.txt')), { code: 'ENOENT' }); assert.equal(await fs.readFile(journalPath(f.b, oldId), 'utf8'), original);
  assert.ok(await fs.stat(path.join(f.b.engine.engineDirectory, 'repair-plans', `${plan.id}.json`)));
  const result = await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() }); assert.equal(result.summary.restore, 1);
  assert.equal(await text(f.b, 'a.txt'), 'old-A'); assert.equal(await fs.readFile(backupPath(f.b, oldId), 'utf8'), 'old-A');
});

test('repair refuses a primary created after preview without overwriting it or clearing old authority', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), plan = await f.b.make().prepareReplan();
  await write(f.b, 'a.txt', 'new owner content');
  await assert.rejects(f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() }), { code: 'SYNC_REPAIR_CHANGED' });
  assert.equal(await text(f.b, 'a.txt'), 'new owner content'); assert.equal((await f.b.state()).pending.requestId, oldId); assert.equal((await f.b.state()).pendingRepair, null);
});

test('repair mandatory Host exclusions keep primaries untouched while custom ignore is only a local restore boundary', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), engine = f.b.make({ getExcludedPaths: async () => ['a.txt'] });
  assert.equal((await engine.run()).errorCode, 'SYNC_REPLAN_REQUIRED'); const plan = await engine.prepareReplan();
  assert.equal(plan.paths[0].protected, true); assert.equal(plan.paths[0].action, 'keep');
  await engine.confirmReplan({ planId: plan.id, requestId: randomUUID() });
  await assert.rejects(fs.stat(path.join(f.b.root, 'a.txt')), { code: 'ENOENT' }); assert.equal(await fs.readFile(backupPath(f.b, oldId), 'utf8'), 'old-A');
});

for (const point of ['repair-accepted', 'repair-after-restore', 'repair-before-finalize', 'repair-finalized']) {
  test(`repair ${point} crash resumes the same durable request without duplicate effects`, async t => {
    const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), plan = await f.b.make().prepareReplan(), requestId = randomUUID();
    let hit = false;
    const crashing = f.b.make({ fault: async phase => { if (phase === point && !hit) { hit = true; throw new Error('synthetic repair crash'); } } });
    await assert.rejects(crashing.confirmReplan({ planId: plan.id, requestId }));
    const middle = await f.b.state();
    if (point !== 'repair-finalized') { assert.equal(middle.pending.requestId, oldId); assert.equal(middle.pendingRepair.requestId, requestId); }
    const resumed = await f.b.make().confirmReplan({ planId: plan.id, requestId }); assert.equal(resumed.state, 'replanned');
    assert.equal(await text(f.b, 'a.txt'), 'old-A'); assert.equal((await f.b.state()).retired.filter(item => item.requestId === oldId).length, 1);
    const before = await fs.readFile(journalPath(f.b, oldId), 'utf8');
    assert.deepEqual(await f.b.make().confirmReplan({ planId: plan.id, requestId }), resumed); assert.equal(await fs.readFile(journalPath(f.b, oldId), 'utf8'), before);
  });
}

test('repair-owned uncertain exclusive create keeps the partial primary and records taint across restart', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f); await write(f.a, 'a.txt', 'old-A'); await f.a.engine.run();
  const plan = await f.b.make().prepareReplan(), requestId = randomUUID();
  const crashing = f.b.make({ fault: async phase => { if (phase === 'repair-before-restore') { await write(f.b, 'a.txt', 'repair partial'); throw new Error('partial local repair write'); } } });
  await assert.rejects(crashing.confirmReplan({ planId: plan.id, requestId }));
  assert.equal((await f.b.make().run()).errorCode, 'SYNC_REPAIR_INCOMPLETE');
  const result = await f.b.make().confirmReplan({ planId: plan.id, requestId }); assert.equal(result.summary.restore, 0); assert.equal(result.summary.conflicts, 1);
  assert.equal(await text(f.b, 'a.txt'), 'repair partial'); assert.equal((await f.b.state()).bases[0].ambiguous, true);
  assert.equal((await f.b.make().run()).state, 'conflicted'); assert.equal((await f.remote()).manifest.files[0].hash, sha256('old-A'));
});

test('repair witnesses actual raced backup bytes rather than treating them as the planned old version', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f, { beforeMoveRace: true });
  const applier = await createSyncApplier({ root: f.b.root, projectId, bindingId: f.b.options.bindingId });
  const recycled = await applier.readRecycled(oldId, 0); assert.equal(recycled.bytes.toString(), 'racing actual bytes'); assert.equal(recycled.state.hash, sha256('racing actual bytes'));
  const plan = await f.b.make().prepareReplan(); assert.equal(plan.paths[0].action, 'keep'); await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() });
  assert.equal(await text(f.b, 'a.txt'), 'racing actual bytes'); assert.equal((await applier.readRecycled(oldId, 0)).bytes.toString(), 'racing actual bytes');
});

test('repair backup corruption, quota and permission changes fail closed', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), plan = await f.b.make().prepareReplan();
  await assert.rejects(f.b.make({ quotaBytes: 1 }).confirmReplan({ planId: plan.id, requestId: randomUUID() }), { code: 'SYNC_QUOTA' });
  await assert.rejects(f.b.make({ check: async () => { throw Object.assign(new Error('secret grant detail'), { code: 'NOT_LOGGED_IN' }); } }).confirmReplan({ planId: plan.id, requestId: randomUUID() }), error => { assert.equal(error.code, 'NOT_LOGGED_IN'); assert.equal(error.message, 'NOT_LOGGED_IN'); return true; });
  await fs.writeFile(backupPath(f.b, oldId), 'corrupt');
  await assert.rejects(f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() }), { code: 'SYNC_INTEGRITY' });
  await assert.rejects(fs.stat(path.join(f.b.root, 'a.txt')), { code: 'ENOENT' }); assert.equal((await f.b.state()).pending.requestId, oldId);
});

test('repair changed root, changed policy and expired previews cannot acquire write authority', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f); const plan = await f.b.make().prepareReplan();
  await write(f.b, '.dsh-syncignore', '*.txt\n');
  await assert.rejects(f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() }), { code: 'SYNC_POLICY_CHANGED' });
  await write(f.b, '.dsh-syncignore', ''); const fresh = await f.b.make().prepareReplan(), clock = t.mock.method(Date, 'now', () => Date.parse(fresh.expiresAt) + 1);
  await assert.rejects(f.b.make().confirmReplan({ planId: fresh.id, requestId: randomUUID() }), { code: 'SYNC_REPAIR_EXPIRED' }); clock.mock.restore();
  const parked = path.join(f.directory, 'old-root-b'); assert.equal(path.dirname(f.b.root), f.directory); assert.equal(path.dirname(parked), f.directory);
  await fs.rename(f.b.root, parked); await fs.mkdir(f.b.root); await write(f.b, 'a.txt', 'replacement root');
  await assert.rejects(f.b.make().confirmReplan({ planId: fresh.id, requestId: randomUUID() }), { code: 'SYNC_ROOT_CHANGED' }); assert.equal(await text(f.b, 'a.txt'), 'replacement root');
});

test('repair explicitly supersedes a policy-interrupted accepted request and old IDs remain terminal after policy flips back', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), firstPlan = await f.b.make().prepareReplan(), firstId = randomUUID();
  await assert.rejects(f.b.make({ fault: async phase => { if (phase === 'repair-accepted') throw new Error('accepted then interrupted'); } }).confirmReplan({ planId: firstPlan.id, requestId: firstId }));
  await write(f.b, '.dsh-syncignore', 'a.txt\n');
  await assert.rejects(f.b.make().confirmReplan({ planId: firstPlan.id, requestId: firstId }), { code: 'SYNC_POLICY_CHANGED' });
  const secondPlan = await f.b.make().prepareReplan(); assert.equal(secondPlan.supersedesRequestId, firstId); assert.equal(secondPlan.paths[0].excluded, true);
  const secondId = randomUUID(), before = writes(f); await f.b.make().confirmReplan({ planId: secondPlan.id, requestId: secondId });
  assert.equal(writes(f), before); assert.equal(await text(f.b, 'a.txt'), 'old-A');
  const oldResult = await f.b.make().confirmReplan({ planId: firstPlan.id, requestId: firstId }); assert.equal(oldResult.superseded, true); assert.equal(oldResult.supersededBy, secondId);
  await write(f.b, '.dsh-syncignore', ''); assert.deepEqual(await f.b.make().confirmReplan({ planId: firstPlan.id, requestId: firstId }), oldResult);
  assert.equal(await text(f.b, 'a.txt'), 'old-A'); assert.equal((await f.b.state()).retired.filter(item => item.requestId === oldId).length, 1);
});

test('repair supersession carries prior uncertain-create taint and never turns a repair fragment into a clean local edit', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f); await write(f.a, 'a.txt', 'old-A'); await f.a.engine.run();
  const firstPlan = await f.b.make().prepareReplan(), firstId = randomUUID();
  await assert.rejects(f.b.make({ fault: async phase => { if (phase === 'repair-before-restore') { await write(f.b, 'a.txt', 'uncertain repair fragment'); throw new Error('interrupted'); } } }).confirmReplan({ planId: firstPlan.id, requestId: firstId }));
  await write(f.b, '.dsh-syncignore', 'unrelated/**\n'); const secondPlan = await f.b.make().prepareReplan();
  assert.equal(secondPlan.paths[0].ambiguous, true); assert.equal(secondPlan.paths[0].action, 'keep');
  await f.b.make().confirmReplan({ planId: secondPlan.id, requestId: randomUUID() });
  assert.equal((await f.b.state()).bases[0].ambiguous, true); assert.equal(await text(f.b, 'a.txt'), 'uncertain repair fragment');
  assert.equal((await f.b.make().confirmReplan({ planId: firstPlan.id, requestId: firstId })).superseded, true);
  assert.equal((await f.b.make().run()).state, 'conflicted'); assert.equal((await f.remote()).manifest.files[0].hash, sha256('old-A'));
});

test('repair supersession recognizes a prior verified restore without repeating it', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f); const firstPlan = await f.b.make().prepareReplan(), firstId = randomUUID();
  await assert.rejects(f.b.make({ fault: async phase => { if (phase === 'repair-after-restore') throw new Error('after verified bytes'); } }).confirmReplan({ planId: firstPlan.id, requestId: firstId }));
  assert.equal(await text(f.b, 'a.txt'), 'old-A'); await write(f.b, '.dsh-syncignore', 'a.txt\n');
  const plan = await f.b.make().prepareReplan(); assert.equal(plan.paths[0].restoredPreviously, true); assert.equal(plan.summary.restore, 0);
  const result = await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() }); assert.equal(result.summary.restore, 0);
  assert.equal(await text(f.b, 'a.txt'), 'old-A'); assert.equal((await f.b.make().confirmReplan({ planId: firstPlan.id, requestId: firstId })).superseded, true);
});

test('repair missing witnessed backups fail closed and preview does not mkdir anywhere in the project', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }), oldId = await incoming(f), mkdir = fs.mkdir;
  const mock = t.mock.method(fs, 'mkdir', async (directory, ...args) => { const target = path.resolve(directory); assert.ok(target !== f.b.root && !target.startsWith(f.b.root + path.sep), 'preview must be read-only in the project'); return mkdir(directory, ...args); });
  await f.b.make().prepareReplan(); mock.mock.restore();
  const backup = backupPath(f.b, oldId); assert.equal(path.dirname(backup), path.join(f.b.root, '.dsh-sync', 'v2', f.b.options.bindingId, 'transactions', oldId, 'backup')); await fs.unlink(backup);
  await assert.rejects(f.b.make().prepareReplan(), { code: 'SYNC_INTEGRITY' }); assert.equal((await f.b.state()).pending.requestId, oldId);
});

test('repair confirms a commit-mode receipt before retiring accepted local-partial work', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await write(f.a, 'a.txt', 'new-A'); await f.a.engine.run(); await write(f.b, 'own.txt', 'B own');
  await f.b.make({ fault: async phase => { if (phase === 'after-preserve') throw new Error('after commit'); } }).run();
  const pending = (await f.b.state()).pending, receipt = f.b.client.syncReceipt.bind(f.b.client); let lookups = 0;
  t.mock.method(f.b.client, 'syncReceipt', async (...args) => { lookups++; assert.equal(args[1], pending.requestId); return receipt(...args); });
  const plan = await f.b.make().prepareReplan(); const result = await f.b.make().confirmReplan({ planId: plan.id, requestId: randomUUID() });
  assert.equal(result.state, 'replanned'); assert.equal(lookups, 2); assert.equal(await text(f.b, 'own.txt'), 'B own');
  assert.equal((await f.b.state()).bases.find(item => item.path === 'own.txt').state.hash, sha256('B own'));
});

test('repairOutcome reads durable admission and terminal outcomes without network or file writes', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f);
  const lookup = f.b.make({ getClient: async () => assert.fail('outcome lookup must not use the network') });
  const rejectedId = randomUUID(), plan = await f.b.make().prepareReplan();
  const before = await fs.readFile(f.b.engine.filename), requests = f.requests.length;
  assert.deepEqual(await lookup.repairOutcome(rejectedId), { state: 'not-accepted' });
  assert.deepEqual(await fs.readFile(f.b.engine.filename), before); assert.equal(f.requests.length, requests);
  await write(f.b, 'a.txt', 'newer primary');
  await assert.rejects(f.b.make().confirmReplan({ planId: plan.id, requestId: rejectedId }), { code: 'SYNC_REPAIR_CHANGED' });
  assert.equal((await lookup.repairOutcome(rejectedId)).state, 'not-accepted');
  const admittedPlan = await f.b.make().prepareReplan(), admittedId = randomUUID();
  await assert.rejects(f.b.make({ fault: async phase => { if (phase === 'repair-accepted') throw new Error('accepted interruption'); } }).confirmReplan({ planId: admittedPlan.id, requestId: admittedId }), { code: 'SYNC_REPAIR_INCOMPLETE' });
  assert.deepEqual(await lookup.repairOutcome(admittedId), { state: 'pending' });
  await write(f.b, '.dsh-syncignore', 'unrelated/**\n'); const next = await f.b.make().prepareReplan(), nextId = randomUUID();
  const result = await f.b.make().confirmReplan({ planId: next.id, requestId: nextId });
  const stable = await fs.readFile(f.b.engine.filename), checked = f.requests.length;
  assert.deepEqual(await lookup.repairOutcome(nextId), { state: 'completed', result });
  const old = await lookup.repairOutcome(admittedId); assert.equal(old.state, 'superseded'); assert.equal(old.result.supersededBy, nextId);
  assert.deepEqual(await fs.readFile(f.b.engine.filename), stable); assert.equal(f.requests.length, checked);
});

test('repair current-policy guards separate stale pre-admission from interrupted finalization', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await incoming(f); const plan = await f.b.make().prepareReplan(), rejectedId = randomUUID();
  const head = f.b.client.syncHead.bind(f.b.client); let change = true;
  const mock = t.mock.method(f.b.client, 'syncHead', async (...args) => { const value = await head(...args); if (change) { change = false; await write(f.b, '.dsh-syncignore', 'a.txt\n'); } return value; });
  await assert.rejects(f.b.make().confirmReplan({ planId: plan.id, requestId: rejectedId }), { code: 'SYNC_POLICY_CHANGED' }); mock.mock.restore();
  assert.equal((await f.b.make().repairOutcome(rejectedId)).state, 'not-accepted');
  const current = await f.b.make().prepareReplan(), acceptedId = randomUUID();
  await assert.rejects(f.b.make({ fault: async phase => { if (phase === 'repair-before-finalize') await write(f.b, '.dsh-syncignore', '*.log\n'); } }).confirmReplan({ planId: current.id, requestId: acceptedId }), { code: 'SYNC_POLICY_CHANGED' });
  assert.equal((await f.b.make().repairOutcome(acceptedId)).state, 'pending'); assert.equal(await text(f.b, 'a.txt'), 'old-A');
});

test('repair queries an uncertain commit receipt without blind replay and refuses an unproved outcome', async t => {
  const f = await fixture(t, { 'a.txt': 'old-A' }); await write(f.b, 'a.txt', 'local pending');
  let commits = 0; t.mock.method(f.b.client, 'commitSync', async () => { commits++; throw new Error('uncertain before request'); });
  assert.equal((await f.b.make().run()).state, 'uncertain'); let lookups = 0; const receipt = f.b.client.syncReceipt.bind(f.b.client);
  t.mock.method(f.b.client, 'syncReceipt', async (...args) => { lookups++; return receipt(...args); });
  await assert.rejects(f.b.make().prepareReplan(), { code: 'SYNC_COMMIT_UNCERTAIN' }); assert.equal(commits, 1); assert.equal(lookups, 1);
});
