import { assert, validateManifest, validateId, validateBlobHash, sha256, MAX_MANIFEST_BYTES, MAX_BLOB_BYTES } from './protocol.mjs';

export function validateServerUrl(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), 'HTTPS is required except on loopback');
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Server URL must be an origin without credentials or a path');
  return url.origin;
}
const passwordFailure = (code, definitive = true, status) => Object.assign(new Error(code), { code, definitive, ...(status ? { status } : {}) });
export function validatePasswordChange({ username, currentPassword, newPassword } = {}) {
  if (typeof username !== 'string' || !username.trim() || Buffer.byteLength(username) > 128 || /[\x00-\x1f\x7f]/.test(username) || typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword) > 1024) throw passwordFailure('BAD_REQUEST');
  if (typeof newPassword !== 'string' || [...newPassword].length < 8 || Buffer.byteLength(newPassword) > 1024) throw passwordFailure('PASSWORD_TOO_WEAK');
  if (Buffer.from(currentPassword, 'utf8').equals(Buffer.from(newPassword, 'utf8'))) throw passwordFailure('PASSWORD_UNCHANGED');
  return { username, currentPassword, newPassword };
}
async function limitedBody(response, maxBytes) {
  const length = response.headers.get('content-length');
  assert(length === null || (Number.isSafeInteger(Number(length)) && Number(length) >= 0 && Number(length) <= maxBytes), 'Server response too large');
  const chunks = []; let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      assert(size <= maxBytes, 'Server response too large');
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, size);
}
export class SyncClient {
  constructor({ server, token, deviceId, signal, timeoutMs = 60_000 }) {
    this.server = validateServerUrl(server); this.token = token; this.deviceId = deviceId; this.signal = signal; this.timeoutMs = timeoutMs;
  }
  async request(route, { method = 'GET', json, bytes, maxBytes = MAX_MANIFEST_BYTES, authenticated = true, binary = false, capabilityProbe = false } = {}) {
    assert(!authenticated || (typeof this.token === 'string' && this.token.length >= 32), 'Login required');
    const headers = { Accept: binary ? 'application/octet-stream' : 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${this.token}`;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (bytes !== undefined) headers['Content-Type'] = 'application/octet-stream';
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const response = await fetch(`${this.server}${route}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : bytes, redirect: 'error', signal });
    const body = await limitedBody(response, response.ok ? maxBytes : 16_384);
    if (!response.ok) {
      const error = new Error(`Sync server returned HTTP ${response.status}`);
      error.status = response.status; error.httpStatus = response.status; throw error;
    }
    if (capabilityProbe) return { passwordChange: response.headers.get('x-dsh-sync-password-change') === '1' };
    if (binary) return body;
    if (!body.length) return null;
    try { return JSON.parse(body.toString('utf8')); }
    catch { throw new Error('Sync server returned invalid JSON'); } // Never echo a response that could contain credentials.
  }
  async login({ username, password, deviceId }) {
    validateId(deviceId);
    const result = await this.request('/v1/login', { method: 'POST', json: { username, password, deviceId }, authenticated: false });
    assert(typeof result.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(result.token) && Number.isFinite(Date.parse(result.expiresAt)), 'Invalid login response');
    this.token = result.token; this.deviceId = deviceId;
    return { token: result.token, expiresAt: result.expiresAt };
  }
  async changePassword(input) {
    const json = validatePasswordChange(input);
    try {
      // Older servers authenticate unknown /v1 routes before returning 404. Probe
      // a read-only capability first so an old server is not reported as a bad password.
      let capabilities;
      try { capabilities = await this.request('/health', { authenticated: false, capabilityProbe: true, maxBytes: 1024 }); }
      catch { throw passwordFailure('SERVER_UNREACHABLE'); }
      if (!capabilities.passwordChange) throw passwordFailure('PASSWORD_CHANGE_UNSUPPORTED');
      const result = await this.request('/v1/password', { method: 'POST', json, authenticated: false, maxBytes: 1024 });
      if (result?.changed !== true) throw passwordFailure('PASSWORD_CHANGE_UNCERTAIN', false);
      return { changed: true };
    } catch (error) {
      if (error.code === 'PASSWORD_CHANGE_UNCERTAIN' || (error.definitive === true && ['SERVER_UNREACHABLE', 'PASSWORD_CHANGE_UNSUPPORTED'].includes(error.code))) throw error;
      // Only an actual, fully read HTTP rejection is definitive. A local response
      // size/header validator also uses status=400, but the cloud may have committed.
      const status = error.httpStatus;
      if (status === 401) throw passwordFailure('CURRENT_PASSWORD_INVALID', true, status);
      if (status === 404 || status === 405) throw passwordFailure('PASSWORD_CHANGE_UNSUPPORTED', true, status);
      if (status === 429) throw passwordFailure('RATE_LIMITED', true, status);
      if ([400, 403, 409, 413, 415, 422].includes(status)) throw passwordFailure('PASSWORD_CHANGE_REJECTED', true, status);
      // A disconnect or malformed acknowledgement may occur after the remote commit.
      throw passwordFailure('PASSWORD_CHANGE_UNCERTAIN', false, status);
    } finally {
      json.currentPassword = ''; json.newPassword = '';
    }
  }
  async logout() {
    let remoteRevoked = false;
    try { await this.request('/v1/logout', { method: 'POST' }); remoteRevoked = true; }
    catch (error) { if (error.status === 401) remoteRevoked = true; }
    this.token = undefined;
    return { remoteRevoked, ...(remoteRevoked ? {} : { warning: 'Local credentials removed; remote revocation could not be confirmed. The server token remains valid until expiry.' }) };
  }
  async list(projectId) { validateId(projectId); return this.request(`/v1/checkpoints?projectId=${encodeURIComponent(projectId)}`); }
  async getCheckpoint(id) { validateId(id); const manifest = validateManifest(await this.request(`/v1/checkpoints/${id}`)); assert(manifest.id === id, 'Server returned a different checkpoint'); return manifest; }
  async uploadBlob(hash, bytes) {
    validateBlobHash(hash);
    assert(bytes.length <= MAX_BLOB_BYTES && sha256(bytes) === hash, 'Invalid local blob');
    return this.request(`/v1/blobs/${hash}`, { method: 'PUT', bytes });
  }
  async downloadBlob(hash, size) {
    validateBlobHash(hash); assert(Number.isSafeInteger(size) && size >= 0 && size <= MAX_BLOB_BYTES, 'Invalid blob size');
    const bytes = await this.request(`/v1/blobs/${hash}`, { maxBytes: size, binary: true });
    assert(bytes.length === size && sha256(bytes) === hash, 'Downloaded blob failed integrity check'); return bytes;
  }
  async commit(manifest) {
    const result = await this.request('/v1/checkpoints', { method: 'POST', json: validateManifest(manifest) });
    assert(result?.id === manifest.id && typeof result.conflict === 'boolean' && Array.isArray(result.heads), 'Invalid commit acknowledgement');
    result.heads.forEach(validateId); return result;
  }
}
