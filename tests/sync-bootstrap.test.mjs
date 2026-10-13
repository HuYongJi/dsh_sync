import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncEngine } from '../src/sync-engine.mjs';
import { syncRootIdentity } from '../src/sync-local.mjs';
import { syncManifestDigest } from '../src/sync-protocol.mjs';
import { sha256 } from '../src/protocol.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
async function fixture(t, options = {}) {
  await fs.mkdir(parent, { recursive: true }); const directory = await fs.mkdtemp(path.join(parent, 'sync-bootstrap-'));
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent)); assert.match(path.basename(directory), /^sync-bootstrap-[A-Za-z0-9]+$/); await fs.rm(directory, { recursive: true, force: true }); });
  const values = new Map([['a.txt', Buffer.from('A')], ['sub/b.txt', Buffer.from('B')]]), blobs = new Map([...values.values()].map(bytes => [sha256(bytes), bytes]));
  const manifest = { version: 2, id: 'checkpoint', projectId: 'cloud-project', deviceId: 'peer', parentId: null, policyRevision: 1, files: [...values].map(([path, bytes]) => ({ path, hash: sha256(bytes), size: bytes.length, executable: false })), tombstones: [], conflicts: [], archiveRefs: [], label: 'Cloud' };
  const head = { projectId: manifest.projectId, id: manifest.id, revision: 1, manifestDigest: syncManifestDigest(manifest), recordHash: '1'.repeat(64) };
  let uploads = 0, archives = 0, downloads = 0;
  const forbidden = async () => { uploads++; throw new Error('bootstrap must not upload'); };
  const client = { server: 'http://127.0.0.1:1', serverId: 'server-id', deviceId: 'device', capabilities: async () => ({ serverId: 'server-id' }), syncCheckpoint: async (projectId, id, digest) => { assert.equal(projectId, manifest.projectId); assert.equal(id, manifest.id); assert.equal(digest, head.manifestDigest); return structuredClone(manifest); }, downloadBlob: async (hash, size) => { downloads++; assert.equal(blobs.get(hash).length, size); return blobs.get(hash); }, uploadBlob: forbidden, commitSync: forbidden, missingBlobs: forbidden, syncHead: forbidden };
  const args = { root, directory: path.join(directory, 'state'), bindingId: 'binding', projectId: manifest.projectId, accountIdentity: { server: client.server, serverId: client.serverId, deviceId: client.deviceId, username: 'owner', authorizationEpoch: 1 }, getClient: async () => client, captureArchives: async () => { archives++; throw new Error('no native archive work'); }, ...options };
  const input = { requestId: 'clone-request', head, manifest, rootIdentity: await syncRootIdentity(root) }, make = patch => createSyncEngine({ ...args, ...patch });
  return { directory, root, input, make, client, get uploads() { return uploads; }, get archives() { return archives; }, get downloads() { return downloads; } };
}

test('bootstrap exclusively downloads pinned snapshot and establishes bases without capture/upload/archive work', async t => {
  const f = await fixture(t), engine = f.make();
  assert.equal((await engine.bootstrap(f.input)).state, 'synced');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(f.root, 'sub', 'b.txt'), 'utf8'), 'B');
  const journal = JSON.parse(await fs.readFile(engine.filename, 'utf8'));
  assert.equal(journal.bootstrap.phase, 'completed'); assert.equal(journal.capture, null); assert.equal(journal.bases.length, 2); assert.equal(journal.pending, null);
  assert.equal((await f.make().bootstrap(f.input)).state, 'synced'); assert.equal(f.downloads, 2); assert.equal(f.uploads, 0); assert.equal(f.archives, 0);
  await assert.rejects(f.make().bootstrap({ ...f.input, requestId: 'different' }), { code: 'SYNC_REQUEST_CONFLICT' });
});

test('bootstrap rejects preexisting/racing user files and fences ordinary run without spooling them', async t => {
  const f = await fixture(t); let raced = false;
  const engine = f.make({ fault: async phase => { if (phase === 'prepared' && !raced) { raced = true; await fs.writeFile(path.join(f.root, 'private.txt'), 'never upload me'); } } });
  await assert.rejects(engine.bootstrap(f.input), { code: 'SYNC_LOCAL_CHANGED' });
  assert.equal(await fs.readFile(path.join(f.root, 'private.txt'), 'utf8'), 'never upload me');
  assert.equal((await f.make().run()).errorCode, 'SYNC_APPLY_INCOMPLETE');
  await assert.rejects(f.make().preview(), { code: 'SYNC_APPLY_INCOMPLETE' });
  assert.equal(JSON.parse(await fs.readFile(engine.filename, 'utf8')).capture, null);
  await assert.rejects(fs.stat(path.join(engine.engineDirectory, 'blobs', sha256('never upload me'))), { code: 'ENOENT' });
  assert.equal(f.uploads, 0); assert.equal(f.archives, 0);
});

test('bootstrap cannot overwrite a race-created target even when publication has already begun', async t => {
  const f = await fixture(t); let raced = false;
  await assert.rejects(f.make({ fault: async (phase, _journal, item) => { if (phase === 'before-publish' && !raced) { raced = true; await fs.writeFile(path.join(f.root, item.path), 'racer'); } } }).bootstrap(f.input), { code: 'SYNC_LOCAL_CHANGED' });
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'racer'); assert.equal(f.uploads, 0);
});

test('bootstrap retries only its same immutable expected-null journal after a partial apply', async t => {
  const f = await fixture(t); let failed = false;
  await assert.rejects(f.make({ fault: async phase => { if (phase === 'after-operation' && !failed) { failed = true; throw new Error('synthetic interruption'); } } }).bootstrap(f.input));
  assert.equal((await f.make().run()).errorCode, 'SYNC_APPLY_INCOMPLETE');
  assert.equal((await f.make().bootstrap(f.input)).state, 'synced'); assert.equal(f.uploads, 0); assert.equal(f.archives, 0);
});

for (const early of ['tree', 'policy', 'quota']) test(`bootstrap fences fresh engines before initial ${early} admission can fail`, async t => {
  const f = await fixture(t), engine = f.make({ ...(early === 'quota' ? { quotaBytes: 1 } : {}), fault: async phase => {
    if (phase === 'bootstrap-fenced' && early !== 'quota') await fs.writeFile(path.join(f.root, early === 'policy' ? '.dsh-syncignore' : 'private.txt'), early === 'policy' ? '!invalid-rule' : 'never upload early racer');
  } });
  await assert.rejects(engine.bootstrap(f.input));
  assert.equal((await f.make().run()).errorCode, 'SYNC_APPLY_INCOMPLETE');
  await assert.rejects(f.make().preview(), { code: 'SYNC_APPLY_INCOMPLETE' });
  assert.equal(f.downloads, 0); assert.equal(f.uploads, 0); assert.equal(f.archives, 0);
  await assert.rejects(fs.stat(path.join(engine.engineDirectory, 'blobs', sha256('never upload early racer'))), { code: 'ENOENT' });
});

test('completed bootstrap re-verifies tree after native awaits and never adopts added local files', async t => {
  const f = await fixture(t); await f.make().bootstrap(f.input);
  await fs.writeFile(path.join(f.root, 'extra.txt'), 'new data');
  await assert.rejects(f.make().bootstrap(f.input), { code: 'SYNC_LOCAL_CHANGED' }); assert.equal(f.uploads, 0);
});
