import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256, validateId } from '../src/protocol.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDLE_MS = 30 * DAY_MS;
const MAX_ABSOLUTE_MS = 90 * DAY_MS;
const MAX_RECORDS = 100_000;
const MAX_TIME = 8_640_000_000_000_000;
// Canonical unpadded base64url for exactly 32 bytes (including the final pad bits).
const OPAQUE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const HASH = /^[a-f0-9]{64}$/;
const PASSWORD_HASH = /^[a-f0-9]{128}$/;
const FAMILY_KEYS = ['familyId', 'deviceId', 'refreshHash', 'createdAt', 'refreshExpiresAt', 'absoluteExpiresAt', 'passwordRevision'];
const TOKEN_KEYS = ['hash', 'expiresAt', 'deviceId'];
const problem = (status, message) => Object.assign(new Error(message), { status });
const unauthorized = () => problem(401, 'Unauthorized');
const corrupt = () => problem(500, 'Invalid device authentication state');
const hashSecret = value => sha256(Buffer.from(value, 'utf8'));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const timestamp = (value, minimum = 1) => Number.isSafeInteger(value) && value >= minimum && value <= MAX_TIME;
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validDeviceId(value) {
  try { validateId(value); return true; } catch { return false; }
}
function revision(auth) {
  if (!record(auth)) throw corrupt();
  const result = Object.hasOwn(auth, 'passwordRevision') ? auth.passwordRevision : 0;
  if (!Number.isSafeInteger(result) || result < 0 || !matches(HASH, auth.salt) || !matches(PASSWORD_HASH, auth.hash)) throw corrupt();
  return result;
}
function positive(value, fallback, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`Invalid ${name}`);
  return result;
}
function sameHash(left, right) {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Validate the authentication portion of a parent-owned v1/v2 storage state.
 * Returns fresh {tokens, families} arrays and records; never repairs or mutates
 * input. Missing families means [], but malformed/unknown record fields, orphan
 * tokens, duplicate credential hashes, or stale password revisions fail closed.
 * The parent validates the full auth record, version, serverId and other data.
 *
 * Family (exact fields): {familyId, deviceId, refreshHash, createdAt,
 *   refreshExpiresAt, absoluteExpiresAt, passwordRevision}.
 * Token (exact fields): {hash, expiresAt, deviceId, familyId?}.
 * All times are integer epoch milliseconds. familyId is a public opaque id, not
 * an authentication proof; only SHA-256 hashes of access/refresh secrets persist.
 */
export function validateDeviceAuthState(state) {
  if (!record(state) || !Array.isArray(state.tokens) || state.tokens.length > MAX_RECORDS) throw corrupt();
  const passwordRevision = revision(state.auth);
  const inputFamilies = Object.hasOwn(state, 'families') ? state.families : [];
  if (!Array.isArray(inputFamilies) || inputFamilies.length > MAX_RECORDS) throw corrupt();
  const byId = new Map(), hashes = new Set(), families = [], tokens = [];
  for (const family of inputFamilies) {
    if (!exact(family, FAMILY_KEYS) || !matches(OPAQUE, family.familyId) || !validDeviceId(family.deviceId) ||
        !matches(HASH, family.refreshHash) || byId.has(family.familyId) || hashes.has(family.refreshHash) ||
        !timestamp(family.createdAt, 0) || !timestamp(family.refreshExpiresAt) || !timestamp(family.absoluteExpiresAt) ||
        family.refreshExpiresAt <= family.createdAt || family.refreshExpiresAt > family.absoluteExpiresAt ||
        family.absoluteExpiresAt - family.createdAt > MAX_ABSOLUTE_MS || family.passwordRevision !== passwordRevision) throw corrupt();
    const normalized = {
      familyId: family.familyId, deviceId: family.deviceId, refreshHash: family.refreshHash,
      createdAt: family.createdAt, refreshExpiresAt: family.refreshExpiresAt,
      absoluteExpiresAt: family.absoluteExpiresAt, passwordRevision: family.passwordRevision,
    };
    byId.set(normalized.familyId, normalized); hashes.add(normalized.refreshHash); families.push(normalized);
  }
  for (const token of state.tokens) {
    const hasFamily = record(token) && Object.hasOwn(token, 'familyId');
    if (!exact(token, hasFamily ? [...TOKEN_KEYS, 'familyId'] : TOKEN_KEYS) || !matches(HASH, token.hash) ||
        hashes.has(token.hash) || !timestamp(token.expiresAt) || !validDeviceId(token.deviceId)) throw corrupt();
    const family = hasFamily ? byId.get(token.familyId) : undefined;
    if (hasFamily && (!family || token.deviceId !== family.deviceId || token.expiresAt <= family.createdAt ||
        token.expiresAt > family.refreshExpiresAt)) throw corrupt();
    hashes.add(token.hash);
    tokens.push({ hash: token.hash, expiresAt: token.expiresAt, deviceId: token.deviceId, ...(hasFamily ? { familyId: token.familyId } : {}) });
  }
  return { tokens, families };
}

function live(records, time) {
  const families = records.families.filter(family => family.refreshExpiresAt > time && family.absoluteExpiresAt > time);
  const ids = new Set(families.map(family => family.familyId));
  const tokens = records.tokens.filter(token => token.expiresAt > time && (!Object.hasOwn(token, 'familyId') || ids.has(token.familyId)));
  return { tokens, families };
}
function refreshProof(input) {
  if (!exact(input, ['deviceId', 'refreshToken', 'familyId'])) throw problem(400, 'Invalid device authentication request');
  const { deviceId, refreshToken, familyId } = input;
  if (!validDeviceId(deviceId) || !matches(OPAQUE, refreshToken) || !matches(OPAQUE, familyId)) throw unauthorized();
  return { deviceId, refreshHash: hashSecret(refreshToken), familyId };
}
function currentFamily(records, proof, time) {
  const family = records.families.find(item => item.familyId === proof.familyId);
  if (!family || family.deviceId !== proof.deviceId || family.createdAt > time || family.refreshExpiresAt <= time ||
      family.absoluteExpiresAt <= time || !sameHash(family.refreshHash, proof.refreshHash)) throw unauthorized();
  return family;
}
function tokenSnapshot(input) {
  const hasFamily = record(input) && Object.hasOwn(input, 'familyId');
  if (!exact(input, hasFamily ? [...TOKEN_KEYS, 'familyId'] : TOKEN_KEYS) || !matches(HASH, input.hash) ||
      !timestamp(input.expiresAt) || !validDeviceId(input.deviceId) || (hasFamily && !matches(OPAQUE, input.familyId))) throw unauthorized();
  return { hash: input.hash, expiresAt: input.expiresAt, deviceId: input.deviceId, ...(hasFamily ? { familyId: input.familyId } : {}) };
}
function removeFamily(records, familyId) {
  return {
    families: records.families.filter(family => family.familyId !== familyId),
    tokens: records.tokens.filter(token => token.familyId !== familyId),
  };
}

/**
 * No KDF, HTTP, timers, filesystem, or logging. The parent verifies the password
 * and username against an immutable authSnapshot before issue(). All methods
 * acquire the parent's global store.exclusive lock; do NOT call them from that
 * lock. store.save(next) must atomically persist and replace store.state only on
 * success (and must not reject after committing).
 *
 * issue({deviceId, authSnapshot}), refresh({deviceId, refreshToken, familyId})
 *   -> {token, expiresAt, refreshToken, refreshExpiresAt, familyId, absoluteExpiresAt}
 * logout({token}) -> undefined: token is the TRUSTED bearer-authenticated stored
 *   record, never user JSON. Rechecks the identical current grant under the lock;
 *   revokes its entire family or that single legacy token. A stale/rotated grant
 *   cannot authorize logout by retaining a familyId.
 * revokeFamily({deviceId, refreshToken, familyId}) -> undefined: current unexpired
 *   refresh proof can revoke a family even after its access token expires.
 *
 * Default access TTL 1d (maximum 365d), idle TTL 30d (maximum 30d), absolute TTL
 * 90d (maximum 90d); idle <= absolute. Access expiry is also capped at the family's
 * refresh expiry. maxTokens defaults to 4096 (maximum 100000), independently
 * bounding live access tokens AND refresh families, including legacy tokens.
 *
 * Password change MUST clear tokens and families in the same credential commit.
 * Rotation is one-shot: there is no replay/ACK recovery. A caller with an unknown
 * refresh result must pause and reauthenticate, never blindly replay the request.
 */
export function createDeviceAuth(options = {}) {
  if (!record(options)) throw new TypeError('Invalid device authentication options');
  const { store, now = Date.now } = options;
  if (!record(store) || typeof store.save !== 'function' || typeof store.exclusive !== 'function' || typeof now !== 'function') {
    throw new TypeError('store, save, exclusive and now are required');
  }
  const tokenTtlMs = positive(options.tokenTtlMs, DAY_MS, 365 * DAY_MS, 'tokenTtlMs');
  const refreshIdleMs = positive(options.refreshIdleMs, MAX_IDLE_MS, MAX_IDLE_MS, 'refreshIdleMs');
  const refreshAbsoluteMs = positive(options.refreshAbsoluteMs, MAX_ABSOLUTE_MS, MAX_ABSOLUTE_MS, 'refreshAbsoluteMs');
  const maxTokens = positive(options.maxTokens, 4096, MAX_RECORDS, 'maxTokens');
  if (refreshIdleMs > refreshAbsoluteMs) throw new TypeError('refreshIdleMs must not exceed refreshAbsoluteMs');
  validateDeviceAuthState(store.state);

  function clock() {
    const time = now();
    if (!timestamp(time, 0)) throw problem(500, 'Invalid authentication clock');
    return time;
  }
  function deadline(time, ttl) {
    const result = time + ttl;
    if (!timestamp(result)) throw problem(500, 'Invalid authentication deadline');
    return result;
  }
  async function commit(state, records) {
    const next = { ...state, ...records };
    validateDeviceAuthState(next);
    try { await store.save(next); }
    catch { throw problem(500, 'Device authentication storage error'); }
  }
  function grant(time, familyId, absoluteExpiresAt) {
    const refreshExpiresAt = Math.min(deadline(time, refreshIdleMs), absoluteExpiresAt);
    const expiresAt = Math.min(deadline(time, tokenTtlMs), refreshExpiresAt);
    return {
      token: randomBytes(32).toString('base64url'), expiresAt,
      refreshToken: randomBytes(32).toString('base64url'), refreshExpiresAt, familyId, absoluteExpiresAt,
    };
  }
  function access(result, deviceId) {
    return { hash: hashSecret(result.token), expiresAt: result.expiresAt, deviceId, familyId: result.familyId };
  }

  return Object.freeze({
    async issue(input) {
      if (!exact(input, ['deviceId', 'authSnapshot']) || !validDeviceId(input.deviceId)) throw problem(400, 'Invalid device authentication request');
      const deviceId = input.deviceId;
      let passwordRevision;
      try { passwordRevision = revision(input.authSnapshot); } catch { throw unauthorized(); }
      // Copy before queueing: a caller's later mutation must not update the proof.
      const { hash, salt } = input.authSnapshot;
      return store.exclusive(async () => {
        const state = store.state, records = validateDeviceAuthState(state), time = clock();
        if (passwordRevision !== revision(state.auth) || !sameHash(hash, state.auth.hash) || !sameHash(salt, state.auth.salt)) throw unauthorized();
        const active = live(records, time);
        if (active.tokens.length >= maxTokens || active.families.length >= maxTokens) throw problem(429, 'Session limit reached');
        const result = grant(time, randomBytes(32).toString('base64url'), deadline(time, refreshAbsoluteMs));
        const family = {
          familyId: result.familyId, deviceId, refreshHash: hashSecret(result.refreshToken), createdAt: time,
          refreshExpiresAt: result.refreshExpiresAt, absoluteExpiresAt: result.absoluteExpiresAt, passwordRevision,
        };
        await commit(state, { tokens: [...active.tokens, access(result, deviceId)], families: [...active.families, family] });
        return result;
      });
    },
    async refresh(input) {
      const proof = refreshProof(input);
      return store.exclusive(async () => {
        const state = store.state, records = validateDeviceAuthState(state), time = clock();
        const family = currentFamily(records, proof, time);
        const active = live(records, time);
        const tokens = active.tokens.filter(token => token.familyId !== family.familyId);
        if (tokens.length >= maxTokens || active.families.length > maxTokens) throw problem(429, 'Session limit reached');
        const result = grant(time, family.familyId, family.absoluteExpiresAt);
        const replacement = { ...family, refreshHash: hashSecret(result.refreshToken), refreshExpiresAt: result.refreshExpiresAt };
        await commit(state, {
          tokens: [...tokens, access(result, family.deviceId)],
          families: active.families.map(item => item.familyId === family.familyId ? replacement : item),
        });
        return result;
      });
    },
    async logout(input) {
      if (!exact(input, ['token'])) throw unauthorized();
      const proof = tokenSnapshot(input.token);
      return store.exclusive(async () => {
        const state = store.state, records = validateDeviceAuthState(state), time = clock();
        const token = records.tokens.find(item => sameHash(item.hash, proof.hash));
        if (!token || token.expiresAt <= time || token.deviceId !== proof.deviceId || token.expiresAt !== proof.expiresAt ||
            token.familyId !== proof.familyId) throw unauthorized();
        const family = token.familyId === undefined ? undefined : records.families.find(item => item.familyId === token.familyId);
        if (family && (family.createdAt > time || family.refreshExpiresAt <= time || family.absoluteExpiresAt <= time)) throw unauthorized();
        const active = live(records, time);
        await commit(state, family ? removeFamily(active, family.familyId) : { ...active, tokens: active.tokens.filter(item => item.hash !== token.hash) });
      });
    },
    async revokeFamily(input) {
      const proof = refreshProof(input);
      return store.exclusive(async () => {
        const state = store.state, records = validateDeviceAuthState(state), time = clock();
        const family = currentFamily(records, proof, time);
        await commit(state, removeFamily(live(records, time), family.familyId));
      });
    },
  });
}
