import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDshAdapter } from '../plugin/dsh-adapter.mjs';
import { createSessionSync, SESSION_ARCHIVE_FORMAT } from '../plugin/session-sync.mjs';
import { LocalStore } from '../src/local-store.mjs';
import { scanSyncProject } from '../src/sync-local.mjs';
import { sha256 } from '../src/protocol.mjs';
import { canonicalJson, validateSyncManifest, referencedBlobs } from '../src/sync-protocol.mjs';

// Synthetic native service mocks + the REAL immutable file hash spool. No installed
// runtime/profile, credentials, real session, agent, or model execution is used.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempParent = path.join(repo, '.test-tmp');
const identity = { server: 'http://127.0.0.1:19871', serverId: 'synthetic-server', username: 'alice', deviceId: 'device-a', authorizationEpoch: 1 };
const known = new Set(['turn/start', 'turn/end', 'user/message', 'deliverables/presented', 'goal/change']);
const copy = value => structuredClone(value);
function mockSdk() {
  return { knownEventTypes: known, validateAssistantStreams() {}, catalog: {
    currentVersion: 4, encodeCurrentHeader: (header, cut) => ({ ...copy(header), cut }), encodeCurrentEvent: copy,
    createRestore(header, options) {
      assert.deepEqual(options, { recovery: 'strict', validation: 'current' }); const events = [];
      return { decodeRow(event) { assert.equal(event.seq, events.length); assert.ok(known.has(event.type) || event.ignorable === true); events.push(copy(event)); }, finish() { const { cut, ...logical } = header; return { header: logical, inheritedEventCount: cut, events }; } };
    },
  } };
}
const events = () => [
  { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, time: 1001, type: 'user/message', surfaceOp: 'append', data: { id: 'message-a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Archive synthetic data, not credentials.' }] } },
  { seq: 2, time: 1002, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
function nativeFixture(root, options = {}) {
  const records = new Map(), assets = new Map(options.assets ?? []), writes = [], created = [], handleStates = [];
  if (!options.empty) records.set('source-session', { header: { version: 4, id: 'source-session', createdAt: 1000, cwd: root, isSeeded: false, delegationDepth: 0 }, events: options.events ?? events(), inheritedEventCount: 0, revision: 'source-1', sizeBytes: 500 });
  const services = {
    sessions: { list: () => [], get: () => undefined, flush: async () => {}, create() { assert.fail('NO live session creation'); } },
    agents: { get: () => options.active ? { status: 'running' } : undefined, create() { assert.fail('NO agent creation'); }, resume() { assert.fail('NO agent resume'); } },
    attachments: {
      async readImage(ref) { return { data: assets.get(ref.attachmentId.slice(7)) }; },
      async *readFileStream(ref) { const bytes = assets.get(ref.attachmentId.slice(7)); assert.ok(bytes, 'synthetic missing asset'); yield bytes; },
      async saveFile({ data, name }) { await options.beforeNativeWrite?.(); writes.push('attachment'); const hash = sha256(data); assets.set(hash, Buffer.from(data)); return { attachmentId: `sha256:${hash}`, bytes: data.length, name }; },
      async saveImage({ data, mediaType, name }) { await options.beforeNativeWrite?.(); writes.push('attachment'); const hash = sha256(data); assets.set(hash, Buffer.from(data)); return { attachmentId: `sha256:${hash}`, bytes: data.length, mediaType, width: 2, height: 2, ...(name ? { name } : {}) }; },
    },
    sessionPersistence: {
      async list() { return [...records.values()].map(item => ({ header: copy(item.header), revision: item.revision, sizeBytes: item.sizeBytes })); },
      async stat(id) { const item = records.get(id); return item && { header: copy(item.header), revision: item.revision, sizeBytes: item.sizeBytes }; },
      async open(id, access) { assert.equal(access, 'read'); const item = records.get(id), state = { closed: false }; handleStates.push(state); return { header: copy(item.header), inheritedEventCount: item.inheritedEventCount, read: async () => ({ events: copy(item.events) }), close: async () => { state.closed = true; } }; },
      async create(header, creation) {
        await options.beforeNativeWrite?.(); assert.ok(!records.has(header.id)); writes.push('create');
        const item = { header: copy(header), inheritedEventCount: creation.inheritedEventCount, events: [], revision: 'new', sizeBytes: undefined };
        records.set(header.id, item); created.push(item);
        if (options.createRejectsAfterRegistration) throw new Error('synthetic unknown provider result');
        const state = { closed: false }; handleStates.push(state);
        return { async append(batch) { item.events.push(...copy(batch)); if (options.appendRejects) throw new Error('synthetic partial append'); }, async flush() { item.sizeBytes = 500; item.revision = 'flushed'; }, async close() { state.closed = true; if (options.closeRejects) throw new Error('synthetic close failure'); } };
      },
    },
    workspaceRegistry: { async create(directory) { writes.push('workspace'); assert.equal(directory, root); return { id: 'synthetic-workspace', async attachSession(id) { assert.ok(records.has(id)); await options.onAttached?.(records.get(id)); } }; } },
  };
  return { records, assets, writes, created, handleStates, services, ctx: { get: name => services[name], waterfall: async (_event, _payload, next) => next() } };
}
async function fixture(t, options = {}) {
  await fs.mkdir(tempParent, { recursive: true }); const base = await fs.mkdtemp(path.join(tempParent, 'session-sync-owned-'));
  t.after(async () => {
    const target = path.resolve(base);
    assert.equal(path.dirname(target), tempParent); assert.ok(path.basename(target).startsWith('session-sync-owned-'));
    assert.equal(await fs.realpath(target), target); // Verify exactly this unique owned fixture before cleanup.
    await fs.rm(target, { recursive: true, force: true });
  });
  const source = path.join(base, 'source'), root = path.join(base, 'target'), stateDir = path.join(base, 'state');
  await fs.mkdir(source); await fs.mkdir(root);
  const store = await new LocalStore(path.join(base, 'blob-spool')).init();
  const sourceNative = nativeFixture(source, options), targetNative = nativeFixture(root, { empty: true, ...options.target });
  const adapter = createDshAdapter({ loadSdk: async () => mockSdk() });
  const producer = createSessionSync({ ctx: sourceNative.ctx, stateDir: path.join(base, 'producer-state'), identity, adapter });
  const consumer = createSessionSync({ ctx: targetNative.ctx, stateDir, identity, adapter });
  const client = { async downloadBlob(hash, size) { const bytes = await store.getBlob(hash); assert.equal(bytes.length, size); return bytes; } };
  const files = [];
  async function file(name, bytes = Buffer.from('deliverable')) {
    bytes = Buffer.from(bytes); const sourceFile = path.join(source, name), targetFile = path.join(root, name);
    await fs.mkdir(path.dirname(sourceFile), { recursive: true }); await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(sourceFile, bytes); await fs.writeFile(targetFile, bytes); await store.putBlob(sha256(bytes), bytes);
    const value = { path: name.split(path.sep).join('/'), hash: sha256(bytes), size: bytes.length, executable: false }; files.push(value); return value;
  }
  async function capture(extra = {}) {
    const put = new Set(); const result = await producer.captureArchives({ root: source, projectId: 'project-a', deviceId: identity.deviceId, files, putBlob: async (hash, bytes) => { put.add(hash); await store.putBlob(hash, bytes); }, ...extra });
    for (const ref of result.archiveRefs) assert.ok(put.has(ref.hash), 'every returned reference was staged this invocation');
    const manifest = validateSyncManifest({ version: 2, id: 'checkpoint-a', projectId: 'project-a', deviceId: identity.deviceId, parentId: null, policyRevision: 1, files, tombstones: [], conflicts: [], archiveRefs: result.archiveRefs });
    return { result, manifest, archiveId: manifest.archiveRefs.find(item => item.id.startsWith('session-'))?.id };
  }
  async function prepare(archive, extra = {}) { return consumer.prepareImport({ root, projectId: 'project-a', manifest: archive.manifest, archiveId: archive.archiveId, identity, client, ...extra }); }
  async function importPlan(plan, extra = {}) { return consumer.importArchive({ plan, requestId: 'request-a', identity, ...extra }); }
  return { base, source, root, stateDir, store, sourceNative, targetNative, producer, consumer, adapter, client, files, file, capture, prepare, importPlan };
}
function withFileAsset(log = events()) {
  const bytes = Buffer.from('synthetic file asset'), hash = sha256(bytes);
  log[1].data.content.push({ type: 'file', attachment: { attachmentId: `sha256:${hash}`, bytes: bytes.length, name: 'input.txt' } });
  return { events: log, assets: [[hash, bytes]], assetHash: hash };
}
async function ledgerFiles(stateDir) {
  const result = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) await walk(target); else if (path.basename(directory) === 'imports' && entry.name.endsWith('.json')) result.push(target); }
  }
  await walk(stateDir); return result;
}

