import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createConnectionTransport, createController, deriveView, filterProjects, normalizeServer, parseStatus, SettingsClientError, validateLogin, validatePreferences } from '../client/state.mjs';
import { createClientPlugin } from '../client/adapter.mjs';
import { bundleClient } from '../scripts/build-client.mjs';

const p1 = { id: 'workspace:alpha', label: '示例 Alpha', root: 'E:\\synthetic\\alpha', selected: false, available: true };
const p2 = { id: 'workspace:beta', label: '示例 Beta', root: 'E:\\synthetic\\beta', selected: false, available: true };
const lost = { id: 'workspace:lost', label: '失踪项目', root: 'E:\\synthetic\\missing', selected: true, available: false, warning: '目录不可用' };
const status = (extra = {}) => ({ revision: 0, server: '', username: '', loggedIn: false, autoSync: false, intervalMs: 60000,
  projects: [{ ...p1 }, { ...p2 }], pending: 0, running: false, ...extra });
const ok = value => ({ ok: true, value });
const failure = (code, message = 'Safe Host error') => ({ ok: false, error: { code, message, details: {} } });
function mockConnection(handler) {
  const calls = [];
  const connection = { rpc: { async call(channel, endpoint, payload, signal) {
    const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal };
    calls.push(call);
    return handler(call, calls.length - 1);
  } } };
  return { connection, calls };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 20; ++i) await Promise.resolve(); }
function timers() {
  let id = 0;
  const jobs = new Map();
  return { jobs,
    setTimeout(fn, ms) { const next = ++id; jobs.set(next, { fn, ms }); return next; },
    clearTimeout(key) { jobs.delete(key); },
    run(ms) { const entry = [...jobs].find(([, job]) => job.ms === ms); assert.ok(entry, `missing timer ${ms}`); jobs.delete(entry[0]); entry[1].fn(); },
  };
}
function controlled(t, handler, options = {}) {
  const mock = mockConnection(handler);
  const clock = timers();
  const controller = createController(mock.connection, { ...clock, ...options });
  t.after(() => controller.dispose());
  return { ...mock, clock, controller };
}

// These are synthetic Connection/React mocks, not a claim of live-GUI integration.
test('client origin validation permits HTTPS and explicit loopback HTTP, never credentials/routes', () => {
  for (const input of ['https://sync.example.test', ' https://sync.example.test/ ', 'http://localhost:8111', 'http://127.0.0.1:8111', 'http://[::1]:8111']) {
    assert.equal(normalizeServer(input), new URL(input.trim()).origin);
  }
  for (const input of ['', null, 'http://remote.example.test', 'http://localhost.evil.test', 'https://a:b@example.test', 'https://example.test/path', 'https://example.test/?x=1', 'https://example.test/#hash', 'https://example.test/?', 'https://example.test/#', 'https://example.test\\path', 'https://exam\nple.test', 'file:///E:/synthetic', '//example.test']) {
    assert.throws(() => normalizeServer(input), error => error.code === 'BAD_SERVER');
  }
});

test('client validates UTF-8 account/password bounds without trimming the secret', () => {
  assert.deepEqual(validateLogin({ server: 'https://sync.example.test/', username: ' alice ', password: ' secret ' }), { server: 'https://sync.example.test', username: 'alice', password: ' secret ' });
  for (const username of ['', '\n', '张'.repeat(43)]) assert.throws(() => validateLogin({ server: 'https://x.test', username, password: 'test' }), error => error.code === 'BAD_USERNAME');
  for (const password of ['', '界'.repeat(342), null]) assert.throws(() => validateLogin({ server: 'https://x.test', username: 'alice', password }), error => error.code === 'BAD_PASSWORD');
});

test('client public status uses a deep allowlist and defaults autoSync to false', () => {
  const input = status({ autoSync: undefined, token: 'must-not-retain', password: 'must-not-retain',
    projects: [{ ...p1, token: 'must-not-retain', password: 'must-not-retain' }],
    lastResult: { at: '2026-01-01T00:00:00.000Z', ok: true, message: '已完成', token: 'must-not-retain', password: 'must-not-retain' } });
  const parsed = parseStatus(input);
  assert.equal(parsed.autoSync, false);
  assert.equal(JSON.stringify(parsed).includes('must-not-retain'), false);
  assert.equal(Object.isFrozen(parsed.projects[0]), true);
  input.projects[0].root = 'changed';
  assert.equal(parsed.projects[0].root, p1.root);
  for (const bad of [status({ revision: -1 }), status({ running: 'false' }), status({ projects: [{ ...p1, available: undefined }] }), status({ projects: [p1, p1] }), status({ pending: NaN }), status({ intervalMs: 0 }), status({ autoSync: 'false' }), status({ server: 'https://u:p@x.test' }), status({ lastResult: { at: 'bad', ok: true, message: '' } })]) {
    assert.throws(() => parseStatus(bad), error => error.code === 'INVALID_RESPONSE');
  }
});

test('client preferences send revision and enumerated IDs only, never directory roots', () => {
  const current = parseStatus(status({ revision: 8, projects: [p1, lost] }));
  assert.deepEqual(validatePreferences(current, { revision: 8, autoSync: false, projectIds: [p1.id, lost.id], root: 'E:\\arbitrary' }), { revision: 8, autoSync: false, projectIds: [p1.id, lost.id] });
  for (const ids of [['E:\\arbitrary'], [p1.id, p1.id]]) assert.throws(() => validatePreferences(current, { revision: 8, autoSync: false, projectIds: ids }), error => error.code === 'UNKNOWN_PROJECT');
  assert.throws(() => validatePreferences(current, { revision: 7, autoSync: false, projectIds: [] }), error => error.code === 'CONFIG_CONFLICT');
  assert.throws(() => validatePreferences(parseStatus(status({ projects: [{ ...lost, selected: false }] })), { revision: 0, autoSync: false, projectIds: [lost.id] }), error => error.code === 'PROJECT_UNAVAILABLE');
  assert.throws(() => validatePreferences(current, { revision: 8, autoSync: true, projectIds: [] }), error => error.code === 'NOT_LOGGED_IN');
});

test('client uses only native Connection RPC and rejects arbitrary actions', async () => {
  const { connection, calls } = mockConnection(() => ok({ scheduled: true }));
  const transport = createConnectionTransport(connection);
  const abort = new AbortController();
  assert.deepEqual(await transport('sync', {}, abort.signal), { scheduled: true });
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].endpoint, 'dsh-personal-sync/sync');
  assert.equal(calls[0].signal, abort.signal);
  await assert.rejects(() => transport('http://localhost:9000/bypass', {}, abort.signal), error => error.code === 'BAD_REQUEST');
  await assert.rejects(() => createConnectionTransport({})('status', {}, abort.signal), error => error.code === 'CONNECTION_UNAVAILABLE');
  assert.equal(calls.length, 1);
});

test('client starts inert, unsigned and with automatic sync off', async t => {
  const { controller, calls } = controlled(t, () => ok(status()));
  assert.equal(controller.getSnapshot().draft.autoSync, false);
  assert.equal(controller.getSnapshot().ready, false);
  assert.equal(calls.length, 0);
  assert.equal(await controller.sync(), false);
  await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canSync, false);
  assert.equal(await controller.sync(), false);
  assert.equal(controller.getSnapshot().error.code, 'NOT_LOGGED_IN');
  assert.equal(controller.setAutoSync(true), false);
  assert.equal(calls.length, 1);
});

