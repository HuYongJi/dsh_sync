import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, deriveView, parseStatus, SettingsClientError, validateLogin } from '../client/state.mjs';

const START = Date.UTC(2026, 0, 1);
const iso = offset => new Date(START + offset).toISOString();
const PROJECT = { id: 'workspace-auth', projectId: 'project', label: 'Synthetic', root: 'E:\\synthetic-auth', selected: true, available: true };
const status = (patch = {}) => ({ revision: 1, server: 'https://auth.example.test', username: 'synthetic-owner', loggedIn: true,
  expiresAt: iso(5000), autoSync: false, intervalMs: 60000, projects: [{ ...PROJECT }], pending: 0, running: false, ...patch });
const ok = value => ({ ok: true, value });
const rejected = (code, secret = 'untrusted-secret-echo') => ({ ok: false, error: { code, message: secret, details: { password: secret, refreshToken: secret } } });
const login = patch => ({ server: 'https://auth.example.test/', username: ' synthetic-owner ', password: ' synthetic-password ', ...patch });
const deferred = () => Promise.withResolvers();
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function fakeClock() {
  let time = START, next = 0;
  const jobs = new Map();
  return {
    jobs, now: () => time,
    setTimeout(fn, ms) { assert.ok(Number.isFinite(ms) && ms >= 1 && ms <= 2_147_483_647); const id = ++next; jobs.set(id, { fn, ms, at: time + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      time += ms;
      for (let count = 0; ; count++) {
        assert.ok(count < 100, 'timer work must be bounded, not an expired-response busy loop');
        const due = [...jobs].filter(([, job]) => job.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]); due[1].fn(); await settle();
      }
    },
  };
}
function controlled(t, handler, extra = {}) {
  const clock = fakeClock(), calls = [];
  const connection = { rpc: { async call(channel, endpoint, payload, signal) {
    assert.equal(channel, '/api');
    const entry = { action: endpoint.split('/').at(-1), payload, signal }; calls.push(entry);
    return handler(entry, calls.length - 1);
  } } };
  const controller = createController(connection, { ...clock, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, ...extra });
  t.after(() => controller.dispose());
  return { controller, clock, calls, actions: () => calls.map(call => call.action) };
}

test('remember accepts only optional booleans and omitted login payload remains exactly legacy-shaped', () => {
  const expected = { server: 'https://auth.example.test', username: 'synthetic-owner', password: ' synthetic-password ' };
  assert.deepEqual(validateLogin(login()), expected);
  assert.deepEqual(validateLogin(login({ remember: undefined })), expected);
  for (const remember of [true, false]) assert.deepEqual(validateLogin(login({ remember })), { ...expected, remember });
  for (const remember of [null, 0, 1, '', 'true', [], {}]) assert.throws(() => validateLogin(login({ remember })), { code: 'BAD_REQUEST' });
});

test('login forwards remember once without retaining passwords, refresh proofs or response extensions', async t => {
  for (const remember of [undefined, false, true]) {
    const f = controlled(t, call => ok(call.action === 'login' ? status({ token: 'access-secret', refreshToken: 'refresh-secret', password: ' synthetic-password ', familyId: 'private-family' }) : status({ loggedIn: false })));
    await f.controller.refresh();
    assert.equal(await f.controller.login(login(remember === undefined ? {} : { remember })), true);
    assert.deepEqual(f.actions(), ['status', 'login']);
    assert.deepEqual(f.calls[1].payload, { server: 'https://auth.example.test', username: 'synthetic-owner', password: ' synthetic-password ', ...(remember === undefined ? {} : { remember }) });
    for (const value of [' synthetic-password ', 'access-secret', 'refresh-secret', 'private-family']) assert.equal(JSON.stringify(f.controller.getSnapshot()).includes(value), false);
    assert.equal(f.clock.jobs.size, 0, 'an unwatched controller does not start an expiry timer');
  }
});

test('renewal, managed-project and unsupported-server errors use safe fixed messages', async t => {
  for (const [code, message] of [
    ['AUTH_RENEWAL_UNCERTAIN', '续期结果未确认，请重新登录'],
    ['SYNC_CLIENT_UPGRADE_REQUIRED', '请先升级同步服务器'],
    ['SYNC_MANAGED_PROJECT', '此项目已启用双向同步，请使用双向同步操作'],
  ]) assert.equal(new SettingsClientError(code).message, message);
  const f = controlled(t, call => call.action === 'login' ? rejected('SYNC_CLIENT_UPGRADE_REQUIRED') : ok(status({ loggedIn: false })));
  await f.controller.refresh();
  assert.equal(await f.controller.login(login({ remember: true })), false);
  assert.deepEqual(f.actions(), ['status', 'login']);
  assert.deepEqual(f.controller.getSnapshot().error, { code: 'SYNC_CLIENT_UPGRADE_REQUIRED', message: '请先升级同步服务器' });
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret-echo'), false);
});

test('public auth status is a strict optional allowlist, never a credential proof channel', () => {
  const ordinary = parseStatus(status());
  assert.equal(Object.hasOwn(ordinary, 'authState'), false); assert.equal(Object.hasOwn(ordinary, 'reauthRequired'), false);
  for (const authState of ['reauth-required', 'renewable', 'legacy', 'signed-out']) {
    const result = parseStatus(status({ authState, reauthRequired: false, refreshToken: 'secret', serverId: 'private', authorizationEpoch: 99 }));
    assert.equal(result.authState, authState); assert.equal(result.reauthRequired, false);
    for (const field of ['refreshToken', 'serverId', 'authorizationEpoch']) assert.equal(Object.hasOwn(result, field), false);
  }
  for (const authState of ['arbitrary-secret', null, 0, {}]) assert.throws(() => parseStatus(status({ authState })), { code: 'INVALID_RESPONSE' });
  for (const reauthRequired of [null, 1, 'true', {}]) assert.throws(() => parseStatus(status({ reauthRequired })), { code: 'INVALID_RESPONSE' });
});

test('idle watched access expiry exposes signed-out state immediately and reconciles exactly once', async t => {
  const recovery = deferred(); let reads = 0;
  const f = controlled(t, () => ++reads === 1 ? ok(status({ autoSync: true })) : recovery.promise);
  const close = f.controller.watch(); await settle();
  assert.deepEqual(f.actions(), ['status']); assert.equal(f.clock.jobs.size, 1);
  await f.clock.advance(4999); assert.equal(reads, 1); assert.equal(f.controller.getSnapshot().status.loggedIn, true);
  await f.clock.advance(1);
  assert.deepEqual(f.actions(), ['status', 'status']);
  let snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.status.loggedIn, false); assert.equal(Object.hasOwn(snapshot.status, 'autoSync'), false); assert.equal(Object.hasOwn(snapshot, 'draft'), false);
  assert.equal(snapshot.refreshing, true); assert.equal(Object.hasOwn(snapshot, 'scheduled'), false);
  recovery.resolve(ok(status({ autoSync: true }))); await settle(); // stale Host still claims the expired token is valid
  snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.status.loggedIn, false); assert.equal(snapshot.ready, true); assert.equal(deriveView(snapshot).canLogin, true);
  assert.equal(f.clock.jobs.size, 0);
  await f.clock.advance(24 * 60 * 60_000); assert.equal(reads, 2);
  close(); assert.equal(f.clock.jobs.size, 0);
});