test('automatic capture stages closed deterministic wrappers, provider assets and pinned deliverables', async t => {
  const options = withFileAsset(); options.events.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { files: [{ path: 'reports/result.txt' }] } });
  const f = await fixture(t, options); await f.file('reports/result.txt');
  const a = await f.capture(), b = await f.capture(); assert.deepEqual(a.manifest.archiveRefs, b.manifest.archiveRefs);
  assert.equal(a.manifest.archiveRefs.length, 3);
  for (const ref of referencedBlobs(a.manifest)) { const bytes = await f.store.getBlob(ref.hash); assert.equal(bytes.length, ref.size); }
  for (const ref of a.manifest.archiveRefs) { assert.ok(ref.id.length <= 100); assert.equal(ref.id, `${ref.id.startsWith('session-') ? 'session' : 'asset'}-${ref.hash}`); }
  const wrapper = JSON.parse((await f.store.getBlob(a.archiveId.slice(8))).toString());
  assert.equal(wrapper.format, SESSION_ARCHIVE_FORMAT); assert.equal(wrapper.projectId, 'project-a'); assert.equal(wrapper.origin.sourceRoot, f.source); assert.equal(wrapper.files[0].path, 'reports/result.txt');
  assert.equal(f.sourceNative.writes.length, 0); assert.ok(f.sourceNative.handleStates.every(item => item.closed));
});

