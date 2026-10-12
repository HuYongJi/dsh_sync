import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, validateId, validateBlobHash, validateRelativePath, validateManifest, MAX_BLOB_BYTES, MAX_MANIFEST_BYTES, MAX_CHECKPOINT_BYTES } from '../src/protocol.mjs';
import { canonicalJson, validateSyncManifest, MAX_SYNC_ENTRIES } from '../src/sync-protocol.mjs';
import { syncRootIdentity, verifySyncRoot, readSyncFile } from '../src/sync-local.mjs';
import { assertNoSymlinks, readStableFile, writeNewFile, atomicWrite } from '../src/files.mjs';
import { validateServerUrl } from '../src/client.mjs';
import * as nativeAdapter from './dsh-adapter.mjs';

export const SESSION_ARCHIVE_FORMAT = 'dsh-personal-sync/session-archive';
export const SESSION_ARCHIVE_VERSION = 1;
export const DEFAULT_ARCHIVE_BYTES = 256 * 1024 * 1024;
const PLAN_TTL = 15 * 60_000;
const fail = code => Object.assign(new Error(code), { code });
const requireValue = (condition, code = 'SYNC_INTEGRITY') => { if (!condition) throw fail(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, optional = []) => object(value) && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const assetId = hash => `asset-${validateBlobHash(hash)}`;
const sessionId = hash => `session-${validateBlobHash(hash)}`;
const fingerprint = envelope => sha256(canonicalJson(envelope));
function sameSourceRoot(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const api = value => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix;
  if (api(a) !== api(b) || !api(a).isAbsolute(a) || !api(b).isAbsolute(b)) return false;
  const normalize = value => { const normalized = api(value).normalize(value).replace(/[\\/]+$/, ''); return api(value) === path.win32 ? normalized.toLowerCase() : normalized; };
  return normalize(a) === normalize(b);
}
const importsInFlight = new Map();
async function locked(name, action) {
  name = key(name);
  const before = importsInFlight.get(name) ?? Promise.resolve();
  let release; const mine = new Promise(resolve => { release = resolve; });
  importsInFlight.set(name, mine);
  await before;
  try { return await action(); }
  finally { release(); if (importsInFlight.get(name) === mine) importsInFlight.delete(name); }
}
async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function readJson(filename, max = MAX_MANIFEST_BYTES) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readStableFile(filename, max)).bytes)); }
function identityOf(value) {
  requireValue(exact(value, ['server', 'serverId', 'username', 'deviceId', 'authorizationEpoch']), 'ACCOUNT_MISMATCH');
  requireValue(typeof value.username === 'string' && value.username.length > 0 && Buffer.byteLength(value.username) <= 128 && !/[\x00-\x1f\x7f]/.test(value.username) && Number.isSafeInteger(value.authorizationEpoch) && value.authorizationEpoch >= 0, 'ACCOUNT_MISMATCH');
  return { server: validateServerUrl(value.server), serverId: validateId(value.serverId), username: value.username, deviceId: validateId(value.deviceId), authorizationEpoch: value.authorizationEpoch };
}
function stableIdentity(value) { const { authorizationEpoch: _epoch, ...stable } = identityOf(value); return stable; }
function validateFiles(files) {
  // Reuse the actual v2 portable-path, collision and aggregate schema.
  return validateSyncManifest({ version: 2, id: 'archive-files', projectId: 'archive-project', deviceId: 'archive-device', parentId: null, policyRevision: 0, files, tombstones: [], conflicts: [], archiveRefs: [] }).files;
}
function validateRef(value) {
  requireValue(exact(value, ['id', 'hash', 'size'])); validateBlobHash(value.hash);
  requireValue(value.id === assetId(value.hash) && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_BLOB_BYTES);
  return { id: value.id, hash: value.hash, size: value.size };
}
function validateWrapper(value, projectId) {
  requireValue(exact(value, ['format', 'version', 'projectId', 'origin', 'native', 'assets', 'files'], ['lineage']) && value.format === SESSION_ARCHIVE_FORMAT && value.version === SESSION_ARCHIVE_VERSION && value.projectId === projectId);
  validateId(projectId);
  const origin = value.origin, envelope = value.native;
  requireValue(exact(origin, ['deviceId', 'sessionId', 'sourceRoot'])); validateId(origin.deviceId); validateId(origin.sessionId);
  requireValue(typeof origin.sourceRoot === 'string' && origin.sourceRoot.length <= 4096 && !/[\x00-\x1f\x7f]/.test(origin.sourceRoot) && (path.win32.isAbsolute(origin.sourceRoot) || path.posix.isAbsolute(origin.sourceRoot)));
  requireValue(exact(envelope, ['format', 'version', 'sessionFormatVersion', 'sessionId', 'sourceRoot', 'header', 'events', 'inheritedEventCount', 'attachments', 'deliverables']) && envelope.format === nativeAdapter.SESSION_ENVELOPE_FORMAT && envelope.version === 1 && envelope.sessionFormatVersion === 4 && envelope.sessionId === origin.sessionId && envelope.sourceRoot === origin.sourceRoot && envelope.header?.id === origin.sessionId && sameSourceRoot(envelope.header?.cwd, origin.sourceRoot));
  requireValue(Array.isArray(envelope.events) && envelope.events.length <= 100_000 && Array.isArray(envelope.attachments) && envelope.attachments.length <= 2_000 && Array.isArray(envelope.deliverables) && envelope.deliverables.length <= MAX_SYNC_ENTRIES);
  requireValue(Number.isSafeInteger(envelope.inheritedEventCount) && envelope.inheritedEventCount >= 0 && envelope.inheritedEventCount <= envelope.events.length);
  requireValue(Array.isArray(value.assets) && value.assets.length <= 2_000);
  const assets = value.assets.map(validateRef), assetMap = new Map(assets.map(item => [item.hash, item]));
  requireValue(assetMap.size === assets.length);
  const used = new Set();
  for (const item of envelope.attachments) {
    requireValue(exact(item, ['kind', 'ref', 'sha256']) && ['image', 'file'].includes(item.kind) && object(item.ref));
    validateBlobHash(item.sha256);
    requireValue(item.ref.attachmentId === `sha256:${item.sha256}` && assetMap.get(item.sha256)?.size === item.ref.bytes);
    used.add(item.sha256);
  }
  requireValue(used.size === assets.length);
  const files = validateFiles(value.files), paths = new Set();
  for (const item of envelope.deliverables) {
    requireValue(exact(item, ['eventSeq', 'index', item.external === true ? 'external' : 'relativePath']) && Number.isSafeInteger(item.eventSeq) && item.eventSeq >= 0 && item.eventSeq < envelope.events.length && Number.isSafeInteger(item.index) && item.index >= 0);
    if (item.external !== true) paths.add(validateRelativePath(item.relativePath));
  }
  // Missing/unknown/external deliverables may be archived, never inferred safe to import.
  requireValue(files.every(file => paths.has(file.path)));
  if (value.lineage !== undefined) requireValue(exact(value.lineage, ['archiveId']) && /^session-[a-f0-9]{64}$/.test(value.lineage.archiveId));
  return { ...value, assets, files };
}
function closure(wrapper, manifest) {
  const refs = new Map(manifest.archiveRefs.map(item => [item.id, item]));
  for (const item of [...wrapper.assets, ...wrapper.files.map(file => ({ id: assetId(file.hash), hash: file.hash, size: file.size }))]) requireValue(equal(refs.get(item.id) ?? null, item));
}
function importKeyOf(wrapper) { return sha256(canonicalJson({ projectId: wrapper.projectId, origin: wrapper.origin, contentHash: fingerprint(wrapper.native) })); }
function warningForNative(error) {
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code) || /^(?:session persistence provider unavailable|unsupported installed session format)$/.test(error?.adapterReason ?? '')) return 'SYNC_ARCHIVES_UNSUPPORTED';
  return undefined;
}
function idleSkip(reason) { return /^(?:active |busy:|pending |incomplete(?::| ))/.test(reason); }
function nativeSummary(result) {
  // Adapter reason strings can contain plugin event names. Never expose native log text.
  return { imported: result.imported.map(item => ({ sourceId: item.sourceId, sessionId: item.sessionId, workspaceAttached: item.workspaceAttached === true, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}) })),
    skipped: result.skipped.map(item => ({ id: item.id, code: 'SYNC_ARCHIVES_UNSUPPORTED' })),
    failed: result.failed.map(item => ({ id: item.id, ...(item.sessionId ? { sessionId: item.sessionId } : {}), mayHaveDurableSession: true, code: 'SYNC_IMPORT_UNCERTAIN' })), mapping: { ...result.mapping } };
}

