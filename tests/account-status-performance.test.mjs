import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { sha256 } from '../src/protocol.mjs';

const base = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
const password = 'synthetic-lean-account-password';
async function fixture(t, count = 2) {
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'lean-account-'));
  const home = path.join(directory, 'private'), profileDir = path.join(home, 'profiles', 'synthetic');
  await fs.mkdir(profileDir, { recursive: true });
  const workspaces = new Map(), records = new Map();
  for (let i = 0; i < count; i++) {
    const root = path.join(directory, `project-${i}`); await fs.mkdir(root);
    workspaces.set(`workspace-${i}`, { id: `workspace-${i}`, path: root, title: `Synthetic ${i}`, sessionIds: [] });
  }
  const ctx = { workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, callback) => { const value = await callback(records.get(key)); if (value !== undefined) records.set(key, value); },
    deleteRecord: async key => records.delete(key),
  } };
  const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false });
  const service = createSettingsService(ctx, controller, { profileDir, dshHome: home });
  const server = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    controller.stop(); await controller.drain(); await closeSyncServer(server);
    assert.equal(path.dirname(directory), base); assert.match(path.basename(directory), /^lean-account-[A-Za-z0-9]+$/);
    assert.equal(await fs.realpath(directory), directory);
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(directory, { recursive: true });
  });
  await service.login({ server: `http://127.0.0.1:${server.address().port}`, username: 'owner', password });
  return { directory, workspaces, records, ctx, controller, service };
}
const publicFields = value => Object.fromEntries(['revision', 'server', 'username', 'loggedIn', 'expiresAt', 'authState', 'reauthRequired', 'running'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

test('account-only Host reads avoid legacy workspace/queue scans while preserving current account metadata', async t => {
  const f = await fixture(t, 40), grant = f.records.get(f.controller.credentialKey).payload;
  const pendingFiles = [];
  for (let i = 0; i < 8; i++) {
    const manifest = { version: 1, id: `queued-${i}`, projectId: 'retained-project', deviceId: grant.deviceId, parentId: i ? `queued-${i - 1}` : null,
      createdAt: '2026-01-01T00:00:00.000Z', sourceRoot: f.workspaces.get('workspace-0').path, sessionIds: [],
      files: Array.from({ length: 128 }, (_, index) => ({ path: `project/file-${index}.txt`, sha256: sha256(Buffer.from('retained synthetic bytes')), size: 24 })) };
    const filename = path.join(f.controller.store.directory, 'pending', `${manifest.id}.json`);
    await fs.writeFile(filename, JSON.stringify(manifest)); pendingFiles.push(filename);
  }
  const before = await Promise.all(pendingFiles.map(filename => fs.readFile(filename)));
  const list = f.ctx.workspaceRegistry.list, pending = f.controller.store.pending;
  const listSpy = t.mock.method(f.ctx.workspaceRegistry, 'list', () => list());
  const pendingSpy = t.mock.method(f.controller.store, 'pending', function(...args) { return pending.apply(this, args); });
  const startedFull = performance.now(), full = await f.service.status(), fullMs = performance.now() - startedFull;
  const countsFull = { workspaceInventories: listSpy.mock.callCount(), queueDecodes: pendingSpy.mock.callCount() };
  assert.equal(countsFull.workspaceInventories, 1); assert.equal(countsFull.queueDecodes, 1);
  assert.equal(full.projects.length, 40); assert.equal(full.pending, 8);
  const startedLean = performance.now(), lean = await f.service.accountStatus(), leanMs = performance.now() - startedLean;
  assert.deepEqual(publicFields(lean), publicFields(full));
  assert.equal(listSpy.mock.callCount(), countsFull.workspaceInventories);
  assert.equal(pendingSpy.mock.callCount(), countsFull.queueDecodes);
  for (const key of ['projects', 'pending', 'recovery', 'download', 'lastResult', 'autoSync', 'intervalMs', 'token', 'refreshToken', 'password']) assert.equal(Object.hasOwn(lean, key), false, key);
  assert.equal(JSON.stringify(lean).includes(grant.token), false);
  assert.deepEqual(await Promise.all(pendingFiles.map(filename => fs.readFile(filename))), before);
  t.diagnostic(JSON.stringify({ fixture: '40 registered workspaces; 8 retained manifests x128 files', full: { ...countsFull, elapsedMs: +fullMs.toFixed(2) }, accountOnly: { workspaceInventories: 0, queueDecodes: 0, elapsedMs: +leanMs.toFixed(2) }, measurement: 'synthetic local reads, not real GUI or WAN latency' }));
});

test('lean account status rereads native authority and ignores malformed retired inventory, not auth damage', async t => {
  const f = await fixture(t), record = structuredClone(f.records.get(f.controller.credentialKey));
  await fs.writeFile(path.join(f.controller.store.directory, 'pending', 'malformed-retired.json'), '{broken');
  t.mock.method(f.ctx.workspaceRegistry, 'list', () => assert.fail('Account identity must not enumerate workspaces'));
  t.mock.method(f.controller.store, 'pending', async () => assert.fail('Account identity must not decode retired queues'));
  assert.equal((await f.service.accountStatus()).loggedIn, true);
  f.records.delete(f.controller.credentialKey);
  assert.equal((await f.service.accountStatus()).loggedIn, false, 'no cached authorization or CLI fallback');
  f.records.set(f.controller.credentialKey, { ...record, payload: { ...record.payload, expiresAt: '2000-01-01T00:00:00.000Z' } });
  assert.equal((await f.service.accountStatus()).loggedIn, false);
  f.records.set(f.controller.credentialKey, record);
  assert.equal((await f.service.accountStatus()).loggedIn, true);
  await fs.writeFile(path.join(f.controller.store.directory, 'config.json'), '{broken');
  assert.equal((await f.controller.accountStatus()).loggedIn, false, 'damaged identity is still fail-closed');
});

test('lean settings DTO rejects a revision race and drops unrelated controller response fields', async t => {
  const f = await fixture(t), initial = await f.service.accountStatus(), original = f.controller.accountStatus;
  const spy = t.mock.method(f.controller, 'accountStatus', async () => ({ ...await original.call(f.controller), token: 'secret-not-public', password: 'secret-not-public', projects: ['legacy'], pending: 99 }));
  assert.deepEqual(await f.service.accountStatus(), initial);
  spy.mock.mockImplementation(async () => {
    const value = await original.call(f.controller);
    await f.service.savePreferences({ revision: initial.revision, projectIds: [], autoSync: false });
    return value;
  });
  await assert.rejects(f.service.accountStatus(), { code: 'CONFIG_CONFLICT' });
});

test('lean account status still reports live v2 work and updater busy state', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const work = f.controller.runSyncOperation(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try { assert.equal((await f.service.accountStatus()).running, true); }
  finally { release.resolve(); await work; }
  assert.equal((await f.service.accountStatus()).running, false);
  f.controller.markUpdateRestartRequired();
  assert.equal((await f.service.accountStatus()).loggedIn, true, 'status remains readable after update gate');
});
