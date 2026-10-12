import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sha256, validateManifest } from '../src/protocol.mjs';
import {
  canonicalJson, validateSyncManifest, encodeSyncManifest, syncManifestDigest,
  validateFileState, fileStateEqual, conflictId, unionVariants, validateSyncTransition,
  referencedBlobs, MAX_SYNC_ENTRIES, MAX_CONFLICT_VARIANTS, MAX_SYNC_PAGE_SIZE,
} from '../src/sync-protocol.mjs';
import { createSyncStore } from '../server/sync-store.mjs';

const fixtureParent = path.resolve('.test-tmp');
const state = (text, executable = false) => ({ hash: sha256(Buffer.from(text)), size: Buffer.byteLength(text), executable });
const file = (name, value) => ({ path: name, ...value });
const a = state('one'), b = state('two'), c = state('three'), d = state('base');
const manifest = (overrides = {}) => ({ version: 2, id: 'c1', projectId: 'project1', deviceId: 'device1', parentId: null, policyRevision: 0, files: [], tombstones: [], conflicts: [], archiveRefs: [], ...overrides });
const successor = (prior, overrides = {}) => ({ ...structuredClone(prior), id: `${prior.id}n`, parentId: prior.id, ...overrides });
const conflict = (projectId, name, base, main, variants) => ({ id: conflictId(projectId, name, base), path: name, base, main, variants: unionVariants(variants) });
const request = (value, revision = 0, overrides = {}) => ({ manifest: value, expectedHeadRevision: revision, expectedHeadId: value.parentId, requestId: `request-${value.id}`, ...overrides });
const status = code => error => error.status === code;
const hashJson = value => sha256(Buffer.from(canonicalJson(value)));
const paths = (directory, projectId) => {
  const project = path.join(directory, 'projects', sha256(Buffer.from(projectId)));
  return { project, head: path.join(project, 'head.json'), records: path.join(project, 'records'), manifests: path.join(project, 'manifests') };
};
async function fixture(t) {
  await fs.mkdir(fixtureParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtureParent, 'sync-v2-store-'));
  assert.equal(path.dirname(path.resolve(root)), fixtureParent);
  assert.match(path.basename(root), /^sync-v2-store-/);
  t.after(async () => {
    // Verify the exact owned synthetic directory before every recursive cleanup.
    assert.equal(path.dirname(path.resolve(root)), fixtureParent);
    assert.match(path.basename(root), /^sync-v2-store-/);
    const info = await fs.lstat(root); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    await fs.rm(root, { recursive: true, force: true });
    await assert.rejects(fs.lstat(root), error => error.code === 'ENOENT');
  });
  const directory = path.join(root, 'store'), blobs = new Map(), verified = [];
  let tail = Promise.resolve(), locked = false;
  function exclusive(task) {
    const result = tail.then(async () => { assert.equal(locked, false); locked = true; try { return await task(); } finally { locked = false; } });
    tail = result.catch(() => {}); return result;
  }
  function add(text, executable = false) { const value = state(text, executable); blobs.set(value.hash, Buffer.from(text)); return value; }
  for (const text of ['one', 'two', 'three', 'base']) add(text);
  async function verifyBlob(value) {
    verified.push(structuredClone(value));
    const bytes = blobs.get(value.hash);
    if (!bytes || bytes.length !== value.size || sha256(bytes) !== value.hash) throw Object.assign(new Error('Referenced blob failed verification'), { status: 409 });
  }
  const trusted = { authenticatedDeviceId: 'device1', beforeCommit: async () => { assert.equal(locked, true); } };
  const open = () => createSyncStore({ directory, exclusive, verifyBlob });
  return { root, directory, blobs, verified, exclusive, isLocked: () => locked, add, trusted, open, store: await open() };
}

