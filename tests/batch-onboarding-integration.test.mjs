import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBidirectionalController } from '../client/bidirectional-state.mjs';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';

// Real production UI state -> native RPC envelope -> Host -> loopback server/disk.
// Native carrier/registry/credentials/chooser are synthetic; this is not live GUI.
const base = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
const password = 'synthetic-batch-onboarding-password';
const diagnostic = ui => JSON.stringify({ ready: ui.getSnapshot().ready, error: ui.getSnapshot().error, dialog: ui.getSnapshot().dialog });
const absent = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'batch-onboarding-integration-'));
  const mounts = [], requests = [];
  const cloud = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password });
  cloud.on('request', request => requests.push({ method: request.method, path: new URL(request.url, 'http://synthetic.invalid').pathname }));
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`;
  t.after(async () => {
    for (const mount of mounts) { mount.ui.dispose(); mount.bridge.dispose(); mount.service.stopBidirectional(); mount.host.stop(); }
    await Promise.all(mounts.flatMap(mount => [mount.host.drain(), mount.service.drainBidirectional()]));
    await closeSyncServer(cloud);
    assert.equal(path.dirname(directory), base); assert.match(path.basename(directory), /^batch-onboarding-integration-[A-Za-z0-9]+$/);
    assert.equal(await fs.realpath(directory), directory); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(directory, { recursive: true, maxRetries: 3 });
  });
  async function mount(name, { locals = 0, browse = false, partialRegistration = false } = {}) {
    assert.match(name, /^[a-z]+$/);
    const home = path.join(directory, `host-${name}`), profileDir = path.join(home, 'profile'), parent = path.join(directory, `destination-${name}`);
    await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(parent);
    const roots = [], records = new Map(), registry = new Map(), calls = [], created = [];
    let pickerCalls = 0, dropAck = false;
    for (let i = 0; i < locals; i++) {
      const root = path.join(directory, `source-${name}-${i}`); await fs.mkdir(root); await fs.writeFile(path.join(root, 'hello.txt'), `Synthetic ${name} ${i}`); roots.push(root);
      registry.set(`${name}-${i}`, { id: `${name}-${i}`, path: root, title: 'Shared Project', sessionIds: [] });
    }
    const capability = browse ? { kind: 'browse', list: async requested => {
      pickerCalls++; assert.ok(requested === undefined || requested === parent);
      return { path: parent, home: parent, crumbs: [{ name: path.basename(parent), path: parent, hidden: false }], entries: [], truncated: false };
    } } : { kind: 'native', pick: async () => { pickerCalls++; return parent; } };
    // The pinned native seam promises one stable capability per service lifetime.
    const picker = { capability: () => capability };
    const context = {
      get: key => key === 'directoryPicker' ? picker : undefined,
      workspaceRegistry: { list: () => [...registry.values()], get: id => registry.get(id), async create(root, title) {
        assert.equal(path.dirname(root), parent); assert.equal(await fs.realpath(root), root);
        const row = { id: `created-${name}-${created.length}`, path: root, title, sessionIds: [] };
        registry.set(row.id, row); created.push(row);
        if (partialRegistration && created.length === 2) throw new Error('synthetic registry wrote then lost acknowledgment');
        return row;
      } },
      credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, update) => { const value = await update(records.get(key)); if (value !== undefined) records.set(key, value); }, deleteRecord: async key => records.delete(key) },
      sessions: { list: () => [], create() { assert.fail('Onboarding never creates sessions'); } },
      sessionPersistence: { list: async () => [] },
      agents: { get: () => undefined, create() { assert.fail('Onboarding never starts agents'); } },
      async waterfall(name, _input, fallback) { assert.equal(name, 'workspace/session-activity'); return fallback(); },
    };
    const host = createController(context, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
      exportSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }), importSessions: async () => assert.fail('No implicit native imports') });
    const legacy = createSettingsService(context, host, { profileDir, dshHome: home });
    const service = withBidirectionalSync(context, host, legacy, { profileDir, dshHome: home, enableWatchers: false });
    const bridge = createSettingsHttp(service);
    const connection = { rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); const action = endpoint.slice('dsh-personal-sync/'.length), rpcId = `${name}-${calls.length}`;
      const entry = { action, payload: action === 'login' ? { server: payload.server, username: payload.username } : structuredClone(payload) }; calls.push(entry);
      const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }) }));
      assert.equal(response.status, 200); const envelope = await response.json(); assert.equal(envelope.rpcId, rpcId); assert.equal(envelope.type, 'server-response');
      entry.result = envelope.result;
      if (dropAck && action === 'syncclonecommit' && envelope.result.ok && envelope.result.value?.accepted) { dropAck = false; throw new Error('synthetic lost accepted clone ACK'); }
      return envelope.result;
    } } };
    const ui = createBidirectionalController(connection, { timeoutMs: 90_000 });
    const mounted = { parent, roots, registry, records, host, service, bridge, calls, ui, created, connection,
      get pickerCalls() { return pickerCalls; }, dropNextCloneAck() { dropAck = true; }, cloudClient() { return new SyncV2Client(records.get(host.credentialKey).payload); } };
    mounts.push(mounted);
    const login = await connection.rpc.call('/api', 'dsh-personal-sync/login', { server, username: 'owner', password, remember: true });
    assert.equal(login.ok, true); ui.setIdentity(login.value); assert.equal(await ui.refresh(), true, diagnostic(ui));
    return mounted;
  }
  return { directory, server, requests, mount };
}
async function settle(mount, requestId) {
  await mount.service.drainBidirectional(); await mount.host.drain();
  assert.equal(await mount.ui.refresh(), true, diagnostic(mount.ui));
  const batch = mount.ui.getSnapshot().status.onboarding.find(item => item.id === requestId);
  assert.ok(batch, 'original request survives as the durable batch id'); return batch;
}
async function publish(mount) {
  const ui = mount.ui;
  assert.equal(await ui.openPublish(), true, diagnostic(ui));
  for (const id of mount.registry.keys()) assert.equal(ui.selectOnboarding(id, true), true);
  assert.equal(mount.calls.some(call => call.action === 'syncprojects'), false, 'local picker never loads cloud inventory');
  assert.equal(await ui.planPublish(), true, diagnostic(ui));
  const plan = ui.getSnapshot().dialog.plan; assert.ok(plan); assert.equal(plan.items.length, mount.roots.length);
  assert.equal(await ui.confirmPublish(plan), true, diagnostic(ui));
  assert.equal(await ui.confirmPublish(plan), false);
  const call = mount.calls.find(call => call.action === 'syncpublishcommit'); assert.ok(call);
  assert.equal(call.result.value.operationId, call.payload.requestId);
  const batch = await settle(mount, call.payload.requestId); assert.equal(batch.state, 'succeeded', JSON.stringify(batch));
  assert.equal(batch.items.length, mount.roots.length); return plan.items.map(item => item.projectId);
}
async function clonePlan(mount, ids) {
  const ui = mount.ui;
  assert.equal(await ui.openClone(), true, diagnostic(ui));
  for (const id of ids) assert.equal(ui.selectOnboarding(id, true), true, diagnostic(ui));
  assert.equal(await ui.pickCloneParent(), true, diagnostic(ui));
  if (ui.getSnapshot().dialog.browser) assert.equal(await ui.selectCloneParent(), true, diagnostic(ui));
  const destination = ui.getSnapshot().dialog.destination; assert.ok(destination); assert.equal(destination.parent, mount.parent);
  assert.equal(destination.items.length, ids.length); assert.equal(mount.created.length, 0);
  for (const item of destination.items) { assert.equal(path.dirname(item.root), mount.parent); await absent(item.root); }
  assert.equal(await ui.planClone(), true, diagnostic(ui));
  const plan = ui.getSnapshot().dialog.plan; assert.ok(plan); assert.equal(plan.items.length, ids.length);
  for (const item of plan.items) { assert.equal(item.summary.upload, 0); assert.equal(item.summary.delete, 0); await absent(item.root); }
  assert.equal(mount.created.length, 0); return plan;
}

test('batch publish and cloud-first clone traverse production RPC, create fresh folders and continue bidirectionally', { timeout: 180_000 }, async t => {
  const f = await fixture(t), source = await f.mount('source', { locals: 2 });
  const ids = await publish(source), target = await f.mount('target');
  const existing = path.join(target.parent, 'Shared Project'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'keep.txt'), 'Never overwrite this existing directory');
  const plan = await clonePlan(target, ids);
  assert.equal(new Set(plan.items.map(item => item.root.toLowerCase())).size, 2);
  assert.ok(plan.items.every(item => item.root !== existing));
  const before = f.requests.length; target.dropNextCloneAck();
  assert.equal(await target.ui.confirmClone(plan), false, 'lost ACK is not reported as known success');
  assert.equal(await target.ui.confirmClone(plan), false, 'the same intent cannot be sent twice');
  const commits = target.calls.filter(call => call.action === 'syncclonecommit'); assert.equal(commits.length, 1);
  assert.deepEqual(Object.keys(commits[0].payload).sort(), ['confirm', 'planId', 'requestId', 'revision', 'server', 'username'].sort());
  const batch = await settle(target, commits[0].payload.requestId);
  assert.equal(batch.state, 'succeeded', JSON.stringify(batch)); assert.equal(target.created.length, 2);
  assert.ok(f.requests.slice(before).every(request => request.method === 'GET'), 'initial clone never uploads or commits local contents');
  for (let i = 0; i < ids.length; i++) {
    const item = batch.items.find(row => row.projectId === ids[i]);
    assert.equal(await fs.readFile(path.join(item.root, 'hello.txt'), 'utf8'), `Synthetic source ${i}`);
    assert.ok(target.ui.getSnapshot().status.bindings.some(binding => binding.projectId === ids[i] && binding.root === item.root && binding.workspaceId === item.workspaceId && binding.enabled));
  }
  assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'Never overwrite this existing directory');
  assert.deepEqual(await fs.readdir(existing), ['keep.txt']);
  const repeat = await target.connection.rpc.call('/api', 'dsh-personal-sync/syncclonecommit', commits[0].payload);
  assert.equal(repeat.ok, true); await target.service.drainBidirectional(); assert.equal(target.created.length, 2);
  const local = batch.items[0], binding = target.ui.getSnapshot().status.bindings.find(row => row.projectId === local.projectId);
  await fs.writeFile(path.join(local.root, 'hello.txt'), 'Explicit edit after successful bootstrap');
  assert.equal(await target.ui.run(binding.id), true, diagnostic(target.ui));
  await target.service.drainBidirectional(); await target.host.drain(); assert.equal(await target.ui.refresh(), true);
  const client = target.cloudClient(), head = await client.syncHead(binding.projectId), manifest = await client.syncCheckpoint(binding.projectId, head.id, head.manifestDigest);
  assert.equal(manifest.files.find(item => item.path === 'hello.txt').hash, sha256(Buffer.from('Explicit edit after successful bootstrap')));
  assert.equal(target.calls.some(call => ['pairplan', 'paircommit', 'downloadstart', 'restore', 'registerproject'].includes(call.action)), false);
});

test('Host browse batch preserves one successful project and an uncertain registration without replaying native creates', { timeout: 180_000 }, async t => {
  const f = await fixture(t), source = await f.mount('origin', { locals: 2 });
  const ids = await publish(source), target = await f.mount('remote', { browse: true, partialRegistration: true });
  const plan = await clonePlan(target, ids);
  assert.equal(await target.ui.confirmClone(plan), true, diagnostic(target.ui));
  const commit = target.calls.find(call => call.action === 'syncclonecommit'); assert.ok(commit);
  const batch = await settle(target, commit.payload.requestId);
  assert.equal(batch.state, 'uncertain', JSON.stringify(batch)); assert.deepEqual(batch.items.map(item => item.state), ['succeeded', 'uncertain']);
  assert.equal(target.created.length, 2); assert.equal(target.pickerCalls, 1);
  assert.equal(target.ui.getSnapshot().status.bindings.length, 1, 'unknown registration cannot expose an active partial binding');
  assert.equal(target.ui.getSnapshot().uncertain, false, 'terminal per-item uncertainty must not freeze unrelated healthy projects');
  const healthy = target.ui.getSnapshot().status.bindings[0];
  assert.equal(await target.ui.run(healthy.id), true, diagnostic(target.ui));
  await target.service.drainBidirectional(); await target.host.drain(); assert.equal(await target.ui.refresh(), true, diagnostic(target.ui));
  assert.equal(target.created.length, 2, 'working on a healthy binding cannot replay an unknown registration');
  assert.equal(target.ui.getSnapshot().status.onboarding.find(item => item.id === batch.id).items[1].state, 'uncertain');
  assert.ok(target.calls.some(call => call.action === 'synccloneselect'));
  const selected = target.calls.find(call => call.action === 'synccloneselect').payload;
  assert.deepEqual(Object.keys(selected).sort(), ['browserId', 'nodeId', 'revision', 'server', 'username'].sort());
  for (const item of batch.items) assert.match(await fs.readFile(path.join(item.root, 'hello.txt'), 'utf8'), /^Synthetic origin /);
  const repeat = await target.connection.rpc.call('/api', 'dsh-personal-sync/syncclonecommit', commit.payload); assert.equal(repeat.ok, true);
  await target.service.drainBidirectional(); await target.service.tickBidirectional(); await target.service.drainBidirectional();
  assert.equal(target.created.length, 2, 'lost native registration must never cause a second create');
  const failed = batch.items[1], registered = [...target.registry.values()].find(row => row.path === failed.root), state = await target.service.syncstatus();
  await assert.rejects(target.service.pairplan({ revision: state.revision, server: state.server, username: state.username, workspaceId: registered.id, projectId: null }), { code: 'SYNC_APPLY_INCOMPLETE' });
});
