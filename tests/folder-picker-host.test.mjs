import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService } from '../plugin/settings-service.mjs';
import { createSettingsHttp, registerSettingsRoutes, SETTINGS_API } from '../plugin/settings-http.mjs';
import { proposedDirectoryName } from '../plugin/destination-picker.mjs';
import { SyncClient, projectFolderMetadata } from '../src/client.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { sha256 } from '../src/protocol.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bound = status => ({ revision: status.revision, server: status.server, username: status.username });
async function temporary(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'folder-picker-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('folder-picker-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function fixture(t, options = {}) {
  const root = await temporary(t), parent = path.join(root, 'destinations'), source = path.join(root, 'known-project'), profileDir = path.join(root, 'private', 'profile');
  for (const dir of [parent, source, profileDir]) await fs.mkdir(dir, { recursive: true });
  const bytes = Buffer.from('restored synthetic bytes'), manifest = { version: 1, id: 'checkpoint', projectId: 'cloud-project', deviceId: 'test-device', parentId: null, createdAt: '2026-01-02T00:00:00.000Z', sourceRoot: '/remote/Cloud Project', sessionIds: [], files: [{ path: 'project/hello.txt', sha256: sha256(bytes), size: bytes.length }] };
  const row = { id: manifest.id, projectId: manifest.projectId, deviceId: manifest.deviceId, parentId: null, createdAt: manifest.createdAt, fileCount: 1, totalBytes: bytes.length };
  const identity = { server: 'http://127.0.0.1:1', username: 'owner', token: 'a'.repeat(43), deviceId: 'test-device', expiresAt: '2099-01-01T00:00:00.000Z' };
  let capability = options.capability || { kind: 'native', pick: async () => parent }, provider = options.unavailable ? undefined : { capability: () => capability }, clock = 1_800_000_000_000, importCalls = 0;
  const workspaces = new Map([['local', { id: 'local', title: 'Known local folder', path: source }]]), records = new Map();
  const ctx = { get(name) { assert.equal(name, 'directoryPicker'); return provider; }, workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => records.set(key, await fn(records.get(key))), deleteRecord: async key => records.delete(key) } };
  Object.defineProperty(ctx, 'directoryPicker', { get() { throw new Error('optional direct property access forbidden'); } });
  const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync'), server: identity.server, username: identity.username, projects: options.noBindings ? [] : [{ id: manifest.projectId, root: source }] }, { allowLegacyCli: false, importSessions: async () => { importCalls++; return { imported: [], failed: [], skipped: [] }; } });
  const service = createSettingsService(ctx, controller, { profileDir, dshHome: path.join(root, 'private'), pickerOptions: { now: () => clock, ...options.pickerOptions } }), bridge = createSettingsHttp(service);
  records.set(controller.credentialKey, { kind: 'grant', payload: identity }); await controller.store.saveConfig({ server: identity.server, username: identity.username, deviceId: identity.deviceId });
  let intercept = options.request;
  t.mock.method(SyncClient.prototype, 'request', async function(route, requestOptions) {
    this.signal?.throwIfAborted();
    if (intercept) { const result = await intercept(route, requestOptions, this); if (result !== undefined) return result; }
    if (route === '/v1/projects') return { projects: [{ projectId: manifest.projectId, checkpointCount: 1, latestCreatedAt: manifest.createdAt, ...projectFolderMetadata(manifest.sourceRoot), latestCheckpointId: manifest.id }] };
    if (route.startsWith('/v1/checkpoints?')) return { checkpoints: [row], heads: [manifest.id] };
    if (route === `/v1/checkpoints/${manifest.id}`) return structuredClone(manifest);
    if (route.startsWith('/v1/blobs/')) return bytes;
    throw Object.assign(new Error('synthetic unavailable'), { httpStatus: 404 });
  });
  t.after(async () => { bridge.dispose(); controller.stop(); await controller.drain(); });
  const binding = bound(await service.status()), pickInput = { ...binding, projectId: manifest.projectId, checkpointId: manifest.id };
  const choose = signal => service.destinationpick(pickInput, signal);
  const restore = destination => ({ ...pickInput, destinationId: destination.id, requestId: randomUUID(), confirm: true });
  async function rpc(action, payload, signal) {
    const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'picker-rpc', method: `dsh-personal-sync/${action}`, payload }) }));
    assert.equal(response.status, 200); return (await response.json()).result;
  }
  return { root, parent, source, profileDir, manifest, row, bytes, identity, records, ctx, workspaces, controller, service, bridge, binding, pickInput, choose, restore, rpc, advance(ms) { clock += ms; }, setCapability(value) { capability = value; }, replaceProvider() { provider = { capability: () => capability }; }, setRequest(value) { intercept = value; }, get importCalls() { return importCalls; } };
}
function listing(directory, entries = [], crumbs = []) { return { path: directory, home: directory, entries: entries.map(value => typeof value === 'string' ? { name: path.basename(value), path: value, hidden: false } : value), crumbs: crumbs.map(value => ({ name: path.basename(value) || value, path: value, hidden: false })), truncated: false }; }
async function noEntry(filename) { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }

test('native Host chooser makes no destination writes; opaque plan restores bytes only after confirmation', async t => {
  const f = await fixture(t), before = await fs.readdir(f.parent), { destination } = await f.choose();
  assert.equal(destination.parent, f.parent); assert.equal(destination.root, path.join(f.parent, 'Cloud Project')); assert.notEqual(destination.id, destination.root);
  assert.deepEqual(await fs.readdir(f.parent), before); await noEntry(destination.root);
  const payload = f.restore(destination);
  assert.equal((await f.rpc('restore', { ...payload, confirm: false })).error.code, 'BAD_REQUEST');
  assert.equal((await f.rpc('restore', { ...payload, destination: path.join(f.parent, 'substitution') })).error.code, 'BAD_REQUEST');
  assert.equal((await f.rpc('restore', { ...payload, projectId: 'foreign-project' })).error.code, 'DIRECTORY_PICKER_EXPIRED');
  const accepted = await f.service.restore(payload); assert.equal(accepted.recovery.state, 'running');
  await f.controller.drain(); const recovery = (await f.service.status()).recovery;
  assert.equal(recovery.state, 'succeeded'); assert.equal(await fs.readFile(path.join(destination.root, 'hello.txt'), 'utf8'), f.bytes.toString());
  assert.equal(f.importCalls, 0); assert.equal(f.workspaces.size, 1); await noEntry(path.join(destination.root, '.dsh-sync', 'INCOMPLETE'));
  f.advance(16 * 60_000); assert.deepEqual((await f.service.restore(payload)).recovery, recovery);
  await assert.rejects(f.service.restore({ ...payload, requestId: randomUUID() }), { code: 'DIRECTORY_PICKER_EXPIRED' });
});

test('fresh Cordis trace wrappers preserve provider identity without optional property access', async t => {
  const f = await fixture(t), original = { capability: () => ({ kind: 'native', pick: async () => f.parent }) };
  t.mock.method(f.ctx, 'get', name => { assert.equal(name, 'directoryPicker'); return { [Symbol.for('cordis.original')]: original, capability: original.capability }; });
  const { destination } = await f.choose(); assert.equal(destination.parent, f.parent); await noEntry(destination.root);
});

test('native chooser cancellation, unavailable provider, sanitized failures and malformed paths', async t => {
  const f = await fixture(t, { unavailable: true });
  await assert.rejects(f.choose(), { code: 'DIRECTORY_PICKER_UNAVAILABLE' });
  f.replaceProvider(); f.setCapability({ kind: 'native', pick: async () => null }); assert.deepEqual(await f.choose(), { cancelled: true });
  f.setCapability({ kind: 'native', pick: async () => { throw new Error('secret-token-provider-failure'); } });
  const failed = await f.rpc('destinationpick', f.pickInput); assert.equal(failed.error.code, 'DIRECTORY_PICKER_FAILED'); assert.ok(!JSON.stringify(failed).includes('secret-token'));
  for (const result of [undefined, {}, 'relative', '//server/share/folder', 'C:relative', path.join(f.parent, 'missing')]) {
    f.setCapability({ kind: 'native', pick: async () => result }); await assert.rejects(f.choose(), { code: 'BAD_DESTINATION' });
  }
  f.setCapability({ kind: 'browse', list: async () => listing(f.profileDir) }); await assert.rejects(f.choose(), { code: 'PROTECTED_DESTINATION' });
});

