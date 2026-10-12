import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, registerSettingsRoutes, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { sha256 } from '../src/protocol.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-batch-password';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const binding = status => ({ revision: status.revision, server: status.server, username: status.username });
const missing = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
const listing = (root, children = [], crumbs = []) => ({ path: root, home: root, entries: children.map(value => ({ name: path.basename(value), path: value, hidden: false })), crumbs: crumbs.map(value => ({ name: path.basename(value) || value, path: value, hidden: false })), truncated: false });

async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'download-batch-'));
  const profileDir = path.join(root, 'private', 'profile'), parent = path.join(root, 'destinations'), local = path.join(root, 'registered');
  for (const directory of [profileDir, parent, local]) await fs.mkdir(directory, { recursive: true });
  const records = new Map(), workspaces = new Map([['local', { id: 'local', path: local, title: 'Synthetic local' }]]), imports = [], releases = [];
  let pickCalls = 0, clock = Date.now(), capability = { kind: 'native', pick: async () => { pickCalls++; return parent; } }, provider = { capability: () => capability };
  const ctx = { get(name) { assert.equal(name, 'directoryPicker'); return provider; }, workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: {
    readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); }, deleteRecord: async key => records.delete(key),
  } };
  Object.defineProperty(ctx, 'directoryPicker', { get() { throw new Error('Optional provider must use ctx.get'); } });
  const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false, ...(options.maxRecoveryRequests ? { maxRecoveryRequests: options.maxRecoveryRequests } : {}), importSessions: async (...args) => {
    imports.push({ root: args[1].root, projectId: args[1].manifest.projectId });
    if (options.importSessions) return options.importSessions(...args);
    return { imported: args[1].manifest.sessionIds.map(sourceId => ({ sourceId, sessionId: `native-${sourceId}`, workspaceAttached: true })), skipped: [], failed: [] };
  } });
  const service = createSettingsService(ctx, controller, { profileDir, dshHome: path.join(root, 'private'), pickerOptions: { now: () => clock, ...options.pickerOptions } });
  const bridge = createSettingsHttp(service), cloudDir = path.join(root, 'cloud');
  const cloud = await createSyncServer({ dataDir: cloudDir, username: 'owner', password });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`;
  t.after(async () => {
    for (const release of releases) release();
    bridge.dispose(); controller.stop(); await controller.drain(); await closeSyncServer(cloud);
    assert.equal(path.dirname(root), path.resolve(base)); assert.match(path.basename(root), /^download-batch-[A-Za-z0-9]+$/);
    await fs.rm(root, { recursive: true, force: true }); await missing(root);
  });
  async function rpc(action, payload, signal) {
    const request = new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'batch-rpc', method: `dsh-personal-sync/${action}`, payload }) });
    const response = await bridge.fetch(action, request); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.rpcId, 'batch-rpc');
    const text = JSON.stringify(body); assert.ok(!text.includes(password));
    const token = records.get(controller.credentialKey)?.payload?.token; if (token) assert.ok(!text.includes(token));
    return body.result;
  }
  async function good(action, payload, signal) { const result = await rpc(action, payload, signal); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
  async function reject(action, payload, code) { const result = await rpc(action, payload); assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, code); return result; }
  const status = await good('login', { server, username: 'owner', password }), bound = binding(status), client = new SyncClient(records.get(controller.credentialKey).payload), manifests = [];
  for (let i = 0; i < 4; i++) {
    const sessionIds = options.sessionIds ? options.sessionIds(i) : [`archived-${i}`], files = [];
    for (const [name, bytes] of [['project/hello.txt', Buffer.from(`synthetic project ${i}`)], ...sessionIds.map(id => [`sessions/${id}.json`, Buffer.from(JSON.stringify({ id, synthetic: true }))])]) {
      const hash = sha256(bytes); await client.uploadBlob(hash, bytes); files.push({ path: name, sha256: hash, size: bytes.length });
    }
    const manifest = { version: 1, id: `checkpoint-${i}`, projectId: `project-${i}`, deviceId: client.deviceId, parentId: null, createdAt: '2026-01-02T00:00:00.000Z', sourceRoot: `/remote/${i}/${i === 2 ? 'Shared' : i === 3 ? 'unselected' : 'shared'}`, sessionIds, files };
    await client.commit(manifest); manifests.push(manifest);
  }
  const items = (count = 2) => manifests.slice(0, count).map(manifest => ({ projectId: manifest.projectId, checkpointId: manifest.id }));
  const pick = (selected = items(), signal) => good('downloadpick', { ...bound, items: selected }, signal);
  const payload = plan => ({ ...bound, items: plan.destinations.map(item => ({ projectId: item.projectId, checkpointId: item.checkpointId, destinationId: item.id })), requestId: randomUUID(), confirm: true });
  async function settle() { await controller.drain(); return (await good('status', {})).download; }
  async function download(count = 2) { const plan = await pick(items(count)), input = payload(plan); const accepted = await good('downloadstart', input); return { plan, input, accepted: accepted.download, result: await settle() }; }
  function gate(method, predicate = () => true) {
    const entered = deferred(), release = deferred(), cancelled = deferred(), original = SyncClient.prototype[method]; let blocked = false;
    releases.push(release.resolve);
    const spy = t.mock.method(SyncClient.prototype, method, async function (...args) {
      const value = await original.apply(this, args);
      if (!blocked && predicate(...args)) { blocked = true; this.signal?.addEventListener('abort', cancelled.resolve, { once: true }); entered.resolve(); await release.promise; }
      return value;
    });
    return { entered: entered.promise, release: release.resolve, cancelled: cancelled.promise, restore: () => spy.mock.restore() };
  }
  return { root, parent, local, profileDir, records, workspaces, imports, controller, service, bridge, cloudDir, server, client, manifests, bound, items, pick, payload, settle, download, rpc, good, reject, gate, releases,
    advance(ms) { clock += ms; }, setCapability(value) { capability = value; }, replaceProvider() { provider = { capability: () => capability }; }, get pickCalls() { return pickCalls; } };
}

test('batch native selection validates whole cloud selection, picks once, reserves portable distinct roots without writes', async t => {
  const f = await fixture(t), routes = [];
  registerSettingsRoutes({ connection: { fetch: { register: route => routes.push(route) } } }, f.bridge);
  assert.equal(routes.length, 40);
  for (const action of ['downloadpick', 'downloadbrowse', 'downloadselect', 'downloadstart']) {
    assert.deepEqual(routes.find(route => route.path === SETTINGS_API + action).methods, ['POST']);
    assert.equal((await f.bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`))).status, 405);
    await f.reject(action, {}, 'BAD_REQUEST');
  }
  for (const items of [[], [f.items()[0], f.items()[0]], [{ ...f.items()[0], root: f.parent }]]) await f.reject('downloadpick', { ...f.bound, items }, 'BAD_REQUEST');
  await f.reject('downloadpick', { ...f.bound, items: Array.from({ length: 21 }, (_, i) => ({ projectId: `p${i}`, checkpointId: `c${i}` })) }, 'DOWNLOAD_LIMIT');
  await f.reject('downloadpick', { ...f.bound, items: [{ projectId: 'other', checkpointId: f.manifests[0].id }] }, 'CHECKPOINT_MISMATCH');
  assert.equal(f.pickCalls, 0);
  const first = await f.pick(f.items(3)); assert.equal(f.pickCalls, 1); assert.equal(first.parent, f.parent);
  assert.equal(new Set(first.destinations.map(item => item.root.toLowerCase())).size, 3);
  assert.deepEqual(first.destinations.map(item => item.label), ['shared', 'shared', 'Shared']);
  for (const item of first.destinations) { assert.equal(item.parent, f.parent); assert.equal(path.dirname(item.root), f.parent); assert.notEqual(item.id, item.root); await missing(item.root); }
  const second = await f.pick(f.items(3)); assert.equal(new Set([...first.destinations, ...second.destinations].map(item => item.root.toLowerCase())).size, 6);
  f.setCapability({ kind: 'native', pick: async () => null }); assert.deepEqual(await f.pick(), { cancelled: true });
  assert.deepEqual(await fs.readdir(f.parent), []);
  await f.good('downloadstart', f.payload(first)); const result = await f.settle(); assert.equal(result.state, 'succeeded');
  assert.equal(result.total, 3); assert.equal(result.completed, 3); assert.equal(f.imports.length, 0); assert.equal(f.workspaces.size, 1);
  await missing(path.join(f.parent, 'unselected')); assert.equal((await f.service.status()).autoSync, false);
});

