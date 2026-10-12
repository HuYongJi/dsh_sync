import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAuth, validateDeviceAuthState } from '../server/device-auth.mjs';
import { sha256 } from '../src/protocol.mjs';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2025, 0, 1);
const DEVICE = 'device-auth-test';
const OTHER_DEVICE = 'another-device';
const digest = value => sha256(Buffer.from(value));
const opaque = byte => Buffer.alloc(32, byte).toString('base64url');
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const unauthorized = { status: 401, message: 'Unauthorized' };
const corrupt = { status: 500, message: 'Invalid device authentication state' };
function auth() {
  return { username: 'synthetic-owner', algorithm: 'scrypt', hash: 'a'.repeat(128), salt: 'b'.repeat(64), N: 32768, r: 8, p: 1, passwordRevision: 0 };
}
function initial() {
  return { version: 2, serverId: 'synthetic-server', auth: auth(), tokens: [], families: [], checkpoints: [{ id: 'unchanged-synthetic-checkpoint' }] };
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function fixture(options = {}, input = initial()) {
  let time = START;
  const store = {
    state: freeze(structuredClone(input)), tail: Promise.resolve(), locked: false, attempts: [], commits: 0, beforeSave: undefined,
    async save(next) {
      assert.equal(this.locked, true, 'all device authentication writes share the global lock');
      this.attempts.push(structuredClone(next));
      await this.beforeSave?.(next);
      this.state = freeze(next); this.commits += 1;
    },
    exclusive(task) {
      const result = this.tail.then(async () => {
        assert.equal(this.locked, false);
        this.locked = true;
        try { return await task(); } finally { this.locked = false; }
      });
      this.tail = result.catch(() => {});
      return result;
    },
  };
  const helper = createDeviceAuth({ store, now: () => time, ...options });
  const f = {
    helper, store,
    get time() { return time; }, setTime(value) { time = value; }, advance(ms) { time += ms; },
    issue(deviceId = DEVICE, authSnapshot = store.state.auth) { return helper.issue({ deviceId, authSnapshot }); },
    proof(result, deviceId = DEVICE) { return { deviceId, refreshToken: result.refreshToken, familyId: result.familyId }; },
    refresh(result, deviceId = DEVICE) { return helper.refresh(this.proof(result, deviceId)); },
    token(result) { return store.state.tokens.find(token => token.hash === digest(result.token)); },
    logout(result) { return helper.logout({ token: this.token(result) }); },
    changePassword() {
      return store.exclusive(async () => {
        const state = store.state;
        await store.save({ ...state, auth: { ...state.auth, hash: 'c'.repeat(128), salt: 'd'.repeat(64), passwordRevision: state.auth.passwordRevision + 1 }, tokens: [], families: [] });
      });
    },
  };
  return f;
}
function pauseNextSave(f) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  let armed = true;
  f.store.beforeSave = async next => {
    if (armed) { armed = false; entered.resolve(next); await released.promise; }
  };
  return { entered: entered.promise, release: () => released.resolve() };
}
function familyRecord(extra = {}) {
  return { familyId: opaque(1), deviceId: DEVICE, refreshHash: digest(opaque(2)), createdAt: START,
    refreshExpiresAt: START + 30 * DAY, absoluteExpiresAt: START + 90 * DAY, passwordRevision: 0, ...extra };
}
function tokenRecord(extra = {}) {
  return { hash: digest(opaque(3)), expiresAt: START + DAY, deviceId: DEVICE, ...extra };
}
function stateWithFamily() {
  const family = familyRecord();
  return { ...initial(), families: [family], tokens: [tokenRecord({ familyId: family.familyId })] };
}

