import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { createHook } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { startFromEnvironment } from '../server/main.mjs';
import { sha256 } from '../src/protocol.mjs';

const TEMP_ROOT = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const USERNAME = 'password-test-owner';
const PASSWORD = 'synthetic-old-password-42!';
const NEW_PASSWORD = 'synthetic-new-password-43!';
const OTHER_PASSWORD = 'synthetic-other-password-44!';
const DEVICE = 'password-test-device';
const PASSWORD_BODY_LIMIT = 16 * 1024;

async function ownedDirectory(t, beforeCleanup = async () => {}) {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const directory = await fs.mkdtemp(path.join(TEMP_ROOT, 'password-server-'));
  t.after(async () => {
    await beforeCleanup();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(TEMP_ROOT));
    assert.match(path.basename(resolved), /^password-server-[A-Za-z0-9]+$/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}
async function api(base, route, { method = 'GET', token, json, body, headers = {} } = {}) {
  if (token !== undefined) headers = { ...headers, Authorization: `Bearer ${token}` };
  if (json !== undefined) { headers = { ...headers, 'Content-Type': 'application/json' }; body = JSON.stringify(json); }
  const response = await fetch(`${base}${route}`, { method, headers, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: bytes.length && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : undefined, bytes, headers: response.headers };
}
function baseFor(server) {
  assert.equal(server.address().address, '127.0.0.1');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const servers = new Set(), cleanup = new Set();
  const dataDir = await ownedDirectory(t, async () => {
    for (const callback of cleanup) callback();
    for (const server of servers) await closeSyncServer(server);
  });
  let current, base;
  async function start(extra = {}) {
    current = await createSyncServer({ dataDir, username: USERNAME, password: PASSWORD, loginMaxAttempts: 1000, ...options, ...extra });
    servers.add(current);
    await new Promise((resolve, reject) => { current.once('error', reject); current.listen(0, resolve); });
    base = baseFor(current);
    return current;
  }
  const f = {
    dataDir, cleanup, start,
    api: (route, request) => api(base, route, request),
    login: (password = PASSWORD, extra = {}) => api(base, '/v1/login', { method: 'POST', json: { username: USERNAME, password, deviceId: DEVICE, ...extra } }),
    change: (extra = {}, request = {}) => api(base, '/v1/password', { method: 'POST', json: { username: USERNAME, currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...extra }, ...request }),
    state: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')),
    get server() { return current; }, get base() { return base; },
  };
  await start();
  return f;
}
function manifest(id, extra = {}) {
  return { version: 1, id, projectId: 'password-project', deviceId: DEVICE, parentId: null, createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: 'E:\\synthetic-password-project', sessionIds: [], files: [], ...extra };
}
function requestBody(base, route, { chunks = [], declaredLength, expectContinue = false, headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${route}`, { method, headers: {
      'Content-Type': 'application/json',
      ...(declaredLength === undefined ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': declaredLength }),
      ...(expectContinue ? { Expect: '100-continue' } : {}), ...headers,
    } }, response => {
      const parts = [];
      response.on('data', chunk => parts.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined }));
      response.on('error', reject);
    });
    request.on('error', reject);
    const send = () => { for (const chunk of chunks) request.write(chunk); request.end(); };
    if (expectContinue) { request.once('continue', send); request.flushHeaders(); } else send();
  });
}
// Observe native async KDF boundaries rather than relying on sleep durations for
// races. These hooks neither replace crypto nor expose production-only test APIs.
function observeKdfs(t, expected) {
  const starts = Array.from({ length: expected }, () => Promise.withResolvers());
  const finishes = Array.from({ length: expected }, () => Promise.withResolvers());
  const pending = new Map();
  let count = 0;
  const hook = createHook({
    init(id, type) {
      if (type !== 'SCRYPTREQUEST') return;
      const index = count++;
      pending.set(id, index);
      starts[index]?.resolve();
    },
    after(id) {
      if (!pending.has(id)) return;
      const index = pending.get(id); pending.delete(id);
      finishes[index]?.resolve();
    },
  });
  hook.enable();
  t.after(() => hook.disable());
  return { started: index => starts[index].promise, finished: index => finishes[index].promise, stop: () => hook.disable(), get count() { return count; } };
}
function pauseNextStateRename(t, f) {
  const original = fs.rename;
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const statePath = path.join(f.dataDir, 'state.json');
  let armed = true;
  const mock = t.mock.method(fs, 'rename', async function (source, target) {
    if (armed && path.resolve(target) === statePath) {
      armed = false;
      entered.resolve(JSON.parse(await fs.readFile(source, 'utf8')));
      await released.promise;
    }
    return original.call(this, source, target);
  });
  f.cleanup.add(() => released.resolve());
  return { entered: entered.promise, release: () => released.resolve(), restore: () => mock.mock.restore() };
}
function requestReached(server, route) {
  const reached = Promise.withResolvers();
  const listener = req => {
    if (req.url !== route) return;
    server.off('request', listener);
    reached.resolve(req);
  };
  server.on('request', listener);
  return reached.promise;
}
function partialRequest(base, route, token, body, method) {
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': body.length } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.write(body.subarray(0, 1));
  });
  return { finish: () => request.end(body.subarray(1)), destroy: () => request.destroy(), result };
}

test('password change authenticates only the current password, never a bearer token', async t => {
  const f = await fixture(t);
  const auth = await f.login(); assert.equal(auth.status, 200);
  const before = await f.state();
  const requests = [
    [{ currentPassword: 'wrong-current-secret' }, {}],
    [{ username: 'wrong-user' }, {}],
    [{ currentPassword: 'wrong-current-secret' }, { token: auth.body.token }],
  ];
  for (const [fields, request] of requests) {
    const response = await f.change(fields, request);
    assert.equal(response.status, 401); assert.deepEqual(response.body, { error: 'Unauthorized' });
    assert.ok(!response.bytes.toString().includes('wrong-current-secret'));
  }
  const tokenOnly = await f.api('/v1/password', { method: 'POST', token: auth.body.token, json: { username: USERNAME, newPassword: NEW_PASSWORD } });
  assert.equal(tokenOnly.status, 400); assert.deepEqual(tokenOnly.body, { error: 'Invalid password change request' });
  assert.deepEqual(await f.state(), before);
  // Even a malformed Bearer header is irrelevant when all current credentials match.
  const changed = await f.change({}, { headers: { Authorization: 'not-a-bearer-token' } });
  assert.equal(changed.status, 200); assert.deepEqual(changed.body, { changed: true });
});

test('rotation atomically replaces salted credentials and all tokens without changing blobs or checkpoints', async t => {
  const f = await fixture(t);
  const first = await f.login(), second = await f.login(PASSWORD, { deviceId: 'second-device' });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const blob = Buffer.from('synthetic checkpoint content must survive password rotation');
  const hash = sha256(blob);
  assert.equal((await f.api(`/v1/blobs/${hash}`, { method: 'PUT', token: first.body.token, body: blob })).status, 201);
  const checkpoint = manifest('preserved', { files: [{ path: 'project/example.txt', sha256: hash, size: blob.length }] });
  assert.equal((await f.api('/v1/checkpoints', { method: 'POST', token: first.body.token, json: checkpoint })).status, 201);
  const before = await f.state();
  const storedManifestPath = path.join(f.dataDir, 'checkpoints', `${sha256(Buffer.from(checkpoint.id))}.json`);
  const storedManifest = await fs.readFile(storedManifestPath);
  const response = await f.change();
  assert.equal(response.status, 200); assert.deepEqual(response.body, { changed: true });
  const after = await f.state();
  assert.equal(after.auth.passwordRevision, 1);
  assert.notEqual(after.auth.salt, before.auth.salt); assert.notEqual(after.auth.hash, before.auth.hash);
  assert.match(after.auth.salt, /^[a-f0-9]{64}$/); assert.match(after.auth.hash, /^[a-f0-9]{128}$/);
  assert.deepEqual(after.tokens, []); assert.deepEqual(after.checkpoints, before.checkpoints);
  assert.equal(after.version, before.version);
  for (const field of ['username', 'algorithm', 'N', 'r', 'p']) assert.equal(after.auth[field], before.auth[field]);
  assert.deepEqual(await fs.readFile(storedManifestPath), storedManifest);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'blobs', hash)), blob);
  for (const secret of [PASSWORD, NEW_PASSWORD, first.body.token, second.body.token]) assert.ok(!JSON.stringify(after).includes(secret));
  for (const token of [first.body.token, second.body.token]) {
    assert.equal((await f.api('/v1/checkpoints?projectId=password-project', { token })).status, 401);
    assert.equal((await f.api('/v1/logout', { method: 'POST', token })).status, 401);
  }
  assert.equal((await f.login()).status, 401);
  const current = await f.login(NEW_PASSWORD); assert.equal(current.status, 200);
  assert.deepEqual((await f.api('/v1/checkpoints/preserved', { token: current.body.token })).body, checkpoint);
  assert.deepEqual((await f.api(`/v1/blobs/${hash}`, { token: current.body.token })).bytes, blob);
  // A revoked old bearer may accompany a second valid password-only rotation.
  assert.equal((await f.change({ currentPassword: NEW_PASSWORD, newPassword: OTHER_PASSWORD }, { token: first.body.token })).status, 200);
  assert.equal((await f.state()).auth.passwordRevision, 2);
  assert.equal((await f.api('/v1/checkpoints/preserved', { token: current.body.token })).status, 401);
  assert.equal((await f.login(OTHER_PASSWORD)).status, 200);
});

test('an expired token does not prevent current-password authentication', async t => {
  const f = await fixture(t, { tokenTtlMs: 10 });
  const auth = await f.login(); assert.equal(auth.status, 200);
  await delay(20);
  assert.equal((await f.api('/v1/checkpoints?projectId=password-project', { token: auth.body.token })).status, 401);
  assert.equal((await f.change({}, { token: auth.body.token })).status, 200);
});

test('strict password fields enforce an 8-codepoint minimum, byte limits, and non-identity', async t => {
  const f = await fixture(t);
  const sevenEmoji = '🔐'.repeat(7);
  assert.equal(sevenEmoji.length, 14);
  assert.equal([...sevenEmoji].length, 7);
  const valid = { username: USERNAME, currentPassword: PASSWORD, newPassword: NEW_PASSWORD };
  const invalid = [
    null, [], 'password', {}, { ...valid, unknown: true }, { ...valid, password: PASSWORD }, { ...valid, deviceId: DEVICE },
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { username: USERNAME, newPassword: NEW_PASSWORD },
    { username: USERNAME, currentPassword: PASSWORD }, { ...valid, username: 42 }, { ...valid, username: 'bad\nuser' },
    { ...valid, username: 'x'.repeat(129) }, { ...valid, currentPassword: 42 }, { ...valid, currentPassword: 'x'.repeat(1025) },
    { ...valid, newPassword: null }, { ...valid, newPassword: 42 }, { ...valid, newPassword: '' },
    { ...valid, newPassword: 'x'.repeat(7) }, { ...valid, newPassword: '界'.repeat(7) }, { ...valid, newPassword: sevenEmoji },
    { ...valid, newPassword: 'x'.repeat(1025) }, { ...valid, newPassword: '🔐'.repeat(257) }, { ...valid, newPassword: PASSWORD },
    JSON.parse('{"username":"password-test-owner","currentPassword":"synthetic-old-password-42!","newPassword":"synthetic-new-password-43!","__proto__":{}}'),
  ];
  const before = await f.state();
  for (const json of invalid) {
    const response = await f.api('/v1/password', { method: 'POST', json });
    assert.equal(response.status, 400); assert.deepEqual(response.body, { error: 'Invalid password change request' });
    for (const secret of [PASSWORD, NEW_PASSWORD]) assert.ok(!response.bytes.toString().includes(secret));
  }
  assert.deepEqual(await f.state(), before);
  let currentPassword = PASSWORD;
  for (const newPassword of ['a'.repeat(8), '界'.repeat(8), '🔐'.repeat(8)]) {
    assert.equal([...newPassword].length, 8);
    assert.equal((await f.change({ currentPassword, newPassword })).status, 200);
    assert.equal((await f.login(newPassword)).status, 200);
    currentPassword = newPassword;
  }
  const maximum = '🔐'.repeat(256);
  assert.equal(Buffer.byteLength(maximum), 1024);
  assert.equal((await f.change({ currentPassword, newPassword: maximum })).status, 200);
  // Escaped control codepoints have substantial JSON expansion but valid byte lengths.
  const escaped = '\u0000'.repeat(1024), nextEscaped = '\u0001'.repeat(1024);
  assert.equal((await f.change({ currentPassword: maximum, newPassword: escaped })).status, 200);
  assert.equal((await f.change({ currentPassword: escaped, newPassword: nextEscaped })).status, 200);
  assert.equal((await f.login(nextEscaped)).status, 200);
});

test('UTF-8-equivalent password strings cannot rotate to the same password', async t => {
  const currentPassword = 'synthetic-password-\ud800', newPassword = 'synthetic-password-\ufffd';
  assert.notEqual(currentPassword, newPassword);
  assert.ok(Buffer.from(currentPassword).equals(Buffer.from(newPassword)));
  const f = await fixture(t, { password: currentPassword });
  const before = await f.state();
  const response = await f.change({ currentPassword, newPassword });
  assert.equal(response.status, 400); assert.deepEqual(response.body, { error: 'Invalid password change request' });
  assert.deepEqual(await f.state(), before);
  assert.equal((await f.login(newPassword)).status, 200);
});

test('password request bodies are bounded for declared, chunked, and Expect/continue transfers', async t => {
  const f = await fixture(t);
  const before = await f.state();
  const malformed = await f.api('/v1/password', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
  assert.equal(malformed.status, 400); assert.deepEqual(malformed.body, { error: 'Invalid JSON body' });
  assert.equal((await f.api('/v1/password', { method: 'POST', body: Buffer.from([0xff]), headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.change({}, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await f.api('/v1/password', { method: 'POST', body: 'not-json', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await requestBody(f.base, '/v1/password', { declaredLength: PASSWORD_BODY_LIMIT + 1 })).status, 413);
  assert.equal((await requestBody(f.base, '/v1/password', { chunks: [Buffer.alloc(8192, 'a'), Buffer.alloc(8193, 'b')] })).status, 413);
  assert.equal((await requestBody(f.base, '/v1/password', { declaredLength: PASSWORD_BODY_LIMIT + 1, expectContinue: true })).status, 413);
  assert.deepEqual(await f.state(), before);
  const body = Buffer.from(JSON.stringify({ username: USERNAME, currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
  const accepted = await requestBody(f.base, '/v1/password', { chunks: [body], declaredLength: body.length, expectContinue: true });
  assert.equal(accepted.status, 200); assert.deepEqual(accepted.body, { changed: true });
});

test('rotated stores survive stale bootstrap passwords, stale files, and deleted files without rewriting them', async t => {
  const servers = new Set();
  const root = await ownedDirectory(t, async () => { for (const server of servers) await closeSyncServer(server); });
  const dataDir = path.join(root, 'data'), passwordFile = path.join(root, 'synthetic-bootstrap.txt');
  await fs.writeFile(passwordFile, PASSWORD + '\r\n');
  const env = { SYNC_DATA_DIR: dataDir, SYNC_USERNAME: USERNAME, SYNC_PASSWORD_FILE: passwordFile, SYNC_PORT: '0' };
  const first = await startFromEnvironment(env); servers.add(first);
  assert.equal((await api(baseFor(first), '/v1/password', { method: 'POST', json: { username: USERNAME, currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status, 200);
  assert.equal(await fs.readFile(passwordFile, 'utf8'), PASSWORD + '\r\n');
  await closeSyncServer(first);
  for (const restartEnv of [
    { SYNC_DATA_DIR: dataDir, SYNC_USERNAME: USERNAME, SYNC_PASSWORD: PASSWORD, SYNC_PORT: '0' },
    env,
  ]) {
    const server = await startFromEnvironment(restartEnv); servers.add(server);
    for (const [password, expected] of [[PASSWORD, 401], [NEW_PASSWORD, 200]]) {
      assert.equal((await api(baseFor(server), '/v1/login', { method: 'POST', json: { username: USERNAME, password, deviceId: DEVICE } })).status, expected);
    }
    await closeSyncServer(server);
  }
  // Only delete the exact synthetic file created by this test.
  assert.equal(path.dirname(path.resolve(passwordFile)), path.resolve(root));
  assert.equal(path.basename(passwordFile), 'synthetic-bootstrap.txt');
  await fs.unlink(passwordFile);
  const restarted = await startFromEnvironment(env); servers.add(restarted);
  assert.equal((await api(baseFor(restarted), '/v1/login', { method: 'POST', json: { username: USERNAME, password: NEW_PASSWORD, deviceId: DEVICE } })).status, 200);
  assert.equal((await api(baseFor(restarted), '/v1/login', { method: 'POST', json: { username: USERNAME, password: PASSWORD, deviceId: DEVICE } })).status, 401);
  await assert.rejects(fs.stat(passwordFile), { code: 'ENOENT' });
  await closeSyncServer(restarted);
  const direct = await createSyncServer({ dataDir, username: USERNAME, password: PASSWORD }); servers.add(direct);
  await closeSyncServer(direct);
  const lazy = await createSyncServer({ dataDir, loadBootstrapPassword: async () => { assert.fail('Rotated stores must not resolve bootstrap secrets'); } });
  servers.add(lazy);
  await closeSyncServer(lazy);
});

test('legacy auth without a revision stays readable and continues to reject bootstrap resets', async t => {
  const f = await fixture(t);
  const auth = await f.login(); assert.equal(auth.status, 200);
  await closeSyncServer(f.server);
  const state = await f.state(); delete state.auth.passwordRevision;
  const statePath = path.join(f.dataDir, 'state.json');
  await fs.writeFile(statePath, JSON.stringify(state));
  await assert.rejects(createSyncServer({ dataDir: f.dataDir, password: NEW_PASSWORD }), /does not match/);
  await assert.rejects(startFromEnvironment({ SYNC_DATA_DIR: f.dataDir, SYNC_PASSWORD: NEW_PASSWORD, SYNC_PORT: '0' }), /does not match/);
  await f.start();
  assert.equal((await f.api('/v1/checkpoints?projectId=password-project', { token: auth.body.token })).status, 200);
  assert.equal((await f.change()).status, 200);
  assert.equal((await f.state()).auth.passwordRevision, 1);
  await closeSyncServer(f.server);
  await f.start(); // Old supplied bootstrap password is now ignored.
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
});

test('password revisions are strictly validated before bypassing bootstrap checks', async t => {
  const f = await fixture(t);
  await closeSyncServer(f.server);
  const state = await f.state(), statePath = path.join(f.dataDir, 'state.json');
  for (const passwordRevision of [null, false, true, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    await fs.writeFile(statePath, JSON.stringify({ ...state, auth: { ...state.auth, passwordRevision } }));
    let reads = 0;
    await assert.rejects(createSyncServer({ dataDir: f.dataDir, loadBootstrapPassword: async () => { reads += 1; return PASSWORD; } }), /Invalid credential record/);
    assert.equal(reads, 0);
    assert.equal((await fs.readdir(f.dataDir)).includes('.lock'), false);
  }
  await fs.writeFile(statePath, JSON.stringify(state));
  await assert.rejects(createSyncServer({ dataDir: f.dataDir, password: NEW_PASSWORD }), /does not match/);
});

test('simultaneous changes based on the same password have exactly one winner', async t => {
  const f = await fixture(t, { maxLoginConcurrency: 2 });
  const results = await Promise.all([f.change(), f.change({ newPassword: OTHER_PASSWORD })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  const winner = results[0].status === 200 ? NEW_PASSWORD : OTHER_PASSWORD;
  const loser = results[0].status === 200 ? OTHER_PASSWORD : NEW_PASSWORD;
  const state = await f.state();
  assert.equal(state.auth.passwordRevision, 1); assert.deepEqual(state.tokens, []);
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.login(loser)).status, 401);
  assert.equal((await f.login(winner)).status, 200);
});

test('login verified against an old snapshot cannot issue a token behind the rotation commit', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const gate = pauseNextStateRename(t, f);
  const changed = f.change();
  try {
    const next = await gate.entered;
    assert.equal(next.auth.passwordRevision, 1); assert.deepEqual(next.tokens, []);
    assert.equal((await f.state()).auth.passwordRevision, 0);
    const observed = observeKdfs(t, 1);
    const login = f.login();
    await observed.finished(0); await nextTurn(); observed.stop();
    // Rotation owns the exclusive commit; this old-password login has finished
    // its KDF and is now queued behind it, not merely arriving after the change.
    gate.release();
    assert.equal((await changed).status, 200);
    const denied = await login;
    assert.equal(denied.status, 401); assert.deepEqual(denied.body, { error: 'Unauthorized' });
    assert.deepEqual((await f.state()).tokens, []);
    assert.equal((await f.login(NEW_PASSWORD)).status, 200);
  } finally { gate.release(); gate.restore(); await changed; }
});

test('already authenticated queued logout and streamed writes cannot commit after rotation', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const auth = await f.login(); assert.equal(auth.status, 200);
  const checkpoint = Buffer.from(JSON.stringify(manifest('late-checkpoint')));
  const blob = Buffer.from('synthetic late blob upload');
  const blobRoute = `/v1/blobs/${sha256(blob)}`;
  const checkpointReached = requestReached(f.server, '/v1/checkpoints'), blobReached = requestReached(f.server, blobRoute);
  const checkpointWrite = partialRequest(f.base, '/v1/checkpoints', auth.body.token, checkpoint, 'POST');
  const blobWrite = partialRequest(f.base, blobRoute, auth.body.token, blob, 'PUT');
  f.cleanup.add(() => checkpointWrite.destroy()); f.cleanup.add(() => blobWrite.destroy());
  await Promise.all([checkpointReached, blobReached]);
  const gate = pauseNextStateRename(t, f);
  const changed = f.change();
  try {
    await gate.entered;
    const logoutReached = requestReached(f.server, '/v1/logout');
    const logout = f.api('/v1/logout', { method: 'POST', token: auth.body.token });
    await logoutReached; // dispatch has already enqueued logout's exclusive write.
    gate.release();
    assert.equal((await changed).status, 200);
    assert.equal((await logout).status, 401);
    checkpointWrite.finish(); blobWrite.finish();
    for (const response of await Promise.all([checkpointWrite.result, blobWrite.result])) {
      assert.equal(response.status, 401); assert.deepEqual(response.body, { error: 'Unauthorized' });
    }
    assert.deepEqual((await f.state()).checkpoints, []);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'checkpoints')), []);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'blobs')), []);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'tmp')), []);
  } finally { gate.release(); gate.restore(); checkpointWrite.destroy(); blobWrite.destroy(); await changed; }
});

test('login and password change share rate budgets and both KDF phases share one concurrency slot', { timeout: 15_000 }, async t => {
  const limited = await fixture(t, { loginMaxAttempts: 2, loginWindowMs: 60_000 });
  assert.equal((await limited.change({ currentPassword: 'incorrect' })).status, 401);
  assert.equal((await limited.login('incorrect')).status, 401);
  const rejected = await limited.change();
  assert.equal(rejected.status, 429); assert.ok(rejected.headers.has('retry-after'));
  assert.equal((await limited.login()).status, 429);
  assert.equal((await limited.state()).auth.passwordRevision, 0);
  const f = await fixture(t, { maxLoginConcurrency: 1 });
  const observed = observeKdfs(t, 2);
  const changed = f.change();
  await observed.started(0);
  assert.equal((await f.login()).status, 429);
  await observed.started(1);
  assert.equal((await f.login()).status, 429);
  assert.equal((await f.change({ newPassword: OTHER_PASSWORD })).status, 429);
  assert.equal((await changed).status, 200);
  assert.equal(observed.count, 2); observed.stop();
  const loginObserved = observeKdfs(t, 1);
  const login = f.login(NEW_PASSWORD);
  await loginObserved.started(0);
  assert.equal((await f.change({ currentPassword: NEW_PASSWORD, newPassword: OTHER_PASSWORD })).status, 429);
  assert.equal((await login).status, 200); loginObserved.stop();
});

test('a failed rotation state rename leaves both credentials and tokens unchanged and hides raw errors', async t => {
  const f = await fixture(t);
  const auth = await f.login(); assert.equal(auth.status, 200);
  assert.equal((await f.api('/v1/checkpoints', { method: 'POST', token: auth.body.token, json: manifest('atomic-preserved') })).status, 201);
  const before = await f.state(), statePath = path.join(f.dataDir, 'state.json');
  const original = fs.rename;
  const commits = [];
  const mock = t.mock.method(fs, 'rename', async function (source, target) {
    if (path.resolve(target) === statePath) {
      commits.push(JSON.parse(await fs.readFile(source, 'utf8')));
      throw Object.assign(new Error(`Synthetic failure containing ${NEW_PASSWORD} and ${f.dataDir}`), { code: 'EIO' });
    }
    return original.call(this, source, target);
  });
  const failed = await f.change();
  assert.equal(failed.status, 500); assert.deepEqual(failed.body, { error: 'Internal server error' });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].auth.passwordRevision, 1); assert.deepEqual(commits[0].tokens, []);
  assert.deepEqual(commits[0].checkpoints, before.checkpoints);
  assert.deepEqual(await f.state(), before);
  assert.equal((await f.api('/v1/checkpoints/atomic-preserved', { token: auth.body.token })).status, 200);
  assert.equal((await f.login(NEW_PASSWORD)).status, 401);
  assert.ok(!(await fs.readdir(f.dataDir)).some(name => name.startsWith('.write-')));
  mock.mock.restore();
  assert.equal((await f.login()).status, 200);
  assert.equal((await f.change()).status, 200);
  assert.deepEqual((await f.state()).tokens, []);
  await closeSyncServer(f.server); await f.start();
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
});
