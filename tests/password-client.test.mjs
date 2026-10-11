import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, deriveView, parseStatus, validatePasswordChange } from '../client/state.mjs';
import { createClientPlugin } from '../client/adapter.mjs';

const project = { id: 'workspace:synthetic', label: 'Synthetic', root: 'E:\\synthetic\\project', selected: true, available: true };
const status = (extra = {}) => ({ revision: 4, server: 'https://saved.example.test', username: 'saved-account', loggedIn: true,
  autoSync: false, intervalMs: 60000, projects: [{ ...project }], pending: 0, running: false, ...extra });
const identity = value => ({ revision: value.revision, server: value.server, username: value.username });
const secret = (extra = {}) => ({ currentPassword: ' old synthetic secret ', newPassword: ' new synthetic password ', confirmPassword: ' new synthetic password ', ...extra });
const ok = value => ({ ok: true, value });
const failure = (code, message = 'untrusted synthetic secret') => ({ ok: false, error: { code, message, details: { password: message } } });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 40; ++i) await Promise.resolve(); }
function mockConnection(handler) {
  const calls = [];
  return { calls, connection: { rpc: { async call(channel, endpoint, payload, signal) {
    const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal };
    calls.push(call);
    return handler(call);
  } } } };
}
function controlled(t, handler) {
  const mock = mockConnection(handler);
  let count = 0;
  const jobs = new Map();
  const controller = createController(mock.connection, {
    setTimeout(fn, ms) { const id = ++count; jobs.set(id, { fn, ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
  });
  t.after(() => controller.dispose());
  return { ...mock, controller, jobs,
    timeout() { const entry = [...jobs].find(([, job]) => job.ms === 60000); assert.ok(entry); jobs.delete(entry[0]); entry[1].fn(); },
  };
}

// Synthetic native Connection/React contracts only; these are not live GUI integration tests.
test('password client enforces an 8-codepoint minimum, UTF-8 byte bounds and exact untrimmed secrets', () => {
  const saved = parseStatus(status());
  const bound = identity(saved);
  const sevenEmoji = '😀'.repeat(7);
  assert.equal(sevenEmoji.length, 14); // UTF-16 length must not satisfy the codepoint minimum.
  assert.equal([...sevenEmoji].length, 7);
  for (const next of ['a'.repeat(8), '界'.repeat(8), '😀'.repeat(8), ' '.repeat(8), ' x'.repeat(4),
    '😀'.repeat(16), '界'.repeat(341), '😀'.repeat(256), 'a'.repeat(1024), ' '.repeat(16), ' x'.repeat(8)]) {
    const body = validatePasswordChange(saved, bound, secret({ newPassword: next, confirmPassword: next }));
    assert.deepEqual(body, { ...bound, currentPassword: secret().currentPassword, newPassword: next });
    assert.equal(Object.hasOwn(body, 'confirmPassword'), false);
  }
  for (const next of [sevenEmoji, '界'.repeat(7), 'a'.repeat(7), '', null]) {
    assert.throws(() => validatePasswordChange(saved, bound, secret({ newPassword: next, confirmPassword: next })), { code: 'PASSWORD_TOO_WEAK' });
  }
  for (const next of ['界'.repeat(342), '😀'.repeat(257), 'a'.repeat(1025)]) {
    assert.throws(() => validatePasswordChange(saved, bound, secret({ newPassword: next, confirmPassword: next })), { code: 'PASSWORD_TOO_LONG' });
  }
  assert.throws(() => validatePasswordChange(saved, bound, secret({ confirmPassword: secret().newPassword.trim() })), { code: 'PASSWORD_CONFIRM_MISMATCH' });
  assert.throws(() => validatePasswordChange(saved, bound, secret({ currentPassword: secret().newPassword })), { code: 'PASSWORD_UNCHANGED' });
  for (const currentPassword of ['', null, '界'.repeat(342)]) assert.throws(() => validatePasswordChange(saved, bound, secret({ currentPassword })), { code: 'BAD_PASSWORD' });
  assert.equal(validatePasswordChange(saved, bound, secret({ currentPassword: ' ' })).currentPassword, ' ');
});

test('password client requires the exact saved identity and revision, not a typed destination', async t => {
  const { controller, calls } = controlled(t, () => ok(status()));
  await controller.refresh();
  const saved = controller.getSnapshot().status;
  for (const binding of [{ ...identity(saved), server: 'https://typed.example.test' }, { ...identity(saved), username: 'typed-account' }, identity(status({ server: '' }))]) {
    assert.equal(await controller.changePassword(binding, secret()), false);
    assert.equal(controller.getSnapshot().error.code, 'ACCOUNT_MISMATCH');
  }
  assert.equal(await controller.changePassword(identity(status({ revision: 3 })), secret()), false);
  assert.equal(controller.getSnapshot().error.code, 'CONFIG_CONFLICT');
  assert.equal(calls.length, 1);
});

test('password client rejects confirmation mismatch locally without RPC or retained secrets', async t => {
  const { controller, calls } = controlled(t, () => ok(status()));
  await controller.refresh();
  assert.equal(await controller.changePassword(identity(status()), secret({ confirmPassword: 'another synthetic confirmation' })), false);
  assert.equal(controller.getSnapshot().error.code, 'PASSWORD_CONFIRM_MISMATCH');
  assert.deepEqual(calls.map(call => call.action), ['status']);
  const encoded = JSON.stringify(controller.getSnapshot());
  for (const value of Object.values(secret())) assert.equal(encoded.includes(value), false);
});

test('password client sends only native CAS payload, permits expired tokens and requires re-login on success', async t => {
  const pending = deferred();
  const { controller, calls } = controlled(t, call => call.action === 'password' ? pending.promise : ok(status({ loggedIn: false })));
  await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canChangePassword, true);
  const changed = controller.changePassword(identity(status()), secret());
  const call = calls.at(-1);
  assert.equal(call.channel, '/api');
  assert.equal(call.endpoint, 'dsh-personal-sync/password');
  assert.deepEqual(call.payload, { ...identity(status()), currentPassword: secret().currentPassword, newPassword: secret().newPassword });
  assert.equal(Object.hasOwn(call.payload, 'confirmPassword'), false);
  assert.equal(controller.getSnapshot().busy, 'password');
  assert.equal(deriveView(controller.getSnapshot()).canChangePassword, false);
  assert.equal(await controller.changePassword(identity(status()), secret()), false);
  assert.equal(await controller.sync(), false);
  for (const value of Object.values(secret())) assert.equal(JSON.stringify(controller.getSnapshot()).includes(value), false);
  pending.resolve(ok(status({ revision: 5, loggedIn: false, autoSync: false, passwordChanged: true,
    currentPassword: secret().currentPassword, newPassword: secret().newPassword, token: 'synthetic-token' })));
  assert.equal(await changed, true);
  const state = controller.getSnapshot();
  assert.equal(state.notice, '密码已修改，请重新登录');
  assert.equal(state.status.loggedIn, false);
  assert.equal(state.status.autoSync, false);
  assert.equal(state.draft.autoSync, false);
  assert.equal(state.scheduled, false);
  assert.equal(deriveView(state).canSync, false);
  assert.equal(deriveView(state).canLogin, true);
  for (const value of [...Object.values(secret()), 'synthetic-token', 'passwordChanged']) assert.equal(JSON.stringify(state).includes(value), false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'password']);
});

test('password client may operate while Host sync runs, and success clears its scheduling latch', async t => {
  let running = false;
  const { controller, calls } = controlled(t, call => {
    if (call.action === 'sync') { running = true; return ok({ scheduled: true }); }
    return ok(status(call.action === 'password' ? { revision: 5, loggedIn: false, running: false } : { running }));
  });
  await controller.refresh();
  await controller.sync();
  assert.equal(controller.getSnapshot().scheduled, true);
  assert.equal(deriveView(controller.getSnapshot()).canChangePassword, true);
  assert.equal(await controller.changePassword(identity(status()), secret()), true);
  assert.equal(controller.getSnapshot().scheduled, false);
  assert.equal(controller.getSnapshot().status.running, false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'sync', 'status', 'password']);
});

