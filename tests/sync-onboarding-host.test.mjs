import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';
import { cloneDirectoryName } from '../plugin/sync-onboarding-picker.mjs';
import { measureSyncStorage } from '../src/sync-budget.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-onboarding-password';
const auth = async service => { const value = await service.syncstatus(); return { revision: value.revision, server: value.server, username: value.username }; };
async function fixture(t, options = {}) {
  await fs.mkdir(parent, { recursive: true }); const directory = await fs.mkdtemp(path.join(parent, 'onboarding-'));
  const destinations = path.join(directory, 'destinations'), home = path.join(directory, 'host'), profileDir = path.join(home, 'profile');
  await fs.mkdir(destinations); await fs.mkdir(profileDir, { recursive: true });
  const server = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`, requests = []; server.on('request', request => requests.push({ method: request.method, url: request.url }));
  const cloud = new SyncV2Client({ server: url }); await cloud.loginRenewable({ username: 'owner', password, deviceId: 'seed-device' });
  const records = new Map(), workspaces = new Map();
  for (const name of ['one', 'two']) { const root = path.join(directory, `local-${name}`); await fs.mkdir(root); await fs.writeFile(path.join(root, `${name}.txt`), name); workspaces.set(name, { id: name, path: root, title: `Local ${name}` }); }
  let capability = { kind: 'native', pick: async () => destinations }, provider = { capability: () => capability }, createHook, faultHook = options.fault, creates = 0, clock = Date.now();
  const registry = { list: () => [...workspaces.values()], get: id => workspaces.get(id), create: async (root, label) => { creates++; if (createHook) return createHook(root, label); const value = { id: randomUUID(), path: root, title: label }; assert.equal((await fs.stat(root)).isDirectory(), true); workspaces.set(value.id, value); return value; } };
  const ctx = { workspaceRegistry: registry, get: name => name === 'directoryPicker' ? provider : undefined, credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, callback) => { const value = await callback(records.get(key)); if (value !== undefined) records.set(key, value); }, deleteRecord: async key => records.delete(key) } };
  const mounts = [];
  function mount() {
    const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync'), server: url, username: 'owner' }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false });
    const legacy = createSettingsService(ctx, controller, { profileDir, dshHome: home });
    const service = withBidirectionalSync(ctx, controller, legacy, { profileDir, dshHome: home, isIdle: async () => true, enableWatchers: false, now: () => clock, onboardingFault: (...args) => faultHook?.(...args) });
    const value = { service, controller, legacy }; mounts.push(value); return value;
  }
  const first = mount(); await first.service.login({ server: url, username: 'owner', password, remember: true });
  t.after(async () => { for (const value of mounts) { value.service.stopBidirectional(); value.controller.stop(); } await Promise.all(mounts.flatMap(value => [value.controller.drain(), value.service.drainBidirectional()])); await closeSyncServer(server); assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent)); assert.match(path.basename(directory), /^onboarding-[A-Za-z0-9]+$/); await fs.rm(directory, { recursive: true, force: true }); });
  async function seed(projectId, label = 'Cloud Project', contents = 'remote') {
    const bytes = Buffer.from(contents); await cloud.uploadBlob(sha256(bytes), bytes);
    const head = await cloud.syncHead(projectId), manifest = { version: 2, id: randomUUID(), projectId, deviceId: cloud.deviceId, parentId: head?.id ?? null, policyRevision: 1, label, files: [{ path: 'hello.txt', hash: sha256(bytes), size: bytes.length, executable: false }], tombstones: [], conflicts: [], archiveRefs: [] };
    await cloud.commitSync({ requestId: randomUUID(), expectedHeadRevision: head?.revision ?? 0, expectedHeadId: head?.id ?? null, manifest });
  }
  async function seedLegacy(projectId, id, contents = 'old') { const bytes = Buffer.from(contents); await cloud.uploadBlob(sha256(bytes), bytes); await cloud.commit({ version: 1, id, projectId, deviceId: cloud.deviceId, parentId: null, createdAt: '2026-01-01T00:00:00.000Z', sourceRoot: '/old/Legacy Cloud', sessionIds: [], files: [{ path: 'project/hello.txt', sha256: sha256(bytes), size: bytes.length }] }); }
  return { ...first, ctx, directory, destinations, cloud, requests, records, workspaces, registry, seed, seedLegacy, mount,
    advance: ms => { clock += ms; }, setFault: fn => { faultHook = fn; }, setCreate: fn => { createHook = fn; }, setCapability: value => { capability = value; }, replaceProvider: () => { provider = { capability: () => capability }; }, get creates() { return creates; } };
}
async function planClone(f, projectIds) { const input = await auth(f.service), picked = await f.service.syncclonepick({ ...input, projectIds }); const planned = await f.service.synccloneplan({ ...input, destinationId: picked.destination.id }); return { input, picked, planned, request: { ...input, planId: planned.plan?.id, requestId: randomUUID(), confirm: true } }; }
const mutations = requests => requests.filter(item => ['POST', 'PUT', 'DELETE'].includes(item.method));

test('multi-cloud preview is inert and one confirmation creates separate new roots then normal bidirectional bindings', async t => {
  const f = await fixture(t); await f.seed('cloud-one'); await f.seed('cloud-two'); f.requests.length = 0;
  const { planned, request } = await planClone(f, ['cloud-one', 'cloud-two']);
  assert.equal(planned.plan.items.length, 2); assert.notEqual(planned.plan.items[0].root, planned.plan.items[1].root); assert.deepEqual(await fs.readdir(f.destinations), []); assert.equal(f.creates, 0); assert.equal(mutations(f.requests).length, 0);
  await assert.rejects(f.service.syncclonecommit({ ...request, confirm: false }), { code: 'BAD_REQUEST' });
  assert.deepEqual(await f.service.syncclonecommit(request), { accepted: true, operationId: request.requestId }); await f.service.drainBidirectional();
  const status = await f.service.syncstatus(), batch = status.onboarding.find(item => item.id === request.requestId);
  assert.equal(batch.state, 'succeeded', JSON.stringify(batch)); assert.equal(status.bindings.length, 2); assert.equal(f.creates, 2); assert.equal(mutations(f.requests).length, 0);
  for (const item of batch.items) { assert.equal(item.state, 'succeeded'); assert.equal(await fs.readFile(path.join(item.root, 'hello.txt'), 'utf8'), 'remote'); }
  assert.deepEqual(await f.service.syncclonecommit(request), { accepted: true, operationId: request.requestId }); assert.equal(f.creates, 2);
  const binding = status.bindings[0]; await fs.writeFile(path.join(binding.root, 'after-first-pull.txt'), 'normal opted-in edit');
  await f.service.syncrun({ ...await auth(f.service), bindingId: binding.id, requestId: 'normal-run' }); await f.service.drainBidirectional();
  const head = await f.cloud.syncHead(binding.projectId), manifest = await f.cloud.syncCheckpoint(binding.projectId, head.id, head.manifestDigest); assert.ok(manifest.files.some(item => item.path === 'after-first-pull.txt'));
});

test('multi-local publish negotiates unknown capabilities itself, does not spool preview, and allocates separate cloud projects', async t => {
  const f = await fixture(t), input = await auth(f.service); assert.equal((await f.service.syncstatus()).capability, 'unknown');
  const plan = await f.service.syncpublishplan({ ...input, workspaceIds: ['one', 'two'] });
  assert.equal((await f.service.syncstatus()).capability, 'supported'); assert.equal(plan.plan.items.length, 2); assert.notEqual(plan.plan.items[0].projectId, plan.plan.items[1].projectId);
  assert.deepEqual(await fs.readdir(path.join(f.controller.store.directory, 'blobs')), [], 'preview never spools captured file contents');
  const request = { ...input, planId: plan.plan.id, requestId: 'publish-batch', confirm: true };
  await f.service.syncpublishcommit(request); await f.service.drainBidirectional();
  const status = await f.service.syncstatus(); assert.equal(status.onboarding[0].state, 'succeeded', JSON.stringify(status.onboarding)); assert.equal(status.bindings.length, 2); assert.equal(f.creates, 0);
  for (const item of plan.plan.items) { const head = await f.cloud.syncHead(item.projectId); assert.equal(head.revision, 1); assert.equal(f.workspaces.get(item.workspaceId).path, item.root); }
  await assert.rejects(f.service.syncpublishcommit({ ...request, planId: randomUUID() }), { code: 'SYNC_REQUEST_CONFLICT' });
  await f.service.syncpublishcommit(request); assert.equal((await f.service.syncstatus()).onboarding.length, 1);
});

test('late mkdir race never adopts, merges, registers or deletes user directory; later batch items still finish', async t => {
  const f = await fixture(t); await f.seed('first'); await f.seed('second');
  const { request, planned } = await planClone(f, ['first', 'second']); let raced = false;
  f.setFault(async (phase, item) => { if (phase === 'before-mkdir' && !raced) { raced = true; await fs.mkdir(item.root); await fs.writeFile(path.join(item.root, 'user.txt'), 'keep me'); } });
  await f.service.syncclonecommit(request); await f.service.drainBidirectional();
  const batch = (await f.service.syncstatus()).onboarding[0]; assert.equal(batch.state, 'partial', JSON.stringify(batch)); assert.equal(batch.items[0].errorCode, 'DESTINATION_EXISTS'); assert.equal(batch.items[1].state, 'succeeded');
  assert.equal(await fs.readFile(path.join(planned.plan.items[0].root, 'user.txt'), 'utf8'), 'keep me'); assert.equal(f.creates, 1);
});

test('registry create that writes then throws remains uncertain and is never blindly replayed, even after restart', async t => {
  const f = await fixture(t); await f.seed('cloud'); const { request } = await planClone(f, ['cloud']);
  f.setCreate(async (root, title) => { const workspace = { id: 'written-before-lost-ack', path: root, title }; f.workspaces.set(workspace.id, workspace); throw new Error('lost native ACK'); });
  await f.service.syncclonecommit(request); await f.service.drainBidirectional();
  const batch = (await f.service.syncstatus()).onboarding[0]; assert.equal(batch.state, 'uncertain'); assert.equal(batch.items[0].errorCode, 'PROJECT_REGISTRATION_UNCERTAIN'); assert.equal((await f.service.syncstatus()).bindings.length, 0);
  await f.service.syncclonecommit(request); await f.service.tickBidirectional(); assert.equal(f.creates, 1);
  f.service.stopBidirectional(); f.controller.stop(); await f.controller.drain(); const next = f.mount();
  await next.service.tickBidirectional(); await next.service.drainBidirectional(); await next.service.syncclonecommit(request); assert.equal(f.creates, 1);
  await assert.rejects(next.service.pairplan({ ...await auth(next.service), workspaceId: 'written-before-lost-ack', projectId: 'cloud' }), { code: 'SYNC_APPLY_INCOMPLETE' });
});

test('new root contaminated before first pull never captures/uploads racer and never becomes timer-managed', async t => {
  const f = await fixture(t); await f.seed('cloud'); const { request, planned } = await planClone(f, ['cloud']); f.requests.length = 0;
  f.setFault(async (phase, item) => { if (phase === 'root-owned') await fs.writeFile(path.join(item.root, 'private.txt'), 'never upload this'); });
  await f.service.syncclonecommit(request); await f.service.drainBidirectional();
  const status = await f.service.syncstatus(); assert.equal(status.onboarding[0].items[0].errorCode, 'SYNC_LOCAL_CHANGED'); assert.equal(status.bindings.length, 0); assert.equal(f.creates, 0);
  f.advance(30_000); await f.service.tickBidirectional(); assert.equal(mutations(f.requests).length, 0); assert.equal(await fs.readFile(path.join(planned.plan.items[0].root, 'private.txt'), 'utf8'), 'never upload this');
});

test('opaque picker enforces provider, revision and parent identity before any directory effects', async t => {
  const f = await fixture(t); await f.seed('cloud'); const first = await planClone(f, ['cloud']); f.replaceProvider();
  await assert.rejects(f.service.syncclonecommit(first.request), { code: 'DIRECTORY_PICKER_EXPIRED' }); assert.deepEqual(await fs.readdir(f.destinations), []);
  const second = await planClone(f, ['cloud']), moved = path.join(f.directory, 'old-destinations');
  assert.equal(path.dirname(f.destinations), f.directory); assert.equal(path.dirname(moved), f.directory); await fs.rename(f.destinations, moved); await fs.mkdir(f.destinations);
  await assert.rejects(f.service.syncclonecommit(second.request), { code: 'DESTINATION_CHANGED' }); assert.equal(f.creates, 0);
});

test('browse picker only accepts issued nodes and never calls native createDirectory during preview', async t => {
  const f = await fixture(t); await f.seed('cloud'); const child = path.join(f.destinations, 'child'); await fs.mkdir(child);
  const listing = root => ({ path: root, home: f.destinations, crumbs: [{ name: 'destinations', path: f.destinations, hidden: false }], entries: root === f.destinations ? [{ name: 'child', path: child, hidden: false }] : [], truncated: false });
  f.setCapability({ kind: 'browse', list: async value => listing(value ?? f.destinations), createDirectory: async () => assert.fail('no preview create') });
  const input = await auth(f.service), picked = await f.service.syncclonepick({ ...input, projectIds: ['cloud'] }); assert.equal(picked.browser.directories.length, 1);
  await assert.rejects(f.service.syncclonebrowse({ ...input, browserId: picked.browser.id, nodeId: 'forged' }), { code: 'DIRECTORY_PICKER_EXPIRED' });
  const selected = await f.service.synccloneselect({ ...input, browserId: picked.browser.id, nodeId: picked.browser.directories[0].id }); assert.equal(selected.destination.parent, child); assert.deepEqual(await fs.readdir(child), []);
});

test('legacy multi-head cloud clone requires explicit primary and migrates without uploading local bytes', async t => {
  const f = await fixture(t); await f.seedLegacy('legacy', 'old-a', 'A'); await f.seedLegacy('legacy', 'old-b', 'B');
  const input = await auth(f.service), picked = await f.service.syncclonepick({ ...input, projectIds: ['legacy'] });
  const choice = await f.service.synccloneplan({ ...input, destinationId: picked.destination.id }); assert.equal(choice.requiresLegacyChoice, true); assert.equal(choice.choices[0].heads.length, 2);
  const planned = await f.service.synccloneplan({ ...input, destinationId: picked.destination.id, primaryLegacyIds: [{ projectId: 'legacy', checkpointId: 'old-a' }] }); assert.equal(planned.plan.items[0].migrationRequired, true); f.requests.length = 0;
  await f.service.syncclonecommit({ ...input, planId: planned.plan.id, requestId: 'legacy-clone', confirm: true }); await f.service.drainBidirectional();
  const status = await f.service.syncstatus(); assert.equal(status.onboarding[0].state, 'succeeded', JSON.stringify(status.onboarding)); assert.equal(status.bindings[0].conflicts, 1);
  assert.equal(f.requests.filter(item => item.method === 'PUT').length, 0); assert.equal(await fs.readFile(path.join(planned.plan.items[0].root, 'hello.txt'), 'utf8'), 'A');
  assert.equal((await f.cloud.getCheckpoint('old-b')).id, 'old-b');
});

test('new publish refuses surprise canonical or legacy project identities instead of adopting them', async t => {
  for (const kind of ['canonical', 'legacy']) {
    const f = await fixture(t), input = await auth(f.service), planned = await f.service.syncpublishplan({ ...input, workspaceIds: ['one'] }), projectId = planned.plan.items[0].projectId;
    if (kind === 'canonical') await f.seed(projectId); else await f.seedLegacy(projectId, 'foreign-legacy');
    await assert.rejects(f.service.syncpublishcommit({ ...input, planId: planned.plan.id, requestId: randomUUID(), confirm: true }), { code: kind === 'canonical' ? 'SYNC_HEAD_MISMATCH' : 'SYNC_MIGRATION_REQUIRED' });
    assert.equal((await f.service.syncstatus()).bindings.length, 0);
  }
});

test('offline initial publication retains durable create-only fence across foreign genesis, resume, old pair API and restart', async t => {
  const f = await fixture(t), input = await auth(f.service), planned = await f.service.syncpublishplan({ ...input, workspaceIds: ['one'] });
  const unavailable = t.mock.method(SyncV2Client.prototype, 'capabilities', async () => { throw Object.assign(new Error('synthetic offline'), { code: 'SERVER_UNAVAILABLE' }); });
  await f.service.syncpublishcommit({ ...input, planId: planned.plan.id, requestId: 'offline-publish', confirm: true }); await f.service.drainBidirectional(); unavailable.mock.restore();
  let status = await f.service.syncstatus(); assert.equal(status.onboarding[0].state, 'failed'); assert.equal(status.bindings[0].errorCode, 'SYNC_COMMIT_UNCERTAIN'); assert.equal(status.bindings[0].enabled, false);
  const binding = status.bindings[0]; await f.seed(binding.projectId, 'Foreign genesis', 'foreign bytes');
  await assert.rejects(f.service.syncpause({ ...await auth(f.service), bindingId: binding.id, enabled: true }), { code: 'SYNC_COMMIT_UNCERTAIN' });
  await assert.rejects(f.service.pairplan({ ...await auth(f.service), workspaceId: 'one', projectId: binding.projectId }), { code: 'SYNC_COMMIT_UNCERTAIN' });
  await assert.rejects(f.service.syncrun({ ...await auth(f.service), bindingId: binding.id, requestId: 'unsafe-run' }), { code: 'SYNC_COMMIT_UNCERTAIN' });
  f.requests.length = 0; f.advance(60_000); await f.service.tickBidirectional(); assert.equal(mutations(f.requests).length, 0);
  f.service.stopBidirectional(); f.controller.stop(); await f.controller.drain(); const next = f.mount(); status = await next.service.syncstatus(); assert.equal(status.bindings[0].errorCode, 'SYNC_COMMIT_UNCERTAIN');
  await assert.rejects(next.service.syncpause({ ...await auth(next.service), bindingId: binding.id, enabled: true }), { code: 'SYNC_COMMIT_UNCERTAIN' });
  assert.equal(await fs.readFile(path.join(binding.root, 'one.txt'), 'utf8'), 'one'); await assert.rejects(fs.stat(path.join(binding.root, 'hello.txt')), { code: 'ENOENT' });
});

test('uncertain first publication preserves its receipt journal and never permits generic replay', async t => {
  const f = await fixture(t), input = await auth(f.service), planned = await f.service.syncpublishplan({ ...input, workspaceIds: ['one'] });
  const commit = SyncV2Client.prototype.commitSync; let calls = 0;
  const lostAck = t.mock.method(SyncV2Client.prototype, 'commitSync', async function(request) { calls++; await commit.call(this, request); throw new Error('synthetic lost commit ACK'); });
  await f.service.syncpublishcommit({ ...input, planId: planned.plan.id, requestId: 'uncertain-publish', confirm: true }); await f.service.drainBidirectional(); lostAck.mock.restore();
  const status = await f.service.syncstatus(), binding = status.bindings[0]; assert.equal(status.onboarding[0].state, 'uncertain'); assert.equal(binding.errorCode, 'SYNC_COMMIT_UNCERTAIN');
  const journal = JSON.parse(await fs.readFile(path.join(f.controller.store.directory, 'v2', binding.id, 'engine.json'), 'utf8')); assert.equal(journal.pending.phase, 'commit-uncertain');
  assert.ok(await f.cloud.syncReceipt(binding.projectId, journal.pending.requestId));
  await assert.rejects(f.service.syncpause({ ...await auth(f.service), bindingId: binding.id, enabled: true }), { code: 'SYNC_COMMIT_UNCERTAIN' });
  await f.service.tickBidirectional(); assert.equal(calls, 1); assert.equal((await f.cloud.syncHead(binding.projectId)).revision, 1);
});

test('unknown mkdir result never acquires ownership by path after restart', async t => {
  const f = await fixture(t); await f.seed('cloud'); const { request, planned } = await planClone(f, ['cloud']), target = planned.plan.items[0].root;
  const mkdir = fs.mkdir; let attempted = false;
  const interrupted = t.mock.method(fs, 'mkdir', async (root, ...args) => { if (root === target && !attempted) { attempted = true; await mkdir(root, ...args); throw new Error('synthetic lost mkdir acknowledgement'); } return mkdir(root, ...args); });
  await f.service.syncclonecommit(request); await f.service.drainBidirectional(); interrupted.mock.restore();
  const status = await f.service.syncstatus(); assert.equal(status.onboarding[0].state, 'uncertain'); assert.equal(status.onboarding[0].items[0].phase, 'mkdir-started'); assert.equal(f.creates, 0); assert.deepEqual(await fs.readdir(target), []);
  const config = JSON.parse(await fs.readFile(f.service.bidirectionalFilename, 'utf8')); assert.equal(config.onboarding[0].items[0].rootIdentity, undefined);
  await f.service.tickBidirectional(); await f.service.syncclonecommit(request); assert.equal(f.creates, 0);
});

test('failed unregistered clone staging still consumes the shared profile quota', async t => {
  const f = await fixture(t); await f.seed('large', 'Large', 'x'.repeat(128 * 1024)); const first = await planClone(f, ['large']);
  f.setCreate(async () => { throw new Error('synthetic native unavailable'); });
  await f.service.syncclonecommit(first.request); await f.service.drainBidirectional();
  assert.equal((await f.service.syncstatus()).bindings.length, 0);
  const stateOnly = await measureSyncStorage({ stateDir: f.controller.store.directory, bindings: [] }); assert.equal(stateOnly.complete, true);
  const config = JSON.parse(await fs.readFile(f.service.bidirectionalFilename, 'utf8')); config.quotaBytes = stateOnly.bytes + 64 * 1024; await fs.writeFile(f.service.bidirectionalFilename, JSON.stringify(config));
  await f.seed('small', 'Small'); const second = await planClone(f, ['small']);
  await assert.rejects(f.service.syncclonecommit(second.request), { code: 'SYNC_QUOTA' });
  await assert.rejects(fs.stat(second.planned.plan.items[0].root), { code: 'ENOENT' }); assert.equal(f.creates, 1);
});

test('portable cloud label sanitizer and removed v1 RPC boundary remain intact', async t => {
  for (const label of ['CON', '..', '.ssh', 'credentials.json', '']) assert.equal(cloneDirectoryName(label), 'project');
  assert.equal(cloneDirectoryName('two/projects:cloud'), 'two-projects-cloud');
  const f = await fixture(t), bridge = createSettingsHttp(f.service);
  for (const action of ['destinationpick', 'destinationbrowse', 'destinationselect', 'restore', 'registerproject']) assert.equal((await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST' }))).status, 404);
});