test('client login never retains a password or triggers an implicit upload', async t => {
  const loginResult = deferred();
  const { controller, calls } = controlled(t, call => call.action === 'login' ? loginResult.promise : ok(status()));
  await controller.refresh();
  const secret = 'synthetic-only-secret';
  const action = controller.login({ server: 'https://sync.example.test', username: 'alice', password: secret });
  assert.equal(controller.getSnapshot().busy, 'login');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false);
  assert.equal(calls.at(-1).payload.password, secret);
  loginResult.resolve(ok(status({ loggedIn: true, server: 'https://sync.example.test', username: 'alice', token: secret, password: secret })));
  assert.equal(await action, true);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'login']);
  assert.equal(controller.getSnapshot().draft.autoSync, false);
});

test('client ignores arbitrary exception and Host error messages, including secret echoes', async t => {
  const { controller } = controlled(t, call => call.action === 'status' ? ok(status()) : failure('LOGIN_FAILED', 'synthetic-password-and-token'));
  await controller.refresh();
  await controller.login({ server: 'https://sync.example.test', username: 'alice', password: 'synthetic-password-and-token' });
  assert.equal(controller.getSnapshot().error.code, 'LOGIN_FAILED');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('synthetic-password-and-token'), false);
  const second = controlled(t, () => { throw new Error('synthetic-password-and-token'); });
  await second.controller.refresh();
  assert.equal(second.controller.getSnapshot().error.code, 'REQUEST_FAILED');
  assert.equal(JSON.stringify(second.controller.getSnapshot()).includes('synthetic-password-and-token'), false);
});

test('client maps Connection admission/not-installed/service HTTP failures to safe Chinese notices', async t => {
  for (const [http, code] of [[400, 'BAD_REQUEST'], [401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'NOT_DEPLOYED'], [409, 'CONFLICT'], [503, 'SERVICE_UNAVAILABLE']]) {
    const { controller } = controlled(t, () => { throw new Error(`transport failure for /api/dsh-personal-sync/status: HTTP ${http}`); });
    await controller.refresh();
    assert.equal(controller.getSnapshot().error.code, code);
    assert.equal(controller.getSnapshot().ready, false);
    assert.match(controller.getSnapshot().error.message, /[\u4e00-\u9fff]/u);
  }
});

test('client search/full-select respects Host availability and missing selected projects can only be removed', async t => {
  const { controller, calls } = controlled(t, () => ok(status({ projects: [p1, p2, lost] })));
  await controller.refresh();
  assert.deepEqual(filterProjects([p1, p2], 'BETA'), [p2]);
  assert.deepEqual(filterProjects([p1, p2], 'synthetic\\alpha'), [p1]);
  controller.selectVisible('Alpha', true);
  assert.deepEqual(controller.getSnapshot().draft.projectIds, [lost.id, p1.id]);
  controller.setProject(lost.id, false);
  assert.equal(controller.setProject(lost.id, true), false);
  controller.selectVisible('', true);
  assert.deepEqual(new Set(controller.getSnapshot().draft.projectIds), new Set([p1.id, p2.id]));
  controller.selectVisible('alpha', false);
  assert.deepEqual(controller.getSnapshot().draft.projectIds, [p2.id]);
  assert.equal(controller.setProject('E:\\arbitrary', true), false);
  assert.equal(calls.length, 1);
});

test('client saving selection is explicit and never calls sync', async t => {
  const { controller, calls } = controlled(t, call => call.action === 'preferences'
    ? ok(status({ revision: 1, projects: [{ ...p1, selected: true }, p2] })) : ok(status()));
  await controller.refresh();
  controller.setProject(p1.id, true);
  assert.equal(calls.length, 1);
  assert.equal(controller.getSnapshot().dirty, true);
  assert.equal(await controller.savePreferences(), true);
  assert.deepEqual(calls.at(-1).payload, { revision: 0, autoSync: false, projectIds: [p1.id] });
  assert.equal(controller.getSnapshot().dirty, false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'preferences']);
});

test('client CONFIG_CONFLICT requires a fresh status and re-selection before retry', async t => {
  let current = status({ revision: 1, loggedIn: true });
  let writes = 0;
  const { controller, calls } = controlled(t, call => {
    if (call.action === 'status') return ok(current);
    if (++writes === 1) { current = status({ revision: 2, loggedIn: true, projects: [p1, { ...p2, selected: true }] }); return failure('CONFIG_CONFLICT'); }
    return ok({ ...current, revision: 3, projects: [{ ...p1, selected: true }, { ...p2, selected: true }] });
  });
  await controller.refresh();
  controller.setProject(p1.id, true);
  assert.equal(await controller.savePreferences(), false);
  assert.equal(controller.getSnapshot().conflict, true);
  assert.equal(await controller.savePreferences(), false);
  assert.equal(writes, 1);
  await controller.refresh();
  assert.equal(controller.getSnapshot().conflict, false);
  assert.equal(controller.getSnapshot().draft.revision, 2);
  assert.deepEqual(controller.getSnapshot().draft.projectIds, [p2.id]);
  controller.setProject(p1.id, true);
  await controller.savePreferences();
  assert.equal(calls.at(-1).payload.revision, 2);
  assert.equal(controller.getSnapshot().dirty, false);
});

test('client refresh never silently rebases dirty preferences onto a different revision', async t => {
  let current = status({ revision: 1, loggedIn: true });
  const { controller } = controlled(t, () => ok(current));
  await controller.refresh();
  controller.setProject(p1.id, true);
  current = status({ revision: 2, loggedIn: true, autoSync: true });
  await controller.refresh();
  assert.equal(controller.getSnapshot().draft.revision, 1);
  assert.equal(controller.getSnapshot().draft.autoSync, false);
  assert.equal(controller.getSnapshot().conflict, true);
  assert.equal(deriveView(controller.getSnapshot()).canSave, false);
  await controller.refresh();
  assert.equal(controller.getSnapshot().draft.revision, 2);
  assert.equal(controller.getSnapshot().draft.autoSync, true);
});

test('client conflict blocks upload even when external preferences now match the old draft', async t => {
  let current = status({ revision: 1, loggedIn: true });
  const { controller, calls } = controlled(t, () => ok(current));
  await controller.refresh();
  controller.setProject(p1.id, true);
  current = status({ revision: 2, loggedIn: true, projects: [{ ...p1, selected: true }, p2] });
  await controller.refresh();
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.getSnapshot().conflict, true);
  assert.equal(deriveView(controller.getSnapshot()).canSync, false);
  assert.equal(await controller.sync(), false);
  assert.equal(calls.length, 2);
});

