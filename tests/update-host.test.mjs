import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createController } from '../plugin/controller.mjs';
import { apply as applyPlugin } from '../plugin/index.mjs';
import { createSettingsService } from '../plugin/settings-service.mjs';
import { createSettingsHttp, registerSettingsRoutes, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createUpdateService, withUpdateStatus, stableVersion, newerVersion, UPDATE_COMMITS_URL } from '../plugin/update-service.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const own = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sha = 'abcdef0123456789abcdef0123456789abcdef01';
const manifest = (version = '0.6.0') => ({ ...structuredClone(own), version });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function payload(candidate, requestId = randomUUID()) { return { candidateId: candidate.id, requestId, confirm: true }; }
async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'update-'));
  const row = { name: 'dsh-personal-sync', version: '0.5.0', installed: true, enabled: false, removable: true, ...options.row };
  const calls = [], requests = [], records = new Map(), held = deferred();
  const manager = {
    async listBundles() { return [{ ...row }]; },
    installBundle(...args) { calls.push(args); return held.promise; },
    async cancelInstall(id) { calls.push(['cancel', id]); held.resolve({ application: 'cancelled' }); return { status: 'cancelled' }; },
  };
  let currentManager = options.unavailable ? undefined : manager, clock = 1_800_000_000_000;
  const profileDir = path.join(root, 'profile'), projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot); await fs.mkdir(profileDir);
  const ctx = { profileContext: { dir: profileDir },
    get(name) { assert.equal(name, 'pluginManager'); return currentManager; },
    workspaceRegistry: { list: () => [], get: () => undefined },
    credentials: { async readRecord(key) { return records.get(key); }, async deleteRecord(key) { records.delete(key); },
      async modifyRecord(key, fn) { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); } },
  };
  const controller = createController(ctx, { stateDir: path.join(root, 'state'), projects: [{ id: 'project', root: projectRoot }] }, {
    allowLegacyCli: false,
    exportSessions: options.exportSessions || (async () => ({ sessions: [], assets: [], skipped: [] })),
  });
  const updater = createUpdateService(ctx, controller, { currentVersion: '0.5.0', now: () => clock,
    fetch: async (url, init) => { requests.push([url, init]); return options.fetch ? options.fetch(url, init, requests.length) : Response.json(url === UPDATE_COMMITS_URL ? [{ sha }] : manifest()); },
    ...options.updateOptions,
  });
  const settings = createSettingsService(ctx, controller, { profileDir, dshHome: path.join(root, 'private') });
  const service = withUpdateStatus(settings, updater), bridge = createSettingsHttp(service);
  t.after(async () => {
    bridge.dispose(); updater.dispose(); controller.stop(); await Promise.all([updater.drain(), controller.drain()]);
    assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('update-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function check() { const result = await updater.checkupdate({}); assert.equal(result.update.state, 'available', JSON.stringify(result)); return result.update.candidate; }
  async function authenticated() {
    controller.setInitializer(async () => {}); controller.setRootAdmission(async () => {}); controller.setCaptureExclusions(async () => []);
    const account = { server: 'https://synthetic.invalid', username: 'owner', deviceId: 'test-device', token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' };
    await controller.store.saveConfig({ server: account.server, username: account.username, deviceId: account.deviceId });
    records.set(controller.credentialKey, { kind: 'grant', payload: account });
    return account;
  }
  async function complete(result = {}) {
    row.version = '0.6.0'; held.resolve({ application: 'restart-required', target: row.name, bundle: row.name, packageResult: { exitCode: 0 }, ...result });
    await updater.drain(); return (await updater.updatestatus()).update;
  }
  return { root, ctx, row, manager, calls, requests, held, controller, updater, settings, service, bridge, records, check, authenticated, complete,
    setManager(value) { currentManager = value; }, advance(ms) { clock += ms; } };
}
async function rpc(f, action, input = {}, signal) {
  const request = new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'update-rpc', method: `dsh-personal-sync/${action}`, payload: input }) });
  const response = await f.bridge.fetch(action, request);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()).result;
}

