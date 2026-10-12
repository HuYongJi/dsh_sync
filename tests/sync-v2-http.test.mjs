import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-v2-http-only';
const file = (name, bytes) => ({ path: name, hash: sha256(bytes), size: bytes.length, executable: false });
const manifest = (id, deviceId, files = [], extra = {}) => ({ version: 2, id, projectId: 'project', deviceId, parentId: null, policyRevision: 1, files, tombstones: [], conflicts: [], archiveRefs: [], label: 'Fixture project', ...extra });
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'v2-http-'));
  let server = await createSyncServer({ dataDir: directory, username: 'owner', password });
  t.after(async () => {
    await closeSyncServer(server);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent)); assert.match(path.basename(directory), /^v2-http-[A-Za-z0-9]+$/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function listen() { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
  let url = await listen();
  async function login(deviceId) { const client = new SyncV2Client({ server: url }); const grant = await client.loginRenewable({ username: 'owner', password, deviceId }); return { client, grant }; }
  return { directory, login, get url() { return url; }, async restart() { await closeSyncServer(server); server = await createSyncServer({ dataDir: directory }); url = await listen(); } };
}

test('real HTTP v2 discovery, missing blobs, immutable CAS receipts and restart use one authoritative head', async t => {
  const f = await fixture(t), { client, grant } = await f.login('a');
  assert.equal(await client.supportsV2(), true); assert.equal((await client.capabilities()).serverId, grant.serverId);
  const bytes = Buffer.from('v2 bytes'), entry = file('hello.txt', bytes);
  assert.deepEqual(await client.missingBlobs([entry]), [entry.hash]); await client.uploadBlob(entry.hash, bytes);
  assert.deepEqual(await client.missingBlobs([entry]), []);
  const first = { manifest: manifest('first', 'a', [entry]), expectedHeadRevision: 0, expectedHeadId: null, requestId: 'request-1' };
  const receipt = await client.commitSync(first); assert.equal(receipt.revision, 1);
  assert.equal((await client.syncProjects()).projects[0].label, 'Fixture project');
  assert.deepEqual(await client.syncCheckpoint('project', receipt.id, receipt.manifestDigest), first.manifest);
  const second = { manifest: manifest('second', 'a', [entry], { parentId: 'first' }), expectedHeadRevision: 1, expectedHeadId: 'first', requestId: 'request-2' };
  await client.commitSync(second);
  assert.deepEqual(await client.commitSync(first), receipt); assert.deepEqual(await client.syncReceipt('project', 'request-1'), receipt);
  await assert.rejects(client.commitSync({ ...first, requestId: 'stale', manifest: { ...first.manifest, id: 'stale' } }), { code: 'SYNC_HEAD_MISMATCH' });
  await f.restart();
  const reopened = new SyncV2Client({ server: f.url, token: grant.token, deviceId: 'a', serverId: grant.serverId });
  assert.equal((await reopened.syncHead('project')).id, 'second'); assert.deepEqual(await reopened.syncReceipt('project', 'request-1'), receipt);
  const stored = await fs.readFile(path.join(f.directory, 'state.json'), 'utf8');
  assert.equal(JSON.parse(stored).version, 2); assert.ok(!stored.includes(grant.token) && !stored.includes(grant.refreshToken));
});

test('migration is explicit, fences legacy writes/latest, and preserves historical direct restore', async t => {
  const f = await fixture(t), { client } = await f.login('a'), legacy = new SyncClient({ server: f.url });
  await legacy.login({ username: 'owner', password, deviceId: 'legacy' });
  const prior = { version: 1, id: 'old', projectId: 'project', deviceId: 'legacy', parentId: null, sourceRoot: '/synthetic/project', createdAt: '2025-01-01T00:00:00.000Z', files: [], sessionIds: [] };
  await legacy.commit(prior);
  const request = { manifest: manifest('migrated', 'a'), expectedHeadRevision: 0, expectedHeadId: null, requestId: 'migration' };
  await assert.rejects(client.commitSync(request), { code: 'SYNC_MIGRATION_REQUIRED' });
  const heads = await client.legacyHeads('project'); assert.deepEqual(heads.heads, ['old']);
  const migrated = await client.migrateSync({ ...request, expectedLegacyHeads: heads.heads }); assert.equal(migrated.revision, 1);
  assert.deepEqual(await client.migrateSync({ ...request, expectedLegacyHeads: heads.heads }), migrated);
  await assert.rejects(legacy.commit({ ...prior, id: 'late', parentId: 'old' }), { httpStatus: 426 });
  await assert.rejects(legacy.list('project'), { httpStatus: 426 });
  assert.deepEqual(await legacy.getCheckpoint('old'), prior);
});

test('wire renewal binds device, rotates all credentials and logout revokes the family', async t => {
  const f = await fixture(t), { client, grant } = await f.login('a');
  await assert.rejects(client.refreshGrant({ deviceId: 'b', familyId: grant.familyId, refreshToken: grant.refreshToken }), { code: 'NOT_LOGGED_IN' });
  const next = await client.refreshGrant({ deviceId: 'a', familyId: grant.familyId, refreshToken: grant.refreshToken });
  assert.notEqual(next.token, grant.token); assert.notEqual(next.refreshToken, grant.refreshToken); assert.equal(next.familyId, grant.familyId);
  const old = new SyncV2Client({ server: f.url, token: grant.token }); await assert.rejects(old.capabilities(), { code: 'NOT_LOGGED_IN' });
  await assert.rejects(client.refreshGrant({ deviceId: 'a', familyId: grant.familyId, refreshToken: grant.refreshToken }), { code: 'NOT_LOGGED_IN' });
  assert.equal((await client.logout()).remoteRevoked, true);
  await assert.rejects(client.refreshGrant({ deviceId: 'a', familyId: next.familyId, refreshToken: next.refreshToken }), { code: 'NOT_LOGGED_IN' });
});

test('v2 commit refuses a different authenticated device and corrupted existing inventory', async t => {
  const f = await fixture(t), { client } = await f.login('a');
  await assert.rejects(client.commitSync({ manifest: manifest('wrong-device', 'b'), expectedHeadRevision: 0, expectedHeadId: null, requestId: 'request' }), { httpStatus: 403 });
  const bytes = Buffer.from('good'), entry = file('a', bytes); await client.uploadBlob(entry.hash, bytes);
  await fs.writeFile(path.join(f.directory, 'blobs', entry.hash), 'evil');
  await assert.rejects(client.missingBlobs([entry]), { httpStatus: 409 });
  await assert.rejects(client.commitSync({ manifest: manifest('bad-blob', 'a', [entry]), expectedHeadRevision: 0, expectedHeadId: null, requestId: 'bad-blob' }), { httpStatus: 409 });
  assert.equal(await client.syncHead('project'), null);
});