test('device auth issues device-bound random grants with hashes only, preserving parent state', async () => {
  const f = fixture(), before = f.store.state;
  const result = await f.issue();
  assert.deepEqual(Object.keys(result).sort(), ['token', 'expiresAt', 'refreshToken', 'refreshExpiresAt', 'familyId', 'absoluteExpiresAt'].sort());
  for (const value of [result.token, result.refreshToken, result.familyId]) {
    assert.match(value, secretPattern); assert.equal(Buffer.from(value, 'base64url').length, 32);
    assert.equal(Buffer.from(value, 'base64url').toString('base64url'), value);
  }
  assert.equal(new Set([result.token, result.refreshToken, result.familyId]).size, 3);
  assert.equal(result.expiresAt, START + DAY);
  assert.equal(result.refreshExpiresAt, START + 30 * DAY);
  assert.equal(result.absoluteExpiresAt, START + 90 * DAY);
  assert.deepEqual(f.store.state.tokens, [{ hash: digest(result.token), expiresAt: result.expiresAt, deviceId: DEVICE, familyId: result.familyId }]);
  assert.deepEqual(f.store.state.families, [{ familyId: result.familyId, deviceId: DEVICE, refreshHash: digest(result.refreshToken),
    createdAt: START, refreshExpiresAt: result.refreshExpiresAt, absoluteExpiresAt: result.absoluteExpiresAt, passwordRevision: 0 }]);
  assert.equal(f.store.state.auth, before.auth);
  assert.equal(f.store.state.checkpoints, before.checkpoints);
  assert.equal(f.store.state.serverId, before.serverId);
  assert.deepEqual(before.tokens, []); assert.deepEqual(before.families, []);
  for (const state of f.store.attempts) {
    const text = JSON.stringify(state);
    assert.equal(text.includes(result.token), false); assert.equal(text.includes(result.refreshToken), false);
    // familyId is deliberately public, but is never a stand-alone proof.
    assert.equal(text.includes(result.familyId), true);
  }
});

test('normal rotation replaces both credentials and every old family access without extending absolute expiry', async () => {
  const f = fixture(), first = await f.issue(), other = await f.issue(OTHER_DEVICE);
  const otherFamily = f.store.state.families.find(item => item.familyId === other.familyId);
  const oldToken = f.token(first);
  // Multiple old access grants still revoke as a family, not just by one hash.
  f.store.state = freeze({ ...f.store.state, tokens: [...f.store.state.tokens, tokenRecord({ familyId: first.familyId, hash: digest(opaque(91)) })] });
  const before = f.store.state;
  f.advance(10 * DAY);
  const next = await f.refresh(first);
  assert.notEqual(next.token, first.token); assert.notEqual(next.refreshToken, first.refreshToken);
  assert.equal(next.familyId, first.familyId); assert.equal(next.absoluteExpiresAt, first.absoluteExpiresAt);
  assert.equal(next.expiresAt, START + 11 * DAY); assert.equal(next.refreshExpiresAt, START + 40 * DAY);
  assert.deepEqual(f.store.state.tokens, [{ hash: digest(next.token), expiresAt: next.expiresAt, deviceId: DEVICE, familyId: next.familyId }]);
  assert.equal(f.store.state.families.length, 2);
  assert.deepEqual(f.store.state.families.find(item => item.familyId === other.familyId), otherFamily);
  assert.equal(f.store.state.families.find(item => item.familyId === first.familyId).createdAt, START);
  assert.equal(before.tokens.length, 3);
  await assert.rejects(f.helper.logout({ token: oldToken }), unauthorized);
  const after = f.store.state;
  await assert.rejects(f.refresh(first), unauthorized);
  await assert.rejects(f.helper.revokeFamily(f.proof(first)), unauthorized);
  assert.equal(f.store.state, after, 'reuse must not revoke the legitimate current grant');
  for (const saved of f.store.attempts) for (const value of [first.token, first.refreshToken, next.token, next.refreshToken, other.token, other.refreshToken]) {
    assert.equal(JSON.stringify(saved).includes(value), false);
  }
});

test('rotation preserves other live legacy and v2 grants, including another family on the same device', async () => {
  const legacy = tokenRecord({ hash: digest(opaque(80)) });
  const f = fixture({}, { ...initial(), tokens: [legacy] });
  const first = await f.issue(), sameDevice = await f.issue(), otherDevice = await f.issue(OTHER_DEVICE);
  const before = f.store.state, retained = [legacy, f.token(sameDevice), f.token(otherDevice)];
  f.advance(1000);
  const next = await f.refresh(first);
  assert.equal(f.store.state.tokens.length, 4); assert.equal(f.store.state.families.length, 3);
  assert.equal(f.store.state.tokens.some(item => item.hash === digest(first.token)), false);
  assert.equal(f.token(next).deviceId, DEVICE);
  for (const record of retained) assert.deepEqual(f.store.state.tokens.find(item => item.hash === record.hash), record);
  for (const record of before.families.filter(item => item.familyId !== first.familyId)) {
    assert.deepEqual(f.store.state.families.find(item => item.familyId === record.familyId), record);
  }
  // The matching device alone is not permission to revoke its other login family.
  await f.logout(next);
  assert.deepEqual(f.store.state.tokens, retained);
  await f.refresh(sameDevice);
});