test('streaming native export does not retain the asset/session arrays and calls its guards', async t => {
  const f = await fixture(t, withFileAsset()); let assets = 0, sessions = 0, checked = 0;
  const result = await f.adapter.exportProjectSessions(f.sourceNative.ctx, f.source, { onAsset: async bytes => { assert.ok(Buffer.isBuffer(bytes)); assets++; }, onSession: async item => { assert.equal(item.id, 'source-session'); sessions++; }, check: async () => { checked++; } });
  assert.deepEqual(result.assets, []); assert.deepEqual(result.sessions, []); assert.equal(assets, 1); assert.equal(sessions, 1); await result.verifyUnchanged(); assert.ok(checked > 3);
});

test('explicit safe import stages only in plugin cache, remaps new identity and never starts an agent', async t => {
  const f = await fixture(t, withFileAsset()), archive = await f.capture();
  const plan = await f.prepare(archive); assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.counts)); assert.equal(plan.counts.assets, 1); assert.deepEqual(await fs.readdir(f.root), []); assert.deepEqual(f.targetNative.writes, []);
  assert.deepEqual((await f.consumer.listArchives({ root: f.root, projectId: 'project-a', identity }, { manifest: archive.manifest, client: f.client })).archives[0].eligibility, 'unchecked');
  const imported = await f.importPlan(plan); assert.equal(imported.state, 'imported'); assert.equal(imported.sessionIds.length, 1); assert.notEqual(imported.sessionIds[0], 'source-session');
  assert.equal(f.targetNative.created[0].header.cwd, f.root); assert.equal(f.targetNative.created[0].header.parentSession, undefined); assert.deepEqual(await fs.readdir(f.root), []);
  assert.ok(f.targetNative.handleStates.every(item => item.closed)); assert.equal((await f.consumer.listArchives({ root: f.root, projectId: 'project-a', identity }, { manifest: archive.manifest, client: f.client })).counts.imported, 1);
  const row = JSON.parse(await fs.readFile((await ledgerFiles(f.stateDir))[0], 'utf8')); assert.match(row.localFingerprint, /^[a-f0-9]{64}$/);
});

test('canonical wrapper member ordering does not weaken or falsely reject exact native resource mappings', async t => {
  const f = await fixture(t, withFileAsset()), archive = await f.capture(), sdk = mockSdk();
  sdk.catalog.encodeCurrentEvent = event => {
    const value = copy(event);
    for (const block of value.data?.content ?? []) if (block.attachment) block.attachment = Object.fromEntries(Object.entries(block.attachment).reverse());
    return value;
  };
  const consumer = createSessionSync({ ctx: f.targetNative.ctx, stateDir: f.stateDir, identity, adapter: createDshAdapter({ loadSdk: async () => sdk }) });
  const plan = await consumer.prepareImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, manifest: archive.manifest, client: f.client, identity });
  const result = await consumer.importArchive({ plan, requestId: 'canonical-order', identity }); assert.equal(result.state, 'imported'); assert.equal(f.targetNative.created.length, 1);
});