test('status is anonymous, local-only, and missing optional manager does not block sync settings', async t => {
  const f = await fixture(t, { unavailable: true });
  assert.equal((await f.updater.updatestatus()).update.supported, false);
  const status = await f.service.status();
  assert.equal(status.loggedIn, false); assert.equal(status.update.errorCode, 'UPDATE_UNAVAILABLE');
  await f.controller.mutate(async () => {});
  assert.equal((await f.updater.checkupdate({})).update.supported, false);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
});

test('explicit check uses two fixed public URLs without credentials and installs only immutable approved candidate', async t => {
  const f = await fixture(t), candidate = await f.check();
  assert.deepEqual(f.requests.map(([url]) => url), [UPDATE_COMMITS_URL, `https://raw.githubusercontent.com/HuYongJi/dsh_sync/${sha}/package.json`]);
  for (const [, init] of f.requests) {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.body, undefined); assert.equal(init.method, 'GET');
  }
  const input = payload(candidate), abort = new AbortController();
  const result = await f.updater.installupdate(input, abort.signal); abort.abort();
  assert.equal(result.update.state, 'installing'); assert.equal(result.update.restartRequired, true);
  assert.deepEqual(f.calls, [[`https://github.com/HuYongJi/dsh_sync#${sha}`, { enabled: false, requestId: input.requestId }]]);
  assert.deepEqual(await f.updater.installupdate(input), await f.updater.updatestatus());
  await assert.rejects(f.updater.installupdate({ ...input, candidateId: randomUUID() }), { code: 'BAD_REQUEST' });
  const done = await f.complete(); assert.equal(done.state, 'restart-required'); assert.equal(done.currentVersion, '0.5.0'); assert.equal(done.installedVersion, '0.6.0');
  assert.equal((await f.updater.installupdate(input)).update.state, 'restart-required'); assert.equal(f.calls.length, 1);
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'UPDATE_RESTART_REQUIRED' });
});

test('newer comparison is exact stable numeric semver, not lexicographic or permissive prerelease', () => {
  for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-beta', '1.0.0+build', '9007199254740992.0.0', '', null]) assert.equal(stableVersion(version), undefined);
  assert.equal(newerVersion('0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.6.0', '0.6.0'), false); assert.equal(newerVersion('0.5.9', '0.6.0'), false);
});

test('equal/older remote versions never offer install; explicit installed mismatch requires restart even on downgrade', async t => {
  for (const version of ['0.5.0', '0.4.9']) {
    const f = await fixture(t, { fetch: url => Response.json(url === UPDATE_COMMITS_URL ? [{ sha }] : manifest(version)) });
    const result = await f.updater.checkupdate({}); assert.equal(result.update.state, 'up-to-date'); assert.equal(result.update.candidate, undefined);
  }
  for (const version of ['0.4.0', '0.6.0']) {
    const f = await fixture(t, { row: { version } });
    const result = await f.updater.updatestatus(); assert.equal(result.update.state, 'restart-required'); assert.equal(result.update.restartRequired, true);
    await f.updater.checkupdate({}); assert.equal(f.requests.length, 0);
    await assert.rejects(f.controller.mutate(async () => {}), { code: 'UPDATE_RESTART_REQUIRED' });
  }
});

test('only healthy own direct dependency qualifies, never shipped-only or manager-protected bundle', async t => {
  for (const row of [{ installed: false }, { readOnlyReason: 'management-required' }, { error: { code: 'incompatible-version' } }, { name: 'other-package' }, { version: '0.5.0-beta' }]) {
    const f = await fixture(t, { row }); const result = await f.updater.checkupdate({});
    assert.equal(result.update.supported, false); assert.equal(result.update.errorCode, 'UPDATE_UNMANAGED'); assert.equal(f.requests.length, 0);
    await f.controller.mutate(async () => {});
  }
});

test('candidate is tied to manager generation, profile, own installed version and selection', async t => {
  for (const change of [f => f.setManager({ ...f.manager }), f => { f.ctx.profileContext.dir += '-changed'; }, f => { f.row.enabled = true; }]) {
    const f = await fixture(t), candidate = await f.check(); change(f);
    await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'UPDATE_CHECK_REQUIRED' }); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t), candidate = await f.check(); f.row.version = '0.5.1';
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'UPDATE_CHECK_REQUIRED' }); assert.equal(f.calls.length, 0);
});