test('v2 normalization is canonical, immutable to caller edits, and leaves v1 unchanged', () => {
  const source = manifest({ files: [file('z.txt', a), file('a.txt', b)], archiveRefs: [{ id: 'logs', hash: c.hash, size: c.size }] });
  const reordered = { ...source, files: [...source.files].reverse() };
  assert.equal(syncManifestDigest(source), syncManifestDigest(reordered));
  assert.deepEqual(JSON.parse(encodeSyncManifest(source)), validateSyncManifest(source));
  assert.equal(source.files[0].path, 'z.txt');
  const normalized = validateSyncManifest(source); normalized.files[0].size = 123;
  assert.equal(source.files[1].size, b.size);
  assert.deepEqual(validateFileState(null), null);
  assert.equal(fileStateEqual(a, { executable: false, size: a.size, hash: a.hash }), true);
  assert.equal(fileStateEqual(a, { ...a, executable: true }), false);
  assert.deepEqual(validateManifest({ version: 1, id: 'old', projectId: 'oldproject', deviceId: 'device1', parentId: null, createdAt: '2026-01-01T00:00:00.000Z', sourceRoot: 'C:\\synthetic', sessionIds: [], files: [] }).version, 1);
});

test('strict identifiers, state fields, protected paths and portable tree collisions', () => {
  for (const name of ['../escape', '/absolute', 'a\\b', 'NUL.txt', 'a.', 'e\u0301.txt', '\ud800', 'é'.repeat(128), '.git/config', '.dsh/state', 'safe/.dsh-syncignore', '.DSH-SYNCIGNORE', 'node_modules/x', '.env', 'nested/.env.prod', '.aws/config', 'private.key', 'auth.json']) {
    assert.throws(() => validateSyncManifest(manifest({ files: [file(name, a)] })), { status: 400 }, name);
  }
  for (const fields of [{ id: '__proto__' }, { id: '../x' }, { policyRevision: -1 }, { policyRevision: 1.5 }, { parentId: 'c1' }, { createdAt: 'not-allowed' }, { archiveRefs: [{ id: 'x', hash: a.hash, size: -1 }] }]) assert.throws(() => validateSyncManifest(manifest(fields)), { status: 400 });
  for (const value of [{ ...a, hash: a.hash.toUpperCase() }, { ...a, size: 64 * 1024 * 1024 + 1 }, { ...a, size: NaN }, { hash: a.hash, size: a.size }, { ...a, sha256: a.hash }]) assert.throws(() => validateFileState(value), { status: 400 });
  for (const files of [[file('same', a), file('SAME', b)], [file('folder', a), file('folder/child', b)], [file('Folder/a', a), file('folder/b', b)], [file('first', a), file('second', { ...a, size: a.size + 1 })]]) assert.throws(() => validateSyncManifest(manifest({ files })), { status: 400 });
  assert.throws(() => validateSyncManifest(manifest({ tombstones: [{ path: 'a', prior: null }] })), /prior file/);
  assert.throws(() => validateSyncManifest(manifest({ files: [file('x', a)], tombstones: [{ path: 'X', prior: b }] })), /collision/);
});

test('optional display label is normalized, hashed, and not silently discarded', () => {
  const labeled = manifest({ label: '  Synthetic project  ' });
  assert.equal(validateSyncManifest(labeled).label, 'Synthetic project');
  assert.notEqual(syncManifestDigest(labeled), syncManifestDigest(manifest()));
  const normalized = validateSyncManifest(labeled), next = successor(normalized);
  validateSyncTransition(normalized, next);
  delete next.label;
  assert.throws(() => validateSyncTransition(normalized, next), /silently omitted/);
  for (const label of ['', ' ', 'x'.repeat(201), 'line\nfeed', '\ud800', 'e\u0301', '\u202Ehidden']) assert.throws(() => validateSyncManifest(manifest({ label })), /project label/);
});

