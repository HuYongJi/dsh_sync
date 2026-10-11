import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { validateRestoreDestination } from '../src/snapshot.mjs';
import { MAX_FILES, MAX_CHECKPOINT_BYTES, MAX_MANIFEST_BYTES, validateManifest } from '../src/protocol.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-recovery-password';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function request(action, payload, signal) {
  return new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'recovery-rpc', method: `dsh-personal-sync/${action}`, payload }) });
}
async function rpc(bridge, action, payload, signal) {
  const response = await bridge.fetch(action, request(action, payload, signal));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.equal(body.rpcId, 'recovery-rpc');
  assert.ok(!JSON.stringify(body).includes(password));
  return body.result;
}
async function good(bridge, action, payload, signal) { const result = await rpc(bridge, action, payload, signal); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
async function rejected(bridge, action, payload, code) { const result = await rpc(bridge, action, payload); assert.equal(result.ok, false); assert.equal(result.error.code, code); return result; }
const binding = status => ({ revision: status.revision, server: status.server, username: status.username });
async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'recovery-'));
  const dshHome = path.join(root, 'private'), profileDir = path.join(dshHome, 'profiles', 'fixture'), source = path.join(root, 'source');
  await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(source); await fs.writeFile(path.join(source, 'hello.txt'), 'synthetic project');
  const records = new Map(), workspaces = new Map([['local-project', { id: 'local-project', path: source, title: 'Synthetic project' }]]);
  const ctx = { workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: {
    readRecord: async key => records.get(key), modifyRecord: async (key, callback) => { const value = await callback(records.get(key)); if (value !== undefined) records.set(key, value); }, deleteRecord: async key => records.delete(key),
  } };
  const sessionIds = options.sessionIds || ['archived-session']; let importCalls = 0;
  const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, {
    credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false, ...(options.maxRecoveryRequests ? { maxRecoveryRequests: options.maxRecoveryRequests } : {}),
    exportSessions: options.exportSessions || (async () => ({ sessions: sessionIds.map(id => ({ id, data: { synthetic: true, sessionId: id } })), assets: [], skipped: [] })),
    importSessions: async (...args) => { importCalls++; return options.importSessions ? options.importSessions(...args) : { imported: args[1].manifest.sessionIds.map(sourceId => ({ sourceId, sessionId: `new-${sourceId}`, workspaceAttached: true })), skipped: [], failed: [] }; },
  });
  const service = createSettingsService(ctx, controller, { profileDir, dshHome }), bridge = createSettingsHttp(service);
  const cloudDir = path.join(root, 'cloud'), cloud = await createSyncServer({ dataDir: cloudDir, username: 'owner', password });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve)); const server = `http://127.0.0.1:${cloud.address().port}`;
  t.after(async () => {
    bridge.dispose(); controller.stop(); await controller.drain(); await closeSyncServer(cloud);
    assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('recovery-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const login = await good(bridge, 'login', { server, username: 'owner', password });
  const selected = await good(bridge, 'preferences', { revision: login.revision, autoSync: false, projectIds: ['local-project'] });
  const projectId = selected.projects.find(item => item.selected).projectId;
  const client = new SyncClient(records.get(controller.credentialKey).payload);
  let checkpointId;
  if (!options.noUpload) { await controller.push(projectId); checkpointId = (await client.list(projectId)).heads[0]; }
  const bound = binding(await service.status());
  const restorePayload = (extra = {}) => ({ ...bound, projectId, checkpointId, destination: path.join(root, `restored-${randomUUID()}`), confirm: true, requestId: randomUUID(), ...extra });
  async function settle() { await controller.drain(); return (await good(bridge, 'status', {})).recovery; }
  async function restore(extra) { const payload = restorePayload(extra), accepted = await good(bridge, 'restore', payload); assert.equal(accepted.recovery.state, 'running'); return { payload, recovery: await settle() }; }
  return { root, dshHome, profileDir, source, records, workspaces, ctx, controller, service, bridge, cloud, cloudDir, server, client, bound, projectId, checkpointId, restorePayload, settle, restore, get importCalls() { return importCalls; } };
}

test('HTTP upload -> settings discover/list -> new directory restore -> explicit import; duplicate IDs never replay', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.server}/v1/projects`)).status, 401);
  const discovered = await good(f.bridge, 'projects', f.bound);
  assert.deepEqual(discovered.projects.map(item => [item.projectId, item.checkpointCount]), [[f.projectId, 1]]);
  const catalog = await good(f.bridge, 'checkpoints', { ...f.bound, projectId: f.projectId });
  assert.deepEqual(catalog.heads, [f.checkpointId]);
  assert.deepEqual(Object.keys(catalog.checkpoints[0]).sort(), ['createdAt', 'deviceId', 'fileCount', 'id', 'parentId', 'projectId', 'totalBytes']);
  assert.equal(discovered.projects[0].sourceRoot, f.source); assert.equal(discovered.projects[0].label, 'source');
  const { payload, recovery } = await f.restore();
  assert.equal(recovery.state, 'succeeded'); assert.equal(recovery.sessionCount, 1); assert.equal(recovery.root, payload.destination);
  assert.equal(await fs.readFile(path.join(recovery.root, 'hello.txt'), 'utf8'), 'synthetic project');
  await assert.rejects(fs.stat(path.join(recovery.root, '.dsh-sync', 'INCOMPLETE')), { code: 'ENOENT' });
  assert.equal(f.importCalls, 0, 'download never imports or starts sessions');
  assert.deepEqual((await good(f.bridge, 'restore', payload)).recovery, recovery);
  const input = { ...f.bound, restoreId: recovery.id, confirm: true, requestId: randomUUID() };
  assert.equal((await good(f.bridge, 'import', input)).recovery.state, 'running');
  const imported = await f.settle();
  assert.equal(imported.state, 'succeeded'); assert.equal(imported.importedCount, 1);
  assert.deepEqual(imported.sessions, [{ sourceId: 'archived-session', sessionId: 'new-archived-session', outcome: 'imported', workspaceAttached: true }]);
  assert.deepEqual((await good(f.bridge, 'import', input)).recovery, imported); assert.equal(f.importCalls, 1);
  await rejected(f.bridge, 'import', { ...input, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  await rejected(f.bridge, 'restore', { ...payload, checkpointId: 'different' }, 'BAD_REQUEST');
  assert.equal((await f.service.status()).revision, f.bound.revision);
});

test('project aggregates count only committed checkpoints and derive folder names without secrets', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'hello.txt'), 'second checkpoint'); await f.controller.push(f.projectId);
  const pending = await f.controller.store.capture({ root: f.source, projectId: 'uncommitted-project', deviceId: f.client.deviceId });
  assert.ok(pending.queuedId);
  const { projects } = await f.client.projects(), listed = await f.client.list(f.projectId);
  assert.deepEqual(projects, [{ projectId: f.projectId, checkpointCount: 2, latestCreatedAt: listed.checkpoints.map(item => item.createdAt).sort().at(-1), label: 'source', sourceRoot: f.source, latestCheckpointId: listed.checkpoints.at(-1).id }]);
});

test('new actions are exact POST and reject missing, invalid, extra and stale binding/confirmation fields', async t => {
  const f = await fixture(t);
  for (const action of ['projects', 'checkpoints', 'restore', 'import']) {
    const response = await f.bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'GET' })); assert.equal(response.status, 405);
    await rejected(f.bridge, action, {}, 'BAD_REQUEST');
  }
  await rejected(f.bridge, 'projects', { ...f.bound, secret: 'never-reflect' }, 'BAD_REQUEST');
  await rejected(f.bridge, 'projects', { ...f.bound, revision: f.bound.revision - 1 }, 'CONFIG_CONFLICT');
  await rejected(f.bridge, 'projects', { ...f.bound, username: 'other-account' }, 'ACCOUNT_MISMATCH');
  await rejected(f.bridge, 'checkpoints', { ...f.bound, projectId: '../bad' }, 'BAD_REQUEST');
  for (const patch of [{ confirm: false }, { confirm: undefined }, { requestId: '../bad' }, { checkpointId: undefined }, { path: f.source }]) await rejected(f.bridge, 'restore', f.restorePayload(patch), 'BAD_REQUEST');
  await rejected(f.bridge, 'restore', f.restorePayload({ destination: 'relative' }), 'BAD_DESTINATION');
  if (process.platform === 'win32') await rejected(f.bridge, 'restore', f.restorePayload({ destination: '\\root-relative' }), 'BAD_DESTINATION');
  await rejected(f.bridge, 'import', { ...f.bound, restoreId: 'unknown', confirm: true, requestId: randomUUID(), root: f.source }, 'BAD_REQUEST');
  await rejected(f.bridge, 'import', { ...f.bound, restoreId: 'unknown', confirm: true, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
});

test('filesystem destination admission rejects existing, protected, linked, missing-parent and unsafe Windows paths', async t => {
  const f = await fixture(t);
  const existing = path.join(f.root, 'existing'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'sentinel'), 'unchanged');
  const linked = path.join(f.root, 'linked-parent'); await fs.symlink(existing, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [destination, code] of [
    [existing, 'DESTINATION_EXISTS'], [path.join(f.source, 'restore'), 'PROTECTED_DESTINATION'], [path.join(f.dshHome, 'restore'), 'PROTECTED_DESTINATION'],
    [path.join(f.controller.store.directory, 'restore'), 'PROTECTED_DESTINATION'], [path.join(linked, 'restore'), 'BAD_DESTINATION'],
    [path.join(f.root, 'missing-parent', 'restore'), 'BAD_DESTINATION'], [path.join(f.root, 'CON.txt'), 'BAD_DESTINATION'],
    [path.join(f.root, 'bad.'), 'BAD_DESTINATION'], [path.join(f.root, 'file:stream'), 'BAD_DESTINATION'],
  ]) { const { recovery } = await f.restore({ destination }); assert.equal(recovery.state, 'failed'); assert.equal(recovery.errorCode, code, destination); }
  assert.equal(await fs.readFile(path.join(existing, 'sentinel'), 'utf8'), 'unchanged');
  for (const unsafe of ['\\\\?\\C:\\recovery', '\\\\.\\C:\\recovery', 'C:relative', '\\Device\\HarddiskVolume1\\recovery', '//server/share/recovery']) await assert.rejects(validateRestoreDestination(unsafe), { code: 'BAD_DESTINATION' });
});

test('checkpoint project mismatch fails before destination creation', async t => {
  const f = await fixture(t), { payload, recovery } = await f.restore({ projectId: 'not-this-project' });
  assert.equal(recovery.errorCode, 'CHECKPOINT_MISMATCH');
  await assert.rejects(fs.stat(payload.destination), { code: 'ENOENT' }); assert.equal(f.importCalls, 0);
});

test('corrupt blob failure is sanitized, leaves INCOMPLETE and cannot be imported', async t => {
  const f = await fixture(t), manifest = await f.client.getCheckpoint(f.checkpointId);
  await fs.writeFile(path.join(f.cloudDir, 'blobs', manifest.files[0].sha256), Buffer.alloc(manifest.files[0].size, 0x58));
  const { payload, recovery } = await f.restore();
  assert.equal(recovery.state, 'failed'); assert.equal(recovery.errorCode, 'RESTORE_FAILED');
  assert.ok(await fs.stat(path.join(payload.destination, '.dsh-sync', 'INCOMPLETE')));
  await rejected(f.bridge, 'import', { ...f.bound, restoreId: recovery.id, confirm: true, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  assert.ok(!JSON.stringify(recovery).includes(manifest.files[0].sha256));
});

test('accepted Host restore survives page abort, conflicts with recovery/upload/settings and polls running', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = SyncClient.prototype.downloadBlob;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (...args) { const bytes = await original.apply(this, args); entered.resolve(); await release.promise; return bytes; });
  const page = new AbortController(), payload = f.restorePayload();
  const accepted = await good(f.bridge, 'restore', payload, page.signal); page.abort(); await entered.promise;
  const status = await f.service.status(); assert.equal(status.running, true); assert.equal(status.recovery.state, 'running');
  assert.deepEqual((await good(f.bridge, 'restore', payload)).recovery, accepted.recovery);
  await rejected(f.bridge, 'restore', f.restorePayload(), 'BUSY');
  await rejected(f.bridge, 'preferences', { revision: f.bound.revision, autoSync: false, projectIds: [] }, 'BUSY');
  await rejected(f.bridge, 'sync', {}, 'BUSY');
  await assert.rejects(f.controller.push(f.projectId), { code: 'BUSY' });
  release.resolve(); assert.equal((await f.settle()).state, 'succeeded'); assert.equal(f.importCalls, 0);
});

test('logout cancels/drains downloads and hides old recovery across subsequent login', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), cancelled = deferred(), original = SyncClient.prototype.downloadBlob;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (...args) { const bytes = await original.apply(this, args); this.signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); entered.resolve(); await release.promise; return bytes; });
  const payload = f.restorePayload(); await good(f.bridge, 'restore', payload); await entered.promise;
  const loggingOut = f.service.logout({}); let done = false; loggingOut.then(() => { done = true; });
  await cancelled.promise; assert.equal(done, false);
  release.resolve(); const loggedOut = await loggingOut; assert.equal(loggedOut.recovery, undefined); assert.equal(loggedOut.loggedIn, false);
  assert.ok(await fs.stat(path.join(payload.destination, '.dsh-sync', 'INCOMPLETE')));
  await assert.rejects(fs.stat(path.join(payload.destination, 'hello.txt')), { code: 'ENOENT' });
  const loggedIn = await f.service.login({ server: f.server, username: 'owner', password }); assert.equal(loggedIn.recovery, undefined);
  await rejected(f.bridge, 'restore', { ...payload, ...binding(loggedIn) }, 'RECOVERY_UNAVAILABLE');
});

test('disposal drains an in-flight task and cancellation prevents blob writes/finalization', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = SyncClient.prototype.downloadBlob;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (...args) { const bytes = await original.apply(this, args); entered.resolve(); await release.promise; return bytes; });
  const payload = f.restorePayload(); await good(f.bridge, 'restore', payload); await entered.promise;
  f.bridge.dispose(); f.controller.stop(); let done = false; const draining = f.controller.drain().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); release.resolve(); await draining;
  assert.ok(await fs.stat(path.join(payload.destination, '.dsh-sync', 'INCOMPLETE')));
  await assert.rejects(fs.stat(path.join(payload.destination, '.dsh-sync', 'manifest.json')), { code: 'ENOENT' });
  assert.equal((await f.bridge.fetch('status', request('status', {}))).status, 503);
});

test('partial imports preserve durable session IDs, deduplicate close failures and never call them all successful', async t => {
  const f = await fixture(t, { sessionIds: ['one', 'two', 'three'], importSessions: async () => ({
    imported: [{ sourceId: 'one', sessionId: 'new-one', workspaceAttached: false, warning: 'SYNTHETIC-SECRET' }],
    skipped: [{ id: 'two', reason: 'SYNTHETIC-SECRET' }],
    failed: [{ id: 'three', sessionId: 'new-three', reason: 'SYNTHETIC-SECRET', mayHaveDurableSession: true }, { id: 'three', sessionId: 'new-three', reason: 'close failed', mayHaveDurableSession: true }],
  }) });
  const { recovery } = await f.restore(); const payload = { ...f.bound, restoreId: recovery.id, confirm: true, requestId: randomUUID() };
  await good(f.bridge, 'import', payload); const result = await f.settle();
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'IMPORT_FAILED');
  assert.equal(result.importedCount, 1); assert.equal(result.skippedCount, 1); assert.equal(result.failedCount, 1);
  assert.deepEqual(result.sessions, [{ sourceId: 'one', sessionId: 'new-one', outcome: 'imported', workspaceAttached: false }, { sourceId: 'two', outcome: 'skipped' }, { sourceId: 'three', sessionId: 'new-three', outcome: 'failed' }]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  await good(f.bridge, 'import', payload); assert.equal(f.importCalls, 1);
});

test('only the latest successful restoration may be imported; no replay after uncertain adapter failure', async t => {
  const f = await fixture(t, { importSessions: async () => { throw new Error('SYNTHETIC-SECRET'); } });
  const first = await f.restore(), second = await f.restore();
  await rejected(f.bridge, 'import', { ...f.bound, restoreId: first.recovery.id, confirm: true, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  const payload = { ...f.bound, restoreId: second.recovery.id, confirm: true, requestId: randomUUID() };
  await good(f.bridge, 'import', payload); const failed = await f.settle(); assert.equal(failed.errorCode, 'IMPORT_FAILED');
  await rejected(f.bridge, 'import', { ...payload, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE'); assert.equal(f.importCalls, 1);
});

test('recovery request ID cap explicitly rejects instead of evicting and rerunning', async t => {
  const f = await fixture(t, { maxRecoveryRequests: 1 }), first = await f.restore();
  await rejected(f.bridge, 'restore', f.restorePayload(), 'RECOVERY_LIMIT');
  assert.deepEqual((await good(f.bridge, 'restore', first.payload)).recovery, first.recovery);
});

test('binding is rechecked under operation lock before writes, including stale remote response', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = SyncClient.prototype.getCheckpoint;
  t.mock.method(SyncClient.prototype, 'getCheckpoint', async function (...args) { const manifest = await original.apply(this, args); entered.resolve(); await release.promise; return manifest; });
  const payload = f.restorePayload(); await good(f.bridge, 'restore', payload); await entered.promise;
  const preferences = JSON.parse(await fs.readFile(f.service.filename, 'utf8'));
  await fs.writeFile(f.service.filename, JSON.stringify({ ...preferences, revision: preferences.revision + 1 }));
  release.resolve(); const result = await f.settle(); assert.equal(result.errorCode, 'CONFIG_CONFLICT');
  await assert.rejects(fs.stat(payload.destination), { code: 'ENOENT' });
});

test('changed native grant during remote download prevents writes and hides stale job metadata', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = SyncClient.prototype.getCheckpoint;
  t.mock.method(SyncClient.prototype, 'getCheckpoint', async function (...args) { const manifest = await original.apply(this, args); entered.resolve(); await release.promise; return manifest; });
  const payload = f.restorePayload(); await good(f.bridge, 'restore', payload); await entered.promise;
  const prior = f.records.get(f.controller.credentialKey);
  f.records.set(f.controller.credentialKey, { ...prior, payload: { ...prior.payload, token: 'z'.repeat(43) } });
  release.resolve(); await f.controller.drain();
  assert.equal((await f.service.status()).recovery, undefined);
  await assert.rejects(fs.stat(payload.destination), { code: 'ENOENT' });
  await rejected(f.bridge, 'restore', payload, 'RECOVERY_UNAVAILABLE');
});

test('restore fails BUSY instead of nesting upload or settings operation locks', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const modifying = f.controller.mutate(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  await rejected(f.bridge, 'restore', f.restorePayload(), 'BUSY'); release.resolve(); await modifying;
  const uploadEntered = deferred(), uploadRelease = deferred(), original = SyncClient.prototype.uploadBlob;
  t.mock.method(SyncClient.prototype, 'uploadBlob', async function (...args) { uploadEntered.resolve(); await uploadRelease.promise; return original.apply(this, args); });
  await fs.writeFile(path.join(f.source, 'hello.txt'), 'new content');
  const uploading = f.controller.push(f.projectId); await uploadEntered.promise;
  await rejected(f.bridge, 'restore', f.restorePayload(), 'BUSY'); uploadRelease.resolve(); await uploading;
});

test('logout drains non-cancellable native import and retains partial IDs in prior job without exposing them to a fresh account', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { importSessions: async () => { entered.resolve(); await release.promise; return { imported: [{ sourceId: 'archived-session', sessionId: 'durable-new-session', workspaceAttached: true }], skipped: [], failed: [] }; } });
  const { recovery } = await f.restore(); const payload = { ...f.bound, restoreId: recovery.id, confirm: true, requestId: randomUUID() };
  await good(f.bridge, 'import', payload); await entered.promise;
  const loggingOut = f.service.logout({}); let done = false; loggingOut.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); release.resolve();
  const value = await loggingOut; assert.equal(value.recovery, undefined); assert.equal(f.importCalls, 1);
});

test('import accepts a valid near-limit manifest whose restored pretty JSON exceeds the wire limit', async t => {
  const f = await fixture(t), original = f.controller.store.restore.bind(f.controller.store);
  t.mock.method(f.controller.store, 'restore', async (...args) => {
    const restored = await original(...args);
    const files = Array.from({ length: MAX_FILES - 1 }, (_, i) => ({ path: `project/${'d'.repeat(180)}/${String(i).padStart(5, '0')}-${'f'.repeat(100)}`, sha256: '0'.repeat(64), size: 0 }));
    const manifest = validateManifest({ ...restored.manifest, files: [...files, ...restored.manifest.files.filter(item => item.path.startsWith('sessions/'))] });
    const pretty = JSON.stringify(manifest, null, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(manifest)) <= MAX_MANIFEST_BYTES);
    assert.ok(Buffer.byteLength(pretty) > MAX_MANIFEST_BYTES && Buffer.byteLength(pretty) < MAX_MANIFEST_BYTES * 2);
    // Synthetic near-limit download metadata; the adapter is intentionally mocked.
    await fs.writeFile(path.join(restored.root, '.dsh-sync', 'manifest.json'), pretty);
    return { ...restored, manifest };
  });
  const { recovery } = await f.restore(); assert.equal(recovery.state, 'succeeded');
  await good(f.bridge, 'import', { ...f.bound, restoreId: recovery.id, confirm: true, requestId: randomUUID() });
  assert.equal((await f.settle()).state, 'succeeded'); assert.equal(f.importCalls, 1);
});

test('old server 404/405 project browsing has explicit-ID checkpoint fallback and strict metadata projection', async t => {
  const timestamp = new Date().toISOString(); let status = 404;
  const checkpoint = { id: 'checkpoint', projectId: 'explicit-project', deviceId: 'device', parentId: null, createdAt: timestamp, fileCount: 0, totalBytes: 0, token: 'NEVER-EXPOSE', sourceRoot: '/secret' };
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${'x'.repeat(43)}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/projects') { res.statusCode = status; res.end('{}'); }
    else { assert.equal(req.url, '/v1/checkpoints?projectId=explicit-project'); res.end(JSON.stringify({ checkpoints: [checkpoint], heads: ['checkpoint'], password: 'NEVER-EXPOSE' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new SyncClient({ server: `http://127.0.0.1:${server.address().port}`, token: 'x'.repeat(43) });
  await assert.rejects(client.projects(), { code: 'CLOUD_BROWSE_UNSUPPORTED' }); status = 405;
  await assert.rejects(client.projects(), { code: 'CLOUD_BROWSE_UNSUPPORTED' });
  const result = await client.list('explicit-project'); assert.equal(result.checkpoints.length, 1); assert.ok(!JSON.stringify(result).includes('NEVER-EXPOSE')); assert.ok(!JSON.stringify(result).includes('/secret'));
});