test('fresh Cordis trace proxies bind to the same original native service', async t => {
  const f = await fixture(t);
  f.ctx.get = () => new Proxy(f.manager, { get(target, key) { return key === Symbol.for('cordis.original') ? target : Reflect.get(target, key); } });
  const candidate = await f.check(); await f.updater.installupdate(payload(candidate)); assert.equal(f.calls.length, 1); await f.complete();
});

test('candidate TTL, check rate limit and replacement check invalidation fail closed', async t => {
  const f = await fixture(t), candidate = await f.check();
  await assert.rejects(f.updater.checkupdate({}), { code: 'RATE_LIMITED' });
  f.advance(15 * 60_000);
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'UPDATE_CHECK_REQUIRED' });
  const expired = (await f.updater.updatestatus()).update;
  assert.equal(expired.candidate, undefined); assert.equal(expired.state, 'idle'); assert.equal(expired.errorCode, 'UPDATE_CHECK_REQUIRED');
  const newer = await f.check(); assert.notEqual(newer.id, candidate.id);
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'UPDATE_CHECK_REQUIRED' }); assert.equal(f.calls.length, 0);
});

test('strict fixed payloads reject arbitrary spec, URLs, credentials, confirmation and unknown IDs', async t => {
  const f = await fixture(t), candidate = await f.check(), good = payload(candidate);
  for (const input of [{ ...good, spec: 'attacker/repo' }, { ...good, confirm: false }, { ...good, approvedBuilds: ['anything'] }, { ...good, requestId: '' }, { candidateId: candidate.id, requestId: 'one' }]) {
    await assert.rejects(f.updater.installupdate(input), { code: 'BAD_REQUEST' });
  }
  for (const requestId of ['constructor', 'PROTOTYPE', '__proto__', '_leading', '-leading', 'a'.repeat(101)]) await assert.rejects(f.updater.installupdate({ ...good, requestId }), { code: 'BAD_REQUEST' });
  await assert.rejects(f.updater.checkupdate({ url: 'https://attacker.invalid' }), { code: 'BAD_REQUEST' });
  await assert.rejects(f.updater.updatestatus({ token: 'secret' }), { code: 'BAD_REQUEST' });
  await assert.rejects(f.updater.cancelupdate({ requestId: 'unrelated' }), { code: 'BAD_REQUEST' });
  assert.equal(f.calls.length, 0);
});

test('malformed hashes, oversized manifests, redirects, hooks and wrong peers are rejected without arbitrary output', async t => {
  const variants = [
    (url, _init, count) => count === 1 ? Response.json([{ sha: '../../escape' }]) : Response.json(manifest()),
    () => new Response('secret transport detail', { status: 302, headers: { location: 'https://attacker.invalid' } }),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : new Response(' '.repeat(128 * 1024 + 1)),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : new Response('{}', { headers: { 'content-length': String(128 * 1024 + 1) } }),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : Response.json({ ...manifest(), name: 'attacker' }),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : Response.json({ ...manifest(), scripts: { prepare: 'steal secret' } }),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : Response.json({ ...manifest(), peerDependencies: {} }),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : Response.json({ ...manifest(), exports: {} }),
    (url, _init, count) => count === 1 ? Response.json([{ sha }]) : Response.json(manifest('0.6.0-beta')),
    () => new Response('not-json secret'),
  ];
  for (const fetch of variants) {
    const f = await fixture(t, { fetch }); const result = await f.updater.checkupdate({});
    assert.equal(result.update.state, 'failed'); assert.ok(['UPDATE_CHECK_FAILED', 'UPDATE_INVALID_METADATA'].includes(result.update.errorCode));
    assert.equal(result.update.candidate, undefined); assert.ok(!JSON.stringify(result).includes('secret')); assert.equal(f.calls.length, 0);
  }
});

test('decoded gzip and br metadata accepts compressed length while identity mismatch and decoded overflow fail', async t => {
  for (const encoding of ['gzip', 'br']) {
    const f = await fixture(t, { fetch: url => Response.json(url === UPDATE_COMMITS_URL ? [{ sha }] : manifest(), {
      headers: { 'content-encoding': encoding, 'content-length': '8' },
    }) });
    assert.equal((await f.updater.checkupdate({})).update.state, 'available');
  }
  for (const headers of [{ 'content-length': '8' }, { 'content-encoding': 'identity', 'content-length': '8' }]) {
    const f = await fixture(t, { fetch: () => Response.json([{ sha }], { headers }) });
    assert.equal((await f.updater.checkupdate({})).update.errorCode, 'UPDATE_INVALID_METADATA');
  }
  const f = await fixture(t, { fetch: () => new Response(' '.repeat(256 * 1024 + 1), {
    headers: { 'content-encoding': 'gzip', 'content-length': '8' },
  }) });
  assert.equal((await f.updater.checkupdate({})).update.errorCode, 'UPDATE_INVALID_METADATA');
});