test('a genuinely renewed native expiry restores login at the old deadline without any write replay', async t => {
  let reads = 0;
  const f = controlled(t, () => ok(status({ expiresAt: ++reads === 1 ? iso(5000) : iso(20000), authState: 'renewable', autoSync: true })));
  const close = f.controller.watch(); await settle(); await f.clock.advance(5000);
  assert.equal(reads, 2); assert.equal(f.controller.getSnapshot().status.loggedIn, true);
  assert.equal(f.controller.getSnapshot().status.expiresAt, iso(20000)); assert.equal(Object.hasOwn(f.controller.getSnapshot(), 'draft'), false);
  assert.deepEqual(f.actions(), ['status', 'status']); assert.equal(f.clock.jobs.size, 1);
  await f.clock.advance(1000); assert.equal(reads, 2); close();
});

test('the same expired status, including timestamp aliases, cannot create a busy loop', async t => {
  let current = status({ expiresAt: iso(-1) });
  const f = controlled(t, () => ok(current));
  const close = f.controller.watch(); await settle();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false); assert.equal(f.clock.jobs.size, 0);
  current = status({ revision: 2, expiresAt: new Date(START - 1).toUTCString() });
  await f.controller.refresh(); await f.clock.advance(1_000_000);
  assert.deepEqual(f.actions(), ['status', 'status']); assert.equal(f.clock.jobs.size, 0);
  close();
});

test('expiry timers are watcher-owned, last-watcher teardown is idempotent, and disposal aborts a late read', async t => {
  const later = deferred(); let reads = 0;
  const f = controlled(t, () => ++reads < 4 ? ok(status()) : later.promise);
  await f.controller.refresh(); assert.equal(f.clock.jobs.size, 0);
  const closeOne = f.controller.watch(), closeTwo = f.controller.watch(); await settle();
  assert.equal(reads, 2); assert.equal(f.clock.jobs.size, 1);
  closeOne(); assert.equal(f.clock.jobs.size, 1); closeOne(); assert.equal(f.clock.jobs.size, 1);
  closeTwo(); assert.equal(f.clock.jobs.size, 0);
  await f.clock.advance(4000); assert.equal(reads, 2);
  f.controller.watch(); await settle(); assert.equal(reads, 3);
  await f.clock.advance(1000); assert.equal(reads, 4);
  f.controller.dispose(); assert.equal(f.calls.at(-1).signal.aborted, true);
  await settle(); assert.equal(f.clock.jobs.size, 0); // The aborted RPC clears its deadline in finally.
  later.resolve(ok(status({ expiresAt: iso(30000) }))); await settle();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false); assert.equal(f.clock.jobs.size, 0);
});