test('wrong device, family, refresh proof, and bearer-as-refresh all reject uniformly without mutation', async () => {
  const f = fixture(), result = await f.issue(), second = await f.issue(OTHER_DEVICE), before = f.store.state;
  const proof = f.proof(result);
  const wrong = [
    { ...proof, deviceId: OTHER_DEVICE }, { ...proof, deviceId: 'invalid/device' },
    { ...proof, familyId: second.familyId }, { ...proof, familyId: opaque(53) },
    { ...proof, refreshToken: opaque(54) }, { ...proof, refreshToken: result.token },
    { ...proof, refreshToken: '' }, { ...proof, refreshToken: 'x'.repeat(44) },
    { ...proof, refreshToken: null }, { ...proof, refreshToken: 42 },
    { ...proof, familyId: '' }, { ...proof, familyId: 'x'.repeat(43) },
  ];
  for (const input of wrong) {
    await assert.rejects(f.helper.refresh(input), unauthorized);
    await assert.rejects(f.helper.revokeFamily(input), unauthorized);
  }
  assert.equal(f.store.state, before); assert.equal(f.store.commits, 2);
  assert.ok(await f.refresh(result));
});

test('idle expiration is inclusive and successful refresh extends only the idle window', async () => {
  const f = fixture({ tokenTtlMs: 5, refreshIdleMs: 10, refreshAbsoluteMs: 30 });
  const first = await f.issue();
  f.advance(9);
  const second = await f.refresh(first);
  assert.equal(second.expiresAt, START + 14); assert.equal(second.refreshExpiresAt, START + 19);
  assert.equal(second.absoluteExpiresAt, START + 30);
  f.setTime(second.refreshExpiresAt);
  const before = f.store.state;
  await assert.rejects(f.refresh(second), unauthorized);
  await assert.rejects(f.helper.revokeFamily(f.proof(second)), unauthorized);
  assert.equal(f.store.state, before);
  const fresh = await f.issue();
  assert.equal(f.store.state.families.length, 1); assert.equal(f.store.state.tokens.length, 1);
  assert.notEqual(fresh.familyId, first.familyId);
});

test('repeated renewals never extend the absolute bound, including the exact expiry boundary', async () => {
  const f = fixture({ tokenTtlMs: 365 * DAY, refreshIdleMs: 10, refreshAbsoluteMs: 30 });
  let result = await f.issue();
  assert.equal(result.expiresAt, result.refreshExpiresAt, 'large access TTL is capped by family expiry');
  for (const offset of [9, 18, 27, 29]) {
    f.setTime(START + offset);
    result = await f.refresh(result);
    assert.equal(result.absoluteExpiresAt, START + 30);
    assert.equal(result.refreshExpiresAt, Math.min(START + offset + 10, START + 30));
    assert.equal(result.expiresAt, result.refreshExpiresAt);
  }
  const token = f.token(result), before = f.store.state;
  f.setTime(START + 30);
  await assert.rejects(f.refresh(result), unauthorized);
  await assert.rejects(f.helper.logout({ token }), unauthorized);
  await assert.rejects(f.helper.revokeFamily(f.proof(result)), unauthorized);
  assert.equal(f.store.state, before);
});

test('the production defaults enforce a 90-day absolute lifetime despite renewal every 29 days', async () => {
  const f = fixture();
  let result = await f.issue();
  for (const day of [29, 58, 87, 89]) {
    f.setTime(START + day * DAY);
    result = await f.refresh(result);
    assert.equal(result.absoluteExpiresAt, START + 90 * DAY);
    assert.equal(result.refreshExpiresAt, START + Math.min(day + 30, 90) * DAY);
  }
  f.setTime(START + 90 * DAY);
  await assert.rejects(f.refresh(result), unauthorized);
});

test('concurrent reuse has exactly one winner and failed reuse does not damage that winner', async () => {
  const f = fixture(), first = await f.issue();
  const results = await Promise.allSettled([f.refresh(first), f.refresh(first), f.refresh(first)]);
  const succeeded = results.filter(result => result.status === 'fulfilled');
  assert.equal(succeeded.length, 1);
  for (const failed of results.filter(result => result.status === 'rejected')) {
    assert.equal(failed.reason.status, 401); assert.equal(failed.reason.message, 'Unauthorized');
  }
  assert.equal(f.store.state.tokens.length, 1); assert.equal(f.store.state.families.length, 1);
  const winner = succeeded[0].value;
  assert.equal(f.token(winner).hash, digest(winner.token));
  await f.refresh(winner);
});