test('combined live, tombstone, conflict and archive quotas fail closed', () => {
  assert.throws(() => validateSyncManifest(manifest({ files: new Array(2) })), /Invalid JSON object/);
  assert.throws(() => validateSyncManifest(manifest({ files: Array(MAX_SYNC_ENTRIES + 1).fill(file('x', a)) })), /Too many files/);
  assert.throws(() => validateSyncManifest(manifest({ files: Array.from({ length: 17 }, (_, index) => file(`large-${index}`, { ...state(`hash-${index}`), size: 64 * 1024 * 1024 })) })), /blob byte limit/);
  assert.throws(() => validateSyncManifest(manifest({ files: Array(MAX_SYNC_ENTRIES).fill(file('x', a)), tombstones: [{ path: 'old', prior: a }] })), /entry limit/);
  assert.throws(() => unionVariants(Array(MAX_CONFLICT_VARIANTS + 1).fill(a)), /Too many conflict variants/);
  assert.throws(() => validateSyncManifest(manifest({ conflicts: [{ id: conflictId('project1', 'x', a), path: 'x', base: a, main: null, variants: [null, null] }] })), /distinct variants/);
});

test('conflict stable ids and deduplicated union preserve active main until explicit resolution', () => {
  const initial = manifest({ files: [file('x', a)] });
  const active = successor(initial, { conflicts: [conflict('project1', 'x', d, a, [a, b, b])] });
  assert.equal(active.conflicts[0].id, conflictId('project1', 'x', d));
  assert.equal(active.conflicts[0].variants.length, 2);
  validateSyncTransition(initial, active);
  const expanded = successor(active, { conflicts: [conflict('project1', 'x', d, a, [null, b, a, c])] });
  validateSyncTransition(active, expanded);
  assert.equal(expanded.conflicts[0].id, active.conflicts[0].id);
  assert.throws(() => validateSyncTransition(expanded, successor(expanded, { conflicts: [] })), /cannot be removed/);
  assert.throws(() => validateSyncTransition(expanded, successor(expanded, { conflicts: [active.conflicts[0]] })), /deduplicated union/);
  assert.throws(() => validateSyncTransition(active, successor(active, { files: [file('x', b)], conflicts: [conflict('project1', 'x', d, b, [a, b])] })), /main cannot change/);
  const resolved = successor(expanded, { files: [file('x', c)], conflicts: [] });
  validateSyncTransition(expanded, resolved, { resolutions: [{ conflictId: active.conflicts[0].id, state: c }] });
  assert.throws(() => validateSyncTransition(expanded, resolved, { resolutions: [{ conflictId: active.conflicts[0].id, state: b }] }), /resulting live state/);
  assert.throws(() => validateSyncTransition(expanded, resolved, { resolutions: [{ conflictId: sha256(Buffer.from('missing')), state: c }] }), /unknown conflict/);
  assert.throws(() => validateSyncManifest({ ...active, conflicts: [{ ...active.conflicts[0], id: a.hash }] }), /stable conflict identifier/);
  assert.throws(() => validateSyncManifest({ ...active, conflicts: [{ ...active.conflicts[0], main: b }] }), /live file state/);
});

test('tracked deletions require prior refs; tombstones survive recreation and tree changes', () => {
  const initial = manifest({ files: [file('tree', a)] });
  assert.throws(() => validateSyncTransition(initial, successor(initial, { files: [] })), /explicit tombstone/);
  assert.throws(() => validateSyncTransition(initial, successor(initial, { files: [], tombstones: [{ path: 'tree', prior: b }] })), /matching its prior/);
  const deleted = successor(initial, { files: [], tombstones: [{ path: 'tree', prior: a }] });
  validateSyncTransition(initial, deleted);
  assert.throws(() => validateSyncTransition(deleted, successor(deleted, { tombstones: [] })), /cannot be removed/);
  const recreated = successor(deleted, { files: [file('tree', b)] });
  validateSyncTransition(deleted, recreated);
  const again = successor(recreated, { files: [], tombstones: [{ path: 'tree', prior: b }] });
  validateSyncTransition(recreated, again);
  assert.throws(() => validateSyncTransition(deleted, successor(deleted, { tombstones: [{ path: 'tree', prior: b }] })), /only on a new tracked deletion/);
  validateSyncTransition(deleted, successor(deleted, { files: [file('tree/child', b)] }));
  const deleteEdit = successor(deleted, { files: [file('tree', b)], conflicts: [conflict('project1', 'tree', a, b, [b, null])] });
  validateSyncTransition(deleted, deleteEdit);
  assert.throws(() => validateSyncTransition(null, manifest({ tombstones: [{ path: 'x', prior: a }] })), /historical tombstones/);
  assert.throws(() => validateSyncTransition(deleted, successor(deleted, { tombstones: [...deleted.tombstones, { path: 'never-tracked', prior: b }] })), /tracked prior deletion/);
});

