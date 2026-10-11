import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createConnectionTransport, createController, deriveView, parseStatus, parseUpdateStatus } from '../client/state.mjs';
import { createClientPlugin } from '../client/adapter.mjs';

// Synthetic Connection/controller/React contracts only: no installed profile, native install or real GUI.
const uuid = 'a0000000-0000-4000-8000-000000000001';
const candidate = { id: 'candidate-one', version: '0.6.0', commit: 'a'.repeat(40), checkedAt: '2026-03-01T12:00:00.000Z' };
const update = (extra = {}) => ({ currentVersion: '0.5.0', supported: true, state: 'idle', restartRequired: false, ...extra });
const available = (extra = {}) => update({ state: 'available', candidate, ...extra });
const running = (extra = {}) => update({ state: 'installing', restartRequired: true, requestId: uuid, candidate, ...extra });
const project = { id: 'workspace:synthetic', projectId: 'cloud-one', label: 'Synthetic', root: 'E:\\synthetic\\project', selected: true, available: true };
const status = (extra = {}) => ({ revision: 4, server: '', username: '', loggedIn: false, autoSync: false,
  running: false, pending: 0, intervalMs: 60000, projects: [{ ...project }], ...extra });
const signed = { server: 'https://synthetic.example.test', username: 'synthetic-account', loggedIn: true };
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted-secret-token', details: { path: 'untrusted-secret-token' } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 40; ++i) await Promise.resolve(); }
function timers() {
  let next = 0; const jobs = new Map();
  return { jobs, setTimeout(fn, ms) { jobs.set(++next, { fn, ms }); return next; }, clearTimeout(id) { jobs.delete(id); },
    run(ms) { const item = [...jobs].find(([, job]) => job.ms === ms); assert.ok(item, `missing timer ${ms}`); jobs.delete(item[0]); item[1].fn(); } };
}
function connection(handler) {
  const calls = [];
  return { calls, connection: { rpc: { async call(channel, endpoint, payload, signal) {
    const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call); return handler(call);
  } } } };
}
function setup(t, handler, options = {}) {
  const mock = connection(handler); const clock = timers();
  const controller = createController(mock.connection, { ...clock, crypto: { randomUUID: () => uuid }, ...options });
  t.after(() => controller.dispose()); return { ...mock, clock, controller };
}
const readOnly = call => ok(call.action === 'status' ? status({ update: available() }) : { update: available() });

test('update public contract deeply allowlists, freezes and mirrors ordinary status without retaining diagnostic echoes', () => {
  const input = available({ installedVersion: '0.5.1', requestId: uuid, token: 'untrusted-secret-token', diagnostics: { log: 'untrusted-secret-token' },
    candidate: { ...candidate, url: 'untrusted-secret-token', approvedBuilds: ['untrusted-secret-token'], registry: 'untrusted-secret-token' } });
  const parsed = parseUpdateStatus(input);
  assert.deepEqual(parsed, available({ installedVersion: '0.5.1', requestId: uuid }));
  assert.equal(Object.isFrozen(parsed), true); assert.equal(Object.isFrozen(parsed.candidate), true);
  assert.equal(JSON.stringify(parsed).includes('untrusted-secret-token'), false);
  input.candidate.version = '100.0.0'; assert.equal(parsed.candidate.version, candidate.version);
  const ordinary = parseStatus(status({ update: parsed }));
  assert.deepEqual(ordinary.update, parsed); assert.equal(Object.isFrozen(ordinary.update), true);
  assert.equal(Object.hasOwn(parseStatus(status()), 'update'), false);
});

