import { SyncClient } from './client.mjs';
import { assert, validateId, validateBlobHash, MAX_MANIFEST_BYTES, MAX_BLOB_BYTES } from './protocol.mjs';
import { validateSyncManifest, syncManifestDigest, MAX_SYNC_PAGE_SIZE } from './sync-protocol.mjs';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const codes = new Set(['NOT_LOGGED_IN', 'RATE_LIMITED', 'BAD_REQUEST', 'SERVER_UNAVAILABLE', 'SYNC_PROJECT_CORRUPT', 'SYNC_HEAD_MISMATCH', 'SYNC_LEGACY_HEAD_MISMATCH', 'SYNC_MIGRATION_REQUIRED', 'SYNC_ALREADY_MIGRATED', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_CONFLICT']);
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function head(input, projectId) {
  assert(record(input) && input.projectId === projectId && integer(input.revision) && input.revision > 0, 'Invalid canonical head');
  return { projectId: validateId(projectId), id: validateId(input.id), revision: input.revision, manifestDigest: validateBlobHash(input.manifestDigest), recordHash: validateBlobHash(input.recordHash) };
}
function receipt(input, projectId, requestId) {
  const value = head(input, projectId);
  assert(input.requestId === requestId, 'Invalid commit receipt');
  return { ...value, requestId: validateId(requestId) };
}
function grant(input) {
  assert(record(input) && tokenPattern.test(input.token) && tokenPattern.test(input.refreshToken) && tokenPattern.test(input.familyId), 'Invalid device grant');
  assert(date(input.expiresAt) && date(input.refreshExpiresAt) && date(input.absoluteExpiresAt) && Date.parse(input.refreshExpiresAt) <= Date.parse(input.absoluteExpiresAt), 'Invalid device grant expiry');
  return { token: input.token, expiresAt: input.expiresAt, refreshToken: input.refreshToken, refreshExpiresAt: input.refreshExpiresAt, familyId: input.familyId, absoluteExpiresAt: input.absoluteExpiresAt, serverId: validateId(input.serverId) };
}
async function body(response, maxBytes) {
  const raw = response.headers.get('content-length');
  if (raw !== null) assert(/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= maxBytes, 'Server response too large');
  const chunks = []; let length = 0;
  if (response.body) for await (const chunk of response.body) { length += chunk.byteLength; assert(length <= maxBytes, 'Server response too large'); chunks.push(chunk); }
  if (!length) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
  catch { throw fail('SYNC_INVALID_RESPONSE'); }
}

/** Host/CLI only. No automatic credential refresh or mutation replay here: the
 * native credential owner must serialize renewal and persist its outcome.
 */
export class SyncV2Client extends SyncClient {
  constructor(config) { super(config); this.serverId = config.serverId; }
  async requestV2(route, { method = 'GET', json, authenticated = true, maxBytes = MAX_MANIFEST_BYTES } = {}) {
    assert(!authenticated || tokenPattern.test(this.token), 'Login required');
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const headers = { accept: 'application/json', ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) };
    const response = await fetch(this.server + route, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }), signal, redirect: 'error' });
    const value = await body(response, response.ok ? maxBytes : 16_384);
    if (!response.ok) {
      const code = codes.has(value?.code) ? value.code : response.status === 401 ? 'NOT_LOGGED_IN' : response.status === 429 ? 'RATE_LIMITED' : response.status === 426 ? 'SYNC_CLIENT_UPGRADE_REQUIRED' : response.status >= 500 ? 'SERVER_UNAVAILABLE' : 'BAD_REQUEST';
      const retry = response.headers.get('retry-after');
      throw fail(code, { status: response.status, httpStatus: response.status, ...(retry && /^\d+$/.test(retry) ? { retryAfterMs: Math.min(Number(retry) * 1000, 300_000) } : {}) });
    }
    return value;
  }
  async supportsV2() {
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.server}/health`, { signal, redirect: 'error', headers: { accept: 'application/json' } });
    await body(response, 1024);
    if (!response.ok) throw fail('SERVER_UNAVAILABLE', { httpStatus: response.status });
    return response.headers.get('x-dsh-sync-protocol') === '2';
  }
  async capabilities() {
    const result = await this.requestV2('/v2/capabilities', { maxBytes: 4096 });
    assert(result?.protocol === 2 && result.bidirectional === true && result.recoverableDeletes === true, 'Bidirectional synchronization is unsupported');
    const serverId = validateId(result.serverId);
    if (this.serverId && this.serverId !== serverId) throw fail('ACCOUNT_MISMATCH');
    return { protocol: 2, serverId, bidirectional: true, recoverableDeletes: true, maxPageSize: MAX_SYNC_PAGE_SIZE, maxBlobBytes: MAX_BLOB_BYTES };
  }
  async loginRenewable({ username, password, deviceId }) {
    validateId(deviceId);
    assert(typeof username === 'string' && username.length > 0 && Buffer.byteLength(username) <= 128 && typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 1024, 'Invalid login');
    const payload = { username, password, deviceId };
    try {
      const value = grant(await this.requestV2('/v2/login', { method: 'POST', json: payload, authenticated: false, maxBytes: 4096 }));
      this.token = value.token; this.deviceId = deviceId; this.serverId = value.serverId; return value;
    } finally { payload.password = ''; }
  }
  async refreshGrant({ deviceId, refreshToken, familyId }) {
    validateId(deviceId); assert(tokenPattern.test(refreshToken) && tokenPattern.test(familyId), 'Invalid refresh proof');
    const value = grant(await this.requestV2('/v2/refresh', { method: 'POST', json: { deviceId, refreshToken, familyId }, authenticated: false, maxBytes: 4096 }));
    if (value.familyId !== familyId || this.serverId && value.serverId !== this.serverId) throw fail('ACCOUNT_MISMATCH');
    this.token = value.token; this.deviceId = deviceId; this.serverId = value.serverId; return value;
  }
  async revokeGrant({ deviceId, refreshToken, familyId }) {
    validateId(deviceId); assert(tokenPattern.test(refreshToken) && tokenPattern.test(familyId), 'Invalid revocation proof');
    await this.requestV2('/v2/revoke', { method: 'POST', json: { deviceId, refreshToken, familyId }, authenticated: false, maxBytes: 4096 });
    this.token = undefined;
  }
  async syncProjects({ limit = 100, cursor = null } = {}) {
    assert(integer(limit) && limit > 0 && limit <= MAX_SYNC_PAGE_SIZE, 'Invalid page size');
    if (cursor !== null) validateBlobHash(cursor);
    const result = await this.requestV2(`/v2/projects?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
    assert(record(result) && Array.isArray(result.projects) && result.projects.length <= limit, 'Invalid project page');
    const seen = new Set();
    const projects = result.projects.map(item => {
      assert(record(item), 'Invalid project');
      if (item.corrupt === true) return { projectId: item.projectId === null ? null : validateId(item.projectId), corrupt: true };
      const value = head(item, item.projectId);
      assert(!seen.has(value.projectId), 'Duplicate project'); seen.add(value.projectId);
      assert(typeof item.label === 'string' && item.label.trim() && item.label.length <= 200 && item.label.isWellFormed() && !/[\x00-\x1f\x7f]/.test(item.label) && integer(item.conflicts) && integer(item.fileCount), 'Invalid project summary');
      return { ...value, label: item.label, conflicts: item.conflicts, fileCount: item.fileCount };
    });
    return { projects, nextCursor: result.nextCursor === null ? null : validateBlobHash(result.nextCursor) };
  }
  async syncHead(projectId) {
    validateId(projectId); const result = await this.requestV2(`/v2/projects/${projectId}/head`, { maxBytes: 4096 });
    assert(record(result), 'Invalid head response');
    return result.head === null ? null : head(result.head, projectId);
  }
  async syncChanges(projectId, { afterRevision = 0, untilRevision, limit = 100 } = {}) {
    validateId(projectId);
    assert(integer(afterRevision) && integer(limit) && limit > 0 && limit <= MAX_SYNC_PAGE_SIZE && (untilRevision === undefined || integer(untilRevision) && untilRevision >= afterRevision), 'Invalid history page');
    const result = await this.requestV2(`/v2/projects/${projectId}/changes?afterRevision=${afterRevision}&limit=${limit}${untilRevision === undefined ? '' : `&untilRevision=${untilRevision}`}`);
    assert(record(result) && integer(result.untilRevision) && result.untilRevision >= afterRevision && (untilRevision === undefined || result.untilRevision === untilRevision) && Array.isArray(result.changes) && result.changes.length === Math.min(limit, result.untilRevision - afterRevision), 'Invalid history page response');
    const seen = new Set();
    const changes = result.changes.map((item, index) => {
      const value = receipt(item, projectId, item.requestId);
      assert(value.revision === afterRevision + index + 1 && !seen.has(value.id) && integer(item.policyRevision), 'Invalid history sequence'); seen.add(value.id);
      const parentId = item.parentId === null ? null : validateId(item.parentId);
      assert((value.revision === 1) === (parentId === null) && parentId !== value.id && (index === 0 || parentId === result.changes[index - 1].id), 'Invalid history parent');
      let migration = null;
      if (item.migration !== null) {
        assert(value.revision === 1 && record(item.migration) && Array.isArray(item.migration.legacyHeads) && item.migration.legacyHeads.length > 0 && item.migration.legacyHeads.length <= 20_000 && new Set(item.migration.legacyHeads).size === item.migration.legacyHeads.length, 'Invalid migration history');
        migration = { legacyHeads: item.migration.legacyHeads.map(validateId) };
      }
      return { ...value, parentId, deviceId: validateId(item.deviceId), policyRevision: item.policyRevision, migration };
    });
    const last = changes.at(-1)?.revision ?? afterRevision;
    assert(result.nextAfterRevision === (last < result.untilRevision ? last : null), 'Invalid history cursor');
    return { changes, untilRevision: result.untilRevision, nextAfterRevision: result.nextAfterRevision };
  }
  async syncCheckpoint(projectId, id, expectedDigest) {
    validateId(projectId); validateId(id);
    const manifest = validateSyncManifest(await this.requestV2(`/v2/projects/${projectId}/checkpoints/${id}`));
    assert(manifest.projectId === projectId && manifest.id === id && (!expectedDigest || syncManifestDigest(manifest) === validateBlobHash(expectedDigest)), 'Checkpoint does not match committed head');
    return manifest;
  }
  async syncReceipt(projectId, requestId) {
    validateId(projectId); validateId(requestId);
    const result = await this.requestV2(`/v2/projects/${projectId}/receipts/${requestId}`, { maxBytes: 4096 });
    assert(record(result), 'Invalid receipt response');
    return result.receipt === null ? null : receipt(result.receipt, projectId, requestId);
  }
  async missingBlobs(blobs) {
    assert(Array.isArray(blobs) && blobs.length <= 20_000, 'Invalid blob references');
    const missing = [];
    for (let offset = 0; offset < blobs.length; offset += 256) {
      const batch = blobs.slice(offset, offset + 256).map(item => { validateBlobHash(item.hash); assert(integer(item.size) && item.size <= MAX_BLOB_BYTES, 'Invalid blob size'); return { hash: item.hash, size: item.size }; });
      const result = await this.requestV2('/v2/blobs/missing', { method: 'POST', json: { blobs: batch }, maxBytes: 32 * 1024 });
      const allowed = new Set(batch.map(item => item.hash));
      assert(Array.isArray(result?.missing) && result.missing.length <= allowed.size && new Set(result.missing).size === result.missing.length && result.missing.every(hash => allowed.has(hash)), 'Invalid missing blob response');
      missing.push(...result.missing);
    }
    return [...new Set(missing)];
  }
  async commitSync(input) {
    const manifest = validateSyncManifest(input.manifest);
    const result = await this.requestV2(`/v2/projects/${manifest.projectId}/commits`, { method: 'POST', json: { ...input, manifest }, maxBytes: 4096 });
    const value = receipt(result, manifest.projectId, input.requestId);
    assert(value.id === manifest.id && value.manifestDigest === syncManifestDigest(manifest) && value.revision === input.expectedHeadRevision + 1, 'Commit acknowledgement differs');
    return value;
  }
  async legacyHeads(projectId) {
    validateId(projectId);
    const result = await this.requestV2(`/v2/projects/${projectId}/legacy`);
    assert(result?.projectId === projectId && Array.isArray(result.heads) && result.heads.length <= 20_000 && new Set(result.heads).size === result.heads.length && integer(result.checkpointCount), 'Invalid legacy head response');
    return { projectId, heads: result.heads.map(validateId), checkpointCount: result.checkpointCount, latestCheckpointId: result.latestCheckpointId === null ? null : validateId(result.latestCheckpointId) };
  }
  async migrateSync(input) {
    const manifest = validateSyncManifest(input.manifest);
    const result = receipt(await this.requestV2(`/v2/projects/${manifest.projectId}/migrate`, { method: 'POST', json: { ...input, manifest }, maxBytes: 4096 }), manifest.projectId, input.requestId);
    assert(result.id === manifest.id && result.revision === 1 && result.manifestDigest === syncManifestDigest(manifest), 'Migration acknowledgement differs'); return result;
  }
}
