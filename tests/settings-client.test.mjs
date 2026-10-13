import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createConnectionTransport, createController, deriveView, normalizeServer, parseStatus, SettingsClientError, validateLogin } from '../client/state.mjs';
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

test('account status strictly validates its allowlist and ignores obsolete or malformed legacy extensions', () => {
  const input = status({ token: 'must-not-retain', password: 'must-not-retain', autoSync: true,
    projects: [{ ...p1, token: 'must-not-retain' }], lastResult: { message: 'must-not-retain' }, download: 'obsolete', recovery: null });
  const parsed = parseStatus(input);
  assert.deepEqual(parsed, { revision: 0, server: '', username: '', loggedIn: false, running: false });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(JSON.stringify(parsed).includes('must-not-retain'), false);
  assert.deepEqual(parseStatus({ revision: 1, loggedIn: false }), { revision: 1, server: '', username: '', loggedIn: false, running: false });
  for (const patch of [{ autoSync: 'old-format' }, { projects: null }, { pending: -1 }, { intervalMs: null }, { recovery: { secret: 'x' } }, { download: [] }, { lastResult: { at: 'invalid' } }]) {
    assert.deepEqual(parseStatus(status(patch)), parsed);
  }
  for (const bad of [status({ revision: -1 }), status({ loggedIn: 'false' }), status({ running: 'false' }), status({ server: 'https://u:p@x.test' }), status({ username: '\n' }), status({ expiresAt: 'bad' }), status({ warning: {} })]) {
    assert.throws(() => parseStatus(bad), { code: 'INVALID_RESPONSE' });
  }
});

test('client uses only native Connection RPC and rejects arbitrary actions', async () => {
  const current = status();
  const { connection, calls } = mockConnection(() => ok(current));
  const transport = createConnectionTransport(connection);
  const abort = new AbortController();
  assert.deepEqual(await transport('status', {}, abort.signal), current);
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].endpoint, 'dsh-personal-sync/status');
  assert.equal(calls[0].signal, abort.signal);
  await assert.rejects(() => transport('http://localhost:9000/bypass', {}, abort.signal), error => error.code === 'BAD_REQUEST');
  await assert.rejects(() => createConnectionTransport({})('status', {}, abort.signal), error => error.code === 'CONNECTION_UNAVAILABLE');
  assert.equal(calls.length, 1);
});

test('account client starts inert and unsigned, with no automatic operations or legacy controls', async t => {
  const { controller, calls, clock } = controlled(t, () => ok(status()));
  assert.equal(controller.getSnapshot().status, null); assert.equal(controller.getSnapshot().ready, false);
  assert.equal(calls.length, 0); assert.equal(await controller.logout(), false);
  assert.equal(deriveView(controller.getSnapshot()).canLogin, false);
  await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canLogin, true);
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false);
  assert.equal(await controller.logout(), false);
  assert.equal(controller.sync, undefined); assert.equal(controller.savePreferences, undefined);
  assert.equal(calls.length, 1); assert.equal(clock.jobs.size, 0);
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
  assert.equal(Object.hasOwn(controller.getSnapshot(), 'draft'), false);
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

test('Host running work blocks login but retains password/logout safety controls without project actions', async t => {
  const { controller, calls } = controlled(t, () => ok(status({ server: 'https://sync.example.test', username: 'alice', loggedIn: true, running: true })));
  await controller.refresh();
  const view = deriveView(controller.getSnapshot());
  assert.equal(view.canLogout, true); assert.equal(view.canChangePassword, true); assert.equal(view.canLogin, false);
  assert.equal(await controller.login({ server: 'https://sync.example.test', username: 'alice', password: 'synthetic-only' }), false);
  assert.deepEqual(calls.map(call => call.action), ['status']);
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
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false);
});

