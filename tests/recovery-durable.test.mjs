import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { restoreCheckpoint, validateRestoreDestination } from '../src/snapshot.mjs';
import { sha256, validateManifest } from '../src/protocol.mjs';

const BASE = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const SERVER = 'https://synthetic-durable.invalid';
const USERNAME = 'synthetic-owner';
const opaque = byte => Buffer.alloc(32, byte).toString('base64url');
const deferred = () => Promise.withResolvers();
async function fixture(t, { renewable = true, sessionIds = ['archive-one'], importImpl, createImpl, maxRecoveryRequests } = {}) {
  await fs.mkdir(BASE, { recursive: true }); const root = await fs.mkdtemp(path.join(BASE, 'recovery-durable-'));
  const profileDir = path.join(root, 'private', 'profile'), stateDir = path.join(profileDir, 'sync'), destinationParent = path.join(root, 'downloads');
  await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(destinationParent);
  const credentialKey = credentialKeyForProfile(profileDir), records = new Map(), workspaces = new Map(), controllers = [];
  const grant = { server: SERVER, username: USERNAME, deviceId: 'durable-device', token: opaque(31), expiresAt: '2099-01-01T00:00:00.000Z', authorizationEpoch: 7,
    ...(renewable ? { familyId: opaque(32), refreshToken: opaque(33), serverId: 'durable-server', refreshExpiresAt: '2099-01-02T00:00:00.000Z', absoluteExpiresAt: '2099-02-01T00:00:00.000Z' } : {}) };
  records.set(credentialKey, { kind: 'grant', payload: grant });
  let imports = 0, creates = 0, restores = 0, beforeBlob;
  const ctx = {
    credentials: {
      async readRecord(key) { return structuredClone(records.get(key)); },
      async modifyRecord(key, callback) { const next = await callback(structuredClone(records.get(key))); if (next !== undefined) records.set(key, structuredClone(next)); },
      async deleteRecord(key) { records.delete(key); },
    },
    workspaceRegistry: {
      list: () => [...workspaces.values()], get: id => workspaces.get(id),
      async create(directory) {
        creates++;
        const create = async () => {
          const canonical = await fs.realpath(directory), existing = [...workspaces.values()].find(item => item.path === canonical);
          if (existing) return existing;
          const value = { id: `workspace-${creates}`, path: canonical, title: path.basename(canonical), sessionIds: [], attachSession() { assert.fail('Registration must not attach sessions'); } };
          workspaces.set(value.id, value); return value;
        };
        return createImpl ? createImpl(directory, create) : create();
      },
    },
    sessions: { create() { assert.fail('No live sessions may start'); } }, agents: { create() { assert.fail('No agents may start'); } },
  };
  const contents = new Map();
  function manifest(projectId = 'durable-project', checkpointId = 'durable-checkpoint') {
    const files = [{ path: 'project/hello.txt', bytes: Buffer.from('synthetic durable restore') }, ...sessionIds.map(id => ({ path: `sessions/${id}.json`, bytes: Buffer.from(JSON.stringify({ synthetic: true, id })) }))]
      .map(item => { const hash = sha256(item.bytes); contents.set(hash, item.bytes); return { path: item.path, sha256: hash, size: item.bytes.length }; });
    return validateManifest({ version: 1, id: checkpointId, projectId, deviceId: 'cloud-device', parentId: null, createdAt: '2026-01-01T00:00:00.000Z', sourceRoot: 'E:\\synthetic-durable-source', sessionIds, files });
  }
  function mount() {
    const controller = createController(ctx, { stateDir, server: SERVER, username: USERNAME }, { credentialKey, allowLegacyCli: false, ...(maxRecoveryRequests ? { maxRecoveryRequests } : {}),
      importSessions: async (_ctx, options) => {
        imports++;
        if (importImpl) return importImpl(options);
        const imported = [];
        for (const sourceId of options.manifest.sessionIds) {
          const sessionId = await options.allocateSessionId(sourceId);
          const result = { sourceId, sessionId, workspaceAttached: true }; imported.push(result);
          await options.onResult({ sourceId, imported: [result], skipped: [], failed: [], mapping: { [sourceId]: sessionId } });
        }
        return { imported, skipped: [], failed: [] };
      },
    });
    controller.store.restore = async (_client, checkpointId, destination, options) => {
      restores++;
      const value = manifest(options.projectId, checkpointId);
      const result = await restoreCheckpoint({ manifest: value, destination, signal: options.signal, beforeWrite: options.beforeWrite,
        getBlob: async hash => { await beforeBlob?.({ restore: restores, destination, hash }); return contents.get(hash); },
      });
      return { ...result, manifest: value };
    };
    const service = createSettingsService(ctx, controller, { profileDir, dshHome: path.dirname(profileDir) });
    controllers.push(controller); return { controller, service };
  }
  const current = mount(); await current.controller.store.init();
  await current.controller.store.saveConfig({ server: SERVER, username: USERNAME, deviceId: grant.deviceId, authorizationEpoch: grant.authorizationEpoch });
  const historyFile = path.join(stateDir, `recovery-${sha256(credentialKey).slice(0, 24)}.json`);
  t.after(async () => {
    controllers.forEach(item => item.stop()); await Promise.all(controllers.map(item => item.drain()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(BASE)); assert.match(path.basename(root), /^recovery-durable-[A-Za-z0-9]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  async function binding(target = current) { const value = await target.service.status(); return { revision: value.revision, server: value.server, username: value.username }; }
  async function restore(target = current, requestId = randomUUID(), extra = {}) {
    const input = { ...await binding(target), projectId: 'durable-project', checkpointId: 'durable-checkpoint', destination: path.join(destinationParent, `restored-${requestId}`), requestId, confirm: true, ...extra };
    await target.service.restore(input); await target.controller.drain();
    return { input, recovery: (await target.service.status()).recovery };
  }
  const f = { ...current, root, stateDir, profileDir, destinationParent, credentialKey, historyFile, records, workspaces, ctx, mount, binding, restore,
    history: async () => JSON.parse(await fs.readFile(historyFile, 'utf8')),
    writeHistory: value => fs.writeFile(historyFile, JSON.stringify(value)),
    setBeforeBlob(fn) { beforeBlob = fn; }, get imports() { return imports; }, get creates() { return creates; }, get restores() { return restores; },
    async stop(target = current) { target.controller.stop(); await target.controller.drain(); },
    async importRestored(target, restoreId, requestId = randomUUID()) {
      const input = { ...await binding(target), restoreId, requestId, confirm: true }; await target.service.import(input); await target.controller.drain();
      return { input, recovery: (await target.service.status()).recovery };
    },
    async register(target, restoreId, requestId = randomUUID()) { return target.service.registerproject({ ...await binding(target), restoreId, requestId, confirm: true }); },
  };
  return f;
}

test('completed restore and request receipts survive restart using only nonsecret family/epoch identity', async t => {
  const f = await fixture(t), first = await f.restore(); assert.equal(first.recovery.state, 'succeeded');
  const text = await fs.readFile(f.historyFile, 'utf8'), grant = f.records.get(f.credentialKey).payload;
  for (const secret of [grant.token, grant.refreshToken, 'synthetic-password']) assert.equal(text.includes(secret), false);
  const saved = await f.history(); assert.equal(saved.version, 1); assert.equal(saved.records[0].identity.familyId, grant.familyId);
  assert.equal(saved.records[0].identity.authorizationEpoch, 7); assert.match(saved.records[0].fingerprint, /^[a-f0-9]{64}$/);
  await f.stop();
  const restarted = f.mount(); assert.deepEqual((await restarted.service.status()).recovery, first.recovery);
  assert.deepEqual((await restarted.service.restore(first.input)).recovery, first.recovery); assert.equal(f.restores, 1);
  const imported = await f.importRestored(restarted, first.recovery.id);
  assert.equal(imported.recovery.state, 'succeeded'); assert.equal(imported.recovery.importedCount, 1); assert.equal(f.imports, 1);
  assert.match(imported.recovery.sessions[0].sessionId, /^import-/);
  await f.stop(restarted); const again = f.mount();
  assert.deepEqual((await again.service.import(imported.input)).recovery, imported.recovery); assert.equal(f.imports, 1);
  await assert.rejects(f.importRestored(again, first.recovery.id), { code: 'RECOVERY_UNAVAILABLE' });
});

test('normal renewal preserves durable recovery visibility, explicit epoch/family changes hide old tasks', async t => {
  const f = await fixture(t), first = await f.restore(); await f.stop();
  const payload = f.records.get(f.credentialKey).payload;
  payload.token = opaque(34); payload.refreshToken = opaque(35); payload.expiresAt = '2099-01-01T01:00:00.000Z';
  let restarted = f.mount(); assert.equal((await restarted.service.status()).recovery.id, first.recovery.id); await f.stop(restarted);
  payload.authorizationEpoch++; payload.familyId = opaque(36);
  await f.controller.store.saveConfig({ server: SERVER, username: USERNAME, deviceId: payload.deviceId, authorizationEpoch: payload.authorizationEpoch });
  restarted = f.mount(); assert.equal((await restarted.service.status()).recovery, undefined);
  await assert.rejects(restarted.service.restore(first.input), { code: 'RECOVERY_UNAVAILABLE' });
  await assert.rejects(f.register(restarted, first.recovery.id), { code: 'RECOVERY_UNAVAILABLE' }); assert.equal(f.creates, 0);
});

test('legacy grant visibility persists only its digest and disappears when the bearer changes', async t => {
  const f = await fixture(t, { renewable: false }), first = await f.restore();
  const identity = (await f.history()).records[0].identity, grant = f.records.get(f.credentialKey).payload;
  assert.equal(identity.tokenDigest, sha256(grant.token)); assert.equal(Object.hasOwn(identity, 'token'), false); assert.equal(Object.hasOwn(identity, 'familyId'), false);
  await f.stop(); const restarted = f.mount(); assert.equal((await restarted.service.status()).recovery.id, first.recovery.id);
  await f.stop(restarted); grant.token = opaque(99);
  const changed = f.mount(); assert.equal((await changed.service.status()).recovery, undefined);
});

test('interrupted batch never resumes existing roots and preserves completed item import eligibility', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); t.after(() => release.resolve());
  f.setBeforeBlob(async ({ restore }) => { if (restore === 2) { entered.resolve(); await release.promise; } });
  const rows = [0, 1, 2].map(index => ({ projectId: `batch-project-${index}`, checkpointId: `batch-checkpoint-${index}`, destinationId: `plan-${index}`, root: path.join(f.destinationParent, `batch-${index}`), label: `Batch ${index}`, check: async () => {} }));
  const input = { requestId: 'batch-interrupted', items: rows.map(({ projectId, checkpointId, destinationId }) => ({ projectId, checkpointId, destinationId })) };
  const options = { checkBinding: async () => {}, admitDestination: (root, extra) => validateRestoreDestination(root, [f.profileDir], extra), resolveDestinations: () => rows.map(item => ({ ...item })) };
  await f.controller.startDownload(input, options); await entered.promise;
  const atCrash = await f.history(), firstId = atCrash.records[0].value.items[0].restoreId;
  assert.equal(atCrash.records[0].value.items[0].state, 'succeeded'); assert.equal(atCrash.records[0].value.items[1].state, 'running');
  f.controller.stop(); release.resolve(); await f.controller.drain();
  await f.writeHistory(atCrash); f.setBeforeBlob(undefined);
  const restarted = f.mount(), value = (await restarted.service.status()).download;
  assert.equal(value.state, 'partial'); assert.equal(value.completed, 3);
  assert.deepEqual(value.items.map(item => item.state), ['succeeded', 'cancelled', 'cancelled']); assert.equal(value.items[0].canImport, true);
  assert.ok(await fs.stat(path.join(rows[1].root, '.dsh-sync', 'INCOMPLETE'))); await assert.rejects(fs.stat(rows[2].root), { code: 'ENOENT' });
  const before = f.restores;
  assert.deepEqual((await restarted.controller.startDownload(input, { ...options, resolveDestinations() { assert.fail('An old request cannot re-admit roots'); } })).download, value);
  assert.equal(f.restores, before);
  const imported = await f.importRestored(restarted, firstId); assert.equal(imported.recovery.state, 'succeeded'); assert.equal(f.imports, 1);
});

test('an interrupted native import retains its allocated possible ID and never replays after restart', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let allocated;
  const f = await fixture(t, { importImpl: async options => {
    allocated = await options.allocateSessionId(options.manifest.sessionIds[0]); entered.resolve(); await release.promise;
    return { imported: [{ sourceId: options.manifest.sessionIds[0], sessionId: allocated, workspaceAttached: true }], skipped: [], failed: [] };
  } });
  const restored = await f.restore(), input = { ...await f.binding(), restoreId: restored.recovery.id, requestId: 'import-interrupted', confirm: true };
  await f.service.import(input); await entered.promise;
  const atCrash = await f.history(); assert.equal(atCrash.restores[0].consumed, true);
  assert.equal(atCrash.records.at(-1).allocations[0].sessionId, allocated);
  f.controller.stop(); release.resolve(); await f.controller.drain(); await f.writeHistory(atCrash);
  const restarted = f.mount(), value = (await restarted.service.status()).recovery;
  assert.equal(value.kind, 'import'); assert.equal(value.state, 'failed'); assert.equal(value.errorCode, 'RECOVERY_UNCERTAIN');
  assert.deepEqual(value.sessions, [{ sourceId: 'archive-one', sessionId: allocated, outcome: 'failed' }]); assert.equal(value.failedCount, 1);
  assert.deepEqual((await restarted.service.import(input)).recovery, value); assert.equal(f.imports, 1);
  await assert.rejects(f.importRestored(restarted, restored.recovery.id), { code: 'RECOVERY_UNAVAILABLE' }); assert.equal(f.imports, 1);
});

test('import progress callbacks persist partial known results and consume eligibility before native effects', async t => {
  let f;
  f = await fixture(t, { sessionIds: ['archive-one', 'archive-two'], importImpl: async options => {
    assert.equal((await f.history()).restores[0].consumed, true);
    const id = await options.allocateSessionId('archive-one');
    await options.onResult({ sourceId: 'archive-one', imported: [{ sourceId: 'archive-one', sessionId: id, workspaceAttached: true }], skipped: [], failed: [] });
    assert.equal((await f.history()).records.at(-1).value.importedCount, 1);
    throw new Error('synthetic provider failure containing secret path');
  } });
  const restored = await f.restore(), imported = await f.importRestored(f, restored.recovery.id);
  assert.equal(imported.recovery.state, 'failed'); assert.equal(imported.recovery.importedCount, 1); assert.equal(imported.recovery.sessions.length, 1);
  assert.equal(JSON.stringify(imported.recovery).includes('synthetic provider'), false);
  await f.stop(); const restarted = f.mount(); assert.deepEqual((await restarted.service.status()).recovery, imported.recovery);
  await assert.rejects(f.importRestored(restarted, restored.recovery.id), { code: 'RECOVERY_UNAVAILABLE' }); assert.equal(f.imports, 1);
});

test('registration accepts only a trusted verified completed root and never selects sync or imports sessions', async t => {
  const f = await fixture(t, { sessionIds: [] }), restored = await f.restore();
  const before = await f.controller.store.config(), bound = await f.binding();
  for (const patch of [{ root: f.root }, { confirm: false }, { revision: bound.revision + 1 }, { restoreId: 'forged' }, { server: 'https://another.invalid' }]) {
    await assert.rejects(f.service.registerproject({ ...bound, restoreId: restored.recovery.id, requestId: randomUUID(), confirm: true, ...patch }));
  }
  assert.equal(f.creates, 0);
  const result = await f.register(f, restored.recovery.id, 'registration-one');
  assert.equal(result.registered, true); assert.equal(result.root, restored.recovery.root); assert.equal(result.workspaceId, 'workspace-1');
  assert.equal(f.creates, 1); assert.equal(f.imports, 0); assert.deepEqual(await f.controller.store.config(), before);
  const status = await f.service.status(); assert.equal(status.autoSync, false); assert.equal(status.projects[0].selected, false);
  await f.stop(); const restarted = f.mount();
  assert.deepEqual(await f.register(restarted, restored.recovery.id, 'registration-one'), result);
  assert.equal((await f.register(restarted, restored.recovery.id, 'registration-two')).workspaceId, result.workspaceId); assert.equal(f.creates, 1);
});

test('registration validates immutable manifest, file hashes, completeness and physical root identity', async t => {
  const f = await fixture(t, { sessionIds: [] }), restored = await f.restore(), root = restored.recovery.root;
  const manifestPath = path.join(root, '.dsh-sync', 'manifest.json'), manifest = await fs.readFile(manifestPath);
  await fs.writeFile(manifestPath, '{}'); await assert.rejects(f.register(f, restored.recovery.id)); await fs.writeFile(manifestPath, manifest);
  const file = path.join(root, 'hello.txt'), content = await fs.readFile(file);
  await fs.writeFile(file, 'changed'); await assert.rejects(f.register(f, restored.recovery.id), { code: 'CHECKPOINT_MISMATCH' }); await fs.writeFile(file, content);
  await fs.writeFile(path.join(root, '.dsh-sync', 'INCOMPLETE'), 'synthetic incomplete');
  await assert.rejects(f.register(f, restored.recovery.id), { code: 'CHECKPOINT_MISMATCH' });
  const marker = path.resolve(root, '.dsh-sync', 'INCOMPLETE'); assert.equal(path.dirname(marker), path.join(root, '.dsh-sync')); await fs.unlink(marker);
  const moved = path.resolve(root + '-original'); assert.equal(path.dirname(moved), f.destinationParent); assert.equal(path.dirname(path.resolve(root)), f.destinationParent);
  await fs.rename(root, moved); await fs.mkdir(root);
  await assert.rejects(f.register(f, restored.recovery.id), { code: 'DESTINATION_CHANGED' }); assert.equal(f.creates, 0);
});

test('provider creation that writes then throws reports uncertainty and only reconciles by reads, never rollback or replay', async t => {
  const f = await fixture(t, { sessionIds: [], createImpl: async (_root, create) => { await create(); throw new Error('untrusted native secret failure'); } });
  const restored = await f.restore();
  const result = await f.register(f, restored.recovery.id, 'registration-unknown');
  assert.equal(result.registered, false); assert.equal(result.uncertain, true); assert.equal(result.errorCode, 'PROJECT_REGISTRATION_UNCERTAIN');
  assert.equal(f.workspaces.size, 1); assert.equal(f.creates, 1); assert.equal(JSON.stringify(result).includes('untrusted'), false);
  await f.stop(); const restarted = f.mount(), confirmed = await f.register(restarted, restored.recovery.id, 'registration-unknown');
  assert.equal(confirmed.registered, true); assert.equal(confirmed.workspaceId, 'workspace-1'); assert.equal(f.creates, 1);
});

test('native registration failure before visible commit is never blindly retried under another request id', async t => {
  const f = await fixture(t, { sessionIds: [], createImpl: async () => { throw new Error('synthetic unconfirmed failure'); } });
  const restored = await f.restore(); assert.equal((await f.register(f, restored.recovery.id, 'registration-first')).uncertain, true);
  assert.equal((await f.register(f, restored.recovery.id, 'registration-first')).uncertain, true);
  assert.equal((await f.register(f, restored.recovery.id, 'registration-second')).uncertain, true); assert.equal(f.creates, 1);
});

test('corrupt or cross-profile recovery metadata fails closed without accepting injected credential fields', async t => {
  const f = await fixture(t), restored = await f.restore(), valid = await f.history(); await f.stop();
  for (const mutate of [
    value => { value.records[0].identity.token = opaque(9); }, value => { value.profile = '0'.repeat(64); },
    value => { value.restores[0].rootIdentity.ino = '../bad'; }, value => { value.records[0].fingerprint = 'bad'; },
    value => { value.restores[0].digest = 'bad'; }, value => { value.records.push(structuredClone(value.records[0])); },
    value => { value.restores[0].value.root = 'relative'; }, value => { value.records[0].identity.authorizationEpoch = -1; },
    value => { value.restores[0].consumed = true; },
  ]) {
    const corrupt = structuredClone(valid); mutate(corrupt); await f.writeHistory(corrupt);
    const restarted = f.mount(); await assert.rejects(restarted.service.status(), { code: 'RECOVERY_STATE_CORRUPT' });
    await assert.rejects(restarted.controller.registerProject({ restoreId: restored.recovery.id, requestId: randomUUID() }), { code: 'RECOVERY_STATE_CORRUPT' });
    await f.stop(restarted);
  }
  assert.equal(f.creates, 0); assert.equal(f.imports, 0);
});

test('durable history is bounded and a failed admission save prevents restore/native effects', async t => {
  const f = await fixture(t, { maxRecoveryRequests: 1 }); await f.restore(); await f.stop();
  const restarted = f.mount(); await assert.rejects(f.restore(restarted), { code: 'RECOVERY_LIMIT' }); assert.equal(f.restores, 1);
  const second = await fixture(t), original = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (path.resolve(target) === second.historyFile) throw new Error('synthetic durable metadata failure');
    return original(source, target);
  });
  await assert.rejects(second.restore()); assert.equal(second.restores, 0); assert.equal(second.imports, 0); assert.equal(second.creates, 0);
});

