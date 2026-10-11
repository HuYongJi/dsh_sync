import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, registerSettingsRoutes, SETTINGS_API, MAX_SETTINGS_BODY } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-settings-password-12345';
async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'settings-'));
  const controllers = [], servers = [];
  t.after(async () => {
    for (const controller of controllers) controller.stop();
    await Promise.all(controllers.map(controller => controller.drain()));
    for (const server of servers) await closeSyncServer(server);
    assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('settings-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dshHome = path.join(root, 'host-private'), profileDir = path.join(dshHome, 'profiles', 'one');
  await fs.mkdir(profileDir, { recursive: true });
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b');
  await fs.mkdir(a); await fs.mkdir(b); await fs.writeFile(path.join(a, 'a.txt'), 'fixture A'); await fs.writeFile(path.join(b, 'b.txt'), 'fixture B');
  const records = options.records || new Map();
  const workspaces = new Map([
    ['workspace-a', { id: 'workspace-a', path: a, title: '项目 A', sessionIds: ['do-not-expose-session-ids'] }],
    ['workspace-b', { id: 'workspace-b', path: b, title: '项目 B', sessionIds: [] }],
  ]);
  const ctx = { workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, callback) => { const value = await callback(records.get(key)); if (value !== undefined) records.set(key, value); },
    deleteRecord: async key => records.delete(key),
  } };
  function mount(dir = profileDir, extra = {}) {
    const controller = createController(ctx, { stateDir: path.join(dir, 'dsh-personal-sync') }, { credentialKey: credentialKeyForProfile(dir), allowLegacyCli: false, exportSessions: options.exportSessions || (async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} })), ...extra });
    controllers.push(controller);
    const service = createSettingsService(ctx, controller, { profileDir: dir, dshHome });
    const bridge = createSettingsHttp(service, options.http);
    return { controller, service, bridge };
  }
  const mounted = mount();
  let cloud;
  async function login() {
    if (!cloud) {
      cloud = await createSyncServer({ dataDir: path.join(root, 'cloud'), username: 'owner', password }); servers.push(cloud);
      await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
    }
    const server = `http://127.0.0.1:${cloud.address().port}`;
    const result = await mounted.service.login({ server, username: 'owner', password });
    return { result, server, cloud, client: new SyncClient(records.get(mounted.controller.credentialKey).payload) };
  }
  return { root, a, b, dshHome, profileDir, records, workspaces, ctx, mount, login, ...mounted };
}
function nativeRequest(action, payload = {}, extra = {}) {
  return new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-fixture-1', method: `dsh-personal-sync/${action}`, payload }), ...extra });
}
async function rpc(bridge, action, payload = {}) {
  const response = await bridge.fetch(action, nativeRequest(action, payload));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.type, 'server-response'); assert.equal(body.rpcId, 'rpc-fixture-1');
  return { response, body, result: body.result };
}