test('password client maps rejected and old-server errors to short safe text, refreshing once without clearing valid login', async t => {
  const messages = { CURRENT_PASSWORD_INVALID: '当前密码错误', PASSWORD_TOO_WEAK: '新密码至少8位', PASSWORD_UNCHANGED: '新旧密码不能相同',
    PASSWORD_CHANGE_UNSUPPORTED: '请先升级同步服务器', PASSWORD_CHANGE_REJECTED: '修改未通过验证', CONFIG_CONFLICT: '配置已变更，请刷新并重新选择',
    ACCOUNT_MISMATCH: '服务器或账号已变更', BUSY: '正在处理其他操作', SERVER_UNREACHABLE: '无法连接同步服务器' };
  for (const [code, message] of Object.entries(messages)) {
    const { controller, calls } = controlled(t, call => call.action === 'password' ? failure(code) : ok(status({ autoSync: true })));
    await controller.refresh();
    assert.equal(await controller.changePassword(identity(status()), secret()), false);
    const state = controller.getSnapshot();
    assert.deepEqual(state.error, { code, message });
    assert.equal(state.status.loggedIn, true);
    assert.equal(state.status.autoSync, true);
    assert.equal(state.passwordUncertain, false);
    assert.equal(state.ready, true);
    assert.equal(state.conflict, code === 'CONFIG_CONFLICT');
    assert.equal(JSON.stringify(state).includes('untrusted synthetic secret'), false);
    assert.deepEqual(calls.map(call => call.action), ['status', 'password', 'status']);
  }
});

