import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBidirectionalController } from '../client/bidirectional-state.mjs';
import { createController as createHostController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';

// Production GUI controller + real native RPC JSON envelopes + real Host services
// + real loopback HTTP storage. Only the DSH carrier, registry, credentials and
// activity interfaces are synthetic. This is NOT browser/native GUI integration.
const fixtureParent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const syntheticPassword = 'synthetic-bidirectional-integration-only';
const limit = { timeout: 120_000 };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const diagnostic = ui => JSON.stringify({ ready: ui.getSnapshot().ready, error: ui.getSnapshot().error, dialogError: ui.getSnapshot().dialog?.error, status: ui.getSnapshot().status });

async function fixture(t) {
  await fs.mkdir(fixtureParent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureParent, 'bidir-integration-'));
  const mounts = [], cloudRequests = []; let clock = Date.now(), cloud;
  t.after(async () => {
    for (const mount of mounts) {
      mount.activity.release?.();
      for (const ui of mount.clients) ui.dispose();
      mount.bridge.dispose(); mount.service.stopBidirectional(); mount.host.stop();
    }
    await Promise.all(mounts.flatMap(mount => [mount.host.drain(), mount.service.drainBidirectional()]));
    if (cloud) await closeSyncServer(cloud);
    // Never clean anything except this exact freshly-created synthetic fixture.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(fixtureParent));
    assert.match(path.basename(directory), /^bidir-integration-[A-Za-z0-9]+$/);
    const info = await fs.lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
    await assert.rejects(fs.lstat(directory), { code: 'ENOENT' });
  });
  cloud = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password: syntheticPassword });
  cloud.on('request', request => { cloudRequests.push({ method: request.method, pathname: new URL(request.url, 'http://synthetic.invalid').pathname }); });
  await new Promise((resolve, reject) => { cloud.once('error', reject); cloud.listen(0, '127.0.0.1', resolve); });
  const server = `http://127.0.0.1:${cloud.address().port}`;
  async function mount(name) {
    assert.match(name, /^[a-z]+$/);
    const root = path.join(directory, `project-${name}`), home = path.join(directory, `host-${name}`), profileDir = path.join(home, 'profile'), workspaceId = `workspace:${name}`;
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(profileDir, { recursive: true });
    const records = new Map(), registry = new Map([[workspaceId, { id: workspaceId, title: `Synthetic ${name.toUpperCase()}`, path: root }]]);
    const activity = { idle: true, checks: 0, imports: 0, gate: null, entered: null, release: null };
    const context = { workspaceRegistry: { list: () => [...registry.values()], get: id => registry.get(id) }, credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, update) => { const next = await update(records.get(key)); if (next !== undefined) records.set(key, next); },
      deleteRecord: async key => records.delete(key),
    } };
    const host = createHostController(context, { stateDir: path.join(profileDir, 'sync') }, {
      credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
      exportSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }),
      importSessions: async () => { activity.imports++; throw new Error('Synthetic integration must never import or launch sessions'); },
    });
    const legacy = createSettingsService(context, host, { profileDir, dshHome: home });
    const service = withBidirectionalSync(context, host, legacy, { profileDir, dshHome: home, enableWatchers: false, now: () => clock, isIdle: async () => {
      activity.checks++; activity.entered?.resolve(); if (activity.gate) await activity.gate; return activity.idle;
    } });
    const bridge = createSettingsHttp(service), calls = [], clients = [];
    let sequence = 0, dropAction = null, savedIdentity = null;
    const connection = { rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); assert.ok(endpoint.startsWith('dsh-personal-sync/'));
      const action = endpoint.slice('dsh-personal-sync/'.length), rpcId = `fixture-${name}-${++sequence}`;
      // The test carrier records no passwords/tokens, even for account-card login.
      const visiblePayload = action === 'login' ? { server: payload.server, username: payload.username, remember: payload.remember } : structuredClone(payload);
      const call = { action, channel, endpoint, payload: visiblePayload, signal, result: null }; calls.push(call);
      const request = new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }) });
      const response = await bridge.fetch(action, request), envelope = await response.json();
      assert.equal(response.status, 200); assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, rpcId);
      assert.equal(typeof envelope.result?.ok, 'boolean'); call.result = envelope.result;
      if (dropAction === action && envelope.result.ok && envelope.result.value?.accepted === true) {
        dropAction = null; call.dropped = true;
        throw new Error('Synthetic lost acknowledgment after durable Host admission');
      }
      return envelope.result;
    } } };
    function newUi() {
      const ui = createBidirectionalController(connection, { now: () => clock, timeoutMs: 60_000 });
      if (savedIdentity) ui.setIdentity(savedIdentity);
      clients.push(ui); return ui;
    }
    const result = { root, home, profileDir, workspaceId, records, registry, host, legacy, service, bridge, connection, calls, clients, activity, newUi,
      ui: newUi(), dropNextAck(action) { assert.ok(['paircommit', 'syncrun', 'syncresolve', 'syncrestore'].includes(action)); dropAction = action; },
      async login() {
        const result = await connection.rpc.call('/api', 'dsh-personal-sync/login', { server, username: 'owner', password: syntheticPassword, remember: true });
        assert.equal(result.ok, true, JSON.stringify(result.error)); savedIdentity = result.value;
        // Deliberately pass the saved legacy revision too: the new controller must
        // authorize from syncstatus, not the old account/preferences revision.
        this.ui.setIdentity(savedIdentity); assert.equal(await this.ui.refresh(), true, diagnostic(this.ui)); return savedIdentity;
      },
      cloudClient() { return new SyncV2Client(records.get(host.credentialKey).payload); },
      holdActivity() {
        const gate = deferred(), entered = deferred(); activity.gate = gate.promise; activity.entered = entered; activity.release = () => { gate.resolve(); activity.gate = null; activity.entered = null; };
        return { entered: entered.promise, release: activity.release };
      },
    };
    mounts.push(result); return result;
  }
  return { directory, server, cloudRequests, mount, advance(ms) { clock += ms; } };
}
function projectFile(mount, relative) {
  assert.ok(typeof relative === 'string' && relative && relative.split('/').every(segment => segment && segment !== '.' && segment !== '..'));
  const target = path.resolve(mount.root, ...relative.split('/'));
  assert.ok(target.startsWith(path.resolve(mount.root) + path.sep)); return target;
}
async function write(mount, relative, bytes) { const filename = projectFile(mount, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes); }
async function read(mount, relative) { return fs.readFile(projectFile(mount, relative), 'utf8'); }
async function remove(mount, relative) { const target = projectFile(mount, relative); assert.equal(path.resolve(target), path.join(path.resolve(mount.root), ...relative.split('/'))); await fs.unlink(target); }
async function preparePair(mount, projectId = null) {
  const ui = mount.ui;
  assert.equal(await ui.refresh(), true, diagnostic(ui));
  assert.equal(await ui.openPair(), true, diagnostic(ui));
  assert.equal(ui.getSnapshot().status.capability, 'supported');
  assert.equal(ui.getSnapshot().dialog.workspaceId, ''); assert.equal(ui.getSnapshot().dialog.projectChoice, '');
  assert.equal(ui.selectWorkspace(mount.workspaceId), true); assert.equal(ui.selectProject(projectId), true);
  assert.equal(await ui.planPair(), true, diagnostic(ui));
  const plan = ui.getSnapshot().dialog.plan; assert.ok(plan && Object.isFrozen(plan)); return plan;
}
async function settleHost(mount, requestId, ui = mount.ui) {
  await mount.service.drainBidirectional(); await mount.host.drain();
  assert.equal(await ui.refresh(), true, diagnostic(ui));
  const snapshot = ui.getSnapshot(), operation = snapshot.status.operations.find(item => item.id === requestId);
  assert.ok(operation, 'Committed request id must remain in public operation history');
  assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
  assert.equal(snapshot.pending.some(item => item.requestId === requestId), false);
  return snapshot.status;
}
async function pair(mount, projectId = null) {
  const plan = await preparePair(mount, projectId), before = mount.calls.length;
  assert.equal(await mount.ui.confirmPair(plan), true, diagnostic(mount.ui));
  assert.equal(await mount.ui.confirmPair(plan), false);
  const writes = mount.calls.slice(before).filter(call => call.action === 'paircommit'); assert.equal(writes.length, 1);
  assert.equal(writes[0].result.value.operationId, writes[0].payload.requestId);
  const status = await settleHost(mount, writes[0].payload.requestId);
  return { plan, status, binding: status.bindings.find(item => item.projectId === plan.projectId), requestId: writes[0].payload.requestId };
}
async function run(mount, ui = mount.ui) {
  assert.equal(await ui.refresh(), true, diagnostic(ui));
  const binding = ui.getSnapshot().status.bindings[0], before = mount.calls.length;
  assert.equal(await ui.run(binding.id), true, diagnostic(ui));
  const call = mount.calls.slice(before).find(item => item.action === 'syncrun'); assert.ok(call);
  return settleHost(mount, call.payload.requestId, ui);
}

