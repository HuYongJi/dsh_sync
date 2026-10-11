import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDshAdapter } from '../plugin/dsh-adapter.mjs';
import { sha256 } from '../src/protocol.mjs';

// Deliberately MOCK tests of the adapter boundary. These do not load an installed DSH
// process, read real Sessions, touch a user's credentials, or prove Host integration.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function temporaryRoot() {
  const parent = path.join(repo, '.test-tmp');
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, 'adapter-test-'));
}
const copy = value => structuredClone(value);
const known = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'agent/inbox/spliced', 'deliverables/presented', 'session/end-seed', 'goal/change', 'sandbox/mode']);
function mockSdk() {
  const calls = [];
  return {
    calls,
    knownEventTypes: known,
    validateAssistantStreams(events) { calls.push({ mockStreamValidation: events.length }); },
    catalog: {
      currentVersion: 4,
      encodeCurrentHeader(header, cut) { assert.equal(header.version, 4); return { ...copy(header), cut }; },
      encodeCurrentEvent(event) { return copy(event); },
      createRestore(header, options) {
        calls.push(options);
        assert.deepEqual(options, { recovery: 'strict', validation: 'current' });
        const events = [];
        return {
          decodeRow(event) { assert.equal(event.seq, events.length); assert.ok(known.has(event.type) || event.ignorable === true); events.push(copy(event)); },
          finish() { const { cut, ...logical } = header; return { header: logical, inheritedEventCount: cut, events }; },
        };
      },
    },
  };
}
function basicEvents() {
  return [
    { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1001, type: 'user/message', surfaceOp: 'append', data: { id: 'message-a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep C:\\old\\project unchanged in prose.' }] } },
    { seq: 2, time: 1002, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}