test('password client locks uncertain outcomes against stale logged-in refreshes until explicit login', async t => {
  for (const code of ['PASSWORD_CHANGE_UNCERTAIN', 'UNKNOWN_SECRET_CODE']) {
    const { controller, calls } = controlled(t, call => call.action === 'password' ? failure(code) : ok(status({ autoSync: call.action !== 'login' })));
    await controller.refresh();
    assert.equal(await controller.changePassword(identity(status()), secret()), false);
    const state = controller.getSnapshot();
    assert.deepEqual(state.error, { code: 'PASSWORD_CHANGE_UNCERTAIN', message: '结果未确认，请重新登录' });
    assert.equal(state.status.loggedIn, false);
    assert.equal(state.status.autoSync, false);
    assert.equal(state.draft.autoSync, false);
    assert.equal(state.passwordUncertain, true);
    assert.equal(deriveView(state).canSync, false);
    assert.equal(deriveView(state).canChangePassword, false);
    assert.equal(controller.setAutoSync(true), false);
    assert.equal(await controller.sync(), false);
    assert.equal(await controller.changePassword(identity(status()), secret()), false);
    await controller.refresh();
    assert.equal(controller.getSnapshot().status.loggedIn, false);
    assert.equal(controller.getSnapshot().status.autoSync, false);
    assert.equal(await controller.login({ ...identity(status()), password: secret().newPassword }), true);
    assert.equal(controller.getSnapshot().passwordUncertain, false);
    assert.equal(controller.getSnapshot().status.loggedIn, true);
    assert.equal(controller.getSnapshot().draft.autoSync, false);
    assert.equal(calls.filter(call => call.action === 'password').length, 1);
  }
});

test('password client marks cache unconfirmed when the single recovery read fails', async t => {
  let reads = 0;
  const { controller, calls } = controlled(t, call => call.action === 'password' ? failure('CURRENT_PASSWORD_INVALID')
    : ++reads === 1 ? ok(status({ autoSync: true })) : Promise.reject(new Error('synthetic transport secret')));
  await controller.refresh();
  await controller.changePassword(identity(status()), secret());
  const state = controller.getSnapshot();
  assert.equal(state.ready, false);
  assert.equal(state.status.loggedIn, false);
  assert.equal(state.status.autoSync, false);
  assert.equal(deriveView(state).canSync, false);
  assert.equal(state.error.message, '当前密码错误');
  assert.equal(JSON.stringify(state).includes('synthetic transport secret'), false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'password', 'status']);
});

test('password client timeout cancels even an uncooperative carrier, never replays, and ignores late success', async t => {
  const late = deferred();
  const { controller, calls, timeout, jobs } = controlled(t, call => call.action === 'password' ? late.promise : ok(status({ autoSync: true })));
  await controller.refresh();
  const changing = controller.changePassword(identity(status()), secret());
  timeout();
  assert.equal(await changing, false);
  assert.equal(calls.find(call => call.action === 'password').signal.aborted, true);
  assert.equal(controller.getSnapshot().error.code, 'PASSWORD_CHANGE_UNCERTAIN');
  assert.equal(controller.getSnapshot().status.loggedIn, false);
  assert.equal(controller.getSnapshot().status.autoSync, false);
  assert.equal(jobs.size, 0);
  late.resolve(ok(status({ revision: 5, loggedIn: false })));
  await settle();
  assert.equal(controller.getSnapshot().notice, '');
  assert.deepEqual(calls.map(call => call.action), ['status', 'password', 'status']);
});