test('Host accepts full batch quickly; page abort leaves remaining jobs owned by Host and all mutation/update gates busy', async t => {
  const f = await fixture(t), plan = await f.pick(), input = f.payload(plan), gate = f.gate('downloadBlob'), page = new AbortController();
  const accepted = await f.good('downloadstart', input, page.signal); page.abort();
  assert.equal(accepted.download.state, 'running'); assert.equal(accepted.download.total, 2); assert.deepEqual(accepted.download.items.map(item => item.state), ['pending', 'pending']);
  await gate.entered;
  const status = await f.good('status', {}); assert.equal(status.running, true); assert.deepEqual(status.download.items.map(item => item.state), ['running', 'pending']);
  assert.equal((await f.good('downloadstart', input)).download.id, input.requestId);
  await f.reject('downloadstart', { ...input, requestId: randomUUID() }, 'BUSY');
  await f.reject('downloadpick', { ...f.bound, items: f.items() }, 'BUSY');
  await f.reject('preferences', { revision: f.bound.revision, autoSync: false, projectIds: [] }, 'BUSY');
  await f.reject('login', { server: f.server, username: 'owner', password }, 'BUSY');
  await f.reject('password', { ...f.bound, currentPassword: password, newPassword: 'synthetic-new-password' }, 'BUSY');
  await f.reject('sync', {}, 'BUSY');
  await f.reject('restore', { ...f.bound, ...f.items()[0], requestId: randomUUID(), destination: path.join(f.parent, 'legacy'), confirm: true }, 'BUSY');
  await f.reject('import', { ...f.bound, restoreId: accepted.download.items[0].restoreId, requestId: randomUUID(), confirm: true }, 'BUSY');
  await assert.rejects(f.controller.push('any'), { code: 'BUSY' });
  await assert.rejects(f.controller.runUpdate(() => assert.fail('update must not start')), { code: 'BUSY' });
  assert.equal(await f.controller.tick(), undefined);
  f.advance(16 * 60_000); gate.release(); const result = await f.settle();
  assert.equal(result.state, 'succeeded'); assert.equal(result.completed, 2);
  for (let i = 0; i < result.items.length; i++) assert.equal(await fs.readFile(path.join(result.items[i].root, 'hello.txt'), 'utf8'), `synthetic project ${i}`);
  assert.deepEqual((await f.good('downloadstart', input)).download, result);
  await f.reject('downloadstart', { ...input, items: [...input.items].reverse() }, 'BAD_REQUEST');
  await f.reject('downloadstart', { ...input, requestId: randomUUID() }, 'DIRECTORY_PICKER_EXPIRED');
});