test('all preserved blob states and immutable archive refs are included', () => {
  const old = manifest({ files: [file('x', a), file('deleted', c)], archiveRefs: [{ id: 'logs', hash: b.hash, size: b.size }] });
  const next = successor(old, { files: [file('x', a)], tombstones: [{ path: 'deleted', prior: c }], conflicts: [conflict('project1', 'x', d, a, [a, b, null])] });
  validateSyncTransition(old, next);
  assert.deepEqual(new Set(referencedBlobs(next).map(item => item.hash)), new Set([a.hash, b.hash, c.hash, d.hash]));
  assert.throws(() => validateSyncTransition(old, successor(old, { archiveRefs: [] })), /Archive references are immutable/);
  assert.throws(() => validateSyncTransition(old, successor(old, { archiveRefs: [{ id: 'logs', hash: c.hash, size: c.size }] })), /Archive references are immutable/);
});

test('store immutable commit, authenticated binding, direct reads and verified reopen', async t => {
  const h = await fixture(t), initial = manifest({ files: [file('x', a)] });
  assert.equal(await h.store.head('project1'), null);
  assert.equal(await h.store.receipt('project1', 'missing'), null);
  await assert.rejects(h.store.commit(request(initial), { ...h.trusted, authenticatedDeviceId: 'other' }), status(403));
  await assert.rejects(h.store.commit(request(initial), { authenticatedDeviceId: 'device1' }), /beforeCommit/);
  await assert.rejects(h.store.commit(request(initial), { ...h.trusted, beforeCommit: () => false }), status(401));
  const result = await h.store.commit(request(initial), h.trusted);
  assert.equal(result.revision, 1); assert.equal(result.manifestDigest, syncManifestDigest(initial));
  assert.deepEqual(await h.store.head('project1'), { projectId: 'project1', id: 'c1', revision: 1, manifestDigest: result.manifestDigest, recordHash: result.recordHash });
  assert.deepEqual(await h.store.getCheckpoint('project1', 'c1'), validateSyncManifest(initial));
  const returned = await h.store.getCheckpoint('project1', 'c1'); returned.files.length = 0;
  assert.equal((await h.store.getCheckpoint('project1', 'c1')).files.length, 1);
  await assert.rejects(h.store.getCheckpoint('project1', 'not-committed'), status(404));
  await assert.rejects(h.store.commit(request({ ...initial, files: [file('x', b)] }, 1, { expectedHeadId: 'c1', requestId: 'different' }), h.trusted), status(409));
  const layout = paths(h.directory, 'project1'), names = await fs.readdir(layout.manifests);
  assert.deepEqual(names, [`${sha256(Buffer.from('c1'))}-${result.manifestDigest}.json`]);
  assert.deepEqual(await fs.readdir(layout.records), [`${result.recordHash}.json`]);
  const reopened = await h.open();
  assert.deepEqual(await reopened.receipt('project1', request(initial).requestId), result);
  assert.equal((await reopened.list()).projects.length, 1);
});

test('all reference kinds are verified and missing or corrupted blobs cannot commit', async t => {
  const h = await fixture(t);
  const initial = manifest({ files: [file('x', a), file('deleted', c)] });
  await h.store.commit(request(initial), h.trusted);
  const next = successor(initial, { files: [file('x', a)], tombstones: [{ path: 'deleted', prior: c }], conflicts: [conflict('project1', 'x', d, a, [a, b, null])], archiveRefs: [{ id: 'logs', hash: h.add('archived log').hash, size: Buffer.byteLength('archived log') }] });
  h.verified.length = 0;
  await h.store.commit(request(next, 1), h.trusted);
  assert.deepEqual(new Set(h.verified.map(item => item.hash)), new Set(referencedBlobs(next).map(item => item.hash)));
  const missing = manifest({ projectId: 'missing-project', files: [file('x', state('absent'))] });
  await assert.rejects(h.store.commit(request(missing), h.trusted), status(409));
  assert.equal(await h.store.head('missing-project'), null);
  h.blobs.set(a.hash, Buffer.from('bad'));
  await assert.rejects(h.store.commit(request(manifest({ projectId: 'bad-project', files: [file('x', a)] })), h.trusted), status(409));
  assert.equal(await h.store.head('bad-project'), null);
});

