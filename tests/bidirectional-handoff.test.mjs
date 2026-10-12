import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBidirectionalController, canRepairBinding } from '../client/bidirectional-state.mjs';
import { createController as createHostController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createDshAdapter, SESSION_ENVELOPE_FORMAT } from '../plugin/dsh-adapter.mjs';
import { SESSION_ARCHIVE_FORMAT } from '../plugin/session-sync.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';

// Production GUI controller -> native RPC JSON envelopes -> production Host,
// session helper + DSH adapter -> actual loopback cloud. Only SDK/provider and
// native Connection carrier interfaces are synthetic; no real GUI/SDK claim.
const fixtureParent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-native-handoff-only';
const options = { timeout: 180_000 };
const copy = value => structuredClone(value);
const diagnostic = ui => JSON.stringify({ error: ui.getSnapshot().error, dialogError: ui.getSnapshot().dialog?.error, status: ui.getSnapshot().status });
const knownEvents = new Set(['turn/start', 'turn/end', 'user/message', 'deliverables/presented']);
function syntheticSdk() {
  return { knownEventTypes: knownEvents, validateAssistantStreams() {}, catalog: {
    currentVersion: 4, encodeCurrentHeader: (header, cut) => ({ ...copy(header), cut }), encodeCurrentEvent: copy,
    createRestore(header, mode) {
      assert.deepEqual(mode, { recovery: 'strict', validation: 'current' }); const events = [];
      return { decodeRow(event) { assert.equal(event.seq, events.length); assert.ok(knownEvents.has(event.type)); events.push(copy(event)); }, finish() { const { cut, ...logical } = header; return { header: logical, inheritedEventCount: cut, events }; } };
    },
  } };
}
async function importLedgers(stateDir) {
  const root = path.join(stateDir, 'session-sync');
  try {
    const names = await fs.readdir(root, { recursive: true });
    return Promise.all(names.filter(name => /(?:^|[\\/])imports[\\/][a-f0-9]{64}\.json$/.test(name)).map(async name => {
      const filename = path.resolve(root, name); assert.ok(filename.startsWith(path.resolve(root) + path.sep));
      return JSON.parse(await fs.readFile(filename, 'utf8'));
    }));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function nativeProvider(root, workspaceId, stateDir, { seed = false, partialCreate = false } = {}) {
  const records = new Map(), assets = new Map(), reserved = [], created = [], effects = [], results = [], exported = [];
  const counts = { exports: 0, imports: 0, reads: 0, writes: 0, agents: 0, liveCreates: 0 };
  const assetBytes = Buffer.from('synthetic native attachment'), assetHash = sha256(assetBytes); assets.set(assetHash, assetBytes);
  if (seed) records.set('source-session', {
    header: { version: 4, id: 'source-session', createdAt: 1000, cwd: root, isSeeded: false, delegationDepth: 0 }, inheritedEventCount: 0, revision: 'source-1', sizeBytes: 1000,
    events: [
      { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 1001, type: 'user/message', surfaceOp: 'append', data: { id: 'message-source', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic archived conversation.' }, { type: 'file', attachment: { attachmentId: `sha256:${assetHash}`, bytes: assetBytes.length, name: 'input.txt' } }] } },
      { seq: 2, time: 1002, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 3, time: 1003, type: 'deliverables/presented', data: { files: [{ path: 'project.txt' }] } },
    ],
  });
  async function beforeWrite(kind) {
    assert.equal(reserved.length, 1, 'one new target ID must be durably reserved before any native effects');
    const ledger = (await importLedgers(stateDir)).find(row => row.sessionId === reserved[0]);
    assert.ok(ledger); assert.ok(['reserved', 'imported', 'uncertain'].includes(ledger.state));
    counts.writes++; effects.push(kind);
  }
  const workspace = { id: workspaceId, title: 'Synthetic workspace', path: root, async attachSession(id) { await beforeWrite('attach'); assert.ok(records.has(id)); } };
  const services = {
    sessions: { list: () => [], get: () => undefined, flush: async () => {}, create() { counts.liveCreates++; assert.fail('never create a running native session'); } },
    agents: { get: () => undefined, create() { counts.agents++; assert.fail('never start agents'); }, resume() { counts.agents++; assert.fail('never resume agents'); } },
    attachments: {
      async *readFileStream(ref) { counts.reads++; const bytes = assets.get(ref.attachmentId.slice(7)); assert.ok(bytes); yield bytes; },
      async readImage() { assert.fail('fixture has no images'); },
      async saveFile({ data, name }) { await beforeWrite('attachment'); const hash = sha256(data); assets.set(hash, Buffer.from(data)); return { attachmentId: `sha256:${hash}`, bytes: data.length, name }; },
      async saveImage() { assert.fail('fixture has no images'); },
    },
    sessionPersistence: {
      async list() { counts.reads++; return [...records.values()].map(row => ({ header: copy(row.header), revision: row.revision, sizeBytes: row.sizeBytes })); },
      async stat(id) { counts.reads++; const row = records.get(id); return row && { header: copy(row.header), revision: row.revision, sizeBytes: row.sizeBytes }; },
      async open(id, access) { counts.reads++; assert.equal(access, 'read'); const row = records.get(id); assert.ok(row); return { header: copy(row.header), inheritedEventCount: row.inheritedEventCount, async read() { return { events: copy(row.events) }; }, async close() {} }; },
      async create(header, creation) {
        await beforeWrite('create'); assert.ok(reserved.includes(header.id)); assert.ok(!records.has(header.id));
        const row = { header: copy(header), inheritedEventCount: creation.inheritedEventCount, events: [], revision: 'created', sizeBytes: undefined };
        records.set(header.id, row); created.push(header.id);
        if (partialCreate) throw new Error('synthetic native create registered ID, then lost acknowledgment');
        return { async append(events) { await beforeWrite('append'); row.events.push(...copy(events)); }, async flush() { await beforeWrite('flush'); row.sizeBytes = Buffer.byteLength(JSON.stringify(row)); row.revision = 'flushed'; }, async close() { effects.push('close'); } };
      },
    },
    workspaceRegistry: { list: () => [workspace], get: id => id === workspaceId ? workspace : undefined, async create(directory) { assert.equal(directory, root); return workspace; } },
  };
  const actual = createDshAdapter({ loadSdk: async () => syntheticSdk() });
  const adapter = {
    async exportProjectSessions(ctx, sourceRoot, config) {
      counts.exports++;
      return actual.exportProjectSessions(ctx, sourceRoot, { ...config, onSession: async row => { exported.push(copy({ id: row.id, data: row.data, selected: config.sessionIds ?? null })); await config.onSession?.(row); },
        ...(config.onAsset ? { onAsset: (bytes, ref) => config.onAsset(bytes, ref) } : {}) });
    },
    async importProjectSessions(ctx, config) {
      counts.imports++;
      return actual.importProjectSessions(ctx, { ...config, allocateSessionId: async oldId => {
        const targetId = await config.allocateSessionId(oldId); assert.notEqual(targetId, oldId);
        const ledger = (await importLedgers(stateDir)).find(row => row.sessionId === targetId); assert.equal(ledger?.state, 'reserved');
        reserved.push(targetId); effects.push('reserve'); return targetId;
      }, onResult: async result => { results.push(copy(result)); await config.onResult?.(result); } });
    },
  };
  return { services, adapter, records, assets, counts, reserved, created, effects, results, exported };
}
async function fixture(t) {
  await fs.mkdir(fixtureParent, { recursive: true }); const directory = await fs.mkdtemp(path.join(fixtureParent, 'bidir-handoff-'));
  const mounts = []; let cloud, clock = Date.now();
  t.after(async () => {
    for (const mount of mounts) { for (const ui of mount.clients) ui.dispose(); mount.bridge.dispose(); mount.service.stopBidirectional(); mount.host.stop(); }
    await Promise.all(mounts.flatMap(mount => [mount.host.drain(), mount.service.drainBidirectional()]));
    if (cloud) await closeSyncServer(cloud);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(fixtureParent)); assert.match(path.basename(directory), /^bidir-handoff-[A-Za-z0-9]+$/);
    const info = await fs.lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }); await assert.rejects(fs.lstat(directory), { code: 'ENOENT' });
  });
  cloud = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password });
  await new Promise((resolve, reject) => { cloud.once('error', reject); cloud.listen(0, '127.0.0.1', resolve); });
  const server = `http://127.0.0.1:${cloud.address().port}`;
  async function mount(name, nativeOptions = {}) {
    assert.match(name, /^[a-z]+$/);
    const root = path.join(directory, `project-${name}`), home = path.join(directory, `host-${name}`), profileDir = path.join(home, 'profile'), stateDir = path.join(profileDir, 'sync'), workspaceId = `workspace:${name}`;
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(profileDir, { recursive: true });
    const native = nativeProvider(root, workspaceId, stateDir, nativeOptions), credentials = new Map();
    const ctx = { workspaceRegistry: native.services.workspaceRegistry, get: name => native.services[name], waterfall: async (_event, _payload, next) => next(), credentials: {
      readRecord: async key => credentials.get(key), modifyRecord: async (key, update) => { const next = await update(credentials.get(key)); if (next !== undefined) credentials.set(key, next); }, deleteRecord: async key => credentials.delete(key),
    } };
    const host = createHostController(ctx, { stateDir }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
      exportSessions: native.adapter.exportProjectSessions, importSessions: native.adapter.importProjectSessions });
    const legacy = createSettingsService(ctx, host, { profileDir, dshHome: home });
    const service = withBidirectionalSync(ctx, host, legacy, { profileDir, dshHome: home, enableWatchers: false, now: () => clock, isIdle: async () => true, sessionAdapter: native.adapter });
    const bridge = createSettingsHttp(service), clients = [], calls = []; let rpcSequence = 0, drop = null, saved;
    const connection = { rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); const action = endpoint.slice('dsh-personal-sync/'.length); assert.equal(endpoint, `dsh-personal-sync/${action}`);
      const rpcId = `handoff-${name}-${++rpcSequence}`, call = { action, payload: action === 'login' ? { server: payload.server, username: payload.username } : copy(payload), signal }; calls.push(call);
      const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }) }));
      const envelope = await response.json(); assert.equal(response.status, 200); assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, rpcId); call.result = envelope.result;
      if (drop === action && call.result.ok && call.result.value?.accepted) { drop = null; call.lost = true; throw new Error('synthetic carrier lost acknowledged native admission'); }
      return call.result;
    } } };
    function newUi() { const ui = createBidirectionalController(connection, { now: () => clock, timeoutMs: 60_000 }); if (saved) ui.setIdentity(saved); clients.push(ui); return ui; }
    const result = { root, home, profileDir, stateDir, workspaceId, native, credentials, host, legacy, service, bridge, clients, connection, calls, newUi, ui: newUi(),
      dropNextAck(action) { drop = action; },
      async login() { const reply = await connection.rpc.call('/api', 'dsh-personal-sync/login', { server, username: 'owner', password, remember: true }); assert.equal(reply.ok, true, JSON.stringify(reply.error)); saved = reply.value; this.ui.setIdentity(saved); await this.ui.refresh(); },
      grant() { return credentials.get(host.credentialKey).payload; }, cloudClient() { return new SyncV2Client(this.grant()); },
    };
    mounts.push(result); await result.login(); return result;
  }
  return { directory, server, mount, advance(ms) { clock += ms; } };
}
function file(mount, relative) { assert.ok(relative && relative.split('/').every(part => part && part !== '.' && part !== '..')); const value = path.resolve(mount.root, ...relative.split('/')); assert.ok(value.startsWith(path.resolve(mount.root) + path.sep)); return value; }
async function write(mount, relative, bytes) { const target = file(mount, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
const read = (mount, relative) => fs.readFile(file(mount, relative), 'utf8');
async function drain(mount, requestId, expected = 'succeeded', ui = mount.ui) {
  await mount.service.drainBidirectional(); await mount.host.drain(); assert.equal(await ui.refresh(), true, diagnostic(ui));
  const result = ui.getSnapshot().status.operations.find(item => item.id === requestId); assert.ok(result); assert.equal(result.state, expected, JSON.stringify(result)); return result;
}
async function pair(mount, projectId = null) {
  const ui = mount.ui; await ui.refresh(); assert.equal(await ui.openPair(), true, diagnostic(ui)); assert.equal(ui.selectWorkspace(mount.workspaceId), true); assert.equal(ui.selectProject(projectId), true);
  assert.equal(await ui.planPair(), true, diagnostic(ui)); const plan = ui.getSnapshot().dialog.plan, before = mount.calls.length;
  assert.equal(await ui.confirmPair(plan), true, diagnostic(ui)); const call = mount.calls.slice(before).find(item => item.action === 'paircommit'); await drain(mount, call.payload.requestId);
  return ui.getSnapshot().status.bindings.find(item => item.projectId === plan.projectId);
}
async function run(mount, expected = 'succeeded', ui = mount.ui) {
  await ui.refresh(); const before = mount.calls.length; assert.equal(await ui.run(ui.getSnapshot().status.bindings[0].id), true, diagnostic(ui));
  const call = mount.calls.slice(before).find(item => item.action === 'syncrun'); return drain(mount, call.payload.requestId, expected, ui);
}
async function remote(mount, projectId) { const client = mount.cloudClient(), head = await client.syncHead(projectId); return { head, manifest: await client.syncCheckpoint(projectId, head.id, head.manifestDigest) }; }
async function planImport(mount, bindingId, ui = mount.ui) {
  await ui.refresh(); assert.equal(await ui.openArchives(bindingId), true, diagnostic(ui));
  const archive = ui.getSnapshot().dialog.items.find(item => item.state === 'available'); assert.ok(archive); assert.equal(ui.selectArchive(archive.id), true);
  assert.equal(await ui.planArchiveImport(), true, diagnostic(ui)); return { archive, plan: ui.getSnapshot().dialog.plan };
}
function noExecution(...mounts) { for (const mount of mounts) { assert.equal(mount.native.counts.agents, 0); assert.equal(mount.native.counts.liveCreates, 0); } }

test('format-4 cloud handoff imports once while files paused; readonly plans and unchanged native capture stay inert', options, async t => {
  const f = await fixture(t), a = await f.mount('a', { seed: true }), b = await f.mount('b'); await write(a, 'project.txt', 'pinned synthetic deliverable');
  const aBinding = await pair(a), initial = await remote(a, aBinding.projectId);
  const sessions = initial.manifest.archiveRefs.filter(ref => ref.id.startsWith('session-')); assert.equal(sessions.length, 1);
  const wrapper = JSON.parse((await a.cloudClient().downloadBlob(sessions[0].hash, sessions[0].size)).toString());
  assert.equal(wrapper.format, SESSION_ARCHIVE_FORMAT); assert.equal(wrapper.native.format, SESSION_ENVELOPE_FORMAT); assert.equal(wrapper.native.sessionFormatVersion, 4); assert.equal(wrapper.native.header.id, 'source-session'); assert.equal(wrapper.native.events.length, 4); assert.equal(wrapper.files[0].path, 'project.txt'); assert.equal(wrapper.assets.length, 1);
  assert.equal(a.native.counts.imports, 0); assert.equal(a.native.counts.writes, 0);
  const bBinding = await pair(b, aBinding.projectId); assert.equal(await read(b, 'project.txt'), 'pinned synthetic deliverable'); assert.equal(b.ui.getSnapshot().status.bindings[0].archives, 1);
  assert.equal(await b.ui.setEnabled(bBinding.id, false), true, diagnostic(b.ui)); assert.equal(b.ui.getSnapshot().status.bindings[0].enabled, false);
  const nativeBefore = copy(b.native.counts), prepared = await planImport(b, bBinding.id);
  assert.deepEqual(b.native.counts, nativeBefore, 'list/preview cannot call native adapter or providers'); assert.equal(prepared.plan.eligibility, 'unchecked'); assert.deepEqual(prepared.plan.counts, { sessions: 1, events: 4, assets: 1, files: 1 });
  const before = b.calls.length; assert.equal(await b.ui.confirmArchiveImport(prepared.plan), true, diagnostic(b.ui)); assert.equal(await b.ui.confirmArchiveImport(prepared.plan), false);
  const call = b.calls.slice(before).find(item => item.action === 'syncarchiveimport'); assert.equal(call.result.value.operationId, call.payload.requestId);
  const result = await drain(b, call.payload.requestId); assert.equal(result.kind, 'import'); assert.equal(result.importedCount, 1); assert.equal(result.failedCount, 0); assert.equal(result.skippedCount, 0); assert.equal(result.sessionIds.length, 1);
  assert.deepEqual(result.sessionIds, b.native.reserved); assert.deepEqual(b.native.created, b.native.reserved); assert.equal(b.native.effects[0], 'reserve'); assert.equal(b.native.counts.imports, 1);
  assert.equal(b.ui.getSnapshot().status.bindings[0].enabled, false); assert.equal(b.native.records.get(result.sessionIds[0]).header.cwd, b.root);
  const saved = b.native.records.get(result.sessionIds[0]); assert.equal(saved.header.parentSession, undefined); assert.equal(saved.header.delegationDepth, 0); assert.equal(saved.events[3].data.files[0].path, file(b, 'project.txt'));
  assert.ok(b.native.exported.some(item => item.selected?.includes(result.sessionIds[0])), 'post-import exact-ID observation establishes fingerprint');
  const reopened = b.newUi(); await reopened.refresh(); await reopened.openArchives(bBinding.id); const row = reopened.getSnapshot().dialog.items.find(item => item.id === prepared.archive.id);
  assert.equal(row.state, 'imported'); assert.deepEqual(row.sessionIds, result.sessionIds); assert.equal(reopened.selectArchive(row.id), false);
  const replay = await b.connection.rpc.call('/api', 'dsh-personal-sync/syncarchiveimport', call.payload); assert.equal(replay.ok, true); assert.equal(replay.value.operationId, call.payload.requestId); await b.service.drainBidirectional(); assert.equal(b.native.counts.imports, 1);
  await b.ui.refresh(); assert.equal(await b.ui.setEnabled(bBinding.id, true), true); await run(b);
  const after = await remote(b, aBinding.projectId); assert.deepEqual(after.manifest.archiveRefs, initial.manifest.archiveRefs, 'unchanged imported native log must not create a new archive lineage loop');
  assert.equal(b.native.counts.imports, 1); assert.equal((await importLedgers(b.stateDir))[0].state, 'imported'); noExecution(a, b);
});

test('lost native-import acknowledgment reconciles request status and fresh UI ledger without creating twice', options, async t => {
  const f = await fixture(t), a = await f.mount('a', { seed: true }), b = await f.mount('b'); await write(a, 'project.txt', 'archived deliverable');
  const first = await pair(a), second = await pair(b, first.projectId); await b.ui.setEnabled(second.id, false);
  const { archive, plan } = await planImport(b, second.id), observed = []; const unsubscribe = b.ui.subscribe(() => observed.push(b.ui.getSnapshot().uncertain));
  const before = b.calls.length; b.dropNextAck('syncarchiveimport'); assert.equal(await b.ui.confirmArchiveImport(plan), false);
  const call = b.calls.slice(before).find(item => item.action === 'syncarchiveimport'); assert.equal(call.lost, true); assert.ok(observed.includes(true));
  assert.ok(b.calls.slice(before + 1).every(item => item.action === 'syncstatus'), 'unknown native acceptance can only read status');
  const result = await drain(b, call.payload.requestId); unsubscribe(); assert.equal(result.kind, 'import'); assert.equal(result.importedCount, 1); assert.deepEqual(result.sessionIds, b.native.created);
  assert.equal(b.native.counts.imports, 1); assert.equal(b.ui.getSnapshot().uncertain, false); b.ui.dispose();
  const reopened = b.newUi(); await reopened.refresh(); await reopened.openArchives(second.id); const row = reopened.getSnapshot().dialog.items.find(item => item.id === archive.id);
  assert.equal(row.state, 'imported'); assert.equal(reopened.selectArchive(row.id), false); assert.deepEqual(row.sessionIds, result.sessionIds);
  assert.equal(b.calls.slice(before).filter(item => item.action === 'syncarchiveimport').length, 1); assert.equal(b.native.created.length, 1); noExecution(a, b);
});

test('native create-then-throw exposes terminal partial ID, durable readonly uncertainty and a usable file lane', options, async t => {
  const f = await fixture(t), a = await f.mount('a', { seed: true }), b = await f.mount('b', { partialCreate: true }); await write(a, 'project.txt', 'partial source deliverable');
  const first = await pair(a), second = await pair(b, first.projectId), { archive, plan } = await planImport(b, second.id);
  const before = b.calls.length; assert.equal(await b.ui.confirmArchiveImport(plan), true, diagnostic(b.ui));
  const call = b.calls.slice(before).find(item => item.action === 'syncarchiveimport'), result = await drain(b, call.payload.requestId, 'failed');
  assert.equal(result.kind, 'import'); assert.equal(result.errorCode, 'SYNC_IMPORT_UNCERTAIN'); assert.equal(result.importedCount, 0); assert.equal(result.failedCount, 1); assert.equal(result.sessionIds.length, 1);
  assert.deepEqual(result.sessionIds, b.native.created); assert.deepEqual(result.sessionIds, b.native.reserved); assert.equal(b.ui.getSnapshot().uncertain, false, 'terminal native uncertainty must not lock unrelated file sync');
  const ledger = (await importLedgers(b.stateDir))[0]; assert.equal(ledger.state, 'uncertain'); assert.equal(ledger.sessionId, result.sessionIds[0]);
  const reopened = b.newUi(); await reopened.refresh(); await reopened.openArchives(second.id); const row = reopened.getSnapshot().dialog.items.find(item => item.id === archive.id);
  assert.equal(row.state, 'uncertain'); assert.deepEqual(row.sessionIds, result.sessionIds); assert.equal(reopened.selectArchive(archive.id), false); assert.equal(await reopened.planArchiveImport(), false);
  await write(b, 'after-partial.txt', 'files remain usable'); await run(b, 'succeeded', reopened); await run(a); assert.equal(await read(a, 'after-partial.txt'), 'files remain usable');
  assert.equal(b.native.created.length, 1); assert.equal(b.native.counts.imports, 1); noExecution(a, b);
});

test('real pinned-download local race is explicitly repairable; preview is inert and newer edits survive forced conflict', options, async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b'); await write(a, 'a-race.txt', 'old primary'); await write(a, 'b-other.txt', 'old other');
  const first = await pair(a), second = await pair(b, first.projectId); await write(a, 'a-race.txt', 'remote new primary'); await write(a, 'b-other.txt', 'remote new other'); await run(a);
  const original = SyncV2Client.prototype.downloadBlob, expected = sha256(Buffer.from('remote new primary')), deviceId = b.grant().deviceId; let injected = false;
  const replacement = t.mock.method(SyncV2Client.prototype, 'downloadBlob', async function(hash, size) {
    const bytes = await original.call(this, hash, size);
    if (!injected && this.deviceId === deviceId && hash === expected) { injected = true; await write(b, 'a-race.txt', 'newer local edit'); }
    return bytes;
  });
  const blocked = await run(b, 'failed'); replacement.mock.restore(); assert.equal(injected, true); assert.equal(blocked.errorCode, 'SYNC_LOCAL_CHANGED');
  const status = b.ui.getSnapshot().status, row = status.bindings.find(item => item.id === second.id); assert.equal(row.state, 'blocked'); assert.equal(row.repairable, true); assert.equal(canRepairBinding(row), true);
  assert.equal(await read(b, 'a-race.txt'), 'newer local edit'); const otherBefore = await read(b, 'b-other.txt'), headBefore = await b.cloudClient().syncHead(first.projectId), before = b.calls.length;
  assert.equal(b.ui.openRepair(second.id), true); assert.equal(b.calls.length, before); assert.equal(await b.ui.planRepair(), true, diagnostic(b.ui)); const plan = b.ui.getSnapshot().dialog.plan;
  assert.ok(plan.summary.conflicts >= 1); assert.ok(plan.paths.includes('a-race.txt')); assert.equal(await read(b, 'a-race.txt'), 'newer local edit'); assert.equal(await read(b, 'b-other.txt'), otherBefore); assert.deepEqual(await b.cloudClient().syncHead(first.projectId), headBefore);
  assert.equal(b.calls.some(item => item.action === 'syncrepair'), false);
  const beforeConfirm = b.calls.length; assert.equal(await b.ui.confirmRepair(plan), true, diagnostic(b.ui)); assert.equal(await b.ui.confirmRepair(plan), false);
  const call = b.calls.slice(beforeConfirm).find(item => item.action === 'syncrepair'); const repaired = await drain(b, call.payload.requestId); assert.equal(repaired.kind, 'repair');
  assert.equal(await read(b, 'a-race.txt'), 'newer local edit'); assert.equal(await read(b, 'b-other.txt'), 'remote new other');
  const committed = await remote(b, first.projectId), conflict = committed.manifest.conflicts.find(item => item.path === 'a-race.txt'); assert.ok(conflict, 'repair must not publish newer local bytes as a clean overwrite');
  assert.ok(conflict.variants.some(item => item?.hash === sha256(Buffer.from('newer local edit')))); assert.ok(conflict.variants.some(item => item?.hash === expected)); noExecution(a, b);
});
