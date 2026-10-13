import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import * as controllers from '../plugin/controller.mjs';
import * as settingsServices from '../plugin/settings-service.mjs';
import * as bidirectional from '../plugin/bidirectional-service.mjs';
import * as updateServices from '../plugin/update-service.mjs';
import * as settingsHttp from '../plugin/settings-http.mjs';
import { SyncClient } from '../src/client.mjs';
import { LocalStore } from '../src/local-store.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const publicActions = ['status', 'login', 'password', 'logout', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate', ...bidirectional.BIDIRECTIONAL_ACTIONS];

// Observe the real factories without rewriting apply or adding a production test
// API. Only this uniquely identified entry import resolves through these wrappers;
// all service implementations and their own imports remain the real modules.
async function observedEntry(t, handles) {
  const entry = new URL('../plugin/index.mjs', import.meta.url);
  const key = `bidirectional-only-host-${randomUUID()}`;
  entry.searchParams.set('host-test', key);
  const modules = {
    './controller.mjs': { ...controllers, createController(...args) {
      handles.controllerArgs = args;
      handles.controller = controllers.createController(...args);
      handles.assertNoLegacy = forbidLegacy(t, handles);
      return handles.controller;
    } },
    './settings-service.mjs': { ...settingsServices, createSettingsService(...args) {
      handles.settingsArgs = args;
      return handles.legacy = settingsServices.createSettingsService(...args);
    } },
    './bidirectional-service.mjs': { ...bidirectional, withBidirectionalSync(...args) {
      handles.bidirectionalArgs = args;
      return bidirectional.withBidirectionalSync(...args);
    } },
    './update-service.mjs': { ...updateServices, createUpdateService(...args) {
      return handles.updates = updateServices.createUpdateService(...args);
    }, withUpdateStatus(...args) {
      return handles.settings = updateServices.withUpdateStatus(...args);
    } },
    './settings-http.mjs': { ...settingsHttp, createSettingsHttp(...args) {
      return handles.bridge = settingsHttp.createSettingsHttp(...args);
    } },
  };
  globalThis[key] = modules;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL !== entry.href || !Object.hasOwn(modules, specifier)) return nextResolve(specifier, context);
    const source = `const module = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}];\n` +
      Object.keys(modules[specifier]).map(name => `export const ${name} = module.${name};`).join('\n');
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  } });
  try { return await import(entry.href); }
  finally { hook.deregister(); delete globalThis[key]; }
}

function mockCtx(t, { home, profileDir, root }, events) {
  const commands = [], flows = [], routes = [], listeners = [], records = new Map(), nativeEffects = [];
  const forbiddenService = name => new Proxy({}, { get(_target, property) {
    nativeEffects.push(`${name}.${String(property)}`);
    throw new Error('Host entry must not start agents or import/export sessions');
  } });
  const workspace = { id: 'workspace', title: 'Synthetic project', path: root };
  const ctx = {
    profileContext: { dir: profileDir, home },
    credentials: {
      readRecord: t.mock.fn(async key => records.get(key)),
      modifyRecord: t.mock.fn(async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); }),
      deleteRecord: t.mock.fn(async key => records.delete(key)),
    },
    workspaceRegistry: { list: () => [workspace], get: id => id === workspace.id ? workspace : undefined },
    connection: { fetch: { register: value => routes.push(value) } },
    authorization: { registerFlow: value => flows.push(value) },
    commands: { register: value => commands.push(value) },
    on: (name, listener) => listeners.push([name, listener]),
    logger: { warn: t.mock.fn() },
    get(name) { return this[name]; },
  };
  for (const name of ['agents', 'sessions', 'sessionPersistence', 'attachments']) ctx[name] = forbiddenService(name);
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    const handle = { callback, ms, unref: t.mock.fn() }; timers.push(handle); return handle;
  });
  t.mock.method(globalThis, 'clearInterval', handle => { assert.ok(timers.includes(handle)); handle.cleared = true; events.push('timer.clear'); });
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Synthetic Host tests must not access the network'); });
  return { ctx, commands, flows, routes, listeners, records, timers, nativeEffects, network };
}