test('account client serializes mutations and blocks duplicate login, password, logout and updater requests while busy', async t => {
  const pending = deferred();
  const { controller, calls } = controlled(t, call => call.action === 'login' ? pending.promise : ok(status()));
  await controller.refresh();
  const login = controller.login({ server: 'https://sync.example.test', username: 'alice', password: 'synthetic-only' });
  assert.equal(controller.getSnapshot().busy, 'login');
  assert.equal(await controller.login({ server: 'https://sync.example.test', username: 'alice', password: 'synthetic-only' }), false);
  assert.equal(await controller.changePassword({}, {}), false);
  assert.equal(await controller.logout(), false); assert.equal(await controller.refresh(), false); assert.equal(await controller.checkUpdate(), false);
  assert.equal(calls.length, 2);
  pending.resolve(ok(status({ revision: 1, loggedIn: true, server: 'https://sync.example.test', username: 'alice' })));
  assert.equal(await login, true); assert.equal(controller.getSnapshot().busy, null);
  assert.equal(deriveView(controller.getSnapshot()).canLogout, true);
  assert.deepEqual(calls.map(call => call.action), ['status', 'login']);
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

test('legacy queues and automatic-upload flags cause no polling; reset reads remain mounted-only and teardown idempotent', async t => {
  const { controller, clock, calls } = controlled(t, () => ok(status({ loggedIn: true, autoSync: true, pending: 42 })));
  const close = controller.watch(); await settle();
  assert.equal(calls.length, 1); assert.equal(clock.jobs.size, 0);
  await controller.refreshIfWatching(); assert.equal(calls.length, 2); assert.equal(clock.jobs.size, 0);
  close(); close(); assert.equal(clock.jobs.size, 0);
  assert.equal(await controller.refreshIfWatching(), false); assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(controller.getSnapshot(), 'draft'), false);
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

test('client logout uses an empty body, retains only public warning and cannot replay after sign-out', async t => {
  const { controller, calls } = controlled(t, call => ok(call.action === 'logout'
    ? status({ warning: '本机已退出，无法确认云端撤销。', token: 'synthetic-token' }) : status({ loggedIn: true, projects: [{ ...p1, selected: true }] })));
  await controller.refresh();
  assert.equal(await controller.logout(), true);
  assert.deepEqual(calls.at(-1).payload, {});
  assert.equal(controller.getSnapshot().status.loggedIn, false);
  assert.equal(controller.getSnapshot().status.warning, '本机已退出，无法确认云端撤销。');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('synthetic-token'), false);
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false);
  assert.equal(await controller.logout(), false);
  assert.equal(calls.filter(call => call.action === 'logout').length, 1);
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
  assert.equal(mainButton(initial, '登录').props.disabled, true);
  assert.equal(nodes(initial).some(node => node.type === 'native:Button' && renderedText(node) === '管理'), false);
  assert.equal(nodes(initial).some(node => (node.type === 'native:Checkbox' && node.props['data-personal-sync'] !== 'remember-device') || node.props.type === 'search'), false);
  page.mountEffects(); await settle();
  const tree = page.tree();
  assert.equal(nodes(tree).some(node => node.type === 'aside' || (node.type !== 'native:Modal' && node.props?.title) || node.props?.description), false);
  assert.doesNotMatch(renderedText(tree), /默认关闭|同步前请确认|项目文件与会话归档|不会默认|服务器（server）|账号（username）|密码（password）/);
  assert.match(renderedText(tree), /个人云同步/);
  assert.equal(nodes(tree).some(node => node.type === 'native:Switch'), false);
  assert.equal(nodes(tree).some(node => node.type === 'native:Button' && renderedText(node) === '立即同步'), false);
  const remember = nodes(tree).find(node => node.props['data-personal-sync'] === 'remember-device');
  assert.equal(remember.props.checked, false);
  assert.equal(remember.props.disabled, false);
  assert.equal(mainButton(tree, '登录').props.disabled, false);
  const panels = nodes(tree).filter(node => typeof node.type === 'function' && node.type.name === 'BidirectionalPanel');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].props.connection, page.connection);
  assert.deepEqual(panels[0].props.identity, { server: '', username: '', loggedIn: false });
  assert.equal(typeof panels[0].props.onAuthenticationRequired, 'function');
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
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
  assert.equal(renderedText(tree).includes(current.server), true);
  assert.ok(controls.some(node => node.props['aria-label'] === '已连接服务器')); // Readonly origin, never a mounted login field.
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

test('client adapter omits all one-way controls for legacy running, pending and unavailable selections while keeping logout usable', async t => {
  for (const legacy of [
    { autoSync: true, running: true, projects: [{ ...p1, selected: true }, { ...p2, selected: true }] },
    { autoSync: false, pending: 3, projects: [{ ...p1, selected: true }, p2] },
    { autoSync: true, projects: [lost, p1] },
  ]) {
    const page = setupPage(t, () => ok(status({ server: 'https://saved.example.test', username: 'saved-account', loggedIn: true, ...legacy })));
    const tree = await mounted(page);
    const controls = nodes(tree);
    for (const label of ['管理', '立即同步', '保存', '撤销更改', '全选可用项目', '全部取消', '选择项目', '保存位置', '下载所选', '确认下载', '添加到DSH项目']) {
      assert.equal(controls.some(node => node.type === 'native:Button' && renderedText(node) === label), false, label);
    }
    assert.equal(controls.some(node => ['native:Switch', 'native:Checkbox'].includes(node.type) || node.props.type === 'search'), false);
    assert.equal(controls.some(node => ['legacy-actions', 'projects-summary', 'cloud-summary', 'recovery-result'].includes(node.props['data-personal-sync'])), false);
    assert.equal(controls.some(node => node.type === 'native:Modal' && /管理同步项目|下载|保存位置/.test(node.props.title)), false);
    assert.doesNotMatch(renderedText(tree), /待上传|待重试|已选择|仅同步所选项目|未保存|备份与恢复/);
    for (const project of [p1, p2, lost]) {
      assert.equal(renderedText(tree).includes(project.label), false);
      assert.equal(renderedText(tree).includes(project.root), false);
    }
    assert.equal(mainButton(tree, '退出登录').props.disabled, false);
    assert.equal(mainNodes(tree).some(node => node.type === 'form' || node.type === 'native:Input'), false);
    assert.equal(controls.filter(node => typeof node.type === 'function' && node.type.name === 'BidirectionalPanel').length, 1);
    assert.ok(page.calls.every(call => call.action === 'status'));
  }
});

test('client adapter renders the concise safe uninstalled Host error without a legacy fallback', async t => {
  const page = setupPage(t, () => { throw new Error('transport failure for /api/dsh-personal-sync/status: HTTP 404'); });
  await page.controller.refresh();
  const tree = page.tree();
  assert.match(renderedText(tree), /此宿主尚未启用个人云同步服务/);
  assert.doesNotMatch(renderedText(tree), /打开或添加|不会自动扫描|请先部署/);
  assert.equal(mainButton(tree, '登录').props.disabled, true);
  assert.equal(nodes(tree).some(node => node.props['data-personal-sync'] === 'legacy-actions'), false);
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
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