test('client retries selected projects with offline or deselected pending queues and autoSync off', async t => {
  const base = status({ loggedIn: true, autoSync: false, pending: 3, projects: [{ ...p1, selected: true }, p2] });
  let reads = 0;
  const { controller, calls } = controlled(t, call => call.action === 'sync' ? ok({ scheduled: true })
    : ok(++reads === 1 ? base : { ...base, running: true }));
  await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canSync, true);
  assert.equal(await controller.sync(), true);
  assert.deepEqual(calls.find(call => call.action === 'sync').payload, {});
  assert.equal(controller.getSnapshot().status.autoSync, false);
  assert.equal(controller.getSnapshot().status.running, true);
  assert.equal(deriveView(controller.getSnapshot()).canSync, false);
});

test('client permits preferences during running sync but blocks re-login and duplicate sync', async t => {
  const saveResult = deferred();
  const base = status({ loggedIn: true, autoSync: true, running: true, pending: 3,
    projects: [{ ...p1, selected: true }, { ...p2, selected: true }] });
  const { controller, calls } = controlled(t, call => call.action === 'preferences' ? saveResult.promise : ok(base));
  await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).editable, true);
  assert.equal(deriveView(controller.getSnapshot()).canLogout, true);
  assert.equal(deriveView(controller.getSnapshot()).canLogin, false);
  assert.equal(await controller.login({ server: 'https://sync.example.test', username: 'alice', password: 'synthetic-only' }), false);
  assert.equal(await controller.sync(), false);
  assert.equal(calls.length, 1);
  assert.equal(controller.setProject(p2.id, false), true);
  assert.equal(controller.setAutoSync(false), true);
  assert.equal(deriveView(controller.getSnapshot()).canSave, true);
  const save = controller.savePreferences();
  assert.equal(controller.getSnapshot().busy, 'preferences');
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false);
  assert.deepEqual(calls.at(-1).payload, { revision: 0, autoSync: false, projectIds: [p1.id] });
  saveResult.resolve(ok({ ...base, revision: 1, autoSync: false, running: false, projects: [{ ...p1, selected: true }, p2] }));
  assert.equal(await save, true);
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(deriveView(controller.getSnapshot()).canSync, true);
  assert.deepEqual(calls.map(call => call.action), ['status', 'preferences']);
});

test('client logout remains available during running sync and waits for Host acknowledgement', async t => {
  const logoutResult = deferred();
  const { controller, calls } = controlled(t, call => call.action === 'logout' ? logoutResult.promise
    : ok(status({ loggedIn: true, autoSync: true, running: true, projects: [{ ...p1, selected: true }] })));
  await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canLogout, true);
  const logout = controller.logout();
  assert.equal(controller.getSnapshot().busy, 'logout');
  assert.deepEqual(calls.at(-1).payload, {});
  logoutResult.resolve(ok(status({ pending: 1 })));
  assert.equal(await logout, true);
  assert.equal(controller.getSnapshot().status.loggedIn, false);
  assert.equal(controller.getSnapshot().scheduled, false);
});

test('client PROTECTED_QUEUE is an explicit safe warning, never an instruction to upload the queue', async t => {
  const { controller, calls } = controlled(t, call => call.action === 'sync' ? failure('PROTECTED_QUEUE', 'untrusted secret path')
    : ok(status({ loggedIn: true, pending: 1, projects: [{ ...p1, selected: true }] })));
  await controller.refresh();
  assert.equal(await controller.sync(), false);
  assert.equal(controller.getSnapshot().error.code, 'PROTECTED_QUEUE');
  assert.match(controller.getSnapshot().error.message, /保留.*不会上传/);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted secret path'), false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'sync']);
});

test('client serializes actions, blocks edits while busy and never invents project roots', async t => {
  const pending = deferred();
  const { controller, calls } = controlled(t, call => call.action === 'preferences' ? pending.promise : ok(status({ loggedIn: true })));
  await controller.refresh();
  controller.setProject(p1.id, true);
  const save = controller.savePreferences();
  assert.equal(controller.getSnapshot().busy, 'preferences');
  assert.equal(controller.setProject(p2.id, true), false);
  assert.equal(await controller.sync(), false);
  assert.equal(await controller.logout(), false);
  assert.equal(await controller.refresh(), false);
  assert.equal(calls.length, 2);
  pending.resolve(ok(status({ revision: 1, loggedIn: true, projects: [{ ...p1, selected: true }, p2] })));
  await save;
  assert.equal(controller.getSnapshot().busy, null);
  assert.equal(await controller.sync('E:\\arbitrary'), false);
  assert.equal(calls.length, 2);
});

test('client refuses upload of unsaved selections and empty/unavailable projects', async t => {
  const { controller, calls } = controlled(t, () => ok(status({ loggedIn: true, projects: [p1, lost] })));
  await controller.refresh();
  assert.equal(await controller.sync(), false);
  assert.equal(controller.getSnapshot().error.code, 'NO_PROJECTS');
  controller.setProject(p1.id, true);
  assert.equal(await controller.sync(), false);
  assert.equal(controller.getSnapshot().error.code, 'UNSAVED_CHANGES');
  assert.equal(calls.length, 1);
});

test('client ignores late superseded status responses', async t => {
  const first = deferred();
  const { controller, calls } = controlled(t, (_call, index) => index === 0 ? first.promise : ok(status({ revision: 2 })));
  const old = controller.refresh();
  await controller.refresh();
  assert.equal(calls[0].signal.aborted, true);
  first.resolve(ok(status({ revision: 1, loggedIn: true, autoSync: true })));
  await old;
  assert.equal(controller.getSnapshot().status.revision, 2);
  assert.equal(controller.getSnapshot().status.loggedIn, false);
});

test('client only polls mounted unfinished work, preserves same-revision drafts and stops when closed', async t => {
  const { controller, clock, calls } = controlled(t, () => ok(status({ loggedIn: true, pending: 1 })));
  const close = controller.watch();
  await settle();
  assert.equal(calls.length, 1);
  controller.setProject(p1.id, true);
  clock.run(10000);
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(controller.getSnapshot().draft.projectIds, [p1.id]);
  assert.equal(controller.getSnapshot().dirty, true);
  close();
  assert.equal(clock.jobs.size, 0);
  await controller.refreshIfWatching();
  assert.equal(calls.length, 2);
  close(); // Strict-mode cleanup is idempotent.
});

test('client accepted sync is not success; it polls native status to show the eventual result', async t => {
  let reads = 0;
  const base = status({ loggedIn: true, projects: [{ ...p1, selected: true }] });
  const { controller, clock, calls } = controlled(t, call => {
    if (call.action === 'sync') return ok({ scheduled: true });
    ++reads;
    return ok(reads === 1 ? base : reads === 2 ? { ...base, running: true }
      : { ...base, lastResult: { at: '2026-01-01T00:00:00.000Z', ok: false, message: '部分项目未完成' } });
  });
  const close = controller.watch();
  await settle();
  assert.equal(await controller.sync(p1.id), true);
  assert.deepEqual(calls.find(call => call.action === 'sync').payload, { projectId: p1.id });
  assert.equal(controller.getSnapshot().scheduled, true);
  assert.equal(controller.getSnapshot().status.running, true);
  assert.equal(deriveView(controller.getSnapshot()).canSync, false);
  clock.run(3000);
  await settle();
  assert.equal(controller.getSnapshot().scheduled, false);
  assert.equal(controller.getSnapshot().status.lastResult.ok, false);
  assert.equal(clock.jobs.size, 0);
  close();
});