test('password changes invalidate all families, tokens and previously verified login snapshots', async () => {
  const f = fixture(), oldAuth = f.store.state.auth, first = await f.issue(), token = f.token(first);
  await f.changePassword();
  const before = f.store.state;
  await assert.rejects(f.issue(DEVICE, oldAuth), unauthorized);
  await assert.rejects(f.refresh(first), unauthorized);
  await assert.rejects(f.helper.logout({ token }), unauthorized);
  await assert.rejects(f.helper.revokeFamily(f.proof(first)), unauthorized);
  assert.equal(f.store.state, before);
  const next = await f.issue();
  assert.equal(f.store.state.families[0].passwordRevision, 1);
  assert.notEqual(next.familyId, first.familyId);
});

test('issue validates every immutable password snapshot component, not just its revision', async () => {
  const f = fixture(), snapshot = f.store.state.auth;
  for (const authSnapshot of [
    { ...snapshot, hash: 'f'.repeat(128) }, { ...snapshot, salt: 'f'.repeat(64) },
    { ...snapshot, passwordRevision: 1 }, { ...snapshot, passwordRevision: null },
    { ...snapshot, hash: 'malformed-secret-hash' }, null, [], {},
  ]) await assert.rejects(f.issue(DEVICE, authSnapshot), unauthorized);
  assert.equal(f.store.commits, 0);
});

test('old login, refresh, and already authenticated logout queued behind password commit cannot resurrect grants', async t => {
  const f = fixture(), first = await f.issue(), token = f.token(first), oldAuth = { ...f.store.state.auth };
  const gate = pauseNextSave(f); t.after(gate.release);
  const passwordChange = f.changePassword();
  await gate.entered;
  const denied = [
    assert.rejects(f.issue(DEVICE, oldAuth), unauthorized),
    assert.rejects(f.refresh(first), unauthorized),
    assert.rejects(f.helper.logout({ token }), unauthorized),
    assert.rejects(f.helper.revokeFamily(f.proof(first)), unauthorized),
  ];
  // Even a mutated caller-owned snapshot cannot alter the already queued proof.
  oldAuth.hash = 'c'.repeat(128); oldAuth.salt = 'd'.repeat(64); oldAuth.passwordRevision = 1;
  gate.release();
  await passwordChange; await Promise.all(denied);
  assert.deepEqual(f.store.state.tokens, []); assert.deepEqual(f.store.state.families, []);
  assert.equal(f.store.commits, 2);
});

test('password change queued behind refresh revokes the freshly rotated grant at its commit', async t => {
  const f = fixture(), first = await f.issue(), before = f.store.state;
  const gate = pauseNextSave(f); t.after(gate.release);
  const refreshing = f.refresh(first);
  const candidate = await gate.entered;
  assert.equal(f.store.state, before);
  assert.equal(candidate.families[0].familyId, first.familyId);
  assert.notEqual(candidate.families[0].refreshHash, before.families[0].refreshHash);
  const passwordChange = f.changePassword();
  gate.release();
  const result = await refreshing; await passwordChange;
  assert.deepEqual(f.store.state.tokens, []); assert.deepEqual(f.store.state.families, []);
  await assert.rejects(f.refresh(result), unauthorized);
});

test('issue and refresh publish no in-memory state until the single save completes', async t => {
  const f = fixture(), empty = f.store.state;
  let gate = pauseNextSave(f); t.after(() => gate.release());
  const issuing = f.issue();
  await gate.entered;
  assert.equal(f.store.state, empty); assert.deepEqual(empty.tokens, []); assert.deepEqual(empty.families, []);
  gate.release();
  const first = await issuing, before = f.store.state;
  gate = pauseNextSave(f);
  const refreshing = f.refresh(first);
  await gate.entered;
  assert.equal(f.store.state, before);
  assert.equal(before.families[0].refreshHash, digest(first.refreshToken));
  assert.equal(before.tokens[0].hash, digest(first.token));
  gate.release();
  const next = await refreshing;
  assert.equal(f.store.state.families[0].refreshHash, digest(next.refreshToken));
  assert.equal(f.store.commits, 2);
});