test('SyncClient bounds and validates all remote metadata before projection', async t => {
  const client = new SyncClient({ server: 'http://127.0.0.1:1', token: 'x'.repeat(43) }), timestamp = new Date().toISOString();
  let response; t.mock.method(client, 'request', async () => response);
  const valid = { projectId: 'p', checkpointCount: 1, latestCreatedAt: timestamp, token: 'do-not-expose' };
  response = { projects: [valid], secret: 'do-not-expose' }; assert.deepEqual(await client.projects(), { projects: [{ projectId: 'p', checkpointCount: 1, latestCreatedAt: timestamp }] });
  for (const item of [{ ...valid, projectId: '../bad' }, { ...valid, checkpointCount: -1 }, { ...valid, latestCreatedAt: 'yesterday' }]) { response = { projects: [item] }; await assert.rejects(client.projects()); }
  response = { projects: [valid, valid] }; await assert.rejects(client.projects());
  response = { projects: Array(10_001).fill(valid) }; await assert.rejects(client.projects());
  const checkpoint = { id: 'c', projectId: 'p', deviceId: 'd', parentId: null, createdAt: timestamp, fileCount: 0, totalBytes: 0 };
  for (const patch of [{ projectId: 'other' }, { fileCount: MAX_FILES + 1 }, { totalBytes: MAX_CHECKPOINT_BYTES + 1 }, { parentId: 'c' }, { createdAt: 'invalid' }, { deviceId: '../bad' }]) { response = { checkpoints: [{ ...checkpoint, ...patch }], heads: ['c'] }; await assert.rejects(client.list('p')); }
  response = { checkpoints: [checkpoint], heads: ['foreign'] }; await assert.rejects(client.list('p'));
  response = { checkpoints: [checkpoint, checkpoint], heads: ['c'] }; await assert.rejects(client.list('p'));
  response = { checkpoints: [{ ...checkpoint, parentId: 'b' }, { ...checkpoint, id: 'b', parentId: 'c' }], heads: [] }; await assert.rejects(client.list('p'));
});
