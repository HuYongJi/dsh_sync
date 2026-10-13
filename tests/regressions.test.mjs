import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '../src/local-store.mjs';
import { SyncClient } from '../src/client.mjs';
import { validateManifest, sha256 } from '../src/protocol.mjs';
import { createController, apply, credentialKeyForProfile } from '../plugin/index.mjs';
import { captureCheckpoint } from '../src/snapshot.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
async function temp(t) {
  await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'regression-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(base)); assert.ok(path.basename(directory).startsWith('regression-')); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}
test('state names containing glob syntax are excluded literally from capture and preview', async t => {
  const root = await temp(t), state = path.join(root, 'state[1]');
  const store = await new LocalStore(state).init(); await store.saveConfig({ token: 'SECRET-BEARER-FIXTURE' });
  const result = await store.capture({ root, projectId: 'demo', deviceId: 'a' });
  assert.equal(result.manifest.files.length, 0);
  const preview = await captureCheckpoint({ root, projectId: 'demo', deviceId: 'preview', excludedPaths: ['state[1]'], putBlob: async () => {} });
  assert.deepEqual(preview.manifest.files, []);
});
test('queue root and server binding are checked before uploading any blob', async t => {
  const directory = await temp(t), rootA = path.join(directory, 'a'), rootB = path.join(directory, 'b');
  await fs.mkdir(rootA); await fs.mkdir(rootB); await fs.writeFile(path.join(rootA, 'private.txt'), 'A data');
  const store = await new LocalStore(path.join(directory, 'state')).init();
  await store.saveConfig({ server: 'https://server-a.example', deviceId: 'a' });
  await store.capture({ root: rootA, projectId: 'demo', deviceId: 'a' });
  let uploads = 0;
  const client = { server: 'https://server-a.example', uploadBlob: async () => uploads++ };
  await assert.rejects(store.flush(client, 'demo', { root: rootB, deviceId: 'a' }), /another project root/);
  await assert.rejects(store.flush({ ...client, server: 'https://server-b.example' }, 'demo', { root: rootA }), /another server/);
  await assert.rejects(store.capture({ root: rootB, projectId: 'demo', deviceId: 'a' }), /another root/);
  assert.equal(uploads, 0);
});
test('oversized valid-path manifests fail validation before they can jam the spool', () => {
  const prefix = `project/${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/`;
  const files = Array.from({ length: 12_000 }, (_, i) => ({ path: `${prefix}${i}`, sha256: sha256(''), size: 0 }));
  assert.throws(() => validateManifest({ version: 1, id: 'large', projectId: 'demo', deviceId: 'a', parentId: null, createdAt: new Date().toISOString(), sourceRoot: '/project', sessionIds: [], files }), /byte limit/);
});
test('object-prototype-looking project IDs are treated as ordinary own keys', async t => {
  const directory = await temp(t), root = path.join(directory, 'root'); await fs.mkdir(root);
  const store = await new LocalStore(path.join(directory, 'state')).init();
  const captured = await store.capture({ root, projectId: 'toString', deviceId: 'a' });
  assert.equal(captured.manifest.projectId, 'toString');
  await store.flush({ uploadBlob: async () => {}, commit: async item => ({ id: item.id, conflict: false, heads: [item.id] }) });
  assert.equal((await store.capture({ root, projectId: 'toString', deviceId: 'a' })).unchanged, true);
});
test('logout forgets invalid/expired token and distinguishes unconfirmed remote revocation', async () => {
  const client = new SyncClient({ server: 'https://sync.example', token: 'x'.repeat(43) });
  client.request = async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); };
  assert.equal((await client.logout()).remoteRevoked, true); assert.equal(client.token, undefined);
  client.token = 'x'.repeat(43); client.request = async () => { throw new Error('offline'); };
  const result = await client.logout(); assert.equal(result.remoteRevoked, false); assert.match(result.warning, /until expiry/); assert.equal(client.token, undefined);
});
test('native login rejects server/account switching with pending data before prompting a password', async t => {
  const directory = await temp(t), root = path.join(directory, 'root'); await fs.mkdir(root);
  const stateDir = path.join(directory, 'state');
  const store = await new LocalStore(stateDir).init(); await store.saveConfig({ server: 'https://old.example', username: 'owner', deviceId: 'a' });
  await store.capture({ root, projectId: 'demo', deviceId: 'a' });
  const controller = createController({}, { server: 'https://new.example', username: 'owner', stateDir });
  let prompts = 0;
  await assert.rejects(controller.authorize({ signal: new AbortController().signal, prompt: async () => prompts++, commit: async () => {} }), /stateDir/);
  assert.equal(prompts, 0);
});
test('plugin registers inert-by-default native login/commands and scoped settings routes', async t => {
  const directory = await temp(t), commands = [], flows = [], hooks = [], routes = [];
  const profileDir = path.join(directory, 'dsh-home', 'profiles', 'fixture');
  apply({ profileContext: { dir: profileDir, home: path.join(directory, 'dsh-home') }, connection: { fetch: { register: value => routes.push(value) } }, authorization: { registerFlow: value => flows.push(value) }, commands: { register: value => commands.push(value) }, on: (...args) => hooks.push(args) });
  t.after(() => hooks.find(([name]) => name === 'dispose')[1]());
  assert.equal(flows[0].key, credentialKeyForProfile(profileDir)); assert.equal(flows[0].methods[0].id, 'password');
  assert.deepEqual(commands.map(command => command.name), ['sync-status', 'sync-logout']); assert.ok(commands.every(command => command.recordInput === false));
  assert.equal(routes.length, 33); assert.ok(routes.every(route => route.requestBody === 'streaming' && route.methods.length === 1 && route.methods[0] === 'POST'));
});
test('native flow stores token only in its credential record and syncs only the mapped idle project', async t => {
  const directory = await temp(t), root = path.join(directory, 'root'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'hello'), 'fixture');
  const server = await createSyncServer({ dataDir: path.join(directory, 'server'), username: 'owner', password: 'fixture-password-at-least-16' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let record, verified = 0;
    const ctx = { credentials: { readRecord: async () => record, deleteRecord: async () => { record = undefined; } } };
    const controller = createController(ctx, { server: `http://127.0.0.1:${server.address().port}`, username: 'owner', stateDir: path.join(directory, 'state'), projects: [{ id: 'demo', root }] }, { exportSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => verified++ }) });
    await controller.authorize({ signal: new AbortController().signal, prompt: async request => { assert.equal(request.kind, 'secret'); return 'fixture-password-at-least-16'; }, commit: async value => { record = value; } });
    assert.equal(record.kind, 'grant'); assert.equal((await controller.store.config()).token, undefined);
    const result = await controller.push('demo'); assert.equal(result.uploaded.length, 1); assert.equal(verified, 1);
    await assert.rejects(controller.push('unmapped'), /未在插件配置/);
    const status = await controller.status(); assert.equal(status.loggedIn, true); assert.ok(!JSON.stringify(status).includes(record.payload.token));
    assert.equal((await controller.logout()).remoteRevoked, true); assert.equal(record, undefined);
  } finally { await closeSyncServer(server); }
});