test('far-future expiry uses bounded local timer chunks, not idle network polling', async t => {
  const maximum = 2_147_483_647, deadline = maximum * 2 + 100;
  const f = controlled(t, () => ok(status({ expiresAt: iso(deadline) })));
  const close = f.controller.watch(); await settle();
  assert.equal([...f.clock.jobs.values()][0].ms, maximum);
  await f.clock.advance(maximum); assert.equal(f.calls.length, 1);
  await f.clock.advance(maximum); assert.equal(f.calls.length, 1);
  assert.equal([...f.clock.jobs.values()][0].ms, 100);
  await f.clock.advance(100); assert.equal(f.calls.length, 2); assert.equal(f.clock.jobs.size, 0);
  close();
});

test('an active logout keeps busy/cancel guards while expiry cannot interrupt or replay it', async t => {
  const pending = deferred();
  const f = controlled(t, call => call.action === 'logout' ? pending.promise : ok(status()));
  const close = f.controller.watch(); await settle();
  const loggingOut = f.controller.logout(); await settle();
  await f.clock.advance(5000);
  assert.deepEqual(f.actions(), ['status', 'logout']); assert.equal(f.calls[1].signal.aborted, false);
  assert.equal(f.controller.getSnapshot().busy, 'logout');
  assert.equal(await f.controller.logout(), false); assert.equal(await f.controller.login(login()), false);
  pending.resolve(ok(status({ loggedIn: false }))); assert.equal(await loggingOut, true);
  assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  await f.clock.advance(5000); assert.equal(f.calls.length, 2); assert.equal(f.clock.jobs.size, 0); close();
});

test('known auth rejection immediately shows login and performs one readonly reconciliation despite stale Host cache', async t => {
  for (const code of ['NOT_LOGGED_IN', 'AUTH_RENEWAL_UNCERTAIN']) {
    const recovery = deferred(); let reads = 0;
    const base = status({ expiresAt: iso(60_000), autoSync: true });
    const f = controlled(t, call => call.action === 'logout' ? rejected(code) : ++reads === 1 ? ok(base) : recovery.promise);
    const close = f.controller.watch(); await settle();
    const syncing = f.controller.logout(); await settle();
    assert.deepEqual(f.actions(), ['status', 'logout', 'status']);
    assert.equal(f.controller.getSnapshot().status.loggedIn, false); assert.equal(Object.hasOwn(f.controller.getSnapshot(), 'draft'), false);
    assert.equal(f.controller.getSnapshot().passwordUncertain, false); assert.equal(f.controller.getSnapshot().busy, 'logout');
    recovery.resolve(ok(base)); assert.equal(await syncing, false);
    let snapshot = f.controller.getSnapshot();
    assert.equal(snapshot.status.loggedIn, false); assert.equal(snapshot.error.code, code); assert.equal(deriveView(snapshot).canLogin, true);
    assert.equal(await f.controller.logout(), false); assert.equal(f.calls.filter(item => item.action === 'logout').length, 1);
    await f.clock.advance(120_000); assert.equal(reads, 2); assert.equal(f.clock.jobs.size, 0);
    assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('untrusted-secret-echo'), false);
    close();
  }
});

test('revision/authState/secret extensions cannot revive a rejected identity; a strictly newer future expiry can', async t => {
  let current = status({ expiresAt: iso(60_000), authState: 'renewable' });
  const f = controlled(t, call => call.action === 'logout' ? rejected('NOT_LOGGED_IN') : ok(current));
  await f.controller.refresh(); await f.controller.logout();
  for (const patch of [{ revision: 2 }, { revision: 3, authState: 'legacy' }, { token: 'fresh-looking-secret', refreshToken: 'untrusted' }, { expiresAt: iso(59_000) }, { expiresAt: undefined }]) {
    current = status({ expiresAt: iso(60_000), ...patch }); await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  }
  current = status({ expiresAt: iso(61_000), authState: 'renewable' }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, true); assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.calls.filter(item => item.action !== 'status').length, 1);
});