test('independent integrity failure records partial, continues selected projects, and zero sessions cannot import', async t => {
  const f = await fixture(t, { sessionIds: i => i === 2 ? [] : [`session-${i}`] });
  const file = f.manifests[0].files[0]; await fs.writeFile(path.join(f.cloudDir, 'blobs', file.sha256), Buffer.alloc(file.size, 0x58));
  const { result } = await f.download(3);
  assert.equal(result.state, 'partial'); assert.equal(result.completed, 3); assert.deepEqual(result.items.map(item => item.state), ['failed', 'succeeded', 'succeeded']);
  assert.equal(result.items[0].errorCode, 'RESTORE_FAILED'); assert.equal(result.items[0].canImport, false);
  assert.equal(result.items[1].canImport, true); assert.equal(result.items[2].sessionCount, 0); assert.equal(result.items[2].canImport, false);
  assert.ok(await fs.stat(path.join(result.items[0].root, '.dsh-sync', 'INCOMPLETE')));
  await f.reject('import', { ...f.bound, restoreId: result.items[0].restoreId, confirm: true, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  await f.reject('import', { ...f.bound, restoreId: result.items[2].restoreId, confirm: true, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes(file.sha256)); await missing(path.join(f.parent, 'unselected'));
});

test('whole admission rejects forged/duplicate/mixed/missing/expired plans and replaced parent before any creation', async t => {
  const f = await fixture(t), first = await f.pick(), second = await f.pick(), input = f.payload(first);
  for (const patch of [{ confirm: false }, { path: f.parent }, { items: [] }, { items: [input.items[0], input.items[0]] }, { items: [input.items[0], { ...input.items[1], destinationId: input.items[0].destinationId }] }]) await f.reject('downloadstart', { ...input, ...patch }, 'BAD_REQUEST');
  for (const items of [[input.items[0]], [input.items[0], { ...input.items[1], destinationId: 'forged' }], [input.items[0], f.payload(second).items[1]], [{ ...input.items[0], checkpointId: 'other' }, input.items[1]]]) await f.reject('downloadstart', { ...input, items }, 'DIRECTORY_PICKER_EXPIRED');
  await f.reject('downloadstart', { ...input, revision: f.bound.revision - 1 }, 'CONFIG_CONFLICT');
  await f.reject('downloadstart', { ...input, username: 'other' }, 'ACCOUNT_MISMATCH');
  assert.deepEqual(await fs.readdir(f.parent), []);
  await fs.mkdir(first.destinations[1].root); await f.reject('downloadstart', input, 'DESTINATION_EXISTS'); await missing(first.destinations[0].root);
  const moved = path.join(f.root, 'original-parent'); assert.equal(path.dirname(moved), f.root); await fs.rename(f.parent, moved); await fs.mkdir(f.parent);
  await f.reject('downloadstart', f.payload(second), 'DESTINATION_CHANGED'); assert.deepEqual(await fs.readdir(f.parent), []);
  const fresh = await f.pick(); f.advance(15 * 60_000); await f.reject('downloadstart', f.payload(fresh), 'DIRECTORY_PICKER_EXPIRED'); assert.deepEqual(await fs.readdir(f.parent), []);
});

test('batch browser is opaque and mode-bound, one selected Host parent serves every item without writes', async t => {
  const f = await fixture(t), child = path.join(f.parent, 'child'), calls = []; await fs.mkdir(child);
  f.setCapability({ kind: 'browse', list: async value => { calls.push(value); return value === child ? listing(child, [], [f.parent, child]) : listing(f.parent, [child], [f.root, f.parent]); }, createDirectory: () => assert.fail('no writes while selecting') });
  const { browser } = await f.pick(); assert.deepEqual(calls, [undefined]); assert.equal(browser.directories[0].label, 'child'); assert.ok(!Object.hasOwn(browser.directories[0], 'path'));
  const input = { ...f.bound, browserId: browser.id, nodeId: browser.directories[0].id };
  await f.reject('destinationbrowse', input, 'DIRECTORY_PICKER_EXPIRED'); await f.reject('destinationselect', input, 'DIRECTORY_PICKER_EXPIRED');
  await f.reject('downloadbrowse', { ...input, nodeId: child }, 'BAD_REQUEST');
  await f.reject('downloadselect', { ...input, nodeId: 'forged' }, 'DIRECTORY_PICKER_EXPIRED');
  const visited = await f.good('downloadbrowse', input); assert.equal(visited.browser.path, child); assert.equal(calls.at(-1), child);
  const plan = await f.good('downloadselect', input); assert.equal(plan.parent, child); assert.ok(plan.destinations.every(item => item.parent === child)); assert.deepEqual(await fs.readdir(child), []);
  const single = await f.good('destinationpick', { ...f.bound, ...f.items()[0] });
  const singleInput = { ...f.bound, browserId: single.browser.id, nodeId: single.browser.currentId };
  await f.reject('downloadbrowse', singleInput, 'DIRECTORY_PICKER_EXPIRED'); await f.reject('downloadselect', singleInput, 'DIRECTORY_PICKER_EXPIRED');
  const legacyPlan = await f.good('destinationselect', singleInput);
  await f.reject('downloadstart', { ...f.payload(plan), items: [{ ...f.items()[0], destinationId: legacyPlan.destination.id }] }, 'DIRECTORY_PICKER_EXPIRED');
  await f.reject('restore', { ...f.bound, ...f.items()[0], destinationId: plan.destinations[0].id, requestId: randomUUID(), confirm: true }, 'DIRECTORY_PICKER_EXPIRED');
  f.replaceProvider(); await f.reject('downloadstart', f.payload(plan), 'DIRECTORY_PICKER_EXPIRED');
});

test('successful roots each explicitly import; running-to-terminal per-item DTO and partial durable IDs cannot replay', async t => {
  const entered = deferred(), release = deferred(); let call = 0;
  const f = await fixture(t, { sessionIds: i => [`one-${i}`, `two-${i}`, `three-${i}`], importSessions: async (_ctx, { manifest }) => {
    if (call++ === 0) { entered.resolve(); await release.promise; }
    const [one, two, three] = ['one-', 'two-', 'three-'].map(prefix => manifest.sessionIds.find(id => id.startsWith(prefix)));
    return { imported: [{ sourceId: one, sessionId: `durable-${one}`, workspaceAttached: false, secret: 'NEVER-REFLECT' }], skipped: [{ id: two, reason: 'NEVER-REFLECT' }], failed: [{ id: three, sessionId: `durable-${three}`, reason: 'NEVER-REFLECT' }, { id: three, sessionId: `durable-${three}`, reason: 'close failure' }] };
  } }); f.releases.push(release.resolve);
  const { result } = await f.download(); assert.ok(result.items.every(item => item.canImport));
  const first = { ...f.bound, restoreId: result.items[0].restoreId, requestId: randomUUID(), confirm: true };
  assert.equal((await f.good('import', first)).recovery.state, 'running'); await entered.promise;
  const running = (await f.good('status', {})).download.items[0]; assert.equal(running.canImport, false); assert.equal(running.importResult.state, 'running');
  await f.reject('import', { ...first, restoreId: result.items[1].restoreId, requestId: randomUUID() }, 'BUSY');
  await assert.rejects(f.controller.runUpdate(() => assert.fail('update during import')), { code: 'BUSY' });
  release.resolve(); let settled = await f.settle(), imported = settled.items[0].importResult;
  assert.equal(imported.state, 'failed'); assert.equal(imported.errorCode, 'IMPORT_FAILED'); assert.equal(imported.importedCount, 1); assert.equal(imported.skippedCount, 1); assert.equal(imported.failedCount, 1);
  assert.equal(imported.sessions[2].sessionId, 'durable-three-0'); assert.ok(!JSON.stringify(imported).includes('NEVER-REFLECT'));
  assert.deepEqual((await f.good('import', first)).recovery, imported); await f.reject('import', { ...first, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  const second = { ...f.bound, restoreId: result.items[1].restoreId, requestId: randomUUID(), confirm: true };
  await f.good('import', second); settled = await f.settle();
  assert.equal(settled.items[1].importResult.failedCount, 1); assert.equal(settled.state, 'succeeded', 'download success is distinct from explicit import result');
  assert.deepEqual(f.imports.map(item => item.root), result.items.map(item => item.root)); assert.ok(settled.items.every(item => !item.canImport));
});

test('digest rejects changed immutable restored manifest and consumes import without native adapter calls', async t => {
  const f = await fixture(t), { result } = await f.download(), first = result.items[0], filename = path.join(first.root, '.dsh-sync', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8')); await fs.writeFile(filename, JSON.stringify({ ...manifest, sourceRoot: '/remote/tampered' }));
  const input = { ...f.bound, restoreId: first.restoreId, requestId: randomUUID(), confirm: true };
  await f.good('import', input); const settled = await f.settle(); assert.equal(settled.items[0].importResult.errorCode, 'IMPORT_FAILED'); assert.equal(f.imports.length, 0);
  await f.reject('import', { ...input, requestId: randomUUID() }, 'RECOVERY_UNAVAILABLE');
  await f.good('import', { ...input, restoreId: result.items[1].restoreId, requestId: randomUUID() }); assert.equal((await f.settle()).items[1].importResult.state, 'succeeded');
  assert.equal(f.imports.length, 1);
});

test('only latest batch remains eligible; earlier ordinary restores never gain batch eligibility', async t => {
  const f = await fixture(t), first = await f.download(), second = await f.download();
  await f.reject('import', { ...f.bound, restoreId: first.result.items[0].restoreId, requestId: randomUUID(), confirm: true }, 'RECOVERY_UNAVAILABLE');
  assert.ok((await f.good('downloadstart', first.input)).download.items.every(item => !item.canImport));
  const legacy = [];
  for (let i = 0; i < 2; i++) {
    const input = { ...f.bound, ...f.items()[0], destination: path.join(f.parent, `ordinary-${i}`), requestId: randomUUID(), confirm: true };
    await f.good('restore', input); await f.controller.drain(); legacy.push((await f.good('status', {})).recovery);
  }
  await f.reject('import', { ...f.bound, restoreId: legacy[0].id, requestId: randomUUID(), confirm: true }, 'RECOVERY_UNAVAILABLE');
  await f.good('import', { ...f.bound, restoreId: legacy[1].id, requestId: randomUUID(), confirm: true }); await f.controller.drain();
  await f.good('import', { ...f.bound, restoreId: second.result.items[1].restoreId, requestId: randomUUID(), confirm: true }); assert.equal((await f.settle()).items[1].importResult.state, 'succeeded');
});

test('logout aborts and joins remaining batch before revoke, preserves written successes, hides old grant status', async t => {
  const f = await fixture(t), plan = await f.pick(f.items(3)), input = f.payload(plan), gate = f.gate('downloadBlob', hash => hash === f.manifests[1].files[0].sha256);
  await f.good('downloadstart', input); await gate.entered;
  assert.equal((await f.good('status', {})).download.items[0].state, 'succeeded');
  let done = false; const loggingOut = f.service.logout({}).then(value => { done = true; return value; });
  await gate.cancelled; assert.equal(done, false); assert.ok(f.records.get(f.controller.credentialKey)?.payload.token);
  gate.release(); const loggedOut = await loggingOut; assert.equal(loggedOut.download, undefined); assert.equal(loggedOut.loggedIn, false);
  assert.equal(await fs.readFile(path.join(plan.destinations[0].root, 'hello.txt'), 'utf8'), 'synthetic project 0');
  await missing(path.join(plan.destinations[1].root, 'hello.txt')); await missing(plan.destinations[2].root);
  const loggedIn = await f.good('login', { server: f.server, username: 'owner', password }); assert.equal(loggedIn.download, undefined);
  await f.reject('downloadstart', { ...input, ...binding(loggedIn) }, 'RECOVERY_UNAVAILABLE');
  await f.reject('import', { ...binding(loggedIn), restoreId: 'unknown', requestId: randomUUID(), confirm: true }, 'RECOVERY_UNAVAILABLE');
});

test('disposal drains the one batch task and stops pending items without deleting completed roots', async t => {
  const f = await fixture(t), plan = await f.pick(f.items(3)), gate = f.gate('downloadBlob', hash => hash === f.manifests[1].files[0].sha256);
  await f.good('downloadstart', f.payload(plan)); await gate.entered;
  f.controller.stop(); let done = false; const draining = f.controller.drain().then(() => { done = true; });
  await gate.cancelled; assert.equal(done, false); gate.release(); await draining;
  assert.equal(await fs.readFile(path.join(plan.destinations[0].root, 'hello.txt'), 'utf8'), 'synthetic project 0');
  await missing(path.join(plan.destinations[1].root, '.dsh-sync', 'manifest.json')); await missing(plan.destinations[2].root);
});

test('revision drift cancels remaining items with safe permission code and counts every terminal item', async t => {
  const f = await fixture(t), plan = await f.pick(f.items(3)), gate = f.gate('downloadBlob', hash => hash === f.manifests[1].files[0].sha256);
  await f.good('downloadstart', f.payload(plan)); await gate.entered;
  const preferences = JSON.parse(await fs.readFile(f.service.filename, 'utf8')); await fs.writeFile(f.service.filename, JSON.stringify({ ...preferences, revision: preferences.revision + 1 }));
  gate.release(); const result = await f.settle(); assert.equal(result.state, 'partial'); assert.equal(result.completed, 3);
  assert.deepEqual(result.items.map(item => item.state), ['succeeded', 'cancelled', 'cancelled']); assert.ok(result.items.slice(1).every(item => item.errorCode === 'CONFIG_CONFLICT'));
  await missing(plan.destinations[2].root);
});

test('remote authentication failure stops whole batch and grant replacement never exposes prior status', async t => {
  const f = await fixture(t), plan = await f.pick(f.items(3));
  const spy = t.mock.method(SyncClient.prototype, 'downloadBlob', async () => { throw Object.assign(new Error('NEVER-REFLECT'), { status: 401 }); });
  const input = f.payload(plan); await f.good('downloadstart', input); const result = await f.settle();
  assert.equal(result.state, 'failed'); assert.equal(result.completed, 3); assert.ok(result.items.every(item => item.state === 'cancelled' && item.errorCode === 'NOT_LOGGED_IN'));
  assert.ok(!JSON.stringify(result).includes('NEVER-REFLECT')); await missing(plan.destinations[1].root); spy.mock.restore();
  const grant = f.records.get(f.controller.credentialKey); f.records.set(f.controller.credentialKey, { ...grant, payload: { ...grant.payload, token: 'z'.repeat(43) } });
  assert.equal((await f.service.status()).download, undefined); await f.reject('downloadstart', input, 'RECOVERY_UNAVAILABLE');
});

test('root replacement during accepted restore is detected and does not prevent independent sibling restore', async t => {
  const f = await fixture(t), plan = await f.pick(), gate = f.gate('downloadBlob');
  await f.good('downloadstart', f.payload(plan)); await gate.entered;
  const original = plan.destinations[0].root, moved = path.join(f.parent, 'moved-incomplete');
  assert.equal(path.dirname(original), f.parent); assert.equal(path.dirname(moved), f.parent); await fs.rename(original, moved); await fs.mkdir(original);
  gate.release(); const result = await f.settle(); assert.equal(result.state, 'partial'); assert.equal(result.items[0].errorCode, 'DESTINATION_CHANGED'); assert.equal(result.items[1].state, 'succeeded');
  assert.deepEqual(await fs.readdir(original), []); assert.ok(await fs.stat(path.join(moved, '.dsh-sync', 'INCOMPLETE'))); await missing(path.join(moved, 'hello.txt'));
});

test('lock-release failure preserves verified downloads and exposes only constant finalization warning', async t => {
  const f = await fixture(t), plan = await f.pick(), input = f.payload(plan), original = fs.unlink, lockfile = path.join(f.controller.store.directory, 'operation.lock');
  let attempts = 0;
  const spy = t.mock.method(fs, 'unlink', async function (filename, ...args) {
    if (filename === lockfile) { attempts++; throw Object.assign(new Error('NEVER-REFLECT-LOCK-DETAIL'), { code: 'EACCES' }); }
    return original.call(this, filename, ...args);
  });
  await f.good('downloadstart', input); const result = await f.settle();
  assert.equal(result.state, 'succeeded'); assert.equal(result.completed, 2); assert.ok(result.items.every(item => item.state === 'succeeded'));
  assert.equal(result.warningCode, 'DOWNLOAD_FINALIZATION_FAILED'); assert.ok(!JSON.stringify(result).includes('NEVER-REFLECT'));
  for (const item of result.items) { assert.ok(await fs.stat(path.join(item.root, 'hello.txt'))); await missing(path.join(item.root, '.dsh-sync', 'INCOMPLETE')); }
  assert.deepEqual((await f.good('downloadstart', input)).download, result); assert.equal(attempts, 1, 'no automatic finalization retry');
  assert.ok(await fs.stat(lockfile)); spy.mock.restore();
});

test('page cancellation during whole local admission rejects without creating any selected root', async t => {
  const f = await fixture(t), plan = await f.pick(), input = f.payload(plan), original = fs.lstat, entered = deferred(), release = deferred(), page = new AbortController();
  f.releases.push(release.resolve); let blocked = false;
  const spy = t.mock.method(fs, 'lstat', async function (filename, ...args) {
    const value = await original.call(this, filename, ...args);
    if (!blocked && filename === f.parent && args[0]?.bigint === true) { blocked = true; entered.resolve(); await release.promise; }
    return value;
  });
  const starting = f.rpc('downloadstart', input, page.signal); await entered.promise; page.abort(); release.resolve();
  const response = await starting; assert.equal(response.ok, false); assert.equal(response.error.code, 'TIMEOUT'); await f.controller.drain(); spy.mock.restore();
  assert.deepEqual(await fs.readdir(f.parent), []); assert.equal((await f.service.status()).download, undefined);
  await f.good('downloadstart', input); assert.equal((await f.settle()).state, 'succeeded', 'unaccepted request did not consume an idempotency entry');
});

test('plans expiring during unaccepted local admission fail before any destination creation', async t => {
  const f = await fixture(t), plan = await f.pick(), original = fs.lstat, entered = deferred(), release = deferred();
  f.releases.push(release.resolve); let blocked = false;
  const spy = t.mock.method(fs, 'lstat', async function (filename, ...args) {
    const value = await original.call(this, filename, ...args);
    if (!blocked && filename === f.parent && args[0]?.bigint === true) { blocked = true; entered.resolve(); await release.promise; }
    return value;
  });
  const starting = f.rpc('downloadstart', f.payload(plan)); await entered.promise; f.advance(15 * 60_000); release.resolve();
  const response = await starting; assert.equal(response.ok, false); assert.equal(response.error.code, 'DIRECTORY_PICKER_EXPIRED'); await f.controller.drain(); spy.mock.restore();
  assert.deepEqual(await fs.readdir(f.parent), []); assert.equal((await f.service.status()).download, undefined);
});

test('cancelled download marks all remaining terminals with DOWNLOAD_CANCELLED and keeps completed roots', async t => {
  const f = await fixture(t), plan = await f.pick(f.items(3)), original = SyncClient.prototype.downloadBlob;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (hash, ...args) {
    if (hash === f.manifests[1].files[0].sha256) throw new DOMException('NEVER-REFLECT', 'AbortError');
    return original.call(this, hash, ...args);
  });
  await f.good('downloadstart', f.payload(plan)); const result = await f.settle();
  assert.equal(result.state, 'partial'); assert.equal(result.completed, 3); assert.equal(result.items[0].state, 'succeeded');
  assert.ok(result.items.slice(1).every(item => item.state === 'cancelled' && item.errorCode === 'DOWNLOAD_CANCELLED'));
  await missing(plan.destinations[2].root); assert.ok(!JSON.stringify(result).includes('NEVER-REFLECT'));
});

test('plan-cap failure publishes no partial selection and leaves earlier valid selection usable', async t => {
  const f = await fixture(t, { pickerOptions: { maxPlans: 4 } }), prior = await f.pick();
  await f.reject('downloadpick', { ...f.bound, items: f.items(3) }, 'DIRECTORY_PICKER_FAILED');
  assert.deepEqual(await fs.readdir(f.parent), []);
  await f.good('downloadstart', f.payload(prior)); assert.equal((await f.settle()).state, 'succeeded');
});

test('request cache cap is explicit, shared with recovery, and duplicates keep recorded results', async t => {
  const f = await fixture(t, { maxRecoveryRequests: 1 }), first = await f.download(), second = await f.pick();
  await f.reject('downloadstart', f.payload(second), 'RECOVERY_LIMIT');
  await f.reject('import', { ...f.bound, restoreId: first.result.items[0].restoreId, confirm: true, requestId: randomUUID() }, 'RECOVERY_LIMIT');
  assert.deepEqual((await f.good('downloadstart', first.input)).download, first.result);
  await f.reject('restore', { ...f.bound, ...f.items()[0], destination: path.join(f.parent, 'legacy'), confirm: true, requestId: first.input.requestId }, 'BAD_REQUEST');
});