test('unsupported native domains stay archived while explicit safe-subset import skips before reservation', async t => {
  for (const event of [{ type: 'goal/change', data: { operation: 'create' } }, { type: 'other-plugin/record', data: {}, ignorable: true }]) {
    const log = events(); log.push({ seq: 3, time: 1003, ...event }); const f = await fixture(t, { events: log });
    const archive = await f.capture(); assert.ok(archive.archiveId); const plan = await f.prepare(archive); assert.equal(plan.eligibility, 'unchecked');
    const result = await f.importPlan(plan); assert.equal(result.state, 'skipped'); assert.equal(result.skipped[0].code, 'SYNC_ARCHIVES_UNSUPPORTED'); assert.deepEqual(f.targetNative.writes, []); assert.deepEqual(await ledgerFiles(f.stateDir), []);
  }
});

test('unknown, external and changed current-root deliverables fail closed without writing project files', async t => {
  for (const relative of ['not-captured.txt', '../external-do-not-read.txt', '.env']) {
    const log = events(); log.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { files: [{ path: relative }] } });
    const f = await fixture(t, { events: log }), archive = await f.capture(); assert.ok(archive.archiveId);
    await assert.rejects(f.prepare(archive), { code: 'SYNC_LOCAL_CHANGED' }); assert.deepEqual(f.targetNative.writes, []);
  }
  const log = events(); log.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { files: [{ path: 'result.txt' }] } });
  const f = await fixture(t, { events: log }); await f.file('result.txt'); const archive = await f.capture(), plan = await f.prepare(archive);
  await fs.writeFile(path.join(f.root, 'result.txt'), 'user edit');
  await assert.rejects(f.importPlan(plan), { code: 'SYNC_LOCAL_CHANGED' }); assert.deepEqual(f.targetNative.writes, []); assert.equal(await fs.readFile(path.join(f.root, 'result.txt'), 'utf8'), 'user edit');
});

test('deliverable snapshots remain closed immutable assets and are verified against the current manifest', async t => {
  const log = events(); log.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { files: [{ path: 'result.txt' }] } });
  const f = await fixture(t, { events: log }); await f.file('result.txt'); const archive = await f.capture();
  const newer = { ...archive, manifest: { ...archive.manifest, files: [] } };
  await assert.rejects(f.prepare(newer), { code: 'SYNC_LOCAL_CHANGED' });
  const plan = await f.prepare(archive), imported = await f.importPlan(plan); assert.equal(imported.state, 'imported');
  assert.equal(f.targetNative.created[0].events[3].data.files[0].path, path.join(f.root, 'result.txt'));
});

test('missing/corrupt assets, unclosed refs and corrupt wrappers are refused before provider writes', async t => {
  const f = await fixture(t, withFileAsset()), archive = await f.capture(), asset = archive.manifest.archiveRefs.find(item => item.id.startsWith('asset-'));
  await assert.rejects(f.prepare({ ...archive, manifest: { ...archive.manifest, archiveRefs: archive.manifest.archiveRefs.filter(item => item.id !== asset.id) } }), { code: 'SYNC_INTEGRITY' });
  await assert.rejects(f.prepare(archive, { client: { downloadBlob: async (hash, size) => hash === asset.hash ? Buffer.from('corruption') : f.client.downloadBlob(hash, size) } }), { code: 'SYNC_INTEGRITY' });
  await assert.rejects(f.prepare(archive, { client: { downloadBlob: async (hash, size) => { if (hash === asset.hash) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return f.client.downloadBlob(hash, size); } } }), { code: 'ENOENT' });
  await assert.rejects(f.prepare(archive, { client: { downloadBlob: async () => Buffer.from('{}') } }), { code: 'SYNC_INTEGRITY' });
  assert.deepEqual(f.targetNative.writes, []);
});

test('wrapper source/project substitution and unknown versioned fields fail closure validation', async t => {
  const f = await fixture(t), archive = await f.capture(), original = JSON.parse((await f.store.getBlob(archive.archiveId.slice(8))).toString());
  for (const alter of [value => { value.projectId = 'other-project'; }, value => { value.origin.sessionId = 'another-session'; }, value => { value.origin.sourceRoot = path.join(f.base, 'unseen'); }, value => { value.credentialPath = 'DO-NOT-READ'; }, value => { value.version = 2; }]) {
    const wrapper = copy(original); alter(wrapper); const bytes = Buffer.from(canonicalJson(wrapper)), hash = sha256(bytes); await f.store.putBlob(hash, bytes);
    const wrong = { archiveId: `session-${hash}`, manifest: { ...archive.manifest, archiveRefs: [{ id: `session-${hash}`, hash, size: bytes.length }] } };
    await assert.rejects(f.prepare(wrong), { code: 'SYNC_INTEGRITY' });
  }
  assert.deepEqual(f.targetNative.writes, []);
});

