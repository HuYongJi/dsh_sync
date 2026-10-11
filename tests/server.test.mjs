import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { startFromEnvironment } from '../server/main.mjs';
import { sha256, MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES, MAX_FILES } from '../src/protocol.mjs';

const TEMP_ROOT = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const USERNAME = 'sync-test-owner';
const PASSWORD = 'test-only-strong-password-42!';
const DEVICE = 'test-device';

async function ownedDirectory(t, beforeCleanup = async () => {}) {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const directory = await fs.mkdtemp(path.join(TEMP_ROOT, 'server-'));
  t.after(async () => {
    await beforeCleanup();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(TEMP_ROOT));
    assert.match(path.basename(resolved), /^server-[A-Za-z0-9]+$/);
    // This exact directory was returned by this test's mkdtemp, never from user input.
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}
async function fixture(t, options = {}) {
  const servers = new Set();
  const dataDir = await ownedDirectory(t, async () => { for (const server of servers) await closeSyncServer(server); });
  let current, base;
  async function start(extra = {}) {
    current = await createSyncServer({ dataDir, username: USERNAME, password: PASSWORD, ...options, ...extra });
    servers.add(current);
    await new Promise((resolve, reject) => { current.once('error', reject); current.listen(0, resolve); });
    assert.equal(current.address().address, '127.0.0.1');
    base = `http://127.0.0.1:${current.address().port}`;
    return current;
  }
  async function api(route, { method = 'GET', token, json, body, headers = {} } = {}) {
    if (token !== undefined) headers = { ...headers, Authorization: `Bearer ${token}` };
    if (json !== undefined) { headers = { ...headers, 'Content-Type': 'application/json' }; body = JSON.stringify(json); }
    const response = await fetch(`${base}${route}`, { method, headers, body });
    const bytes = Buffer.from(await response.arrayBuffer());
    const value = response.headers.get('content-type')?.startsWith('application/json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined;
    return { status: response.status, body: value, bytes, headers: response.headers };
  }
  async function login(extra = {}) {
    const result = await api('/v1/login', { method: 'POST', json: { username: USERNAME, password: PASSWORD, deviceId: DEVICE, ...extra } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  await start();
  return { dataDir, api, login, start, get server() { return current; }, get base() { return base; } };
}
function manifest(id, extra = {}) {
  return {
    version: 1, id, projectId: 'test-project', deviceId: DEVICE, parentId: null,
    createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: 'E:\\test-only-project', sessionIds: [], files: [], ...extra,
  };
}
function fileEntry(bytes, filename = 'project/example.txt') { return { path: filename, sha256: sha256(bytes), size: bytes.length }; }
async function commit(f, token, value) { return f.api('/v1/checkpoints', { method: 'POST', token, json: value }); }
async function upload(f, token, bytes) { return f.api(`/v1/blobs/${sha256(bytes)}`, { method: 'PUT', token, body: bytes }); }

function chunkedPut(base, token, hash, chunks, declaredLength) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${token}`, ...(declaredLength === undefined ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': declaredLength }) };
    const request = http.request(`${base}/v1/blobs/${hash}`, { method: 'PUT', headers }, response => {
      const parts = [];
      response.on('data', chunk => parts.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('health is non-sensitive; all private routes require auth; credentials/tokens are only hashed on disk', async t => {
  const f = await fixture(t);
  const health = await f.api('/health');
  assert.equal(health.status, 200); assert.deepEqual(health.body, { ok: true });
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  assert.equal(health.headers.get('x-dsh-sync-password-change'), '1');
  for (const route of ['/v1/checkpoints?projectId=test-project', '/v1/checkpoints/unknown', `/v1/blobs/${'a'.repeat(64)}`, '/unknown']) {
    const result = await f.api(route);
    assert.equal(result.status, 401); assert.deepEqual(result.body, { error: 'Unauthorized' });
    assert.ok(!result.bytes.toString().includes(f.dataDir));
  }
  assert.equal((await f.api('/v1/logout', { method: 'POST' })).status, 401);
  assert.equal((await f.api('/v1/login', { method: 'POST', json: { username: USERNAME, password: 'wrong', deviceId: DEVICE } })).status, 401);
  assert.equal((await f.api('/v1/login', { method: 'POST', json: { username: 'wrong-user', password: PASSWORD, deviceId: DEVICE } })).status, 401);
  assert.equal((await f.api('/v1/login', { method: 'POST', json: { username: USERNAME, password: PASSWORD, deviceId: '../escape' } })).status, 400);
  const { token, expiresAt } = await f.login();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt) > Date.now() + 23 * 60 * 60 * 1000);
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token })).status, 200);
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token: token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') })).status, 401);
  const storedText = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  assert.ok(!storedText.includes(PASSWORD)); assert.ok(!storedText.includes(token));
  const stored = JSON.parse(storedText);
  assert.equal(stored.auth.algorithm, 'scrypt'); assert.equal(stored.auth.N, 32768);
  assert.match(stored.auth.hash, /^[a-f0-9]{128}$/);
  assert.equal(stored.tokens[0].hash, sha256(Buffer.from(token)));
  assert.equal(stored.tokens[0].deviceId, DEVICE);
  assert.deepEqual((await f.api('/v1/checkpoints/missing', { token })).body, { error: 'Not found' });
});

test('logout revokes a token durably while other tokens and checkpoints survive a clean restart', async t => {
  const f = await fixture(t);
  const first = await f.login(); const second = await f.login({ deviceId: 'second-device' });
  assert.equal((await commit(f, first.token, manifest('persisted'))).status, 201);
  assert.equal((await f.api('/v1/logout', { method: 'POST', token: first.token })).status, 204);
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token: first.token })).status, 401);
  await new Promise((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
  await f.start({ username: undefined, password: undefined });
  assert.equal((await f.api('/v1/checkpoints/persisted', { token: second.token })).status, 200);
  assert.equal((await f.api('/v1/checkpoints/persisted', { token: first.token })).status, 401);
  assert.equal((await f.api('/v1/logout', { method: 'POST', token: second.token })).status, 204);
  assert.equal((await f.api('/v1/logout', { method: 'POST', token: second.token })).status, 401);
});

test('bootstrap requires strong credentials, refuses reset, and keeps an exclusive storage lock', async t => {
  const servers = new Set();
  const dataDir = await ownedDirectory(t, async () => { for (const server of servers) await closeSyncServer(server); });
  await assert.rejects(createSyncServer({ dataDir, username: USERNAME, password: 'weak' }), /at least 8/);
  await assert.rejects(createSyncServer({ dataDir, password: PASSWORD }), /username/);
  const first = await createSyncServer({ dataDir, username: USERNAME, password: PASSWORD });
  servers.add(first);
  await assert.rejects(createSyncServer({ dataDir }), /locked/);
  assert.throws(() => first.listen(0, '0.0.0.0'), /public HTTP/);
  assert.throws(() => first.listen({ port: 0, host: '::' }), /public HTTP/);
  await closeSyncServer(first);
  await assert.rejects(createSyncServer({ dataDir, username: 'new-account' }), /does not match/);
  await assert.rejects(createSyncServer({ dataDir, password: 'new-strong-password-that-cannot-reset' }), /does not match/);
  const second = await createSyncServer({ dataDir });
  servers.add(second);
  await closeSyncServer(second);
  assert.equal((await fs.readdir(dataDir)).includes('.lock'), false);
});

test('bootstrap rejects 7 Unicode codepoints, accepts exactly 8, and retains the UTF-8 byte ceiling', async t => {
  const dataDir = await ownedDirectory(t);
  const sevenEmoji = '🔐'.repeat(7);
  assert.equal(sevenEmoji.length, 14);
  assert.equal([...sevenEmoji].length, 7);
  for (const password of ['a'.repeat(7), '界'.repeat(7), sevenEmoji]) {
    await assert.rejects(createSyncServer({ dataDir, username: USERNAME, password }), /at least 8/);
  }
  for (const password of ['a'.repeat(1025), '界'.repeat(342), '🔐'.repeat(257)]) {
    await assert.rejects(createSyncServer({ dataDir, username: USERNAME, password }), /1024/);
  }
  await assert.rejects(fs.stat(path.join(dataDir, 'state.json')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(dataDir)).includes('.lock'), false);
  for (const password of ['a'.repeat(8), '界'.repeat(8), '🔐'.repeat(8), '🔐'.repeat(256)]) {
    const f = await fixture(t, { password });
    const auth = await f.login({ password });
    assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token: auth.token })).status, 200);
  }
});

test('token TTL is enforced after expiration and restart', async t => {
  const f = await fixture(t, { tokenTtlMs: 150 });
  const { token } = await f.login();
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token })).status, 200);
  await delay(180);
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token })).status, 401);
  await closeSyncServer(f.server); await f.start({ username: undefined, password: undefined });
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token })).status, 401);
});

test('blobs enforce checksum, immutability, declared/chunked byte limits, and missing-object privacy', async t => {
  const f = await fixture(t, { maxBlobBytes: 32 });
  const { token } = await f.login();
  const data = Buffer.from([0, 1, 2, 255, 128, 12]);
  const hash = sha256(data);
  assert.equal((await f.api(`/v1/blobs/${hash}`, { method: 'PUT', body: data })).status, 401);
  assert.equal((await f.api(`/v1/blobs/${hash}`, { method: 'PUT', token, body: Buffer.from('wrong') })).status, 400);
  assert.equal((await f.api(`/v1/blobs/${hash}`, { token })).status, 404);
  assert.equal((await upload(f, token, data)).status, 201);
  assert.equal((await upload(f, token, data)).status, 204);
  const downloaded = await f.api(`/v1/blobs/${hash}`, { token });
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, data);
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await upload(f, token, Buffer.alloc(0))).status, 201);
  assert.equal((await upload(f, token, Buffer.alloc(33))).status, 413);
  const chunked = await chunkedPut(f.base, token, sha256(Buffer.alloc(40)), [Buffer.alloc(20), Buffer.alloc(20)]);
  assert.equal(chunked.status, 413);
  assert.equal((await f.api(`/v1/blobs/${hash.toUpperCase()}`, { token })).status, 400);
  const missing = await f.api(`/v1/blobs/${'a'.repeat(64)}`, { token });
  assert.equal(missing.status, 404); assert.deepEqual(missing.body, { error: 'Not found' });
  assert.ok(!missing.bytes.toString().includes(f.dataDir));
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'tmp')), []);
});

test('checkpoints commit only complete matching blobs, and bind to the authenticated device', async t => {
  const f = await fixture(t); const { token } = await f.login();
  const data = Buffer.from('atomic checkpoint blob');
  const value = manifest('complete', { files: [fileEntry(data)] });
  assert.equal((await commit(f, token, value)).status, 409);
  assert.deepEqual((await f.api('/v1/checkpoints?projectId=test-project', { token })).body, { checkpoints: [], heads: [] });
  assert.equal((await upload(f, token, data)).status, 201);
  assert.equal((await commit(f, token, { ...value, files: [{ ...value.files[0], size: data.length + 1 }] })).status, 409);
  assert.equal((await commit(f, token, { ...value, deviceId: 'other-device' })).status, 403);
  const accepted = await commit(f, token, value);
  assert.equal(accepted.status, 201); assert.deepEqual(accepted.body, { id: 'complete', conflict: false, heads: ['complete'] });
  assert.deepEqual((await f.api('/v1/checkpoints/complete', { token })).body, value);
  assert.deepEqual((await f.api('/v1/checkpoints?projectId=test-project', { token })).body.checkpoints[0], {
    id: 'complete', projectId: 'test-project', deviceId: DEVICE, parentId: null,
    createdAt: value.createdAt, fileCount: 1, totalBytes: data.length,
  });
});

test('concurrent immutable commits cannot overwrite ids or lose index updates', async t => {
  const f = await fixture(t, { maxConnections: 64 }); const { token } = await f.login();
  assert.equal((await commit(f, token, manifest('root'))).status, 201);
  const branches = await Promise.all(Array.from({ length: 16 }, (_, i) => commit(f, token, manifest(`branch-${i}`, {
    parentId: 'root', createdAt: new Date(Date.UTC(2020, 0, 17 - i)).toISOString(),
  }))));
  assert.ok(branches.every(result => result.status === 201));
  assert.equal(branches.filter(result => result.body.conflict === false).length, 1);
  assert.equal(branches.filter(result => result.body.conflict === true).length, 15);
  const listing = (await f.api('/v1/checkpoints?projectId=test-project', { token })).body;
  assert.equal(listing.checkpoints.length, 17); assert.equal(listing.checkpoints[0].id, 'root');
  assert.equal(listing.heads.length, 16); assert.ok(!listing.heads.includes('root'));
  const contenders = [manifest('immutable', { sourceRoot: '/first' }), manifest('immutable', { sourceRoot: '/second' })];
  const raced = await Promise.all(contenders.map(value => commit(f, token, value)));
  assert.deepEqual(raced.map(result => result.status).sort(), [201, 409]);
  const winner = contenders[raced.findIndex(result => result.status === 201)];
  assert.deepEqual((await f.api('/v1/checkpoints/immutable', { token })).body, winner);
  const repeats = await Promise.all(Array.from({ length: 8 }, () => commit(f, token, winner)));
  assert.ok(repeats.every(result => result.status === 201));
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token })).body.checkpoints.length, 18);
  await closeSyncServer(f.server); await f.start({ username: undefined, password: undefined });
  assert.equal((await f.api('/v1/checkpoints?projectId=test-project', { token })).body.checkpoints.length, 18);
  assert.deepEqual((await f.api('/v1/checkpoints/immutable', { token })).body, winner);
});

test('heads preserve stale-parent branches and reject missing or cross-project parents', async t => {
  const f = await fixture(t); const { token } = await f.login();
  assert.deepEqual((await commit(f, token, manifest('r'))).body, { id: 'r', conflict: false, heads: ['r'] });
  assert.deepEqual((await commit(f, token, manifest('a', { parentId: 'r' }))).body, { id: 'a', conflict: false, heads: ['a'] });
  assert.deepEqual((await commit(f, token, manifest('b', { parentId: 'r' }))).body, { id: 'b', conflict: true, heads: ['a', 'b'] });
  assert.deepEqual((await commit(f, token, manifest('c', { parentId: 'a' }))).body, { id: 'c', conflict: false, heads: ['b', 'c'] });
  assert.equal((await commit(f, token, manifest('missing-parent', { parentId: 'unknown' }))).status, 409);
  assert.equal((await commit(f, token, manifest('other-project', { projectId: 'other', parentId: 'r' }))).status, 409);
  assert.deepEqual((await commit(f, token, manifest('second-root'))).body, { id: 'second-root', conflict: true, heads: ['b', 'c', 'second-root'] });
  const listing = (await f.api('/v1/checkpoints?projectId=test-project', { token })).body;
  assert.deepEqual(listing.checkpoints.map(entry => entry.id), ['r', 'a', 'b', 'c', 'second-root']);
  assert.deepEqual((await f.api('/v1/checkpoints?projectId=other', { token })).body, { checkpoints: [], heads: [] });
});

test('portable path validation, whitelist normalization, and case-distinct Windows-safe checkpoint storage', async t => {
  const f = await fixture(t); const { token } = await f.login();
  const data = Buffer.from('safe'); const hash = sha256(data);
  assert.equal((await upload(f, token, data)).status, 201);
  const unsafePaths = [
    'project/../escape', '/absolute', 'project/a\\b', 'project/C:/escape', 'project/CON.txt',
    'project/trailing.', 'project/.git/config', 'project/.dsh-sync/state', 'sessions/unlisted.json', `assets/${'a'.repeat(64)}`,
  ];
  for (const [index, unsafe] of unsafePaths.entries()) {
    assert.equal((await commit(f, token, manifest(`unsafe-${index}`, { files: [fileEntry(data, unsafe)] }))).status, 400, unsafe);
  }
  assert.equal((await commit(f, token, manifest('relative-root', { sourceRoot: 'relative' }))).status, 400);
  assert.equal((await commit(f, token, manifest('collision', { files: [fileEntry(data, 'project/A'), fileEntry(data, 'project/a')] }))).status, 400);
  assert.equal((await commit(f, token, manifest('prefix', { files: [fileEntry(data, 'project/a'), fileEntry(data, 'project/a/b')] }))).status, 400);
  assert.equal((await commit(f, token, manifest('../escape'))).status, 400);
  const normalized = manifest('normalized', { files: [{ ...fileEntry(data), executable: false, discarded: 'not stored' }], discarded: 'not stored' });
  assert.equal((await commit(f, token, normalized)).status, 201);
  const returned = (await f.api('/v1/checkpoints/normalized', { token })).body;
  assert.equal(Object.hasOwn(returned, 'discarded'), false); assert.equal(Object.hasOwn(returned.files[0], 'discarded'), false);
  assert.equal(Object.hasOwn(returned.files[0], 'executable'), false);
  for (const id of ['Case', 'case', 'CON', 'AUX']) assert.equal((await commit(f, token, manifest(id))).status, 201);
  for (const id of ['Case', 'case', 'CON', 'AUX']) assert.equal((await f.api(`/v1/checkpoints/${id}`, { token })).body.id, id);
  const reordered = { ...manifest('sorted', { sessionIds: ['session-b', 'session-a'], files: [
    fileEntry(data, 'sessions/session-b.json'), fileEntry(data, 'project/z'), fileEntry(data, 'sessions/session-a.json'),
  ] }) };
  assert.equal((await commit(f, token, reordered)).status, 201);
  assert.equal((await commit(f, token, { ...reordered, sessionIds: [...reordered.sessionIds].reverse(), files: [...reordered.files].reverse() })).status, 201);
  assert.equal(hash.length, 64);
});

test('manifest body, individual blob size, file count, and total checkpoint size are bounded', async t => {
  const f = await fixture(t); const { token } = await f.login();
  const hash = 'a'.repeat(64);
  assert.equal((await chunkedPut(f.base, token, hash, [], MAX_BLOB_BYTES + 1)).status, 413);
  assert.equal((await commit(f, token, manifest('large-file', { files: [{ path: 'project/a', sha256: hash, size: MAX_BLOB_BYTES + 1 }] }))).status, 400);
  const overTotal = Array.from({ length: Math.floor(MAX_CHECKPOINT_BYTES / MAX_BLOB_BYTES) + 1 }, (_, i) => ({ path: `project/${i}`, sha256: hash, size: MAX_BLOB_BYTES }));
  assert.equal((await commit(f, token, manifest('large-total', { files: overTotal }))).status, 400);
  const tooMany = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `project/${i}`, sha256: hash, size: 0 }));
  assert.equal((await commit(f, token, manifest('large-count', { files: tooMany }))).status, 400);
  const limited = await fixture(t, { maxManifestBytes: 1024 }); const auth = await limited.login();
  assert.equal((await commit(limited, auth.token, manifest('large-body', { sourceRoot: '/' + 'x'.repeat(2000) }))).status, 413);
  assert.equal((await limited.api('/v1/login', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await limited.api('/v1/login', { method: 'POST', body: 'x'.repeat(8193), headers: { 'Content-Type': 'application/json' } })).status, 413);
});

test('login rate limits and bounded concurrent scrypt work reject excess attempts', async t => {
  const limited = await fixture(t, { loginMaxAttempts: 2, loginWindowMs: 60_000, loginMaxEntries: 1 });
  for (let i = 0; i < 2; i += 1) assert.equal((await limited.api('/v1/login', { method: 'POST', json: { username: USERNAME, password: 'incorrect', deviceId: DEVICE } })).status, 401);
  const rejected = await limited.api('/v1/login', { method: 'POST', json: { username: USERNAME, password: PASSWORD, deviceId: DEVICE } });
  assert.equal(rejected.status, 429); assert.ok(rejected.headers.has('retry-after'));
  const concurrent = await fixture(t, { maxLoginConcurrency: 1 });
  const results = await Promise.all(Array.from({ length: 6 }, () => concurrent.api('/v1/login', { method: 'POST', json: { username: USERNAME, password: PASSWORD, deviceId: DEVICE } })));
  assert.ok(results.some(result => result.status === 200)); assert.ok(results.some(result => result.status === 429));
  assert.ok(results.every(result => [200, 429].includes(result.status)));
});

test('hanging request bodies are terminated and clean shutdown releases the lock', async t => {
  const f = await fixture(t, { requestTimeoutMs: 150, headersTimeoutMs: 100 });
  const closed = new Promise((resolve, reject) => {
    const socket = net.connect(f.server.address().port, '127.0.0.1');
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Hanging request was not terminated')); }, 2000);
    socket.on('connect', () => socket.write('POST /v1/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timeout); resolve(); });
  });
  await closed;
  await f.server.closeSync();
  await f.start({ username: undefined, password: undefined });
  assert.equal((await f.api('/health')).status, 200);
});

test('environment entrypoint uses a password file, refuses public HTTP, and never resets existing storage', async t => {
  const servers = new Set();
  const root = await ownedDirectory(t, async () => { for (const server of servers) await closeSyncServer(server); });
  const dataDir = path.join(root, 'data');
  const passwordFile = path.join(root, 'test-password.txt');
  await fs.writeFile(passwordFile, PASSWORD + '\n');
  await assert.rejects(startFromEnvironment({}), /SYNC_DATA_DIR/);
  await assert.rejects(startFromEnvironment({ SYNC_DATA_DIR: dataDir, SYNC_PASSWORD_FILE: passwordFile, SYNC_PASSWORD: PASSWORD }), /only/);
  const env = { SYNC_DATA_DIR: dataDir, SYNC_USERNAME: USERNAME, SYNC_PASSWORD_FILE: passwordFile, SYNC_PORT: '0' };
  const server = await startFromEnvironment(env);
  servers.add(server);
  assert.equal(server.address().address, '127.0.0.1');
  await closeSyncServer(server);
  await assert.rejects(startFromEnvironment({ ...env, SYNC_HOST: '0.0.0.0' }), /public HTTP/);
  await assert.rejects(startFromEnvironment({ SYNC_DATA_DIR: dataDir, SYNC_USERNAME: USERNAME, SYNC_PASSWORD: 'different-strong-password', SYNC_PORT: '0' }), /does not match/);
  const restarted = await startFromEnvironment({ SYNC_DATA_DIR: dataDir, SYNC_PORT: '0', SYNC_HOST: 'localhost' });
  servers.add(restarted);
  assert.equal(restarted.address().address, '127.0.0.1');
  await closeSyncServer(restarted);
});

test('storage rejects directory symlinks and Windows junction redirects before following them', async t => {
  const links = [];
  const root = await ownedDirectory(t, async () => {
    for (const link of links.reverse()) {
      assert.ok(path.resolve(link).startsWith(path.resolve(root) + path.sep));
      // Remove our known junction entries themselves before generic recursive cleanup.
      // On affected Windows runtimes lstat/rm do not reliably identify junctions.
      if (process.platform === 'win32') await fs.rmdir(link); else await fs.unlink(link);
    }
  });
  const target = path.join(root, 'target');
  const redirect = path.join(root, 'redirect');
  await fs.mkdir(target);
  await fs.symlink(target, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(redirect);
  await assert.rejects(createSyncServer({ dataDir: redirect, username: USERNAME, password: PASSWORD }), /real directories|redirect/);
  await assert.rejects(createSyncServer({ dataDir: path.join(redirect, 'new-store'), username: USERNAME, password: PASSWORD }), /real directories|redirect/);
  assert.deepEqual(await fs.readdir(target), []);
  const nestedData = path.join(root, 'nested-store');
  await fs.mkdir(nestedData);
  await fs.symlink(target, path.join(nestedData, 'blobs'), process.platform === 'win32' ? 'junction' : 'dir');
  links.push(path.join(nestedData, 'blobs'));
  await assert.rejects(createSyncServer({ dataDir: nestedData, username: USERNAME, password: PASSWORD }), /real directories|redirect/);
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal((await fs.readdir(nestedData)).includes('.lock'), false);
});