// All mutations below use production GUI-controller methods and travel through
// the RPC parser. Direct Host calls are only deterministic scheduler/drain hooks.
test('first connection through production RPC is explicit; two paired peers converge and pause without Save', limit, async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b');
  assert.equal(await a.ui.refresh(), true); assert.equal(a.ui.getSnapshot().status.loggedIn, false);
  const saved = await a.login(); await b.login();
  assert.equal(a.ui.getSnapshot().status.capability, 'unknown');
  const beforeCloud = f.cloudRequests.length; await a.ui.refresh();
  assert.equal(f.cloudRequests.length, beforeCloud, 'syncstatus must remain local-only before explicit discovery');
  assert.equal(a.calls.some(call => call.action === 'syncprojects'), false);
  await write(a, 'shared.txt', 'from A'); await write(a, '.env', 'synthetic-secret-excluded'); await write(a, '.dsh-syncignore', 'ignored.txt\n'); await write(a, 'ignored.txt', 'local-only');
  const plan = await preparePair(a); assert.equal(plan.root, a.root); assert.equal(plan.summary.upload, 1);
  assert.equal(a.ui.getSnapshot().status.bindings.length, 0); await assert.rejects(fs.lstat(path.join(a.root, '.dsh-sync')), { code: 'ENOENT' });
  assert.equal(await a.cloudClient().syncHead(plan.projectId), null, 'preview cannot create cloud history');
  const envelope = a.calls.find(call => call.action === 'pairplan');
  assert.equal(envelope.payload.revision, plan.identity.revision); assert.notEqual(envelope.payload.revision, saved.revision, 'legacy account revision must not authorize v2 plans');
  const beforeCommit = a.calls.length; assert.equal(await a.ui.confirmPair(plan), true, diagnostic(a.ui)); assert.equal(await a.ui.confirmPair(plan), false);
  const writes = a.calls.slice(beforeCommit).filter(call => call.action === 'paircommit'); assert.equal(writes.length, 1);
  const aStatus = await settleHost(a, writes[0].payload.requestId), projectId = aStatus.bindings[0].projectId;
  const bPair = await pair(b, projectId); assert.equal(await read(b, 'shared.txt'), 'from A');
  await assert.rejects(fs.lstat(projectFile(b, '.env')), { code: 'ENOENT' }); await assert.rejects(fs.lstat(projectFile(b, '.dsh-syncignore')), { code: 'ENOENT' }); await assert.rejects(fs.lstat(projectFile(b, 'ignored.txt')), { code: 'ENOENT' });
  await write(b, 'from-b.txt', 'from B'); f.advance(20_000);
  await b.service.tickBidirectional(); await b.service.drainBidirectional(); await a.service.tickBidirectional(); await a.service.drainBidirectional();
  assert.equal(await read(a, 'from-b.txt'), 'from B');
  await write(a, 'shared.txt', 'A changed'); await run(a); await run(b); assert.equal(await read(b, 'shared.txt'), 'A changed');
  await b.ui.refresh(); const beforePause = b.calls.length;
  assert.equal(await b.ui.setEnabled(bPair.binding.id, false), true, diagnostic(b.ui));
  assert.equal(b.ui.getSnapshot().status.bindings[0].enabled, false); assert.equal(b.ui.getSnapshot().status.bindings[0].state, 'paused');
  assert.deepEqual(b.calls.slice(beforePause).filter(call => call.action !== 'syncstatus').map(call => call.action), ['syncpause']);
  const head = await b.cloudClient().syncHead(projectId); await write(b, 'paused.txt', 'must remain local'); f.advance(20_000); await b.service.tickBidirectional(); await b.service.drainBidirectional();
  assert.deepEqual(await b.cloudClient().syncHead(projectId), head);
  assert.equal(await b.ui.setEnabled(bPair.binding.id, true), true, diagnostic(b.ui)); await run(b); await run(a); assert.equal(await read(a, 'paused.txt'), 'must remain local');
  const grant = a.records.get(a.host.credentialKey).payload, serialized = JSON.stringify([a.ui.getSnapshot(), b.ui.getSnapshot()]);
  for (const secret of [syntheticPassword, grant.token, grant.refreshToken].filter(Boolean)) assert.equal(serialized.includes(secret), false);
  assert.equal(a.activity.imports + b.activity.imports, 0);
});