test('native active/unavailable warns without blocking files but integrity, policy and cancellation stop', async t => {
  const f = await fixture(t, { active: true }); const skipped = await f.capture(); assert.deepEqual(skipped.result.archiveRefs, []); assert.equal(skipped.result.warningCode, 'SYNC_ARCHIVES_SKIPPED');
  const unavailable = createSessionSync({ ctx: f.sourceNative.ctx, stateDir: path.join(f.base, 'unavailable'), adapter: createDshAdapter({ loadSdk: async () => { throw Object.assign(new Error('synthetic missing SDK'), { code: 'ERR_MODULE_NOT_FOUND' }); } }) });
  assert.equal((await unavailable.captureArchives({ root: f.source, projectId: 'project-a', deviceId: 'device-a', files: [], putBlob: () => assert.fail('no bytes') })).warningCode, 'SYNC_ARCHIVES_UNSUPPORTED');
  const a = new AbortController(); a.abort(); await assert.rejects(f.capture({ signal: a.signal }), { name: 'AbortError' });
  await assert.rejects(f.capture({ check: async () => { throw Object.assign(new Error('revoked'), { code: 'ACCOUNT_MISMATCH' }); } }), { code: 'ACCOUNT_MISMATCH' });
  const g = await fixture(t, withFileAsset()); g.sourceNative.assets.set([...g.sourceNative.assets.keys()][0], Buffer.from('broken'));
  await assert.rejects(g.capture(), { code: 'SYNC_INTEGRITY' });
});

test('an excluded literal state[1] inside a project skips archives without breaking the file lane', async t => {
  const f = await fixture(t); await f.file('ordinary.txt', 'file lane still works');
  const stateDir = path.join(f.source, 'state[1]'); await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, 'private-bookkeeping.json'), 'SYNTHETIC-PRIVATE-STATE-CANARY');
  const bytesSeen = [];
  const scan = await scanSyncProject({ root: f.source, projectId: 'project-a', deviceId: identity.deviceId, excludedPaths: ['state[1]'], putBlob: async (hash, bytes) => { bytesSeen.push(bytes); await f.store.putBlob(hash, bytes); } });
  assert.deepEqual(scan.files.map(file => file.path), ['ordinary.txt']);
  const api = createSessionSync({ ctx: f.sourceNative.ctx, stateDir, identity, adapter: f.adapter });
  const result = await api.captureArchives({ root: f.source, projectId: 'project-a', deviceId: identity.deviceId, files: scan.files, putBlob: () => assert.fail('overlapping archive cache must not stage bytes') });
  assert.deepEqual(result.archiveRefs, []); assert.equal(result.warningCode, 'SYNC_ARCHIVES_UNSUPPORTED'); assert.equal(f.sourceNative.handleStates.length, 0);
  assert.ok(bytesSeen.every(bytes => !bytes.includes('SYNTHETIC-PRIVATE-STATE-CANARY'))); await scan.verify();
  const archive = await f.capture();
  await assert.rejects(api.prepareImport({ root: f.source, projectId: 'project-a', archiveId: archive.archiveId, manifest: archive.manifest, client: f.client, identity }), { code: 'SYNC_METADATA_UNSAFE' });
  assert.deepEqual(await fs.readdir(stateDir), ['private-bookkeeping.json']);
  await assert.rejects(api.captureArchives({ root: f.source, projectId: 'project-a', deviceId: identity.deviceId, files: scan.files, putBlob: async () => {}, check: async () => { throw Object.assign(new Error('revoked'), { code: 'ACCOUNT_MISMATCH' }); } }), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(api.captureArchives({ root: path.join(f.source, 'missing-root'), projectId: 'project-a', deviceId: identity.deviceId, files: [], putBlob: async () => {} }), { code: 'ENOENT' });
});