/** Host-only archive lane. stateDir MUST be profile-isolated and excluded from
 * project scans. Automatic capture never calls import. Plans are opaque object
 * capabilities; serializing one to a browser does not convey import authority.
 * Native archived domains are deliberately broader than the explicit import subset.
 */
export function createSessionSync({ ctx, stateDir, identity, getIdentity, adapter = nativeAdapter, maxArchiveBytes = DEFAULT_ARCHIVE_BYTES, maxCacheBytes = 2 * DEFAULT_ARCHIVE_BYTES, now = Date.now, planTtlMs = PLAN_TTL, newSessionId = () => `session-${randomUUID()}`, beforeCacheWrite = async () => {} } = {}) {
  requireValue(typeof stateDir === 'string' && path.isAbsolute(stateDir) && typeof beforeCacheWrite === 'function', 'BAD_REQUEST');
  requireValue(Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0 && maxArchiveBytes <= MAX_CHECKPOINT_BYTES && Number.isSafeInteger(maxCacheBytes) && maxCacheBytes > 0 && Number.isSafeInteger(planTtlMs) && planTtlMs > 0, 'BAD_REQUEST');
  const home = path.join(path.resolve(stateDir), 'session-sync'), plans = new WeakMap();
  const currentIdentity = async () => { const value = getIdentity ? await getIdentity() : identity; return value === undefined ? undefined : identityOf(value); };
  async function scopeFor(root, projectId, value) {
    validateId(projectId); value = identityOf(value);
    requireValue(!within(key(home), key(root)) && !within(key(root), key(home)), 'SYNC_METADATA_UNSAFE');
    const rootIdentity = await syncRootIdentity(await fs.realpath(await assertNoSymlinks(path.resolve(root)))), account = sha256(canonicalJson(stableIdentity(value)));
    const scope = sha256(canonicalJson({ account, projectId, rootIdentity: { ...rootIdentity, root: key(rootIdentity.root) } }));
    return { root: rootIdentity.root, rootIdentity, projectId, identity: value, account, scope, directory: path.join(home, account, scope) };
  }
  function guardFor(scope, check = async () => {}, signal) {
    const guard = async () => {
      signal?.throwIfAborted(); await check(); signal?.throwIfAborted();
      if (scope) await verifySyncRoot(scope.rootIdentity);
    };
    return Object.assign(guard, { signal });
  }
  function validateLedger(value, scope, name) {
    requireValue(exact(value, ['version', 'scope', 'importKey', 'archiveId', 'wrapperDigest', 'sourceId', 'sessionId', 'state', 'localFingerprint', 'workspaceAttached']) && value.version === 1 && value.scope === scope.scope && value.importKey === name && ['reserved', 'imported', 'uncertain'].includes(value.state) && typeof value.workspaceAttached === 'boolean', 'SYNC_JOURNAL_CORRUPT');
    validateBlobHash(value.importKey); validateBlobHash(value.wrapperDigest); validateId(value.sourceId); validateId(value.sessionId);
    requireValue(value.archiveId === sessionId(value.wrapperDigest) && value.sourceId !== value.sessionId && (value.localFingerprint === null || /^[a-f0-9]{64}$/.test(value.localFingerprint)), 'SYNC_JOURNAL_CORRUPT');
    return value;
  }
  const ledgerPath = (scope, name) => path.join(scope.directory, 'imports', `${validateBlobHash(name)}.json`);
  async function loadLedger(scope, name) {
    try { return validateLedger(await readJson(ledgerPath(scope, name), 16_384), scope, name); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function ledgerRows(scope) {
    const directory = path.join(scope.directory, 'imports');
    if (!(await exists(directory))) return [];
    await assertNoSymlinks(directory); const names = await fs.readdir(directory);
    requireValue(names.length <= MAX_SYNC_ENTRIES, 'SYNC_QUOTA'); const rows = [];
    for (const name of names) { if (/^[a-f0-9]{64}\.json$/.test(name)) rows.push(await loadLedger(scope, name.slice(0, -5))); }
    return rows;
  }
  async function saveLedger(scope, value) { validateLedger(value, scope, value.importKey); await atomicWrite(ledgerPath(scope, value.importKey), canonicalJson(value)); }
  async function cacheUsage(directory = home, count = { value: 0 }, guard = async () => {}) {
    if (!(await exists(directory))) return 0;
    await assertNoSymlinks(directory); let bytes = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      await guard(); requireValue(++count.value <= 100_000, 'SYNC_QUOTA');
      const filename = path.join(directory, entry.name); await assertNoSymlinks(filename); const stat = await fs.lstat(filename);
      if (stat.isDirectory()) bytes += await cacheUsage(filename, count, guard);
      else { requireValue(stat.isFile() && stat.nlink === 1, 'SYNC_METADATA_UNSAFE'); bytes += stat.size; }
      requireValue(bytes <= maxCacheBytes, 'SYNC_QUOTA');
    }
    return bytes;
  }
  async function cachedWrite(filename, bytes, guard) {
    await guard();
    if (await exists(filename)) { requireValue((await readStableFile(filename)).bytes.equals(bytes)); return; }
    await locked(home, async () => {
      await guard();
      if (await exists(filename)) { requireValue((await readStableFile(filename)).bytes.equals(bytes)); return; }
      requireValue(await cacheUsage(home, { value: 0 }, guard) + bytes.length <= maxCacheBytes, 'SYNC_QUOTA');
      await beforeCacheWrite({ bytes: bytes.length, check: guard, signal: guard.signal }); await guard();
      await writeNewFile(filename, bytes);
    });
  }
  async function download(client, ref, guard) {
    await guard(); requireValue(typeof client?.downloadBlob === 'function', 'BAD_REQUEST');
    const bytes = await client.downloadBlob(ref.hash, ref.size); await guard();
    requireValue(Buffer.isBuffer(bytes) && bytes.length === ref.size && sha256(bytes) === ref.hash); return bytes;
  }
  function pinned(manifest, projectId) { const value = validateSyncManifest(manifest); requireValue(value.projectId === projectId); return value; }
  async function readWrapper(manifest, archiveId, client, guard) {
    const ref = manifest.archiveRefs.find(item => item.id === archiveId);
    requireValue(ref && ref.id === sessionId(ref.hash));
    requireValue(ref.size <= maxArchiveBytes, 'SYNC_QUOTA');
    const bytes = await download(client, ref, guard);
    let wrapper;
    try { wrapper = validateWrapper(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), manifest.projectId); }
    catch { throw fail('SYNC_INTEGRITY'); }
    requireValue(bytes.equals(Buffer.from(canonicalJson(wrapper)))); closure(wrapper, manifest);
    const distinct = new Map([[ref.hash, ref], ...wrapper.assets.map(item => [item.hash, item]), ...wrapper.files.map(item => [item.hash, item])]);
    requireValue([...distinct.values()].reduce((sum, item) => sum + item.size, 0) <= maxArchiveBytes, 'SYNC_QUOTA');
    return { ref, bytes, wrapper };
  }
  async function deliverables(scope, wrapper, manifest, guard) {
    const files = new Map(wrapper.files.map(file => [file.path, file])), current = new Map(manifest.files.map(file => [file.path, file]));
    for (const item of wrapper.native.deliverables) {
      requireValue(item.external !== true && files.has(item.relativePath), 'SYNC_LOCAL_CHANGED');
      const file = files.get(item.relativePath); requireValue(equal(current.get(file.path) ?? null, file), 'SYNC_LOCAL_CHANGED');
      await guard();
      requireValue(equal(await readSyncFile(scope.root, file.path, file), { hash: file.hash, size: file.size, executable: file.executable }), 'SYNC_LOCAL_CHANGED');
    }
    await guard();
  }
  const ledgerResult = (row, duplicate = false) => ({ state: row.state === 'imported' ? 'imported' : 'uncertain', archiveId: row.archiveId, sessionIds: [row.sessionId], mapping: { [row.sourceId]: row.sessionId }, duplicate,
    ...(row.state === 'imported' ? { imported: [{ sourceId: row.sourceId, sessionId: row.sessionId, workspaceAttached: row.workspaceAttached }], skipped: [], failed: [] } : { imported: [], skipped: [], failed: [{ id: row.sourceId, sessionId: row.sessionId, mayHaveDurableSession: true, code: 'SYNC_IMPORT_UNCERTAIN' }] }) });

  async function captureArchives({ root, projectId, deviceId, files, putBlob, check = async () => {}, signal }) {
    validateId(projectId); validateId(deviceId); requireValue(typeof putBlob === 'function', 'BAD_REQUEST');
    const pinnedFiles = new Map(validateFiles(files).map(file => [file.path, file]));
    const rootIdentity = await syncRootIdentity(await fs.realpath(await assertNoSymlinks(path.resolve(root)))), guard = guardFor({ rootIdentity }, check, signal);
    await guard();
    // Legacy/core file sync supports a literally excluded state directory inside
    // the selected project. Do not broaden cache write authority or disable that
    // file lane merely because this optional archive cache cannot live there.
    if (within(key(home), key(rootIdentity.root)) || within(key(rootIdentity.root), key(home))) return { archiveRefs: [], skippedCount: 1, warningCode: 'SYNC_ARCHIVES_UNSUPPORTED' };
    const account = await currentIdentity();
    if (account) requireValue(account.deviceId === deviceId, 'ACCOUNT_MISMATCH');
    const scope = account ? await scopeFor(root, projectId, account) : null;
    const imported = scope ? await ledgerRows(scope) : [], staged = new Map(), refs = new Map();
    let byteCount = 0, sessionCount = 0;
    async function stage(bytes, hash = sha256(bytes)) {
      await guard(); requireValue(Buffer.isBuffer(bytes) && sha256(bytes) === hash); requireValue(bytes.length <= MAX_BLOB_BYTES, 'SYNC_QUOTA');
      const old = staged.get(hash); requireValue(!old || old.size === bytes.length);
      if (!old) {
        byteCount += bytes.length; requireValue(byteCount <= maxArchiveBytes && staged.size < MAX_SYNC_ENTRIES, 'SYNC_QUOTA');
        await putBlob(hash, bytes); await guard(); staged.set(hash, { hash, size: bytes.length });
      }
      return { id: assetId(hash), hash, size: bytes.length };
    }
    let exported;
    try {
      exported = await adapter.exportProjectSessions(ctx, rootIdentity.root, { signal, check: guard, maxBytes: maxArchiveBytes,
        onAsset: async (bytes, ref) => { requireValue(ref.hash === sha256(bytes) && ref.size === bytes.length); await stage(bytes, ref.hash); },
        onSession: async ({ id, data }) => {
          sessionCount++; validateId(id); requireValue(data.sessionId === id && sameSourceRoot(data.sourceRoot, rootIdentity.root));
          const localHash = fingerprint(data), previous = imported.find(row => row.sessionId === id && row.state === 'imported');
          if (previous?.localFingerprint === localHash) return;
          const assets = [...new Map(data.attachments.map(item => { const ref = staged.get(item.sha256); requireValue(ref && ref.size === item.ref.bytes); return [item.sha256, { id: assetId(item.sha256), ...ref }]; })).values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
          const snapshots = [];
          for (const name of new Set(data.deliverables.filter(item => item.external !== true).map(item => item.relativePath))) {
            const file = pinnedFiles.get(name); if (!file) continue;
            await guard(); const { bytes } = await readStableFile(path.join(rootIdentity.root, ...file.path.split('/')));
            requireValue(bytes.length === file.size && sha256(bytes) === file.hash, 'SYNC_LOCAL_CHANGED');
            await stage(bytes, file.hash); snapshots.push(file);
          }
          const wrapper = validateWrapper({ format: SESSION_ARCHIVE_FORMAT, version: SESSION_ARCHIVE_VERSION, projectId, origin: { deviceId, sessionId: id, sourceRoot: data.sourceRoot }, native: data, assets, files: snapshots,
            ...(previous ? { lineage: { archiveId: previous.archiveId } } : {}) }, projectId);
          const bytes = Buffer.from(canonicalJson(wrapper)), hash = sha256(bytes); await stage(bytes, hash);
          for (const ref of [...assets, ...snapshots.map(file => ({ id: assetId(file.hash), hash: file.hash, size: file.size }))]) refs.set(ref.id, ref);
          refs.set(sessionId(hash), { id: sessionId(hash), hash, size: bytes.length });
        } });
      requireValue(exported && typeof exported.verifyUnchanged === 'function' && Array.isArray(exported.skipped) && Array.isArray(exported.sessions) && exported.sessions.length === 0 && Array.isArray(exported.assets) && exported.assets.length === 0);
      for (const item of exported.skipped) {
        if (/(?:safety limit|blob size limit)$/.test(item.reason)) throw fail('SYNC_QUOTA');
        if (!idleSkip(item.reason) && !/provider unavailable$/.test(item.reason)) throw fail('SYNC_INTEGRITY');
      }
      await exported.verifyUnchanged(); await guard();
    } catch (error) {
      await guard(); // An admission/cancellation error is never downgraded to a warning.
      if (/(?:safety limit|blob size limit)$/.test(error?.adapterReason ?? '')) throw fail('SYNC_QUOTA');
      const warningCode = warningForNative(error);
      if (warningCode || error?.adapterReason && idleSkip(error.adapterReason)) return { archiveRefs: [], skippedCount: Math.max(1, sessionCount + (exported?.skipped?.length ?? 0)), warningCode: warningCode ?? 'SYNC_ARCHIVES_SKIPPED' };
      throw error;
    }
    return { archiveRefs: [...refs.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')), ...(exported.skipped.length ? { skippedCount: exported.skipped.length, warningCode: 'SYNC_ARCHIVES_SKIPPED' } : {}) };
  }

  async function listArchives(binding, options = {}) {
    const { client, check, signal } = options, value = options.identity ?? binding.identity ?? await currentIdentity();
    const scope = await scopeFor(binding.root, binding.projectId, value), guard = guardFor(scope, check, signal); await guard();
    let manifest = options.manifest;
    if (!manifest) { const head = await client.syncHead(binding.projectId); await guard(); if (!head) return { archives: [], counts: { archives: 0, assets: 0, imported: 0, uncertain: 0, unchecked: 0 } }; manifest = await client.syncCheckpoint(binding.projectId, head.id, head.manifestDigest); }
    manifest = pinned(manifest, binding.projectId);
    const archives = [];
    let budget = 0;
    for (const ref of manifest.archiveRefs.filter(item => item.id.startsWith('session-'))) {
      await guard(); budget += ref.size; requireValue(budget <= maxArchiveBytes, 'SYNC_QUOTA');
      const { wrapper } = await readWrapper(manifest, ref.id, client, guard), row = await loadLedger(scope, importKeyOf(wrapper));
      archives.push({ archiveId: ref.id, label: `Session ${wrapper.origin.sessionId}`, sourceSessionId: wrapper.origin.sessionId, sourceSessionIds: [wrapper.origin.sessionId], state: row ? row.state === 'imported' ? 'imported' : 'uncertain' : 'available', eligibility: row ? row.state === 'imported' ? 'imported' : 'uncertain' : 'unchecked',
        counts: { sessions: 1, events: wrapper.native.events.length, assets: wrapper.assets.length, files: wrapper.files.length }, ...(row ? { sessionIds: [row.sessionId] } : {}) });
    }
    await guard();
    return { archives, counts: { archives: archives.length, assets: manifest.archiveRefs.filter(item => item.id.startsWith('asset-')).length, ...Object.fromEntries(['imported', 'uncertain', 'unchecked'].map(state => [state, archives.filter(item => item.eligibility === state).length])) } };
  }

  async function prepareImport({ root, projectId, archiveId, manifest, client, identity: value, check, signal }) {
    validateId(archiveId); const scope = await scopeFor(root, projectId, value), guard = guardFor(scope, check, signal); await guard();
    manifest = pinned(manifest, projectId);
    const { ref, bytes, wrapper } = await readWrapper(manifest, archiveId, client, guard);
    const importKey = importKeyOf(wrapper), prior = await loadLedger(scope, importKey);
    // A prior completed/uncertain import remains queryable even after the user edits deliverables.
    if (!prior) await deliverables(scope, wrapper, manifest, guard);
    const directory = path.join(scope.directory, 'cache', ref.hash);
    await cachedWrite(path.join(directory, 'wrapper.json'), bytes, guard);
    const envelopeBytes = Buffer.from(canonicalJson(wrapper.native));
    await cachedWrite(path.join(directory, 'sessions', `${wrapper.origin.sessionId}.json`), envelopeBytes, guard);
    for (const asset of wrapper.assets) await cachedWrite(path.join(directory, 'assets', asset.hash), await download(client, asset, guard), guard);
    const legacyManifest = validateManifest({ version: 1, id: ref.id, projectId, deviceId: wrapper.origin.deviceId, parentId: null, createdAt: '1970-01-01T00:00:00.000Z', sourceRoot: wrapper.origin.sourceRoot, sessionIds: [wrapper.origin.sessionId],
      files: [{ path: `sessions/${wrapper.origin.sessionId}.json`, sha256: sha256(envelopeBytes), size: envelopeBytes.length }, ...wrapper.assets.map(item => ({ path: `assets/${item.hash}`, sha256: item.hash, size: item.size })), ...wrapper.files.map(item => ({ path: `project/${item.path}`, sha256: item.hash, size: item.size, executable: item.executable }))] });
    await guard();
    const plan = Object.freeze({ planId: randomUUID(), archiveId, wrapperDigest: ref.hash, root: scope.root, projectId, eligibility: prior ? prior.state === 'imported' ? 'imported' : 'uncertain' : 'unchecked', counts: Object.freeze({ sessions: 1, events: wrapper.native.events.length, assets: wrapper.assets.length, archivedFiles: wrapper.files.length, rootFiles: manifest.files.length }) });
    plans.set(plan, { scope, ref, wrapper, manifest, legacyManifest, directory, importKey, until: now() + planTtlMs }); return plan;
  }

  async function importArchive({ plan, requestId, identity: value, check, signal }) {
    validateId(requestId); value = identityOf(value);
    const prepared = plans.get(plan);
    requireValue(prepared && prepared.until > now(), 'SYNC_PLAN_EXPIRED');
    requireValue(equal(prepared.scope.identity, value), 'ACCOUNT_MISMATCH');
    const { scope, ref, wrapper, manifest, legacyManifest, directory, importKey } = prepared;
    const guard = guardFor(scope, check, signal); await guard();
    return locked(ledgerPath(scope, importKey), async () => {
      await guard();
      const requestPath = path.join(scope.directory, 'requests', `${sha256(requestId)}.json`);
      const request = { version: 1, scope: scope.scope, requestId, importKey, archiveId: ref.id, wrapperDigest: ref.hash };
      if (await exists(requestPath)) requireValue(equal(await readJson(requestPath, 16_384), request), 'SYNC_PLAN_CHANGED');
      else {
        const requestDirectory = path.dirname(requestPath);
        if (await exists(requestDirectory)) { await assertNoSymlinks(requestDirectory); requireValue((await fs.readdir(requestDirectory)).length < MAX_SYNC_ENTRIES, 'SYNC_QUOTA'); }
        await guard();
        try { await writeNewFile(requestPath, canonicalJson(request)); }
        catch (error) { if (error.code !== 'EEXIST') throw error; requireValue(equal(await readJson(requestPath, 16_384), request), 'SYNC_PLAN_CHANGED'); }
      }
      const prior = await loadLedger(scope, importKey); if (prior) return ledgerResult(prior, true);
      const cached = (await readStableFile(path.join(directory, 'wrapper.json'))).bytes;
      requireValue(cached.length === ref.size && sha256(cached) === ref.hash && cached.equals(Buffer.from(canonicalJson(wrapper))));
      closure(wrapper, manifest); await deliverables(scope, wrapper, manifest, guard);
      for (const file of legacyManifest.files.filter(item => !item.path.startsWith('project/'))) {
        await guard(); const bytes = (await readStableFile(path.join(directory, ...file.path.split('/')))).bytes;
        requireValue(bytes.length === file.size && sha256(bytes) === file.sha256);
      }
      const archiveDirectory = await nativeAdapter.authorizeSessionArchiveDirectory({ directory, stateDir });
      let reserved, result;
      const reserve = async oldId => {
        await guard(); requireValue(oldId === wrapper.origin.sessionId);
        requireValue((await ledgerRows(scope)).length < MAX_SYNC_ENTRIES, 'SYNC_QUOTA');
        const id = validateId(newSessionId()); requireValue(id !== oldId, 'SYNC_INTEGRITY');
        reserved = { version: 1, scope: scope.scope, importKey, archiveId: ref.id, wrapperDigest: ref.hash, sourceId: oldId, sessionId: id, state: 'reserved', localFingerprint: null, workspaceAttached: false };
        // Exclusive, fsynced reservation BEFORE attachments or provider.create. A
        // crashed/foreign writer leaves an uncertain ID, never an automatic retry.
        try { await writeNewFile(ledgerPath(scope, importKey), canonicalJson(reserved)); }
        catch (error) { reserved = undefined; if (error.code === 'EEXIST') throw fail('SYNC_IMPORT_UNCERTAIN'); throw error; }
        await guard(); return id;
      };
      const settle = async outcome => {
        if (!reserved) return;
        const imported = outcome.imported.find(item => item.sessionId === reserved.sessionId);
        reserved.state = imported && outcome.failed.length === 0 ? 'imported' : 'uncertain';
        reserved.workspaceAttached = imported?.workspaceAttached === true;
        // Do not let logout/cancellation erase a provider result. Only plugin-owned
        // ledger writes occur here; no new native/project operation is authorized.
        await saveLedger(scope, reserved);
      };
      try {
        result = await adapter.importProjectSessions(ctx, { root: scope.root, manifest: legacyManifest, archiveDirectory, allocateSessionId: reserve, onResult: settle, check: guard, signal });
        await settle(result);
      } catch (error) {
        if (!reserved) { const raced = await loadLedger(scope, importKey); if (raced) return ledgerResult(raced, true); throw error; }
        // An exception from any native callback after reservation has unknown effects.
        if (reserved.state !== 'imported') reserved.state = 'uncertain';
        await saveLedger(scope, reserved); return ledgerResult(reserved);
      }
      if (!reserved) { await guard(); const raced = await loadLedger(scope, importKey); if (raced) return ledgerResult(raced, true); return { state: 'skipped', archiveId: ref.id, sessionIds: [], ...nativeSummary(result) }; }
      if (reserved.state === 'imported') {
        try {
          let actual;
          const observation = await adapter.exportProjectSessions(ctx, scope.root, { sessionIds: [reserved.sessionId], check: guard, signal, maxBytes: maxArchiveBytes, onAsset: async () => {}, onSession: async item => { requireValue(item.id === reserved.sessionId); actual = item.data; } });
          requireValue(actual && observation.skipped.length === 0); await observation.verifyUnchanged(); await guard();
          const expectedEvents = structuredClone(wrapper.native.events);
          for (const item of wrapper.native.deliverables) expectedEvents[item.eventSeq].data.files[item.index].path = path.join(scope.root, ...item.relativePath.split('/'));
          requireValue(equal(actual.events, expectedEvents) && actual.inheritedEventCount === wrapper.native.inheritedEventCount && equal(actual.header, { version: 4, id: reserved.sessionId, createdAt: actual.header.createdAt, cwd: scope.root, isSeeded: wrapper.native.header.isSeeded, delegationDepth: 0 }));
          reserved.localFingerprint = fingerprint(actual); await saveLedger(scope, reserved);
        } catch {
          // Import is already durable; absence of a verified fingerprint must NEVER
          // suppress a genuinely continued log, nor cause replay of this import.
        }
      }
      return { ...ledgerResult(reserved), ...(reserved.state === 'imported' && reserved.localFingerprint === null ? { warningCode: 'SYNC_ARCHIVES_SKIPPED' } : {}) };
    });
  }
  async function lookupImport({ root, projectId, archiveId, identity: value, check, signal }) {
    validateId(archiveId);
    const scope = await scopeFor(root, projectId, value), guard = guardFor(scope, check, signal); await guard();
    const row = (await ledgerRows(scope)).find(item => item.archiveId === archiveId); await guard();
    return row ? ledgerResult(row, true) : null;
  }
  return Object.freeze({ captureArchives, listArchives, prepareImport, importArchive, lookupImport });
}