test('password client cancellation reconciles once; disposal aborts and suppresses all late delivery', async t => {
  const late = deferred();
  const { controller, calls } = controlled(t, call => call.action === 'password' ? late.promise : ok(status()));
  await controller.refresh();
  const changing = controller.changePassword(identity(status()), secret());
  controller.cancelPasswordChange();
  assert.equal(await changing, false);
  assert.equal(calls.find(call => call.action === 'password').signal.aborted, true);
  assert.equal(controller.getSnapshot().passwordUncertain, true);
  assert.deepEqual(calls.map(call => call.action), ['status', 'password', 'status']);
  const second = controlled(t, call => call.action === 'password' ? late.promise : ok(status()));
  await second.controller.refresh();
  const disposed = second.controller.changePassword(identity(status()), secret());
  second.controller.dispose();
  assert.equal(await disposed, false);
  late.resolve(ok(status({ loggedIn: false, revision: 5 })));
  await settle();
  assert.equal(second.calls.at(-1).signal.aborted, true);
  assert.equal(second.controller.getSnapshot().notice, '');
  assert.deepEqual(second.calls.map(call => call.action), ['status', 'password']);
});

test('password client rejects malformed success that would leave login or automatic sync enabled', async t => {
  for (const result of [status({ loggedIn: true }), status({ loggedIn: false, autoSync: true }), { passwordChanged: true }]) {
    const { controller, calls } = controlled(t, call => ok(call.action === 'password' ? result : status()));
    await controller.refresh();
    assert.equal(await controller.changePassword(identity(status()), secret()), false);
    assert.equal(controller.getSnapshot().error.code, 'PASSWORD_CHANGE_UNCERTAIN');
    assert.equal(controller.getSnapshot().status.loggedIn, false);
    assert.equal(controller.getSnapshot().notice, '');
    assert.deepEqual(calls.map(call => call.action), ['status', 'password', 'status']);
  }
});

function mockReact() {
  const cells = [];
  let cursor = 0;
  let effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    useId() { return 'mock-password'; },
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
  return { React, cells,
    render(Component, props) { cursor = 0; return Component(props); },
    mountEffects() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
  };
}
function nodes(root) {
  return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)];
}
function text(root) {
  return typeof root === 'string' ? root : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(text).join(' ');
}
function setupPage(t, handler) {
  const hooks = mockReact();
  const primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const plugin = createClientPlugin(name => name === 'react' ? hooks.React : primitives);
  const mock = mockConnection(handler);
  const cleanups = [];
  let slot;
  plugin.apply({ connection: mock.connection, effect(fn) { cleanups.push(fn()); }, on() {},
    slots: { inject(_name, register) { register(); }, register(spec, Component) { slot = { spec, Component }; return () => {}; } },
  });
  const props = slot.spec.inject();
  const page = { ...mock, ...hooks, controller: props.controller, tree: () => hooks.render(slot.Component, props) };
  t.after(() => { hooks.unmount(); cleanups.forEach(fn => fn?.()); });
  return page;
}
async function mounted(page) { await page.controller.refresh(); page.tree(); page.mountEffects(); await settle(); return page.tree(); }
function button(tree, label) { return nodes(tree).find(node => node.type === 'native:Button' && text(node) === label); }
function passwordModal(page) { return nodes(page.tree()).find(node => node.type === 'native:Modal' && node.props.title === '修改密码'); }
function open(page) { button(page.tree(), '修改密码').props.onClick(); return passwordModal(page); }
function fields(modal) { return nodes(modal).filter(node => node.type === 'native:Input' && node.props.type === 'password'); }
function fill(modal, values = Object.values(secret())) {
  const inputs = fields(modal);
  assert.equal(inputs.length, 3);
  inputs.forEach((input, index) => { input.props.ref.current = { value: values[index] }; });
  return inputs;
}
function submit(modal) { nodes(modal).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); }
function cleared(inputs) { for (const input of inputs) assert.equal(input.props.ref.current.value, ''); }