test('all save failures leave immutable state intact and sanitize storage error secrets', async () => {
  for (const operation of ['issue', 'refresh', 'logout', 'revokeFamily']) {
    const f = fixture(), first = await f.issue(), before = f.store.state;
    f.store.beforeSave = async () => { throw new Error(`secret failure ${first.token} ${first.refreshToken} synthetic-path`); };
    const action = operation === 'issue' ? f.issue() : operation === 'refresh' ? f.refresh(first)
      : operation === 'logout' ? f.logout(first) : f.helper.revokeFamily(f.proof(first));
    await assert.rejects(action, error => {
      assert.equal(error.status, 500); assert.equal(error.message, 'Device authentication storage error');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      for (const value of [first.token, first.refreshToken, 'synthetic-path']) assert.equal(String(error.stack).includes(value), false);
      return true;
    });
    assert.equal(f.store.state, before); assert.equal(f.store.commits, 1);
    assert.equal(before.tokens[0].hash, digest(first.token));
    assert.equal(before.families[0].refreshHash, digest(first.refreshToken));
    for (const attempt of f.store.attempts) for (const secret of [first.token, first.refreshToken]) assert.equal(JSON.stringify(attempt).includes(secret), false);
    f.store.beforeSave = undefined;
    assert.ok(await f.refresh(first), `${operation} failure must not consume refresh proof`);
  }
});

test('logout requires the identical current authenticated token and revokes its complete family only', async () => {
  const f = fixture(), first = await f.issue(), second = await f.issue(OTHER_DEVICE);
  const token = f.token(first), before = f.store.state;
  const invalid = [
    { token: { ...token, deviceId: OTHER_DEVICE } }, { token: { ...token, familyId: second.familyId } },
    { token: { ...token, expiresAt: token.expiresAt + 1 } }, { token: { ...token, hash: digest(opaque(57)) } },
    { token: { hash: token.hash, expiresAt: token.expiresAt, deviceId: token.deviceId } },
    { token: { ...token, refreshToken: first.refreshToken } }, { familyId: first.familyId },
    { token: first.token }, { token: null }, { token: { familyId: first.familyId } },
    { token, familyId: second.familyId },
  ];
  for (const input of invalid) await assert.rejects(f.helper.logout(input), unauthorized);
  assert.equal(f.store.state, before);
  f.store.state = freeze({ ...before, tokens: [...before.tokens, tokenRecord({ hash: digest(opaque(58)), familyId: first.familyId })] });
  assert.equal(await f.helper.logout({ token }), undefined);
  assert.deepEqual(f.store.state.families.map(item => item.familyId), [second.familyId]);
  assert.deepEqual(f.store.state.tokens.map(item => item.familyId), [second.familyId]);
  await assert.rejects(f.refresh(first), unauthorized);
  await assert.rejects(f.helper.logout({ token }), unauthorized);
  await f.refresh(second, OTHER_DEVICE);
});

test('logout with the rotated current access token revokes its current refresh credential', async () => {
  const f = fixture(), first = await f.issue(), oldToken = f.token(first), next = await f.refresh(first);
  const before = f.store.state;
  await assert.rejects(f.helper.logout({ token: oldToken }), unauthorized);
  assert.equal(f.store.state, before);
  await f.logout(next);
  assert.deepEqual(f.store.state.tokens, []); assert.deepEqual(f.store.state.families, []);
  await assert.rejects(f.refresh(next), unauthorized);
});

test('logout/refresh races obey lock order without authorizing by family id alone', async t => {
  {
    const f = fixture(), first = await f.issue(), oldToken = f.token(first);
    const gate = pauseNextSave(f); t.after(gate.release);
    const refreshing = f.refresh(first); await gate.entered;
    const denied = assert.rejects(f.helper.logout({ token: oldToken }), unauthorized);
    gate.release(); const next = await refreshing; await denied;
    assert.equal(f.token(next).hash, digest(next.token));
    await f.logout(next);
  }
  {
    const f = fixture(), first = await f.issue();
    const gate = pauseNextSave(f); t.after(gate.release);
    const logout = f.logout(first); await gate.entered;
    const denied = assert.rejects(f.refresh(first), unauthorized);
    gate.release(); await logout; await denied;
    assert.deepEqual(f.store.state.tokens, []); assert.deepEqual(f.store.state.families, []);
  }
});