async function fixture(t, config = {}) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'bidir-only-host-'));
  const home = path.join(directory, 'host'), profileDir = path.join(home, 'profiles', 'fixture'), root = path.join(directory, 'project');
  await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(root);
  const handles = {}, events = [], mock = mockCtx(t, { home, profileDir, root }, events);
  let disposing;
  const dispose = () => disposing ??= mock.listeners.find(([name]) => name === 'dispose')?.[1]();
  t.after(async () => {
    try {
      await dispose();
      handles.assertNoLegacy?.();
      assert.equal(mock.network.mock.callCount(), 0, 'no implicit cloud, legacy upload, or update requests');
      assert.deepEqual(mock.nativeEffects, [], 'no native agent/session work');
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
      assert.match(path.basename(directory), /^bidir-only-host-[A-Za-z0-9]+$/);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const plugin = await observedEntry(t, handles);
  const installed = { server: 'https://synthetic.invalid', username: 'owner', autoSync: true, intervalMs: 30_000,
    projects: [{ id: 'legacy-project', root, workspaceId: 'workspace' }], allowLegacyCli: true, ...config };
  const before = structuredClone(installed);
  plugin.apply(mock.ctx, installed);
  assert.deepEqual(installed, before, 'installation must not rewrite legacy preferences');
  assert.equal(mock.timers.length, 1); assert.equal(mock.timers[0].ms, 5000); assert.equal(mock.timers[0].unref.mock.callCount(), 1);
  return { ...mock, ...handles, directory, home, profileDir, root, installed, plugin, events, dispose,
    tick: () => mock.timers[0].callback(),
    command: name => mock.commands.find(command => command.name === name).handler({ rawInput: '   ' }),
  };
}

function forbidLegacy(t, f) {
  const spies = [];
  for (const [target, names] of [[f.controller, ['tick', 'push', 'schedulePush', 'scheduleSelected', 'list', 'restore', 'import']], [f.controller.store, ['capture', 'flush']]]) {
    for (const name of names) spies.push([name, t.mock.method(target, name, async () => { throw new Error(`Unexpected legacy ${name}`); })]);
  }
  return () => { for (const [name, spy] of spies) assert.equal(spy.mock.callCount(), 0, `legacy ${name} must never run`); };
}

const grant = () => ({ server: 'https://synthetic.invalid', username: 'owner', deviceId: 'synthetic-device', token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' });

test('Host keeps exact services, profile authority and only status/logout native commands', async t => {
  const f = await fixture(t), assertNoLegacy = f.assertNoLegacy;
  assert.deepEqual(f.plugin.inject, ['authorization', 'credentials', 'commands', 'sessions', 'sessionPersistence', 'agents', 'attachments', 'workspaceRegistry', 'connection', 'profileContext']);
  assert.equal(f.controllerArgs[0], f.ctx);
  assert.deepEqual(f.controllerArgs[2], { credentialKey: settingsServices.credentialKeyForProfile(f.profileDir), allowLegacyCli: false });
  assert.notEqual(f.controller.credentialKey, controllers.CREDENTIAL_KEY);
  assert.equal(f.controller.store.directory, path.join(f.profileDir, 'dsh-personal-sync'));
  assert.deepEqual(f.settingsArgs[2], { profileDir: f.profileDir, dshHome: f.home });
  assert.deepEqual(f.bidirectionalArgs[3], { profileDir: f.profileDir, dshHome: f.home });
  assert.deepEqual(f.listeners.map(([name]) => name), ['dispose']);
  assert.deepEqual(f.commands.map(command => command.name), ['sync-status', 'sync-logout']);
  assert.ok(f.commands.every(command => command.recordInput === false));
  assert.equal(f.flows.length, 1); assert.equal(f.flows[0].key, f.controller.credentialKey);
  assert.deepEqual(f.flows[0].methods, [{ id: 'password', label: '登录个人同步服务器' }]);
  const session = { signal: new AbortController().signal }, authorizationResult = { authorized: true };
  const authorize = t.mock.method(f.controller, 'authorize', async value => { assert.equal(value, session); return authorizationResult; });
  assert.equal(await f.flows[0].run(session), authorizationResult); assert.equal(authorize.mock.callCount(), 1);
  assert.equal(publicActions.length, 33);
  assert.deepEqual(f.routes.map(route => route.path), publicActions.map(action => settingsHttp.SETTINGS_API + action));
  assert.equal(new Set(f.routes.map(route => route.path)).size, f.routes.length);
  assert.ok(f.routes.every(route => route.path.startsWith(settingsHttp.SETTINGS_API) && !route.path.includes('*') && route.requestBody === 'streaming' && JSON.stringify(route.methods) === '["POST"]'));
  const v2 = { revision: 7, bindings: [{ id: 'paired', pendingUpload: 2, pendingDownload: 3 }], operations: [], capability: 'supported' };
  const status = t.mock.method(f.settings, 'syncstatus', async () => v2);
  const legacyStatus = t.mock.method(f.settings, 'status', async () => ({ pending: 99, autoSync: true }));
  assert.deepEqual(await f.command('sync-status'), { kind: 'success', text: JSON.stringify(v2, null, 2) });
  assert.equal(status.mock.callCount(), 1); assert.equal(legacyStatus.mock.callCount(), 0);
  const logout = t.mock.method(f.settings, 'logout', async () => ({ loggedIn: false }));
  assert.deepEqual(await f.command('sync-logout'), { kind: 'success', text: JSON.stringify({ loggedIn: false }, null, 2) });
  assert.equal(logout.mock.callCount(), 1);
  logout.mock.mockImplementation(async () => { throw new Error('Logout refused'); });
  assert.deepEqual(await f.command('sync-logout'), { kind: 'error', text: 'Logout refused' });
  assertNoLegacy();
});

test('all removed native HTTP operations are absent and return 404 before reading valid old payloads or touching services', async () => {
  const binding = { revision: 1, server: 'https://synthetic.invalid', username: 'owner' };
  const checkpoint = { projectId: 'project', checkpointId: 'checkpoint' };
  const node = { browserId: 'browser', nodeId: 'node' };
  const confirmed = { requestId: 'request', confirm: true };
  const removed = {
    preferences: { revision: 1, autoSync: true, projectIds: ['workspace'] },
    sync: { projectId: 'workspace' },
    projects: binding,
    checkpoints: { ...binding, projectId: checkpoint.projectId },
    destinationpick: { ...binding, ...checkpoint },
    destinationbrowse: { ...binding, ...node },
    destinationselect: { ...binding, ...node },
    downloadpick: { ...binding, items: [checkpoint] },
    downloadbrowse: { ...binding, ...node },
    downloadselect: { ...binding, ...node },
    downloadstart: { ...binding, ...confirmed, items: [{ ...checkpoint, destinationId: 'destination' }] },
    restore: { ...binding, ...checkpoint, ...confirmed, destination: path.resolve(parent, 'removed-route-destination') },
    import: { ...binding, ...confirmed, restoreId: 'restore' },
    registerproject: { ...binding, ...confirmed, restoreId: 'restore' },
  };
  assert.equal(Object.keys(removed).length, 14);
  const accesses = [], routes = [];
  const bridge = settingsHttp.createSettingsHttp(new Proxy({}, { get(_target, key) {
    accesses.push(key); throw new Error('Removed routes must never access internal service helpers');
  } }));
  settingsHttp.registerSettingsRoutes({ connection: { fetch: { register: value => routes.push(value) } } }, bridge);
  assert.deepEqual(routes.map(route => route.path), publicActions.map(action => settingsHttp.SETTINGS_API + action));
  try {
    for (const [action, payload] of Object.entries(removed)) {
      assert.equal(routes.some(route => route.path === settingsHttp.SETTINGS_API + action), false, action);
      const url = `http://dsh.internal${settingsHttp.SETTINGS_API}${action}`;
      const rpc = { type: 'client-request', rpcId: 'removed-route', method: `dsh-personal-sync/${action}`, payload };
      for (const request of [new Request(url), ...[payload, rpc].map(value => new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      }))]) {
        const response = await bridge.fetch(action, request);
        assert.equal(response.status, 404, action); assert.equal(request.bodyUsed, false, 'unknown routes reject before body parsing');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        const body = await response.json(); assert.equal(body.error.code, 'BAD_REQUEST');
        assert.equal(body.type, undefined); assert.ok(!JSON.stringify(body).includes(binding.username));
        assert.deepEqual(accesses, [], `${action} cannot dispatch, including through a logout fallback`);
      }
    }
  } finally { bridge.dispose(); }
});

test('catalog generation errors stay actionable through native RPC without exposing remote diagnostics', async t => {
  const bridge = settingsHttp.createSettingsHttp({ async syncprojects() { throw Object.assign(new Error('untrusted-catalog-secret'), { code: 'SYNC_CATALOG_CHANGED', details: { token: 'untrusted-catalog-secret' } }); } });
  t.after(() => bridge.dispose());
  const request = new Request(`http://dsh.internal${settingsHttp.SETTINGS_API}syncprojects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'catalog-read', method: 'dsh-personal-sync/syncprojects', payload: {} }) });
  const response = await bridge.fetch('syncprojects', request), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.rpcId, 'catalog-read'); assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, 'SYNC_CATALOG_CHANGED'); assert.match(body.result.error.message, /重新打开选择器/);
  assert.equal(JSON.stringify(body).includes('untrusted-catalog-secret'), false);
});

test('every retained native HTTP operation remains an exact streaming POST RPC with correlated dispatch', async () => {
  const calls = [], routes = [];
  const service = Object.fromEntries(publicActions.map(action => [action, async (...args) => {
    calls.push({ action, args, payload: structuredClone(args[0]) }); return { action };
  }]));
  const bridge = settingsHttp.createSettingsHttp(service);
  settingsHttp.registerSettingsRoutes({ connection: { fetch: { register: value => routes.push(value) } } }, bridge);
  assert.equal(routes.length, 33);
  try {
    for (const [index, action] of publicActions.entries()) {
      const route = routes[index], url = `http://dsh.internal${settingsHttp.SETTINGS_API}${action}`;
      assert.equal(route.path, settingsHttp.SETTINGS_API + action);
      assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'streaming');
      assert.equal((await route.fetch(new Request(url))).status, 405); assert.equal(calls.length, index);
      const payload = ['login', 'password'].includes(action) ? { password: 'synthetic-secret', currentPassword: 'synthetic-current', newPassword: 'synthetic-new' } : {};
      const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `retained-${index}`, method: `dsh-personal-sync/${action}`, payload }) });
      const response = await route.fetch(request);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { type: 'server-response', rpcId: `retained-${index}`, result: { ok: true, value: { action } } });
      assert.equal(calls.length, index + 1); assert.equal(calls[index].action, action);
      assert.equal(calls[index].args.length, action === 'status' ? 0 : action === 'logout' ? 1 : 2);
      if (action !== 'status') assert.deepEqual(calls[index].payload, payload);
      if (!['status', 'logout'].includes(action)) assert.equal(calls[index].args[1], request.signal);
      if (['login', 'password'].includes(action)) for (const key of Object.keys(payload)) assert.equal(calls[index].args[0][key], '');
    }
  } finally { bridge.dispose(); }
});