test('without prior public expiry the same rejected identity needs explicit login, not invented proof fields', async t => {
  let current = status({ expiresAt: undefined });
  const f = controlled(t, call => call.action === 'logout' ? rejected('NOT_LOGGED_IN') : ok(current));
  await f.controller.refresh(); await f.controller.logout();
  current = status({ expiresAt: iso(100000), authState: 'renewable', authorizationEpoch: 999 }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  assert.equal(await f.controller.login(login()), true);
  assert.equal(f.controller.getSnapshot().status.loggedIn, true);
});

test('failed relogin preserves the rejection latch; successful explicit login can reset an identical public expiry', async t => {
  let acceptLogin = false;
  const base = status({ expiresAt: iso(60_000) });
  const f = controlled(t, call => call.action === 'logout' ? rejected('AUTH_RENEWAL_UNCERTAIN')
    : call.action === 'login' && !acceptLogin ? rejected('LOGIN_FAILED') : ok(base));
  await f.controller.refresh(); await f.controller.logout();
  assert.equal(await f.controller.login(login({ remember: true })), false);
  assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  acceptLogin = true;
  assert.equal(await f.controller.login(login({ remember: true })), true);
  assert.equal(f.controller.getSnapshot().status.loggedIn, true); assert.equal(f.controller.getSnapshot().error, null);
  assert.deepEqual(f.actions(), ['status', 'logout', 'status', 'login', 'login']);
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes(' synthetic-password '), false);
});

test('failed auth reconciliation remains signed-out and unconfirmed, and disposal never accepts its late response', async t => {
  {
    let reads = 0;
    const f = controlled(t, call => call.action === 'logout' ? rejected('NOT_LOGGED_IN') : ++reads === 1 ? ok(status()) : Promise.reject(new Error('sensitive transport failure')));
    await f.controller.refresh(); await f.controller.logout();
    assert.equal(f.controller.getSnapshot().ready, false); assert.equal(f.controller.getSnapshot().status.loggedIn, false);
    assert.equal(f.controller.getSnapshot().error.code, 'NOT_LOGGED_IN'); assert.deepEqual(f.actions(), ['status', 'logout', 'status']);
  }
  {
    const recovery = deferred(); let reads = 0;
    const f = controlled(t, call => call.action === 'logout' ? rejected('AUTH_RENEWAL_UNCERTAIN') : ++reads === 1 ? ok(status()) : recovery.promise);
    await f.controller.refresh(); const syncing = f.controller.logout(); await settle();
    f.controller.dispose(); assert.equal(await syncing, false); assert.equal(f.calls.at(-1).signal.aborted, true);
    recovery.resolve(ok(status({ expiresAt: iso(100000) }))); await settle();
    assert.equal(f.controller.getSnapshot().status.loggedIn, false); assert.equal(f.clock.jobs.size, 0);
  }
});

test('native reauthentication state overrides loggedIn and cannot be bypassed by a newer but still paused expiry', async t => {
  let current = status({ authState: 'reauth-required', reauthRequired: true });
  const f = controlled(t, () => ok(current)); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  current = status({ expiresAt: iso(10000), authState: 'reauth-required', reauthRequired: true }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  current = status({ expiresAt: iso(10000), authState: 'renewable', reauthRequired: false }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false, 'same paused proof cannot be revived');
  current = status({ expiresAt: iso(20000), authState: 'renewable', reauthRequired: false }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, true);
});

test('auth rejection retains the latest revision and rejects old password identity without another write', async t => {
  let current = status({ expiresAt: iso(60_000) });
  const f = controlled(t, call => {
    if (call.action === 'logout') { current = { ...current, revision: 2 }; return rejected('NOT_LOGGED_IN'); }
    return ok(current);
  });
  await f.controller.refresh(); assert.equal(await f.controller.logout(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.status.revision, 2); assert.equal(snapshot.status.loggedIn, false);
  assert.equal(await f.controller.changePassword({ revision: 1, server: current.server, username: current.username }, { currentPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'new-password' }), false);
  assert.equal(f.controller.getSnapshot().error.code, 'CONFIG_CONFLICT');
  assert.deepEqual(f.actions(), ['status', 'logout', 'status']);
});

test('uncertain password writes remain stronger than new native expiry hints', async t => {
  let current = status({ expiresAt: iso(60_000) });
  const f = controlled(t, call => call.action === 'password' ? rejected('PASSWORD_CHANGE_UNCERTAIN') : ok(current));
  await f.controller.refresh();
  await f.controller.changePassword({ revision: 1, server: current.server, username: current.username }, { currentPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'new-password' });
  assert.equal(f.controller.getSnapshot().passwordUncertain, true);
  current = status({ expiresAt: iso(120_000) }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().status.loggedIn, false);
  assert.equal(await f.controller.login(login()), true); assert.equal(f.controller.getSnapshot().passwordUncertain, false);
});