test('refresh proof permits offline logout after access expiry, but only for its current device-bound family', async () => {
  const f = fixture({ tokenTtlMs: 1, refreshIdleMs: 10, refreshAbsoluteMs: 30 });
  const first = await f.issue(), token = f.token(first);
  f.advance(1);
  await assert.rejects(f.helper.logout({ token }), unauthorized);
  await assert.rejects(f.helper.revokeFamily(f.proof(first, OTHER_DEVICE)), unauthorized);
  assert.equal(await f.helper.revokeFamily(f.proof(first)), undefined);
  assert.deepEqual(f.store.state.tokens, []); assert.deepEqual(f.store.state.families, []);
  await assert.rejects(f.helper.revokeFamily(f.proof(first)), unauthorized);
  await assert.rejects(f.refresh(first), unauthorized);
});

test('legacy tokens and missing legacy families coexist, expire, and revoke independently', async () => {
  const legacy = tokenRecord(), expired = tokenRecord({ hash: digest(opaque(70)), expiresAt: START });
  const input = { ...initial(), version: 1, tokens: [legacy, expired] };
  delete input.families; delete input.auth.passwordRevision;
  const f = fixture({}, input);
  assert.equal(Object.hasOwn(f.store.state, 'families'), false, 'validation must not mutate legacy state');
  const result = await f.issue();
  assert.deepEqual(f.store.state.tokens[0], legacy);
  assert.equal(f.store.state.tokens.length, 2); assert.equal(f.store.state.families[0].passwordRevision, 0);
  assert.equal(f.store.state.version, 1, 'parent alone owns version migration');
  await f.helper.logout({ token: legacy });
  assert.equal(f.store.state.tokens.length, 1); assert.equal(f.store.state.families.length, 1);
  const renewed = await f.refresh(result);
  await f.logout(renewed);
  assert.deepEqual(f.store.state.tokens, []); assert.deepEqual(f.store.state.families, []);
});

test('live access and idle refresh families each enforce maxTokens without evicting valid sessions', async () => {
  const f = fixture({ maxTokens: 1, tokenTtlMs: 1, refreshIdleMs: 10, refreshAbsoluteMs: 30 });
  let result = await f.issue(), before = f.store.state;
  await assert.rejects(f.issue(OTHER_DEVICE), { status: 429, message: 'Session limit reached' });
  assert.equal(f.store.state, before);
  result = await f.refresh(result);
  f.advance(1); before = f.store.state;
  await assert.rejects(f.issue(OTHER_DEVICE), { status: 429 });
  assert.equal(f.store.state, before, 'expired access does not release a live refresh-family slot');
  result = await f.refresh(result);
  f.setTime(result.refreshExpiresAt);
  await f.issue(OTHER_DEVICE);
  assert.equal(f.store.state.tokens.length, 1); assert.equal(f.store.state.families.length, 1);
  assert.equal(f.store.state.families[0].deviceId, OTHER_DEVICE);
  const legacyOnly = fixture({ maxTokens: 1 }, { ...initial(), tokens: [tokenRecord()] });
  await assert.rejects(legacyOnly.issue(), { status: 429 });
  await legacyOnly.helper.logout({ token: legacyOnly.store.state.tokens[0] });
  await legacyOnly.issue();
});

test('refresh checks legacy access capacity before replacing a family grant', async () => {
  const input = stateWithFamily();
  input.tokens[0].expiresAt = START;
  // A historical access token must still end after its family's creation time.
  input.families[0].createdAt = START - 1;
  input.families[0].absoluteExpiresAt = START + 89 * DAY;
  input.tokens.push(tokenRecord({ hash: digest(opaque(71)), deviceId: OTHER_DEVICE }));
  const f = fixture({ maxTokens: 1 }, input), before = f.store.state;
  await assert.rejects(f.helper.refresh({ familyId: opaque(1), refreshToken: opaque(2), deviceId: DEVICE }), { status: 429 });
  assert.equal(f.store.state, before);
  await f.helper.logout({ token: input.tokens[1] });
  const next = await f.helper.refresh({ familyId: opaque(1), refreshToken: opaque(2), deviceId: DEVICE });
  assert.equal(f.store.state.tokens.length, 1); assert.equal(f.token(next).hash, digest(next.token));
});