test('five-second timer ignores old autoSync/projects and only serializes initialize, renewal and v2', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t), assertNoLegacy = f.assertNoLegacy, entered = deferred(), release = deferred(), calls = [];
  const initialize = t.mock.method(f.settings, 'initialize', async () => { calls.push('initialize'); });
  const renewal = t.mock.method(f.controller, 'renewAuthorization', async () => { calls.push('renew'); entered.resolve(); await release.promise; });
  const v2 = t.mock.method(f.settings, 'tickBidirectional', async () => { calls.push('v2'); });
  const legacyStatus = t.mock.method(f.controller, 'status', async () => ({ loggedIn: true }));
  // Deliberately keep the legacy authority active so reintroducing its timer
  // branch cannot be masked by a logged-out account or a not-yet-due interval.
  assert.equal(f.controller.config.autoSync, true); assert.equal(f.controller.config.projects.length, 1);
  now += 60_000;
  const first = f.tick();
  try {
    await entered.promise; await f.tick();
    assert.deepEqual(calls, ['initialize', 'renew']);
  } finally { release.resolve(); await first; }
  assert.deepEqual(calls, ['initialize', 'renew', 'v2']);
  now += 60_000; await f.tick();
  assert.deepEqual(calls, ['initialize', 'renew', 'v2', 'initialize', 'renew', 'v2']);
  initialize.mock.mockImplementationOnce(async () => { throw new Error('Synthetic initialization failure'); });
  await f.tick(); assert.equal(f.ctx.logger.warn.mock.callCount(), 1);
  await f.tick();
  assert.equal(renewal.mock.callCount(), 3); assert.equal(v2.mock.callCount(), 3);
  assert.equal(legacyStatus.mock.callCount(), 0); assertNoLegacy();
});