test('aggregate budgets and mid-asset cancellation are bounded and callback errors are not swallowed', async t => {
  const f = await fixture(t, withFileAsset());
  const limited = createSessionSync({ ctx: f.sourceNative.ctx, stateDir: path.join(f.base, 'limited'), adapter: f.adapter, maxArchiveBytes: 10 });
  await assert.rejects(limited.captureArchives({ root: f.source, projectId: 'project-a', deviceId: 'device-a', files: [], putBlob: async () => {} }));
  const abort = new AbortController();
  await assert.rejects(f.capture({ signal: abort.signal, putBlob: async () => { abort.abort(); } }), { name: 'AbortError' });
  const sentinel = new Error('spool denied'); await assert.rejects(f.capture({ putBlob: async () => { throw sentinel; } }), error => error === sentinel);
  const guarded = new Error('guard denied'); await assert.rejects(f.adapter.exportProjectSessions(f.sourceNative.ctx, f.source, { onAsset: async () => { throw guarded; } }), error => error === guarded);
});

test('ledger reserves ID before attachments/provider effects and marks unknown create result uncertain', async t => {
  let f;
  const options = withFileAsset(); options.target = { createRejectsAfterRegistration: true, async beforeNativeWrite() {
    const names = await ledgerFiles(f.stateDir); assert.equal(names.length, 1); const row = JSON.parse(await fs.readFile(names[0], 'utf8')); assert.equal(row.state, 'reserved'); assert.match(row.sessionId, /^session-/);
  } };
  f = await fixture(t, options); const archive = await f.capture(), plan = await f.prepare(archive);
  const result = await f.importPlan(plan); assert.equal(result.state, 'uncertain'); assert.equal(result.failed[0].mayHaveDurableSession, true); assert.equal(result.sessionIds[0], f.targetNative.created[0].header.id);
  const again = await f.importPlan(plan, { requestId: 'different-request' }); assert.equal(again.state, 'uncertain'); assert.deepEqual(again.sessionIds, result.sessionIds); assert.equal(f.targetNative.created.length, 1);
  const restarted = createSessionSync({ ctx: f.targetNative.ctx, stateDir: f.stateDir, identity, adapter: f.adapter });
  const newPlan = await restarted.prepareImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, manifest: archive.manifest, client: f.client, identity });
  assert.equal((await restarted.importArchive({ plan: newPlan, requestId: 'after-restart', identity })).state, 'uncertain'); assert.equal(f.targetNative.created.length, 1);
});

test('partial append/close failures preserve possible new IDs and never replay native writes', async t => {
  for (const mode of ['appendRejects', 'closeRejects']) {
    const f = await fixture(t, { target: { [mode]: true } }), archive = await f.capture(), plan = await f.prepare(archive);
    const result = await f.importPlan(plan); assert.equal(result.state, 'uncertain'); assert.equal(result.sessionIds.length, 1);
    await f.importPlan(plan, { requestId: 'another-request' }); assert.equal(f.targetNative.created.length, 1); assert.ok(f.targetNative.handleStates.every(item => item.closed));
  }
});

test('same-archive concurrent cross-request import is exactly once and survives helper restart', async t => {
  const f = await fixture(t), archive = await f.capture(), plan = await f.prepare(archive);
  const [a, b] = await Promise.all([f.importPlan(plan), f.importPlan(plan, { requestId: 'request-b' })]);
  assert.equal(a.state, 'imported'); assert.equal(b.state, 'imported'); assert.deepEqual(a.sessionIds, b.sessionIds); assert.equal(f.targetNative.created.length, 1); assert.equal([a, b].filter(item => item.duplicate).length, 1);
  const restarted = createSessionSync({ ctx: f.targetNative.ctx, stateDir: f.stateDir, identity, adapter: f.adapter });
  const newPlan = await restarted.prepareImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, manifest: archive.manifest, client: f.client, identity });
  const c = await restarted.importArchive({ plan: newPlan, requestId: 'new-after-restart', identity }); assert.deepEqual(c.sessionIds, a.sessionIds); assert.equal(f.targetNative.created.length, 1);
});