test('check abort/timeout and disposal drain bounded HTTP work with no installation', async t => {
  const never = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('secret')), { once: true }); });
  const f = await fixture(t, { fetch: never, updateOptions: { timeoutMs: 10 } });
  assert.equal((await f.updater.checkupdate({})).update.errorCode, 'UPDATE_CHECK_FAILED');
  const g = await fixture(t, { fetch: never });
  const checking = g.updater.checkupdate({}); await new Promise(resolve => setImmediate(resolve));
  g.updater.dispose(); await g.updater.drain(); await checking;
  await assert.rejects(g.updater.updatestatus(), { code: 'DISPOSED' }); assert.equal(g.calls.length, 0);
});

test('busy settings mutation refuses update without cancelling existing work', async t => {
  const f = await fixture(t), candidate = await f.check(), entered = deferred(), release = deferred();
  const mutation = f.controller.mutate(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'BUSY' }); assert.equal(f.calls.length, 0);
  release.resolve(); await mutation;
  await f.updater.installupdate(payload(candidate)); await f.complete();
});

test('busy upload and recovery refuse native update, never cancel user operations', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { exportSessions: async () => { entered.resolve(); await release.promise; return { sessions: [], assets: [], skipped: [{ reason: 'active' }] }; } });
  await f.authenticated(); f.controller.store.flush = async () => [];
  const candidate = await f.check(), upload = f.controller.push('project'); await entered.promise;
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'BUSY' }); assert.equal(f.calls.length, 0);
  release.resolve(); assert.equal((await upload).deferred, true);
  const downloading = deferred(); f.controller.store.restore = async () => { await downloading.promise; return { sessionIds: [], manifest: {} }; };
  await f.controller.startRecovery('restore', { requestId: 'recovery', destination: path.join(f.root, 'restored'), projectId: 'project', checkpointId: 'checkpoint' }, { checkBinding: async () => {}, admitDestination: async () => {} });
  await assert.rejects(f.updater.installupdate(payload(candidate)), { code: 'BUSY' }); assert.equal(f.calls.length, 0);
  downloading.resolve(); await f.controller.drain();
});

test('update permanently gates writes and ticks, preserves preferences, and allows logout only after installer settles', async t => {
  const f = await fixture(t); await f.settings.initialize();
  const before = structuredClone(f.controller.config), candidate = await f.check();
  await f.updater.installupdate(payload(candidate));
  for (const attempt of [() => f.controller.mutate(async () => {}), () => f.controller.scheduleSelected(), () => f.controller.logout()]) await assert.rejects(attempt(), { code: 'BUSY' });
  f.held.resolve({ application: 'failed', packageResult: { exitCode: 1 }, error: { code: 'operation-error', diagnostic: 'private file location' } }); await f.updater.drain();
  for (const attempt of [() => f.controller.mutate(async () => {}), () => f.controller.push('project'), () => f.controller.scheduleSelected(), () => f.controller.login({}), () => f.controller.startRecovery('restore', {}, { checkBinding: async () => {} })]) {
    await assert.rejects(attempt(), { code: 'UPDATE_RESTART_REQUIRED' });
  }
  assert.equal(await f.controller.tick(), undefined); assert.deepEqual(f.controller.config, before);
  assert.equal((await f.updater.updatestatus()).update.restartRequired, true);
  assert.equal((await f.controller.logout()).loggedOut, true);
});

