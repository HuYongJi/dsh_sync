import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { SyncClient } from '../src/client.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';

const BASE = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const PASSWORD = 'synthetic-renewal-password-42';
const USERNAME = 'renewal-owner';
const KEY = 'dsh-personal-sync/account-renewal';
const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => Promise.withResolvers();
function nativeCredentials() {
  const records = new Map(); let tail = Promise.resolve();
  function exclusive(action) { const result = tail.then(action); tail = result.catch(() => {}); return result; }
  const native = {
    records, beforeCallback: undefined, beforeSave: undefined, afterSave: undefined, reads: 0, writes: 0,
    async readRecord(key) { native.reads++; return clone(records.get(key)); },
    modifyRecord(key, callback) {
      return exclusive(async () => {
        await native.beforeCallback?.();
        const previous = clone(records.get(key));
        const next = await callback(previous);
        if (next !== undefined) {
          await native.beforeSave?.(next, previous);
          records.set(key, clone(next)); native.writes++;
          await native.afterSave?.(next, previous);
        }
      });
    },
    deleteRecord(key) { return exclusive(async () => { records.delete(key); }); },
  };
  return native;
}
async function fixture(t, options = {}) {
  await fs.mkdir(BASE, { recursive: true });
  const root = await fs.mkdtemp(path.join(BASE, 'renewal-host-'));
  const project = path.join(root, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'synthetic renewal fixture');
  const cloud = await createSyncServer({ dataDir: path.join(root, 'cloud'), username: USERNAME, password: PASSWORD, loginMaxAttempts: 1000, ...options.server });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`;
  const credentials = nativeCredentials(), controllers = [], requests = [];
  cloud.on('request', req => requests.push({ method: req.method, route: req.url }));
  const ctx = { credentials };
  function mount(directory = path.join(root, 'state'), config = {}) {
    const controller = createController(ctx, { stateDir: directory, projects: [{ id: 'project', root: project }], ...config }, {
      credentialKey: KEY, allowLegacyCli: false,
      exportSessions: options.exportSessions || (async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} })),
    });
    controllers.push(controller); return controller;
  }
  const controller = mount();
  t.after(async () => {
    for (const item of controllers) item.stop();
    await Promise.all(controllers.map(item => item.drain()));
    await closeSyncServer(cloud);
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(BASE)); assert.match(path.basename(resolved), /^renewal-host-[A-Za-z0-9]+$/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return {
    root, project, server, cloud, ctx, credentials, requests, controller, mount,
    grant() { return clone(credentials.records.get(KEY)?.payload); },
    login(remember = true, target = controller) { return target.login({ server, username: USERNAME, password: PASSWORD, ...(remember === undefined ? {} : { remember }) }); },
    async due(target = controller, milliseconds = 60_000) {
      await credentials.modifyRecord(KEY, async current => ({ ...current, payload: { ...current.payload, expiresAt: new Date(Date.now() + milliseconds).toISOString() } }));
      return target.syncAccount();
    },
    async markers(target = controller) { return (await fs.readdir(target.store.directory)).filter(name => /^reauth-[a-f0-9]+\.json$/.test(name)); },
    refreshCount() { return requests.filter(item => item.route === '/v2/refresh').length; },
  };
}
async function noSecretsOnDisk(f, secrets) {
  for (const name of await fs.readdir(f.controller.store.directory)) {
    if (!name.endsWith('.json')) continue;
    const text = await fs.readFile(path.join(f.controller.store.directory, name), 'utf8');
    for (const value of secrets) assert.equal(text.includes(value), false, `${name} must not contain credentials`);
  }
}

test('omitted/false remember preserves v1 login and legacy native records default to epoch zero', async t => {
  const f = await fixture(t);
  await f.controller.login({ server: f.server, username: USERNAME, password: PASSWORD });
  assert.deepEqual(f.requests.map(item => item.route), ['/v1/login']);
  assert.equal(f.grant().refreshToken, undefined); assert.equal(f.grant().authorizationEpoch, 1);
  assert.equal((await f.controller.status()).authState, 'legacy');
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'not-renewable' });
  const stored = f.credentials.records.get(KEY); delete stored.payload.authorizationEpoch;
  const local = await f.controller.store.config(); delete local.authorizationEpoch; await f.controller.store.saveConfig(local);
  assert.equal((await f.controller.syncAccount()).authorizationEpoch, 0);
  assert.equal((await f.controller.syncAccount()).authEpoch, 0);
  await f.login(false);
  assert.equal(f.grant().authorizationEpoch, 1);
  assert.equal(f.requests.some(item => item.route === '/v2/login' || item.route === '/health'), false);
});

test('remember login probes v2 first and persists credentials only in native storage', async t => {
  const f = await fixture(t), reply = await f.login();
  const grant = f.grant(), identity = await f.controller.syncAccount();
  assert.deepEqual(f.requests.map(item => item.route), ['/health', '/v2/login']);
  for (const field of ['token', 'refreshToken', 'familyId', 'serverId']) assert.equal(typeof grant[field], 'string');
  assert.equal(grant.authorizationEpoch, 1); assert.equal(identity.authorizationEpoch, 1); assert.equal(identity.authEpoch, 1);
  assert.equal(Object.isFrozen(identity), true);
  assert.deepEqual(await f.controller.store.config(), { server: f.server, username: USERNAME, deviceId: grant.deviceId, authorizationEpoch: 1 });
  const status = await f.controller.status(); assert.equal(status.authState, 'renewable'); assert.equal(status.loggedIn, true);
  for (const output of [reply, status]) {
    for (const key of ['token', 'refreshToken', 'familyId', 'serverId', 'authorizationEpoch', 'authEpoch', 'refreshExpiresAt', 'absoluteExpiresAt']) assert.equal(Object.hasOwn(output, key), false);
    for (const secret of [PASSWORD, grant.token, grant.refreshToken]) assert.equal(JSON.stringify(output).includes(secret), false);
  }
  await noSecretsOnDisk(f, [PASSWORD, grant.token, grant.refreshToken, grant.familyId]);
});

test('unsupported remembered login fails explicit upgrade before sending a password and retains existing grant', async t => {
  const f = await fixture(t); await f.login(false);
  const before = f.grant(), local = await f.controller.store.config(), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url)); assert.equal(options.body, undefined); return Response.json({ ok: true });
  });
  await assert.rejects(f.login(), { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' });
  assert.deepEqual(calls, [`${f.server}/health`]); assert.deepEqual(f.grant(), before);
  assert.deepEqual(await f.controller.store.config(), local);
  for (const remember of [null, 1, 'true']) await assert.rejects(f.controller.login({ server: f.server, username: USERNAME, password: PASSWORD, remember }));
  assert.equal(calls.length, 1);
});

test('status and syncAccount never renew or make a network request; renewal rotates in place only near expiry', async t => {
  const f = await fixture(t); await f.login();
  const first = f.grant(), beforeRequests = f.requests.length;
  await f.controller.status(); await f.controller.syncAccount();
  assert.equal(f.requests.length, beforeRequests);
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'not-due' });
  await f.due();
  const dueRequests = f.requests.length;
  await f.controller.status(); await f.controller.syncAccount();
  assert.equal(f.requests.length, dueRequests);
  const reply = await f.controller.renewAuthorization(), next = f.grant();
  assert.equal(reply.renewed, true); assert.equal(reply.expiresAt, next.expiresAt); assert.equal(f.refreshCount(), 1);
  assert.notEqual(next.token, first.token); assert.notEqual(next.refreshToken, first.refreshToken);
  for (const key of ['familyId', 'serverId', 'server', 'username', 'deviceId', 'authorizationEpoch', 'absoluteExpiresAt']) assert.equal(next[key], first[key]);
  assert.deepEqual(await f.markers(), []); assert.equal((await f.controller.store.config()).authorizationEpoch, 1);
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'not-due' });
  await assert.rejects(new SyncClient(first).list('project'), { status: 401 });
  assert.deepEqual((await new SyncClient(next).list('project')).checkpoints, []);
  await noSecretsOnDisk(f, [PASSWORD, first.token, first.refreshToken, next.token, next.refreshToken]);
});

test('renewal works after access expiry but expired refresh/absolute grants pause without network', async t => {
  const f = await fixture(t); await f.login();
  await f.due(f.controller, -1000);
  assert.equal((await f.controller.status()).loggedIn, false);
  assert.equal((await f.controller.renewAuthorization()).renewed, true);
  const prior = f.grant();
  await f.credentials.modifyRecord(KEY, async current => ({ ...current, payload: { ...current.payload,
    expiresAt: '2000-01-01T00:00:00.000Z', refreshExpiresAt: '2000-01-02T00:00:00.000Z', absoluteExpiresAt: '2000-01-03T00:00:00.000Z' } }));
  const requests = f.refreshCount();
  await assert.rejects(f.controller.renewAuthorization(), { code: 'NOT_LOGGED_IN', status: 401 });
  assert.equal(f.refreshCount(), requests); assert.equal((await f.markers()).length, 1);
  assert.equal((await f.controller.status()).reauthRequired, true);
  assert.equal(f.grant().token, prior.token);
});

test('native modifyRecord rereads the latest grant under one shared lock instead of double refreshing', async t => {
  const f = await fixture(t); await f.login(); await f.due();
  const second = f.mount(path.join(f.root, 'second-state'), { server: f.server, username: USERNAME });
  await second.store.init(); await second.store.saveConfig(await f.controller.store.config());
  const entered = deferred(), release = deferred(), secondQueued = deferred(); let callbacks = 0;
  f.credentials.beforeCallback = async () => { if (++callbacks === 1) { entered.resolve(); await release.promise; } };
  t.after(() => release.resolve());
  const original = f.credentials.modifyRecord;
  f.credentials.modifyRecord = (key, fn) => { if (callbacks === 1) secondQueued.resolve(); return original(key, fn); };
  const one = f.controller.renewAuthorization(); await entered.promise;
  const two = second.renewAuthorization(); await secondQueued.promise;
  release.resolve();
  const results = await Promise.all([one, two]);
  assert.equal(results.filter(item => item.renewed).length, 1);
  assert.equal(results.find(item => !item.renewed).reason, 'already-renewed');
  assert.equal(f.refreshCount(), 1); assert.equal(f.grant().authorizationEpoch, 1);
  assert.equal((await second.syncAccount()).token, f.grant().token);
});

test('unknown remote rotation acknowledgement pauses durably, never replays, and requires explicit new login', async t => {
  const f = await fixture(t); await f.login(); await f.due();
  const before = f.grant(), realFetch = globalThis.fetch;
  const mocked = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).endsWith('/v2/refresh')) { await response.arrayBuffer(); return new Response('synthetic malformed acknowledgement'); }
    return response;
  });
  await assert.rejects(f.controller.renewAuthorization(), { code: 'AUTH_RENEWAL_UNCERTAIN' });
  assert.equal(f.refreshCount(), 1); assert.equal(f.grant().token, before.token);
  assert.equal((await f.controller.status()).reauthRequired, true);
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'reauth-required' });
  assert.equal(f.refreshCount(), 1);
  const restart = f.mount(); assert.equal((await restart.status()).authState, 'reauth-required');
  await assert.rejects(restart.syncAccount(), { code: 'NOT_LOGGED_IN' });
  await noSecretsOnDisk(f, [PASSWORD, before.token, before.refreshToken]);
  mocked.mock.restore();
  await f.login(true, restart);
  assert.equal(f.grant().authorizationEpoch, 2); assert.notEqual(f.grant().familyId, before.familyId);
  assert.deepEqual(await f.markers(restart), []); assert.equal((await restart.status()).loggedIn, true);
});

test('a rotated response cannot extend absolute lifetime or substitute the remembered server or family', async t => {
  const realFetch = globalThis.fetch;
  for (const field of ['absoluteExpiresAt', 'serverId', 'familyId']) {
    const f = await fixture(t); await f.login(); await f.due(); const before = f.grant();
    const mocked = t.mock.method(globalThis, 'fetch', async (url, options) => {
      const response = await realFetch(url, options);
      if (!String(url).endsWith('/v2/refresh')) return response;
      const body = await response.json();
      body[field] = field === 'absoluteExpiresAt' ? new Date(Date.parse(body.absoluteExpiresAt) + 1).toISOString() : field === 'serverId' ? 'substituted-server' : Buffer.alloc(32, 99).toString('base64url');
      return Response.json(body);
    });
    await assert.rejects(f.controller.renewAuthorization(), { code: 'AUTH_RENEWAL_UNCERTAIN' });
    assert.deepEqual(f.grant(), before); assert.equal((await f.controller.status()).reauthRequired, true);
    assert.equal(f.refreshCount(), 1); mocked.mock.restore();
  }
});

test('native save failure before or after commit retains durable renewal intent without restoring old credentials', async t => {
  for (const afterCommit of [false, true]) {
    const f = await fixture(t); await f.login(); await f.due(); const before = f.grant();
    const hook = async () => { throw new Error(`untrusted native secret ${before.refreshToken}`); };
    f.credentials[afterCommit ? 'afterSave' : 'beforeSave'] = hook;
    await assert.rejects(f.controller.renewAuthorization(), error => {
      assert.equal(error.code, 'AUTH_RENEWAL_UNCERTAIN'); assert.equal(String(error.stack).includes(before.refreshToken), false); return true;
    });
    assert.equal(f.refreshCount(), 1); assert.equal((await f.controller.status()).loggedIn, false);
    assert.equal((await f.markers()).length, 1);
    assert.equal(f.grant().token === before.token, !afterCommit);
    assert.equal((await f.controller.store.config()).reauthRequired, true);
    f.credentials.beforeSave = undefined; f.credentials.afterSave = undefined;
    assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'reauth-required' });
    const restarted = f.mount(); await assert.rejects(restarted.syncAccount(), { code: 'NOT_LOGGED_IN' });
  }
});

test('failure to persist renewal intent prevents sending any refresh proof', async t => {
  const f = await fixture(t); await f.login(); await f.due();
  const realRename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (path.dirname(target) === f.controller.store.directory && path.basename(target).startsWith('reauth-')) throw new Error('synthetic marker write failure');
    return realRename(source, target);
  });
  const before = f.grant();
  await assert.rejects(f.controller.renewAuthorization(), { code: 'SETTINGS_FAILED' });
  assert.equal(f.refreshCount(), 0); assert.deepEqual(f.grant(), before);
  assert.equal((await f.controller.status()).loggedIn, true);
});

test('confirmed refresh 401 uses a safe typed reason and permanently pauses the revoked native grant', async t => {
  const f = await fixture(t); await f.login(); await f.due(); const grant = f.grant();
  await new SyncV2Client(grant).revokeGrant(grant);
  await assert.rejects(f.controller.renewAuthorization(), { code: 'NOT_LOGGED_IN', status: 401, httpStatus: 401, message: '登录已失效，请重新登录' });
  assert.equal((await f.controller.status()).reauthRequired, true);
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'reauth-required' });
  assert.equal(f.refreshCount(), 1);
});

test('explicit relogin and logout advance authorization epoch while family rotation never does', async t => {
  const f = await fixture(t); await f.login(); const first = f.grant();
  await f.login(); const second = f.grant();
  assert.equal(second.authorizationEpoch, 2); assert.notEqual(second.familyId, first.familyId);
  await assert.rejects(new SyncV2Client(first).refreshGrant(first), { status: 401 });
  await f.due(); await f.controller.renewAuthorization(); assert.equal(f.grant().authorizationEpoch, 2);
  const current = f.grant(); await f.due(f.controller, -1000);
  const loggedOut = await f.controller.logout();
  assert.equal(loggedOut.loggedOut, true); assert.equal(loggedOut.remoteRevoked, true);
  assert.equal(f.credentials.records.has(KEY), false); assert.equal((await f.controller.store.config()).authorizationEpoch, 3);
  await assert.rejects(new SyncV2Client(current).refreshGrant(current), { status: 401 });
  await f.login(); assert.equal(f.grant().authorizationEpoch, 4);
});

test('completed same-login recovery results survive rotation but cannot survive a manual new family', async t => {
  const f = await fixture(t); await f.login(); await f.controller.push('project');
  const checkpointId = (await new SyncClient(f.grant()).list('project')).heads[0];
  const input = { projectId: 'project', checkpointId, destination: path.join(f.root, 'restored'), requestId: 'synthetic-restore' };
  await f.controller.startRecovery('restore', input, { checkBinding: async () => {}, admitDestination: async () => {} });
  await f.controller.drain();
  const before = (await f.controller.status()).recovery; assert.equal(before.state, 'succeeded');
  await f.due(); await f.controller.renewAuthorization();
  assert.deepEqual((await f.controller.status()).recovery, before);
  assert.deepEqual((await f.controller.startRecovery('restore', input, { checkBinding: async () => {}, admitDestination: async () => {} })).recovery, before);
  await f.login(); assert.equal((await f.controller.status()).recovery, undefined);
  await assert.rejects(f.controller.startRecovery('restore', input, { checkBinding: async () => {}, admitDestination: async () => {} }), { code: 'RECOVERY_UNAVAILABLE' });
});

test('active Host sync defers renewal, reserves running state, and does not borrow legacy root permission', async t => {
  const f = await fixture(t); await f.login(); await f.due();
  f.controller.setRootAdmission(() => { assert.fail('bidirectional admission must not call legacy root authorization'); });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  let checks = 0, effects = 0;
  const operation = f.controller.runSyncOperation(async ({ identity, signal, check }) => {
    assert.equal(identity.token, f.grant().token); assert.equal(signal.aborted, false); entered.resolve();
    await release.promise; await check(); effects++; return { done: true };
  }, { checkBinding: async () => { checks++; } });
  await entered.promise;
  assert.equal((await f.controller.status()).running, true);
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'busy' });
  assert.equal(f.refreshCount(), 0);
  await assert.rejects(f.controller.runSyncOperation(async () => {}), { code: 'BUSY' });
  await assert.rejects(f.controller.runUpdate(async () => {}), { code: 'BUSY' });
  release.resolve(); assert.deepEqual(await operation, { done: true });
  assert.equal(effects, 1); assert.ok(checks >= 3); assert.equal((await f.controller.status()).running, false);
  assert.equal((await f.controller.renewAuthorization()).renewed, true);
});

test('logout aborts and drains an active Host sync, rechecks after awaited binding and forbids late effects', async t => {
  const f = await fixture(t); await f.login();
  const inside = deferred(), release = deferred(), aborted = deferred(); t.after(() => release.resolve());
  let calls = 0, effects = 0, loggedOut = false;
  const operation = f.controller.runSyncOperation(async ({ signal, check }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await check(); effects++;
  }, { checkBinding: async () => { if (++calls === 2) { inside.resolve(); await release.promise; } } });
  const denied = assert.rejects(operation, { name: 'AbortError' });
  await inside.promise;
  const logout = f.controller.logout().then(value => { loggedOut = true; return value; });
  await aborted.promise; assert.equal(loggedOut, false);
  release.resolve(); await denied; await logout;
  assert.equal(effects, 0); assert.equal(loggedOut, true); assert.equal((await f.controller.status()).running, false);
  assert.equal((await f.controller.store.config()).authorizationEpoch, 2);
});

test('an external token rotation cannot replace the active operation proof even within the same family', async t => {
  const f = await fixture(t); await f.login();
  const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let effects = 0;
  const operation = f.controller.runSyncOperation(async ({ check }) => { entered.resolve(); await release.promise; await check(); effects++; });
  const denied = assert.rejects(operation, { code: 'ACCOUNT_MISMATCH' }); await entered.promise;
  const old = f.grant(), rotated = await new SyncV2Client(old).refreshGrant(old);
  await f.credentials.modifyRecord(KEY, async current => ({ kind: 'grant', payload: { ...current.payload, ...rotated } }));
  release.resolve(); await denied;
  assert.equal(effects, 0); assert.equal(f.grant().familyId, old.familyId); assert.equal(f.grant().authorizationEpoch, old.authorizationEpoch);
});

test('Host operation checks proof expiry, account binding and updates before any effect', async t => {
  const f = await fixture(t); await f.login(); let effects = 0;
  await assert.rejects(f.controller.runSyncOperation(async () => { effects++; }, { checkBinding: async () => { throw Object.assign(new Error('synthetic binding changed'), { code: 'CONFIG_CONFLICT' }); } }), { code: 'CONFIG_CONFLICT' });
  await f.due(f.controller, -1000);
  await assert.rejects(f.controller.runSyncOperation(async () => { effects++; }), { code: 'NOT_LOGGED_IN' });
  assert.equal(effects, 0);
  await f.controller.runUpdate(async lease => { lease.begin(); lease.settled(); });
  await assert.rejects(f.controller.syncAccount(), { code: 'UPDATE_RESTART_REQUIRED' });
  await assert.rejects(f.controller.runSyncOperation(async () => { effects++; }), { code: 'UPDATE_RESTART_REQUIRED' });
  assert.deepEqual(await f.controller.renewAuthorization(), { renewed: false, reason: 'busy' });
  assert.equal(f.refreshCount(), 0); assert.equal(effects, 0);
  assert.equal((await f.controller.logout()).loggedOut, true, 'logout remains available after update barrier');
});

test('Host operation caller cancellation and disposal drain work without returning a stale success', async t => {
  for (const dispose of [false, true]) {
    const f = await fixture(t); await f.login();
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const abort = new AbortController(); let captured;
    const operation = f.controller.runSyncOperation(async ({ signal }) => { captured = signal; entered.resolve(); await release.promise; return 'late success'; }, { signal: abort.signal });
    const denied = assert.rejects(operation, { name: 'AbortError' }); await entered.promise;
    if (dispose) f.controller.stop(); else abort.abort();
    assert.equal(captured.aborted, true);
    release.resolve(); await denied; await f.controller.drain();
  }
});

test('confirmed remote401 is safely typed and Host-only reauthentication hook durably pauses the exact grant', async t => {
  const f = await fixture(t); await f.login(); const old = await f.controller.syncAccount();
  await f.due(); await f.controller.renewAuthorization();
  assert.deepEqual(await f.controller.requireSyncReauthentication({ expectedIdentity: old }), { reauthRequired: false });
  assert.deepEqual(await f.markers(), []);
  await assert.rejects(f.controller.runSyncOperation(async () => { throw Object.assign(new Error(`unsafe ${f.grant().refreshToken}`), { httpStatus: 401 }); }), { code: 'NOT_LOGGED_IN', status: 401, message: '登录已失效，请重新登录' });
  await assert.rejects(f.controller.runSyncOperation(async ({ identity }) => {
    assert.deepEqual(await f.controller.requireSyncReauthentication({ expectedIdentity: identity }), { reauthRequired: true });
  }), { code: 'NOT_LOGGED_IN' });
  const paused = await f.controller.status(); assert.equal(paused.authState, 'reauth-required'); assert.equal(paused.autoSync, false);
  assert.equal((await f.mount().status()).reauthRequired, true);
  assert.equal(f.grant().authorizationEpoch, 1); assert.equal(f.credentials.records.has(KEY), true);
  await noSecretsOnDisk(f, [PASSWORD, f.grant().token, f.grant().refreshToken]);
});

test('additional identity admission protects both GUI login and native secret prompting', async t => {
  const f = await fixture(t), calls = [];
  f.controller.replaceConfiguration({ server: f.server, username: USERNAME });
  f.controller.setAdditionalIdentityAdmission(async value => { calls.push(value); throw Object.assign(new Error('v2 history belongs to another identity'), { code: 'ACCOUNT_BOUND' }); });
  await assert.rejects(f.login(), { code: 'ACCOUNT_BOUND' });
  const signal = new AbortController().signal;
  await assert.rejects(f.controller.authorize({ signal, prompt() { assert.fail('No secret prompt before history admission'); }, commit() { assert.fail(); } }), { code: 'ACCOUNT_BOUND' });
  assert.equal(f.requests.length, 0); assert.equal(calls.length, 2);
  for (const input of calls) { assert.deepEqual(Object.keys(input).sort(), ['server', 'username', 'deviceId'].sort()); assert.equal(input.server, f.server); assert.equal(input.username, USERNAME); }
});

test('invalid renewable metadata or authorization epoch fails closed without leaking or refreshing it', async t => {
  const f = await fixture(t); await f.login(); const valid = clone(f.credentials.records.get(KEY));
  const mutations = [
    value => { delete value.refreshToken; }, value => { value.refreshToken = 'bad'; }, value => { value.familyId = 'bad'; },
    value => { value.serverId = 'invalid/server'; }, value => { value.refreshExpiresAt = 'bad'; },
    value => { value.absoluteExpiresAt = '2000-01-01T00:00:00.000Z'; }, value => { value.authorizationEpoch = '1'; },
    value => { value.authorizationEpoch = -1; }, value => { value.authorizationEpoch = 2; },
  ];
  for (const mutate of mutations) {
    const record = clone(valid); mutate(record.payload); f.credentials.records.set(KEY, record);
    await assert.rejects(f.controller.syncAccount(), { code: 'ACCOUNT_MISMATCH' });
    await assert.rejects(f.controller.renewAuthorization(), { code: 'ACCOUNT_MISMATCH' });
    assert.equal((await f.controller.status()).loggedIn, false);
  }
  assert.equal(f.refreshCount(), 0); f.credentials.records.set(KEY, valid);
  assert.equal((await f.controller.status()).loggedIn, true);
});