test('persisted old selections and immutable queue survive real Host ticks without implicit v2 pairing or uploads', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t), identity = grant();
  // Seed through a separate fixture store: every legacy method on the Host's
  // own controller/store has been watched since construction, including apply.
  const fixtureStore = await new LocalStore(f.controller.store.directory).init();
  await fixtureStore.saveConfig({ server: identity.server, username: identity.username, deviceId: identity.deviceId });
  f.records.set(f.controller.credentialKey, { kind: 'grant', payload: identity });
  await fs.writeFile(path.join(f.root, 'fixture.txt'), 'retained legacy checkpoint');
  await fixtureStore.capture({ root: f.root, projectId: 'legacy-project', deviceId: identity.deviceId });
  const preferences = JSON.stringify({ version: 1, revision: 9, server: identity.server, username: identity.username, autoSync: true, intervalMs: 30_000,
    bindings: [{ workspaceId: 'workspace', projectId: 'legacy-project', root: f.root }], selected: ['workspace'] }, null, 2);
  await fs.writeFile(f.legacy.filename, preferences);
  const pending = await f.controller.store.pending(); assert.equal(pending.length, 1);
  const assertNoLegacy = f.assertNoLegacy, renewal = t.mock.method(f.controller, 'renewAuthorization'), v2 = t.mock.method(f.settings, 'tickBidirectional');
  for (let i = 0; i < 3; i++) { now += 60_000; await f.tick(); }
  assert.equal(renewal.mock.callCount(), 3); assert.equal(v2.mock.callCount(), 3); assert.equal(f.ctx.logger.warn.mock.callCount(), 0);
  const result = await f.command('sync-status'); assert.equal(result.kind, 'success');
  const status = JSON.parse(result.text);
  assert.equal(status.loggedIn, true); assert.deepEqual(status.bindings, []); assert.deepEqual(status.operations, []);
  assert.equal(Object.hasOwn(status, 'pending'), false); assert.equal(Object.hasOwn(status, 'autoSync'), false);
  assert.equal(await fs.readFile(f.legacy.filename, 'utf8'), preferences);
  assert.deepEqual(await f.controller.store.pending(), pending);
  assert.equal(await fs.readFile(path.join(f.root, 'fixture.txt'), 'utf8'), 'retained legacy checkpoint');
  await assert.rejects(fs.stat(f.settings.bidirectionalFilename), { code: 'ENOENT' });
  assertNoLegacy();
});