test('validator returns independent normalized records and preserves expired records until a successful commit', () => {
  const input = freeze(stateWithFamily()), result = validateDeviceAuthState(input);
  assert.deepEqual(result, { tokens: input.tokens, families: input.families });
  assert.notEqual(result.tokens, input.tokens); assert.notEqual(result.families, input.families);
  assert.notEqual(result.tokens[0], input.tokens[0]); assert.notEqual(result.families[0], input.families[0]);
  result.tokens[0].deviceId = OTHER_DEVICE; result.families[0].refreshHash = 'f'.repeat(64);
  assert.equal(input.tokens[0].deviceId, DEVICE); assert.equal(input.families[0].refreshHash, digest(opaque(2)));
  const legacy = initial(); delete legacy.families;
  assert.deepEqual(validateDeviceAuthState(legacy), { tokens: [], families: [] });
  assert.equal(Object.hasOwn(legacy, 'families'), false);
});

test('corrupt family records, revisions, duplicates and unknown secret fields fail closed', () => {
  const cases = [
    state => { state.families = null; }, state => { state.families = {}; }, state => { state.families = undefined; },
    state => { state.families[0] = null; }, state => { state.families[0] = []; },
    state => { state.families[0].familyId = 'not-random'; }, state => { state.families[0].familyId = 'x'.repeat(43); },
    state => { state.families[0].deviceId = 'invalid/device'; }, state => { state.families[0].refreshHash = 'z'.repeat(64); },
    state => { state.families[0].refreshHash = state.tokens[0].hash; },
    state => { state.families[0].passwordRevision = 1; }, state => { state.families[0].passwordRevision = '0'; },
    state => { state.auth.passwordRevision = null; }, state => { state.auth.passwordRevision = -1; },
    state => { state.auth.passwordRevision = Number.MAX_SAFE_INTEGER + 1; }, state => { state.auth.hash = 'bad'; },
    state => { state.families[0].createdAt = -1; }, state => { state.families[0].createdAt = START + 0.5; },
    state => { state.families[0].createdAt = state.families[0].refreshExpiresAt; },
    state => { state.families[0].refreshExpiresAt = Infinity; }, state => { state.families[0].refreshExpiresAt = '123'; },
    state => { state.families[0].refreshExpiresAt = state.families[0].absoluteExpiresAt + 1; },
    state => { state.families[0].absoluteExpiresAt += 1; }, state => { state.families[0].absoluteExpiresAt = Number.MAX_SAFE_INTEGER; },
    state => { delete state.families[0].createdAt; }, state => { delete state.families[0].passwordRevision; },
    state => { state.families[0].refreshToken = 'synthetic-secret-not-allowed'; },
    state => { state.families.push({ ...state.families[0] }); },
    state => { state.families.push({ ...state.families[0], familyId: opaque(5) }); },
    state => { Object.setPrototypeOf(state.families[0], { unexpected: true }); },
  ];
  for (const mutate of cases) {
    const state = stateWithFamily(); mutate(state);
    assert.throws(() => validateDeviceAuthState(state), corrupt);
    // Do not structuredClone here: cloning would discard the corrupt prototype.
    assert.throws(() => createDeviceAuth({ store: { state, save() {}, exclusive() {} } }), corrupt);
  }
});

test('corrupt access records fail closed, including expired corruption rather than silently pruning it', () => {
  const cases = [
    state => { state.tokens = null; }, state => { state.tokens = {}; }, state => { state.tokens[0] = null; },
    state => { state.tokens[0].hash = 'bad'; }, state => { state.tokens[0].hash = 'A'.repeat(64); },
    state => { state.tokens[0].deviceId = 'invalid/device'; }, state => { state.tokens[0].deviceId = OTHER_DEVICE; },
    state => { state.tokens[0].expiresAt = 0; }, state => { state.tokens[0].expiresAt = 1.5; },
    state => { state.tokens[0].expiresAt = Number.MAX_SAFE_INTEGER; }, state => { state.tokens[0].expiresAt = '100'; },
    state => { state.tokens[0].expiresAt = state.families[0].refreshExpiresAt + 1; },
    state => { state.tokens[0].expiresAt = state.families[0].createdAt; },
    state => { state.tokens[0].familyId = opaque(7); }, state => { state.tokens[0].familyId = null; },
    state => { state.tokens[0].familyId = undefined; }, state => { state.families = []; },
    state => { state.tokens[0].token = 'synthetic-secret-not-allowed'; }, state => { state.tokens.push({ ...state.tokens[0] }); },
    state => { delete state.tokens[0].deviceId; }, state => { Object.setPrototypeOf(state.tokens[0], { unexpected: true }); },
  ];
  for (const mutate of cases) {
    const state = stateWithFamily(); mutate(state);
    assert.throws(() => validateDeviceAuthState(state), corrupt);
  }
  assert.throws(() => validateDeviceAuthState(null), corrupt);
  assert.throws(() => validateDeviceAuthState([]), corrupt);
});

