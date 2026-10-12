import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url)), password = 'synthetic-recovery-host';
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true }); const directory = await fs.mkdtemp(path.join(parent, 'bidir-recovery-')), peers = [];
  const server = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const peer of peers) { peer.service.stopBidirectional(); peer.controller.stop(); }
    await Promise.all(peers.flatMap(peer => [peer.controller.drain(), peer.service.drainBidirectional()])); await closeSyncServer(server);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent)); assert.match(path.basename(directory), /^bidir-recovery-[A-Za-z0-9]+$/); assert.equal(await fs.realpath(directory), path.resolve(directory));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function peer(name) {
    const root = path.join(directory, `project-${name}`), profileDir = path.join(directory, `profile-${name}`); await fs.mkdir(root); await fs.mkdir(profileDir);
    const records = new Map(), workspaces = new Map([['workspace', { id: 'workspace', title: name, path: root }]]); let idle = true;
    const ctx = { workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const record = await fn(records.get(key)); if (record !== undefined) records.set(key, record); }, deleteRecord: async key => records.delete(key) } };
    const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false, exportSessions: async () => ({ sessions: [], assets: [], skipped: [] }) });
    const legacy = createSettingsService(ctx, controller, { profileDir }), service = withBidirectionalSync(ctx, controller, legacy, { profileDir, enableWatchers: false, isIdle: async () => idle });
    const login = () => service.login({ server: url, username: 'owner', password, remember: true });
    const result = { root, records, controller, service, login, setIdle(value) { idle = value; }, client() { return new SyncV2Client(records.get(controller.credentialKey).payload); } }; peers.push(result); await login(); return result;
  }
  return { directory, peer };
}
const bound = async service => { const state = await service.syncstatus(); return { revision: state.revision, server: state.server, username: state.username }; };
async function pair(peer, projectId = null, requestId = 'pair') {
  const binding = await bound(peer.service), planned = await peer.service.pairplan({ ...binding, workspaceId: 'workspace', projectId });
  await peer.service.paircommit({ ...binding, planId: planned.plan.id, requestId, confirm: true }); await peer.service.drainBidirectional(); return (await peer.service.syncstatus()).bindings[0];
}
async function run(peer, requestId) {
  const binding = (await peer.service.syncstatus()).bindings[0]; await peer.service.syncrun({ ...await bound(peer.service), bindingId: binding.id, requestId }); await peer.service.drainBidirectional(); return peer.service.syncstatus();
}

test('lost migration acknowledgment survives re-login and explicit resume without another migration write', async t => {
  const f = await fixture(t), a = await f.peer('a'), client = a.client(), bytes = Buffer.from('legacy bytes'), hash = sha256(bytes);
  await fs.writeFile(path.join(a.root, 'file.txt'), bytes); await client.uploadBlob(hash, bytes);
  await client.commit({ version: 1, id: 'legacy', projectId: 'legacy-project', deviceId: client.deviceId, parentId: null, sourceRoot: '/synthetic/project', createdAt: '2025-01-01T00:00:00.000Z', sessionIds: [], files: [{ path: 'project/file.txt', sha256: hash, size: bytes.length }] });
  const original = SyncV2Client.prototype.migrateSync; let calls = 0;
  const spy = t.mock.method(SyncV2Client.prototype, 'migrateSync', async function(input) { calls++; await original.call(this, input); throw new Error('synthetic lost acknowledgment'); });
  const binding = await pair(a, 'legacy-project', 'migration');
  let status = await a.service.syncstatus(); assert.equal(status.operations[0].state, 'uncertain', JSON.stringify(status));
  const configBefore = JSON.parse(await fs.readFile(a.service.bidirectionalFilename, 'utf8')), originalHash = configBefore.operations[0].descriptorHash, oldEpoch = configBefore.bindings[0].identity.authorizationEpoch;
  await a.service.logout({}); await a.login();
  await a.service.syncpause({ ...await bound(a.service), bindingId: binding.id, enabled: true });
  await a.service.tickBidirectional(); await a.service.drainBidirectional();
  status = await a.service.syncstatus(); assert.equal(status.operations[0].state, 'succeeded', JSON.stringify(status)); assert.equal(calls, 1, 'must look up committed receipt, not repeat migration');
  const after = JSON.parse(await fs.readFile(a.service.bidirectionalFilename, 'utf8'));
  assert.ok(after.bindings[0].identity.authorizationEpoch > oldEpoch); assert.ok(after.bindings[0].authorizedEpochs.includes(oldEpoch)); assert.equal(after.operations[0].descriptorHash, originalHash);
  assert.equal((await a.client().syncHead('legacy-project')).revision, 1); spy.mock.restore();
});

test('resolution rejects before cloud CAS while a local apply journal cannot accept handoff', async t => {
  const f = await fixture(t), a = await f.peer('a'), b = await f.peer('b');
  await fs.writeFile(path.join(a.root, 'conflict.txt'), 'base'); await fs.writeFile(path.join(a.root, 'incoming.txt'), 'old');
  const ab = await pair(a); const bb = await pair(b, ab.projectId, 'pair-b');
  await fs.writeFile(path.join(a.root, 'conflict.txt'), 'A'); await fs.writeFile(path.join(a.root, 'incoming.txt'), 'new'); await fs.writeFile(path.join(b.root, 'conflict.txt'), 'B');
  await run(a, 'a-edit'); b.setIdle(false); const deferred = await run(b, 'b-edit'); assert.equal(deferred.bindings[0].state, 'deferred'); assert.equal(deferred.bindings[0].conflicts, 1);
  b.setIdle(true); const head = await b.client().syncHead(bb.projectId), binding = await bound(b.service), { conflicts } = await b.service.syncconflicts({ ...binding, bindingId: bb.id });
  await assert.rejects(b.service.syncresolveplan({ ...binding, bindingId: bb.id, conflictId: conflicts[0].id, choice: 'local' }), { code: 'SYNC_APPLY_INCOMPLETE' });
  assert.deepEqual(await b.client().syncHead(bb.projectId), head); assert.equal(await fs.readFile(path.join(b.root, 'incoming.txt'), 'utf8'), 'old');
  await run(b, 'settle-local'); assert.equal(await fs.readFile(path.join(b.root, 'incoming.txt'), 'utf8'), 'new');
  const plan = await b.service.syncresolveplan({ ...await bound(b.service), bindingId: bb.id, conflictId: conflicts[0].id, choice: 'local' }); assert.ok(plan.plan.id);
});

test('pause remains available after the root disappears and after cloud logout', async t => {
  const f = await fixture(t), a = await f.peer('a'); await fs.writeFile(path.join(a.root, 'a'), 'preserve me'); const binding = await pair(a);
  const moved = path.join(f.directory, 'moved-project'); assert.equal(path.dirname(path.resolve(a.root)), path.resolve(f.directory)); assert.equal(path.dirname(path.resolve(moved)), path.resolve(f.directory));
  await fs.rename(a.root, moved);
  const paused = await a.service.syncpause({ ...await bound(a.service), bindingId: binding.id, enabled: false }); assert.equal(paused.bindings[0].enabled, false);
  await a.service.logout({});
  const signedOut = await a.service.syncpause({ ...await bound(a.service), bindingId: binding.id, enabled: false }); assert.equal(signedOut.loggedIn, false); assert.equal(signedOut.bindings[0].enabled, false);
  assert.equal(await fs.readFile(path.join(moved, 'a'), 'utf8'), 'preserve me'); await assert.rejects(fs.stat(a.root), { code: 'ENOENT' });
});