test('native rejects links, protected/current/historical projects and safely proposes collision suffix', async t => {
  const f = await fixture(t), link = path.join(f.root, 'redirect'); await fs.symlink(f.parent, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [selected, code] of [[link, 'BAD_DESTINATION'], [f.profileDir, 'PROTECTED_DESTINATION'], [f.source, 'PROTECTED_DESTINATION']]) {
    f.setCapability({ kind: 'native', pick: async () => selected }); await assert.rejects(f.choose(), { code });
  }
  f.workspaces.clear(); f.setCapability({ kind: 'native', pick: async () => f.source }); await assert.rejects(f.choose(), { code: 'PROTECTED_DESTINATION' });
  await fs.mkdir(path.join(f.parent, 'Cloud Project')); f.setCapability({ kind: 'native', pick: async () => f.parent });
  const { destination } = await f.choose(); assert.match(path.basename(destination.root), /^Cloud Project-[a-f0-9]{8}$/); await noEntry(destination.root);
  for (const name of ['CON', '.ssh', '.dsh-sync', 'credentials.json', '..']) assert.equal(proposedDirectoryName(`/remote/${name}`), 'project');
  assert.equal(proposedDirectoryName('C:\\remote\\normal project'), 'normal project');
});

test('selecting a registered project parent proposes a safe sibling instead of modifying the source', async t => {
  const f = await fixture(t); f.manifest.sourceRoot = '/remote/known-project';
  f.setCapability({ kind: 'native', pick: async () => f.root });
  const before = await fs.readdir(f.source), { destination } = await f.choose();
  assert.equal(destination.parent, f.root); assert.match(path.basename(destination.root), /^known-project-[a-f0-9]{8}$/);
  await noEntry(destination.root); assert.deepEqual(await fs.readdir(f.source), before);
});

test('native caller abort, Host disposal, stale binding/account and provider replacement cannot issue a plan', async t => {
  const f = await fixture(t), entered = deferred(), page = new AbortController();
  let observed;
  f.setCapability({ kind: 'native', pick: async signal => { observed = signal; entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return f.parent; } });
  const picking = f.choose(page.signal); await entered.promise; page.abort(); await assert.rejects(picking); assert.equal(observed.aborted, true); assert.deepEqual(await fs.readdir(f.parent), []);
  f.setCapability({ kind: 'native', pick: async () => { f.replaceProvider(); return f.parent; } }); await assert.rejects(f.choose(), { code: 'DIRECTORY_PICKER_EXPIRED' });
  f.setCapability({ kind: 'native', pick: async () => { f.setCapability({ kind: 'browse', list: async () => listing(f.parent) }); return f.parent; } }); await assert.rejects(f.choose(), { code: 'DIRECTORY_PICKER_EXPIRED' });
  f.setCapability({ kind: 'native', pick: async () => { f.records.set(f.controller.credentialKey, { kind: 'grant', payload: { ...f.identity, token: 'b'.repeat(43) } }); return f.parent; } }); await assert.rejects(f.choose(), { code: 'ACCOUNT_MISMATCH' });
  f.records.set(f.controller.credentialKey, { kind: 'grant', payload: f.identity });
  f.setCapability({ kind: 'native', pick: async () => { await fs.writeFile(f.service.filename, JSON.stringify({ version: 1, ...f.binding, revision: f.binding.revision + 1, bindings: [], selected: [], autoSync: false, intervalMs: 60000 })); return f.parent; } });
  await assert.rejects(f.choose(), { code: 'CONFIG_CONFLICT' });
});

test('Host disposal actually aborts native callback and drains chooser', async t => {
  const f = await fixture(t), entered = deferred(); let observed;
  f.setCapability({ kind: 'native', pick: async signal => { observed = signal; entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return null; } });
  const choosing = f.choose(); await entered.promise; f.controller.stop(); await assert.rejects(choosing); await f.controller.drain(); assert.equal(observed.aborted, true);
});