test('password modal uses three uncontrolled native password refs, saved identity instead of edited login fields', async t => {
  const change = deferred();
  const page = setupPage(t, call => call.action === 'password' ? change.promise : ok(status({ loggedIn: false })));
  let tree = await mounted(page);
  nodes(tree).find(node => node.props.id === 'mock-password-server' && node.type === 'native:Input').props.onChange({ target: { value: 'https://typed.example.test' } });
  tree = page.tree();
  nodes(tree).find(node => node.props.id === 'mock-password-username' && node.type === 'native:Input').props.onChange({ target: { value: 'typed-account' } });
  const modal = open(page);
  assert.equal(modal.props.open, true);
  assert.equal(modal.props.description, undefined);
  const inputs = fill(modal);
  assert.equal(nodes(modal).filter(node => node.type === 'label').length, 3);
  for (const input of inputs) {
    assert.equal(Object.hasOwn(input.props, 'value'), false);
    assert.equal(Object.hasOwn(input.props, 'defaultValue'), false);
    assert.equal(Object.hasOwn(input.props, 'onChange'), false);
    assert.equal(input.props.autoComplete, 'off');
  }
  submit(modal);
  cleared(inputs);
  assert.deepEqual(page.calls.at(-1).payload, { ...identity(status()), currentPassword: secret().currentPassword, newPassword: secret().newPassword });
  assert.equal(JSON.stringify(page.controller.getSnapshot()).includes(secret().newPassword), false);
  assert.equal(page.cells.some(cell => typeof cell === 'string' && Object.values(secret()).includes(cell)), false);
  fill(modal);
  change.resolve(ok(status({ loggedIn: false, revision: 5, passwordChanged: true })));
  await settle();
  cleared(inputs);
  assert.equal(passwordModal(page).props.open, false);
  assert.match(text(page.tree()), /密码已修改，请重新登录/);
  assert.equal(button(page.tree(), '立即同步').props.disabled, true);
  assert.equal(button(page.tree(), '登录').props.disabled, false);
});

test('password change from a logged-in account restores an empty login form only after success', async t => {
  const pending = deferred();
  const page = setupPage(t, call => call.action === 'password' ? pending.promise : ok(status()));
  let tree = await mounted(page);
  const loginInput = root => nodes(root).find(node => node.type === 'native:Input' && node.props.id === 'mock-password-password');
  assert.equal(loginInput(tree), undefined);
  assert.equal(button(tree, '登录'), undefined);
  assert.ok(button(tree, '退出登录'));
  assert.ok(text(tree).includes(status().username));
  const modal = open(page);
  const inputs = fill(modal);
  submit(modal);
  cleared(inputs);
  assert.equal(loginInput(page.tree()), undefined);
  pending.resolve(ok(status({ revision: 5, loggedIn: false, passwordChanged: true })));
  await settle();
  tree = page.tree();
  assert.equal(passwordModal(page).props.open, false);
  assert.equal(page.controller.getSnapshot().status.loggedIn, false);
  assert.ok(button(tree, '登录'));
  assert.equal(nodes(tree).filter(node => node.type === 'native:Input').length, 3);
  const restored = loginInput(tree);
  assert.ok(restored);
  assert.equal(Object.hasOwn(restored.props, 'value'), false);
  assert.equal(Object.hasOwn(restored.props, 'defaultValue'), false);
  assert.equal(restored.props.ref.current?.value ?? '', '');
  cleared(inputs);
  for (const value of Object.values(secret())) {
    assert.equal(JSON.stringify(page.controller.getSnapshot()).includes(value), false);
    assert.equal(text(tree).includes(value), false);
  }
  assert.equal(page.calls.filter(call => call.action === 'password').length, 1);
  assert.equal(page.calls.some(call => call.action === 'login' || call.action === 'sync'), false);
});

test('password modal rejects 7-codepoint secrets without RPC and displays the 8-codepoint minimum', async t => {
  const page = setupPage(t, () => ok(status()));
  await mounted(page);
  for (const next of ['a'.repeat(7), '界'.repeat(7), '😀'.repeat(7)]) {
    const modal = open(page);
    const inputs = fill(modal, [secret().currentPassword, next, next]);
    const before = page.calls.length;
    submit(modal);
    await settle();
    cleared(inputs);
    assert.equal(page.calls.length, before);
    assert.match(text(passwordModal(page)), /新密码至少8位/);
    assert.equal(text(page.tree()).includes(next), false);
  }
});

test('password modal confirmation mismatch clears secrets and displays a short error without RPC', async t => {
  const page = setupPage(t, () => ok(status()));
  await mounted(page);
  const modal = open(page);
  const inputs = fill(modal, [secret().currentPassword, secret().newPassword, 'wrong confirmation']);
  const before = page.calls.length;
  submit(modal);
  await settle();
  cleared(inputs);
  assert.equal(page.calls.length, before);
  assert.match(text(passwordModal(page)), /两次新密码不一致/);
  assert.doesNotMatch(text(page.tree()), /wrong confirmation|old synthetic|new synthetic/);
});