test('real two-peer edit conflicts preserve local files until explicit GUI keep-both resolution', limit, async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b'); await a.login(); await b.login();
  await write(a, 'same.txt', 'base'); const first = await pair(a); await pair(b, first.binding.projectId);
  await write(a, 'same.txt', 'A edited'); await write(b, 'same.txt', 'B edited'); await run(a); const before = await run(b);
  assert.equal(before.bindings[0].conflicts, 1); assert.equal(await read(a, 'same.txt'), 'A edited'); assert.equal(await read(b, 'same.txt'), 'B edited');
  assert.equal(await b.ui.openConflicts(before.bindings[0].id), true, diagnostic(b.ui));
  const conflicts = b.ui.getSnapshot().dialog.items; assert.equal(conflicts.length, 1); assert.equal(conflicts[0].variants.length, 2);
  assert.equal(b.ui.selectConflict(conflicts[0].id), true); assert.equal(b.ui.getSnapshot().dialog.choice, 'both');
  assert.equal(await b.ui.planResolution(), true, diagnostic(b.ui)); const plan = b.ui.getSnapshot().dialog.plan;
  assert.equal(plan.paths.length, 2); assert.equal(plan.choice, 'both'); assert.equal(await read(b, 'same.txt'), 'B edited');
  const beforeResolve = b.calls.length; assert.equal(await b.ui.confirmResolution(plan), true, diagnostic(b.ui)); assert.equal(await b.ui.confirmResolution(plan), false);
  const calls = b.calls.slice(beforeResolve).filter(call => call.action === 'syncresolve'); assert.equal(calls.length, 1);
  const after = await settleHost(b, calls[0].payload.requestId); assert.equal(after.bindings[0].conflicts, 0);
  assert.equal(await read(b, 'same.txt'), 'B edited');
  const preserved = plan.paths.find(name => name !== 'same.txt'); assert.ok(preserved); assert.equal(await read(b, preserved), 'A edited');
  await run(a); assert.equal(await read(a, 'same.txt'), 'B edited'); assert.equal(await read(a, preserved), 'A edited');
  assert.equal(a.activity.imports + b.activity.imports, 0);
});