function fixtureContext(root, options = {}) {
  const events = options.events ?? basicEvents();
  const id = options.id ?? 'session-source';
  const header = { version: 4, id, createdAt: 1000, cwd: root, isSeeded: false, delegationDepth: 0, ...options.header };
  const source = { header, events, inheritedEventCount: options.inheritedEventCount ?? 0, revision: 'revision-1', sizeBytes: options.unmaterialized ? undefined : 256 };
  const records = new Map([[id, source]]), created = [], handles = [], attachmentWrites = [];
  const live = options.live === false ? undefined : { id, header, seq: events.length };
  const agent = options.agent === undefined ? { status: 'idle', whenIdle: async () => {}, inbox: { hasPending: false } } : options.agent;
  const services = {
    sessions: { get: key => key === id ? live : undefined, list: () => live ? [live] : [], flush: async () => { options.onFlush?.(source, live); } },
    agents: { get: key => key === id ? agent : undefined, create() { throw new Error('MUST NOT CREATE AGENT'); }, resume() { throw new Error('MUST NOT RESUME AGENT'); } },
    attachments: {
      async readImage(ref) { return { ref, data: options.assets?.get(ref.attachmentId.slice(7)) ?? Buffer.from('image') }; },
      async *readFileStream(ref) { yield options.assets?.get(ref.attachmentId.slice(7)) ?? Buffer.from('file'); },
      async saveImage(input) { attachmentWrites.push(copy(input)); return { attachmentId: `sha256:${sha256(input.data)}`, mediaType: input.mediaType, width: 2, height: 2, bytes: input.data.length, ...(input.name === undefined ? {} : { name: input.name }) }; },
      async saveFile(input) { attachmentWrites.push(copy(input)); return { attachmentId: `sha256:${sha256(input.data)}`, name: input.name ?? 'file', bytes: input.data.length }; },
    },
    sessionPersistence: {
      async list() { return [...records.values()].map(record => ({ header: copy(record.header), revision: record.revision, ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }) })); },
      async stat(key) { const record = records.get(key); return record ? { header: copy(record.header), revision: record.revision, ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }) } : undefined; },
      async open(key, access) {
        assert.equal(access, 'read'); const record = records.get(key); assert.ok(record);
        const handle = { header: copy(record.header), inheritedEventCount: record.inheritedEventCount, closed: false, async read() { return { eventState: 'detached', events: copy(record.events) }; }, async close() { this.closed = true; } };
        handles.push(handle); return handle;
      },
      async create(nextHeader, creationOptions) {
        assert.ok(!records.has(nextHeader.id));
        const record = { header: copy(nextHeader), inheritedEventCount: creationOptions.inheritedEventCount, events: [], revision: 'created', sizeBytes: undefined };
        records.set(nextHeader.id, record); created.push(record);
        const handle = { closed: false, async append(batch) { record.events.push(...copy(batch)); }, async flush() { record.sizeBytes = 512; }, async close() { this.closed = true; } };
        handles.push(handle); return handle;
      },
    },
    workspaceRegistry: { async create(directory) { assert.equal(directory, options.importRoot ?? root); return { id: 'workspace-new', async attachSession(key) { assert.ok(records.has(key)); } }; } },
  };
  const ctx = { get: name => services[name], async waterfall(event, payload, next) { assert.equal(event, 'workspace/session-activity'); return options.activity ?? next(); } };
  return { ctx, services, records, source, created, handles, attachmentWrites, live, agent };
}
function adapter(sdk = mockSdk()) { return createDshAdapter({ loadSdk: async () => sdk, newId: () => 'session-new' }); }
async function restoredProject(envelope, assets = [], projectFiles = {}) {
  const root = await temporaryRoot(), meta = path.join(root, '.dsh-sync');
  await fs.mkdir(path.join(meta, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(meta, 'assets'));
  const bytes = Buffer.from(JSON.stringify(envelope));
  const files = [{ path: `sessions/${envelope.sessionId}.json`, sha256: sha256(bytes), size: bytes.length }];
  await fs.writeFile(path.join(meta, 'sessions', `${envelope.sessionId}.json`), bytes);
  for (const value of assets) {
    const bytes = Buffer.from(value), hash = sha256(bytes);
    files.push({ path: `assets/${hash}`, sha256: hash, size: bytes.length });
    await fs.writeFile(path.join(meta, 'assets', hash), bytes);
  }
  for (const [name, value] of Object.entries(projectFiles)) {
    const bytes = Buffer.from(value), absolute = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, bytes);
    files.push({ path: `project/${name}`, sha256: sha256(bytes), size: bytes.length });
  }
  const manifest = { version: 1, id: 'checkpoint-1', projectId: 'project-1', deviceId: 'device-1', parentId: null, createdAt: '2026-01-01T00:00:00.000Z', sourceRoot: envelope.sourceRoot, sessionIds: [envelope.sessionId], files };
  return { root, manifest, meta };
}
async function basicArchive(options = {}) {
  const root = await temporaryRoot(), fixture = fixtureContext(root, options), sdk = mockSdk(), api = adapter(sdk);
  const result = await api.exportProjectSessions(fixture.ctx, root);
  return { root, fixture, sdk, api, result };
}

test('adapter exports a deterministic detached native-v4 envelope and closes its read handle', async () => {
  const { api, fixture, root, result, sdk } = await basicArchive();
  assert.equal(result.sessions.length, 1); assert.deepEqual(result.skipped, []);
  assert.equal(result.sessions[0].data.format, 'dsh-personal-sync/session');
  assert.equal(result.sessions[0].data.header.id, 'session-source');
  assert.deepEqual(result.sessions[0].data.events, basicEvents());
  assert.ok(fixture.handles.every(handle => handle.closed)); assert.ok(sdk.calls.length);
  const again = await api.exportProjectSessions(fixture.ctx, root);
  assert.deepEqual(result.sessions, again.sessions);
  await result.verifyUnchanged();
});

test('adapter skips running, maintenance, background-active and unmaterialized sessions', async () => {
  for (const options of [
    { agent: { status: 'running' } },
    { agent: { status: 'idle', whenIdle: () => new Promise(() => {}) } },
    { agent: { status: 'idle', whenIdle: async () => { throw new Error('cannot observe activity'); } } },
    { activity: [{ kind: 'job', items: [{ id: 'job-1' }] }] },
    { unmaterialized: true },
  ]) {
    const { result } = await basicArchive(options);
    assert.equal(result.sessions.length, 0);
    assert.match(result.skipped[0].reason, /active|busy|running|pending|incomplete/);
  }
});

