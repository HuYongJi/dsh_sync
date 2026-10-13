import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { SyncClient, validatePasswordChange } from '../src/client.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const oldPassword = 'synthetic-current-password-123';
const newPassword = 'synthetic-updated-password-456';
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'password-host-'));
  const controllers = [];
  const dshHome = path.join(root, 'home'), profileDir = path.join(dshHome, 'profiles', 'test'), project = path.join(root, 'project');
  await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(project); await fs.writeFile(path.join(project, 'hello.txt'), 'synthetic content');
  const cloud = await createSyncServer({ dataDir: path.join(root, 'cloud'), username: 'owner', password: oldPassword });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`;
  const records = new Map([['unrelated/provider', { kind: 'grant', payload: { token: 'unrelated synthetic grant' } }]]);
  const ctx = {
    workspaceRegistry: { list: () => [{ id: 'local-project', title: 'Example', path: project }], get: id => id === 'local-project' ? { id, path: project } : undefined },
    credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); },
      deleteRecord: async key => records.delete(key),
    },
  };
  function mount() {
    const controller = createController(ctx, { stateDir: path.join(profileDir, 'dsh-personal-sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
      exportSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }) });
    controllers.push(controller);
    const service = createSettingsService(ctx, controller, { profileDir, dshHome });
    return { controller, service, bridge: createSettingsHttp(service) };
  }
  const current = mount();
  t.after(async () => {
    for (const controller of controllers) controller.stop();
    await Promise.all(controllers.map(controller => controller.drain()));
    await closeSyncServer(cloud);
    assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('password-host-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await current.service.login({ server, username: 'owner', password: oldPassword });
  const initial = await current.service.status();
  await current.service.savePreferences({ revision: initial.revision, autoSync: true, projectIds: ['local-project'] });
  async function payload(patch = {}) {
    const status = await current.service.status();
    return { revision: status.revision, server: status.server, username: status.username, currentPassword: oldPassword, newPassword, ...patch };
  }
  async function markerNames() { return (await fs.readdir(current.controller.store.directory)).filter(name => /^reauth-.*\.json$/.test(name)); }
  return { root, dshHome, profileDir, project, cloud, server, records, ctx, mount, payload, markerNames, ...current };
}
async function rpc(bridge, action, payload) {
  const request = new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'password-rpc', method: `dsh-personal-sync/${action}`, payload }) });
  const response = await bridge.fetch(action, request);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()).result;
}
const capableHealth = () => Response.json({ ok: true }, { headers: { 'X-DSH-Sync-Password-Change': '1' } });

test('Host password change verifies current password, revokes every token and keeps project data', async t => {
  const f = await fixture(t), initial = await f.service.status();
  const id = initial.projects[0].projectId;
  await f.controller.push(id);
  const first = new SyncClient(f.records.get(f.controller.credentialKey).payload);
  const second = new SyncClient({ server: f.server }); await second.login({ username: 'owner', password: oldPassword, deviceId: 'other-device' });
  const reply = await rpc(f.bridge, 'password', await f.payload());
  assert.equal(reply.ok, true); assert.equal(reply.value.passwordChanged, true); assert.equal(reply.value.loggedIn, false); assert.equal(reply.value.autoSync, false);
  assert.equal(reply.value.projects[0].selected, true); assert.equal(f.records.has(f.controller.credentialKey), false);
  assert.equal(f.records.has('unrelated/provider'), true); assert.equal((await f.markerNames()).length, 1);
  await assert.rejects(first.list(id), { status: 401 }); await assert.rejects(second.list(id), { status: 401 });
  await assert.rejects(f.service.login({ server: f.server, username: 'owner', password: oldPassword }), { status: 401 });
  const loggedIn = await f.service.login({ server: f.server, username: 'owner', password: newPassword });
  assert.equal(loggedIn.loggedIn, true); assert.equal(loggedIn.autoSync, false); assert.deepEqual(await f.markerNames(), []);
  const fresh = new SyncClient(f.records.get(f.controller.credentialKey).payload); assert.equal((await fresh.list(id)).checkpoints.length, 1);
  const text = JSON.stringify(reply);
  assert.ok(!text.includes(oldPassword)); assert.ok(!text.includes(newPassword));
});
test('wrong current password preserves the current grant, preferences and automatic sync', async t => {
  const f = await fixture(t), before = await fs.readFile(f.service.filename, 'utf8');
  const token = f.records.get(f.controller.credentialKey).payload.token;
  const reply = await rpc(f.bridge, 'password', await f.payload({ currentPassword: 'wrong-current-password' }));
  assert.equal(reply.ok, false); assert.equal(reply.error.code, 'CURRENT_PASSWORD_INVALID');
  assert.equal(f.records.get(f.controller.credentialKey).payload.token, token);
  assert.equal(await fs.readFile(f.service.filename, 'utf8'), before); assert.deepEqual(await f.markerNames(), []);
  const after = await f.service.status(); assert.equal(after.loggedIn, true); assert.equal(after.autoSync, true);
});
test('password action rejects stale or substituted targets and invalid secrets before network', async t => {
  const f = await fixture(t), original = await f.payload();
  let calls = 0; f.cloud.on('request', () => calls++);
  for (const input of [
    { ...original, server: 'https://unexpected.invalid' }, { ...original, username: 'another' },
    { ...original, revision: original.revision - 1 }, { ...original, token: 'token is not password authentication' },
    { ...original, currentPassword: '' }, { ...original, newPassword: 'short' },
    { ...original, newPassword: oldPassword }, { ...original, confirmPassword: newPassword },
  ]) await assert.rejects(f.service.password(input));
  for (const next of ['a'.repeat(7), '界'.repeat(7), '😀'.repeat(7)]) {
    const reply = await rpc(f.bridge, 'password', { ...original, newPassword: next });
    assert.equal(reply.ok, false);
    assert.deepEqual(reply.error, { code: 'PASSWORD_TOO_WEAK', message: '新密码至少8位，最多1024字节', details: {} });
  }
  assert.equal(calls, 0); assert.equal((await f.service.status()).loggedIn, true); assert.deepEqual(await f.markerNames(), []);
});
test('current-password authentication works with an expired local token and sends no bearer', async t => {
  const f = await fixture(t), grant = f.records.get(f.controller.credentialKey);
  grant.payload.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await f.service.status()).loggedIn, false);
  let authorization = 'unobserved'; f.cloud.on('request', req => { if (req.url === '/v1/password') authorization = req.headers.authorization; });
  const result = await f.service.password(await f.payload());
  assert.equal(result.passwordChanged, true); assert.equal(authorization, undefined);
});
test('old-server capability check rejects without sending passwords or removing login', async t => {
  const f = await fixture(t), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options }); assert.ok(String(url).endsWith('/health'));
    assert.equal(options.body, undefined); assert.equal(options.headers.Authorization, undefined);
    return Response.json({ ok: true });
  });
  const reply = await rpc(f.bridge, 'password', await f.payload());
  assert.equal(reply.error.code, 'PASSWORD_CHANGE_UNSUPPORTED'); assert.equal(requests.length, 1);
  assert.equal((await f.service.status()).loggedIn, true); assert.deepEqual(await f.markerNames(), []);
});
test('read-only capability network failures are definitive and preserve the current login', async t => {
  const f = await fixture(t); t.mock.method(globalThis, 'fetch', async () => { throw new Error('untrusted secret echo'); });
  await assert.rejects(f.service.password(await f.payload()), { code: 'SERVER_UNREACHABLE', definitive: true });
  assert.equal((await f.service.status()).loggedIn, true); assert.deepEqual(await f.markerNames(), []);
});
test('local response validation and every 5xx are uncertain, not HTTP password rejections', async t => {
  const client = new SyncClient({ server: 'https://synthetic.invalid', token: 'x'.repeat(43) });
  const mock = t.mock.method(globalThis, 'fetch');
  const cases = [
    () => new Response('x'.repeat(2048), { status: 200 }),
    () => new Response('{"changed":true}', { status: 200, headers: { 'content-length': 'not-a-length' } }),
    () => new Response('x'.repeat(17000), { status: 500 }),
    () => Response.json({ error: 'not implemented' }, { status: 501 }),
    () => new Response(`invalid-json-${newPassword}`, { status: 200 }),
    () => Response.json({ changed: false }),
  ];
  for (const result of cases) {
    mock.mock.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/health')) return capableHealth();
      assert.equal(options.headers.Authorization, undefined); return result();
    });
    await assert.rejects(client.changePassword({ username: 'owner', currentPassword: oldPassword, newPassword }), error => {
      assert.equal(error.code, 'PASSWORD_CHANGE_UNCERTAIN'); assert.equal(error.definitive, false);
      assert.ok(!error.message.includes(newPassword)); return true;
    });
  }
});
test('a committed change with damaged acknowledgement keeps durable reauth across restart', async t => {
  const f = await fixture(t), realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).endsWith('/v1/password') && response.ok) { await response.arrayBuffer(); return new Response('x'.repeat(2048)); }
    return response;
  });
  await assert.rejects(f.service.password(await f.payload()), { code: 'PASSWORD_CHANGE_UNCERTAIN' });
  const another = f.mount(); const status = await another.service.status();
  assert.equal(status.loggedIn, false); assert.equal(status.autoSync, false); assert.equal((await f.markerNames()).length, 1);
  await assert.rejects(another.controller.push(status.projects[0].projectId), { code: 'NOT_LOGGED_IN' });
  await assert.rejects(another.service.login({ server: f.server, username: 'owner', password: oldPassword }), { status: 401 });
  assert.equal((await another.service.login({ server: f.server, username: 'owner', password: newPassword })).loggedIn, true);
  assert.deepEqual(await f.markerNames(), []);
});
test('a preexisting uncertain intent survives a subsequent wrong-current-password rejection', async t => {
  const f = await fixture(t);
  const mocked = t.mock.method(globalThis, 'fetch', async url => String(url).endsWith('/health') ? capableHealth() : Response.json({ error: 'unknown' }, { status: 500 }));
  await assert.rejects(f.service.password(await f.payload()), { code: 'PASSWORD_CHANGE_UNCERTAIN' }); mocked.mock.restore();
  await assert.rejects(f.service.password(await f.payload({ currentPassword: 'wrong' })), { code: 'CURRENT_PASSWORD_INVALID' });
  assert.equal((await f.markerNames()).length, 1); assert.equal((await f.service.status()).loggedIn, false);
  // The simulated 500 did not touch the real cloud; fresh authentication resolves the intent.
  assert.equal((await f.service.login({ server: f.server, username: 'owner', password: oldPassword })).loggedIn, true);
  assert.deepEqual(await f.markerNames(), []);
});
test('local cleanup failures do not reverse or misreport a confirmed cloud password change', async t => {
  const f = await fixture(t), originalSave = f.controller.store.saveConfig.bind(f.controller.store);
  t.mock.method(f.ctx.credentials, 'deleteRecord', async () => { throw new Error('synthetic readonly native store'); });
  t.mock.method(f.controller.store, 'saveConfig', async value => { if (value.reauthRequired) throw new Error('synthetic readonly config'); return originalSave(value); });
  const result = await f.service.password(await f.payload());
  assert.equal(result.passwordChanged, true); assert.equal(result.loggedIn, false); assert.equal(result.autoSync, false); assert.match(result.warning, /本机清理未完成/);
  assert.equal((await f.mount().service.status()).loggedIn, false);
  assert.equal((await f.service.login({ server: f.server, username: 'owner', password: newPassword })).loggedIn, true);
});
test('lock cleanup cannot overwrite confirmed password success with a misleading failure', async t => {
  const f = await fixture(t), unlink = fs.unlink.bind(fs), lock = path.join(f.controller.store.directory, 'operation.lock');
  const mock = t.mock.method(fs, 'unlink', async filename => { if (filename === lock) throw Object.assign(new Error('synthetic lock cleanup failure'), { code: 'EACCES' }); return unlink(filename); });
  const result = await f.service.password(await f.payload());
  assert.equal(result.passwordChanged, true); assert.equal(result.loggedIn, false); assert.match(result.warning, /本机清理未完成/);
  mock.mock.restore();
  assert.equal(path.dirname(lock), f.controller.store.directory); assert.ok(lock.startsWith(f.root + path.sep));
  await fs.unlink(lock); // Our now-idle fixture lock only, verified above.
  assert.equal((await f.service.login({ server: f.server, username: 'owner', password: newPassword })).loggedIn, true);
});
test('failure to persist the no-secret intent prevents all remote requests', async t => {
  const f = await fixture(t), rename = fs.rename.bind(fs); let requests = 0;
  f.cloud.on('request', () => requests++);
  t.mock.method(fs, 'rename', async (from, to) => { if (path.basename(to).startsWith('reauth-')) throw Object.assign(new Error('synthetic write denial'), { code: 'EACCES' }); return rename(from, to); });
  await assert.rejects(f.service.password(await f.payload()), { code: 'EACCES' });
  assert.equal(requests, 0); assert.equal((await f.service.status()).loggedIn, true);
});
test('all persisted local password-change metadata excludes current/new passwords and tokens', async t => {
  const f = await fixture(t), token = f.records.get(f.controller.credentialKey).payload.token;
  const result = await f.service.password(await f.payload());
  for (const filename of (await fs.readdir(f.controller.store.directory)).filter(name => name.endsWith('.json'))) {
    const text = await fs.readFile(path.join(f.controller.store.directory, filename), 'utf8');
    assert.ok(!text.includes(oldPassword)); assert.ok(!text.includes(newPassword)); assert.ok(!text.includes(token));
  }
  assert.ok(!JSON.stringify(result).includes(token));
});
test('Host RPC clears every password field on success and failure without echoing exceptions', async () => {
  let captured;
  const bridge = createSettingsHttp({ password: async body => { captured = body; throw new Error('reflected-private-value'); } });
  const result = await rpc(bridge, 'password', { revision: 0, server: 'https://example.test', username: 'owner', currentPassword: oldPassword, newPassword, confirmPassword: newPassword });
  assert.equal(result.ok, false); assert.equal(captured.currentPassword, ''); assert.equal(captured.newPassword, ''); assert.equal(captured.confirmPassword, '');
  assert.ok(!JSON.stringify(result).includes('reflected-private-value'));
});
test('Host password validation enforces an 8-codepoint minimum and the 1024-byte UTF-8 ceiling', () => {
  const sevenEmoji = '😀'.repeat(7);
  assert.equal(sevenEmoji.length, 14);
  assert.equal([...sevenEmoji].length, 7);
  for (const next of ['a'.repeat(8), '界'.repeat(8), '😀'.repeat(8), ' '.repeat(8), 'a'.repeat(1024), '😀'.repeat(256)]) {
    const input = { username: 'owner', currentPassword: oldPassword, newPassword: next };
    assert.deepEqual(validatePasswordChange(input), input);
  }
  for (const next of ['a'.repeat(7), '界'.repeat(7), sevenEmoji, '', null]) {
    assert.throws(() => validatePasswordChange({ username: 'owner', currentPassword: oldPassword, newPassword: next }), { code: 'PASSWORD_TOO_WEAK' });
  }
  for (const next of ['a'.repeat(1025), '界'.repeat(342), '😀'.repeat(257)]) {
    assert.throws(() => validatePasswordChange({ username: 'owner', currentPassword: oldPassword, newPassword: next }), { code: 'PASSWORD_TOO_WEAK' });
  }
});
test('Host password validation rejects UTF-8-equivalent secrets and does not trim spaces', () => {
  const equivalent = 'x'.repeat(16);
  assert.throws(() => validatePasswordChange({ username: 'owner', currentPassword: equivalent + '\ud800', newPassword: equivalent + '\ufffd' }), { code: 'PASSWORD_UNCHANGED' });
  const input = { username: 'owner', currentPassword: ' ' + oldPassword, newPassword: newPassword + ' ' };
  assert.deepEqual(validatePasswordChange(input), input);
});
test('production Client controller completes 8-codepoint changes through Host RPC and the loopback cloud', async t => {
  const { createController: createUiController } = await import('../client/state.mjs');
  for (const [label, minimumPassword] of [['ASCII', 'Abcd123!'], ['Unicode', '🔐'.repeat(8)]]) {
    await t.test(label, async t => {
      assert.equal([...minimumPassword].length, 8);
      const f = await fixture(t), initial = await f.service.status();
      const id = initial.projects[0].projectId;
      const first = new SyncClient(f.records.get(f.controller.credentialKey).payload);
      const second = new SyncClient({ server: f.server });
      await second.login({ username: 'owner', password: oldPassword, deviceId: 'other-device' });
      const ui = createUiController({ rpc: { call: async (channel, method, payload, signal) => {
        assert.equal(channel, '/api'); const action = method.slice('dsh-personal-sync/'.length);
        const response = await f.bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'flow', method, payload }) }));
        return (await response.json()).result;
      } } });
      t.after(() => ui.dispose());
      await ui.refresh(); const status = ui.getSnapshot().status;
      assert.equal(await ui.changePassword({ revision: status.revision, server: status.server, username: status.username }, { currentPassword: oldPassword, newPassword: minimumPassword, confirmPassword: minimumPassword }), true);
      assert.equal(ui.getSnapshot().status.loggedIn, false); assert.equal(Object.hasOwn(ui.getSnapshot().status, 'autoSync'), false);
      assert.match(ui.getSnapshot().notice, /密码已修改/); assert.ok(!JSON.stringify(ui.getSnapshot()).includes(minimumPassword));
      await assert.rejects(first.list(id), { status: 401 }); await assert.rejects(second.list(id), { status: 401 });
      assert.equal(await ui.login({ server: f.server, username: 'owner', password: oldPassword }), false);
      assert.equal(ui.getSnapshot().status.loggedIn, false);
      assert.equal(await ui.login({ server: f.server, username: 'owner', password: minimumPassword }), true);
      assert.equal(ui.getSnapshot().status.loggedIn, true); assert.equal(Object.hasOwn(ui.getSnapshot().status, 'autoSync'), false);
      const fresh = new SyncClient(f.records.get(f.controller.credentialKey).payload);
      assert.deepEqual((await fresh.list(id)).checkpoints, []);
    });
  }
});