test('identity/root/profile isolation and epoch-pinned plans prevent unintended duplicate admission', async t => {
  const f = await fixture(t), archive = await f.capture(), plan = await f.prepare(archive), newer = { ...identity, authorizationEpoch: 2 };
  await assert.rejects(f.importPlan(plan, { identity: newer }), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(f.prepare(archive, { identity: { ...identity, token: 'MUST-NOT-PERSIST' } }), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(f.importPlan({ ...plan }), { code: 'SYNC_PLAN_EXPIRED' });
  const first = await f.importPlan(plan), newPlan = await f.prepare(archive, { identity: newer });
  assert.deepEqual((await f.importPlan(newPlan, { identity: newer, requestId: 'reauthorized' })).sessionIds, first.sessionIds);
  const other = { ...identity, username: 'bob' }, otherPlan = await f.prepare(archive, { identity: other }); assert.equal(otherPlan.eligibility, 'unchecked');
  const otherResult = await f.importPlan(otherPlan, { identity: other }); assert.notDeepEqual(otherResult.sessionIds, first.sessionIds);
  const differentProfile = createSessionSync({ ctx: f.targetNative.ctx, stateDir: path.join(f.base, 'different-profile'), identity, adapter: f.adapter });
  const profilePlan = await differentProfile.prepareImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, manifest: archive.manifest, client: f.client, identity }); assert.equal(profilePlan.eligibility, 'unchecked');
  const otherRoot = path.join(f.base, 'other-root'); await fs.mkdir(otherRoot);
  const rootPlan = await f.prepare(archive, { root: otherRoot }); assert.equal(rootPlan.eligibility, 'unchecked');
  const moved = path.join(f.base, 'owned-old-root'); assert.equal(path.dirname(path.resolve(moved)), f.base); assert.equal(path.resolve(f.root), path.join(f.base, 'target')); await fs.rename(f.root, moved); await fs.mkdir(f.root);
  await assert.rejects(f.importPlan(plan, { requestId: 'root-swapped' }), { code: 'SYNC_ROOT_CHANGED' });
});

test('valid Unicode account names keep the same auth contract and do not disable archive/file capture', async t => {
  const f = await fixture(t), account = { ...identity, username: 'ali\u200Dce' };
  const api = createSessionSync({ ctx: f.sourceNative.ctx, stateDir: path.join(f.base, 'unicode-account'), identity: account, adapter: f.adapter });
  const result = await api.captureArchives({ root: f.source, projectId: 'project-a', deviceId: account.deviceId, files: [], putBlob: (hash, bytes) => f.store.putBlob(hash, bytes) });
  assert.equal(result.archiveRefs.filter(ref => ref.id.startsWith('session-')).length, 1); assert.equal(result.warningCode, undefined);
  const archive = await f.capture();
  const plan = await f.prepare(archive, { identity: account });
  assert.equal((await f.importPlan(plan, { identity: account })).state, 'imported');
  await assert.rejects(f.prepare(archive, { identity: { ...account, username: 'bad\u0000name' } }), { code: 'ACCOUNT_MISMATCH' });
});

test('unchanged imported native logs are suppressed, while genuine continuation archives carry lineage', async t => {
  const f = await fixture(t, withFileAsset()), archive = await f.capture(), plan = await f.prepare(archive), imported = await f.importPlan(plan);
  assert.equal(imported.warningCode, undefined);
  const capture = () => f.consumer.captureArchives({ root: f.root, projectId: 'project-a', deviceId: identity.deviceId, files: [], putBlob: (hash, bytes) => f.store.putBlob(hash, bytes) });
  assert.deepEqual((await capture()).archiveRefs, []);
  const row = f.targetNative.records.get(imported.sessionIds[0]); row.events.push(...events().map(event => ({ ...event, seq: event.seq + 3, time: event.time + 10 }))); row.revision = 'continued';
  const continued = await capture(), ref = continued.archiveRefs.find(item => item.id.startsWith('session-')); assert.ok(ref);
  const wrapper = JSON.parse((await f.store.getBlob(ref.hash)).toString()); assert.equal(wrapper.lineage.archiveId, archive.archiveId); assert.equal(wrapper.origin.sessionId, imported.sessionIds[0]); assert.equal(wrapper.native.events.length, 6);
});

test('continuation before post-persist observation never establishes a false unchanged fingerprint', async t => {
  const f = await fixture(t, { target: { onAttached(record) { record.events.push(...events().map(event => ({ ...event, seq: event.seq + 3, time: event.time + 10 }))); record.revision = 'immediate-continuation'; } } });
  const archive = await f.capture(), plan = await f.prepare(archive), imported = await f.importPlan(plan); assert.equal(imported.state, 'imported'); assert.equal(imported.warningCode, 'SYNC_ARCHIVES_SKIPPED');
  const result = await f.consumer.captureArchives({ root: f.root, projectId: 'project-a', deviceId: identity.deviceId, files: [], putBlob: (hash, bytes) => f.store.putBlob(hash, bytes) }); assert.equal(result.archiveRefs.filter(ref => ref.id.startsWith('session-')).length, 1);
});