test('native failure kinds are sanitized and restart barrier survives every outcome', async t => {
  const cases = [
    [{ application: 'failed', error: { code: 'incompatible-version', diagnostic: 'secret' } }, 'failed', 'UPDATE_INCOMPATIBLE'],
    [{ application: 'failed', packageResult: { exitCode: 1, kind: 'build-blocked', output: 'secret' }, pendingBuilds: ['secret-package'] }, 'failed', 'UPDATE_BUILD_APPROVAL_REQUIRED'],
    [{ application: 'failed', error: { code: 'unknown-secret' } }, 'failed', 'UPDATE_FAILED'],
    [{ application: 'cancelled' }, 'cancelled', undefined],
    [{ application: 'bogus' }, 'uncertain', 'UPDATE_UNCERTAIN'],
    [{ application: 'restart-required', target: 'other', packageResult: { exitCode: 0 } }, 'uncertain', 'UPDATE_UNCERTAIN'],
    [{ application: 'restart-required', target: 'dsh-personal-sync', bundle: 'dsh-personal-sync', packageResult: { exitCode: 0 } }, 'uncertain', 'UPDATE_UNCERTAIN'],
  ];
  for (const [result, state, code] of cases) {
    const f = await fixture(t), candidate = await f.check(); await f.updater.installupdate(payload(candidate));
    f.held.resolve(result); await f.updater.drain(); const status = (await f.updater.updatestatus()).update;
    assert.equal(status.state, state); assert.equal(status.errorCode, code); assert.equal(status.restartRequired, true); assert.ok(!JSON.stringify(status).includes('secret'));
  }
  const f = await fixture(t), candidate = await f.check(); await f.updater.installupdate(payload(candidate));
  f.held.reject(new Error('secret native failure')); await f.updater.drain(); assert.equal((await f.updater.updatestatus()).update.state, 'uncertain');
});

test('cancel only addresses owned request, joins cancellation; too-late and unknown are never success', async t => {
  const f = await fixture(t), candidate = await f.check(), input = payload(candidate); await f.updater.installupdate(input);
  await assert.rejects(f.updater.cancelupdate({ requestId: 'unrelated' }), { code: 'BAD_REQUEST' });
  await f.updater.cancelupdate({ requestId: input.requestId }); await f.updater.drain();
  assert.equal((await f.updater.updatestatus()).update.state, 'cancelled'); assert.deepEqual(f.calls[1], ['cancel', input.requestId]);
  for (const nativeStatus of ['too-late', 'not-running', 'reject']) {
    const g = await fixture(t); g.manager.cancelInstall = async () => { if (nativeStatus === 'reject') throw new Error('private cancellation detail'); return { status: nativeStatus }; };
    const candidate = await g.check(), input = payload(candidate); await g.updater.installupdate(input);
    await g.updater.cancelupdate({ requestId: input.requestId }); await new Promise(resolve => setImmediate(resolve));
    const active = (await g.updater.updatestatus()).update;
    assert.equal(active.state, 'installing');
    assert.equal(active.errorCode, nativeStatus === 'too-late' ? 'UPDATE_CANCEL_TOO_LATE' : 'UPDATE_UNCERTAIN');
    await assert.rejects(g.controller.logout(), { code: 'BUSY' });
    if (nativeStatus === 'too-late') await g.complete();
    else {
      g.held.reject(new Error('private original operation detail')); await g.updater.drain();
      assert.equal((await g.updater.updatestatus()).update.state, 'uncertain');
      assert.equal((await g.controller.logout()).loggedOut, true);
    }
  }
});

test('disposal cancels and drains only own native task, and repeated requests never replay', async t => {
  const f = await fixture(t), candidate = await f.check(), input = payload(candidate); await f.updater.installupdate(input);
  f.updater.dispose(); await f.updater.drain();
  assert.deepEqual(f.calls[1], ['cancel', input.requestId]); assert.equal(f.calls.length, 2);
  await assert.rejects(f.updater.installupdate(input), { code: 'DISPOSED' });
});

test('non-native teardown drain skips applying work but default drain still joins it', async t => {
  const f = await fixture(t), cancelRelease = deferred();
  f.manager.cancelInstall = async id => { f.calls.push(['cancel', id]); await cancelRelease.promise; return { status: 'too-late' }; };
  const candidate = await f.check(), input = payload(candidate); await f.updater.installupdate(input);
  f.updater.dispose();
  let timer;
  try {
    await Promise.race([f.updater.drain({ native: false }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('teardown waited on native HMR applying')), 1000); })]);
    let joined = false; const fullDrain = f.updater.drain().then(() => { joined = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(joined, false);
    cancelRelease.resolve(); f.held.resolve({ application: 'cancelled' }); await fullDrain;
    assert.equal(joined, true); assert.deepEqual(f.calls[1], ['cancel', input.requestId]);
  } finally { clearTimeout(timer); cancelRelease.resolve(); f.held.resolve({ application: 'cancelled' }); await f.updater.drain(); }
});