test('client active-job completion releases scheduled even if old checkpoints remain pending', async t => {
  let reads = 0;
  const base = status({ loggedIn: true, pending: 4, projects: [{ ...p1, selected: true }] });
  const { controller, clock } = controlled(t, call => call.action === 'sync' ? ok({ scheduled: true })
    : ok(++reads === 2 ? { ...base, running: true } : base));
  const close = controller.watch();
  await settle();
  await controller.sync();
  assert.equal(controller.getSnapshot().scheduled, true);
  clock.run(3000);
  await settle();
  assert.equal(controller.getSnapshot().status.pending, 4);
  assert.equal(controller.getSnapshot().scheduled, false);
  assert.equal(deriveView(controller.getSnapshot()).canSync, true);
  close();
});

test('client saving while scheduled waits for Host cancellation and clears the submission latch', async t => {
  const base = status({ loggedIn: true, autoSync: true, projects: [{ ...p1, selected: true }] });
  const { controller } = controlled(t, call => call.action === 'sync' ? ok({ scheduled: true })
    : call.action === 'preferences' ? ok({ ...base, revision: 1, autoSync: false }) : ok(base));
  await controller.refresh();
  await controller.sync();
  assert.equal(controller.getSnapshot().scheduled, true);
  assert.equal(controller.setAutoSync(false), true);
  assert.equal(await controller.savePreferences(), true);
  assert.equal(controller.getSnapshot().scheduled, false);
  assert.equal(deriveView(controller.getSnapshot()).canSync, true);
});

test('client timeout cancels the carrier and never automatically repeats a mutation', async t => {
  const { controller, calls, clock } = controlled(t, call => call.action === 'status' ? ok(status())
    : new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('synthetic secret')), { once: true })));
  await controller.refresh();
  const login = controller.login({ server: 'https://sync.example.test', username: 'alice', password: 'synthetic secret' });
  clock.run(60000);
  assert.equal(await login, false);
  assert.equal(calls.at(-1).signal.aborted, true);
  assert.equal(controller.getSnapshot().error.code, 'TIMEOUT');
  assert.equal(controller.getSnapshot().ready, false);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('synthetic secret'), false);
  assert.equal(calls.length, 2);
});

test('client logout uses an empty body, retains only public warning and disables upload', async t => {
  const { controller, calls } = controlled(t, call => ok(call.action === 'logout'
    ? status({ warning: '本机已退出，无法确认云端撤销。', token: 'synthetic-token' }) : status({ loggedIn: true, projects: [{ ...p1, selected: true }] })));
  await controller.refresh();
  assert.equal(await controller.logout(), true);
  assert.deepEqual(calls.at(-1).payload, {});
  assert.equal(controller.getSnapshot().status.loggedIn, false);
  assert.equal(controller.getSnapshot().status.warning, '本机已退出，无法确认云端撤销。');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('synthetic-token'), false);
  assert.equal(deriveView(controller.getSnapshot()).canSync, false);
});

test('client disposal aborts in-flight status and drops late delivery', async t => {
  const late = deferred();
  const { controller, calls, clock } = controlled(t, () => late.promise);
  const read = controller.refresh();
  controller.dispose();
  assert.equal(calls[0].signal.aborted, true);
  late.resolve(ok(status({ loggedIn: true })));
  await read;
  assert.equal(controller.getSnapshot().status, null);
  assert.equal(clock.jobs.size, 0);
  assert.equal(await controller.login({}), false);
});