test('read-only restart lookup reports completed and crash-reserved IDs without native replay', async t => {
  const f = await fixture(t), archive = await f.capture();
  const lookup = api => api.lookupImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, identity });
  assert.equal(await lookup(f.consumer), null); assert.deepEqual(await fs.readdir(f.root), []);
  const plan = await f.prepare(archive), imported = await f.importPlan(plan);
  const restarted = createSessionSync({ ctx: f.targetNative.ctx, stateDir: f.stateDir, identity, adapter: f.adapter });
  assert.deepEqual((await lookup(restarted)).sessionIds, imported.sessionIds);
  const filename = (await ledgerFiles(f.stateDir))[0], row = JSON.parse(await fs.readFile(filename, 'utf8'));
  row.state = 'reserved'; row.localFingerprint = null; await fs.writeFile(filename, canonicalJson(row)); // Simulated crash after durable reservation.
  assert.equal((await lookup(restarted)).state, 'uncertain');
  const again = await restarted.prepareImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, manifest: archive.manifest, client: f.client, identity });
  const result = await restarted.importArchive({ plan: again, requestId: 'recover-reservation', identity });
  assert.equal(result.state, 'uncertain'); assert.deepEqual(result.sessionIds, imported.sessionIds); assert.equal(f.targetNative.created.length, 1);
  assert.equal((await restarted.lookupImport({ root: f.root, projectId: 'project-a', archiveId: archive.archiveId, identity: { ...identity, username: 'other-account' } })), null);
});

test('corrupt prepared cache is an integrity failure, never a provider mutation or silent unsupported skip', async t => {
  const f = await fixture(t, withFileAsset()), archive = await f.capture(), plan = await f.prepare(archive);
  const files = [];
  async function walk(directory) { for (const item of await fs.readdir(directory, { withFileTypes: true })) { const name = path.join(directory, item.name); if (item.isDirectory()) await walk(name); else files.push(name); } }
  await walk(f.stateDir); const asset = files.find(name => path.basename(path.dirname(name)) === 'assets'); assert.ok(asset);
  await fs.writeFile(asset, 'synthetic cache corruption');
  await assert.rejects(f.importPlan(plan), { code: 'SYNC_INTEGRITY' }); assert.deepEqual(f.targetNative.writes, []); assert.deepEqual(await ledgerFiles(f.stateDir), []);
});

test('same origin/native content dedupes different wrapper snapshots while request IDs cannot change archives', async t => {
  const log = events(); log.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { files: [{ path: 'result.txt' }] } });
  const f = await fixture(t, { events: log }); await f.file('result.txt');
  const a = await f.capture(), first = await f.importPlan(await f.prepare(a));
  const bytes = Buffer.from('newer file snapshot'); await fs.writeFile(path.join(f.source, 'result.txt'), bytes); await fs.writeFile(path.join(f.root, 'result.txt'), bytes);
  f.files[0] = { ...f.files[0], hash: sha256(bytes), size: bytes.length };
  const b = await f.capture(); assert.notEqual(a.archiveId, b.archiveId);
  const plan = await f.prepare(b); assert.equal(plan.eligibility, 'imported');
  const duplicate = await f.importPlan(plan, { requestId: 'wrapper-alias' }); assert.deepEqual(duplicate.sessionIds, first.sessionIds); assert.equal(f.targetNative.created.length, 1);
  await assert.rejects(f.importPlan(plan), { code: 'SYNC_PLAN_CHANGED' }); assert.equal(f.targetNative.created.length, 1);
});

test('import uses fresh confirmation guard/signal; browser paths cannot authorize the archive directory', async t => {
  const f = await fixture(t), archive = await f.capture(), oldSignal = new AbortController(); const plan = await f.prepare(archive, { signal: oldSignal.signal }); oldSignal.abort();
  let guards = 0; const result = await f.importPlan(plan, { check: async () => { guards++; } }); assert.equal(result.state, 'imported'); assert.ok(guards > 3);
  const envelope = JSON.parse((await f.store.getBlob(archive.archiveId.slice(8))).toString()).native, bytes = Buffer.from(JSON.stringify(envelope));
  const manifest = { version: 1, id: 'checkpoint-v1', projectId: 'project-a', deviceId: 'device-a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z', sourceRoot: f.source, sessionIds: [envelope.sessionId], files: [{ path: `sessions/${envelope.sessionId}.json`, sha256: sha256(bytes), size: bytes.length }] };
  await assert.rejects(f.adapter.importProjectSessions(f.targetNative.ctx, { manifest, root: f.root, archiveDirectory: f.source }), /capability/);
});
