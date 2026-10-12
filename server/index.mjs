import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import { promises as fs, constants } from 'node:fs';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import {
  sha256, validateManifest, validateId, validateBlobHash,
  MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES, MAX_FILES, MAX_MANIFEST_BYTES,
} from '../src/protocol.mjs';

import { readStableFile } from '../src/files.mjs';
import { projectFolderMetadata } from '../src/client.mjs';
import { createSyncStore } from './sync-store.mjs';
import { createSyncHttp } from './sync-http.mjs';
import { createDeviceAuth, validateDeviceAuthState } from './device-auth.mjs';

const scrypt = promisify(scryptCallback);
async function committedManifest(store, entry) {
  try {
    const filename = path.join(store.checkpointDir, `${sha256(Buffer.from(entry.id))}.json`);
    const { bytes } = await readStableFile(filename, MAX_MANIFEST_BYTES);
    if (sha256(bytes) !== entry.manifestSha256) throw new Error('Checkpoint integrity error');
    const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (manifest.id !== entry.id || manifest.projectId !== entry.projectId || manifest.deviceId !== entry.deviceId || manifest.parentId !== entry.parentId || manifest.createdAt !== entry.createdAt || manifest.files.length !== entry.fileCount || manifest.files.reduce((sum, file) => sum + file.size, 0) !== entry.totalBytes) throw new Error('Checkpoint index mismatch');
    return manifest;
  } catch { throw new Error('Checkpoint integrity error'); } // Corrupt storage is 500, not a reflected local-path validation error.
}
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// Preserve the full 1024-byte password range even with JSON escape expansion.
const LOGIN_BODY_LIMIT = 8 * 1024;
// Two 1024-byte passwords plus the username, including JSON escape expansion.
const PASSWORD_BODY_LIMIT = 16 * 1024;
const CLOSE = Symbol('sync-server-close');

function problem(status, message) { return Object.assign(new Error(message), { status }); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`Invalid ${name}`);
  return result;
}
function validUsername(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}
function validPassword(value, bootstrap = false) {
  return typeof value === 'string' && Buffer.byteLength(value) <= 1024 && (!bootstrap || [...value].length >= 8);
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function manifestText(value) {
  const manifest = validateManifest(value);
  // New writes must also be safe to display. Keep historical manifest decoding
  // unchanged, but do not admit roots which poison authenticated project browsing.
  projectFolderMetadata(manifest.sourceRoot);
  // These lists are sets semantically; object key and listing order do not defeat idempotence.
  manifest.sessionIds.sort();
  manifest.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { manifest, text: canonicalJson(manifest) };
}
function publicMetadata(entry) {
  const { id, projectId, deviceId, parentId, createdAt, fileCount, totalBytes } = entry;
  return { id, projectId, deviceId, parentId, createdAt, fileCount, totalBytes };
}
function headsFor(state, projectId) {
  const heads = new Set();
  for (const entry of state.checkpoints) {
    if (entry.projectId !== projectId) continue;
    if (entry.parentId !== null) heads.delete(entry.parentId);
    heads.add(entry.id);
  }
  return [...heads];
}
function isLoopback(host) {
  return host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.split('.')[0] === '127');
}