test('CAS includes head id and revision; concurrent writes serialize through parent callback', async t => {
  const h = await fixture(t), initial = manifest();
  await h.store.commit(request(initial), h.trusted);
  const second = successor(initial, { id: 'second' }), third = successor(initial, { id: 'third' });
  await assert.rejects(h.store.commit(request(second, 0, { expectedHeadId: null }), h.trusted), status(409));
  await assert.rejects(h.store.commit(request(second, 1, { expectedHeadId: 'wrong-head' }), h.trusted), status(409));
  const results = await Promise.allSettled([h.store.commit(request(second, 1), h.trusted), h.store.commit(request(third, 1), h.trusted)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'SYNC_HEAD_MISMATCH');
  assert.equal((await h.store.head('project1')).revision, 2);
  await assert.rejects(h.store.commit({ ...request(successor(second), 2), expectedRevision: 3 }, h.trusted), /Conflicting expected revision/);
});

test('same-digest request replay returns original receipt after head advances and reopening', async t => {
  const h = await fixture(t), initial = manifest({ files: [file('b', b), file('a', a)] }), firstRequest = request(initial);
  // Simulate a successfully committed response lost before reaching the caller.
  const acknowledgment = await h.store.commit(firstRequest, h.trusted);
  const later = successor(initial, { id: 'later' }); await h.store.commit(request(later, 1), h.trusted);
  const replay = { ...firstRequest, manifest: { ...initial, files: [...initial.files].reverse() } };
  delete replay.expectedHeadRevision; replay.expectedRevision = 0;
  assert.deepEqual(await h.store.commit(replay, h.trusted), acknowledgment);
  assert.deepEqual(await h.store.receipt('project1', firstRequest.requestId), acknowledgment);
  await assert.rejects(h.store.commit({ ...firstRequest, manifest: { ...initial, policyRevision: 1 } }, h.trusted), /different committed content/);
  await assert.rejects(h.store.commit(firstRequest, { ...h.trusted, beforeCommit: () => { throw Object.assign(new Error('revoked'), { status: 401 }); } }), status(401));
  const reopened = await h.open(); assert.deepEqual(await reopened.commit(firstRequest, h.trusted), acknowledgment);
  assert.equal((await reopened.head('project1')).id, 'later');
});

test('failed final auth check leaves only immutable orphan files; retry is safe', async t => {
  const h = await fixture(t), initial = manifest({ files: [file('x', a)] });
  let calls = 0;
  await assert.rejects(h.store.commit(request(initial), { ...h.trusted, beforeCommit: () => { assert.equal(h.isLocked(), true); if (++calls === 2) throw Object.assign(new Error('expired'), { status: 401 }); } }), status(401));
  assert.equal(await h.store.head('project1'), null);
  assert.deepEqual(await h.store.list(), { projects: [], nextCursor: null });
  assert.equal(await h.store.receipt('project1', request(initial).requestId), null);
  const location = paths(h.directory, 'project1');
  assert.equal((await fs.readdir(location.manifests)).length, 1);
  assert.equal((await fs.readdir(location.records)).length, 1);
  const reopened = await h.open(); assert.equal((await reopened.list()).projects.length, 0);
  const result = await reopened.commit(request(initial), h.trusted);
  assert.equal(result.revision, 1);
  assert.equal((await fs.readdir(location.manifests)).length, 1);
  assert.equal((await fs.readdir(location.records)).length, 1);
});

test('orphan same-revision branch is never indexed and never garbage-collected', async t => {
  const h = await fixture(t), abandoned = manifest({ id: 'abandoned', files: [file('x', a)] });
  let calls = 0;
  await assert.rejects(h.store.commit(request(abandoned), { ...h.trusted, beforeCommit: () => { if (++calls === 2) throw new Error('synthetic interruption before head'); } }), /synthetic interruption/);
  const committed = manifest({ id: 'committed', files: [file('x', b)] });
  await h.store.commit(request(committed), h.trusted);
  const reopened = await h.open(), location = paths(h.directory, 'project1');
  assert.equal((await fs.readdir(location.manifests)).length, 2);
  assert.equal((await fs.readdir(location.records)).length, 2);
  assert.deepEqual((await reopened.changes('project1')).changes.map(item => item.id), ['committed']);
  assert.equal(await reopened.receipt('project1', request(abandoned).requestId), null);
  await assert.rejects(reopened.getCheckpoint('project1', 'abandoned'), status(404));
});

test('uncommitted orphans do not reserve checkpoint or request identities', async t => {
  const h = await fixture(t), initial = manifest({ files: [file('x', a)] }); let calls = 0;
  await assert.rejects(h.store.commit(request(initial), { ...h.trusted, beforeCommit: () => { if (++calls === 2) throw new Error('uncommitted'); } }), /uncommitted/);
  const changed = { ...initial, files: [file('x', b)] };
  const committed = await h.store.commit(request(changed), h.trusted);
  assert.equal(committed.revision, 1);
  assert.equal((await fs.readdir(paths(h.directory, 'project1').manifests)).length, 2);
  const reopened = await h.open();
  assert.deepEqual(await reopened.getCheckpoint('project1', 'c1'), validateSyncManifest(changed));
  assert.equal((await reopened.changes('project1')).changes.length, 1);
});

test('migration compares complete legacy head set in shared lock and persists provenance/fence', async t => {
  const h = await fixture(t), initial = manifest({ files: [file('x', a)] });
  let currentLegacyHeads = ['old-b', 'old-a'], checks = 0;
  const trusted = { ...h.trusted, checkLegacyHeads: async (projectId, expected) => { assert.equal(h.isLocked(), true); assert.equal(projectId, 'project1'); assert.ok(Array.isArray(expected)); checks++; return currentLegacyHeads; } };
  await assert.rejects(h.store.migrate({ ...request(initial), expectedLegacyHeads: ['old-a'] }, trusted), error => error.code === 'SYNC_LEGACY_HEAD_MISMATCH');
  assert.equal(await h.store.head('project1'), null);
  const migrationRequest = { ...request(initial), expectedLegacyHeads: ['old-b', 'old-a'] };
  const migrated = await h.store.migrate(migrationRequest, trusted);
  const history = await h.store.changes('project1');
  assert.deepEqual(history.changes[0].migration, { legacyHeads: ['old-a', 'old-b'] });
  await h.exclusive(async () => { assert.ok(await h.store.head('project1')); /* parent rejects v1 writes here */ });
  const next = successor(initial); await h.store.commit(request(next, 1), h.trusted);
  currentLegacyHeads = ['changed']; const oldChecks = checks;
  assert.deepEqual(await h.store.migrate(migrationRequest, trusted), migrated); assert.equal(checks, oldChecks);
  assert.deepEqual((await (await h.open()).changes('project1')).changes[0].migration, history.changes[0].migration);
  await assert.rejects(h.store.migrate({ ...request(manifest({ projectId: 'second' })), expectedLegacyHeads: [] }, trusted), /complete legacy head/);
  await assert.rejects(h.store.migrate({ ...migrationRequest, manifest: { ...initial, id: 'other' }, requestId: 'other-request' }, trusted), status(409));
});

test('legacy writes queued before migration invalidate expected heads; queued after see atomic fence', async t => {
  const h = await fixture(t), initial = manifest(); let heads = ['legacy-a'];
  const legacyWrite = h.exclusive(async () => { heads = ['legacy-b']; });
  const failedMigration = h.store.migrate({ ...request(initial), expectedLegacyHeads: ['legacy-a'] }, { ...h.trusted, checkLegacyHeads: () => heads });
  await legacyWrite; await assert.rejects(failedMigration, /legacy head set changed/);
  const migration = h.store.migrate({ ...request(initial), expectedLegacyHeads: ['legacy-b'] }, { ...h.trusted, checkLegacyHeads: () => heads });
  const blockedLegacyWrite = h.exclusive(async () => { assert.notEqual(await h.store.head('project1'), null); return 'fenced'; });
  await migration; assert.equal(await blockedLegacyWrite, 'fenced');
});

test('history pagination is bounded and pinned to untilRevision while head advances', async t => {
  const h = await fixture(t); let current = manifest();
  await h.store.commit(request(current), h.trusted);
  for (let number = 2; number <= 5; number++) { current = successor(current, { id: `c${number}` }); await h.store.commit(request(current, number - 1), h.trusted); }
  const first = await h.store.changes('project1', { limit: 2 });
  assert.deepEqual(first.changes.map(item => item.revision), [1, 2]); assert.equal(first.untilRevision, 5); assert.equal(first.nextAfterRevision, 2);
  current = successor(current, { id: 'c6' }); await h.store.commit(request(current, 5), h.trusted);
  const second = await h.store.changes('project1', { afterRevision: first.nextAfterRevision, untilRevision: first.untilRevision, limit: 2 });
  const third = await h.store.changes('project1', { afterRevision: second.nextAfterRevision, untilRevision: first.untilRevision, limit: 2 });
  assert.deepEqual([...first.changes, ...second.changes, ...third.changes].map(item => item.revision), [1, 2, 3, 4, 5]); assert.equal(third.nextAfterRevision, null);
  await assert.rejects(h.store.changes('project1', { untilRevision: 7 }), /range/);
  await assert.rejects(h.store.changes('project1', { limit: MAX_SYNC_PAGE_SIZE + 1 }), /page limit/);
  await assert.rejects(h.store.changes('project1', { afterRevision: -1 }), /after revision/);
  assert.deepEqual(await h.store.changes('missing'), { changes: [], untilRevision: 0, nextAfterRevision: null });
});

test('project pages have stable key cursor, shared checkpoint IDs are per-project', async t => {
  const h = await fixture(t);
  for (const projectId of ['project1', 'project2', 'project3', 'project4', 'project5']) await h.store.commit(request(manifest({ projectId })), h.trusted);
  const seen = []; let cursor = null;
  do {
    const page = await h.store.list({ limit: 2, cursor }); seen.push(...page.projects.map(item => item.projectId)); cursor = page.nextCursor;
    assert.ok(page.projects.length <= 2);
  } while (cursor !== null);
  assert.equal(seen.length, 5); assert.equal(new Set(seen).size, 5);
  await assert.rejects(h.store.list({ cursor: 'not-a-cursor' }), status(400));
  await assert.rejects(h.store.list({ limit: 0 }), status(400));
  assert.equal((await h.store.getCheckpoint('project5', 'c1')).projectId, 'project5');
});

test('manifest hash corruption fails only the affected project closed, healthy projects remain visible', async t => {
  const h = await fixture(t);
  const bad = await h.store.commit(request(manifest({ files: [file('x', a)] })), h.trusted);
  await h.store.commit(request(manifest({ projectId: 'healthy' })), h.trusted);
  const location = paths(h.directory, 'project1');
  const filename = path.join(location.manifests, `${sha256(Buffer.from('c1'))}-${bad.manifestDigest}.json`);
  await fs.writeFile(filename, canonicalJson(manifest({ files: [file('x', b)] })));
  await assert.rejects(h.store.getCheckpoint('project1', 'c1'), error => error.code === 'SYNC_PROJECT_CORRUPT');
  await assert.rejects(h.store.head('project1'), status(500));
  const reopened = await h.open();
  await assert.rejects(reopened.head('project1'), status(500));
  const page = await reopened.list(); assert.equal(page.projects.length, 2); assert.equal(page.projects.filter(item => item.corrupt).length, 1);
  assert.ok(page.projects.some(item => item.projectId === 'healthy' && item.id === 'c1'));
  assert.equal((await reopened.head('healthy')).revision, 1);
});

test('record hash corruption, missing chain members and malformed pointer are detected', async t => {
  for (const mode of ['record', 'missing', 'head']) await t.test(mode, async sub => {
    const h = await fixture(sub), initial = manifest(), first = await h.store.commit(request(initial), h.trusted);
    await h.store.commit(request(successor(initial), 1), h.trusted);
    const location = paths(h.directory, 'project1');
    if (mode === 'record') await fs.appendFile(path.join(location.records, `${first.recordHash}.json`), ' ');
    if (mode === 'missing') await fs.unlink(path.join(location.records, `${first.recordHash}.json`));
    if (mode === 'head') await fs.writeFile(location.head, '{"broken":true}');
    const reopened = await h.open();
    await assert.rejects(reopened.head('project1'), status(500));
    await assert.rejects(reopened.commit(request(manifest({ id: 'reset' })), h.trusted), status(500));
  });
});

test('verified hash-linked record cannot introduce checkpoint-id cycle', async t => {
  const h = await fixture(t), initial = manifest(), second = successor(initial, { id: 'c2' });
  await h.store.commit(request(initial), h.trusted); const previous = await h.store.commit(request(second, 1), h.trusted);
  // Forge fully hashed/canonical disk data for c1 -> c2 -> c1. Immutable checkpoint
  // identity, not just predecessor hashes/revision arithmetic, must reject the cycle.
  const cycling = successor(second, { id: 'c1' }), manifestDigest = syncManifestDigest(cycling), requestId = 'forged-cycle';
  const body = { manifest: cycling, expectedHeadRevision: 2, expectedHeadId: 'c2', requestId, resolutions: [], migration: null };
  const record = { version: 2, projectId: 'project1', revision: 3, id: 'c1', manifestDigest, previousRecordHash: previous.recordHash, requestId, requestDigest: hashJson(body), expectedHeadRevision: 2, expectedHeadId: 'c2', resolutions: [], migration: null };
  const recordHash = hashJson(record), location = paths(h.directory, 'project1');
  await fs.writeFile(path.join(location.manifests, `${sha256(Buffer.from('c1'))}-${manifestDigest}.json`), encodeSyncManifest(cycling));
  await fs.writeFile(path.join(location.records, `${recordHash}.json`), canonicalJson(record));
  await fs.writeFile(location.head, canonicalJson({ version: 2, projectId: 'project1', id: 'c1', revision: 3, manifestDigest, recordHash }));
  const reopened = await h.open(); await assert.rejects(reopened.head('project1'), status(500));
});

test('reopening checks historical blob refs and rejects a symlinked storage project', async t => {
  const h = await fixture(t), initial = manifest({ files: [file('x', a)] });
  await h.store.commit(request(initial), h.trusted);
  const deleted = successor(initial, { files: [], tombstones: [{ path: 'x', prior: a }] }); await h.store.commit(request(deleted, 1), h.trusted);
  h.blobs.delete(a.hash);
  await assert.rejects((await h.open()).head('project1'), status(500));
  const linkProject = 'linked-project', linkPath = paths(h.directory, linkProject).project, elsewhere = path.join(h.root, 'elsewhere');
  await fs.mkdir(elsewhere);
  try { await fs.symlink(elsewhere, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Synthetic link creation unavailable; blob integrity still checked'); return; } throw error; }
  try { await assert.rejects((await h.open()).head(linkProject), status(500)); }
  finally {
    // Remove our known junction before its target: Windows recursive rm can leave
    // a dangling junction behind if target and link are sibling fixture trees.
    assert.equal(path.dirname(path.dirname(linkPath)), h.directory);
    const info = await fs.lstat(linkPath);
    assert.ok(info.isSymbolicLink() || (process.platform === 'win32' && info.isDirectory()));
    if (process.platform === 'win32') await fs.rmdir(linkPath); else await fs.unlink(linkPath);
  }
});