test('every operation revalidates current state inside the lock rather than trusting constructor validation', async () => {
  const f = fixture(), first = await f.issue(), token = f.token(first);
  f.store.state = { ...f.store.state, families: [{ ...f.store.state.families[0], refreshHash: 'corrupt-secret-value' }] };
  const before = f.store.state;
  for (const action of [() => f.issue(), () => f.refresh(first), () => f.helper.logout({ token }), () => f.helper.revokeFamily(f.proof(first))]) {
    await assert.rejects(action(), corrupt); assert.equal(f.store.state, before);
  }
  assert.equal(f.store.commits, 1);
});

test('request parsing is exact, bounded, and never reflects supplied secrets', async () => {
  const f = fixture(), secret = 'synthetic-sensitive-value';
  for (const input of [null, [], {}, { deviceId: DEVICE }, { deviceId: DEVICE, authSnapshot: auth(), password: secret },
    { deviceId: 'a'.repeat(101), authSnapshot: auth() }, { deviceId: '__proto__', authSnapshot: auth() }]) {
    await assert.rejects(f.helper.issue(input), { status: 400, message: 'Invalid device authentication request' });
  }
  for (const input of [null, [], {}, { familyId: opaque(1), refreshToken: secret },
    { familyId: opaque(1), refreshToken: opaque(2), deviceId: DEVICE, password: secret }]) {
    for (const method of ['refresh', 'revokeFamily']) await assert.rejects(f.helper[method](input), { status: 400, message: 'Invalid device authentication request' });
  }
  assert.equal(f.store.commits, 0);
});

test('configuration bounds, clocks and arithmetic are strictly validated before persisting', async () => {
  const f = fixture();
  for (const name of ['tokenTtlMs', 'refreshIdleMs', 'refreshAbsoluteMs', 'maxTokens']) {
    for (const value of [null, false, true, '1', 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createDeviceAuth({ store: f.store, [name]: value }), { name: 'TypeError', message: `Invalid ${name}` });
    }
  }
  for (const options of [{ tokenTtlMs: 365 * DAY + 1 }, { refreshIdleMs: 30 * DAY + 1 }, { refreshAbsoluteMs: 90 * DAY + 1 },
    { maxTokens: 100_001 }, { refreshIdleMs: 11, refreshAbsoluteMs: 10 }]) assert.throws(() => createDeviceAuth({ store: f.store, ...options }), TypeError);
  for (const options of [null, [], {}, { store: {} }, { store: f.store, now: 0 }]) assert.throws(() => createDeviceAuth(options), TypeError);
  for (const time of [-1, NaN, Infinity, '1', 1.5, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_000]) {
    const helper = createDeviceAuth({ store: f.store, now: () => time });
    await assert.rejects(helper.issue({ deviceId: DEVICE, authSnapshot: auth() }), { status: 500 });
  }
  assert.equal(f.store.commits, 0);
  const atEpoch = fixture({ now: () => 0, tokenTtlMs: 1, refreshIdleMs: 1, refreshAbsoluteMs: 1 });
  assert.equal((await atEpoch.issue()).expiresAt, 1);
});

test('clock rollback before family creation cannot authorize refresh or logout', async () => {
  const f = fixture(), first = await f.issue(), token = f.token(first), before = f.store.state;
  f.setTime(START - 1);
  await assert.rejects(f.refresh(first), unauthorized);
  await assert.rejects(f.helper.revokeFamily(f.proof(first)), unauthorized);
  await assert.rejects(f.helper.logout({ token }), unauthorized);
  assert.equal(f.store.state, before);
});

test('record count hard limits fail before iterating attacker-sized arrays', () => {
  const state = initial();
  state.tokens = new Array(100_001);
  assert.throws(() => validateDeviceAuthState(state), corrupt);
  state.tokens = []; state.families = new Array(100_001);
  assert.throws(() => validateDeviceAuthState(state), corrupt);
});