test('adapter skips incomplete tools and pending durable inboxes without cancelling live work', async () => {
  const unbalanced = basicEvents().slice(0, 2);
  const pending = basicEvents(); pending.push({ seq: 3, time: 1003, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'queued', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do work' }] }] } });
  for (const events of [unbalanced, pending]) {
    const { result } = await basicArchive({ events });
    assert.equal(result.sessions.length, 0); assert.match(result.skipped[0].reason, /incomplete|pending/);
  }
});

test('adapter guards high-water changes and a newly persisted session before checkpoint queueing', async () => {
  const { fixture, result, root } = await basicArchive();
  fixture.live.seq += 1;
  await assert.rejects(result.verifyUnchanged(), /active/);
  fixture.live.seq -= 1;
  fixture.records.set('another-session', { header: { ...fixture.source.header, id: 'another-session', cwd: root }, events: [], inheritedEventCount: 0, revision: 'new', sizeBytes: 100 });
  await assert.rejects(result.verifyUnchanged(), /active project session set/);
});

test('adapter detects same-length durable revision edits before checkpoint queueing', async () => {
  const { fixture, result } = await basicArchive(); fixture.source.revision = 'foreign-revision';
  await assert.rejects(result.verifyUnchanged(), /active session changed/);
});

test('adapter archives unknown ignorable and goal events but refuses resumable import', async () => {
  for (const event of [{ type: 'other-plugin/record', ignorable: true, data: {} }, { type: 'goal/change', data: { operation: 'create' } }]) {
    const events = [...basicEvents(), { seq: 3, time: 1003, ...event }];
    const { api, result } = await basicArchive({ events }); assert.equal(result.sessions.length, 1);
    const restored = await restoredProject(result.sessions[0].data);
    const fixture = fixtureContext(restored.root);
    const imported = await api.importProjectSessions(fixture.ctx, restored);
    assert.equal(imported.imported.length, 0); assert.match(imported.skipped[0].reason, /unsupported/); assert.equal(fixture.created.length, 0);
  }
});

test('adapter restores a new independent durable session without creating any agent', async () => {
  const events = [...basicEvents(), { seq: 3, time: 1003, type: 'session/end-seed', data: { inherited: true } }];
  const { api, result } = await basicArchive({ events, header: { isSeeded: true, parentSession: 'remote-parent', agentPreset: 'remote-executable-preset' }, inheritedEventCount: 3 });
  const restored = await restoredProject(result.sessions[0].data), fixture = fixtureContext(restored.root);
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.deepEqual(imported.skipped, []); assert.deepEqual(imported.failed, []);
  assert.equal(imported.imported[0].sessionId, 'session-new'); assert.equal(imported.imported[0].workspaceAttached, true);
  const stored = fixture.created[0];
  assert.equal(stored.header.cwd, restored.root); assert.equal(stored.header.parentSession, undefined); assert.equal(stored.header.agentPreset, undefined); assert.equal(stored.header.origin, undefined);
  assert.equal(stored.header.delegationDepth, 0); assert.equal(stored.inheritedEventCount, 3);
  assert.match(stored.events[1].data.content[0].text, /C:\\old\\project/);
  assert.ok(stored.sizeBytes > 0); assert.ok(fixture.handles.every(handle => handle.closed));
});

test('adapter verifies the session blob hash and size, not just parsed identity', async () => {
  const { api, result } = await basicArchive(), restored = await restoredProject(result.sessions[0].data), fixture = fixtureContext(restored.root);
  await fs.appendFile(path.join(restored.meta, 'sessions', 'session-source.json'), ' ');
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.match(imported.skipped[0].reason, /hash or size/); assert.equal(fixture.created.length, 0);
});

test('adapter refuses unsupported envelopes, identity substitution, and a pending imported inbox', async () => {
  const { api, result } = await basicArchive();
  const alterations = [
    envelope => { envelope.version = 2; },
    envelope => { envelope.header.id = 'some-other-session'; },
    envelope => { envelope.events.push({ seq: 3, time: 1003, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'pending', role: 'user', source: { kind: 'user' }, content: [] }] } }); },
  ];
  for (const alter of alterations) {
    const envelope = copy(result.sessions[0].data); alter(envelope);
    const restored = await restoredProject(envelope), fixture = fixtureContext(restored.root);
    const imported = await api.importProjectSessions(fixture.ctx, restored);
    assert.equal(imported.imported.length, 0); assert.equal(fixture.created.length, 0);
  }
});