test('browse validates provider topology, filters protected/hidden/links and only accepts issued opaque nodes', async t => {
  const f = await fixture(t), child = path.join(f.parent, 'child'), hidden = path.join(f.parent, '.hidden'), protectedChild = path.join(f.parent, 'registered'), link = path.join(f.parent, 'link');
  await fs.mkdir(child); await fs.mkdir(hidden); await fs.mkdir(protectedChild); await fs.symlink(child, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.workspaces.set('other', { id: 'other', title: 'Do not browse', path: protectedChild });
  const calls = [];
  f.setCapability({ kind: 'browse', list: async value => { calls.push(value); return value === child ? listing(child, [], [f.parent, child]) : listing(f.parent, [child, { name: '.hidden', path: hidden, hidden: true }, protectedChild, link], [f.root, f.parent]); }, createDirectory: () => assert.fail('picker must not create directories') });
  const { browser } = await f.choose(); assert.equal(browser.path, f.parent); assert.equal(browser.selectable, true); assert.deepEqual(browser.directories.map(item => item.label), ['child']); assert.deepEqual(calls, [undefined]);
  assert.ok(browser.directories.every(item => !Object.hasOwn(item, 'path')));
  for (const nodeId of ['forged', child]) {
    const result = await f.rpc('destinationbrowse', { ...f.binding, browserId: browser.id, nodeId }); assert.equal(result.ok, false);
  }
  const input = { ...f.binding, browserId: browser.id, nodeId: browser.directories[0].id };
  const visited = await f.service.destinationbrowse(input); assert.equal(visited.browser.path, child); assert.equal(calls.at(-1), child);
  const selected = await f.service.destinationselect(input); assert.equal(selected.destination.parent, child); await noEntry(selected.destination.root);
  const second = await f.choose(); await assert.rejects(f.service.destinationselect({ ...input, browserId: second.browser.id }), { code: 'DIRECTORY_PICKER_EXPIRED' });
  f.advance(16 * 60_000); await assert.rejects(f.service.destinationbrowse(input), { code: 'DIRECTORY_PICKER_EXPIRED' });
});

test('browse rejects substituted current path, nonchildren, malformed ancestry and oversized metadata', async t => {
  const f = await fixture(t), child = path.join(f.parent, 'child'); await fs.mkdir(child);
  for (const response of [listing(f.parent, [f.source]), listing(f.parent, [], [child]), { ...listing(f.parent), entries: Array(2001).fill({ name: 'child', path: child, hidden: false }) }, { ...listing(f.parent), home: 'relative' }]) {
    f.setCapability({ kind: 'browse', list: async () => response }); await assert.rejects(f.choose(), { code: 'DIRECTORY_PICKER_FAILED' });
  }
  f.setCapability({ kind: 'browse', list: async () => listing(f.parent, [child]) }); const { browser } = await f.choose();
  f.setCapability({ kind: 'browse', list: async () => listing(f.parent) });
  await assert.rejects(f.service.destinationbrowse({ ...f.binding, browserId: browser.id, nodeId: browser.directories[0].id }), { code: 'DIRECTORY_PICKER_FAILED' });
});

test('picker caps fail explicitly; expired sessions are not reused, all RPCs are exact admitted POST routes', async t => {
  const f = await fixture(t, { pickerOptions: { maxPlans: 1, maxBrowsers: 1, maxNodes: 1 } });
  await f.choose(); await assert.rejects(f.choose(), { code: 'DIRECTORY_PICKER_FAILED' }); f.advance(16 * 60_000); await f.choose();
  const child = path.join(f.parent, 'child'); await fs.mkdir(child); f.setCapability({ kind: 'browse', list: async () => listing(f.parent, [child]) });
  await assert.rejects(f.choose(), { code: 'DIRECTORY_PICKER_FAILED' });
  const routes = []; registerSettingsRoutes({ connection: { fetch: { register: value => routes.push(value) } } }, f.bridge);
  assert.equal(routes.length, 17); assert.ok(routes.every(route => route.methods.length === 1 && route.methods[0] === 'POST' && route.requestBody === 'streaming'));
  for (const action of ['destinationpick', 'destinationbrowse', 'destinationselect']) {
    assert.equal((await f.bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`))).status, 405);
    assert.equal((await f.rpc(action, { ...f.pickInput, path: f.parent })).error.code, 'BAD_REQUEST');
  }
});

test('changed parent and changed account invalidate plans; settings/recovery/update gates remain authoritative', async t => {
  const f = await fixture(t), { destination } = await f.choose(), moved = path.join(f.root, 'old-parent');
  await fs.rename(f.parent, moved); await fs.mkdir(f.parent);
  await f.service.restore(f.restore(destination)); await f.controller.drain(); assert.equal((await f.service.status()).recovery.errorCode, 'DESTINATION_CHANGED'); assert.deepEqual(await fs.readdir(f.parent), []);
  const fresh = await f.choose(), grant = f.records.get(f.controller.credentialKey); f.records.set(f.controller.credentialKey, { ...grant, payload: { ...grant.payload, token: 'b'.repeat(43) } });
  await assert.rejects(f.service.restore(f.restore(fresh.destination)), { code: 'DIRECTORY_PICKER_EXPIRED' });
  const entered = deferred(), release = deferred(), holding = f.controller.mutate(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  await assert.rejects(f.choose(), { code: 'BUSY' }); release.resolve(); await holding;
  f.controller.markUpdateRestartRequired(); await assert.rejects(f.choose(), { code: 'UPDATE_RESTART_REQUIRED' });
});

test('accepted restore survives plan TTL; parent swap after network prevents all further writes', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.setRequest(async route => { if (route.startsWith('/v1/blobs/')) { entered.resolve(); await release.promise; return f.bytes; } });
  const { destination } = await f.choose(), payload = f.restore(destination); await f.service.restore(payload); await entered.promise;
  await assert.rejects(f.choose(), { code: 'BUSY' }); f.advance(16 * 60_000); release.resolve(); await f.controller.drain(); assert.equal((await f.service.status()).recovery.state, 'succeeded');
  const nextEntered = deferred(), nextRelease = deferred(); f.setRequest(async route => { if (route.startsWith('/v1/blobs/')) { nextEntered.resolve(); await nextRelease.promise; return f.bytes; } });
  const next = await f.choose(); await f.service.restore(f.restore(next.destination)); await nextEntered.promise;
  const moved = path.join(f.root, 'original-parent'); await fs.rename(f.parent, moved); await fs.mkdir(f.parent); nextRelease.resolve(); await f.controller.drain();
  assert.equal((await f.service.status()).recovery.errorCode, 'DESTINATION_CHANGED'); assert.deepEqual(await fs.readdir(f.parent), []);
  const incomplete = path.join(moved, path.basename(next.destination.root)); assert.ok(await fs.stat(path.join(incomplete, '.dsh-sync', 'INCOMPLETE'))); await noEntry(path.join(incomplete, 'hello.txt'));
});

test('Host project names hydrate old row metadata and fallback only to known nonempty cloud bindings', async t => {
  const f = await fixture(t);
  f.setRequest(async route => route === '/v1/projects' ? { projects: [{ projectId: f.manifest.projectId, checkpointCount: 1, latestCreatedAt: f.manifest.createdAt }] } : undefined);
  let result = await f.service.projects(f.binding); assert.equal(result.legacy, true); assert.equal(result.projects[0].label, 'Cloud Project');
  f.setRequest(async route => { if (route === '/v1/projects') throw Object.assign(new Error('old server'), { httpStatus: 404 }); });
  result = await f.service.projects(f.binding); assert.equal(result.legacy, true); assert.equal(result.projects.length, 1); assert.equal(result.projects[0].projectId, f.manifest.projectId);
  f.setRequest(async route => { if (route === '/v1/projects') throw Object.assign(new Error('old server'), { httpStatus: 405 }); if (route.startsWith('/v1/checkpoints?')) return { checkpoints: [], heads: [] }; });
  assert.deepEqual((await f.service.projects(f.binding)).projects, []);
  f.setRequest(async route => { if (route === '/v1/projects') throw Object.assign(new Error('old server'), { httpStatus: 404 }); if (route === '/v1/checkpoints/checkpoint') throw new Error('secret remote exception'); });
  result = await f.service.projects(f.binding); assert.equal(result.partial, true); assert.equal(result.projects[0].label, 'Known local folder'); assert.ok(!JSON.stringify(result).includes('secret remote'));
});

test('legacy hydration keeps last-committed label but compares expanded ISO timestamps numerically', async t => {
  const f = await fixture(t), future = '+010000-01-01T00:00:00.000Z';
  f.setRequest(async route => {
    if (route === '/v1/projects') return { projects: [{ projectId: f.manifest.projectId, checkpointCount: 2, latestCreatedAt: future }] };
    if (route.startsWith('/v1/checkpoints?')) return { checkpoints: [{ ...f.row, createdAt: future }, { ...f.row, id: 'last-commit', createdAt: '2025-01-01T00:00:00.000Z' }], heads: [f.row.id, 'last-commit'] };
    if (route === '/v1/checkpoints/last-commit') return { ...f.manifest, id: 'last-commit', createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: '/remote/Cafe\u0301' };
  });
  const { projects } = await f.service.projects(f.binding);
  assert.equal(projects[0].latestCreatedAt, future); assert.equal(projects[0].label, 'Café'); assert.equal(projects[0].sourceRoot, '/remote/Cafe\u0301');
});

test('unknown old-server projects cannot guess mapping from unrelated workspaces; invalid metadata is rejected', async t => {
  const f = await fixture(t, { noBindings: true, request: async route => { if (route === '/v1/projects') throw Object.assign(new Error('old'), { httpStatus: 404 }); } });
  assert.equal((await f.rpc('projects', f.binding)).error.code, 'CLOUD_BROWSE_UNSUPPORTED');
  const client = new SyncClient(f.identity);
  for (const optional of [{ label: { secret: 'bad' } }, { label: '\u0000bad' }, { sourceRoot: 'relative' }, { latestCheckpointId: '../bad' }, { sourceRoot: '/remote/folder', label: 'mismatch' }]) {
    f.setRequest(async route => route === '/v1/projects' ? { projects: [{ projectId: 'p', checkpointCount: 1, latestCreatedAt: f.manifest.createdAt, ...optional }] } : undefined);
    await assert.rejects(client.projects());
  }
});

test('loopback committed folder metadata uses last commit, preserves old index and verifies immutable bytes', async t => {
  const root = await temporary(t), dataDir = path.join(root, 'cloud');
  let server = await createSyncServer({ dataDir, username: 'owner', password: 'synthetic-password' }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => closeSyncServer(server));
  const client = new SyncClient({ server: `http://127.0.0.1:${server.address().port}` }); await client.login({ username: 'owner', password: 'synthetic-password', deviceId: 'device' });
  const first = { version: 1, id: 'first', projectId: 'p', deviceId: 'device', parentId: null, createdAt: '2026-06-01T00:00:00.000Z', sourceRoot: '/remote/old-name', sessionIds: [], files: [] };
  await client.commit(first); await client.commit({ ...first, id: 'last-committed', sourceRoot: 'C:\\source\\Final Folder', createdAt: '2025-01-01T00:00:00.000Z' });
  const decomposedRoot = '/remote/Cafe\u0301';
  await client.commit({ ...first, id: 'nfd-checkpoint', projectId: 'nfd-project', sourceRoot: decomposedRoot });
  await closeSyncServer(server);
  const stateFile = path.join(dataDir, 'state.json'), before = await fs.readFile(stateFile);
  server = await createSyncServer({ dataDir }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); client.server = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${client.server}/v1/projects`)).status, 401);
  const result = await client.projects(); assert.equal(result.projects.length, 2);
  assert.deepEqual(result.projects.find(item => item.projectId === 'p'), { projectId: 'p', checkpointCount: 2, latestCreatedAt: first.createdAt, label: 'Final Folder', sourceRoot: 'C:\\source\\Final Folder', latestCheckpointId: 'last-committed' });
  const nfd = result.projects.find(item => item.projectId === 'nfd-project'); assert.equal(nfd.label, 'Café'); assert.equal(nfd.sourceRoot, decomposedRoot); assert.equal(proposedDirectoryName(nfd.sourceRoot), 'Café');
  assert.deepEqual(await fs.readFile(stateFile), before);
  const file = path.join(dataDir, 'checkpoints', `${sha256('last-committed')}.json`); await fs.writeFile(file, '{}'); await assert.rejects(client.projects(), { httpStatus: 500 });
});
