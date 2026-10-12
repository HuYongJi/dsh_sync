import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { SyncClient } from '../src/client.mjs';
import { createSyncEngine } from '../src/sync-engine.mjs';
import { resolveSyncConflict } from '../src/reconcile.mjs';
import { sha256, MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES } from '../src/protocol.mjs';

const parent = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
const password = 'synthetic-engine-loopback-password', projectId = 'engine-project';
const state = text => ({ hash: sha256(text), size: Buffer.byteLength(text), executable: false });
const archiveRef = (kind, bytes) => ({ id: `${kind}-${sha256(bytes)}`, hash: sha256(bytes), size: bytes.length });
function archiveBundle(label) {
  const asset = Buffer.from(`synthetic asset ${label}`), assetRef = archiveRef('asset', asset);
  const session = Buffer.from(JSON.stringify({ format: 'synthetic-idle-session', session: label, assets: [assetRef.id] })), sessionRef = archiveRef('session', session);
  const refs = [assetRef, sessionRef];
  return { asset, assetRef, session, sessionRef, refs, capture: async ({ putBlob, check }) => {
    await check(); await putBlob(assetRef.hash, asset); await putBlob(sessionRef.hash, session); await check(); return { archiveRefs: refs };
  } };
}
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'sync-engine-'));
  const server = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`, requests = [];
  server.on('request', request => requests.push({ method: request.method, url: request.url }));
  t.after(async () => {
    await closeSyncServer(server);
    assert.equal(path.dirname(path.resolve(directory)), parent); assert.match(path.basename(directory), /^sync-engine-[A-Za-z0-9]+$/);
    assert.equal(await fs.realpath(directory), directory);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function device(id, files = {}, extra = {}) {
    const root = path.join(directory, `project-${id}`), local = path.join(directory, `state-${id}`); await fs.mkdir(root);
    for (const [name, bytes] of Object.entries(files)) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
    const client = new SyncV2Client({ server: url });
    const grant = await client.loginRenewable({ username: 'owner', password, deviceId: id });
    const accountIdentity = { server: url, serverId: grant.serverId, username: 'owner', deviceId: id, authorizationEpoch: 0 };
    const options = { directory: local, root, bindingId: `binding-${id}`, projectId, accountIdentity, getClient: async () => client, ...extra };
    const make = patch => createSyncEngine({ ...options, ...patch });
    const engine = make();
    return { root, local, client, grant, accountIdentity, options, engine, make, journal: async () => JSON.parse(await fs.readFile(engine.filename, 'utf8')) };
  }
  return { directory, url, server, requests, device };
}
async function remote(client) {
  const head = await client.syncHead(projectId);
  return { head, manifest: head ? await client.syncCheckpoint(projectId, head.id, head.manifestDigest) : null };
}
async function text(device, name) { return fs.readFile(path.join(device.root, name), 'utf8'); }
async function write(device, name, contents) { const target = path.join(device.root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, contents); }
async function remove(device, name) {
  const target = path.resolve(device.root, name); assert.equal(path.dirname(target), device.root); await fs.unlink(target);
}
const proposal = (device, id) => path.join(device.engine.engineDirectory, 'proposals', `${id}.json`);
async function bump(client) {
  const previous = await remote(client), manifest = previous.manifest ? { ...previous.manifest, id: randomUUID(), parentId: previous.head.id, deviceId: client.deviceId } : { version: 2, id: randomUUID(), projectId, deviceId: client.deviceId, parentId: null, policyRevision: 1, files: [], tombstones: [], conflicts: [], archiveRefs: [], label: 'Engine fixture' };
  return client.commitSync({ manifest, expectedHeadRevision: previous.head?.revision ?? 0, expectedHeadId: previous.head?.id ?? null, requestId: randomUUID() });
}

test('engine preview is read-only in the project/cloud, returns exact summary and persists no credentials', async t => {
  const f = await fixture(t), a = await f.device('a', { 'remote.txt': 'remote' }), b = await f.device('b', { 'local.txt': 'local' });
  assert.equal((await a.engine.run()).state, 'synced');
  const before = await remote(a.client), writes = f.requests.filter(item => item.method === 'PUT' || item.url.endsWith('/commits')).length;
  const preview = await b.make({ accountIdentity: { ...b.accountIdentity, token: b.grant.token, password } }).preview();
  assert.deepEqual(preview.summary, { upload: 1, download: 1, delete: 0, conflicts: 0, blocked: 0 });
  assert.equal(preview.head.id, before.head.id); assert.match(preview.policyHash, /^[a-f0-9]{64}$/); assert.equal(preview.rootIdentity.root, b.root);
  assert.deepEqual(await fs.readdir(b.root), ['local.txt']); assert.equal((await remote(a.client)).head.id, before.head.id);
  assert.equal(f.requests.filter(item => item.method === 'PUT' || item.url.endsWith('/commits')).length, writes);
  const journal = await fs.readFile(b.engine.filename, 'utf8');
  for (const secret of [password, b.grant.token, b.grant.refreshToken]) assert.ok(!journal.includes(secret));
});

test('engine actual-loopback A to B and B to A edits and tracked deletes use per-path bases and recycle', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'base-A', 'b.txt': 'base-B' }), b = await f.device('b');
  assert.equal((await a.engine.run()).state, 'synced'); assert.equal((await b.engine.run()).state, 'synced');
  assert.equal(await text(b, 'a.txt'), 'base-A'); assert.equal((await b.journal()).bases.length, 2);
  await write(b, 'a.txt', 'B edit'); assert.equal((await b.engine.run()).state, 'synced'); assert.equal((await a.engine.run()).state, 'synced');
  assert.equal(await text(a, 'a.txt'), 'B edit');
  await remove(a, 'b.txt'); assert.equal((await a.engine.run()).state, 'synced'); assert.equal((await b.engine.run()).state, 'synced');
  await assert.rejects(fs.stat(path.join(b.root, 'b.txt')), { code: 'ENOENT' });
  const cloud = await remote(a.client); assert.deepEqual(cloud.manifest.files.map(item => item.path), ['a.txt']); assert.equal(cloud.manifest.tombstones[0].path, 'b.txt');
  assert.equal((await b.journal()).bases.find(item => item.path === 'b.txt').state, null);
  const recycled = await b.engine.recycle(); assert.ok(recycled.some(item => item.path === 'b.txt' && item.reason === 'deleted' && item.state.hash === sha256('base-B')));
});

test('engine simultaneous first pairing converges unique files through real CAS contention', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'A' }), b = await f.device('b', { 'b.txt': 'B' });
  const results = await Promise.all([a.engine.run(), b.engine.run()]); assert.ok(results.every(item => item.state === 'synced'), JSON.stringify(results));
  await a.engine.run(); await b.engine.run();
  for (const device of [a, b]) { assert.equal(await text(device, 'a.txt'), 'A'); assert.equal(await text(device, 'b.txt'), 'B'); }
  const cloud = await remote(a.client); assert.equal(cloud.manifest.files.length, 2); assert.deepEqual(cloud.manifest.conflicts, []);
});

test('engine three devices merge disjoint edits instead of treating one remote revision as every path base', async t => {
  const f = await fixture(t), a = await f.device('a', { 'left.txt': 'left-base', 'right.txt': 'right-base' }), b = await f.device('b'), c = await f.device('c');
  await a.engine.run(); await b.engine.run(); await c.engine.run();
  await write(b, 'left.txt', 'B left'); await write(c, 'right.txt', 'C right');
  assert.equal((await b.engine.run()).state, 'synced'); assert.equal((await c.engine.run()).state, 'synced');
  await a.engine.run(); await b.engine.run();
  for (const device of [a, b, c]) { assert.equal(await text(device, 'left.txt'), 'B left'); assert.equal(await text(device, 'right.txt'), 'C right'); }
  assert.deepEqual((await remote(a.client)).manifest.conflicts, []);
});

test('engine edit/edit conflicts freeze primaries, deduplicate sidecars, and preserve variants on a third device', async t => {
  const f = await fixture(t), a = await f.device('a', { 'same.txt': 'common' }), b = await f.device('b'), c = await f.device('c');
  await a.engine.run(); await b.engine.run(); await write(a, 'same.txt', 'A edit'); await a.engine.run(); await write(b, 'same.txt', 'B edit');
  assert.equal((await b.engine.run()).state, 'conflicted'); assert.equal(await text(b, 'same.txt'), 'B edit');
  const cloud = await remote(a.client), conflict = cloud.manifest.conflicts[0];
  assert.equal(conflict.variants.length, 2); assert.equal((await b.journal()).bases[0].preservedState.hash, sha256('B edit'));
  const sidecars = path.join(b.root, '.dsh-sync', 'v2', 'binding-b', 'conflicts', conflict.id);
  assert.equal((await fs.readdir(sidecars)).length, 2);
  assert.equal((await b.engine.run()).state, 'conflicted'); assert.equal((await remote(a.client)).head.revision, cloud.head.revision);
  assert.equal((await c.engine.run()).state, 'conflicted'); await assert.rejects(fs.stat(path.join(c.root, 'same.txt')), { code: 'ENOENT' });
  assert.equal((await remote(c.client)).manifest.conflicts[0].variants.length, 2); assert.equal((await c.engine.conflicts())[0].id, conflict.id);
  await write(c, 'same.txt', 'late C edit'); assert.equal((await c.engine.run()).state, 'conflicted');
  const beforeProposals = await fs.readdir(path.join(b.engine.engineDirectory, 'proposals'));
  assert.equal((await b.engine.run()).state, 'conflicted');
  assert.equal(await text(b, 'same.txt'), 'B edit'); assert.equal((await fs.readdir(sidecars)).length, 3);
  assert.equal(await fs.readFile(path.join(sidecars, sha256('late C edit')), 'utf8'), 'late C edit');
  assert.deepEqual(await fs.readdir(path.join(b.engine.engineDirectory, 'proposals')), beforeProposals, 'sidecar repair must not grow redundant proposal history');
});

test('engine delete/edit conflict preserves surviving bytes and accepts only explicit cloud resolution', async t => {
  const f = await fixture(t), a = await f.device('a', { 'same.txt': 'common' }), b = await f.device('b');
  await a.engine.run(); await b.engine.run(); await remove(a, 'same.txt'); await a.engine.run(); await write(b, 'same.txt', 'surviving edit');
  assert.equal((await b.engine.run()).state, 'conflicted'); const cloud = await remote(a.client), conflict = cloud.manifest.conflicts[0];
  assert.ok(conflict.variants.includes(null)); assert.equal(await text(b, 'same.txt'), 'surviving edit');
  await a.engine.run(); await assert.rejects(fs.stat(path.join(a.root, 'same.txt')), { code: 'ENOENT' });
  const resolution = resolveSyncConflict({ remote: cloud.manifest, conflictId: conflict.id, state: state('surviving edit'), deviceId: 'a' });
  await a.client.commitSync({ ...resolution, expectedHeadRevision: cloud.head.revision, expectedHeadId: cloud.head.id, requestId: randomUUID() });
  assert.equal((await a.engine.run()).state, 'synced'); assert.equal((await b.engine.run()).state, 'synced');
  assert.equal(await text(a, 'same.txt'), 'surviving edit'); assert.equal((await b.journal()).bases[0].conflictId, undefined);
});

test('engine captures latest local bytes on every offline tick before trying any network', async t => {
  const f = await fixture(t), a = await f.device('a', { 'latest.txt': 'first' }); let offline = true;
  const engine = a.make({ getClient: async () => { if (offline) throw new Error('synthetic offline secret'); return a.client; } });
  const requests = f.requests.length;
  assert.equal((await engine.run()).state, 'offline'); await write(a, 'latest.txt', 'latest'); assert.equal((await engine.run()).state, 'offline');
  assert.equal(f.requests.length, requests); const disk = await a.journal(); assert.equal(disk.capture.files[0].hash, sha256('latest')); assert.equal(disk.pending, null);
  assert.equal((await engine.store.getBlob(disk.capture.files[0].hash)).toString(), 'latest'); assert.ok(!JSON.stringify(await engine.status()).includes('secret'));
  offline = false; assert.equal((await engine.run()).state, 'synced'); assert.equal((await remote(a.client)).manifest.files[0].hash, sha256('latest'));
});

test('engine restart resolves a lost commit acknowledgement by receipt without replaying or changing its immutable request', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'uploaded' });
  const commit = a.client.commitSync.bind(a.client), receipt = a.client.syncReceipt.bind(a.client); let commits = 0, receipts = 0;
  t.mock.method(a.client, 'commitSync', async request => { commits++; await commit(request); throw new Error('synthetic lost ACK'); });
  t.mock.method(a.client, 'syncReceipt', async (...args) => { receipts++; return receipt(...args); });
  const result = await a.engine.run(); assert.equal(result.state, 'uncertain');
  const disk = await a.journal(), filename = proposal(a, disk.pending.requestId), immutable = await fs.readFile(filename, 'utf8');
  assert.equal((await remote(a.client)).head.revision, 1);
  const resumed = a.make(); assert.equal((await resumed.run()).state, 'synced');
  assert.equal(commits, 1); assert.equal(receipts, 1); assert.equal(await fs.readFile(filename, 'utf8'), immutable);
  assert.equal((await a.journal()).pending, null); assert.equal((await a.journal()).bases[0].state.hash, sha256('uploaded'));
});

test('engine restart replays the exact same request only after a missing uncertain receipt', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'bytes' });
  const commit = a.client.commitSync.bind(a.client), receipt = a.client.syncReceipt.bind(a.client), requests = [], order = []; let first = true;
  t.mock.method(a.client, 'commitSync', async request => { order.push('commit'); requests.push(JSON.stringify(request)); if (first) { first = false; throw new Error('offline before request reached server'); } return commit(request); });
  t.mock.method(a.client, 'syncReceipt', async (...args) => { order.push('receipt'); return receipt(...args); });
  assert.equal((await a.engine.run()).state, 'uncertain'); assert.equal((await a.make().run()).state, 'synced');
  assert.deepEqual(order, ['commit', 'receipt', 'commit']); assert.equal(requests[0], requests[1]);
});

for (const changedAfterCrash of [false, true]) {
  test(`engine partial-apply restart advances verified paths only${changedAfterCrash ? ' and never overwrites a newer edit' : ''}`, async t => {
    const f = await fixture(t), a = await f.device('a', { 'a.txt': 'old-A', 'b.txt': 'old-B' }), b = await f.device('b');
    await a.engine.run(); await b.engine.run(); await write(a, 'a.txt', 'new-A'); await write(a, 'b.txt', 'new-B'); await a.engine.run();
    let interrupted = false;
    const crashing = b.make({ fault: async phase => { if (phase === 'after-operation' && !interrupted) { interrupted = true; throw new Error('synthetic crash after one durable operation'); } } });
    assert.equal((await crashing.run()).state, 'blocked');
    const partial = await b.journal(); assert.equal(partial.pending.phase, 'local-partial');
    assert.equal(partial.bases.find(item => item.path === 'a.txt').state.hash, sha256('new-A')); assert.equal(partial.bases.find(item => item.path === 'b.txt').state.hash, sha256('old-B'));
    assert.equal(await text(b, 'a.txt'), 'new-A'); assert.equal(await text(b, 'b.txt'), 'old-B');
    if (changedAfterCrash) await write(b, 'b.txt', 'newer local B');
    const resumed = await b.make().run();
    if (changedAfterCrash) {
      assert.equal(resumed.state, 'blocked'); assert.equal(resumed.errorCode, 'SYNC_LOCAL_CHANGED'); assert.equal(await text(b, 'b.txt'), 'newer local B');
      assert.equal((await b.journal()).bases.find(item => item.path === 'b.txt').state.hash, sha256('old-B'));
    } else {
      assert.equal(resumed.state, 'synced'); assert.equal(await text(b, 'b.txt'), 'new-B'); assert.equal((await b.journal()).pending, null);
    }
  });
}

test('engine can recover an accepted fully staged apply offline after a crash preserved the original', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'old' }), b = await f.device('b');
  await a.engine.run(); await b.engine.run(); await write(a, 'a.txt', 'new'); await a.engine.run();
  const crash = b.make({ fault: async phase => { if (phase === 'after-preserve') throw new Error('crash after saving original'); } });
  assert.equal((await crash.run()).state, 'blocked'); await assert.rejects(fs.stat(path.join(b.root, 'a.txt')), { code: 'ENOENT' });
  const offline = b.make({ getClient: async () => { throw new Error('offline after accepted commit'); } });
  const result = await offline.run(); assert.equal(result.state, 'offline');
  assert.equal(await text(b, 'a.txt'), 'new'); assert.equal((await b.journal()).pending, null);
  assert.equal((await b.journal()).bases[0].state.hash, sha256('new')); assert.ok((await offline.recycle()).some(item => item.state.hash === sha256('old')));
});

test('engine refuses a corrupted stored acceptance receipt before any inbound project write', async t => {
  const f = await fixture(t), a = await f.device('a', { 'incoming.txt': 'remote' }), b = await f.device('b');
  await a.engine.run(); const deferred = b.make({ isIdle: async () => false }); await deferred.run();
  const disk = await b.journal(), immutable = await fs.readFile(proposal(b, disk.pending.requestId), 'utf8');
  disk.pending.receipt.id = 'wrong-checkpoint'; await fs.writeFile(b.engine.filename, JSON.stringify(disk));
  const result = await b.make().run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_JOURNAL_CORRUPT');
  assert.deepEqual(await fs.readdir(b.root), []); assert.deepEqual((await b.journal()).bases, []);
  assert.equal(await fs.readFile(proposal(b, disk.pending.requestId), 'utf8'), immutable);
});

test('engine policy changes after a partial apply retire its old apply authority without advancing blocked paths', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'old-A', 'b.txt': 'old-B' }), b = await f.device('b');
  await a.engine.run(); await b.engine.run(); await write(a, 'a.txt', 'new-A'); await write(a, 'b.txt', 'new-B'); await a.engine.run();
  let interrupted = false;
  const crash = b.make({ fault: async phase => { if (phase === 'after-operation' && !interrupted) { interrupted = true; throw new Error('crash'); } } });
  await crash.run(); const pending = (await b.journal()).pending, immutable = await fs.readFile(proposal(b, pending.requestId), 'utf8');
  await write(b, '.dsh-syncignore', 'b.txt\n');
  const result = await b.make().run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_REPLAN_REQUIRED');
  assert.equal((await b.journal()).pending.phase, 'policy-retired'); assert.equal(await text(b, 'b.txt'), 'old-B');
  assert.equal((await b.journal()).bases.find(item => item.path === 'b.txt').state.hash, sha256('old-B'));
  assert.equal(await fs.readFile(proposal(b, pending.requestId), 'utf8'), immutable);
  await write(b, '.dsh-syncignore', '');
  assert.equal((await b.make().run()).errorCode, 'SYNC_REPLAN_REQUIRED', 'a retired descriptor cannot revive when the policy changes back');
});

test('engine idle deferral keeps accepted inbound pending and advances only already materialized local uploads', async t => {
  const f = await fixture(t), a = await f.device('a', { 'remote.txt': 'remote' }), b = await f.device('b', { 'local.txt': 'local' });
  await a.engine.run(); let idle = false;
  const engine = b.make({ isIdle: async () => idle }), deferred = await engine.run();
  assert.equal(deferred.state, 'deferred'); assert.equal(deferred.pendingDownload, 1); assert.equal(deferred.pendingUpload, 0);
  assert.equal(deferred.lastSyncedAt, undefined); assert.deepEqual(await fs.readdir(b.root), ['local.txt']);
  const disk = await b.journal(); assert.equal(disk.pending.receipt.revision, 2); assert.deepEqual(disk.bases.map(item => item.path), ['local.txt']);
  idle = true; assert.equal((await engine.run()).state, 'synced'); assert.equal(await text(b, 'remote.txt'), 'remote');
});

test('engine current policy retires an unsent proposal unchanged and replans without any forbidden blob', async t => {
  const f = await fixture(t), a = await f.device('a', { 'public.txt': 'public', 'private.txt': 'private bytes' });
  const upload = a.client.uploadBlob.bind(a.client); let offline = true;
  t.mock.method(a.client, 'uploadBlob', async (...args) => { if (offline) throw new Error('offline'); return upload(...args); });
  assert.equal((await a.engine.run()).state, 'offline');
  const disk = await a.journal(), old = disk.pending.requestId, immutable = await fs.readFile(proposal(a, old), 'utf8');
  await write(a, '.dsh-syncignore', 'private.txt\n'); offline = false;
  assert.equal((await a.make().run()).state, 'synced'); const current = await remote(a.client);
  assert.deepEqual(current.manifest.files.map(item => item.path), ['public.txt']); assert.notEqual(current.head.requestId, old);
  assert.deepEqual(await a.client.missingBlobs([state('private bytes')]), [sha256('private bytes')]);
  assert.equal(await fs.readFile(proposal(a, old), 'utf8'), immutable); assert.equal((await a.journal()).retired[0].reason, 'SYNC_POLICY_CHANGED');
});

test('engine excludes local private files while preserving unmanaged remote entries without deletions', async t => {
  const f = await fixture(t), a = await f.device('a', { 'private/report.txt': 'remote private', 'public.txt': 'base' }), b = await f.device('b', { '.dsh-syncignore': 'private/\n', 'private/report.txt': 'local private' });
  await a.engine.run(); assert.equal((await b.engine.run()).state, 'synced'); assert.equal(await text(b, 'private/report.txt'), 'local private');
  assert.ok(!(await b.journal()).bases.some(item => item.path.startsWith('private/')));
  await write(b, 'public.txt', 'B public'); await b.engine.run();
  const cloud = await remote(a.client); assert.equal(cloud.manifest.files.find(item => item.path === 'private/report.txt').hash, sha256('remote private'));
  assert.deepEqual(cloud.manifest.tombstones, []); assert.deepEqual(await b.client.missingBlobs([state('local private')]), [sha256('local private')]);
});

test('engine checks current policy immediately before commit and keeps the forbidden descriptor immutable', async t => {
  const f = await fixture(t), a = await f.device('a', { 'private.txt': 'private bytes' });
  const upload = a.client.uploadBlob.bind(a.client);
  t.mock.method(a.client, 'uploadBlob', async (...args) => { const result = await upload(...args); await write(a, '.dsh-syncignore', 'private.txt\n'); return result; });
  const result = await a.engine.run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_POLICY_CHANGED');
  assert.equal(await a.client.syncHead(projectId), null); const pending = (await a.journal()).pending;
  assert.equal(JSON.parse(await fs.readFile(proposal(a, pending.requestId), 'utf8')).manifest.files[0].path, 'private.txt');
});

test('engine missing inventory uploads at most two blobs concurrently and unchanged runs do not grow proposal history', async t => {
  const f = await fixture(t), a = await f.device('a', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`file-${i}.txt`, `bytes-${i}`])));
  const upload = a.client.uploadBlob.bind(a.client); let active = 0, maximum = 0, calls = 0;
  t.mock.method(a.client, 'uploadBlob', async (...args) => { active++; maximum = Math.max(maximum, active); calls++; try { return await upload(...args); } finally { active--; } });
  assert.equal((await a.engine.run()).state, 'synced');
  // Fast loopback responses may finish before the other worker passes its
  // filesystem/authority guards. The contract is a ceiling, not forced overlap.
  assert.ok(maximum >= 1 && maximum <= 2); assert.equal(calls, 8);
  const before = await fs.readdir(path.join(a.engine.engineDirectory, 'proposals'));
  assert.equal((await a.engine.run()).state, 'synced'); assert.equal(calls, 8); assert.deepEqual(await fs.readdir(path.join(a.engine.engineDirectory, 'proposals')), before);
});

for (const stale of [2, 3]) {
  test(`engine CAS contention recomputes with new immutable IDs${stale === 3 ? ' and stops at three attempts' : ''}`, async t => {
    const f = await fixture(t), a = await f.device('a', { 'a.txt': 'local' }), b = await f.device('b');
    const commit = a.client.commitSync.bind(a.client), ids = []; let remaining = stale;
    t.mock.method(a.client, 'commitSync', async request => { ids.push(request.requestId); if (remaining-- > 0) await bump(b.client); return commit(request); });
    const result = await a.engine.run(); assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    assert.equal(result.state, stale === 3 ? 'blocked' : 'synced');
    if (stale === 3) assert.equal(result.errorCode, 'SYNC_CAS_RETRY_LIMIT');
    assert.equal((await a.journal()).retired.length, stale); assert.equal((await a.journal()).pending, null);
  });
}

test('engine legacy heads require explicit migration and never auto-create a canonical v2 head', async t => {
  const f = await fixture(t), a = await f.device('a', { 'local.txt': 'local' });
  const legacy = new SyncClient({ server: f.url, token: a.grant.token, deviceId: 'a' });
  await legacy.commit({ version: 1, id: 'legacy', projectId, deviceId: 'a', parentId: null, createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: a.root, sessionIds: [], files: [] });
  const preview = await a.engine.preview(); assert.equal(preview.migrationRequired, true); assert.equal(preview.summary.blocked, 1);
  const result = await a.engine.run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_MIGRATION_REQUIRED');
  assert.equal(await a.client.syncHead(projectId), null); assert.equal((await a.journal()).pending, null); assert.deepEqual(await fs.readdir(a.root), ['local.txt']);
});

test('engine pinned root and account/server/device identity cannot be silently rebound', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'safe' }); await a.engine.preview();
  for (const patch of [{ username: 'another' }, { serverId: 'another-server' }, { deviceId: 'another-device' }, { authorizationEpoch: 1 }]) {
    const result = await a.make({ accountIdentity: { ...a.accountIdentity, ...patch } }).run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_BINDING_MISMATCH');
  }
  const parked = path.join(f.directory, 'parked-original');
  assert.equal(path.dirname(a.root), f.directory); assert.equal(path.dirname(parked), f.directory);
  await fs.rename(a.root, parked); await fs.mkdir(a.root); await write(a, 'new.txt', 'replacement');
  const result = await a.make().run(); assert.equal(result.errorCode, 'SYNC_ROOT_CHANGED'); assert.equal(await text(a, 'new.txt'), 'replacement');
  assert.equal(await a.client.syncHead(projectId), null);
});

test('engine explicit same-account epoch reauthorization preserves bases, pending requests and immutable history', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'safe' }); let epoch = 0;
  const check = async context => {
    if (context.phase === 'reauthorize') { assert.equal(context.nextAccountIdentity.authorizationEpoch, epoch); return; }
    if (context.accountIdentity.authorizationEpoch !== epoch) throw Object.assign(new Error('no consent'), { code: 'NOT_LOGGED_IN' });
  };
  const commit = a.client.commitSync.bind(a.client); let lose = true;
  t.mock.method(a.client, 'commitSync', async request => { const receipt = await commit(request); if (lose) { lose = false; throw new Error('lost ACK'); } return receipt; });
  const engine = a.make({ check }); assert.equal((await engine.run()).state, 'uncertain');
  const pending = (await a.journal()).pending, immutable = await fs.readFile(proposal(a, pending.requestId), 'utf8'); epoch = 1;
  assert.equal((await engine.run()).errorCode, 'NOT_LOGGED_IN');
  await assert.rejects(engine.reauthorize({ ...a.accountIdentity, serverId: 'other-server', authorizationEpoch: epoch }), { code: 'SYNC_BINDING_MISMATCH' });
  const next = { ...a.accountIdentity, authorizationEpoch: epoch };
  assert.deepEqual(await engine.reauthorize(next), { reauthorized: true, authorizationEpoch: 1 });
  assert.equal((await a.journal()).pending.requestId, pending.requestId); assert.equal(await fs.readFile(proposal(a, pending.requestId), 'utf8'), immutable);
  assert.equal((await a.make({ check, accountIdentity: next }).run()).state, 'synced');
  assert.equal((await a.journal()).bases[0].state.hash, sha256('safe'));
});

test('engine explicit resolution handoff admits an unseen conflict without prematurely advancing its local base', async t => {
  const f = await fixture(t), a = await f.device('a', { 'same.txt': 'base' }), b = await f.device('b'), c = await f.device('c', { 'same.txt': 'C local' });
  await a.engine.run(); await b.engine.run(); await write(a, 'same.txt', 'A edit'); await a.engine.run(); await write(b, 'same.txt', 'B edit'); await b.engine.run();
  const cloud = await remote(c.client), conflict = cloud.manifest.conflicts[0];
  const resolution = resolveSyncConflict({ remote: cloud.manifest, conflictId: conflict.id, state: state('B edit'), deviceId: 'c' });
  const receipt = await c.client.commitSync({ ...resolution, requestId: randomUUID(), expectedHeadRevision: cloud.head.revision, expectedHeadId: cloud.head.id });
  const input = { receipt, conflictId: conflict.id, path: 'same.txt', expectedLocal: state('C local') };
  await assert.rejects(c.engine.acknowledgeResolution({ ...input, receipt: { ...receipt, recordHash: '0'.repeat(64) } }), { code: 'SYNC_INTEGRITY' });
  assert.deepEqual(await c.engine.acknowledgeResolution(input), { acknowledged: true, duplicate: false });
  assert.equal(await text(c, 'same.txt'), 'C local');
  const before = await c.journal(); assert.equal(before.bases[0].state, null); assert.deepEqual(before.bases[0].preservedState, state('C local'));
  assert.deepEqual(await c.engine.acknowledgeResolution(input), { acknowledged: true, duplicate: true });
  assert.equal((await c.make().run()).state, 'synced'); assert.equal(await text(c, 'same.txt'), 'B edit');
  const advanced = (await c.journal()).bases;
  assert.deepEqual(await c.engine.acknowledgeResolution(input), { acknowledged: true, duplicate: true });
  assert.deepEqual((await c.journal()).bases, advanced, 'a duplicate handoff cannot rewind a subsequently applied base');
});

test('engine resolution handoff preserves a newer local edit as a new conflict even when resolution picked the prior local version', async t => {
  const f = await fixture(t), a = await f.device('a', { 'same.txt': 'base' }), b = await f.device('b'), c = await f.device('c', { 'same.txt': 'chosen local' });
  await a.engine.run(); await b.engine.run(); await write(a, 'same.txt', 'A edit'); await a.engine.run(); await write(b, 'same.txt', 'B edit'); await b.engine.run();
  const cloud = await remote(c.client), conflict = cloud.manifest.conflicts[0], chosen = state('chosen local');
  await c.client.uploadBlob(chosen.hash, Buffer.from('chosen local'));
  const resolution = resolveSyncConflict({ remote: cloud.manifest, conflictId: conflict.id, state: chosen, deviceId: 'c' });
  const receipt = await c.client.commitSync({ ...resolution, requestId: randomUUID(), expectedHeadRevision: cloud.head.revision, expectedHeadId: cloud.head.id });
  await c.engine.acknowledgeResolution({ receipt, conflictId: conflict.id, path: 'same.txt', expectedLocal: chosen });
  await write(c, 'same.txt', 'newer local');
  assert.equal((await c.engine.run()).state, 'conflicted'); assert.equal(await text(c, 'same.txt'), 'newer local');
  const next = await remote(c.client); assert.equal(next.manifest.conflicts.length, 1); assert.notEqual(next.manifest.conflicts[0].id, conflict.id);
});

test('engine explicit resolution handoff refuses to overwrite an existing accepted local-apply journal', async t => {
  const f = await fixture(t), a = await f.device('a', { 'same.txt': 'base' }), b = await f.device('b');
  await a.engine.run(); await b.engine.run(); await write(a, 'same.txt', 'A edit'); await a.engine.run(); await write(b, 'same.txt', 'B edit');
  const deferred = b.make({ isIdle: async () => false }); assert.equal((await deferred.run()).state, 'deferred');
  const cloud = await remote(b.client), conflict = cloud.manifest.conflicts[0], before = await b.journal();
  const resolution = resolveSyncConflict({ remote: cloud.manifest, conflictId: conflict.id, state: state('A edit'), deviceId: 'b' });
  const receipt = await b.client.commitSync({ ...resolution, requestId: randomUUID(), expectedHeadRevision: cloud.head.revision, expectedHeadId: cloud.head.id });
  await assert.rejects(deferred.acknowledgeResolution({ receipt, conflictId: conflict.id, path: 'same.txt', expectedLocal: state('B edit') }), { code: 'SYNC_APPLY_INCOMPLETE' });
  const after = await b.journal(); assert.deepEqual(after.pending, before.pending); assert.deepEqual(after.bases, before.bases);
});

test('engine quota blocks before network/upload and never alters user project files', async t => {
  const f = await fixture(t), a = await f.device('a', { 'large.txt': 'x'.repeat(20_000) }), requests = f.requests.length;
  const result = await a.make({ quotaBytes: 4096 }).run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_QUOTA');
  assert.equal(f.requests.length, requests); assert.equal((await text(a, 'large.txt')).length, 20_000);
});

test('engine archive hook spools pinned session and asset closure, previews without upload, and deduplicates unchanged refs', async t => {
  const f = await fixture(t), bundle = archiveBundle('A'), projectBytes = Buffer.from('pinned project report');
  const a = await f.device('a', { 'report.txt': projectBytes }); let captures = 0;
  const captureArchives = async input => {
    captures++; assert.equal(input.root, a.root); assert.equal(input.projectId, projectId); assert.equal(input.deviceId, 'a');
    assert.equal(Object.isFrozen(input.files), true); assert.equal(Object.isFrozen(input.files[0]), true);
    assert.throws(() => { input.files[0].hash = 'changed'; }, TypeError);
    assert.equal(input.files[0].hash, sha256(projectBytes));
    const captured = await bundle.capture(input); await input.putBlob(sha256(projectBytes), projectBytes);
    return { archiveRefs: [...captured.archiveRefs, archiveRef('asset', projectBytes)], message: 'DO-NOT-PERSIST-NATIVE-TEXT', token: 'DO-NOT-PERSIST-CREDENTIAL' };
  };
  const engine = a.make({ captureArchives }), preview = await engine.preview();
  assert.equal(preview.archives, 1); assert.equal(f.requests.filter(item => item.method === 'PUT').length, 0);
  assert.deepEqual(await fs.readdir(a.root), ['report.txt']);
  const result = await engine.run(); assert.equal(result.state, 'synced'); assert.equal(result.archives, 1);
  const cloud = await remote(a.client), refs = cloud.manifest.archiveRefs;
  assert.equal(refs.length, 3); assert.equal(f.requests.filter(item => item.method === 'PUT').length, 3, 'shared project/archive hash uploads once');
  for (const ref of refs) assert.equal(sha256(await a.client.downloadBlob(ref.hash, ref.size)), ref.hash);
  const wrapper = JSON.parse(await a.client.downloadBlob(bundle.sessionRef.hash, bundle.sessionRef.size));
  assert.ok(wrapper.assets.every(id => refs.some(ref => ref.id === id)));
  const disk = await a.journal(), descriptors = await fs.readdir(path.join(engine.engineDirectory, 'proposals'));
  assert.equal(disk.capture.archiveRefs.length, 3);
  const descriptor = JSON.parse(await fs.readFile(path.join(engine.engineDirectory, 'proposals', descriptors[0]), 'utf8'));
  assert.deepEqual(descriptor.localArchiveRefs, disk.capture.archiveRefs); assert.deepEqual(descriptor.priorArchiveRefs, []);
  assert.ok(!JSON.stringify(disk).includes('DO-NOT-PERSIST'));
  assert.equal((await engine.run()).state, 'synced'); assert.equal((await remote(a.client)).head.id, cloud.head.id);
  assert.equal(f.requests.filter(item => item.method === 'PUT').length, 3); assert.equal(captures, 3);
  assert.deepEqual(await fs.readdir(path.join(engine.engineDirectory, 'proposals')), descriptors);
});

test('engine archive references append across devices and remain when a later capture returns no archives', async t => {
  const f = await fixture(t), first = archiveBundle('first'), second = archiveBundle('second');
  const a = await f.device('a', {}, { captureArchives: first.capture }), b = await f.device('b', { 'b.txt': 'B' }, { captureArchives: second.capture });
  assert.equal((await a.engine.run()).archives, 1); const original = (await remote(a.client)).manifest.archiveRefs;
  const result = await b.engine.run(); assert.equal(result.state, 'synced'); assert.equal(result.archives, 2);
  const before = await remote(b.client); assert.equal(before.manifest.archiveRefs.length, 4);
  for (const ref of original) assert.deepEqual(before.manifest.archiveRefs.find(item => item.id === ref.id), ref);
  const withoutArchives = a.make({ captureArchives: async () => ({ archiveRefs: [], skippedCount: 1, warningCode: 'SYNC_ARCHIVES_UNSUPPORTED' }) });
  const observed = await withoutArchives.run(); assert.equal(observed.state, 'synced'); assert.equal(observed.archives, 2); assert.equal(observed.skippedArchives, 1);
  assert.equal(observed.warningCode, 'SYNC_ARCHIVES_UNSUPPORTED'); assert.equal(await text(a, 'b.txt'), 'B');
  const after = await remote(a.client); assert.equal(after.head.id, before.head.id); assert.deepEqual(after.manifest.archiveRefs, before.manifest.archiveRefs);
});

for (const warningCode of ['SYNC_ARCHIVES_UNSUPPORTED', 'SYNC_ARCHIVES_SKIPPED']) {
  test(`engine archive ${warningCode} warning never blocks the file lane or exposes native messages`, async t => {
    const f = await fixture(t), a = await f.device('a', { 'file.txt': 'file lane' }, { captureArchives: async () => ({ archiveRefs: [], skippedCount: 2, warningCode, message: 'RAW-NATIVE-LOG-MUST-NOT-ESCAPE' }) });
    const result = await a.engine.run(); assert.equal(result.state, 'synced'); assert.equal(result.skippedArchives, 2); assert.equal(result.warningCode, warningCode);
    assert.equal(result.archives, undefined); assert.ok(!JSON.stringify(result).includes('RAW-NATIVE'));
    assert.equal((await remote(a.client)).manifest.files[0].hash, sha256('file lane'));
    assert.equal((await a.make().status()).warningCode, warningCode);
  });
}

test('engine archive capture is durable before an offline network attempt', async t => {
  const f = await fixture(t), bundle = archiveBundle('offline'), a = await f.device('a', {}, { captureArchives: bundle.capture });
  const requests = f.requests.length, engine = a.make({ getClient: async () => { throw new Error('offline'); } });
  const result = await engine.run(); assert.equal(result.state, 'offline'); assert.equal(result.archives, 1); assert.equal(result.pendingUpload, 2);
  assert.equal(f.requests.length, requests); assert.equal((await a.journal()).capture.archiveRefs.length, 2);
  assert.deepEqual(await engine.store.getBlob(bundle.sessionRef.hash), bundle.session);
  assert.equal((await a.make().run()).state, 'synced');
});

for (const invalid of ['not-put', 'wrong-id', 'wrong-size', 'warning-text']) {
  test(`engine archive ${invalid} fails closed before any network request`, async t => {
    const f = await fixture(t), bundle = archiveBundle(invalid), a = await f.device('a');
    await a.engine.store.init(); await a.engine.store.putBlob(bundle.sessionRef.hash, bundle.session);
    const requests = f.requests.length;
    const engine = a.make({ captureArchives: async ({ putBlob }) => {
      if (invalid !== 'not-put') await putBlob(bundle.sessionRef.hash, bundle.session);
      return { archiveRefs: [{ ...bundle.sessionRef, ...(invalid === 'wrong-id' ? { id: 'session-not-the-content-hash' } : {}), ...(invalid === 'wrong-size' ? { size: bundle.sessionRef.size + 1 } : {}) }], ...(invalid === 'warning-text' ? { warningCode: 'RAW-SECRET-NATIVE-MESSAGE' } : {}) };
    } });
    const result = await engine.run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_INTEGRITY');
    assert.equal(f.requests.length, requests); assert.ok(!JSON.stringify(result).includes('RAW-SECRET'));
  });
}

test('engine archive spool quota and aggregate reference byte limits fail closed without large fixture files', async t => {
  const f = await fixture(t), a = await f.device('a'), big = Buffer.alloc(20_000, 7), requests = f.requests.length;
  const pressured = a.make({ quotaBytes: 4096, captureArchives: async ({ putBlob }) => { await putBlob(sha256(big), big); return { archiveRefs: [archiveRef('asset', big)] }; } });
  assert.equal((await pressured.run()).errorCode, 'SYNC_QUOTA'); assert.equal(f.requests.length, requests);
  const count = Math.floor(MAX_CHECKPOINT_BYTES / MAX_BLOB_BYTES) + 1;
  const declared = Array.from({ length: count }, (_, i) => { const hash = sha256(`bounded-reference-${i}`); return { id: `asset-${hash}`, hash, size: MAX_BLOB_BYTES }; });
  const oversized = a.make({ captureArchives: async () => ({ archiveRefs: declared }) });
  assert.equal((await oversized.run()).errorCode, 'SYNC_QUOTA'); assert.equal(f.requests.length, requests);
});

test('engine archive checks current policy during the hook and before committing uploaded archive bytes', async t => {
  const f = await fixture(t), bundle = archiveBundle('policy'), a = await f.device('a', { 'private.txt': 'project bytes' });
  const requests = f.requests.length;
  const changed = a.make({ captureArchives: async input => {
    await input.putBlob(bundle.assetRef.hash, bundle.asset); await write(a, '.dsh-syncignore', 'private.txt\n'); await input.check();
    return bundle.capture(input);
  } });
  assert.equal((await changed.run()).errorCode, 'SYNC_POLICY_CHANGED'); assert.equal(f.requests.length, requests);
  await write(a, '.dsh-syncignore', ''); const upload = a.client.uploadBlob.bind(a.client);
  t.mock.method(a.client, 'uploadBlob', async (...args) => { const value = await upload(...args); await write(a, '.dsh-syncignore', 'private.txt\n'); return value; });
  const engine = a.make({ captureArchives: bundle.capture }), result = await engine.run();
  assert.equal(result.errorCode, 'SYNC_POLICY_CHANGED'); assert.equal(await a.client.syncHead(projectId), null);
  const disk = await a.journal(), saved = JSON.parse(await fs.readFile(proposal(a, disk.pending.requestId), 'utf8'));
  assert.equal(saved.localArchiveRefs.length, 2); assert.equal(saved.manifest.archiveRefs.length, 2);
});

test('engine archive upload never grants ownership merely because an old remote archive blob exists in the local cache', async t => {
  const f = await fixture(t), old = archiveBundle('old'), a = await f.device('a', {}, { captureArchives: old.capture }), b = await f.device('b', { 'b.txt': 'B' });
  await a.engine.run(); await b.engine.store.init(); await b.engine.store.putBlob(old.sessionRef.hash, old.session);
  const missing = b.client.missingBlobs.bind(b.client); let uploads = 0;
  t.mock.method(b.client, 'missingBlobs', async refs => [...await missing(refs), ...(refs.some(item => item.hash === old.sessionRef.hash) ? [old.sessionRef.hash] : [])]);
  t.mock.method(b.client, 'uploadBlob', async () => { uploads++; assert.fail('unowned historical references block the entire send set'); });
  const result = await b.engine.run(); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_REMOTE_BLOB_MISSING'); assert.equal(uploads, 0);
  const disk = await b.journal(), saved = JSON.parse(await fs.readFile(proposal(b, disk.pending.requestId), 'utf8'));
  assert.deepEqual(saved.localArchiveRefs, []); assert.equal(saved.priorArchiveRefs.length, 2);
});

for (const accepted of [false, true]) {
  test(`engine archive uncertain restart preserves owned refs and ${accepted ? 'uses its receipt' : 'replays its exact request'} when capture is now skipped`, async t => {
    const f = await fixture(t), bundle = archiveBundle(`retry-${accepted}`), a = await f.device('a', {}, { captureArchives: bundle.capture });
    const commit = a.client.commitSync.bind(a.client), calls = []; let interrupted = false;
    t.mock.method(a.client, 'commitSync', async request => {
      calls.push(JSON.stringify(request));
      if (!interrupted) { interrupted = true; if (accepted) await commit(request); throw new Error('uncertain archive acknowledgement'); }
      return commit(request);
    });
    assert.equal((await a.engine.run()).state, 'uncertain');
    const disk = await a.journal(), filename = proposal(a, disk.pending.requestId), before = await fs.readFile(filename, 'utf8');
    const skipped = a.make({ captureArchives: async () => ({ archiveRefs: [], skippedCount: 1, warningCode: 'SYNC_ARCHIVES_SKIPPED' }) });
    const result = await skipped.run(); assert.equal(result.state, 'synced'); assert.equal(result.archives, 1); assert.equal(result.skippedArchives, 1);
    assert.equal(calls.length, accepted ? 1 : 2); if (!accepted) assert.equal(calls[0], calls[1]);
    assert.equal(await fs.readFile(filename, 'utf8'), before); assert.equal((await remote(a.client)).manifest.archiveRefs.length, 2);
  });
}

test('engine archive descriptor ownership closure survives restart and cannot be removed from a pending proposal', async t => {
  const f = await fixture(t), bundle = archiveBundle('pending'), a = await f.device('a', {}, { captureArchives: bundle.capture });
  t.mock.method(a.client, 'commitSync', async () => { throw new Error('unconfirmed commit'); });
  assert.equal((await a.engine.run()).state, 'uncertain');
  const disk = await a.journal(), filename = proposal(a, disk.pending.requestId), descriptor = JSON.parse(await fs.readFile(filename, 'utf8'));
  descriptor.localArchiveRefs = []; const corrupted = JSON.stringify(descriptor); await fs.writeFile(filename, corrupted);
  disk.pending.descriptorHash = sha256(corrupted); await fs.writeFile(a.engine.filename, JSON.stringify(disk));
  const requests = f.requests.length, result = await a.make().run(); assert.equal(result.errorCode, 'SYNC_JOURNAL_CORRUPT');
  assert.equal(f.requests.length, requests); assert.equal(await fs.readFile(filename, 'utf8'), corrupted);
});

test('engine archive hook waits until accepted partial recovery repairs the primary tree', async t => {
  const f = await fixture(t), a = await f.device('a', { 'a.txt': 'old' }), b = await f.device('b');
  await a.engine.run(); await b.engine.run(); await write(a, 'a.txt', 'new'); await a.engine.run();
  await b.make({ fault: async phase => { if (phase === 'after-preserve') throw new Error('crash'); } }).run();
  await assert.rejects(fs.stat(path.join(b.root, 'a.txt')), { code: 'ENOENT' });
  const bundle = archiveBundle('after-repair'); let calls = 0;
  const engine = b.make({ captureArchives: async input => { calls++; assert.equal(await text(b, 'a.txt'), 'new'); return bundle.capture(input); } });
  await engine.preview(); assert.equal(calls, 0, 'preview cannot archive an intermediate primary tree');
  const result = await engine.run(); assert.equal(result.state, 'synced'); assert.equal(result.archives, 1); assert.equal(calls, 1);
});