function mockReact() {
  const cells = [];
  let cursor = 0;
  let effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    useId() { return 'mock-settings'; },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = value; }]; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!cells[index] || deps.some((value, at) => value !== cells[index].deps[at])) {
        const item = { deps, effect, cleanup: cells[index]?.cleanup };
        cells[index] = item;
        effects.push(item);
      }
    },
  };
  return { React,
    render(Component, props) { cursor = 0; return Component(props); },
    mountEffects() { const pending = effects; effects = []; for (const effect of pending) { effect.cleanup?.(); effect.cleanup = effect.effect(); } },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
  };
}
function nodes(root) {
  if (!root || typeof root !== 'object') return [];
  return [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)];
}
function renderedText(root) {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (!root || typeof root !== 'object') return '';
  return (root.props?.children ?? []).map(renderedText).join(' ');
}
// Native Modal children/footers are a separate surface, even in this non-DOM mock.
function mainNodes(root) {
  if (!root || typeof root !== 'object' || root.type === 'native:Modal') return [];
  return [root, ...(root.props?.children ?? []).flatMap(mainNodes)];
}
function button(root, label) {
  const found = nodes(root).find(node => node.type === 'native:Button' && renderedText(node) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
function mainButton(root, label) {
  const found = mainNodes(root).find(node => node.type === 'native:Button' && renderedText(node) === label);
  assert.ok(found, `missing main-page button: ${label}`);
  return found;
}
function projectModal(page) {
  return nodes(page.tree()).find(node => node.type === 'native:Modal' && node.props.title === '管理同步项目');
}
function openProjects(page) {
  const manage = mainButton(page.tree(), '管理');
  assert.equal(manage.props.disabled, false);
  manage.props.onClick();
  const modal = projectModal(page);
  assert.ok(modal);
  assert.equal(modal.props.open, true);
  return modal;
}
function projectCheckbox(modal, project) {
  const checkbox = nodes(modal).find(node => node.type === 'native:Checkbox'
    && [project.label, `${project.label} · 不可用`].includes(node.props.label));
  assert.ok(checkbox, `missing checkbox: ${project.label}`);
  return checkbox;
}
function searchProjects(page, query) {
  const input = nodes(projectModal(page)).find(node => node.type === 'native:Input' && node.props.type === 'search');
  assert.ok(input);
  input.props.onChange({ target: { value: query } });
  return projectModal(page);
}
function summary(page) {
  const card = mainNodes(page.tree()).find(node => node.props['data-personal-sync'] === 'projects-summary');
  assert.ok(card);
  return card;
}
async function mounted(page) {
  await page.controller.refresh();
  page.tree(); page.mountEffects(); await settle();
  return page.tree();
}
function assertLoginForm(tree, prefix = 'mock-settings') {
  const controls = mainNodes(tree);
  assert.equal(controls.filter(node => node.type === 'form').length, 1);
  for (const field of ['server', 'username', 'password']) {
    assert.ok(controls.find(node => node.type === 'native:Input' && node.props.id === `${prefix}-${field}`));
  }
  assert.ok(mainButton(tree, '登录'));
  const input = controls.find(node => node.type === 'native:Input' && node.props.id === `${prefix}-password`);
  assert.equal(Object.hasOwn(input.props, 'value'), false);
  assert.equal(Object.hasOwn(input.props, 'defaultValue'), false);
  assert.equal(input.props.ref.current?.value ?? '', '');
  return input;
}
function setupPage(t, handler) {
  const hooks = mockReact();
  const primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const required = [];
  const plugin = createClientPlugin(name => { required.push(name); if (name === 'react') return hooks.React; if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives; throw new Error('unexpected dependency'); });
  const mock = mockConnection(handler);
  const cleanups = [];
  const events = new Map();
  let slot;
  plugin.apply({ connection: mock.connection,
    effect(effect) { const cleanup = effect(); cleanups.push(cleanup); return cleanup; },
    on(name, listener) { events.set(name, listener); },
    slots: { inject(name, register) { assert.equal(name, 'settings.section'); register(); }, register(spec, Component) { slot = { spec, Component }; return () => {}; } },
  });
  const props = slot.spec.inject();
  t.after(() => { hooks.unmount(); cleanups.forEach(cleanup => cleanup?.()); });
  return { ...mock, ...hooks, required, plugin, slot, controller: props.controller, events, tree: () => hooks.render(slot.Component, props) };
}

test('client adapter registers the real native settings slot and only requires Host React/primitives', async t => {
  const page = setupPage(t, () => ok(status()));
  assert.deepEqual(page.required, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.deepEqual(page.plugin.inject, ['slots', 'connection']);
  assert.equal(page.slot.spec.id, 'dsh-personal-sync');
  assert.equal(page.slot.spec.name, 'settings.section');
  assert.equal(page.slot.spec.label(), '个人云同步');
  assert.equal(page.calls.length, 0);
  const initial = page.tree();
  assert.equal(mainButton(initial, '管理').props.disabled, true);
  assert.equal(nodes(initial).some(node => node.type === 'native:Checkbox' || node.props.type === 'search'), false);
  page.mountEffects(); await settle();
  const tree = page.tree();
  assert.equal(nodes(tree).some(node => node.type === 'aside' || (node.type !== 'native:Modal' && node.props?.title) || node.props?.description), false);
  assert.doesNotMatch(renderedText(tree), /默认关闭|同步前请确认|项目文件与会话归档|不会默认|服务器（server）|账号（username）|密码（password）/);
  assert.match(renderedText(tree), /个人云同步/);
  assert.equal(nodes(tree).find(node => node.type === 'native:Switch').props.checked, false);
  assert.equal(nodes(tree).find(node => node.type === 'native:Switch').props.disabled, true);
  assert.equal(nodes(tree).find(node => node.type === 'native:Button' && renderedText(node) === '立即同步').props.disabled, true);
});

test('client adapter has an uncontrolled secret field cleared immediately, on completion, blur and unmount', async t => {
  const login = deferred();
  const page = setupPage(t, call => call.action === 'login' ? login.promise : ok(status({ server: 'https://sync.example.test', username: 'alice' })));
  await page.controller.refresh();
  let tree = page.tree();
  page.mountEffects(); await settle(); tree = page.tree();
  const secretInput = nodes(tree).find(node => node.type === 'native:Input' && node.props.type === 'password');
  assert.equal(Object.hasOwn(secretInput.props, 'value'), false);
  assert.equal(secretInput.props.autoComplete, 'off');
  secretInput.props.ref.current = { value: 'synthetic-ui-secret' };
  const form = nodes(tree).find(node => node.type === 'form');
  let prevented = false;
  form.props.onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(secretInput.props.ref.current.value, '');
  assert.equal(page.calls.at(-1).payload.password, 'synthetic-ui-secret');
  assert.equal(JSON.stringify(page.controller.getSnapshot()).includes('synthetic-ui-secret'), false);
  secretInput.props.ref.current.value = 'synthetic-ui-secret';
  login.resolve(failure('LOGIN_FAILED', 'synthetic-ui-secret')); await settle();
  assert.equal(secretInput.props.ref.current.value, '');
  secretInput.props.ref.current.value = 'synthetic-ui-secret';
  form.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
  assert.equal(secretInput.props.ref.current.value, 'synthetic-ui-secret');
  form.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert.equal(secretInput.props.ref.current.value, '');
  secretInput.props.ref.current.value = 'synthetic-ui-secret';
  page.unmount();
  assert.equal(secretInput.props.ref.current.value, '');
});

test('client adapter clears an unsubmitted password before replacing the Host server or account', async t => {
  let current = status({ server: 'https://old.example.test', username: 'old-account' });
  const page = setupPage(t, () => ok(current));
  await page.controller.refresh();
  page.tree(); page.mountEffects(); await settle();
  let tree = page.tree();
  const secret = nodes(tree).find(node => node.type === 'native:Input' && node.props.type === 'password').props.ref;
  secret.current = { value: 'synthetic-old-destination-secret' };
  current = status({ server: 'https://new.example.test', username: 'new-account' });
  await page.controller.refresh();
  page.tree(); page.mountEffects();
  tree = page.tree();
  assert.equal(secret.current.value, '');
  assert.equal(nodes(tree).find(node => node.type === 'native:Input' && node.props.type === 'url').props.value, current.server);
  assert.equal(nodes(tree).find(node => node.type === 'native:Input' && node.props.id === 'mock-settings-username').props.value, current.username);
  secret.current.value = 'synthetic-same-server-old-account-secret';
  current = { ...current, username: 'another-account' };
  await page.controller.refresh();
  page.tree(); page.mountEffects();
  assert.equal(secret.current.value, '');
  assert.equal(page.calls.some(call => call.action === 'login'), false);
});

test('client adapter unmounts all login fields on a same-identity logged-in transition and clears the secret', async t => {
  let current = status({ server: 'https://saved.example.test', username: 'saved-account' });
  const page = setupPage(t, () => ok(current));
  let tree = await mounted(page);
  const input = assertLoginForm(tree);
  const usernameInput = mainNodes(tree).find(node => node.type === 'native:Input' && node.props.id === 'mock-settings-username');
  usernameInput.props.onChange({ target: { value: 'unsubmitted-account' } });
  input.props.ref.current = { value: 'synthetic-unsubmitted-login-secret' };
  current = { ...current, loggedIn: true }; // No server, username, revision or busy transition.
  await page.controller.refresh();
  assert.equal(input.props.ref.current.value, '');
  tree = page.tree(); page.mountEffects(); tree = page.tree();
  const controls = mainNodes(tree);
  assert.equal(controls.some(node => node.type === 'form'), false);
  assert.equal(controls.some(node => node.type === 'native:Input'), false);
  assert.equal(controls.some(node => node.type === 'native:Button' && /^(重新)?登录$/.test(renderedText(node))), false);
  assert.ok(renderedText(tree).includes(current.username));
  assert.equal(renderedText(tree).includes('unsubmitted-account'), false);
  assert.equal(renderedText(tree).includes(current.server), false);
  assert.equal(mainButton(tree, '修改密码').props.disabled, false);
  assert.equal(mainButton(tree, '退出登录').props.disabled, false);
  current = { ...current, loggedIn: false }; // Expiry restores inputs without reviving a secret.
  await page.controller.refresh();
  tree = page.tree(); page.mountEffects(); tree = page.tree();
  assertLoginForm(tree);
  assert.equal(input.props.ref.current.value, '');
  assert.equal(JSON.stringify(page.controller.getSnapshot()).includes('synthetic-unsubmitted-login-secret'), false);
  assert.equal(page.calls.every(call => call.action === 'status'), true);
});

test('client adapter successful login shows the saved username and logout restores an empty login form', async t => {
  const login = deferred();
  const loggedOut = status({ server: 'https://saved.example.test', username: 'saved-account' });
  const page = setupPage(t, call => call.action === 'login' ? login.promise
    : ok(call.action === 'logout' ? { ...loggedOut, revision: 2 } : loggedOut));
  const tree = await mounted(page);
  const input = assertLoginForm(tree);
  input.props.ref.current = { value: 'synthetic-login-transition-secret' };
  mainNodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(input.props.ref.current.value, '');
  assert.equal(page.calls.at(-1).payload.password, 'synthetic-login-transition-secret');
  input.props.ref.current.value = 'synthetic-typed-during-login';
  login.resolve(ok({ ...loggedOut, revision: 1, loggedIn: true }));
  await settle();
  assert.equal(input.props.ref.current.value, '');
  assert.equal(mainNodes(page.tree()).some(node => node.type === 'native:Input' || node.type === 'form'), false);
  assert.ok(renderedText(page.tree()).includes(loggedOut.username));
  const beforeLogout = page.calls.length;
  mainButton(page.tree(), '退出登录').props.onClick();
  const modal = nodes(page.tree()).find(node => node.type === 'native:Modal' && node.props.title === '退出登录？');
  assert.equal(modal.props.open, true);
  assert.equal(page.calls.length, beforeLogout);
  button(modal, '退出登录').props.onClick();
  await settle();
  assertLoginForm(page.tree());
  assert.equal(page.controller.getSnapshot().status.loggedIn, false);
  assert.equal(page.calls.filter(call => call.action === 'login').length, 1);
  assert.equal(page.calls.filter(call => call.action === 'logout').length, 1);
  assert.equal(page.calls.some(call => call.action === 'sync' || call.action === 'preferences'), false);
});

test('client adapter keeps running-sync cancellation and main-page safety controls usable', async t => {
  const base = status({ loggedIn: true, autoSync: true, running: true,
    projects: [{ ...p1, selected: true }, { ...p2, selected: true }] });
  const page = setupPage(t, call => ok(call.action === 'preferences'
    ? { ...base, revision: 1, autoSync: false, running: false, projects: [{ ...p1, selected: true }, p2] } : base));
  await page.controller.refresh();
  let tree = page.tree();
  const controls = mainNodes(tree);
  const autoSync = controls.find(node => node.type === 'native:Switch');
  assert.equal(autoSync.props.disabled, false);
  assert.equal(controls.some(node => node.type === 'native:Checkbox'), false);
  assert.equal(mainButton(tree, '退出登录').props.disabled, false);
  assert.equal(controls.some(node => node.type === 'native:Button' && /^(重新)?登录$/.test(renderedText(node))), false);
  assert.equal(mainButton(tree, '立即同步').props.disabled, true);
  const statusCard = controls.find(node => node.type === 'section' && node.props['aria-labelledby'] === 'mock-settings-status-title');
  assert.ok(nodes(statusCard).includes(autoSync));
  assert.equal(nodes(summary(page)).some(node => node.type === 'native:Switch'), false);
  const modal = openProjects(page);
  const checkbox = projectCheckbox(modal, p2);
  assert.equal(checkbox.props.checked, true);
  assert.equal(checkbox.props.disabled, false);
  checkbox.props.onChange(false);
  assert.deepEqual(page.controller.getSnapshot().draft.projectIds, [p1.id]);
  button(projectModal(page), '关闭').props.onClick();
  autoSync.props.onChange(false);
  tree = page.tree();
  assert.equal(mainButton(tree, '保存').props.disabled, false);
  assert.equal(mainButton(tree, '撤销更改').props.disabled, false);
  assert.match(renderedText(tree), /未保存/);
  assert.doesNotMatch(renderedText(tree), /不可撤回|不能撤回|停止后续上传|保存后生效|默认|刷新未完成|轮询/);
  assert.equal(nodes(tree).some(node => node.props?.description || (node.type !== 'native:Modal' && node.props?.title)), false);
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
  mainButton(tree, '保存').props.onClick();
  await settle();
  assert.deepEqual(page.calls.at(-1).payload, { revision: 0, autoSync: false, projectIds: [p1.id] });
  assert.deepEqual(page.calls.map(call => call.action), ['status', 'preferences']);
  assert.equal(page.controller.getSnapshot().dirty, false);
});

test('client adapter exposes manual retry while pending and automatic sync is off', async t => {
  const page = setupPage(t, () => ok(status({ loggedIn: true, autoSync: false, pending: 3, projects: [{ ...p1, selected: true }, p2] })));
  await page.controller.refresh();
  const tree = page.tree();
  const retry = nodes(tree).find(node => node.type === 'native:Button' && renderedText(node) === '立即同步');
  assert.equal(retry.props.disabled, false);
  assert.equal(retry.props.title, undefined);
  assert.match(renderedText(tree), /待重试/);
  assert.match(renderedText(tree), /待上传 3/);
  assert.doesNotMatch(renderedText(tree), /已取消项目的队列|立即同步会重试|自动同步已关闭|轮询/);
});

test('client adapter allows deselecting a missing project in management then locks re-selection', async t => {
  const page = setupPage(t, () => ok(status({ projects: [lost, p1] })));
  await page.controller.refresh();
  assert.ok(renderedText(summary(page)).includes(lost.label));
  let modal = openProjects(page);
  let checkbox = projectCheckbox(modal, lost);
  assert.equal(checkbox.props.checked, true);
  assert.equal(checkbox.props.disabled, false);
  assert.ok(renderedText(modal).includes(lost.root));
  checkbox.props.onChange(false);
  modal = projectModal(page);
  checkbox = projectCheckbox(modal, lost);
  assert.equal(checkbox.props.checked, false);
  assert.equal(checkbox.props.disabled, true);
  checkbox.props.onChange(true); // Even a stale/native event cannot restore an unavailable project.
  assert.equal(page.controller.getSnapshot().draft.projectIds.includes(lost.id), false);
  button(projectModal(page), '全选可用项目').props.onClick();
  assert.deepEqual(page.controller.getSnapshot().draft.projectIds, [p1.id]);
  button(projectModal(page), '关闭').props.onClick();
  assert.equal(renderedText(summary(page)).includes(lost.label), false);
  assert.match(renderedText(page.tree()), /未保存/);
  modal = openProjects(page);
  assert.equal(projectCheckbox(modal, lost).props.disabled, true);
  assert.equal(projectCheckbox(modal, lost).props.checked, false);
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
});

test('client adapter shows concise empty-project and uninstalled Host states without tutorials', async t => {
  const page = setupPage(t, () => ok(status({ projects: [] })));
  await page.controller.refresh();
  assert.match(renderedText(page.tree()), /暂无项目/);
  assert.doesNotMatch(renderedText(page.tree()), /打开或添加|不会自动扫描|请先部署/);
  const modal = openProjects(page);
  assert.match(renderedText(modal), /暂无项目/);
  assert.equal(nodes(modal).some(node => node.type === 'native:Checkbox'), false);
  assert.equal(button(modal, '全选可用项目').props.disabled, true);
  assert.equal(button(modal, '全部取消').props.disabled, true);
  assert.equal(button(modal, '保存').props.disabled, true);
  const missing = setupPage(t, () => { throw new Error('transport failure for /api/dsh-personal-sync/status: HTTP 404'); });
  await missing.controller.refresh();
  assert.match(renderedText(missing.tree()), /此宿主尚未启用个人云同步服务/);
});

test('client project summary shows only draft selections, at most three names and an exact remainder', async t => {
  const extra = ['Gamma', 'Delta', 'Epsilon'].map(label => ({ id: `workspace:${label.toLowerCase()}`, label: `示例 ${label}`,
    root: `E:\\synthetic\\${label.toLowerCase()}`, selected: true, available: true }));
  const projects = [{ ...p1, selected: true }, p2, ...extra, lost];
  const page = setupPage(t, () => ok(status({ projects })));
  await page.controller.refresh();
  let card = summary(page);
  const selectedList = nodes(card).find(node => node.props['aria-label'] === '已选同步项目');
  assert.ok(selectedList);
  assert.ok(renderedText(selectedList).includes(p1.label));
  assert.ok(renderedText(selectedList).includes(extra[0].label));
  assert.ok(renderedText(selectedList).includes(extra[1].label));
  for (const project of [p2, extra[2], lost]) assert.equal(renderedText(card).includes(project.label), false);
  assert.match(renderedText(card), /另有 2 个项目/);
  for (const project of projects) assert.equal(renderedText(card).includes(project.root), false);
  assert.equal(nodes(card).some(node => ['native:Input', 'native:Checkbox', 'native:Switch'].includes(node.type)), false);
  assert.equal(nodes(page.tree()).some(node => node.type === 'native:Checkbox' || node.props.type === 'search'), false);
  const modal = openProjects(page);
  assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').length, projects.length);
  for (const project of projects) assert.ok(renderedText(modal).includes(project.root));
  projectCheckbox(modal, p1).props.onChange(false);
  projectCheckbox(projectModal(page), p2).props.onChange(true);
  button(projectModal(page), '关闭').props.onClick();
  card = summary(page);
  assert.equal(renderedText(card).includes(p1.label), false);
  assert.ok(renderedText(card).includes(p2.label));
  assert.match(renderedText(card), /另有 2 个项目/);
  assert.equal(page.controller.getSnapshot().dirty, true);
  assert.match(renderedText(page.tree()), /未保存/);
  openProjects(page);
  projectCheckbox(projectModal(page), extra[2]).props.onChange(false);
  projectCheckbox(projectModal(page), lost).props.onChange(false);
  button(projectModal(page), '关闭').props.onClick();
  card = summary(page);
  assert.doesNotMatch(renderedText(card), /另有/);
  for (const project of [p2, extra[0], extra[1]]) assert.ok(renderedText(card).includes(project.label));
  for (const project of [p1, extra[2], lost]) assert.equal(renderedText(card).includes(project.label), false);
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
});

test('client project management mounts only while open and close preserves unsaved selections without RPC', async t => {
  const page = setupPage(t, () => ok(status()));
  await page.controller.refresh();
  assert.equal(mainNodes(page.tree()).some(node => node.type === 'native:Input' && node.props.type === 'search'), false);
  for (const closeWith of ['footer', 'native']) {
    let modal = openProjects(page);
    assert.equal(nodes(modal).filter(node => node.type === 'native:Input' && node.props.type === 'search').length, 1);
    assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').length, 2);
    assert.equal(nodes(modal).some(node => node.type === 'native:Button' && renderedText(node) === '取消'), false);
    if (closeWith === 'footer') projectCheckbox(modal, p1).props.onChange(true);
    modal = projectModal(page);
    assert.equal(projectCheckbox(modal, p1).props.checked, true);
    assert.equal(mainButton(page.tree(), '保存').props.disabled, false);
    assert.equal(mainButton(page.tree(), '撤销更改').props.disabled, false);
    if (closeWith === 'footer') button(modal, '关闭').props.onClick(); else modal.props.onClose();
    assert.equal(Boolean(projectModal(page)?.props.open), false);
    assert.equal(nodes(page.tree()).some(node => node.type === 'native:Checkbox' || node.props.type === 'search'), false);
    assert.equal(renderedText(page.tree()).includes(p1.root), false);
    assert.deepEqual(page.controller.getSnapshot().draft.projectIds, [p1.id]);
    assert.equal(page.controller.getSnapshot().dirty, true);
    assert.match(renderedText(page.tree()), /未保存/);
    assert.ok(renderedText(summary(page)).includes(p1.label));
    assert.deepEqual(page.calls.map(call => call.action), ['status']);
  }
  mainButton(page.tree(), '撤销更改').props.onClick();
  assert.equal(page.controller.getSnapshot().dirty, false);
  assert.deepEqual(page.controller.getSnapshot().draft.projectIds, []);
  assert.equal(renderedText(summary(page)).includes(p1.label), false);
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
});

test('client project search and multi-select save explicitly; pending save locks edits and stale close handlers', async t => {
  const save = deferred();
  const page = setupPage(t, call => call.action === 'preferences' ? save.promise : ok(status({ projects: [p1, p2, lost] })));
  await page.controller.refresh();
  let modal = openProjects(page);
  projectCheckbox(modal, p1).props.onChange(true);
  modal = searchProjects(page, 'BETA');
  assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').length, 1);
  assert.equal(projectCheckbox(modal, p2).props.checked, false);
  button(modal, '全选搜索结果').props.onClick();
  assert.deepEqual(new Set(page.controller.getSnapshot().draft.projectIds), new Set([lost.id, p1.id, p2.id]));
  button(projectModal(page), '取消搜索结果').props.onClick();
  assert.deepEqual(new Set(page.controller.getSnapshot().draft.projectIds), new Set([lost.id, p1.id]));
  button(projectModal(page), '全选搜索结果').props.onClick();
  modal = searchProjects(page, 'no-synthetic-match');
  assert.match(renderedText(modal), /无匹配项目/);
  assert.equal(nodes(modal).some(node => node.type === 'native:Checkbox'), false);
  assert.equal(button(modal, '全选搜索结果').props.disabled, true);
  assert.equal(button(modal, '取消搜索结果').props.disabled, true);
  modal = searchProjects(page, 'synthetic\\alpha');
  assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').length, 1);
  assert.equal(projectCheckbox(modal, p1).props.checked, true);
  modal = searchProjects(page, '');
  const staleClose = button(modal, '关闭').props.onClick;
  const staleNativeClose = modal.props.onClose;
  assert.equal(button(modal, '保存').props.disabled, false);
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
  button(modal, '保存').props.onClick();
  modal = projectModal(page);
  assert.equal(page.controller.getSnapshot().busy, 'preferences');
  assert.equal(modal.props.open, true);
  assert.equal(button(modal, '关闭').props.disabled, true);
  const savingButton = nodes(modal).find(node => node.type === 'native:Button' && node.props['aria-busy'] === true);
  assert.ok(savingButton);
  assert.equal(savingButton.props.disabled, true);
  assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').every(node => node.props.disabled), true);
  assert.equal(button(modal, '全选可用项目').props.disabled, true);
  assert.equal(button(modal, '全部取消').props.disabled, true);
  staleClose(); staleNativeClose(); modal.props.onClose();
  assert.equal(projectModal(page).props.open, true);
  assert.equal(page.calls.length, 2);
  const payload = page.calls.at(-1).payload;
  assert.equal(payload.revision, 0);
  assert.equal(payload.autoSync, false);
  assert.deepEqual(new Set(payload.projectIds), new Set([lost.id, p1.id, p2.id]));
  assert.deepEqual(Object.keys(payload).sort(), ['autoSync', 'projectIds', 'revision']);
  save.resolve(ok(status({ revision: 1, projects: [{ ...p1, selected: true }, { ...p2, selected: true }, lost] })));
  await settle();
  assert.equal(Boolean(projectModal(page)?.props.open), false);
  assert.equal(page.controller.getSnapshot().dirty, false);
  assert.deepEqual(page.calls.map(call => call.action), ['status', 'preferences']);
  assert.equal(nodes(page.tree()).some(node => node.type === 'native:Checkbox' || node.props.type === 'search'), false);
});

test('client project save failure stays open with a safe error, and close does not discard or retry', async t => {
  const page = setupPage(t, call => call.action === 'preferences' ? failure('SERVER_UNREACHABLE', 'untrusted synthetic save secret') : ok(status()));
  await page.controller.refresh();
  let modal = openProjects(page);
  projectCheckbox(modal, p2).props.onChange(true);
  button(projectModal(page), '保存').props.onClick();
  await settle();
  modal = projectModal(page);
  assert.equal(modal.props.open, true);
  assert.equal(page.controller.getSnapshot().dirty, true);
  assert.equal(projectCheckbox(modal, p2).props.checked, true);
  assert.equal(button(modal, '保存').props.disabled, false);
  const alerts = nodes(modal).filter(node => node.props.role === 'alert');
  assert.ok(alerts.length > 0);
  assert.ok(alerts.some(node => renderedText(node).includes(page.controller.getSnapshot().error.message)));
  assert.equal(renderedText(page.tree()).includes('untrusted synthetic save secret'), false);
  button(modal, '关闭').props.onClick();
  assert.equal(Boolean(projectModal(page)?.props.open), false);
  assert.equal(page.controller.getSnapshot().dirty, true);
  assert.match(renderedText(page.tree()), /未保存/);
  assert.ok(renderedText(summary(page)).includes(p2.label));
  modal = openProjects(page);
  assert.equal(projectCheckbox(modal, p2).props.checked, true);
  assert.equal(page.calls.filter(call => call.action === 'preferences').length, 1);
  button(modal, '关闭').props.onClick();
  mainButton(page.tree(), '撤销更改').props.onClick();
  assert.equal(page.controller.getSnapshot().dirty, false);
  assert.deepEqual(page.controller.getSnapshot().draft.projectIds, []);
  assert.deepEqual(page.calls.map(call => call.action), ['status', 'preferences']);
});

test('client project management remains viewable while refreshing but locks selection and saving', async t => {
  const refresh = deferred();
  let waiting = false;
  const page = setupPage(t, () => waiting ? refresh.promise : ok(status()));
  await page.controller.refresh();
  waiting = true;
  const refreshing = page.controller.refresh();
  const before = page.calls.length;
  const modal = openProjects(page);
  assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').every(node => node.props.disabled), true);
  assert.equal(button(modal, '保存').props.disabled, true);
  assert.equal(button(modal, '全选可用项目').props.disabled, true);
  projectCheckbox(modal, p1).props.onChange(true);
  assert.deepEqual(page.controller.getSnapshot().draft.projectIds, []);
  button(modal, '保存').props.onClick();
  assert.equal(page.calls.length, before);
  refresh.resolve(ok(status()));
  await refreshing;
  assert.equal(projectModal(page).props.open, true);
  assert.equal(projectCheckbox(projectModal(page), p1).props.disabled, false);
});

test('client project conflicts can be refreshed inside management before re-selection and explicit saving', async t => {
  let current = status({ revision: 1 });
  let writes = 0;
  const page = setupPage(t, call => {
    if (call.action === 'status') return ok(current);
    assert.equal(call.action, 'preferences');
    if (++writes === 1) {
      current = status({ revision: 2, projects: [p1, { ...p2, selected: true }] });
      return failure('CONFIG_CONFLICT');
    }
    return ok({ ...current, revision: 3, projects: [{ ...p1, selected: true }, { ...p2, selected: true }] });
  });
  await page.controller.refresh();
  let modal = openProjects(page);
  projectCheckbox(modal, p1).props.onChange(true);
  button(projectModal(page), '保存').props.onClick();
  await settle();
  modal = projectModal(page);
  assert.equal(modal.props.open, true);
  assert.equal(page.controller.getSnapshot().conflict, true);
  assert.equal(button(modal, '保存').props.disabled, true);
  assert.equal(nodes(modal).filter(node => node.type === 'native:Checkbox').every(node => node.props.disabled), true);
  assert.ok(nodes(modal).some(node => node.props.role === 'alert'));
  button(modal, '关闭').props.onClick();
  modal = openProjects(page); // A conflict must not prevent viewing projects.
  assert.equal(projectCheckbox(modal, p1).props.disabled, true);
  button(modal, '刷新并重新选择').props.onClick();
  await settle();
  modal = projectModal(page);
  assert.equal(modal.props.open, true);
  assert.equal(page.controller.getSnapshot().conflict, false);
  assert.equal(page.controller.getSnapshot().draft.revision, 2);
  assert.equal(projectCheckbox(modal, p1).props.checked, false);
  assert.equal(projectCheckbox(modal, p2).props.checked, true);
  projectCheckbox(modal, p1).props.onChange(true);
  button(projectModal(page), '保存').props.onClick();
  await settle();
  assert.equal(Boolean(projectModal(page)?.props.open), false);
  assert.equal(page.calls.at(-1).payload.revision, 2);
  assert.deepEqual(new Set(page.calls.at(-1).payload.projectIds), new Set([p1.id, p2.id]));
  assert.equal(page.controller.getSnapshot().dirty, false);
  assert.deepEqual(page.calls.map(call => call.action), ['status', 'preferences', 'status', 'preferences']);
});

test('client build is deterministic, native-module-loader compatible, and contains no fetch/storage/framework copy', async () => {
  const bundle = await bundleClient();
  assert.equal(bundle, await bundleClient());
  let loaded;
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load(module) { loaded = module; } } } });
  assert.equal(loaded.id, 'dsh-personal-sync');
  assert.equal(typeof loaded.factory, 'function');
  const requires = [];
  const plugin = loaded.factory(name => { requires.push(name); return {}; });
  assert.equal(plugin.name, 'dsh-personal-sync-settings');
  assert.deepEqual(requires, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.equal(/\b(?:localStorage|sessionStorage|fetch)\s*(?:\.|\()/u.test(bundle), false);
  assert.equal(/\bconsole\./u.test(bundle), false);
  assert.equal(/createApp\(|ReactCurrentDispatcher|__VUE__/u.test(bundle), false);
  const adapter = await readFile(new URL('../client/adapter.mjs', import.meta.url), 'utf8');
  assert.equal(adapter.includes('dangerouslySetInnerHTML'), false);
  assert.equal(adapter.includes('innerHTML'), false);
  assert.ok(new SettingsClientError('not-allowed').message.length > 0);
});