async function isRedirect(filename) {
  const lexical = path.resolve(filename);
  const real = await fs.realpath(filename);
  return process.platform === 'win32' ? lexical.toLowerCase() !== real.toLowerCase() : lexical !== real;
}
async function assertDirectory(directory) {
  // Some Windows junctions report isSymbolicLink() === false. Check realpath too,
  // including the nearest existing ancestor before recursive mkdir writes anything.
  let ancestor = path.resolve(directory);
  for (;;) {
    let info;
    try { info = await fs.lstat(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent; continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await isRedirect(ancestor)) throw new Error('Storage directories must be real directories without redirects');
    break;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await isRedirect(directory)) throw new Error('Storage directories must be real directories without redirects');
}
async function regularFile(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || await isRedirect(filename)) throw new Error('Storage contains an invalid or redirected file');
  return info;
}
async function syncDirectory(directory) {
  // Windows does not generally permit directory fsync. The file was synced before rename.
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch { /* Best effort: a completed rename must never be treated as a rolled-back write. */ }
  finally { await handle?.close().catch(() => {}); }
}
async function atomicWrite(filename, contents) {
  const temporary = path.join(path.dirname(filename), `.write-${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
async function passwordHash(password, salt) { return scrypt(password, Buffer.from(salt, 'hex'), 64, SCRYPT); }
async function passwordMatches(password, auth) {
  const candidate = await passwordHash(password, auth.salt);
  return timingSafeEqual(candidate, Buffer.from(auth.hash, 'hex'));
}

function validateState(value) {
  if (!isRecord(value) || ![1, 2].includes(value.version) || !isRecord(value.auth) || !Array.isArray(value.tokens) || !Array.isArray(value.checkpoints)) {
    throw new Error('Invalid storage state');
  }
  const auth = value.auth;
  const passwordRevision = Object.hasOwn(auth, 'passwordRevision') ? auth.passwordRevision : 0;
  if (!validUsername(auth.username) || auth.algorithm !== 'scrypt' || auth.N !== SCRYPT.N || auth.r !== SCRYPT.r || auth.p !== SCRYPT.p ||
      !/^[a-f0-9]{64}$/.test(auth.salt) || !/^[a-f0-9]{128}$/.test(auth.hash) ||
      !Number.isSafeInteger(passwordRevision) || passwordRevision < 0) throw new Error('Invalid credential record');
  const tokens = new Set();
  for (const token of value.tokens) {
    if (!isRecord(token) || !HASH_PATTERN.test(token.hash) || !Number.isSafeInteger(token.expiresAt) || token.expiresAt <= 0 || tokens.has(token.hash)) {
      throw new Error('Invalid token record');
    }
    validateId(token.deviceId);
    tokens.add(token.hash);
  }
  const ids = new Map();
  for (const entry of value.checkpoints) {
    if (!isRecord(entry)) throw new Error('Invalid checkpoint index');
    validateId(entry.id); validateId(entry.projectId); validateId(entry.deviceId);
    if (entry.parentId !== null) validateId(entry.parentId);
    if (ids.has(entry.id) || !HASH_PATTERN.test(entry.manifestSha256) || typeof entry.conflict !== 'boolean' ||
        !Number.isSafeInteger(entry.fileCount) || entry.fileCount < 0 || entry.fileCount > MAX_FILES ||
        !Number.isSafeInteger(entry.totalBytes) || entry.totalBytes < 0 || entry.totalBytes > MAX_CHECKPOINT_BYTES ||
        typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) ||
        (entry.parentId !== null && ids.get(entry.parentId)?.projectId !== entry.projectId)) throw new Error('Invalid checkpoint index');
    ids.set(entry.id, entry);
  }
  if (value.version === 2) validateId(value.serverId);
  const normalized = { ...value, auth: { ...auth, passwordRevision } };
  return { ...normalized, ...validateDeviceAuthState(normalized) };
}

async function openStore(dataDir, username, password, loadBootstrapPassword) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required');
  if (loadBootstrapPassword !== undefined && (typeof loadBootstrapPassword !== 'function' || password !== undefined)) {
    throw new TypeError('Supply either password or loadBootstrapPassword');
  }
  const root = path.resolve(dataDir);
  await assertDirectory(root);
  const lockPath = path.join(root, '.lock');
  const owner = randomBytes(32).toString('hex');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Storage is locked; stop the other process before recovering any stale lock');
    throw error;
  }
  let released = false;
  async function release() {
    if (released) return;
    released = true;
    await lock.close();
    // Never delete a replacement lock which an operator may have installed.
    try {
      const info = await regularFile(lockPath);
      if (info.size < 4096 && JSON.parse(await fs.readFile(lockPath, 'utf8')).owner === owner) await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, owner, createdAt: new Date().toISOString() }));
    await lock.sync();
    const blobDir = path.join(root, 'blobs');
    const checkpointDir = path.join(root, 'checkpoints');
    const temporaryDir = path.join(root, 'tmp');
    await assertDirectory(blobDir);
    await assertDirectory(checkpointDir);
    await assertDirectory(temporaryDir);
    const statePath = path.join(root, 'state.json');
    let state, initialized = false;
    try {
      await regularFile(statePath);
      state = validateState(JSON.parse(await fs.readFile(statePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (loadBootstrapPassword) password = await loadBootstrapPassword();
      if (!validUsername(username) || !validPassword(password, true)) {
        throw new Error('New storage requires a username and a password of at least 8 characters (at most 1024 UTF-8 bytes)');
      }
      // A missing state file in a populated directory is not permission to reset the account.
      const contents = await fs.readdir(root);
      const allowed = new Set(['.lock', 'blobs', 'checkpoints', 'tmp']);
      const occupied = (await fs.readdir(blobDir)).length || (await fs.readdir(checkpointDir)).length || (await fs.readdir(temporaryDir)).length;
      if (contents.some(name => !allowed.has(name)) || occupied) throw new Error('Refusing to bootstrap nonempty storage without its state');
      const salt = randomBytes(32).toString('hex');
      state = {
        version: 2, serverId: `server-${randomBytes(16).toString('hex')}`, families: [],
        auth: { username, algorithm: 'scrypt', salt, hash: (await passwordHash(password, salt)).toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, passwordRevision: 0 },
        tokens: [], checkpoints: [],
      };
      await atomicWrite(statePath, JSON.stringify(state));
      initialized = true;
    }
    if (username !== undefined && username !== state.auth.username) throw new Error('Bootstrap username does not match the existing account');
    // A rotated store is authoritative. Never consult an obsolete bootstrap file,
    // or let bootstrap credentials reset it. Revision zero retains legacy checks.
    if (!initialized && state.auth.passwordRevision === 0) {
      if (loadBootstrapPassword) password = await loadBootstrapPassword();
      if (password !== undefined && (!validPassword(password) || !(await passwordMatches(password, state.auth)))) {
        throw new Error('Bootstrap password does not match the existing account; automatic password reset is disabled');
      }
    }
    if (state.version === 1) {
      // A schema-version fence prevents an old binary from bypassing v2 project
      // migration or refresh-family revocation. Keep an owner-only pre-upgrade copy.
      const backup = path.join(root, 'state-v1-before-upgrade.json');
      let handle;
      try {
        handle = await fs.open(backup, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(state)); await handle.sync();
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const prior = JSON.parse((await readStableFile(backup, 64 * 1024 * 1024)).bytes.toString('utf8'));
        if (canonicalJson(prior) !== canonicalJson(state)) throw new Error('Pre-upgrade state backup differs; inspect storage before migrating');
      } finally { await handle?.close(); }
      state = { ...state, version: 2, serverId: `server-${randomBytes(16).toString('hex')}`, families: [] };
      await atomicWrite(statePath, JSON.stringify(state));
    }
    const store = {
      root, blobDir, checkpointDir, temporaryDir, state, tail: Promise.resolve(), release,
      async save(next) { await atomicWrite(statePath, JSON.stringify(next)); store.state = next; },
      exclusive(task) {
        const result = store.tail.then(task);
        store.tail = result.catch(() => {});
        return result;
      },
    };
    return store;
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}

function sendJson(req, res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!req.complete) res.setHeader('Connection', 'close');
  if (body) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Length', body.length); }
  res.end(body);
  if (!req.complete) res.once('finish', () => req.socket.destroy());
}
function sendError(req, res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message = status === 401 ? 'Unauthorized' : status === 404 ? 'Not found' : status >= 500 ? 'Internal server error' : error.message;
  const v2 = req.url?.startsWith('/v2/');
  const safeCodes = new Set(['SYNC_PROJECT_CORRUPT', 'SYNC_HEAD_MISMATCH', 'SYNC_LEGACY_HEAD_MISMATCH', 'SYNC_MIGRATION_REQUIRED', 'SYNC_ALREADY_MIGRATED', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'BAD_REQUEST']);
  const code = safeCodes.has(error.code) ? error.code : status === 401 ? 'NOT_LOGGED_IN' : status === 429 ? 'RATE_LIMITED' : status === 409 ? 'SYNC_CONFLICT' : status >= 500 ? 'SERVER_UNAVAILABLE' : 'BAD_REQUEST';
  sendJson(req, res, status, { error: message, ...(v2 ? { code } : {}) });
}
function contentLimit(req, limit) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw problem(400, 'Invalid content length');
  if (length !== undefined && Number(length) > limit) throw problem(413, 'Request body is too large');
  const encoding = req.headers['content-encoding'];
  if (encoding && encoding.toLowerCase() !== 'identity') throw problem(415, 'Content encoding is not supported');
}
async function readJson(req, limit) {
  contentLimit(req, limit);
  const type = req.headers['content-type'];
  if (type && !/^application\/json(?:\s*;|$)/i.test(type)) throw problem(415, 'Expected application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw problem(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw problem(400, 'Invalid JSON body'); }
}
function bearer(req, state) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw problem(401, 'Unauthorized');
  const raw = authorization.slice(7);
  if (!TOKEN_PATTERN.test(raw)) throw problem(401, 'Unauthorized');
  const hash = sha256(Buffer.from(raw));
  const token = state.tokens.find(item => item.hash === hash);
  if (!token || token.expiresAt <= Date.now()) throw problem(401, 'Unauthorized');
  return token;
}
function assertTokenStillValid(token, state) {
  if (token.expiresAt <= Date.now() || !state.tokens.some(item => item.hash === token.hash)) throw problem(401, 'Unauthorized');
}
function assertPasswordStillCurrent(auth, state) {
  if (auth.passwordRevision !== state.auth.passwordRevision || auth.hash !== state.auth.hash || auth.salt !== state.auth.salt) {
    throw problem(401, 'Unauthorized');
  }
}
function routeId(value, validator) {
  try { return validator(decodeURIComponent(value)); }
  catch (error) { if (error.status) throw error; throw problem(400, 'Invalid identifier'); }
}

class LoginLimiter {
  constructor({ attempts, windowMs, maxEntries }) {
    this.attempts = attempts; this.windowMs = windowMs; this.maxEntries = maxEntries; this.entries = new Map();
  }
  take(key) {
    const now = Date.now();
    for (const [address, entry] of this.entries) if (entry.until <= now) this.entries.delete(address);
    let entry = this.entries.get(key);
    if (!entry) {
      // Reject new addresses when full instead of evicting and letting attackers bypass limits.
      if (this.entries.size >= this.maxEntries) return false;
      entry = { count: 0, until: now + this.windowMs }; this.entries.set(key, entry);
    }
    if (entry.count >= this.attempts) return false;
    entry.count += 1;
    return true;
  }
}

async function uploadBlob(req, store, hash, limit, token) {
  contentLimit(req, limit);
  const temporary = path.join(store.temporaryDir, `blob-${randomBytes(24).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    const digest = createHash('sha256'); let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) throw problem(413, 'Blob exceeds size limit');
      digest.update(chunk);
      await handle.writeFile(chunk);
    }
    if (digest.digest('hex') !== hash) throw problem(400, 'Blob checksum mismatch');
    await handle.sync(); await handle.close(); handle = undefined;
    return await store.exclusive(async () => {
      assertTokenStillValid(token, store.state);
      const target = path.join(store.blobDir, hash);
      try {
        const existing = await regularFile(target);
        if (existing.size !== size) throw problem(409, 'Stored blob size is inconsistent');
        const stored = await readStableFile(target, limit);
        if (stored.bytes.length !== size || sha256(stored.bytes) !== hash) throw problem(409, 'Stored blob integrity check failed');
        assertTokenStillValid(token, store.state);
        return 204;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temporary, target);
      await syncDirectory(store.blobDir);
      return 201;
    });
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
async function downloadBlob(req, res, store, hash) {
  const filename = path.join(store.blobDir, hash);
  let handle;
  try {
    await regularFile(filename);
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile()) throw problem(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': info.size,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(handle.createReadStream({ autoClose: false }), res);
  } catch (error) { if (error.code === 'ENOENT') throw problem(404, 'Not found'); throw error; }
  finally { await handle?.close().catch(() => {}); }
}

/**
 * Open one local, single-user store. No listener is started and no data is uploaded.
 * Call server.listen(port[, loopbackHost]) and await closeSyncServer(server) at shutdown.
 * Bootstrap credentials are optional for existing stores. Revision-zero stores
 * reject mismatches; rotated stores never consult the bootstrap password again.
 */
export async function createSyncServer(options = {}) {
  const tokenTtlMs = positiveInteger(options.tokenTtlMs, DAY_MS, 'tokenTtlMs', 365 * DAY_MS);
  const maxBlobBytes = positiveInteger(options.maxBlobBytes, MAX_BLOB_BYTES, 'maxBlobBytes', MAX_BLOB_BYTES);
  const maxManifestBytes = positiveInteger(options.maxManifestBytes, MAX_MANIFEST_BYTES, 'maxManifestBytes', MAX_MANIFEST_BYTES);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 30_000, 'requestTimeoutMs', 10 * 60_000);
  const headersTimeoutMs = positiveInteger(options.headersTimeoutMs, Math.min(requestTimeoutMs, 10_000), 'headersTimeoutMs', requestTimeoutMs);
  const maxConnections = positiveInteger(options.maxConnections, 128, 'maxConnections', 10_000);
  const maxLoginConcurrency = positiveInteger(options.maxLoginConcurrency, 2, 'maxLoginConcurrency', 16);
  const maxTokens = positiveInteger(options.maxTokens, 4096, 'maxTokens', 100_000);
  const limiter = new LoginLimiter({
    attempts: positiveInteger(options.loginMaxAttempts, 20, 'loginMaxAttempts', 100_000),
    windowMs: positiveInteger(options.loginWindowMs, 15 * 60_000, 'loginWindowMs', DAY_MS),
    maxEntries: positiveInteger(options.loginMaxEntries, 1024, 'loginMaxEntries', 100_000),
  });
  const store = await openStore(options.dataDir, options.username, options.password, options.loadBootstrapPassword);
  const verifyBlob = async ({ hash, size }) => {
    validateBlobHash(hash);
    const { bytes } = await readStableFile(path.join(store.blobDir, hash), maxBlobBytes);
    if (bytes.length !== size || sha256(bytes) !== hash) throw problem(409, 'Referenced blob integrity check failed');
  };
  let sync, deviceAuth;
  try {
    deviceAuth = createDeviceAuth({ store, tokenTtlMs, maxTokens, ...(options.refreshIdleMs === undefined ? {} : { refreshIdleMs: options.refreshIdleMs }), ...(options.refreshAbsoluteMs === undefined ? {} : { refreshAbsoluteMs: options.refreshAbsoluteMs }) });
    sync = await createSyncStore({ directory: path.join(store.root, 'sync-v2'), exclusive: task => store.exclusive(task), verifyBlob });
  } catch (error) { await store.release(); throw error; }
  const syncHttp = createSyncHttp({ sync, store, readJson, sendJson, assertTokenStillValid, verifyBlob, headsFor });
  const publicGrant = value => ({ ...value, expiresAt: new Date(value.expiresAt).toISOString(), refreshExpiresAt: new Date(value.refreshExpiresAt).toISOString(), absoluteExpiresAt: new Date(value.absoluteExpiresAt).toISOString(), serverId: store.state.serverId });
  let loginConcurrency = 0, closing = false, closingPromise;
  const active = new Set();
  const sockets = new Set();

  async function handle(req, res) {
    if (closing) throw problem(503, 'Server is closing');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { throw problem(400, 'Invalid URL'); }
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/health') {
      res.setHeader('X-DSH-Sync-Password-Change', '1');
      res.setHeader('X-DSH-Sync-Protocol', '2');
      sendJson(req, res, 200, { ok: true }); return;
    }
    const changingPassword = pathname === '/v1/password', renewableLogin = pathname === '/v2/login';
    if (req.method === 'POST' && (pathname === '/v1/login' || renewableLogin || changingPassword)) {
      // Both routes share the same per-address budget and concurrent KDF slots.
      if (!limiter.take(req.socket.remoteAddress ?? 'unknown') || loginConcurrency >= maxLoginConcurrency) {
        res.setHeader('Retry-After', '60'); throw problem(429, 'Too many login attempts');
      }
      const credentials = await readJson(req, changingPassword ? PASSWORD_BODY_LIMIT : LOGIN_BODY_LIMIT);
      let deviceId;
      if (changingPassword) {
        if (!isRecord(credentials) || !validUsername(credentials.username) || !validPassword(credentials.currentPassword) ||
            !validPassword(credentials.newPassword, true) || Buffer.from(credentials.currentPassword).equals(Buffer.from(credentials.newPassword)) ||
            Object.keys(credentials).some(key => !['username', 'currentPassword', 'newPassword'].includes(key))) {
          throw problem(400, 'Invalid password change request');
        }
      } else {
        if (!isRecord(credentials) || !validUsername(credentials.username) || !validPassword(credentials.password) ||
            Object.keys(credentials).some(key => !['username', 'password', 'deviceId'].includes(key))) throw problem(400, 'Invalid login request');
        deviceId = validateId(credentials.deviceId);
      }
      if (loginConcurrency >= maxLoginConcurrency) { res.setHeader('Retry-After', '1'); throw problem(429, 'Too many login attempts'); }
      loginConcurrency += 1;
      // Immutable hash/revision snapshot: scrypt never holds the business-write lock.
      const auth = store.state.auth;
      let nextAuth;
      try {
        // Run the same expensive KDF even when the username is wrong. Bearer
        // headers are deliberately irrelevant to current-password authentication.
        const matches = await passwordMatches(changingPassword ? credentials.currentPassword : credentials.password, auth);
        if (!matches || credentials.username !== auth.username) throw problem(401, 'Unauthorized');
        if (changingPassword) {
          if (auth.passwordRevision === Number.MAX_SAFE_INTEGER) throw new Error('Password revision exhausted');
          const salt = randomBytes(32).toString('hex');
          nextAuth = { ...auth, salt, hash: (await passwordHash(credentials.newPassword, salt)).toString('hex'), passwordRevision: auth.passwordRevision + 1 };
        }
      } finally { loginConcurrency -= 1; }
      if (changingPassword) {
        await store.exclusive(async () => {
          assertPasswordStillCurrent(auth, store.state);
          // Credential replacement and revocation have one durable commit point.
          await store.save({ ...store.state, auth: nextAuth, tokens: [], families: [] });
        });
        sendJson(req, res, 200, { changed: true }); return;
      }
      if (renewableLogin) {
        const grant = await deviceAuth.issue({ deviceId, authSnapshot: auth });
        sendJson(req, res, 200, publicGrant(grant)); return;
      }
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + tokenTtlMs;
      await store.exclusive(async () => {
        // A login verified against the old hash must not issue a token after rotation.
        assertPasswordStillCurrent(auth, store.state);
        const tokens = store.state.tokens.filter(item => item.expiresAt > Date.now());
        if (tokens.length >= maxTokens) throw problem(429, 'Session limit reached');
        tokens.push({ hash: sha256(Buffer.from(token)), expiresAt, deviceId });
        await store.save({ ...store.state, tokens });
      });
      sendJson(req, res, 200, { token, expiresAt: new Date(expiresAt).toISOString() }); return;
    }
    if (req.method === 'POST' && ['/v2/refresh', '/v2/revoke'].includes(pathname)) {
      if (!limiter.take(req.socket.remoteAddress ?? 'unknown')) { res.setHeader('Retry-After', '60'); throw problem(429, 'Too many authentication attempts'); }
      const input = await readJson(req, LOGIN_BODY_LIMIT);
      if (!isRecord(input) || Object.keys(input).some(key => !['deviceId', 'familyId', 'refreshToken'].includes(key))) throw problem(400, 'Invalid refresh request');
      if (pathname === '/v2/refresh') sendJson(req, res, 200, publicGrant(await deviceAuth.refresh(input)));
      else { await deviceAuth.revokeFamily(input); sendJson(req, res, 204); }
      return;
    }
    const token = bearer(req, store.state);
    if (req.method === 'POST' && ['/v1/logout', '/v2/logout'].includes(pathname)) {
      await deviceAuth.logout({ token });
      sendJson(req, res, 204); return;
    }
    if (pathname.startsWith('/v2/') && await syncHttp(req, res, url, token)) return;
    if (pathname === '/v1/projects' && req.method === 'GET') {
      // Only the committed index is authoritative; never enumerate orphan manifests.
      const projects = new Map(), latest = new Map();
      const committed = store.state.checkpoints;
      for (const entry of committed) {
        const prior = projects.get(entry.projectId);
        if (prior) { prior.checkpointCount++; if (Date.parse(entry.createdAt) > Date.parse(prior.latestCreatedAt)) prior.latestCreatedAt = entry.createdAt; }
        else projects.set(entry.projectId, { projectId: entry.projectId, checkpointCount: 1, latestCreatedAt: entry.createdAt });
        latest.set(entry.projectId, entry); // Append order is commit order; timestamps do not choose a branch.
      }
      let partial = false;
      for (const [projectId, entry] of latest) {
        try {
          const manifest = await committedManifest(store, entry);
          Object.assign(projects.get(projectId), projectFolderMetadata(manifest.sourceRoot), { latestCheckpointId: manifest.id });
        } catch {
          // An unavailable project is not permission to present an older snapshot,
          // and must not prevent browsing unrelated, verified projects.
          projects.delete(projectId); partial = true;
        }
      }
      assertTokenStillValid(token, store.state);
      sendJson(req, res, 200, { projects: [...projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId, 'en')), ...(partial ? { partial: true } : {}) }); return;
    }
    if (pathname === '/v1/checkpoints' && req.method === 'GET') {
      const projectId = validateId(url.searchParams.get('projectId'));
      if (await sync.head(projectId)) throw Object.assign(problem(426, 'This project requires a v2 sync client'), { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' });
      const state = store.state;
      sendJson(req, res, 200, { checkpoints: state.checkpoints.filter(entry => entry.projectId === projectId).map(publicMetadata), heads: headsFor(state, projectId) }); return;
    }
    if (pathname === '/v1/checkpoints' && req.method === 'POST') {
      const { manifest, text } = manifestText(await readJson(req, maxManifestBytes));
      if (manifest.deviceId !== token.deviceId) throw problem(403, 'Checkpoint device does not match the authenticated device');
      const manifestSha256 = sha256(Buffer.from(text));
      const result = await store.exclusive(async () => {
        assertTokenStillValid(token, store.state);
        const state = store.state;
        if (await sync.head(manifest.projectId)) throw Object.assign(problem(426, 'This project requires a v2 sync client'), { code: 'SYNC_CLIENT_UPGRADE_REQUIRED' });
        const existing = state.checkpoints.find(entry => entry.id === manifest.id);
        if (existing) {
          if (existing.manifestSha256 !== manifestSha256) throw problem(409, 'Checkpoint id already exists with different content');
          return { id: manifest.id, conflict: existing.conflict, heads: headsFor(state, manifest.projectId) };
        }
        if (manifest.parentId !== null && !state.checkpoints.some(entry => entry.id === manifest.parentId && entry.projectId === manifest.projectId)) {
          throw problem(409, 'Checkpoint parent is missing or belongs to another project');
        }
        const checked = new Set();
        for (const file of manifest.files) {
          if (checked.has(file.sha256)) continue;
          checked.add(file.sha256);
          let info;
          try { info = await regularFile(path.join(store.blobDir, file.sha256)); }
          catch (error) { if (error.code === 'ENOENT') throw problem(409, 'Referenced blob is missing'); throw error; }
          if (info.size !== file.size) throw problem(409, 'Referenced blob size does not match');
          const stored = await readStableFile(path.join(store.blobDir, file.sha256), maxBlobBytes);
          if (stored.bytes.length !== file.size || sha256(stored.bytes) !== file.sha256) throw problem(409, 'Referenced blob integrity check failed');
        }
        assertTokenStillValid(token, store.state);
        const previousHeads = headsFor(state, manifest.projectId);
        const conflict = manifest.parentId === null ? previousHeads.length > 0 : !previousHeads.includes(manifest.parentId);
        const entry = {
          id: manifest.id, projectId: manifest.projectId, deviceId: manifest.deviceId, parentId: manifest.parentId,
          createdAt: manifest.createdAt, fileCount: manifest.files.length,
          totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), manifestSha256, conflict,
        };
        // An orphan manifest after a crash is harmless: only the atomically replaced index commits it.
        await atomicWrite(path.join(store.checkpointDir, `${sha256(Buffer.from(manifest.id))}.json`), text);
        const next = { ...state, checkpoints: [...state.checkpoints, entry] };
        await store.save(next);
        return { id: manifest.id, conflict, heads: headsFor(next, manifest.projectId) };
      });
      sendJson(req, res, 201, result); return;
    }
    const checkpointMatch = /^\/v1\/checkpoints\/([^/]+)$/.exec(pathname);
    if (checkpointMatch && req.method === 'GET') {
      const id = routeId(checkpointMatch[1], validateId);
      const entry = store.state.checkpoints.find(item => item.id === id);
      if (!entry) throw problem(404, 'Not found');
      const manifest = await committedManifest(store, entry);
      assertTokenStillValid(token, store.state);
      sendJson(req, res, 200, manifest); return;
    }
    const blobMatch = /^\/v1\/blobs\/([^/]+)$/.exec(pathname);
    if (blobMatch && (req.method === 'PUT' || req.method === 'GET')) {
      const hash = routeId(blobMatch[1], validateBlobHash);
      if (req.method === 'PUT') sendJson(req, res, await uploadBlob(req, store, hash, maxBlobBytes, token));
      else await downloadBlob(req, res, store, hash);
      return;
    }
    throw problem(404, 'Not found');
  }

  function dispatch(req, res) {
    if (active.size >= maxConnections) { sendError(req, res, problem(503, 'Too many requests')); return; }
    const timer = setTimeout(() => { req.destroy(); res.destroy(); }, requestTimeoutMs);
    timer.unref();
    const task = handle(req, res).catch(error => sendError(req, res, error)).finally(() => { clearTimeout(timer); active.delete(task); });
    active.add(task);
  }
  const server = http.createServer({
    requestTimeout: requestTimeoutMs, headersTimeout: headersTimeoutMs,
    connectionsCheckingInterval: Math.min(headersTimeoutMs, 1000),
    keepAliveTimeout: 5000, maxHeaderSize: 16 * 1024,
  }, dispatch);
  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = 1000;
  server.maxHeadersCount = 100;
  server.setTimeout(requestTimeoutMs, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('checkContinue', (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!(req.method === 'POST' && (pathname === '/v1/login' || pathname === '/v1/password')) && !(req.method === 'GET' && pathname === '/health')) bearer(req, store.state);
      contentLimit(req, pathname === '/v1/login' ? LOGIN_BODY_LIMIT : pathname === '/v1/password' ? PASSWORD_BODY_LIMIT : maxBlobBytes);
      res.writeContinue(); dispatch(req, res);
    } catch (error) { sendError(req, res, error); }
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });

  const nativeListen = server.listen.bind(server);
  server.listen = (...args) => {
    if (closing) throw new Error('Server is closed');
    let config, callback;
    if (isRecord(args[0])) {
      config = { ...args[0] }; callback = args.find(arg => typeof arg === 'function');
      if ('path' in config || 'fd' in config || 'handle' in config) throw new Error('Only loopback TCP listeners are supported');
    } else {
      config = { port: args[0] }; callback = args.find(arg => typeof arg === 'function');
      if (typeof args[1] === 'string') config.host = args[1];
      const backlog = typeof args[1] === 'number' ? args[1] : typeof args[2] === 'number' ? args[2] : undefined;
      if (backlog !== undefined) config.backlog = backlog;
    }
    if (typeof config.port === 'string' && /^\d+$/.test(config.port)) config.port = Number(config.port);
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid listening port');
    config.host ??= '127.0.0.1';
    if (!isLoopback(config.host)) throw new Error('Direct public HTTP is forbidden; bind loopback and use a TLS reverse proxy');
    if (config.host === 'localhost') config.host = '127.0.0.1';
    return nativeListen(config, callback);
  };
  const nativeClose = server.close.bind(server);
  const shutdown = () => {
    if (closingPromise) return closingPromise;
    closing = true;
    closingPromise = (async () => {
      await new Promise((resolve, reject) => {
        const force = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 2000);
        force.unref();
        nativeClose(error => {
          clearTimeout(force);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
        });
        server.closeIdleConnections();
      });
      await Promise.allSettled([...active]);
      await store.tail;
      await store.release();
    })();
    return closingPromise;
  };
  Object.defineProperty(server, CLOSE, { value: shutdown });
  Object.defineProperty(server, 'closeSync', { value: shutdown });
  server.close = callback => { shutdown().then(() => callback?.(), error => { if (callback) callback(error); else server.emit('error', error); }); return server; };
  return server;
}

/** Close connections, settle writes/KDF work, and release the exclusive storage lock. */
export async function closeSyncServer(server) {
  if (!server || typeof server[CLOSE] !== 'function') throw new TypeError('Expected a sync server');
  await server[CLOSE]();
}