test('actual plugin dispose returns while native applying and cancellation need the same HMR queue', async t => {
  const f = await fixture(t), routes = [], hooks = [], releaseHmr = deferred();
  f.row.version = own.version; f.ctx.profileContext.home = path.join(f.root, 'private');
  let nativeTask, cancelTask;
  f.manager.installBundle = (...args) => {
    f.calls.push(args);
    nativeTask = releaseHmr.promise.then(() => {
      f.row.version = '0.6.0';
      return { application: 'restart-required', target: f.row.name, bundle: f.row.name, packageResult: { exitCode: 0 } };
    });
    return nativeTask;
  };
  f.manager.cancelInstall = id => {
    f.calls.push(['cancel', id]); cancelTask = releaseHmr.promise.then(() => ({ status: 'too-late' })); return cancelTask;
  };
  t.mock.method(globalThis, 'fetch', async url => Response.json(url === UPDATE_COMMITS_URL ? [{ sha }] : manifest()));
  Object.assign(f.ctx, { connection: { fetch: { register: route => routes.push(route) } }, authorization: { registerFlow() {} }, commands: { register() {} }, on: (name, fn) => hooks.push([name, fn]) });
  applyPlugin(f.ctx);
  const dispose = hooks.find(([name]) => name === 'dispose')[1];
  async function call(action, input = {}) {
    const response = await routes.find(route => route.path === SETTINGS_API + action).fetch(new Request(`http://dsh.internal${SETTINGS_API}${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }));
    assert.equal(response.status, 200); return response.json();
  }
  let timer, disposing;
  try {
    const checked = await call('checkupdate'), input = payload(checked.update.candidate);
    assert.equal((await call('installupdate', input)).update.state, 'installing');
    disposing = dispose();
    await Promise.race([disposing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HMR self-unload deadlock')), 1000); })]);
    assert.deepEqual(f.calls[1], ['cancel', input.requestId]);
  } finally {
    clearTimeout(timer); releaseHmr.resolve();
    await Promise.allSettled([nativeTask, cancelTask, disposing || dispose()].filter(Boolean));
  }
});

test('all updater routes use exact admitted POST RPC, sanitize errors, and ordinary status includes optional update', async t => {
  const f = await fixture(t), routes = [];
  registerSettingsRoutes({ connection: { fetch: { register: value => routes.push(value) } } }, f.bridge);
  assert.equal(routes.length, 14); assert.ok(routes.every(route => route.methods.length === 1 && route.methods[0] === 'POST' && route.requestBody === 'streaming'));
  for (const action of ['updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']) {
    assert.equal((await f.bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`))).status, 405);
    const result = await rpc(f, action, { password: 'never-reflect-this' }); assert.equal(result.ok, false); assert.equal(result.error.code, 'BAD_REQUEST'); assert.ok(!JSON.stringify(result).includes('never-reflect'));
  }
  const status = await rpc(f, 'status'); assert.equal(status.value.update.state, 'idle'); assert.equal(f.requests.length, 0);
  const checked = await rpc(f, 'checkupdate'); assert.equal(checked.ok, true); assert.equal(checked.value.update.state, 'available');
});

test('source contract pins installed native update semantics and does not spawn package managers or bypass gates', async () => {
  const source = await fs.readFile(new URL('../plugin/update-service.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("ctx.get?.('pluginManager')")); assert.ok(source.includes('manager.installBundle'));
  assert.ok(!/from ['"](?:node:child_process|execa)|spawn\(|execFile\(|removeBundle\(|approvedBuilds:|registry:/.test(source));
  assert.ok(!source.includes('credentials.readRecord')); assert.ok(!source.includes('writeFile'));
  // Native evidence: .inspection/installed/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js
  // 1457-1471 defines direct-dependency installed; 1778-1803 performs replacement and requires restart;
  // 1819-1838 cancellation joins settlement, while completed request IDs are not retained.
});