test('adapter rejects INCOMPLETE before any provider mutation', async () => {
  const { api, result } = await basicArchive(), restored = await restoredProject(result.sessions[0].data), fixture = fixtureContext(restored.root);
  await fs.writeFile(path.join(restored.meta, 'INCOMPLETE'), 'not done');
  await assert.rejects(api.importProjectSessions(fixture.ctx, restored), /incomplete/); assert.equal(fixture.created.length, 0);
});

test('adapter archives only provider-owned assets and re-admits exact image and file references', async () => {
  const image = Buffer.from('mock-normalized-image'), file = Buffer.from('mock-uploaded-file');
  const imageRef = { attachmentId: `sha256:${sha256(image)}`, mediaType: 'image/png', width: 2, height: 2, bytes: image.length, name: 'photo.png' };
  const fileRef = { attachmentId: `sha256:${sha256(file)}`, bytes: file.length, name: 'input.txt' };
  const events = basicEvents(); events[1].data.content.push({ type: 'image', attachment: imageRef }, { type: 'file', attachment: fileRef });
  const { api, result } = await basicArchive({ events, assets: new Map([[sha256(image), image], [sha256(file), file]]) });
  assert.equal(result.assets.length, 2);
  const restored = await restoredProject(result.sessions[0].data, result.assets), fixture = fixtureContext(restored.root);
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.equal(imported.imported.length, 1); assert.equal(fixture.attachmentWrites.length, 2);
  assert.deepEqual(fixture.created[0].events[1].data.content.slice(1), events[1].data.content.slice(1));
});

test('adapter refuses corrupt assets before creating a session', async () => {
  const image = Buffer.from('mock-normalized-image'), events = basicEvents();
  events[1].data.content.push({ type: 'image', attachment: { attachmentId: `sha256:${sha256(image)}`, mediaType: 'image/png', width: 2, height: 2, bytes: image.length } });
  const { api, result } = await basicArchive({ events, assets: new Map([[sha256(image), image]]) });
  const restored = await restoredProject(result.sessions[0].data, result.assets), fixture = fixtureContext(restored.root);
  await fs.writeFile(path.join(restored.meta, 'assets', sha256(image)), Buffer.from('corrupt'));
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.match(imported.skipped[0].reason, /hash or size/); assert.equal(fixture.created.length, 0); assert.equal(fixture.attachmentWrites.length, 0);
});

test('adapter verifies project artifacts before mapping only deliverables structured paths', async () => {
  const events = basicEvents(); events.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { turn: 1, callId: 'present-call', files: [{ path: 'reports/result.txt', description: 'Result' }] } });
  const { api, result } = await basicArchive({ events });
  const restored = await restoredProject(result.sessions[0].data, [], { 'reports/result.txt': 'complete' }), fixture = fixtureContext(restored.root);
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.equal(imported.imported.length, 1);
  assert.equal(fixture.created[0].events[3].data.files[0].path, path.join(restored.root, 'reports', 'result.txt'));
  assert.equal(fixture.created[0].events[1].data.content[0].text, events[1].data.content[0].text);
});

test('adapter retains external deliverable metadata in archive but never reads or remaps it', async () => {
  const root = await temporaryRoot(), external = path.resolve(root, '..', 'DO-NOT-READ-secret.txt');
  const events = basicEvents(); events.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { turn: 1, callId: 'p', files: [{ path: external }] } });
  const fixture = fixtureContext(root, { events }), api = adapter(), result = await api.exportProjectSessions(fixture.ctx, root);
  assert.equal(result.sessions.length, 1); assert.equal(result.assets.length, 0); assert.equal(result.sessions[0].data.deliverables[0].external, true);
  const restored = await restoredProject(result.sessions[0].data), target = fixtureContext(restored.root);
  const imported = await api.importProjectSessions(target.ctx, restored);
  assert.match(imported.skipped[0].reason, /external deliverable/); assert.equal(target.created.length, 0);
});