test('settings status discovers native projects, defaults to no selection, and omits sessions/secrets', async t => {
  const f = await fixture(t), { result } = await rpc(f.bridge, 'status');
  assert.equal(result.ok, true); const value = result.value;
  assert.equal(value.loggedIn, false); assert.equal(value.autoSync, false); assert.equal(value.revision, 0);
  assert.deepEqual(value.projects.map(item => [item.id, item.selected, item.available]), [['workspace-a', false, true], ['workspace-b', false, true]]);
  assert.ok(!JSON.stringify(value).includes('do-not-expose-session-ids'));
  await assert.rejects(fs.stat(f.service.filename), { code: 'ENOENT' });
});
test('settings login uses real HTTP and stores only a profile-scoped native grant', async t => {
  const f = await fixture(t), { result } = await f.login();
  assert.equal(result.loggedIn, true); assert.equal(result.revision, 1);
  const record = f.records.get(f.controller.credentialKey); assert.equal(record.kind, 'grant');
  assert.notEqual(f.controller.credentialKey, 'dsh-personal-sync/account');
  assert.equal(f.records.has('dsh-personal-sync/account'), false);
  for (const filename of [f.service.filename, path.join(f.controller.store.directory, 'config.json')]) {
    const text = await fs.readFile(filename, 'utf8'); assert.ok(!text.includes(password)); assert.ok(!text.includes(record.payload.token));
  }
  assert.ok(!JSON.stringify(result).includes(record.payload.token));
});
test('failed login preserves selected projects, previous identity and native token', async t => {
  const f = await fixture(t), { result, server } = await f.login();
  await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-a'] });
  const token = f.records.get(f.controller.credentialKey).payload.token;
  const before = await fs.readFile(f.service.filename, 'utf8');
  const reply = await rpc(f.bridge, 'login', { server, username: 'owner', password: 'wrong password' });
  assert.equal(reply.response.status, 200); assert.equal(reply.result.ok, false); assert.equal(reply.result.error.code, 'LOGIN_FAILED');
  assert.equal(f.records.get(f.controller.credentialKey).payload.token, token);
  assert.equal(await fs.readFile(f.service.filename, 'utf8'), before);
});
test('project selection persists without YAML edits and reloads after controller restart', async t => {
  const f = await fixture(t), { result, client } = await f.login();
  const saved = await f.service.savePreferences({ revision: result.revision, autoSync: true, projectIds: ['workspace-a'] });
  assert.equal(saved.autoSync, true); assert.equal(saved.projects.filter(item => item.selected).length, 1);
  const projectId = saved.projects.find(item => item.id === 'workspace-a').projectId;
  assert.match(projectId, /^project-/);
  const second = f.mount(); const reloaded = await second.service.status();
  assert.equal(reloaded.autoSync, true); assert.equal(reloaded.loggedIn, true); assert.equal(reloaded.projects.find(item => item.selected).projectId, projectId);
  await f.controller.push(projectId);
  assert.equal((await client.list(projectId)).checkpoints.length, 1);
});
test('stale revisions, arbitrary paths and unknown project IDs cannot authorize files', async t => {
  const f = await fixture(t), status = await f.service.status();
  const saved = await f.service.savePreferences({ revision: status.revision, autoSync: false, projectIds: ['workspace-a'] });
  await assert.rejects(f.service.savePreferences({ revision: 0, autoSync: false, projectIds: ['workspace-b'] }), { code: 'CONFIG_CONFLICT' });
  for (const payload of [
    { revision: saved.revision, autoSync: false, projectIds: ['made-up-id'] },
    { revision: saved.revision, autoSync: false, projectIds: ['workspace-b'], root: f.b },
    { revision: saved.revision, autoSync: false, projectIds: ['workspace-b', 'workspace-b'] },
  ]) await assert.rejects(f.service.savePreferences(payload));
  assert.deepEqual((await f.service.status()).projects.filter(item => item.selected).map(item => item.id), ['workspace-a']);
});
test('automatic sync and immediate sync require login and explicitly selected projects', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.savePreferences({ revision: 0, autoSync: true, projectIds: ['workspace-a'] }), { code: 'NOT_LOGGED_IN' });
  await assert.rejects(f.service.sync({}), { code: 'NOT_LOGGED_IN' });
  const { result } = await f.login();
  await assert.rejects(f.service.sync({ projectId: 'workspace-b' }));
  assert.equal(result.projects.filter(item => item.selected).length, 0);
});
test('deselecting a project retains its offline queue but cannot transmit it', async t => {
  const f = await fixture(t), { result, client } = await f.login();
  const selected = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-a'] });
  const id = selected.projects.find(item => item.selected).projectId;
  const deviceId = f.records.get(f.controller.credentialKey).payload.deviceId;
  await f.controller.store.capture({ root: f.a, projectId: id, deviceId });
  await f.service.savePreferences({ revision: selected.revision, autoSync: false, projectIds: [] });
  await assert.rejects(f.controller.push(id), /未在插件配置/);
  await f.controller.tick();
  assert.equal((await f.controller.store.pending()).length, 1); assert.equal((await client.list(id)).checkpoints.length, 0);
});
test('selection change cancels and waits for an in-flight snapshot before acknowledging', async t => {
  let release, entered;
  const exporting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { exportSessions: async () => { entered(); await blocked; return { sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }; } });
  const { result, client } = await f.login();
  const selected = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-a'] });
  const id = selected.projects.find(item => item.selected).projectId;
  const pushing = f.controller.push(id); const rejected = assert.rejects(pushing, { name: 'AbortError' });
  await exporting;
  let saved = false, cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const originalAbort = AbortController.prototype.abort;
  const spy = t.mock.method(AbortController.prototype, 'abort', function (...args) { cancelled(); return originalAbort.apply(this, args); });
  const saving = f.service.savePreferences({ revision: selected.revision, autoSync: false, projectIds: [] }).then(value => { saved = true; return value; });
  await cancellation; spy.mock.restore(); assert.equal(saved, false);
  release(); await rejected; await saving;
  assert.equal((await f.controller.store.pending()).length, 0); assert.equal((await client.list(id)).checkpoints.length, 0);
});
test('removed or moved registry roots cannot flush an existing authorized queue', async t => {
  const f = await fixture(t), { result, client } = await f.login();
  const saved = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-a'] });
  const id = saved.projects.find(item => item.selected).projectId, deviceId = f.records.get(f.controller.credentialKey).payload.deviceId;
  await f.controller.store.capture({ root: f.a, projectId: id, deviceId });
  f.workspaces.get('workspace-a').path = f.b;
  assert.equal((await f.service.status()).projects.find(item => item.id === 'workspace-a').available, false);
  await assert.rejects(f.controller.push(id), { code: 'PROJECT_UNAVAILABLE' });
  f.workspaces.delete('workspace-a');
  const missing = (await f.service.status()).projects.find(item => item.id === 'workspace-a');
  assert.equal(missing.selected, true); assert.equal(missing.available, false);
  await assert.rejects(f.controller.push(id), { code: 'PROJECT_UNAVAILABLE' });
  assert.equal((await client.list(id)).checkpoints.length, 0);
  await f.service.savePreferences({ revision: saved.revision, autoSync: false, projectIds: [] });
});
test('DSH home/profile/state are excluded literally even beneath a selected ancestor project', async t => {
  const f = await fixture(t), { result, client } = await f.login();
  await fs.writeFile(path.join(f.dshHome, 'pretend-credential.txt'), 'DO-NOT-UPLOAD-PRIVATE');
  f.workspaces.set('workspace-home', { id: 'workspace-home', path: f.dshHome, title: 'Protected home' });
  f.workspaces.set('workspace-parent', { id: 'workspace-parent', path: f.root, title: 'Ancestor' });
  const status = await f.service.status(); assert.equal(status.projects.find(item => item.id === 'workspace-home').available, false);
  await assert.rejects(f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-home'] }), { code: 'PROJECT_UNAVAILABLE' });
  const saved = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-parent'] });
  const id = saved.projects.find(item => item.id === 'workspace-parent').projectId;
  // The synthetic cloud is also under this fixture, so avoid selecting that unrelated store.
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'cloud/**\n');
  await f.controller.push(id);
  const catalog = await client.list(id), manifest = await client.getCheckpoint(catalog.checkpoints[0].id);
  assert.ok(!manifest.files.some(file => file.path.includes('host-private')));
  assert.ok(!manifest.files.some(file => file.path.includes('pretend-credential')));
});
test('profiles do not share grants, settings or legacy CLI fallback', async t => {
  const f = await fixture(t); await f.login();
  const two = path.join(f.dshHome, 'profiles', 'two'); await fs.mkdir(two);
  const second = f.mount(two); await second.controller.store.init();
  const oldRecord = f.records.get(f.controller.credentialKey);
  await second.controller.store.saveConfig({ ...oldRecord.payload });
  assert.notEqual(second.controller.credentialKey, f.controller.credentialKey);
  const status = await second.service.status(); assert.equal(status.loggedIn, false); assert.equal(status.projects.filter(item => item.selected).length, 0);
  await assert.rejects(second.service.sync({}), { code: 'NOT_LOGGED_IN' });
});
test('GUI logout clears its grant, disables auto sync and never reveals tokens', async t => {
  const f = await fixture(t), { result, client } = await f.login();
  await f.service.savePreferences({ revision: result.revision, autoSync: true, projectIds: ['workspace-a'] });
  const token = f.records.get(f.controller.credentialKey).payload.token;
  const reply = await rpc(f.bridge, 'logout'); assert.equal(reply.result.ok, true);
  assert.equal(reply.result.value.loggedIn, false); assert.equal(reply.result.value.autoSync, false);
  assert.equal(f.records.has(f.controller.credentialKey), false); assert.ok(!JSON.stringify(reply.body).includes(token));
  await assert.rejects(client.list('unused'), { status: 401 });
});
test('falsy persisted settings fail closed instead of reviving install-time permissions', async t => {
  const f = await fixture(t); await f.service.status();
  for (const value of [null, false, 0, '']) {
    await fs.writeFile(f.service.filename, JSON.stringify(value));
    await assert.rejects(f.service.status(), { code: 'SETTINGS_CORRUPT' });
    await assert.rejects(f.controller.tick(), { code: 'SETTINGS_CORRUPT' });
  }
});
test('native, local identity and saved account must agree without falling back to another grant', async t => {
  const f = await fixture(t); await f.login();
  const original = { ...await f.controller.store.config() };
  for (const patch of [{ username: 'another-user' }, { deviceId: 'another-device' }, { server: 'https://another.example' }]) {
    await f.controller.store.saveConfig({ ...original, ...patch });
    assert.equal((await f.service.status()).loggedIn, false);
    await assert.rejects(f.service.sync({}), { code: 'ACCOUNT_MISMATCH' });
  }
  await f.controller.store.saveConfig({ ...original, token: 'x'.repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() });
  f.records.set(f.controller.credentialKey, { kind: 'invalid', payload: {} });
  assert.equal((await f.service.status()).loggedIn, false);
});
test('registry disappearance after one blob prevents the next blob and commit', async t => {
  const f = await fixture(t), { result, cloud, client } = await f.login();
  await fs.writeFile(path.join(f.a, 'second.txt'), 'another blob');
  const saved = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-a'] });
  const id = saved.projects.find(item => item.selected).projectId;
  await f.controller.store.capture({ root: f.a, projectId: id, deviceId: f.records.get(f.controller.credentialKey).payload.deviceId });
  let uploads = 0, commits = 0;
  cloud.on('request', req => { if (req.method === 'PUT' && req.url.startsWith('/v1/blobs/')) { uploads++; f.workspaces.delete('workspace-a'); } if (req.method === 'POST' && req.url === '/v1/checkpoints') commits++; });
  await assert.rejects(f.controller.push(id), { code: 'PROJECT_UNAVAILABLE' });
  assert.equal(uploads, 1); assert.equal(commits, 0); assert.equal((await client.list(id)).checkpoints.length, 0);
});
test('legacy queued checkpoints containing protected Host paths are blocked before any blob', async t => {
  const f = await fixture(t), { result, cloud } = await f.login();
  await fs.writeFile(path.join(f.dshHome, 'legacy-private.txt'), 'synthetic secret outside selected project files');
  f.workspaces.set('parent', { id: 'parent', path: f.root, title: 'Parent project' });
  const saved = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['parent'] });
  const id = saved.projects.find(item => item.selected).projectId;
  const captured = await f.controller.store.capture({ root: f.root, projectId: id, deviceId: f.records.get(f.controller.credentialKey).payload.deviceId, excludedPaths: ['cloud'] });
  assert.ok(captured.manifest.files.some(file => file.path.endsWith('/legacy-private.txt')));
  let uploads = 0; cloud.on('request', req => { if (req.method === 'PUT') uploads++; });
  await assert.rejects(f.controller.push(id), { code: 'PROTECTED_QUEUE' });
  assert.equal(uploads, 0); assert.equal((await f.controller.store.pending()).length, 1);
  assert.match((await f.service.status()).lastResult.message, /受保护路径/);
});
test('a recreated local workspace does not silently adopt an old queue by directory alone', async t => {
  const f = await fixture(t), { result } = await f.login();
  const saved = await f.service.savePreferences({ revision: result.revision, autoSync: false, projectIds: ['workspace-a'] });
  const oldId = saved.projects.find(item => item.selected).projectId;
  await f.controller.store.capture({ root: f.a, projectId: oldId, deviceId: f.records.get(f.controller.credentialKey).payload.deviceId });
  f.workspaces.delete('workspace-a'); f.workspaces.set('workspace-new', { id: 'workspace-new', path: f.a, title: 'Recreated' });
  const next = await f.service.savePreferences({ revision: saved.revision, autoSync: false, projectIds: ['workspace-new'] });
  assert.notEqual(next.projects.find(item => item.selected).projectId, oldId);
  assert.equal((await f.controller.store.pending())[0].projectId, oldId);
});
test('native authorization flow persists username for the graphical settings page', async t => {
  const f = await fixture(t), { server } = await f.login();
  const profileDir = path.join(f.dshHome, 'profiles', 'native-auth'); await fs.mkdir(profileDir);
  const controller = createController(f.ctx, { server, stateDir: path.join(profileDir, 'dsh-personal-sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false });
  const service = createSettingsService(f.ctx, controller, { profileDir, dshHome: f.dshHome });
  try {
    await controller.authorize({ signal: new AbortController().signal, prompt: async request => request.kind === 'text' ? 'owner' : password, commit: record => f.ctx.credentials.modifyRecord(controller.credentialKey, async () => record) });
    const status = await service.status(); assert.equal(status.username, 'owner'); assert.equal(status.loggedIn, true);
  } finally { controller.stop(); await controller.drain(); }
});
test('login responses cannot override the trusted server, username or device', async t => {
  const token = 'x'.repeat(43), expiresAt = new Date(Date.now() + 60000).toISOString();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ token, expiresAt, server: 'https://unexpected.example', username: 'unexpected', deviceId: 'unexpected', password: 'echoed' }));
  const client = new SyncClient({ server: 'https://expected.example' });
  assert.deepEqual(await client.login({ username: 'owner', password, deviceId: 'expected-device' }), { token, expiresAt });
  assert.equal(client.server, 'https://expected.example'); assert.equal(client.deviceId, 'expected-device');
  fetchMock.mock.mockImplementation(async () => new Response('invalid JSON containing synthetic-password-reflection'));
  await assert.rejects(client.login({ username: 'owner', password, deviceId: 'expected-device' }), error => {
    assert.equal(error.message, 'Sync server returned invalid JSON'); assert.ok(!error.message.includes('synthetic-password-reflection')); return true;
  });
});
test('disposal during native credential commit waits, rolls back and leaves the previous grant usable', async t => {
  const f = await fixture(t), { server, client } = await f.login();
  const old = f.records.get(f.controller.credentialKey), before = await fs.readFile(f.service.filename, 'utf8');
  let committed, release;
  const admitted = new Promise(resolve => { committed = resolve; }), block = new Promise(resolve => { release = resolve; });
  const original = f.ctx.credentials.modifyRecord;
  f.ctx.credentials.modifyRecord = async (...args) => { await original(...args); committed(); await block; };
  const attempt = f.service.login({ server, username: 'owner', password });
  const rejected = assert.rejects(attempt, { name: 'AbortError' });
  await admitted; f.controller.stop();
  let drained = false; const drain = f.controller.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await rejected; await drain;
  assert.equal(f.records.get(f.controller.credentialKey).payload.token, old.payload.token);
  assert.equal(await fs.readFile(f.service.filename, 'utf8'), before);
  assert.equal((await client.list('still-authorized')).checkpoints.length, 0);
});