test('password modal clears all secrets on leaving its form, cancel and unmount', async t => {
  const page = setupPage(t, () => ok(status()));
  await mounted(page);
  let modal = open(page);
  let inputs = fill(modal);
  const form = nodes(modal).find(node => node.type === 'form');
  form.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
  assert.equal(inputs[0].props.ref.current.value, secret().currentPassword);
  form.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  cleared(inputs);
  fill(modal);
  button(modal, '取消').props.onClick();
  cleared(inputs);
  assert.equal(passwordModal(page).props.open, false);
  modal = open(page);
  inputs = fill(modal);
  modal.props.onClose();
  cleared(inputs);
  modal = open(page);
  inputs = fill(modal);
  page.unmount();
  cleared(inputs);
  assert.equal(page.calls.some(call => call.action === 'password'), false);
});

test('password modal invalidates immediately on Host server, username or revision changes before stale submission', async t => {
  for (const patch of [{ server: 'https://next.example.test' }, { username: 'next-account' }, { revision: 5 }]) {
    let current = status();
    const page = setupPage(t, () => ok(current));
    await mounted(page);
    const modal = open(page);
    const inputs = fill(modal);
    current = { ...current, ...patch };
    await page.controller.refresh();
    cleared(inputs); // No rerender/effect pass is required for invalidation.
    submit(modal); // The old event handler must not use the new destination.
    await settle();
    assert.equal(passwordModal(page).props.open, false);
    assert.equal(page.calls.some(call => call.action === 'password'), false);
  }
});

test('password modal closes and clears on unsaved destination edits; an old handler cannot submit', async t => {
  const page = setupPage(t, () => ok(status({ loggedIn: false })));
  await mounted(page);
  for (const id of ['mock-password-server', 'mock-password-username']) {
    const modal = open(page);
    const inputs = fill(modal);
    nodes(page.tree()).find(node => node.type === 'native:Input' && node.props.id === id).props.onChange({ target: { value: 'synthetic-edited-destination' } });
    cleared(inputs);
    submit(modal);
    assert.equal(passwordModal(page).props.open, false);
  }
  assert.equal(page.calls.some(call => call.action === 'password'), false);
});

test('password modal cancellation and unmount during submit abort native request and keep login fail-closed', async t => {
  for (const unmount of [false, true]) {
    const pending = deferred();
    const page = setupPage(t, call => call.action === 'password' ? pending.promise : ok(status({ autoSync: true })));
    await mounted(page);
    const modal = open(page);
    const inputs = fill(modal);
    submit(modal);
    cleared(inputs);
    fill(modal);
    if (unmount) page.unmount(); else modal.props.onClose();
    await settle();
    cleared(inputs);
    assert.equal(page.calls.find(call => call.action === 'password').signal.aborted, true);
    assert.equal(page.controller.getSnapshot().status.loggedIn, false);
    assert.equal(page.controller.getSnapshot().status.autoSync, false);
    assert.equal(page.calls.filter(call => call.action === 'password').length, 1);
    pending.resolve(ok(status({ loggedIn: false, revision: 5 })));
    await settle();
    assert.equal(page.controller.getSnapshot().notice, '');
  }
});

test('password modal clears login and change-password inputs for unrelated submit start and finish', async t => {
  const pending = deferred();
  const page = setupPage(t, call => call.action === 'preferences' ? pending.promise : ok(status({ loggedIn: false })));
  await mounted(page);
  const modal = open(page);
  const inputs = fill(modal);
  const loginInput = nodes(page.tree()).find(node => node.type === 'native:Input' && node.props.id === 'mock-password-password');
  loginInput.props.ref.current = { value: 'synthetic-login-secret' };
  page.controller.setProject(project.id, false);
  const saving = page.controller.savePreferences();
  cleared(inputs);
  assert.equal(loginInput.props.ref.current.value, '');
  fill(modal);
  loginInput.props.ref.current.value = 'synthetic-login-secret';
  pending.resolve(ok(status({ loggedIn: false, revision: 5, projects: [{ ...project, selected: false }] })));
  await saving;
  cleared(inputs);
  assert.equal(loginInput.props.ref.current.value, '');
  assert.equal(passwordModal(page).props.open, false);
});