test('tracked delete reaches peer recycle; GUI restore plans a safe new target without overwriting', limit, async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b'); await a.login(); await b.login();
  await write(a, 'remove.txt', 'recoverable original'); const first = await pair(a); await pair(b, first.binding.projectId);
  await remove(a, 'remove.txt'); await run(a); const received = await run(b);
  await assert.rejects(fs.lstat(projectFile(b, 'remove.txt')), { code: 'ENOENT' });
  assert.equal(received.bindings[0].recycleCount, 1); assert.equal(await b.ui.openRecycle(received.bindings[0].id), true, diagnostic(b.ui));
  const items = b.ui.getSnapshot().dialog.items; assert.equal(items.length, 1); assert.equal(items[0].reason, 'deleted');
  await write(b, 'remove.txt', 'new untracked local file'); assert.equal(b.ui.selectRecycle(items[0].id), true);
  assert.equal(await b.ui.planRestore(), true, diagnostic(b.ui)); const plan = b.ui.getSnapshot().dialog.plan;
  assert.notEqual(plan.target, projectFile(b, 'remove.txt')); assert.ok(plan.target.startsWith(b.root + path.sep));
  await assert.rejects(fs.lstat(plan.target), { code: 'ENOENT' }); assert.equal(await read(b, 'remove.txt'), 'new untracked local file');
  const before = b.calls.length; assert.equal(await b.ui.confirmRestore(plan), true, diagnostic(b.ui));
  const writes = b.calls.slice(before).filter(call => call.action === 'syncrestore'); assert.equal(writes.length, 1);
  await settleHost(b, writes[0].payload.requestId);
  assert.equal(await read(b, 'remove.txt'), 'new untracked local file'); assert.equal(await fs.readFile(plan.target, 'utf8'), 'recoverable original');
  assert.equal(await b.ui.openRecycle(received.bindings[0].id), true, diagnostic(b.ui)); assert.ok(b.ui.getSnapshot().dialog.items.some(item => item.id === items[0].id), 'restore does not automatically GC the retained record');
});