test('update parser rejects malformed versions, protocol IDs, dates, hashes, flags and secret error codes', () => {
  for (const version of [null, '', '1.2', '1.2.3-beta', 'v1.2.3', '01.2.3', '-1.2.3', '1.2.3+secret', '9007199254740992.0.0']) {
    assert.throws(() => parseUpdateStatus(update({ currentVersion: version })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => parseUpdateStatus(update({ installedVersion: version })), { code: 'INVALID_RESPONSE' });
  }
  for (const patch of [{ supported: 1 }, { restartRequired: 'false' }, { state: 'done' }, { errorCode: 'untrusted-secret-token' }, { errorCode: 'LOGIN_FAILED' },
    { requestId: '../escape' }, { requestId: 'constructor' }, { requestId: '__proto__' }, { requestId: 'a'.repeat(101) }, { candidate: null }, { candidate: undefined }]) {
    assert.throws(() => parseUpdateStatus(available(patch)), { code: 'INVALID_RESPONSE' });
  }
  for (const patch of [{ id: '../escape' }, { id: 'prototype' }, { version: '0.5.0' }, { version: '0.4.99' }, { version: '0.6.0-secret' },
    { commit: 'A'.repeat(40) }, { commit: 'a'.repeat(39) }, { commit: 'g'.repeat(40) }, { checkedAt: '2026-03-01' }, { checkedAt: '2026-03-01T12:00:00Z' }, { checkedAt: 'untrusted-secret-token' }]) {
    assert.throws(() => parseUpdateStatus(available({ candidate: { ...candidate, ...patch } })), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => parseUpdateStatus(running({ requestId: undefined })), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseUpdateStatus(update({ state: 'restart-required' })), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseStatus(status({ update: null })), { code: 'INVALID_RESPONSE' });
  assert.equal(parseUpdateStatus(available({ currentVersion: '0.9.0', candidate: { ...candidate, version: '0.10.0' } })).candidate.version, '0.10.0');
  assert.equal(parseUpdateStatus(update({ currentVersion: '9007199254740991.0.0' })).currentVersion, '9007199254740991.0.0');
});

test('update accepts only safe native error codes and transport uses exact native action names', async () => {
  const codes = ['UPDATE_UNAVAILABLE', 'UPDATE_UNMANAGED', 'UPDATE_CHECK_FAILED', 'UPDATE_INVALID_METADATA', 'UPDATE_CHECK_REQUIRED', 'UPDATE_NOT_NEWER', 'UPDATE_BUILD_APPROVAL_REQUIRED', 'UPDATE_INCOMPATIBLE', 'UPDATE_FAILED', 'UPDATE_UNCERTAIN', 'UPDATE_CANCEL_TOO_LATE', 'UPDATE_RESTART_REQUIRED', 'BAD_REQUEST', 'BUSY', 'DISPOSED', 'RATE_LIMITED'];
  for (const errorCode of codes) assert.equal(parseUpdateStatus(update({ errorCode })).errorCode, errorCode);
  const mock = connection(() => ok({ update: update() })); const transport = createConnectionTransport(mock.connection);
  for (const action of ['updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']) await transport(action, {});
  assert.ok(mock.calls.every(call => call.channel === '/api' && call.endpoint === `dsh-personal-sync/${call.action}`));
  await assert.rejects(() => transport('updatePlugin', {}), { code: 'BAD_REQUEST' });
});

test('update starts inert and explicit logged-out check uses no browser fetch, account payload or automatic writes', async t => {
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('browser fetch forbidden'); };
  t.after(() => { globalThis.fetch = previous; });
  const { controller, calls, clock } = setup(t, call => ok(call.action === 'status' ? status({ update: update() }) : { update: available() }));
  assert.equal(calls.length, 0); assert.equal(controller.getSnapshot().update, null);
  assert.equal(controller.prepareUpdate(), null); assert.equal(await controller.confirmUpdate({}), false);
  const close = controller.watch(); await settle();
  assert.deepEqual(calls.map(call => call.action), ['status']);
  assert.equal(deriveView(controller.getSnapshot()).canCheckUpdate, true);
  assert.equal(await controller.checkUpdate(), true);
  assert.deepEqual(calls.at(-1).payload, {}); assert.equal(calls.at(-1).action, 'checkupdate');
  assert.equal(controller.getSnapshot().status.update, controller.getSnapshot().update);
  assert.equal(deriveView(controller.getSnapshot()).canUpdate, true);
  assert.equal(clock.jobs.size, 0);
  const intent = controller.prepareUpdate(); assert.ok(intent); controller.cancelUpdateIntent();
  assert.equal(await controller.confirmUpdate(intent), false);
  assert.deepEqual(calls.map(call => call.action), ['status', 'checkupdate']); close();
});

test('update check/status/login never implicitly check GitHub or install, and cloud revision does not bind updater', async t => {
  let current = status({ update: available() });
  const { controller, calls } = setup(t, call => {
    if (call.action === 'login') current = status({ ...signed, revision: 5, update: available() });
    return ok(current);
  });
  await controller.refresh(); const intent = controller.prepareUpdate();
  assert.equal(await controller.login({ ...signed, password: 'synthetic-only' }), true);
  assert.equal(controller.getSnapshot().updateIntent, intent);
  await controller.refresh();
  assert.deepEqual(calls.map(call => call.action), ['status', 'login', 'status']);
  assert.equal(controller.getSnapshot().update.currentVersion, '0.5.0');
});

test('update confirmation consumes a frozen version/runtime/commit-bound intent and sends only exact pinned candidate payload once', async t => {
  let current = available(); let generated = 0; const response = deferred();
  const { controller, calls } = setup(t, call => call.action === 'installupdate' ? response.promise : ok(call.action === 'status' ? status({ update: current }) : { update: current }),
    { crypto: { randomUUID() { ++generated; return uuid; } } });
  await controller.refresh(); const intent = controller.prepareUpdate();
  assert.deepEqual(intent, { candidateId: candidate.id, version: candidate.version, commit: candidate.commit, currentVersion: '0.5.0', requestId: uuid });
  assert.equal(Object.isFrozen(intent), true); assert.equal(controller.prepareUpdate(), intent); assert.equal(generated, 1);
  assert.equal(await controller.confirmUpdate({ ...intent, url: 'https://untrusted.example.test' }), false);
  const pending = controller.confirmUpdate(intent);
  assert.equal(controller.getSnapshot().updateIntent, null);
  assert.equal(await controller.confirmUpdate(intent), false);
  assert.deepEqual(calls.at(-1).payload, { candidateId: candidate.id, requestId: uuid, confirm: true });
  current = running(); response.resolve(ok({ update: current })); assert.equal(await pending, true);
  assert.equal(controller.getSnapshot().update.state, 'installing');
  assert.equal(calls.filter(call => call.action === 'installupdate').length, 1);
  assert.equal(calls.at(-1).action, 'updatestatus'); assert.deepEqual(calls.at(-1).payload, {});
  assert.ok(calls.every(call => !['sync', 'restore', 'import', 'preferences'].includes(call.action)));
});

test('update UUID fallback is secure and broken crypto never creates an intent', async t => {
  for (const crypto of [{}, { randomUUID: () => 'not-a-uuid' }, { randomUUID() { throw new Error('untrusted-secret-token'); } }]) {
    const { controller, calls } = setup(t, readOnly, { crypto }); await controller.refresh();
    assert.equal(controller.prepareUpdate(), null); assert.equal(controller.getSnapshot().updateError.code, 'BAD_REQUEST_ID'); assert.equal(calls.length, 1);
  }
  const { controller } = setup(t, readOnly, { crypto: { getRandomValues(bytes) { bytes.fill(2); return bytes; } } });
  await controller.refresh(); assert.match(controller.prepareUpdate().requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('update candidate, commit, target and runtime changes invalidate stale confirmations immediately', async t => {
  for (const replacement of [available({ candidate: { ...candidate, id: 'new-candidate' } }), available({ candidate: { ...candidate, version: '0.7.0' } }),
    available({ candidate: { ...candidate, commit: 'b'.repeat(40) } }), available({ currentVersion: '0.5.1' }), update({ state: 'up-to-date' })]) {
    let current = available(); const { controller, calls } = setup(t, () => ok(status({ update: current })));
    await controller.refresh(); const intent = controller.prepareUpdate(); current = replacement; await controller.refresh();
    assert.equal(controller.getSnapshot().updateIntent, null); assert.equal(await controller.confirmUpdate(intent), false);
    assert.ok(calls.every(call => call.action === 'status'));
  }
});

test('update dirty preferences, pending sync and recovery lock installation without removing normal upload cancellation', async t => {
  let current = status({ ...signed, update: available() }); const { controller, calls } = setup(t, () => ok(current));
  await controller.refresh(); const intent = controller.prepareUpdate(); controller.setAutoSync(true);
  assert.equal(controller.prepareUpdate(), null); assert.equal(await controller.confirmUpdate(intent), false);
  controller.discardChanges();
  current = status({ ...signed, running: true, update: available() }); await controller.refresh();
  assert.equal(controller.prepareUpdate(), null); assert.equal(deriveView(controller.getSnapshot()).editable, true); assert.equal(deriveView(controller.getSnapshot()).canLogout, true);
  current = status({ ...signed, recovery: { id: 'restore-one', kind: 'restore', state: 'running', root: 'E:\\synthetic\\new' }, update: available() }); await controller.refresh();
  assert.equal(controller.prepareUpdate(), null); assert.equal(await controller.confirmUpdate(intent), false);
  assert.ok(calls.every(call => call.action === 'status'));
});

test('update native running work polls local reads while logged out and survives reopen without replay', async t => {
  let current = running(); const { controller, clock, calls } = setup(t, call => ok(call.action === 'status' ? status({ update: current }) : { update: current }));
  const close = controller.watch(); await settle(); assert.equal(controller.getSnapshot().updatePendingId, uuid);
  assert.equal(deriveView(controller.getSnapshot()).canCancelUpdate, true);
  clock.run(3000); await settle(); assert.equal(calls.at(-1).action, 'updatestatus');
  close(); assert.equal(clock.jobs.size, 0);
  current = running({ state: 'cancelling' }); const closeAgain = controller.watch(); await settle();
  assert.equal(controller.getSnapshot().update.state, 'cancelling'); assert.equal(deriveView(controller.getSnapshot()).canCancelUpdate, false);
  current = running({ state: 'restart-required', installedVersion: candidate.version }); clock.run(3000); await settle();
  assert.equal(controller.getSnapshot().updatePendingId, null); assert.equal(clock.jobs.size, 0);
  assert.equal(controller.getSnapshot().update.installedVersion, candidate.version);
  assert.ok(calls.every(call => ['status', 'updatestatus'].includes(call.action))); closeAgain();
  const reopened = setup(t, () => ok(status({ update: current }))); await reopened.controller.refresh();
  assert.equal(deriveView(reopened.controller.getSnapshot()).restartRequired, true);
});

test('update unmount aborts local reads, clears confirmation and prevents late status from overwriting reopen', async t => {
  let current = available(); const late = deferred();
  const { controller, calls, clock } = setup(t, call => call.action === 'updatestatus' ? late.promise : ok(status({ update: current })));
  const close = controller.watch(); await settle(); const intent = controller.prepareUpdate(); close();
  assert.equal(controller.getSnapshot().updateIntent, null); assert.equal(await controller.confirmUpdate(intent), false);
  current = running(); const closeAgain = controller.watch(); await settle(); clock.run(3000); await settle();
  const read = calls.at(-1); closeAgain(); await settle(); assert.equal(read.signal.aborted, true); assert.equal(clock.jobs.size, 0);
  current = update({ currentVersion: candidate.version, state: 'up-to-date' }); const stop = controller.watch(); await settle();
  late.resolve(ok({ update: running() })); await settle();
  assert.equal(controller.getSnapshot().update.currentVersion, candidate.version); assert.equal(controller.getSnapshot().updatePendingId, null); stop();
});

test('update response loss reconciles matching Host task by read, ignores late delivery and never replays install', async t => {
  let current = available(); const late = deferred();
  const { controller, clock, calls } = setup(t, call => {
    if (call.action === 'installupdate') { current = running(); return late.promise; }
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  const close = controller.watch(); await settle(); const intent = controller.prepareUpdate(); const pending = controller.confirmUpdate(intent);
  clock.run(60000); assert.equal(await pending, false);
  assert.equal(calls.find(call => call.action === 'installupdate').signal.aborted, true);
  assert.equal(controller.getSnapshot().updateUncertain, false); assert.equal(controller.getSnapshot().update.state, 'installing');
  late.resolve(ok({ update: running({ state: 'restart-required', installedVersion: candidate.version }) })); await settle();
  assert.equal(controller.getSnapshot().update.state, 'installing');
  assert.equal(await controller.confirmUpdate(intent), false); assert.equal(calls.filter(call => call.action === 'installupdate').length, 1); close();
});

test('update uncertainty bounds read-only reconciliation, blocks new intents and allows manual read without replay', async t => {
  let current = available(); const { controller, clock, calls } = setup(t, call => {
    if (call.action === 'installupdate') throw new Error('untrusted-secret-token');
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  const close = controller.watch(); await settle(); const intent = controller.prepareUpdate();
  assert.equal(await controller.confirmUpdate(intent), false); assert.equal(controller.getSnapshot().updateUncertain, true);
  for (let i = 0; i < 9; ++i) { clock.run(3000); await settle(); }
  assert.equal(calls.filter(call => call.action === 'updatestatus').length, 10); assert.equal(clock.jobs.size, 0);
  assert.equal(controller.prepareUpdate(), null); assert.equal(await controller.checkUpdate(), false);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-secret-token'), false);
  current = running({ state: 'failed', errorCode: 'UPDATE_FAILED' }); await controller.refreshUpdate();
  assert.equal(controller.getSnapshot().updateUncertain, false); assert.equal(controller.getSnapshot().updatePendingId, null);
  assert.equal(controller.getSnapshot().updateError, null); assert.equal(deriveView(controller.getSnapshot()).restartRequired, true);
  assert.equal(calls.filter(call => call.action === 'installupdate').length, 1); close();
});

test('update malformed or mismatched acceptance is uncertain, never successful or replayed', async t => {
  for (const reply of [{}, { update: available() }, { update: running({ requestId: 'other-request' }) }, { update: running({ errorCode: 'untrusted-secret-token' }) }]) {
    const { controller, calls } = setup(t, call => call.action === 'installupdate' ? ok(reply) : readOnly(call)); await controller.refresh();
    const intent = controller.prepareUpdate(); assert.equal(await controller.confirmUpdate(intent), false);
    assert.equal(controller.getSnapshot().updateUncertain, true); assert.equal(controller.getSnapshot().updatePendingId, uuid);
    assert.equal(await controller.confirmUpdate(intent), false); assert.equal(calls.filter(call => call.action === 'installupdate').length, 1);
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-secret-token'), false);
  }
});

test('update mismatched status never grants cancellation of another task and reconciliation stays bounded', async t => {
  let current = running(); const { controller, clock, calls } = setup(t, call => ok(call.action === 'status' ? status({ update: current }) : { update: current }));
  const close = controller.watch(); await settle();
  current = running({ requestId: 'somebody-elses-task' }); clock.run(3000); await settle();
  assert.equal(controller.getSnapshot().updatePendingId, uuid); assert.equal(controller.getSnapshot().updateUncertain, true);
  assert.equal(deriveView(controller.getSnapshot()).canCancelUpdate, false); assert.equal(await controller.cancelUpdate(), false);
  for (let i = 0; i < 10; ++i) { clock.run(3000); await settle(); }
  assert.equal(clock.jobs.size, 0); assert.ok(calls.every(call => ['status', 'updatestatus'].includes(call.action))); close();
});

test('update definite admission and restart refusals do not create stuck unknown tasks or mutation replays', async t => {
  for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_DEPLOYED', 'UPDATE_RESTART_REQUIRED', 'UPDATE_CHECK_REQUIRED', 'BUSY']) {
    const { controller, calls, clock } = setup(t, call => call.action === 'installupdate' ? failure(code) : readOnly(call));
    const close = controller.watch(); await settle();
    assert.equal(await controller.confirmUpdate(controller.prepareUpdate()), false);
    assert.equal(controller.getSnapshot().updateUncertain, false); assert.equal(controller.getSnapshot().updatePendingId, null);
    assert.equal(controller.getSnapshot().updateError.code, code); assert.equal(clock.jobs.size, 0);
    assert.equal(deriveView(controller.getSnapshot()).restartRequired, code === 'UPDATE_RESTART_REQUIRED');
    assert.equal(calls.filter(call => call.action === 'installupdate').length, 1); assert.equal(calls.at(-1).action, 'updatestatus'); close();
  }
});

test('update observed terminal uncertain task permits logout but transport uncertainty and live installer do not', async t => {
  let current = status({ ...signed, update: running({ state: 'uncertain', errorCode: 'UPDATE_UNCERTAIN' }) });
  const { controller } = setup(t, () => ok(current)); await controller.refresh();
  assert.equal(controller.getSnapshot().updateUncertain, true); assert.equal(controller.getSnapshot().updatePendingId, null);
  assert.equal(deriveView(controller.getSnapshot()).canLogout, true); assert.equal(deriveView(controller.getSnapshot()).canSync, false);
  assert.equal(deriveView(controller.getSnapshot()).canChangePassword, false); assert.equal(controller.prepareUpdate(), null);
  current = status({ ...signed, update: running({ errorCode: 'UPDATE_UNCERTAIN' }) }); await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false); assert.equal(deriveView(controller.getSnapshot()).updaterBusy, true);
  current = status({ ...signed, update: running({ state: 'uncertain', requestId: undefined }) }); await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canLogout, false);
});

test('update currentVersion change clears old uncertainty and restart latch without cloud-account revision changes', async t => {
  let current = available(); const { controller } = setup(t, call => {
    if (call.action === 'installupdate') throw new Error('response lost');
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  await controller.refresh(); await controller.confirmUpdate(controller.prepareUpdate()); assert.equal(controller.getSnapshot().updateUncertain, true);
  current = update({ currentVersion: '0.6.0', state: 'up-to-date' }); await controller.refreshUpdate();
  assert.equal(controller.getSnapshot().updateUncertain, false); assert.equal(controller.getSnapshot().updatePendingId, null);
  assert.equal(controller.getSnapshot().updateError, null); assert.equal(deriveView(controller.getSnapshot()).canLogin, true);
});

test('update cancellation sends only current task ID, consumes duplicate clicks and keeps cancellation available during reads', async t => {
  let current = running(); const lateRead = deferred(); const response = deferred(); let deferRead = true;
  const { controller, calls } = setup(t, call => {
    if (call.action === 'cancelupdate') return response.promise;
    if (call.action === 'updatestatus' && deferRead) return lateRead.promise;
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  await controller.refresh(); const reading = controller.refreshUpdate();
  assert.equal(deriveView(controller.getSnapshot()).canCancelUpdate, true);
  const cancel = controller.cancelUpdate({ requestId: 'foreign-request', confirm: true });
  assert.deepEqual(calls.at(-1).payload, { requestId: uuid }); assert.equal(await controller.cancelUpdate(), false);
  deferRead = false; current = running({ state: 'cancelling' }); response.resolve(ok({ update: current }));
  assert.equal(await cancel, true); await reading;
  assert.equal(calls.find(call => call.action === 'updatestatus').signal.aborted, true);
  assert.equal(controller.getSnapshot().update.state, 'cancelling'); assert.equal(deriveView(controller.getSnapshot()).canCancelUpdate, false);
  lateRead.resolve(ok({ update: running() })); await settle(); assert.equal(controller.getSnapshot().update.state, 'cancelling');
  current = running({ state: 'cancelled' }); await controller.refreshUpdate();
  assert.equal(controller.getSnapshot().update.restartRequired, true); assert.equal(controller.getSnapshot().updatePendingId, null);
  assert.equal(calls.filter(call => call.action === 'cancelupdate').length, 1);
});

test('update too-late cancellation is a safe warning, never a fake rollback or arbitrary diagnostics', async t => {
  const { controller, calls } = setup(t, call => call.action === 'cancelupdate' ? failure('UPDATE_CANCEL_TOO_LATE') : ok(call.action === 'status' ? status({ update: running() }) : { update: running() }));
  await controller.refresh(); assert.equal(await controller.cancelUpdate(), false);
  assert.equal(controller.getSnapshot().update.state, 'installing'); assert.equal(controller.getSnapshot().update.restartRequired, true);
  assert.equal(controller.getSnapshot().updateError.code, 'UPDATE_CANCEL_TOO_LATE'); assert.match(deriveView(controller.getSnapshot()).updateError, /不表示回滚/);
  assert.equal(deriveView(controller.getSnapshot()).canCancelUpdate, false); assert.equal(await controller.cancelUpdate(), false);
  assert.equal(calls.filter(call => call.action === 'cancelupdate').length, 1); assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-secret-token'), false);
});

test('update install/failure/cancel/restart gates block all writes, but allow logout only once native installer settles', async t => {
  let current = status({ ...signed, update: running() }); const { controller, calls } = setup(t, () => ok(current));
  await controller.refresh(); let view = deriveView(controller.getSnapshot());
  for (const key of ['editable', 'canLogin', 'canLogout', 'canChangePassword', 'canSync', 'canBrowse', 'canImport', 'canRestore', 'canUpdate']) assert.equal(view[key], false, key);
  assert.equal(await controller.logout(), false); assert.equal(await controller.savePreferences(), false); assert.equal(controller.setAutoSync(true), false);
  assert.equal(await controller.sync(), false); assert.equal(await controller.browseProjects(), false); assert.equal(controller.prepareRestore(), null);
  for (const terminal of ['failed', 'cancelled', 'uncertain', 'restart-required']) {
    current = status({ ...signed, update: running({ state: terminal, errorCode: terminal === 'failed' ? 'UPDATE_FAILED' : undefined }) }); await controller.refresh();
    view = deriveView(controller.getSnapshot());
    assert.equal(view.canSync, false); assert.equal(view.editable, false); assert.equal(view.canChangePassword, false);
    assert.equal(view.canLogout, true); assert.equal(controller.prepareUpdate(), null);
    assert.equal(await controller.login({ ...signed, password: 'synthetic' }), false);
    assert.equal(await controller.changePassword({ revision: 4, server: signed.server, username: signed.username }, { currentPassword: 'old', newPassword: 'new-password', confirmPassword: 'new-password' }), false);
  }
  current = status({ ...signed, update: update({ state: 'failed', restartRequired: false }) }); await controller.refresh();
  assert.equal(controller.getSnapshot().update.restartRequired, true); // Same-runtime Host omission cannot remove the observed latch.
  assert.ok(calls.every(call => call.action === 'status'));
  assert.equal(await controller.logout(), true); assert.equal(calls.at(-1).action, 'logout');
  current = status({ ...signed, update: update({ currentVersion: '0.6.0' }) }); await controller.refresh();
  assert.equal(deriveView(controller.getSnapshot()).canSync, true); assert.equal(deriveView(controller.getSnapshot()).editable, true);
});

test('update failed native result is not success and keeps restart gate even when install RPC itself returns ok', async t => {
  let current = available(); const { controller } = setup(t, call => {
    if (call.action === 'installupdate') current = running({ state: 'failed', errorCode: 'UPDATE_BUILD_APPROVAL_REQUIRED' });
    return ok(call.action === 'status' ? status({ ...signed, update: current }) : { update: current });
  });
  await controller.refresh(); assert.equal(await controller.confirmUpdate(controller.prepareUpdate()), false);
  assert.equal(controller.getSnapshot().update.state, 'failed'); assert.equal(deriveView(controller.getSnapshot()).restartRequired, true);
  assert.match(deriveView(controller.getSnapshot()).updateError, /DSH Plugins/); assert.equal(deriveView(controller.getSnapshot()).canLogout, true);
});

test('update absent or unsupported never hides existing cloud features or alters running-upload cancellation', async t => {
  for (const updater of [undefined, update({ supported: false, errorCode: 'UPDATE_UNAVAILABLE' }), update({ supported: false, errorCode: 'UPDATE_UNMANAGED' })]) {
    const { controller, calls } = setup(t, call => ok(call.action === 'projects' ? { projects: [] } : status({ ...signed, ...(updater ? { update: updater } : {}) })));
    await controller.refresh(); const view = deriveView(controller.getSnapshot());
    assert.equal(view.canSync, true); assert.equal(view.canBrowse, true); assert.equal(view.editable, true);
    assert.equal(await controller.browseProjects(), true); assert.equal(controller.setAutoSync(true), true);
    assert.equal(controller.getSnapshot().dirty, true); assert.ok(calls.every(call => ['status', 'projects'].includes(call.action)));
  }
});

test('update native check failures discard arbitrary bodies, block stale install intent and never auto-retry GitHub', async t => {
  for (const code of ['UPDATE_CHECK_FAILED', 'UPDATE_INVALID_METADATA', 'UPDATE_UNMANAGED', 'UPDATE_UNAVAILABLE', 'untrusted-secret-token']) {
    const { controller, calls, clock } = setup(t, call => call.action === 'checkupdate' ? failure(code) : readOnly(call));
    const close = controller.watch(); await settle(); const intent = controller.prepareUpdate();
    assert.equal(await controller.checkUpdate(), false); assert.equal(controller.getSnapshot().updateIntent, null);
    assert.equal(await controller.confirmUpdate(intent), false); assert.equal(controller.prepareUpdate(), null);
    assert.equal(clock.jobs.size, 0); assert.equal(calls.filter(call => call.action === 'checkupdate').length, 1);
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-secret-token'), false); close();
  }
});

function mockReact() {
  const cells = []; let cursor = 0; let effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }, useId() { return 'mock-update'; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = value; }]; },
    useEffect(effect, deps) { const i = cursor++; if (!cells[i] || deps.some((value, at) => value !== cells[i].deps[at])) { const item = { deps, effect, cleanup: cells[i]?.cleanup }; cells[i] = item; effects.push(item); } },
  };
  return { React, render(Component, props) { cursor = 0; return Component(props); }, mount() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } }, unmount() { for (const cell of cells) cell?.cleanup?.(); } };
}
function nodes(root) { return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)]; }
function text(root) { return typeof root === 'string' || typeof root === 'number' ? String(root) : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(text).join(' '); }
function button(root, label) { const found = nodes(root).find(node => node.type === 'native:Button' && text(node) === label); assert.ok(found, `missing ${label}`); return found; }
function modal(page) { return nodes(page.tree()).find(node => node.type === 'native:Modal' && node.props.title === '确认更新插件？'); }
function pageSetup(t, handler) {
  const hooks = mockReact(); const mock = connection(handler); const cleanups = []; let slot;
  const primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const required = []; const plugin = createClientPlugin(name => { required.push(name); return name === 'react' ? hooks.React : primitives; });
  plugin.apply({ connection: mock.connection, effect(effect) { cleanups.push(effect()); }, on() {}, slots: { inject(_name, register) { register(); }, register(spec, Component) { slot = { Component, props: spec.inject() }; } } });
  t.after(() => { hooks.unmount(); cleanups.forEach(cleanup => cleanup?.()); });
  return { ...mock, ...hooks, required, controller: slot.props.controller, tree: () => hooks.render(slot.Component, slot.props) };
}

test('update native React final card has one explicit action and a concise version/restart-bound Modal', async t => {
  let current = update(); const page = pageSetup(t, call => {
    if (call.action === 'checkupdate') current = available();
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  page.tree(); assert.equal(page.calls.length, 0); page.mount(); await settle();
  assert.deepEqual(page.required, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.equal(modal(page).props.open, false); assert.match(text(page.tree()), /插件更新/); assert.match(text(page.tree()), /当前版本 0.5.0/);
  const children = page.tree().props.children.filter(node => node && typeof node === 'object');
  const card = children.filter(node => node.type === 'section').at(-1);
  assert.equal(card.props['data-personal-sync'], 'update-summary');
  assert.equal(children.indexOf(card) < children.findIndex(node => node.type === 'native:Modal'), true);
  assert.equal(nodes(card).filter(node => node.type === 'native:Button').length, 1);
  assert.doesNotMatch(text(page.tree()), /GitHub|固定来源|一键更新|核对更新状态|取消更新|安全检查|Host 后台/);
  assert.equal(button(card, '检查更新').props.disabled, false);
  button(page.tree(), '检查更新').props.onClick(); await settle();
  assert.equal(nodes(page.tree()).some(node => node.type === 'native:Button' && text(node) === '检查更新'), false);
  button(page.tree(), '手动更新').props.onClick(); const confirm = modal(page);
  assert.equal(confirm.props.open, true); assert.match(text(confirm), /0.5.0 → 0.6.0/);
  assert.equal(page.controller.getSnapshot().updateIntent.commit, candidate.commit);
  assert.equal(text(confirm).includes(candidate.commit), false);
  assert.match(text(confirm), /更新后需重启 DSH/);
  assert.doesNotMatch(text(confirm), /GitHub|DSH Plugins|提交|豁免|自动/);
  assert.deepEqual(page.calls.map(call => call.action), ['status', 'checkupdate']);
  button(confirm, '取消').props.onClick(); assert.equal(modal(page).props.open, false);
  assert.ok(page.calls.every(call => !['installupdate', 'cancelupdate'].includes(call.action)));
});

test('an available update keeps one manual-update action disabled while preferences are dirty', async t => {
  const page = pageSetup(t, () => ok(status({ ...signed, update: available() })));
  await page.controller.refresh();
  assert.equal(page.controller.setAutoSync(true), true);
  const card = nodes(page.tree()).find(node => node.props?.['data-personal-sync'] === 'update-summary');
  assert.equal(nodes(card).filter(node => node.type === 'native:Button').length, 1);
  assert.equal(button(card, '手动更新').props.disabled, true);
  assert.equal(nodes(card).some(node => node.type === 'native:Button' && text(node) === '检查更新'), false);
  button(card, '手动更新').props.onClick(); await settle();
  assert.deepEqual(page.calls.map(call => call.action), ['status']);
  page.controller.discardChanges();
  assert.equal(button(page.tree(), '手动更新').props.disabled, false);
});

test('update native React stale modal callbacks and duplicate click cannot write twice or use a replaced candidate', async t => {
  let current = available(); const page = pageSetup(t, call => {
    if (call.action === 'installupdate') current = running({ requestId: call.payload.requestId });
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  await page.controller.refresh(); button(page.tree(), '手动更新').props.onClick();
  const old = button(modal(page), '确认更新').props.onClick;
  current = available({ candidate: { ...candidate, id: 'replacement', commit: 'b'.repeat(40) } }); await page.controller.refresh(); old(); await settle();
  assert.equal(modal(page).props.open, false); assert.equal(page.calls.some(call => call.action === 'installupdate'), false);
  button(page.tree(), '手动更新').props.onClick(); const confirm = button(modal(page), '确认更新').props.onClick; confirm(); confirm(); await settle();
  assert.equal(page.calls.filter(call => call.action === 'installupdate').length, 1);
  assert.equal(page.calls.find(call => call.action === 'installupdate').payload.candidateId, 'replacement');
  assert.equal(modal(page).props.open, false); assert.match(text(page.tree()), /更新中…/);
  assert.equal(button(page.tree(), '更新中…').props.disabled, true);
  assert.doesNotMatch(text(page.tree()), /取消更新|核对更新状态|更新器忙碌/);
  assert.equal(button(page.tree(), '登录').props.disabled, true);
});

test('update native React failure/install/restart rendering locks controls, shows concise errors and clears secrets', async t => {
  let current = update(); const page = pageSetup(t, call => ok(call.action === 'status' ? status({ ...signed, update: current }) : { update: current }));
  await page.controller.refresh(); page.tree(); page.mount(); await settle();
  button(page.tree(), '修改密码').props.onClick();
  const secretInput = nodes(page.tree()).find(node => node.type === 'native:Input' && node.props.type === 'password');
  secretInput.props.ref.current = { value: 'unsubmitted-synthetic-secret' };
  current = running(); await page.controller.refresh(); assert.equal(secretInput.props.ref.current.value, '');
  for (const label of ['修改密码', '退出登录', '立即同步', '选择项目', '保存位置', '下载所选', '管理']) assert.equal(button(page.tree(), label).props.disabled, true, label);
  assert.equal(nodes(page.tree()).find(node => node.type === 'native:Switch').props.disabled, true);
  current = running({ state: 'failed', installedVersion: '0.6.0', errorCode: 'UPDATE_BUILD_APPROVAL_REQUIRED' }); await page.controller.refresh();
  assert.match(text(page.tree()), /更新未完成/); assert.equal(page.controller.getSnapshot().update.installedVersion, '0.6.0');
  assert.match(text(page.tree()), /原生安装需要脚本审批/); assert.match(text(page.tree()), /请重启 DSH/);
  assert.equal(button(page.tree(), '退出登录').props.disabled, false); assert.equal(button(page.tree(), '立即同步').props.disabled, true);
  assert.equal(button(page.tree(), '待重启').props.disabled, true); assert.doesNotMatch(text(page.tree()), /更新成功/);
});

test('update global refresh reconciles uncertainty and restart without reinstalling or exposing standalone actions', async t => {
  let current = available();
  const page = pageSetup(t, call => {
    if (call.action === 'installupdate') throw new Error('response lost');
    return ok(call.action === 'status' ? status({ update: current }) : { update: current });
  });
  await page.controller.refresh(); button(page.tree(), '手动更新').props.onClick();
  button(modal(page), '确认更新').props.onClick(); await settle();
  assert.equal(page.controller.getSnapshot().updateUncertain, true);
  assert.equal(button(page.tree(), '检查更新').props.disabled, true);
  assert.equal(button(page.tree(), '刷新').props.disabled, false);
  const requestId = page.calls.find(call => call.action === 'installupdate').payload.requestId;
  current = running({ requestId, state: 'restart-required' });
  button(page.tree(), '刷新').props.onClick(); await settle();
  assert.equal(page.calls.at(-1).action, 'status');
  assert.equal(page.controller.getSnapshot().updateUncertain, false);
  assert.equal(button(page.tree(), '待重启').props.disabled, true);
  assert.equal(page.calls.filter(call => call.action === 'installupdate').length, 1);
  assert.doesNotMatch(text(page.tree()), /核对更新状态|取消更新|一键更新/);
});

test('update source keeps adapter first import exact and adds no browser fetch/navigation or SDK dependency', async () => {
  const adapter = await readFile(new URL('../client/adapter.mjs', import.meta.url), 'utf8');
  const state = await readFile(new URL('../client/state.mjs', import.meta.url), 'utf8');
  assert.equal(adapter.split(/\r?\n/)[0], "import { createController, deriveView, filterProjects } from './state.mjs';");
  assert.doesNotMatch(adapter + state, /\bfetch\s*\(|window\.|location\.(?:href|assign|replace)|localStorage|sessionStorage|approvedBuilds\s*:/);
});