test('native entry rejects standalone CLI credentials even with allowLegacyCli true, while native grants and logout still work', async t => {
  const f = await fixture(t), assertNoLegacy = f.assertNoLegacy, identity = grant();
  await f.controller.store.saveConfig(identity);
  const local = await f.controller.store.config();
  let result = await f.command('sync-status'); assert.equal(result.kind, 'success');
  assert.equal(JSON.parse(result.text).loggedIn, false);
  await assert.rejects(f.controller.syncAccount(), { code: 'NOT_LOGGED_IN' });
  await f.tick(); assert.deepEqual(await f.controller.store.config(), local);
  f.records.set(f.controller.credentialKey, { kind: 'grant', payload: identity });
  result = await f.command('sync-status'); assert.equal(result.kind, 'success'); assert.equal(JSON.parse(result.text).loggedIn, true);
  const revoke = t.mock.method(SyncClient.prototype, 'logout', async function () { assert.equal(this.token, identity.token); return { remoteRevoked: true }; });
  result = await f.command('sync-logout'); assert.equal(result.kind, 'success'); assert.equal(JSON.parse(result.text).loggedIn, false);
  assert.equal(revoke.mock.callCount(), 1); assert.equal(f.records.size, 0);
  assert.deepEqual(f.ctx.credentials.deleteRecord.mock.calls.map(call => call.arguments), [[f.controller.credentialKey]]);
  const after = await f.controller.store.config(); assert.equal(after.token, undefined); assert.equal(after.reauthRequired, true);
  await assert.rejects(f.controller.syncAccount(), { code: 'NOT_LOGGED_IN' });
  await f.tick(); assertNoLegacy();
});