test('closing accepted GUI controller does not stop Host jobs; lost acknowledgments reconcile without replay', limit, async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b'); await a.login(); await b.login();
  await write(a, 'incoming.txt', 'arrives after UI closes'); const first = await pair(a), plan = await preparePair(b, first.binding.projectId);
  const hold = b.holdActivity(), before = b.calls.length;
  assert.equal(await b.ui.confirmPair(plan), true, diagnostic(b.ui));
  const accepted = b.calls.slice(before).find(call => call.action === 'paircommit'); assert.equal(accepted.result.value.operationId, accepted.payload.requestId);
  await hold.entered; b.ui.closeDialog(); b.ui.dispose();
  assert.equal(accepted.signal.aborted, false, 'disposing GUI must not abort the accepted write carrier');
  await assert.rejects(fs.lstat(projectFile(b, 'incoming.txt')), { code: 'ENOENT' });
  hold.release(); await b.service.drainBidirectional(); await b.host.drain();
  assert.equal(await read(b, 'incoming.txt'), 'arrives after UI closes');
  const reopened = b.newUi(); await reopened.refresh();
  const completed = reopened.getSnapshot().status.operations.find(item => item.id === accepted.payload.requestId); assert.equal(completed.state, 'succeeded');
  const observed = [], unsubscribe = reopened.subscribe(() => { observed.push(reopened.getSnapshot().uncertain); });
  await write(b, 'lost-ack.txt', 'still committed'); b.dropNextAck('syncrun'); const beforeLost = b.calls.length;
  assert.equal(await reopened.run(reopened.getSnapshot().status.bindings[0].id), false);
  const lost = b.calls.slice(beforeLost).find(call => call.action === 'syncrun'); assert.equal(lost.dropped, true); assert.equal(lost.result.value.operationId, lost.payload.requestId);
  assert.ok(observed.includes(true), 'transport loss must first latch unknown write acceptance');
  assert.ok(b.calls.slice(beforeLost + 1).every(call => call.action === 'syncstatus'), 'unknown result may only issue status reads, never replay');
  const after = await settleHost(b, lost.payload.requestId, reopened); unsubscribe();
  assert.equal(after.operations.find(item => item.id === lost.payload.requestId).state, 'succeeded'); assert.equal(reopened.getSnapshot().uncertain, false);
  assert.equal(b.calls.slice(beforeLost).filter(call => call.action === 'syncrun').length, 1);
  await run(a); assert.equal(await read(a, 'lost-ack.txt'), 'still committed');
  assert.equal(b.calls.some(call => /cancel/.test(call.action)), false); assert.equal(a.activity.imports + b.activity.imports, 0);
});

test('native RPC stale-plan rejection remains actionable and cannot admit a changed local snapshot', limit, async t => {
  const f = await fixture(t), a = await f.mount('a'); await a.login(); await write(a, 'version.txt', 'before preview');
  const stale = await preparePair(a); await write(a, 'version.txt', 'after preview'); const before = a.calls.length;
  assert.equal(await a.ui.confirmPair(stale), false);
  const rejected = a.calls.slice(before).find(call => call.action === 'paircommit'); assert.equal(rejected.result.ok, false); assert.equal(rejected.result.error.code, 'SYNC_PLAN_CHANGED');
  assert.equal(a.ui.getSnapshot().uncertain, false); assert.equal(a.ui.getSnapshot().dialog.stage, 'choose'); assert.equal(a.ui.getSnapshot().dialog.workspaceId, a.workspaceId);
  assert.equal(a.ui.getSnapshot().status.bindings.length, 0); assert.equal(await a.cloudClient().syncHead(stale.projectId), null);
  assert.equal(await a.ui.planPair(), true, diagnostic(a.ui)); const fresh = a.ui.getSnapshot().dialog.plan;
  assert.equal(await a.ui.confirmPair(fresh), true, diagnostic(a.ui));
  const accepted = a.calls.filter(call => call.action === 'paircommit').at(-1); await settleHost(a, accepted.payload.requestId);
  assert.equal(await read(a, 'version.txt'), 'after preview');
});