test('registration final-save failure preserves pending intent and restart confirms without another native create', async t => {
  const f = await fixture(t, { sessionIds: [] }), restored = await f.restore(), original = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source, target) => {
    if (path.resolve(target) === f.historyFile && f.creates > 0) throw new Error('synthetic post-native journal failure');
    return original(source, target);
  });
  const result = await f.register(f, restored.recovery.id, 'save-uncertain');
  assert.equal(result.uncertain, true); assert.equal(f.creates, 1);
  assert.equal((await f.history()).registrations[0].state, 'pending');
  await f.stop(); mock.mock.restore();
  const restarted = f.mount();
  assert.equal((await f.register(restarted, restored.recovery.id, 'save-uncertain')).registered, true);
  assert.equal(f.creates, 1);
});

// Internal compatibility remains covered above; the retired browser workflow is
// deliberately absent. Real production transport must reject even valid consent.
test('removed native registration RPC never dispatches retained internal registration', async t => {
  const f = await fixture(t, { sessionIds: [] }), restored = await f.restore(), bridge = createSettingsHttp(f.service);
  t.after(() => bridge.dispose());
  const input = { ...await f.binding(), restoreId: restored.recovery.id, requestId: 'rpc-registration', confirm: true };
  for (const payload of [input, { ...input, root: f.root }]) {
    const request = new Request('http://dsh.internal' + SETTINGS_API + 'registerproject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'durable-rpc', method: 'dsh-personal-sync/registerproject', payload }) });
    const response = await bridge.fetch('registerproject', request);
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.creates, 0); assert.equal(f.imports, 0);
});