test('adapter refuses missing selected project artifacts and identity collisions', async () => {
  const events = basicEvents(); events.push({ seq: 3, time: 1003, type: 'deliverables/presented', data: { turn: 1, callId: 'p', files: [{ path: 'not-captured.txt' }] } });
  const archived = await basicArchive({ events }), restored = await restoredProject(archived.result.sessions[0].data), fixture = fixtureContext(restored.root);
  const missing = await archived.api.importProjectSessions(fixture.ctx, restored);
  assert.match(missing.skipped[0].reason, /absent from checkpoint/); assert.equal(fixture.created.length, 0);
  const basic = await basicArchive(), other = await restoredProject(basic.result.sessions[0].data), target = fixtureContext(other.root);
  target.records.set('session-new', { header: { ...target.source.header, id: 'session-new' }, revision: 'existing', sizeBytes: 100, events: [], inheritedEventCount: 0 });
  const collision = await basic.api.importProjectSessions(target.ctx, other);
  assert.match(collision.skipped[0].reason, /collision/); assert.equal(target.created.length, 0);
});

test('adapter maps a foreign Windows cwd before invoking the target Host validator', async () => {
  const { api, result } = await basicArchive();
  const envelope = copy(result.sessions[0].data);
  envelope.sourceRoot = 'C:\\old-device\\project'; envelope.header.cwd = envelope.sourceRoot;
  const restored = await restoredProject(envelope), fixture = fixtureContext(restored.root);
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.equal(imported.imported.length, 1); assert.equal(fixture.created[0].header.cwd, restored.root);
});

test('adapter refuses provider image normalization that changes a recorded immutable identity', async () => {
  const image = Buffer.from('image'), events = basicEvents();
  events[1].data.content.push({ type: 'image', attachment: { attachmentId: `sha256:${sha256(image)}`, mediaType: 'image/png', width: 2, height: 2, bytes: image.length } });
  const { api, result } = await basicArchive({ events, assets: new Map([[sha256(image), image]]) });
  const restored = await restoredProject(result.sessions[0].data, result.assets), fixture = fixtureContext(restored.root);
  fixture.services.attachments.saveImage = async () => ({ attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: 'image/png', width: 2, height: 2, bytes: image.length });
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.match(imported.skipped[0].reason, /normalization changed/); assert.equal(fixture.created.length, 0);
});

test('adapter reports potentially durable partial-write failures and closes ownership', async () => {
  const { api, result } = await basicArchive(), restored = await restoredProject(result.sessions[0].data), fixture = fixtureContext(restored.root);
  let closed = false;
  fixture.services.sessionPersistence.create = async () => ({ async append() { throw new Error('simulated disk failure'); }, async flush() {}, async close() { closed = true; } });
  const imported = await api.importProjectSessions(fixture.ctx, restored);
  assert.equal(imported.imported.length, 0); assert.equal(imported.failed[0].mayHaveDurableSession, true); assert.equal(closed, true);
});

test('adapter propagates the native stream verifier refusal before creating sessions', async () => {
  const { result } = await basicArchive(), restored = await restoredProject(result.sessions[0].data), fixture = fixtureContext(restored.root);
  const sdk = mockSdk(); sdk.validateAssistantStreams = () => { throw new Error('bad native stream'); };
  const imported = await adapter(sdk).importProjectSessions(fixture.ctx, restored);
  assert.equal(imported.imported.length, 0); assert.equal(fixture.created.length, 0);
});

test('adapter fails closed when native SDK loading fails', async () => {
  const root = await temporaryRoot(), fixture = fixtureContext(root);
  const api = createDshAdapter({ loadSdk: async () => { throw new Error('missing host SDK'); } });
  await assert.rejects(api.exportProjectSessions(fixture.ctx, root), /missing host SDK/);
});