test('dispose clears its timer, stops services and joins non-native drains without starting sync or agents', async t => {
  const f = await fixture(t), assertNoLegacy = f.assertNoLegacy, gates = [deferred(), deferred(), deferred()];
  const wrap = (target, method, label, gate) => {
    const original = target[method];
    return t.mock.method(target, method, function (...args) {
      f.events.push(label);
      const result = original.apply(this, args);
      return gate ? Promise.resolve(result).then(() => gate.promise) : result;
    });
  };
  const stopped = [wrap(f.bridge, 'dispose', 'bridge.dispose'), wrap(f.updates, 'dispose', 'updates.dispose'),
    wrap(f.settings, 'stopBidirectional', 'v2.stop'), wrap(f.controller, 'stop', 'controller.stop')];
  const updatesDrain = wrap(f.updates, 'drain', 'updates.drain', gates[0]);
  const drains = [updatesDrain, wrap(f.controller, 'drain', 'controller.drain', gates[1]), wrap(f.settings, 'drainBidirectional', 'v2.drain', gates[2])];
  let settled = false; const disposing = f.dispose().then(() => { settled = true; });
  try {
    assert.deepEqual(f.events, ['timer.clear', 'bridge.dispose', 'updates.dispose', 'v2.stop', 'controller.stop', 'updates.drain', 'controller.drain', 'v2.drain']);
    assert.equal(f.timers[0].cleared, true);
    assert.deepEqual(updatesDrain.mock.calls[0].arguments, [{ native: false }], 'native HMR owns applying/cancellation settlement');
    for (const spy of [...stopped, ...drains]) assert.equal(spy.mock.callCount(), 1);
    for (const gate of gates.slice(0, 2)) gate.resolve();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'v2 drain must be joined');
    const route = f.routes.find(route => route.path === settingsHttp.SETTINGS_API + 'syncstatus');
    assert.equal((await route.fetch(new Request(`http://dsh.internal${route.path}`, { method: 'POST' }))).status, 503);
    await assert.rejects(f.settings.syncstatus(), { code: 'DISPOSED' });
    await assert.rejects(f.controller.syncAccount(), /Plugin is stopped/);
    assertNoLegacy();
  } finally { for (const gate of gates) gate.resolve(); await disposing; }
  assert.equal(settled, true);
});
