import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { withBidirectionalSync } from '../plugin/bidirectional-service.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncEngine } from '../src/sync-engine.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url)), gib = 1024 ** 3;
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'bidir-performance-'));
  const root = path.join(directory, 'project'), profileDir = path.join(directory, 'profile'); await fs.mkdir(root); await fs.mkdir(profileDir);
  const cloud = await createSyncServer({ dataDir: path.join(directory, 'cloud'), username: 'owner', password: 'synthetic-performance' }); await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`, records = new Map(); let clock = Date.now();
  const ctx = { workspaceRegistry: { list: () => [{ id: 'workspace', path: root, title: 'Fixture' }], get: id => id === 'workspace' ? { id, path: root } : null }, credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); }, deleteRecord: async key => records.delete(key) },
    sessionPersistence: { list: async () => [], stat: async () => undefined }, sessions: { list: () => [], get: () => undefined }, agents: { get: () => undefined }, waterfall: async (_event, _payload, next) => next() };
  const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false });
  const settings = createSettingsService(ctx, controller, { profileDir });
  const sessionAdapter = { exportProjectSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }) };
  const service = withBidirectionalSync(ctx, controller, settings, { profileDir, enableWatchers: false, now: () => clock, sessionAdapter });
  t.after(async () => { service.stopBidirectional(); controller.stop(); await Promise.all([service.drainBidirectional(), controller.drain()]); await closeSyncServer(cloud); assert.equal(path.dirname(path.resolve(directory)), path.resolve(base)); assert.match(path.basename(directory), /^bidir-performance-[A-Za-z0-9]+$/); assert.equal(await fs.realpath(directory), path.resolve(directory)); await fs.rm(directory, { recursive: true, force: true }); });
  await service.login({ server, username: 'owner', password: 'synthetic-performance', remember: true }); await fs.writeFile(path.join(root, 'file.txt'), 'initial');
  const identity = async () => { const status = await service.syncstatus(); return { revision: status.revision, server: status.server, username: status.username }; };
  const auth = await identity(), plan = await service.pairplan({ ...auth, workspaceId: 'workspace', projectId: null });
  await service.paircommit({ ...auth, planId: plan.plan.id, requestId: 'initial', confirm: true }); await service.drainBidirectional();
  const binding = (await service.syncstatus()).bindings[0];
  return { directory, root, controller, service, identity, binding, client: () => new SyncV2Client(records.get(controller.credentialKey).payload), advance(ms) { clock += ms; }, async run(id) { await service.syncrun({ ...await identity(), bindingId: binding.id, requestId: id }); await service.drainBidirectional(); return service.syncstatus(); } };
}

test('unchanged healthy projects poll metadata only, still force full scans and detect new edits', async t => {
  const f = await fixture(t), original = SyncEngine.prototype.run; let fullScans = 0;
  t.mock.method(SyncEngine.prototype, 'run', async function (...args) { fullScans++; return original.apply(this, args); });
  f.advance(20_000); await f.service.tickBidirectional(); assert.equal(fullScans, 1);
  f.advance(20_000); await f.service.tickBidirectional(); assert.equal(fullScans, 1, 'unchanged metadata must not rehash payloads');
  f.advance(300_001); await f.service.tickBidirectional(); assert.equal(fullScans, 2, 'five-minute full verification must not be skipped');
  await fs.writeFile(path.join(f.root, 'file.txt'), 'changed'); f.advance(31_000); await f.service.tickBidirectional(); assert.equal(fullScans, 3);
  const head = await f.client().syncHead(f.binding.projectId), manifest = await f.client().syncCheckpoint(f.binding.projectId, head.id, head.manifestDigest);
  assert.equal((await f.client().downloadBlob(manifest.files[0].hash, manifest.files[0].size)).toString(), 'changed');
});

test('shared profile usage blocks growth globally and quota setting is explicit revision-bound without changing selection', async t => {
  const f = await fixture(t), before = await f.service.syncstatus();
  assert.equal(before.storage.limitBytes, 10 * gib);
  const lower = await f.service.syncsettings({ ...await f.identity(), quotaBytes: gib }); assert.ok(lower.revision > before.revision); assert.equal(lower.bindings[0].enabled, true);
  await assert.rejects(f.service.syncsettings({ ...await f.identity(), quotaBytes: 1.5 * gib }), { code: 'BAD_REQUEST' });
  await assert.rejects(f.service.syncsettings({ revision: before.revision, server: before.server, username: before.username, quotaBytes: 3 * gib }), { code: 'CONFIG_CONFLICT' });
  const marker = path.join(f.controller.store.directory, 'synthetic-shared-usage'); await fs.writeFile(marker, 'metadata only');
  const lstat = fs.lstat;
  // Simulate a large owned shared cache through metadata; do NOT allocate GiBs
  // on the development machine or read those synthetic bytes as real payload.
  t.mock.method(fs, 'lstat', async function (filename, options) {
    const info = await lstat(filename, options);
    if (path.resolve(String(filename)) !== marker || !options?.bigint) return info;
    return new Proxy(info, { get(target, key) { if (key === 'size') return BigInt(2 * gib); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  });
  await fs.writeFile(path.join(f.root, 'file.txt'), 'after-limit'); const head = await f.client().syncHead(f.binding.projectId);
  await assert.rejects(f.run('blocked'), { code: 'SYNC_QUOTA' });
  const blocked = await f.service.syncstatus(); assert.equal(blocked.operations.some(item => item.id === 'blocked'), false, 'over-budget admission must not enqueue another write');
  assert.equal((await f.client().syncHead(f.binding.projectId)).id, head.id);
  await f.service.syncsettings({ ...await f.identity(), quotaBytes: 3 * gib });
  const resumed = await f.run('resumed'); assert.equal(resumed.operations.find(item => item.id === 'resumed').state, 'succeeded', JSON.stringify(resumed));
  assert.notEqual((await f.client().syncHead(f.binding.projectId)).id, head.id);
  assert.equal(await fs.readFile(marker, 'utf8'), 'metadata only', 'quota never cleans or rewrites retained data');
});