test('damaged owned grant origins cannot trap local logout', async t => {
  const f = await fixture(t); await f.login();
  const old = f.records.get(f.controller.credentialKey);
  f.records.set(f.controller.credentialKey, { ...old, payload: { ...old.payload, server: 'not-a-valid-origin' } });
  const result = await f.service.logout({});
  assert.equal(result.loggedIn, false); assert.equal(f.records.has(f.controller.credentialKey), false);
  assert.match(result.warning, /撤销未确认/);
});
test('a successful repaired login is not reported failed because old revocation is impossible', async t => {
  const f = await fixture(t), { server } = await f.login();
  const old = f.records.get(f.controller.credentialKey);
  f.records.set(f.controller.credentialKey, { ...old, payload: { ...old.payload, server: 'damaged-origin' } });
  const result = await f.service.login({ server, username: 'owner', password });
  assert.equal(result.loggedIn, true); assert.match(result.warning, /新登录已成功/);
  assert.notEqual(f.records.get(f.controller.credentialKey).payload.token, old.payload.token);
});

test('native RPC envelopes correlate replies and reject cross-method or malformed commands', async t => {
  const f = await fixture(t);
  for (const value of [
    { type: 'client-request', rpcId: 'rpc-a', method: 'dsh-personal-sync/login', payload: {} },
    { type: 'client-request', rpcId: '../bad', method: 'dsh-personal-sync/status', payload: {} },
    { type: 'client-request', rpcId: 'rpc-a', method: 'dsh-personal-sync/status', payload: {}, extra: true },
  ]) {
    const response = await f.bridge.fetch('status', nativeRequest('status', {}, { body: JSON.stringify(value) }));
    assert.equal(response.status, 400);
  }
  const bad = await rpc(f.bridge, 'preferences', { revision: 0, autoSync: false, projectIds: [], unexpectedPassword: 'synthetic-SECRET' });
  assert.equal(bad.response.status, 200); assert.equal(bad.result.ok, false); assert.equal(bad.result.error.code, 'BAD_REQUEST');
  assert.ok(!JSON.stringify(bad.body).includes('synthetic-SECRET'));
});
test('streaming routes enforce media type, declared/actual body sizes, invalid UTF-8 and timeout', async t => {
  const f = await fixture(t, { http: { bodyTimeoutMs: 30 } });
  const tooLong = await f.bridge.fetch('status', nativeRequest('status', {}, { headers: { 'content-type': 'application/json', 'content-length': String(MAX_SETTINGS_BODY + 1) } })); assert.equal(tooLong.status, 413);
  const chunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_SETTINGS_BODY + 1)); controller.close(); } });
  assert.equal((await f.bridge.fetch('status', nativeRequest('status', {}, { body: chunks, duplex: 'half' }))).status, 413);
  assert.equal((await f.bridge.fetch('status', nativeRequest('status', {}, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await f.bridge.fetch('status', nativeRequest('status', {}, { body: Buffer.from([0xff, 0xfe]) }))).status, 400);
  const hanging = new ReadableStream({});
  assert.equal((await f.bridge.fetch('status', nativeRequest('status', {}, { body: hanging, duplex: 'half' }))).status, 408);
});
test('HTTP bridge redacts arbitrary exceptions and clears password from parsed payload on settlement', async () => {
  let payload;
  const bridge = createSettingsHttp({ login: async value => { payload = value; throw new Error('do-not-leak-secret-token'); } });
  const { result, body } = await rpc(bridge, 'login', { server: 'https://example.test', username: 'owner', password: 'do-not-leak-password' });
  assert.equal(result.ok, false); assert.equal(payload.password, '');
  assert.ok(!JSON.stringify(body).includes('do-not-leak'));
});
test('production Client state, Host RPC and real HTTP cloud complete the settings-only workflow', async t => {
  const { createController: createUiController } = await import('../client/state.mjs');
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { exportSessions: async () => { entered(); return { sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }; } });
  const { server } = await f.login(); await f.service.logout({});
  const actions = [];
  const ui = createUiController({ rpc: { call: async (channel, endpoint, payload, signal) => {
    assert.equal(channel, '/api'); assert.ok(endpoint.startsWith('dsh-personal-sync/'));
    const action = endpoint.slice('dsh-personal-sync/'.length); actions.push(action);
    const response = await f.bridge.fetch(action, nativeRequest(action, payload, { signal }));
    assert.equal(response.status, 200); const envelope = await response.json(); return envelope.result;
  } } });
  t.after(() => ui.dispose());
  assert.equal(await ui.refresh(), true); assert.equal(ui.getSnapshot().status.loggedIn, false);
  assert.equal(await ui.login({ server, username: 'owner', password }), true);
  ui.setProject('workspace-a', true); assert.equal(await ui.savePreferences(), true);
  assert.equal(actions.includes('sync'), false, 'login/save must not upload');
  assert.equal(await ui.sync(), true); await started; await f.controller.drain(); await ui.refresh();
  const snapshot = ui.getSnapshot(); assert.equal(snapshot.status.pending, 0); assert.equal(snapshot.status.lastResult.ok, true);
  assert.deepEqual(snapshot.status.projects.filter(item => item.selected).map(item => item.id), ['workspace-a']);
  const client = new SyncClient(f.records.get(f.controller.credentialKey).payload);
  assert.equal((await client.list(snapshot.status.projects.find(item => item.selected).projectId)).checkpoints.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes(password));
  assert.equal(await ui.logout(), true); assert.equal(ui.getSnapshot().status.loggedIn, false);
});

test('exact streaming routes do not replace the native /api gateway or claim to implement admission', () => {
  const routes = [], bridge = createSettingsHttp({});
  registerSettingsRoutes({ connection: { fetch: { register: value => routes.push(value) } } }, bridge);
  assert.equal(routes.length, 6); assert.ok(routes.every(route => route.requestBody === 'streaming' && route.path.startsWith(SETTINGS_API)));
  assert.deepEqual(routes.find(route => route.path.endsWith('/status')).methods, ['POST']);
  assert.ok(routes.filter(route => !route.path.endsWith('/status')).every(route => route.methods.length === 1 && route.methods[0] === 'POST'));
});
