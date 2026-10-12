import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-bidirectional-only';
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'bidir-host-')), mounts = []; let clock = Date.now();
  const cloud = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`;
  t.after(async () => {
    for (const mount of mounts) { mount.service.stopBidirectional(); mount.controller.stop(); }
    await Promise.all(mounts.flatMap(mount => [mount.controller.drain(), mount.service.drainBidirectional()]));
    await closeSyncServer(cloud);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent)); assert.match(path.basename(directory), /^bidir-host-[A-Za-z0-9]+$/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function mount(name, options = {}) {
    const root = path.join(directory, `project-${name}`), home = path.join(directory, `host-${name}`), profileDir = path.join(home, 'profile');
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(profileDir, { recursive: true });
    const records = options.records ?? new Map(), workspaces = new Map([['workspace', { id: 'workspace', title: `Project ${name}`, path: root }]]);
    const ctx = { workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); },
      deleteRecord: async key => records.delete(key),
    } };
    const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false, exportSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }) });
    const legacy = createSettingsService(ctx, controller, { profileDir, dshHome: home });
    const service = withBidirectionalSync(ctx, controller, legacy, { profileDir, dshHome: home, enableWatchers: false, now: () => clock, isIdle: options.isIdle ?? (async () => true), planTtlMs: options.planTtlMs });
    const bridge = createSettingsHttp(service), result = { root, home, profileDir, records, workspaces, controller, legacy, service, bridge };
    mounts.push(result);
    await service.login({ server, username: 'owner', password, remember: true });
    return result;
  }
  return { directory, server, mount, advance(ms) { clock += ms; } };
}
async function identity(service) { const status = await service.syncstatus(); return { revision: status.revision, server: status.server, username: status.username }; }
async function pair(mount, projectId = null, id = 'pair') {
  const auth = await identity(mount.service), planned = await mount.service.pairplan({ ...auth, workspaceId: 'workspace', projectId });
  assert.ok(planned.plan); const request = { ...auth, planId: planned.plan.id, requestId: id, confirm: true };
  assert.deepEqual(await mount.service.paircommit(request), { accepted: true, operationId: id });
  await mount.service.drainBidirectional();
  const status = await mount.service.syncstatus();
  assert.equal(status.operations.find(item => item.id === id).state, 'succeeded', JSON.stringify(status));
  return { request, status, binding: status.bindings[0] };
}
async function run(mount, id) {
  const status = await mount.service.syncstatus();
  await mount.service.syncrun({ ...await identity(mount.service), bindingId: status.bindings[0].id, requestId: id });
  await mount.service.drainBidirectional(); return mount.service.syncstatus();
}
async function rpc(mount, action, input = {}) {
  const response = await mount.bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-request', method: `dsh-personal-sync/${action}`, payload: input }) }));
  return (await response.json()).result;
}

test('pair preview is inert; one explicit confirmation enables exact root and disables legacy upload mode', async t => {
  const f = await fixture(t), a = await f.mount('a'); await fs.writeFile(path.join(a.root, 'hello.txt'), 'hello');
  const logged = await a.legacy.status(); await a.legacy.savePreferences({ revision: logged.revision, projectIds: ['workspace'], autoSync: false });
  const before = await identity(a.service), planned = await a.service.pairplan({ ...before, workspaceId: 'workspace', projectId: null });
  assert.equal(planned.plan.summary.upload, 1); assert.equal((await a.service.syncstatus()).bindings.length, 0);
  await assert.rejects(fs.stat(path.join(a.root, '.dsh-sync')), { code: 'ENOENT' });
  const grant = a.records.get(a.controller.credentialKey).payload, client = new SyncV2Client(grant);
  assert.equal(await client.syncHead(planned.plan.projectId), null);
  const request = { ...before, planId: planned.plan.id, requestId: 'enable', confirm: true };
  await a.service.paircommit(request); await a.service.drainBidirectional();
  const status = await a.service.syncstatus(); assert.equal(status.bindings[0].state, 'synced', JSON.stringify(status));
  assert.equal((await a.legacy.status()).projects[0].selected, false);
  await assert.rejects(a.legacy.savePreferences({ revision: (await a.legacy.status()).revision, projectIds: ['workspace'], autoSync: false }), { code: 'SYNC_MANAGED_PROJECT' });
  assert.deepEqual(await a.service.paircommit(request), { accepted: true, operationId: 'enable' });
  assert.equal((await client.syncHead(planned.plan.projectId)).revision, 1);
  const text = await fs.readFile(a.service.bidirectionalFilename, 'utf8'); assert.ok(!text.includes(grant.token) && !text.includes(grant.refreshToken) && !text.includes(password));
});

test('two Host settings services automatically converge selected existing directories in both directions', async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b');
  await fs.writeFile(path.join(a.root, 'a.txt'), 'A'); const first = await pair(a);
  await pair(b, first.binding.projectId, 'pair-b'); assert.equal(await fs.readFile(path.join(b.root, 'a.txt'), 'utf8'), 'A');
  await fs.writeFile(path.join(b.root, 'b.txt'), 'B');
  f.advance(20_000); await b.service.tickBidirectional(); await a.service.tickBidirectional();
  assert.equal(await fs.readFile(path.join(a.root, 'b.txt'), 'utf8'), 'B');
  await fs.writeFile(path.join(a.root, 'a.txt'), 'A2'); await run(a, 'run-a'); await run(b, 'run-b');
  assert.equal(await fs.readFile(path.join(b.root, 'a.txt'), 'utf8'), 'A2');
});

test('clean deletion retains a recycle copy; restoring cannot overwrite a newly occupied path', async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b');
  await fs.writeFile(path.join(a.root, 'a.txt'), 'original'); const first = await pair(a); await pair(b, first.binding.projectId, 'pair-b');
  const target = path.resolve(a.root, 'a.txt'); assert.equal(path.dirname(target), path.resolve(a.root)); await fs.unlink(target);
  await run(a, 'delete-a'); const bStatus = await run(b, 'delete-b');
  await assert.rejects(fs.stat(path.join(b.root, 'a.txt')), { code: 'ENOENT' });
  const bindingId = bStatus.bindings[0].id, auth = await identity(b.service), list = await b.service.syncrecycle({ ...auth, bindingId });
  assert.equal(list.items.length, 1); assert.equal(list.items[0].reason, 'deleted');
  await fs.writeFile(path.join(b.root, 'a.txt'), 'new local file');
  const planned = await b.service.syncrestoreplan({ ...auth, bindingId, itemId: list.items[0].id });
  assert.notEqual(planned.plan.target, path.join(b.root, 'a.txt'));
  await b.service.syncrestore({ ...auth, planId: planned.plan.id, requestId: 'recover', confirm: true }); await b.service.drainBidirectional();
  assert.equal(await fs.readFile(path.join(b.root, 'a.txt'), 'utf8'), 'new local file');
  assert.equal(await fs.readFile(planned.plan.target, 'utf8'), 'original');
});

test('both-edited conflict preserves both primaries until explicit version-bound resolution', async t => {
  const f = await fixture(t), a = await f.mount('a'), b = await f.mount('b');
  await fs.writeFile(path.join(a.root, 'same.txt'), 'base'); const first = await pair(a); await pair(b, first.binding.projectId, 'pair-b');
  await fs.writeFile(path.join(a.root, 'same.txt'), 'A edit'); await fs.writeFile(path.join(b.root, 'same.txt'), 'B edit');
  await run(a, 'edit-a'); const status = await run(b, 'edit-b');
  assert.equal(status.bindings[0].conflicts, 1); assert.equal(await fs.readFile(path.join(b.root, 'same.txt'), 'utf8'), 'B edit');
  const bindingId = status.bindings[0].id, auth = await identity(b.service), { conflicts } = await b.service.syncconflicts({ ...auth, bindingId });
  const planned = await b.service.syncresolveplan({ ...auth, bindingId, conflictId: conflicts[0].id, choice: 'both' });
  assert.equal(planned.plan.paths.length, 2);
  await b.service.syncresolve({ ...auth, planId: planned.plan.id, requestId: 'resolve', confirm: true }); await b.service.drainBidirectional();
  const after = await b.service.syncstatus(); assert.equal(after.operations.find(item => item.id === 'resolve').state, 'succeeded', JSON.stringify(after));
  assert.equal(after.bindings[0].conflicts, 0); assert.equal(await fs.readFile(path.join(b.root, 'same.txt'), 'utf8'), 'B edit');
  assert.equal(await fs.readFile(path.join(b.root, ...planned.plan.paths[1].split('/')), 'utf8'), 'A edit');
});

test('stale pairing plan, changed local files and old authority never enable writes', async t => {
  const f = await fixture(t), a = await f.mount('a'); await fs.writeFile(path.join(a.root, 'a'), 'old');
  const auth = await identity(a.service), planned = await a.service.pairplan({ ...auth, workspaceId: 'workspace', projectId: null });
  await fs.writeFile(path.join(a.root, 'a'), 'new');
  await assert.rejects(a.service.paircommit({ ...auth, planId: planned.plan.id, requestId: 'stale', confirm: true }), { code: 'SYNC_PLAN_CHANGED' });
  assert.equal((await a.service.syncstatus()).bindings.length, 0);
  const fresh = await pair(a, null, 'valid');
  await a.service.syncpause({ ...await identity(a.service), bindingId: fresh.binding.id, enabled: false });
  await assert.rejects(a.service.syncrun({ ...await identity(a.service), bindingId: fresh.binding.id, requestId: 'not-selected' }), { code: 'PROJECT_NOT_SELECTED' });
  assert.equal((await a.service.syncstatus()).bindings[0].state, 'paused');
});

test('RPC projects requires account binding; v2 history blocks cross-account login before sending a password', async t => {
  const f = await fixture(t), a = await f.mount('a'); const initial = await rpc(a, 'syncstatus'); assert.equal(initial.ok, true);
  const bad = await rpc(a, 'syncprojects', { ...await identity(a.service), username: 'other' }); assert.equal(bad.ok, false); assert.equal(bad.error.code, 'ACCOUNT_MISMATCH');
  await fs.writeFile(path.join(a.root, 'a'), 'A'); await pair(a);
  await assert.rejects(a.service.login({ server: f.server, username: 'other', password: 'secret-that-must-not-be-sent', remember: true }), { code: 'ACCOUNT_BOUND' });
  const valid = await rpc(a, 'syncstatus'); assert.equal(valid.ok, true); assert.ok(!JSON.stringify(valid).includes('refreshToken'));
});

test('active native work defers incoming file writes, then manual retry completes without starting agents', async t => {
  const f = await fixture(t); let idle = true;
  const a = await f.mount('a'), b = await f.mount('b', { isIdle: async () => idle });
  await fs.writeFile(path.join(a.root, 'a.txt'), 'A'); const first = await pair(a); idle = false;
  const paired = await pair(b, first.binding.projectId, 'pair-b'); assert.equal(paired.status.bindings[0].state, 'deferred');
  await assert.rejects(fs.stat(path.join(b.root, 'a.txt')), { code: 'ENOENT' });
  idle = true; const result = await run(b, 'after-idle'); assert.equal(result.bindings[0].state, 'synced');
  assert.equal(await fs.readFile(path.join(b.root, 'a.txt'), 'utf8'), 'A');
});
