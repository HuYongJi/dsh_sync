import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from './local-store.mjs';
import { atomicWrite, assertNoSymlinks, readStableFile, writeNewFile } from './files.mjs';
import { assert, sha256, validateId, validateBlobHash, validateRelativePath, MAX_MANIFEST_BYTES } from './protocol.mjs';
import { validateServerUrl } from './client.mjs';
import { readExclusionPolicy, createExclusionPolicy } from './snapshot.mjs';
import { canonicalJson, validateSyncManifest, syncManifestDigest, validateFileState, validateSyncPath, fileStateEqual, referencedBlobs, MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES, MAX_SYNC_ENTRIES } from './sync-protocol.mjs';
import { reconcileSync } from './reconcile.mjs';
import { scanSyncProject, syncRootIdentity, verifySyncRoot, readSyncFile, createSyncApplier, DEFAULT_SYNC_QUOTA } from './sync-local.mjs';

const VERSION = 1, MAX_STATE_BYTES = MAX_MANIFEST_BYTES * 6;
const fail = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = fileStateEqual;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const stateOf = file => file ? { hash: file.hash, size: file.size, executable: file.executable } : null;
const now = () => new Date().toISOString();
const phases = new Set(['prepared', 'committing', 'commit-uncertain', 'remote-accepted', 'applying', 'local-partial', 'policy-retired']);
const archiveWarnings = new Set(['SYNC_ARCHIVES_UNSUPPORTED', 'SYNC_ARCHIVES_SKIPPED']);
const noArchives = async () => ({ archiveRefs: [] });
const safeCodes = new Set(['NOT_LOGGED_IN', 'ACCOUNT_MISMATCH', 'PROJECT_UNAVAILABLE', 'CONFIG_CONFLICT', 'SETTINGS_CORRUPT', 'DISPOSED', 'BUSY', 'RATE_LIMITED', 'SERVER_UNAVAILABLE', 'SYNC_PROJECT_CORRUPT', 'SYNC_HEAD_MISMATCH', 'SYNC_MIGRATION_REQUIRED', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_ROOT_CHANGED', 'SYNC_POLICY_CHANGED', 'SYNC_LOCAL_CHANGED', 'SYNC_QUOTA', 'SYNC_INTEGRITY', 'SYNC_METADATA_UNSAFE', 'SYNC_VOLUME_CHANGED', 'SYNC_NOT_IDLE', 'SYNC_BINDING_MISMATCH', 'SYNC_JOURNAL_CORRUPT', 'SYNC_CAS_RETRY_LIMIT', 'SYNC_STRUCTURAL_CONFLICT', 'SYNC_UNTRACKED_DELETE', 'SYNC_REMOTE_BLOB_MISSING', 'SYNC_APPLY_INCOMPLETE', 'SYNC_CONFLICT_CHANGED', 'SYNC_CANCELLED', 'SYNC_REPLAN_REQUIRED', 'SYNC_REQUEST_CONFLICT', 'SYNC_REPAIR_UNAVAILABLE', 'SYNC_REPAIR_CHANGED', 'SYNC_REPAIR_EXPIRED', 'SYNC_REPAIR_INCOMPLETE', 'SYNC_COMMIT_UNCERTAIN']);
function safeCode(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'SYNC_CANCELLED';
  if (error?.code === 'ENOSPC') return 'SYNC_QUOTA';
  if (['EACCES', 'EPERM', 'EIO'].includes(error?.code)) return 'SYNC_METADATA_UNSAFE';
  return safeCodes.has(error?.code) ? error.code : error?.httpStatus === 401 ? 'NOT_LOGGED_IN' : 'SYNC_FAILED';
}
function identity(value) {
  assert(object(value), 'Invalid engine account identity');
  const server = validateServerUrl(value.server), serverId = validateId(value.serverId), deviceId = validateId(value.deviceId);
  assert(typeof value.username === 'string' && value.username.length > 0 && Buffer.byteLength(value.username) <= 128 && !/[\x00-\x1f\x7f]/.test(value.username), 'Invalid engine username');
  assert(Number.isSafeInteger(value.authorizationEpoch) && value.authorizationEpoch >= 0, 'Invalid authorization epoch');
  // Deliberately project the identity: credentials supplied accidentally are NEVER persisted.
  return Object.freeze({ server, serverId, username: value.username, deviceId, authorizationEpoch: value.authorizationEpoch });
}
function rootRecord(value, root) {
  if (!object(value) || key(value.root) !== key(root) || ['dev', 'ino', 'birthtimeNs'].some(field => typeof value[field] !== 'string' || !/^\d+$/.test(value[field]))) throw fail('SYNC_BINDING_MISMATCH');
  return { root: path.resolve(value.root), dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}
function headRecord(value, projectId) {
  if (value === null) return null;
  if (!object(value) || value.projectId !== projectId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw fail('SYNC_INTEGRITY');
  return { projectId, id: validateId(value.id), revision: value.revision, manifestDigest: validateBlobHash(value.manifestDigest), recordHash: validateBlobHash(value.recordHash), ...(value.requestId === undefined ? {} : { requestId: validateId(value.requestId) }) };
}
function baseRecords(values) {
  if (!Array.isArray(values) || values.length > 20_000) throw fail('SYNC_JOURNAL_CORRUPT');
  const seen = new Set();
  return values.map(item => {
    const name = validateSyncPath(item.path); if (seen.has(name.toLowerCase())) throw fail('SYNC_JOURNAL_CORRUPT'); seen.add(name.toLowerCase());
    if (item.ambiguous !== undefined && typeof item.ambiguous !== 'boolean') throw fail('SYNC_JOURNAL_CORRUPT');
    return { path: name, state: validateFileState(item.state), ...(item.conflictId === undefined ? {} : { conflictId: validateBlobHash(item.conflictId), preservedState: validateFileState(item.preservedState) }), ...(item.ambiguous ? { ambiguous: true } : {}) };
  });
}
function localFiles(values, projectId, deviceId) {
  return validateSyncManifest({ version: 2, id: 'local-scan', projectId, deviceId, parentId: null, policyRevision: 1, files: values, tombstones: [], conflicts: [], archiveRefs: [] }).files;
}
function normalizedArchives(values, files, projectId, deviceId, { captured = false } = {}) {
  if (!Array.isArray(values)) throw fail('SYNC_INTEGRITY');
  if (values.length + files.length > MAX_SYNC_ENTRIES) throw fail('SYNC_QUOTA');
  const hashes = new Map(); let bytes = 0;
  for (const item of [...files, ...values]) {
    if (!object(item) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_BLOB_BYTES) throw fail('SYNC_INTEGRITY');
    try { validateBlobHash(item.hash); } catch { throw fail('SYNC_INTEGRITY'); }
    if (hashes.has(item.hash) && hashes.get(item.hash) !== item.size) throw fail('SYNC_INTEGRITY');
    if (!hashes.has(item.hash)) { hashes.set(item.hash, item.size); bytes += item.size; }
  }
  if (bytes > MAX_CHECKPOINT_BYTES) throw fail('SYNC_QUOTA');
  let normalized;
  try { normalized = validateSyncManifest({ version: 2, id: 'archive-scan', projectId, deviceId, parentId: null, policyRevision: 1, files, tombstones: [], conflicts: [], archiveRefs: values }).archiveRefs; }
  catch { throw fail('SYNC_INTEGRITY'); }
  if (captured && normalized.some(item => item.id !== `asset-${item.hash}` && item.id !== `session-${item.hash}`)) throw fail('SYNC_INTEGRITY');
  return normalized;
}
function unionArchives(prior, captured) {
  const refs = new Map(prior.map(item => [item.id, item]));
  for (const item of captured) {
    const old = refs.get(item.id);
    if (old && (old.hash !== item.hash || old.size !== item.size)) throw fail('SYNC_INTEGRITY');
    refs.set(item.id, item);
  }
  return [...refs.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function archiveMetadata(input) {
  if (!object(input) || input.skippedCount !== undefined && (!Number.isSafeInteger(input.skippedCount) || input.skippedCount < 0 || input.skippedCount > MAX_SYNC_ENTRIES) || input.warningCode !== undefined && !archiveWarnings.has(input.warningCode)) throw fail('SYNC_INTEGRITY');
  return { skippedCount: input.skippedCount ?? 0, ...(input.warningCode ? { warningCode: input.warningCode } : {}) };
}
function repairResult(value) {
  if (!object(value)) throw fail('SYNC_JOURNAL_CORRUPT');
  const planId = validateId(value.planId), requestId = validateId(value.requestId);
  if (value.state === 'superseded' && value.superseded === true) return { state: 'superseded', superseded: true, requestId, planId, supersededBy: validateId(value.supersededBy) };
  if (value.state !== 'replanned' || !object(value.summary) || ['restore', 'conflicts', 'unchanged'].some(key => !Number.isSafeInteger(value.summary[key]) || value.summary[key] < 0 || value.summary[key] > MAX_SYNC_ENTRIES)) throw fail('SYNC_JOURNAL_CORRUPT');
  return { state: 'replanned', planId, requestId, retiredRequestId: validateId(value.retiredRequestId), summary: Object.fromEntries(['restore', 'conflicts', 'unchanged'].map(key => [key, value.summary[key]])) };
}
async function readJson(filename) {
  const { bytes } = await readStableFile(filename, MAX_STATE_BYTES);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function treeBytes(directory) {
  if (!(await exists(directory))) return 0;
  await assertNoSymlinks(directory); let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name); await assertNoSymlinks(target);
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) total += await treeBytes(target);
    else { if (!stat.isFile() || stat.nlink !== 1) throw fail('SYNC_METADATA_UNSAFE'); total += stat.size; }
  }
  return total;
}
function summary(plan, remote, local) {
  if (!plan.manifest) return { upload: 0, download: 0, delete: 0, conflicts: plan.frozen.length, blocked: plan.blockers.length };
  const prior = new Map((remote?.files || []).map(file => [file.path, stateOf(file)])), uploads = new Set(), deletes = new Set();
  for (const file of local) {
    if (!equal(stateOf(file), prior.get(file.path) ?? null) && (plan.adoptions.some(item => item.path === file.path) || plan.frozen.some(item => item.path === file.path))) uploads.add(file.path);
  }
  for (const item of plan.operations) if (item.desired === null) deletes.add(item.path);
  for (const item of plan.adoptions) if (item.state === null && prior.has(item.path)) deletes.add(item.path);
  return { upload: uploads.size, download: plan.operations.filter(item => item.desired !== null).length, delete: deletes.size, conflicts: plan.manifest.conflicts.length, blocked: plan.blockers.length };
}

/** Durable, native-Host-independent orchestration for ONE explicit binding.
 * `directory` is plugin-owned state; all engine data lives in v2/<bindingId>.
 * check(context) owns consent/account/authorization-epoch admission. getClient()
 * owns native credential renewal; no grant, password or bearer enters a journal.
 * preview() never creates root-side metadata or uploads. Enabling is Host-owned.
 */
export class SyncEngine {
  constructor({ directory, bindingId, projectId, root, accountIdentity, getClient, check = async () => {}, isIdle = async () => true, captureArchives = noArchives, excludedPaths = [], getExcludedPaths = async () => [], quotaBytes = DEFAULT_SYNC_QUOTA, signal, fault = async () => {} }) {
    this.directory = path.resolve(directory); this.bindingId = validateId(bindingId); this.projectId = validateId(projectId); this.root = path.resolve(root);
    this.accountIdentity = identity(accountIdentity);
    assert(typeof getClient === 'function' && typeof check === 'function' && typeof isIdle === 'function' && typeof getExcludedPaths === 'function' && typeof captureArchives === 'function', 'Invalid engine callbacks');
    assert(Number.isSafeInteger(quotaBytes) && quotaBytes > 0 && Array.isArray(excludedPaths), 'Invalid engine limits');
    if (inside(key(this.root), key(this.directory))) throw fail('SYNC_BINDING_MISMATCH');
    this.getClient = getClient; this.check = check; this.isIdle = isIdle; this.captureArchives = captureArchives; this.excludedPaths = [...excludedPaths]; this.getExcludedPaths = getExcludedPaths; this.quotaBytes = quotaBytes; this.signal = signal; this.fault = fault;
    this.engineDirectory = path.join(this.directory, 'v2', this.bindingId);
    this.filename = path.join(this.engineDirectory, 'engine.json');
    this.applierDirectory = path.join(this.root, '.dsh-sync', 'v2', this.bindingId);
    this.store = new LocalStore(this.engineDirectory);
    this._active = false; this._state = null;
  }
  async _check(phase) {
    this.signal?.throwIfAborted();
    await this.check({ phase, bindingId: this.bindingId, projectId: this.projectId, root: this.root, accountIdentity: clone(this.accountIdentity) });
    this.signal?.throwIfAborted();
    if (this._state) await verifySyncRoot(this._state.rootIdentity);
  }
  async _exclusions() {
    const dynamic = await this.getExcludedPaths();
    if (!Array.isArray(dynamic)) throw fail('SYNC_POLICY_CHANGED');
    const relative = path.relative(this.root, this.directory);
    return [...this.excludedPaths, ...dynamic, ...(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : [])];
  }
  async _policy() {
    const excludedPaths = await this._exclusions();
    try { return await readExclusionPolicy(this.root, { excluded: ['.dsh-syncignore', '**/.dsh-syncignore'], excludedPaths }); }
    catch (error) { if (safeCodes.has(error.code)) throw error; throw fail('SYNC_POLICY_CHANGED'); }
  }
  async _guard(descriptor, phase, idle = false) {
    await this._check(phase);
    if (descriptor && (await this._policy()).fingerprint !== descriptor.policyHash) throw fail('SYNC_POLICY_CHANGED');
    if (idle && !(await this.isIdle())) throw fail('SYNC_NOT_IDLE');
    this.signal?.throwIfAborted();
  }
  _newState(rootIdentity) {
    return { version: VERSION, bindingId: this.bindingId, projectId: this.projectId, rootIdentity, accountIdentity: clone(this.accountIdentity), authorizationDigests: [sha256(canonicalJson(this.accountIdentity))], bases: [], capture: null, pending: null, remote: null, retired: [], resolutionReceipts: [], pendingRepair: null, repairReceipts: [], lastResult: { state: 'idle', pendingUpload: 0, pendingDownload: 0, conflicts: 0 } };
  }
  _validateState(input) {
    if (!object(input) || !Object.keys(input).every(field => ['version', 'bindingId', 'projectId', 'rootIdentity', 'accountIdentity', 'authorizationDigests', 'bases', 'capture', 'pending', 'remote', 'retired', 'resolutionReceipts', 'pendingRepair', 'repairReceipts', 'lastResult', 'lastCheckedAt', 'lastSyncedAt'].includes(field))) throw fail('SYNC_JOURNAL_CORRUPT');
    if (input.version !== VERSION || input.bindingId !== this.bindingId || input.projectId !== this.projectId || canonicalJson(input.accountIdentity) !== canonicalJson(this.accountIdentity)) throw fail('SYNC_BINDING_MISMATCH');
    rootRecord(input.rootIdentity, this.root); input.bases = baseRecords(input.bases);
    if (!Array.isArray(input.authorizationDigests) || input.authorizationDigests.length > 1000 || !input.authorizationDigests.includes(sha256(canonicalJson(this.accountIdentity)))) throw fail('SYNC_JOURNAL_CORRUPT');
    input.authorizationDigests.forEach(validateBlobHash);
    if (input.capture) {
      input.capture.files = localFiles(input.capture.files, this.projectId, this.accountIdentity.deviceId);
      input.capture.archiveRefs = normalizedArchives(input.capture.archiveRefs ?? [], input.capture.files, this.projectId, this.accountIdentity.deviceId, { captured: true });
      Object.assign(input.capture, archiveMetadata(input.capture));
      validateBlobHash(input.capture.policyHash); rootRecord(input.capture.rootIdentity, this.root);
      if (!Array.isArray(input.capture.unknownPaths)) throw fail('SYNC_JOURNAL_CORRUPT'); input.capture.unknownPaths.forEach(validateRelativePath);
    }
    if (input.pending) {
      validateId(input.pending.requestId); validateBlobHash(input.pending.descriptorHash);
      if (!phases.has(input.pending.phase) || !Array.isArray(input.pending.outcomes) || input.pending.outcomes.length > 20_000) throw fail('SYNC_JOURNAL_CORRUPT');
      input.pending.outcomes = input.pending.outcomes.map(item => {
        if (!['applied', 'adopted', 'frozen'].includes(item.state)) throw fail('SYNC_JOURNAL_CORRUPT');
        return { path: validateSyncPath(item.path), state: item.state };
      });
      if (input.pending.receipt) input.pending.receipt = headRecord(input.pending.receipt, this.projectId);
    }
    if (input.remote) {
      const head = headRecord(input.remote.head, this.projectId), manifest = validateSyncManifest(input.remote.manifest);
      if (!head || head.id !== manifest.id || manifest.projectId !== this.projectId || head.manifestDigest !== syncManifestDigest(manifest)) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    if (!Array.isArray(input.retired) || input.retired.length > 1000 || !object(input.lastResult)) throw fail('SYNC_JOURNAL_CORRUPT');
    input.resolutionReceipts ??= [];
    if (!Array.isArray(input.resolutionReceipts) || input.resolutionReceipts.length > 1000) throw fail('SYNC_JOURNAL_CORRUPT');
    for (const marker of input.resolutionReceipts) { validateId(marker.requestId); validateBlobHash(marker.digest); }
    input.pendingRepair ??= null; input.repairReceipts ??= [];
    if (!Array.isArray(input.repairReceipts) || input.repairReceipts.length > 1000) throw fail('SYNC_JOURNAL_CORRUPT');
    const repairIds = new Set();
    for (const receipt of input.repairReceipts) {
      if (repairIds.has(receipt.requestId)) throw fail('SYNC_JOURNAL_CORRUPT'); repairIds.add(receipt.requestId);
      validateId(receipt.requestId); validateId(receipt.planId); validateBlobHash(receipt.planDigest); receipt.result = repairResult(receipt.result);
      if (receipt.result.requestId !== receipt.requestId || receipt.result.planId !== receipt.planId) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    if (input.pendingRepair) {
      const repair = input.pendingRepair;
      validateId(repair.requestId); validateId(repair.planId); validateBlobHash(repair.planDigest); validateBlobHash(repair.identityDigest);
      if (repairIds.has(repair.requestId) || !input.pending || !Array.isArray(repair.steps) || repair.steps.length > MAX_SYNC_ENTRIES || repair.steps.some((step, index) => step.index !== index || !['pending', 'creating', 'restored', 'kept', 'ambiguous'].includes(step.phase))) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    const result = input.lastResult;
    if (!['idle', 'scanning', 'offline', 'uploading', 'applying', 'deferred', 'conflicted', 'blocked', 'uncertain', 'synced'].includes(result.state) || ['pendingUpload', 'pendingDownload', 'conflicts'].some(field => !Number.isSafeInteger(result[field]) || result[field] < 0 || result[field] > 40_000) || result.errorCode !== undefined && !safeCodes.has(result.errorCode) && result.errorCode !== 'SYNC_FAILED') throw fail('SYNC_JOURNAL_CORRUPT');
    if (result.summary && ['upload', 'download', 'delete', 'conflicts', 'blocked'].some(field => !Number.isSafeInteger(result.summary[field]) || result.summary[field] < 0 || result.summary[field] > 40_000)) throw fail('SYNC_JOURNAL_CORRUPT');
    if (result.operationId) validateId(result.operationId);
    return input;
  }
  async _load() {
    this._engineBytes = undefined; this._networkVerified = false;
    await this._check('initialize');
    if (await exists(this.filename)) this._state = this._validateState(await readJson(this.filename));
    else { this._state = this._newState(await syncRootIdentity(this.root)); await this._save(); }
    await verifySyncRoot(this._state.rootIdentity);
  }
  async _space(additional = 0) {
    // The exclusive engine lock admits all spool writes. Count existing bytes
    // once, then account our writes; never rescan N old blobs for each new blob.
    this._engineBytes ??= await treeBytes(this.engineDirectory);
    if (this._engineBytes + await treeBytes(this.applierDirectory) + additional > this.quotaBytes) throw fail('SYNC_QUOTA');
  }
  async _save() {
    await this._check('journal');
    const bytes = Buffer.from(canonicalJson(this._state));
    if (bytes.length > MAX_STATE_BYTES) throw fail('SYNC_QUOTA');
    const previousSize = await exists(this.filename) ? (await fs.lstat(this.filename)).size : 0;
    await this._space(bytes.length); // Conservative allowance includes the temporary atomic-write copy.
    try { await atomicWrite(this.filename, bytes); this._engineBytes += bytes.length - previousSize; }
    catch (error) { this._engineBytes = undefined; throw error; }
  }
  async _putBlob(hash, bytes) {
    await this._check('spool');
    const filename = path.join(this.engineDirectory, 'blobs', validateBlobHash(hash));
    const present = await exists(filename);
    if (!present) await this._space(bytes.length);
    try { await this.store.putBlob(hash, bytes); if (!present) this._engineBytes += bytes.length; }
    catch (error) { this._engineBytes = undefined; throw error; }
  }
  async _captureArchiveRefs(scan) {
    if (this.captureArchives === noArchives) return { archiveRefs: [], skippedCount: 0 };
    const owned = new Map(), budget = new Map(scan.files.map(file => [file.hash, file.size]));
    let total = [...budget.values()].reduce((sum, size) => sum + size, 0), writes = Promise.resolve(), open = true;
    const admit = () => this._guard(scan, 'archives');
    const check = async () => { if (!open) throw fail('SYNC_INTEGRITY'); await admit(); };
    const putBlob = (hash, value) => {
      if (!open) return Promise.reject(fail('SYNC_INTEGRITY'));
      const invalid = !Buffer.isBuffer(value) ? 'SYNC_INTEGRITY' : value.length > MAX_BLOB_BYTES ? 'SYNC_QUOTA' : undefined;
      const bytes = invalid ? null : Buffer.from(value); // Pin mutable buffers before asynchronous admission.
      const operation = writes.then(async () => {
        await admit(); if (invalid) throw fail(invalid);
        if (typeof hash !== 'string' || sha256(bytes) !== hash) throw fail('SYNC_INTEGRITY');
        if (budget.has(hash) && budget.get(hash) !== bytes.length) throw fail('SYNC_INTEGRITY');
        if (!budget.has(hash)) { budget.set(hash, bytes.length); total += bytes.length; }
        if (total > MAX_CHECKPOINT_BYTES || !owned.has(hash) && owned.size + scan.files.length >= MAX_SYNC_ENTRIES) throw fail('SYNC_QUOTA');
        await this._putBlob(hash, bytes); owned.set(hash, bytes.length); await admit();
      });
      writes = operation; void operation.catch(() => {}); // Always drain started writes, even if a hook throws.
      return operation;
    };
    try {
      await check();
      const files = Object.freeze(scan.files.map(file => Object.freeze({ ...file })));
      let captured;
      try { captured = await this.captureArchives({ root: this.root, projectId: this.projectId, deviceId: this.accountIdentity.deviceId, files, putBlob, check, signal: this.signal }); }
      finally { open = false; }
      await writes; await admit();
      const metadata = archiveMetadata(captured);
      const archiveRefs = normalizedArchives(captured.archiveRefs, scan.files, this.projectId, this.accountIdentity.deviceId, { captured: true });
      for (const ref of archiveRefs) if (owned.get(ref.hash) !== ref.size) throw fail('SYNC_INTEGRITY');
      return { archiveRefs, ...metadata };
    } finally { open = false; await writes.catch(() => {}); }
  }
  async _capture({ archives = true } = {}) {
    await this._check('scan'); this._state.lastResult = { ...this._state.lastResult, state: 'scanning' };
    await this._policy();
    const scan = await scanSyncProject({ root: this.root, projectId: this.projectId, deviceId: this.accountIdentity.deviceId, bases: this._state.bases, excludedPaths: await this._exclusions(), signal: this.signal, check: () => this._check('scan'), putBlob: (hash, bytes) => this._putBlob(hash, bytes) });
    if (canonicalJson(scan.rootIdentity) !== canonicalJson(this._state.rootIdentity)) throw fail('SYNC_ROOT_CHANGED');
    if ((await this._policy()).fingerprint !== scan.policyHash) throw fail('SYNC_POLICY_CHANGED');
    const captured = archives ? await this._captureArchiveRefs(scan) : { archiveRefs: [], skippedCount: 0 };
    await scan.verify();
    if ((await this._policy()).fingerprint !== scan.policyHash) throw fail('SYNC_POLICY_CHANGED');
    Object.assign(scan, captured);
    this._state.capture = { rootIdentity: scan.rootIdentity, files: scan.files, ...captured, policyHash: scan.policyHash, unknownPaths: scan.skipped.filter(item => item.reason !== 'excluded').map(item => item.path), capturedAt: now() };
    await this._save(); return scan;
  }
  async _client() {
    await this._check('network'); const client = await this.getClient();
    if (!client || client.server !== this.accountIdentity.server || client.deviceId !== this.accountIdentity.deviceId || client.serverId && client.serverId !== this.accountIdentity.serverId) throw fail('ACCOUNT_MISMATCH');
    return client;
  }
  async _connect() {
    const client = await this._client(), capabilities = await client.capabilities();
    if (capabilities.serverId !== this.accountIdentity.serverId) throw fail('ACCOUNT_MISMATCH');
    await this._check('network'); this._networkVerified = true; return client;
  }
  async _remote(attempt = 0) {
    const client = await this._client(); const head = headRecord(await client.syncHead(this.projectId), this.projectId);
    await this._check('remote');
    if (!head) {
      let legacy;
      try { legacy = await client.legacyHeads(this.projectId); }
      catch (error) { if (error.code === 'SYNC_ALREADY_MIGRATED' && attempt < 2) return this._remote(attempt + 1); throw error; }
      await this._check('remote');
      this._state.lastCheckedAt = now(); await this._save();
      return { head: null, manifest: null, migrationRequired: legacy.checkpointCount > 0 || legacy.heads.length > 0 };
    }
    const manifest = validateSyncManifest(await client.syncCheckpoint(this.projectId, head.id, head.manifestDigest));
    if (manifest.projectId !== this.projectId || manifest.id !== head.id || syncManifestDigest(manifest) !== head.manifestDigest) throw fail('SYNC_INTEGRITY');
    await this._check('remote'); this._state.remote = { head, manifest }; this._state.lastCheckedAt = now(); await this._save();
    return { head, manifest, migrationRequired: false };
  }
  _plan(scan, remote) {
    const label = path.basename(this.root).normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '') || this.projectId;
    const plan = reconcileSync({ projectId: this.projectId, deviceId: this.accountIdentity.deviceId, remote: remote.manifest, local: scan.files, bases: this._state.bases, isManaged: scan.isManaged, label });
    if (plan.manifest) {
      const archiveRefs = unionArchives(remote.manifest?.archiveRefs ?? [], scan.archiveRefs ?? []);
      try { plan.manifest = validateSyncManifest({ ...plan.manifest, archiveRefs }); }
      catch { throw fail('SYNC_QUOTA'); } // All pieces were validated; the aggregate can exceed v2 bounds.
      plan.changed ||= canonicalJson(archiveRefs) !== canonicalJson(remote.manifest?.archiveRefs ?? []);
    }
    return { ...plan, summary: summary(plan, remote.manifest, scan.files) };
  }
  _proposalPath(id) { return path.join(this.engineDirectory, 'proposals', `${validateId(id)}.json`); }
  async _descriptor() {
    const pending = this._state.pending;
    const { bytes } = await readStableFile(this._proposalPath(pending.requestId), MAX_STATE_BYTES);
    if (sha256(bytes) !== pending.descriptorHash) throw fail('SYNC_JOURNAL_CORRUPT');
    const descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (descriptor.version !== VERSION || descriptor.bindingId !== this.bindingId || descriptor.projectId !== this.projectId || descriptor.requestId !== pending.requestId || !this._state.authorizationDigests.includes(descriptor.identityDigest) || canonicalJson(rootRecord(descriptor.rootIdentity, this.root)) !== canonicalJson(this._state.rootIdentity) || !['commit', 'observe'].includes(descriptor.mode)) throw fail('SYNC_JOURNAL_CORRUPT');
    validateBlobHash(descriptor.policyHash); const manifest = validateSyncManifest(descriptor.manifest), head = headRecord(descriptor.expectedHead, this.projectId);
    if (manifest.projectId !== this.projectId || descriptor.mode === 'commit' && (manifest.deviceId !== this.accountIdentity.deviceId || manifest.parentId !== (head?.id ?? null)) || descriptor.mode === 'observe' && (!head || manifest.id !== head.id || syncManifestDigest(manifest) !== head.manifestDigest)) throw fail('SYNC_JOURNAL_CORRUPT');
    descriptor.localFiles = localFiles(descriptor.localFiles, this.projectId, this.accountIdentity.deviceId);
    descriptor.localArchiveRefs = normalizedArchives(descriptor.localArchiveRefs ?? [], descriptor.localFiles, this.projectId, this.accountIdentity.deviceId, { captured: true });
    if (descriptor.priorArchiveRefs !== undefined) {
      descriptor.priorArchiveRefs = normalizedArchives(descriptor.priorArchiveRefs, [], this.projectId, this.accountIdentity.deviceId);
      if (canonicalJson(unionArchives(descriptor.priorArchiveRefs, descriptor.localArchiveRefs)) !== canonicalJson(manifest.archiveRefs)) throw fail('SYNC_JOURNAL_CORRUPT');
    } else if (descriptor.localArchiveRefs.length) throw fail('SYNC_JOURNAL_CORRUPT');
    const local = new Map(descriptor.localFiles.map(file => [file.path, stateOf(file)]));
    descriptor.plan.adoptions = baseRecords(descriptor.plan.adoptions); descriptor.plan.frozen = baseRecords(descriptor.plan.frozen);
    if (!Array.isArray(descriptor.plan.operations) || descriptor.plan.operations.length > 20_000) throw fail('SYNC_JOURNAL_CORRUPT');
    descriptor.manifest = manifest; descriptor.expectedHead = head;
    descriptor.plan.operations = descriptor.plan.operations.map(item => ({ path: validateSyncPath(item.path), expected: validateFileState(item.expected), desired: validateFileState(item.desired) }));
    const seen = new Set(), adoptions = new Map(descriptor.plan.adoptions.map(item => [item.path, item.state]));
    for (const operation of descriptor.plan.operations) {
      validateSyncPath(operation.path); validateFileState(operation.expected); validateFileState(operation.desired);
      if (seen.has(operation.path) || !equal(operation.expected, local.get(operation.path) ?? null) || !adoptions.has(operation.path) || !equal(operation.desired, adoptions.get(operation.path))) throw fail('SYNC_JOURNAL_CORRUPT'); seen.add(operation.path);
    }
    const live = new Map(manifest.files.map(file => [file.path, stateOf(file)]));
    for (const item of descriptor.plan.adoptions) {
      if (!equal(item.state, live.get(item.path) ?? null) || !seen.has(item.path) && !equal(item.state, local.get(item.path) ?? null)) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    for (const item of descriptor.plan.frozen) {
      if (adoptions.has(item.path) || !manifest.conflicts.some(conflict => conflict.path === item.path && conflict.id === item.conflictId) || !equal(item.preservedState, local.get(item.path) ?? null)) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    if (pending.receipt) {
      if (descriptor.mode === 'commit') pending.receipt = this._receipt(descriptor, pending.receipt);
      else if (canonicalJson(headRecord(pending.receipt, this.projectId)) !== canonicalJson(head)) throw fail('SYNC_JOURNAL_CORRUPT');
    } else if (descriptor.mode === 'observe') throw fail('SYNC_JOURNAL_CORRUPT');
    return descriptor;
  }
  async _prepare(plan, scan, remote) {
    await this._guard({ policyHash: scan.policyHash }, 'prepare');
    const requestId = randomUUID(), mode = plan.changed ? 'commit' : 'observe';
    const descriptor = { version: VERSION, bindingId: this.bindingId, projectId: this.projectId, identityDigest: sha256(canonicalJson(this.accountIdentity)), rootIdentity: this._state.rootIdentity, policyHash: scan.policyHash, requestId, mode, expectedHead: remote.head, manifest: mode === 'commit' ? plan.manifest : remote.manifest, localFiles: scan.files, localArchiveRefs: scan.archiveRefs ?? [], priorArchiveRefs: remote.manifest?.archiveRefs ?? [], plan: { operations: plan.operations, adoptions: plan.adoptions, frozen: plan.frozen }, summary: plan.summary };
    const bytes = Buffer.from(canonicalJson(descriptor)); await this._space(bytes.length);
    try { await writeNewFile(this._proposalPath(requestId), bytes); this._engineBytes += bytes.length; }
    catch (error) { this._engineBytes = undefined; throw error; }
    this._state.pending = { requestId, descriptorHash: sha256(bytes), phase: mode === 'observe' ? 'remote-accepted' : 'prepared', receipt: mode === 'observe' ? remote.head : null, outcomes: [], applierStarted: false };
    await this._save(); return descriptor;
  }
  _request(descriptor) { return { requestId: descriptor.requestId, expectedHeadRevision: descriptor.expectedHead?.revision ?? 0, expectedHeadId: descriptor.expectedHead?.id ?? null, manifest: validateSyncManifest(descriptor.manifest), resolutions: [] }; }
  _receipt(descriptor, value) {
    const receipt = headRecord(value, this.projectId);
    if (!receipt || receipt.requestId !== descriptor.requestId || receipt.id !== descriptor.manifest.id || receipt.revision !== (descriptor.expectedHead?.revision ?? 0) + 1 || receipt.manifestDigest !== syncManifestDigest(descriptor.manifest)) throw fail('SYNC_INTEGRITY');
    return receipt;
  }
  async _accepted(descriptor, receipt) {
    this._state.pending.receipt = receipt; this._state.pending.phase = 'remote-accepted';
    this._state.remote = { head: receipt, manifest: descriptor.manifest }; this._state.lastCheckedAt = now();
    await this._save();
  }
  async _retire(descriptor, reason) {
    if (this._state.retired.length >= 1000) throw fail('SYNC_QUOTA');
    this._state.retired.push({ requestId: descriptor.requestId, descriptorHash: this._state.pending.descriptorHash, reason, receipt: this._state.pending.receipt });
    this._state.pending = null; await this._save();
  }
  async _upload(descriptor) {
    await this._guard(descriptor, 'inventory');
    const refs = referencedBlobs(descriptor.manifest), byHash = new Map(refs.map(item => [item.hash, item]));
    const allowed = new Map([...descriptor.localFiles, ...(descriptor.localArchiveRefs ?? [])].map(item => [item.hash, item]));
    const missing = [];
    for (let offset = 0; offset < refs.length; offset += 256) {
      const client = await this._client(); await this._guard(descriptor, 'inventory');
      missing.push(...await client.missingBlobs(refs.slice(offset, offset + 256)));
    }
    for (const hash of missing) if (!allowed.has(hash) || !byHash.has(hash)) throw fail('SYNC_REMOTE_BLOB_MISSING');
    let index = 0, failure;
    // At most two in-flight transfers; after either failure no new worker is admitted.
    await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
      while (!failure && index < missing.length) {
        const hash = missing[index++];
        try {
          const bytes = await this.store.getBlob(hash); if (bytes.length !== byHash.get(hash).size) throw fail('SYNC_INTEGRITY');
          const client = await this._client(); await this._guard(descriptor, 'upload');
          if (failure) return;
          await client.uploadBlob(hash, bytes);
        } catch (error) { failure ||= error; }
      }
    }));
    if (failure) throw failure;
  }
  async _commit(descriptor) {
    await this._result('uploading', undefined, descriptor);
    await this._upload(descriptor);
    const client = await this._client(); await this._guard(descriptor, 'commit');
    this._state.pending.phase = 'committing'; await this._save();
    // The final policy/authority read is AFTER fallible durable intent writes.
    await this._guard(descriptor, 'commit');
    let receipt;
    try { receipt = this._receipt(descriptor, await client.commitSync(this._request(descriptor))); await this.fault('after-remote-commit', descriptor); }
    catch (error) {
      this._state.pending.phase = error.code === 'SYNC_HEAD_MISMATCH' ? 'prepared' : 'commit-uncertain';
      await this._save(); throw error;
    }
    await this._accepted(descriptor, receipt);
  }
  _advance(descriptor, applied = []) {
    const pending = this._state.pending, bases = new Map(this._state.bases.map(item => [item.path, item]));
    const operations = new Map(descriptor.plan.operations.map(item => [item.path, item]));
    const outcomes = new Map(pending.outcomes.map(item => [item.path, item]));
    for (const adoption of descriptor.plan.adoptions) {
      const operation = operations.get(adoption.path);
      if (operation && !applied.includes(adoption.path)) continue;
      // A no-op/upload adoption was verified in the immutable local capture;
      // later local edits do not erase that materialized common ancestor.
      bases.set(adoption.path, clone(adoption)); outcomes.set(adoption.path, { path: adoption.path, state: operation ? 'applied' : 'adopted' });
    }
    for (const frozen of descriptor.plan.frozen) { bases.set(frozen.path, clone(frozen)); outcomes.set(frozen.path, { path: frozen.path, state: 'frozen' }); }
    this._state.bases = [...bases.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')); pending.outcomes = [...outcomes.values()];
  }
  async _applier(descriptor, idle = true) {
    this._engineBytes ??= await treeBytes(this.engineDirectory);
    const available = this.quotaBytes - this._engineBytes;
    if (available <= 0) throw fail('SYNC_QUOTA');
    return createSyncApplier({ root: this.root, bindingId: this.bindingId, projectId: this.projectId, quotaBytes: available, signal: this.signal, check: () => this._guard(descriptor, idle ? 'apply' : 'recycle', idle), fault: this.fault });
  }
  async _getBlob(descriptor, hash, size) {
    await this._guard(descriptor, 'download', true);
    try { const bytes = await this.store.getBlob(hash); if (bytes.length !== size) throw fail('SYNC_INTEGRITY'); return bytes; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!this._networkVerified) await this._connect();
    const client = await this._client(); await this._guard(descriptor, 'download', true);
    // The applier owns and verifies its durable stage/conflict copies. Do not
    // duplicate inbound blobs in the spool before they materialize as files.
    return client.downloadBlob(hash, size);
  }
  async _apply(descriptor) {
    await this._guard(descriptor, 'accepted');
    this._advance(descriptor); await this._save();
    const conflicts = descriptor.manifest.conflicts.filter(item => descriptor.plan.frozen.some(frozen => frozen.path === item.path));
    if (descriptor.plan.operations.length || conflicts.length) {
      if (!(await this.isIdle())) throw fail('SYNC_NOT_IDLE');
      await this._result('applying', undefined, descriptor);
      let applier;
      try {
        applier = await this._applier(descriptor);
        const getBlob = (hash, size) => this._getBlob(descriptor, hash, size);
        await applier.preserveVariants(conflicts, getBlob);
        if (descriptor.plan.operations.length) {
          await applier.prepare({ id: descriptor.requestId, operations: descriptor.plan.operations, remoteReceipt: this._state.pending.receipt }, getBlob);
          this._state.pending.phase = 'applying'; this._state.pending.applierStarted = true; await this._save();
          const result = await applier.apply(descriptor.requestId), journal = await applier.journal(descriptor.requestId);
          this._advance(descriptor, journal.operations.filter(item => item.phase === 'applied').map(item => item.path));
          await this._save();
          if (result.state !== 'applied') throw fail(result.errorCode || 'SYNC_APPLY_INCOMPLETE');
          await applier.finalize(descriptor.requestId);
        }
      } catch (error) {
        this._state.pending.phase = 'local-partial';
        // A crash/fault after verified publish may precede the engine's own base
        // write. The applier journal is the ONLY authority to advance that path.
        if (applier && this._state.pending.applierStarted) {
          try { const journal = await applier.journal(descriptor.requestId); this._advance(descriptor, journal.operations.filter(item => item.phase === 'applied').map(item => item.path)); } catch {}
        }
        await this._save(); throw error;
      }
    }
    this._state.pending = null; await this._save();
  }
  async _recover(descriptor) {
    const pending = this._state.pending;
    if (pending.phase === 'policy-retired') throw fail('SYNC_REPLAN_REQUIRED');
    // Resolve an uncertain request by its immutable receipt BEFORE any replay,
    // even if today's policy forbids replaying the old proposal.
    if (!pending.receipt && ['committing', 'commit-uncertain'].includes(pending.phase)) {
      const client = await this._client(), result = await client.syncReceipt(this.projectId, descriptor.requestId); await this._check('receipt');
      if (result) await this._accepted(descriptor, this._receipt(descriptor, result));
    }
    if ((await this._policy()).fingerprint !== descriptor.policyHash) {
      if (pending.applierStarted) { pending.phase = 'policy-retired'; await this._save(); throw fail('SYNC_REPLAN_REQUIRED'); }
      await this._retire(descriptor, 'SYNC_POLICY_CHANGED'); return;
    }
    if (!pending.receipt) await this._commit(descriptor);
    await this._apply(descriptor);
  }
  _archiveStatus(state = this._state) {
    const refs = new Set([...(state?.capture?.archiveRefs ?? []), ...(state?.remote?.manifest.archiveRefs ?? [])].filter(item => item.id.startsWith('session-')).map(item => item.id));
    return { ...(refs.size ? { archives: refs.size } : {}), ...(state?.capture?.skippedCount ? { skippedArchives: state.capture.skippedCount } : {}), ...(state?.capture?.warningCode ? { warningCode: state.capture.warningCode } : {}) };
  }
  _public(state = this._state) {
    if (!state) return { state: 'idle', pendingUpload: 0, pendingDownload: 0, conflicts: 0 };
    const value = state.lastResult || {}, result = { state: value.state || 'idle', pendingUpload: value.pendingUpload || 0, pendingDownload: value.pendingDownload || 0, conflicts: value.conflicts || 0, ...this._archiveStatus(state) };
    for (const name of ['errorCode', 'operationId']) if (value[name] !== undefined) result[name] = value[name];
    if (value.summary) result.summary = Object.fromEntries(['upload', 'download', 'delete', 'conflicts', 'blocked'].map(name => [name, value.summary[name]]));
    if (state.lastCheckedAt) result.lastCheckedAt = state.lastCheckedAt;
    if (state.lastSyncedAt) result.lastSyncedAt = state.lastSyncedAt;
    if (state.remote?.head) result.head = clone(state.remote.head);
    if (state.pending) { result.operationId = state.pending.requestId; result.phase = state.pending.phase; result.outcomes = clone(state.pending.outcomes); }
    if (state.pendingRepair) result.repair = { requestId: state.pendingRepair.requestId, planId: state.pendingRepair.planId, state: 'incomplete' };
    return result;
  }
  async _result(status, errorCode, descriptor) {
    const pending = this._state.pending, remoteConflicts = this._state.remote?.manifest.conflicts.length || 0;
    const applied = new Set(pending?.outcomes.filter(item => item.state === 'applied').map(item => item.path) || []);
    const pendingDownload = pending && descriptor ? descriptor.plan.operations.filter(item => !applied.has(item.path)).length : 0;
    const priorArchives = new Set((descriptor?.priorArchiveRefs ?? []).map(item => item.id));
    let pendingUpload = pending && !pending.receipt && descriptor ? descriptor.summary.upload + (descriptor.localArchiveRefs ?? []).filter(item => !priorArchives.has(item.id)).length : 0;
    if (!pending && status === 'offline') {
      const bases = new Map(this._state.bases.map(item => [item.path, item.state]));
      const remoteArchives = new Set((this._state.remote?.manifest.archiveRefs ?? []).map(item => item.id));
      pendingUpload = (this._state.capture?.files || []).filter(file => !equal(stateOf(file), bases.get(file.path) ?? null)).length + (this._state.capture?.archiveRefs ?? []).filter(item => !remoteArchives.has(item.id)).length;
    }
    this._state.lastResult = { state: status, pendingUpload, pendingDownload, conflicts: remoteConflicts, ...(errorCode ? { errorCode } : {}), ...(pending ? { operationId: pending.requestId } : {}), ...(descriptor ? { summary: descriptor.summary } : {}) };
    if (status === 'synced' && !pending && !remoteConflicts) this._state.lastSyncedAt = now();
    await this._save(); return this._public();
  }
  async preview() {
    if (this._active) throw fail('BUSY'); this._active = true;
    try {
      await this._check('preview');
      return await this.store.exclusive(async () => {
        await this._load(); const scan = await this._capture({ archives: !this._state.pending?.receipt }); await this._connect(); const remote = await this._remote();
        await scan.verify();
        const plan = remote.migrationRequired ? null : this._plan(scan, remote);
        return { previewId: randomUUID(), bindingId: this.bindingId, projectId: this.projectId, rootIdentity: clone(scan.rootIdentity), policyHash: scan.policyHash, head: clone(remote.head), migrationRequired: remote.migrationRequired, summary: plan?.summary || { upload: 0, download: 0, delete: 0, conflicts: 0, blocked: 1 }, ...this._archiveStatus() };
      });
    } finally { this._active = false; }
  }
  async run() {
    if (this._active) return { ...this._public(), state: 'deferred', errorCode: 'BUSY' };
    this._active = true;
    let descriptor;
    try {
      await this._check('run');
      return await this.store.exclusive(async () => {
        try {
          await this._load();
          if (this._state.pendingRepair) return this._result('blocked', 'SYNC_REPAIR_INCOMPLETE');
          let scan = await this._capture({ archives: !this._state.pending?.receipt }); // Local durability precedes ANY new network request; native archives wait for accepted recovery.
          if (this._state.pending) {
            descriptor = await this._descriptor();
            // An already accepted, fully staged transaction can repair its local
            // tree offline. A missing stage or ANY remote mutation still probes
            // the pinned server first; uncertain requests always query receipts.
            if (!this._state.pending.receipt) await this._connect();
            try { await this._recover(descriptor); }
            catch (error) { if (error.code !== 'SYNC_HEAD_MISMATCH') throw error; await this._retire(descriptor, 'SYNC_HEAD_MISMATCH'); }
            // An earlier journal can have temporarily moved a file to backup.
            // Never plan from the pre-recovery scan of that intermediate tree.
            scan = await this._capture(); descriptor = undefined;
          }
          if (!this._networkVerified) await this._connect();
          for (let attempt = 0; attempt < 3; attempt++) {
            const remote = await this._remote();
            if (remote.migrationRequired) return this._result('blocked', 'SYNC_MIGRATION_REQUIRED');
            await scan.verify(); const plan = this._plan(scan, remote);
            if (plan.blocked) return this._result('blocked', plan.blockers[0]?.code || 'SYNC_STRUCTURAL_CONFLICT');
            const bases = new Map(this._state.bases.map(item => [item.path, item]));
            if (!plan.changed && !plan.operations.length && [...plan.adoptions, ...plan.frozen].every(item => canonicalJson(item) === canonicalJson(bases.get(item.path) ?? null))) {
              if (plan.frozen.length) {
                // Another peer may have added variants while these frozen bases
                // stayed identical. Metadata copies are idempotent and do not
                // need a new proposal/primary-file apply transaction every tick.
                const observation = { policyHash: scan.policyHash };
                const applier = await this._applier(observation);
                await applier.preserveVariants(plan.manifest.conflicts.filter(item => plan.frozen.some(frozen => frozen.path === item.path)), (hash, size) => this._getBlob(observation, hash, size));
              }
              return this._result(plan.manifest.conflicts.length ? 'conflicted' : 'synced');
            }
            descriptor = await this._prepare(plan, scan, remote);
            try {
              if (descriptor.mode === 'commit') { this._state.lastResult.state = 'uploading'; await this._commit(descriptor); }
              await this._apply(descriptor);
              return this._result(descriptor.manifest.conflicts.length ? 'conflicted' : 'synced', undefined, descriptor);
            } catch (error) {
              if (error.code !== 'SYNC_HEAD_MISMATCH') throw error;
              await this._retire(descriptor, 'SYNC_HEAD_MISMATCH'); descriptor = undefined;
              if (attempt === 2) return this._result('blocked', 'SYNC_CAS_RETRY_LIMIT');
              scan = await this._capture();
            }
          }
        } catch (error) {
          const code = safeCode(error), pending = this._state?.pending;
          const remoteAccepted = pending?.receipt || descriptor && this._state?.remote?.head.id === descriptor.manifest.id;
          const blocking = remoteAccepted || code.startsWith('SYNC_') && !['SYNC_FAILED', 'SYNC_CANCELLED'].includes(code) || ['NOT_LOGGED_IN', 'ACCOUNT_MISMATCH', 'PROJECT_UNAVAILABLE', 'CONFIG_CONFLICT', 'SETTINGS_CORRUPT', 'DISPOSED'].includes(code);
          const status = ['SYNC_NOT_IDLE', 'BUSY'].includes(code) ? 'deferred' : pending?.phase === 'commit-uncertain' || pending?.phase === 'committing' ? 'uncertain' : blocking ? 'blocked' : 'offline';
          if (this._state) { try { return await this._result(status, code, descriptor); } catch {} }
          return { ...this._public(), state: status, errorCode: code };
        }
      });
    } catch (error) { return { ...this._public(), state: 'blocked', errorCode: safeCode(error) }; }
    finally { this._active = false; }
  }
  _repairPlanPath(id) { return path.join(this.engineDirectory, 'repair-plans', `${validateId(id)}.json`); }
  _repairFingerprint() { return sha256(canonicalJson({ pending: this._state.pending, bases: this._state.bases })); }
  async _repairProof(descriptor) {
    const client = await this._connect(); let receipt;
    if (descriptor.mode === 'commit') {
      const found = await client.syncReceipt(this.projectId, descriptor.requestId);
      if (!found) throw fail(this._state.pending.receipt ? 'SYNC_INTEGRITY' : 'SYNC_COMMIT_UNCERTAIN');
      receipt = this._receipt(descriptor, found);
      if (this._state.pending.receipt && canonicalJson(headRecord(this._state.pending.receipt, this.projectId)) !== canonicalJson(receipt)) throw fail('SYNC_INTEGRITY');
    } else receipt = headRecord(descriptor.expectedHead, this.projectId);
    const accepted = await client.syncCheckpoint(this.projectId, receipt.id, receipt.manifestDigest);
    if (syncManifestDigest(accepted) !== syncManifestDigest(descriptor.manifest)) throw fail('SYNC_INTEGRITY');
    const head = headRecord(await client.syncHead(this.projectId), this.projectId);
    if (!head || head.revision < receipt.revision) throw fail('SYNC_INTEGRITY');
    const manifest = validateSyncManifest(await client.syncCheckpoint(this.projectId, head.id, head.manifestDigest));
    if (syncManifestDigest(manifest) !== head.manifestDigest) throw fail('SYNC_INTEGRITY');
    await this._check('replan'); return { receipt, head, manifest };
  }
  async _repairInspection(descriptor) {
    const policy = await this._policy(), mandatory = createExclusionPolicy({ excluded: ['.dsh-syncignore', '**/.dsh-syncignore'], excludedPaths: await this._exclusions() });
    const protectedPaths = descriptor.plan.operations.filter(item => mandatory.isExcluded(item.path)).map(item => item.path);
    let applier, inspection;
    if (await exists(this.applierDirectory)) {
      applier = await createSyncApplier({ root: this.root, bindingId: this.bindingId, projectId: this.projectId, check: () => this._check('replan'), signal: this.signal, quotaBytes: this.quotaBytes, readOnly: true });
      const journalFile = path.join(this.applierDirectory, 'transactions', descriptor.requestId, 'journal.json');
      const intentFile = path.join(this.applierDirectory, 'intents', `${descriptor.requestId}.json`);
      if (await exists(journalFile) || await exists(intentFile)) inspection = await applier.inspectRepair(descriptor.requestId, { skipPaths: protectedPaths });
    }
    if (!inspection && this._state.pending.applierStarted || inspection?.orphan && this._state.pending.applierStarted) throw fail('SYNC_JOURNAL_CORRUPT');
    if (inspection) {
      const operations = inspection.journal.operations.map(({ path, expected, desired }) => ({ path, expected, desired }));
      if (canonicalJson(operations) !== canonicalJson(descriptor.plan.operations) || canonicalJson(inspection.journal.remoteReceipt ?? null) !== canonicalJson(this._state.pending.receipt ?? null)) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    const entries = inspection?.entries || await Promise.all(descriptor.plan.operations.map(async (item, index) => ({ ...item, index, phase: 'pending', publishAttempted: false, backupState: null, current: protectedPaths.includes(item.path) ? null : await readSyncFile(this.root, item.path, item.expected ?? item.desired) })));
    return { applier, policy, mandatory, journalDigest: inspection ? sha256(canonicalJson(inspection.journal)) : null, entries };
  }
  _repairPublic(plan) {
    return { id: plan.id, expiresAt: plan.expiresAt, root: this.root, projectId: this.projectId, pendingRequestId: plan.pendingRequestId, summary: clone(plan.summary), paths: plan.entries.map(item => ({ path: item.path, action: item.action, ambiguous: item.ambiguous, excluded: item.excluded, protected: item.protected, backupAvailable: item.backupState !== null, ...(item.priorRestore ? { restoredPreviously: true } : {}) })), ...(plan.supersedes ? { supersedesRequestId: plan.supersedes.requestId } : {}) };
  }
  /** Explicit, read-only project preview. Only this plugin's plan file is written. */
  async prepareReplan() {
    if (this._active) throw fail('BUSY'); this._active = true;
    try {
      await this._check('replan');
      return await this.store.exclusive(async () => {
        await this._load();
        const previousRepair = this._state.pendingRepair ? clone(this._state.pendingRepair) : null;
        if (!this._state.pending || !['local-partial', 'policy-retired', 'remote-accepted', 'committing', 'commit-uncertain'].includes(this._state.pending.phase)) throw fail('SYNC_REPAIR_UNAVAILABLE');
        const descriptor = await this._descriptor(), proof = await this._repairProof(descriptor), view = await this._repairInspection(descriptor);
        let priorPlan;
        if (previousRepair) {
          const stored = await this._loadRepairPlan(previousRepair.planId); priorPlan = stored.plan;
          if (stored.digest !== previousRepair.planDigest || priorPlan.pendingRequestId !== descriptor.requestId || priorPlan.descriptorHash !== this._state.pending.descriptorHash || priorPlan.fingerprint !== this._repairFingerprint() || previousRepair.steps.length !== descriptor.plan.operations.length || priorPlan.entries.length !== descriptor.plan.operations.length || priorPlan.entries.some((entry, index) => entry.path !== descriptor.plan.operations[index].path) || !this._state.authorizationDigests.includes(previousRepair.identityDigest)) throw fail('SYNC_JOURNAL_CORRUPT');
        }
        const remote = new Map(proof.manifest.files.map(file => [file.path, stateOf(file)]));
        const entries = view.entries.map(item => {
          const protectedPath = view.mandatory.isExcluded(item.path), excluded = view.policy.isExcluded(item.path);
          const verified = item.phase === 'applied' || !protectedPath && equal(item.current, item.desired);
          const restore = !protectedPath && !verified && item.current === null && item.backupState !== null;
          const publishUnknown = !verified && (item.publishAttempted || item.phase === 'publishing' || item.phase === 'blocked' && item.backupState !== null && !equal(item.current, item.expected));
          const oldStep = previousRepair?.steps[item.index], oldEntry = priorPlan?.entries[item.index];
          if (oldStep && ['creating', 'restored', 'ambiguous'].includes(oldStep.phase) && oldEntry?.action !== 'restore') throw fail('SYNC_JOURNAL_CORRUPT');
          const priorRestore = Boolean(oldStep && ['creating', 'restored'].includes(oldStep.phase) && !protectedPath && equal(item.current, oldEntry.backupState));
          const repairUnknown = oldStep?.phase === 'ambiguous' || oldStep?.phase === 'creating' && !priorRestore;
          const projected = restore ? item.backupState : item.current;
          return { ...item, protected: protectedPath, excluded, verified, priorRestore, action: restore ? 'restore' : verified ? 'verified' : 'keep', ambiguous: (publishUnknown || repairUnknown) && (protectedPath || !equal(projected, remote.get(item.path) ?? null)) };
        });
        const plan = { version: 1, id: randomUUID(), bindingId: this.bindingId, projectId: this.projectId, rootIdentity: this._state.rootIdentity, identityDigest: sha256(canonicalJson(this.accountIdentity)), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), pendingRequestId: descriptor.requestId, descriptorHash: this._state.pending.descriptorHash, fingerprint: this._repairFingerprint(), policyHash: view.policy.fingerprint, journalDigest: view.journalDigest, proof, entries, supersedes: previousRepair,
          summary: { restore: entries.filter(item => item.action === 'restore').length, conflicts: entries.filter(item => item.ambiguous || !item.protected && !item.verified && item.action === 'keep' && !equal(item.current, item.expected) && !equal(item.current, remote.get(item.path) ?? null)).length, unchanged: entries.filter(item => item.action !== 'restore').length } };
        await this._check('replan');
        const bytes = Buffer.from(canonicalJson(plan)); if (bytes.length > MAX_STATE_BYTES) throw fail('SYNC_QUOTA');
        await this._space(bytes.length); await writeNewFile(this._repairPlanPath(plan.id), bytes); this._engineBytes += bytes.length;
        return this._repairPublic(plan);
      });
    } catch (error) { throw fail(safeCode(error)); }
    finally { this._active = false; }
  }
  async _loadRepairPlan(id) {
    const { bytes } = await readStableFile(this._repairPlanPath(id), MAX_STATE_BYTES);
    let plan; try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('SYNC_JOURNAL_CORRUPT'); }
    if (!object(plan) || plan.version !== 1 || plan.id !== id || plan.bindingId !== this.bindingId || plan.projectId !== this.projectId || canonicalJson(rootRecord(plan.rootIdentity, this.root)) !== canonicalJson(this._state.rootIdentity) || !Array.isArray(plan.entries) || plan.entries.length > MAX_SYNC_ENTRIES || !Number.isFinite(Date.parse(plan.expiresAt))) throw fail('SYNC_JOURNAL_CORRUPT');
    validateId(plan.pendingRequestId); validateBlobHash(plan.descriptorHash); validateBlobHash(plan.fingerprint); validateBlobHash(plan.policyHash); validateBlobHash(plan.identityDigest);
    if (!object(plan.proof)) throw fail('SYNC_JOURNAL_CORRUPT');
    plan.proof.head = headRecord(plan.proof.head, this.projectId); plan.proof.receipt = headRecord(plan.proof.receipt, this.projectId);
    plan.proof.manifest = validateSyncManifest(plan.proof.manifest);
    if (!plan.proof.head || !plan.proof.receipt || plan.proof.manifest.id !== plan.proof.head.id || syncManifestDigest(plan.proof.manifest) !== plan.proof.head.manifestDigest) throw fail('SYNC_JOURNAL_CORRUPT');
    for (const [index, item] of plan.entries.entries()) {
      validateSyncPath(item.path); validateFileState(item.expected); validateFileState(item.desired); validateFileState(item.current); validateFileState(item.backupState);
      if (item.index !== index || !['restore', 'keep', 'verified'].includes(item.action) || ['ambiguous', 'excluded', 'protected', 'verified'].some(field => typeof item[field] !== 'boolean') || item.action === 'restore' && (item.protected || item.current !== null || item.backupState === null)) throw fail('SYNC_JOURNAL_CORRUPT');
    }
    return { plan, digest: sha256(bytes) };
  }
  async _repairGuard(plan, idle = false) {
    await this._check('replan');
    if ((await this._policy()).fingerprint !== plan.policyHash) throw fail('SYNC_POLICY_CHANGED');
    if (idle && !(await this.isIdle())) throw fail('SYNC_NOT_IDLE');
  }
  /** Durable read-only outcome lookup, including during another instance's work.
   * Never infer acceptance from an in-memory intent before its atomic save. */
  async repairOutcome(requestId) {
    validateId(requestId);
    try {
      await this._check('repair-outcome');
      if (!(await exists(this.filename))) {
        if (await exists(this.engineDirectory) || await exists(this.applierDirectory)) throw fail('SYNC_JOURNAL_CORRUPT');
        await syncRootIdentity(this.root); return { state: 'not-accepted' };
      }
      let state;
      try { state = this._validateState(await readJson(this.filename)); }
      catch (error) { const code = safeCode(error); throw fail(code === 'SYNC_FAILED' ? 'SYNC_JOURNAL_CORRUPT' : code); }
      await verifySyncRoot(state.rootIdentity);
      const receipt = state.repairReceipts.find(item => item.requestId === requestId);
      if (receipt) return { state: receipt.result.superseded ? 'superseded' : 'completed', result: repairResult(receipt.result) };
      return { state: state.pendingRepair?.requestId === requestId ? 'pending' : 'not-accepted' };
    } catch (error) { throw fail(safeCode(error)); }
  }
  /** Durable exact-request repair. Never retries old apply writes or uploads data. */
  async confirmReplan({ planId, requestId }) {
    validateId(planId); validateId(requestId); if (this._active) throw fail('BUSY'); this._active = true;
    try {
      await this._check('replan');
      return await this.store.exclusive(async () => {
        await this._load(); const { plan, digest } = await this._loadRepairPlan(planId);
        const completed = this._state.repairReceipts.find(item => item.requestId === requestId);
        if (completed) {
          if (completed.planId !== planId || completed.planDigest !== digest) throw fail('SYNC_REQUEST_CONFLICT');
          return clone(completed.result);
        }
        const activeRepair = this._state.pendingRepair;
        const accepted = activeRepair?.requestId === requestId ? activeRepair : null;
        if (accepted && (accepted.planId !== planId || accepted.planDigest !== digest)) throw fail('SYNC_REQUEST_CONFLICT');
        const superseding = !accepted && activeRepair && plan.supersedes && canonicalJson(activeRepair) === canonicalJson(plan.supersedes);
        if (activeRepair && !accepted && !superseding) throw fail('SYNC_REPAIR_INCOMPLETE');
        if (!activeRepair && plan.supersedes) throw fail('SYNC_REPAIR_CHANGED');
        if (!this._state.authorizationDigests.includes(plan.identityDigest) || !accepted && plan.identityDigest !== sha256(canonicalJson(this.accountIdentity))) throw fail('SYNC_BINDING_MISMATCH');
        if (!accepted && Date.parse(plan.expiresAt) <= Date.now()) throw fail('SYNC_REPAIR_EXPIRED');
        if (!this._state.pending || this._state.pending.requestId !== plan.pendingRequestId || this._state.pending.descriptorHash !== plan.descriptorHash || this._repairFingerprint() !== plan.fingerprint) throw fail('SYNC_REPAIR_CHANGED');
        await this._repairGuard(plan);
        const descriptor = await this._descriptor(), proof = await this._repairProof(descriptor), view = await this._repairInspection(descriptor);
        if (view.journalDigest !== plan.journalDigest || view.entries.length !== plan.entries.length || canonicalJson(proof.receipt) !== canonicalJson(plan.proof.receipt)) throw fail('SYNC_REPAIR_CHANGED');
        if (!accepted && canonicalJson(proof.head) !== canonicalJson(plan.proof.head)) throw fail('SYNC_REPAIR_CHANGED');
        for (const [index, current] of view.entries.entries()) {
          const expected = plan.entries[index], step = accepted?.steps[index];
          if (current.path !== expected.path || !equal(current.backupState, expected.backupState) || canonicalJson({ expected: current.expected, desired: current.desired }) !== canonicalJson({ expected: expected.expected, desired: expected.desired })) throw fail('SYNC_REPAIR_CHANGED');
          // An admitted exclusive-create may have completed or left a partial
          // file. Resume never overwrites either; a differing value is tainted.
          if ((!step || step.phase === 'pending') && !expected.protected && !equal(current.current, expected.current)) throw fail('SYNC_REPAIR_CHANGED');
        }
        if (this._state.retired.length >= 1000 || this._state.repairReceipts.length + (superseding ? 2 : 1) > 1000) throw fail('SYNC_QUOTA');
        await this._space(plan.entries.filter(item => item.action === 'restore').reduce((sum, item) => sum + item.backupState.size, 0) + 4096);
        await this._repairGuard(plan); // Fresh policy/authority after remote proof and quota I/O, before acceptance.
        if (!accepted) {
          const beforeAcceptance = clone(this._state);
          if (superseding) this._state.repairReceipts.push({ requestId: activeRepair.requestId, planId: activeRepair.planId, planDigest: activeRepair.planDigest, outcomes: clone(activeRepair.steps), result: { state: 'superseded', superseded: true, requestId: activeRepair.requestId, planId: activeRepair.planId, supersededBy: requestId } });
          this._state.pendingRepair = { requestId, planId, planDigest: digest, identityDigest: plan.identityDigest, steps: plan.entries.map(item => ({ index: item.index, phase: 'pending' })) };
          try { await this._save(); } catch (error) { this._state = beforeAcceptance; throw error; }
          await this.fault('repair-accepted', plan);
        }
        const progress = this._state.pendingRepair;
        for (const item of plan.entries) {
          const step = progress.steps[item.index]; if (['restored', 'kept', 'ambiguous'].includes(step.phase)) continue;
          await this._repairGuard(plan, item.action === 'restore');
          if (item.action !== 'restore') { step.phase = 'kept'; await this._save(); continue; }
          const current = await readSyncFile(this.root, item.path, item.backupState);
          if (step.phase === 'creating' && current !== null) {
            step.phase = equal(current, item.backupState) ? 'restored' : 'ambiguous'; await this._save(); continue;
          }
          if (current !== null) throw fail('SYNC_REPAIR_CHANGED');
          if (!view.applier) throw fail('SYNC_JOURNAL_CORRUPT');
          const backup = await view.applier.readRecycled(descriptor.requestId, item.index);
          if (backup.path !== item.path || !equal(backup.state, item.backupState)) throw fail('SYNC_INTEGRITY');
          step.phase = 'creating'; await this._save(); await this.fault('repair-before-restore', plan, item);
          await this._repairGuard(plan, true);
          const target = path.join(this.root, ...item.path.split('/'));
          try { await writeNewFile(target, backup.bytes, backup.state.executable); }
          catch (error) { if (error.code === 'EEXIST') throw fail('SYNC_REPAIR_CHANGED'); throw error; }
          await this.fault('repair-after-restore', plan, item);
          await this._repairGuard(plan);
          if (!equal(await readSyncFile(this.root, item.path, item.backupState), item.backupState)) { step.phase = 'ambiguous'; await this._save(); throw fail('SYNC_REPAIR_INCOMPLETE'); }
          step.phase = 'restored'; await this._save();
        }
        await this._repairGuard(plan); await this.fault('repair-before-finalize', plan);
        const bases = new Map(this._state.bases.map(item => [item.path, clone(item)])), operations = new Map(descriptor.plan.operations.map(item => [item.path, item]));
        for (const item of descriptor.plan.adoptions) if (!operations.has(item.path)) bases.set(item.path, clone(item));
        for (const item of descriptor.plan.frozen) bases.set(item.path, clone(item));
        const currentRemote = new Map(proof.manifest.files.map(file => [file.path, stateOf(file)]));
        let conflicts = 0;
        for (const item of plan.entries) {
          const step = progress.steps[item.index];
          if (item.verified) bases.set(item.path, { path: item.path, state: item.desired });
          let ambiguous = item.ambiguous || step.phase === 'ambiguous';
          if (ambiguous && !item.protected && equal(await readSyncFile(this.root, item.path, item.backupState ?? item.expected ?? item.desired), currentRemote.get(item.path) ?? null)) ambiguous = false;
          if (ambiguous) { const base = bases.get(item.path) ?? { path: item.path, state: null }; bases.set(item.path, { ...base, ambiguous: true }); conflicts++; }
          else if (!item.protected && !item.verified && item.action === 'keep') {
            const current = await readSyncFile(this.root, item.path, item.expected);
            if (!equal(current, item.expected) && !equal(current, currentRemote.get(item.path) ?? null)) conflicts++;
          }
        }
        const result = { state: 'replanned', planId, requestId, retiredRequestId: descriptor.requestId, summary: { restore: progress.steps.filter(item => item.phase === 'restored').length, conflicts, unchanged: progress.steps.filter(item => item.phase !== 'restored').length } };
        const next = clone(this._state);
        next.retired.push({ requestId: descriptor.requestId, descriptorHash: next.pending.descriptorHash, reason: 'SYNC_REPLANNED', receipt: proof.receipt, repairRequestId: requestId });
        next.bases = [...bases.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
        next.repairReceipts.push({ requestId, planId, planDigest: digest, result, outcomes: progress.steps.map(item => ({ ...item })) });
        next.pending = null; next.pendingRepair = null; next.lastCheckedAt = now(); next.remote = { head: proof.head, manifest: proof.manifest };
        next.lastResult = { state: conflicts ? 'conflicted' : 'idle', pendingUpload: 0, pendingDownload: 0, conflicts: Math.max(conflicts, proof.manifest.conflicts.length) };
        // This single durable replacement retires authority AND advances only
        // proven bases/taint/outcomes. Never clear the pending pointer first.
        await this._repairGuard(plan); // Do not retire authority under a policy changed during final checks.
        const before = this._state; this._state = next;
        try { await this._save(); } catch (error) { this._state = before; throw error; }
        await this.fault('repair-finalized', plan); return result;
      });
    } catch (error) {
      const code = safeCode(error), accepted = this._state?.pendingRepair?.requestId === requestId || this._state?.repairReceipts.some(item => item.requestId === requestId);
      throw fail(code === 'SYNC_FAILED' && accepted ? 'SYNC_REPAIR_INCOMPLETE' : code);
    } finally { this._active = false; }
  }
  /** Host calls after an explicitly authorized resolution CAS, never as an apply
   * shortcut. The preserved local state guards the subsequent ordinary run. */
  async acknowledgeResolution({ receipt, conflictId, path: relative, expectedLocal }) {
    if (this._active) throw fail('BUSY');
    const claimed = headRecord(receipt, this.projectId), name = validateSyncPath(relative), expected = validateFileState(expectedLocal);
    validateBlobHash(conflictId); if (!claimed?.requestId) throw fail('SYNC_INTEGRITY');
    const digest = sha256(canonicalJson({ receipt: claimed, conflictId, path: name, expectedLocal: expected }));
    this._active = true;
    try {
      await this._check('resolution');
      return await this.store.exclusive(async () => {
        await this._load(); await this._check('resolution');
        const prior = this._state.resolutionReceipts.find(item => item.requestId === claimed.requestId);
        if (prior) { if (prior.digest !== digest) throw fail('SYNC_INTEGRITY'); return { acknowledged: true, duplicate: true }; }
        if (this._state.pending) throw fail('SYNC_APPLY_INCOMPLETE');
        if (this._state.resolutionReceipts.length >= 1000) throw fail('SYNC_QUOTA');
        const client = await this._connect(), verified = headRecord(await client.syncReceipt(this.projectId, claimed.requestId), this.projectId);
        if (canonicalJson(verified) !== canonicalJson(claimed)) throw fail('SYNC_INTEGRITY');
        const manifest = validateSyncManifest(await client.syncCheckpoint(this.projectId, claimed.id, claimed.manifestDigest));
        if (manifest.deviceId !== this.accountIdentity.deviceId || !manifest.parentId || manifest.conflicts.some(item => item.path === name)) throw fail('SYNC_CONFLICT_CHANGED');
        const previous = await client.syncCheckpoint(this.projectId, manifest.parentId);
        if (!previous.conflicts.some(item => item.id === conflictId && item.path === name)) throw fail('SYNC_CONFLICT_CHANGED');
        await this._check('resolution');
        const bases = new Map(this._state.bases.map(item => [item.path, item]));
        bases.set(name, { path: name, state: bases.get(name)?.state ?? null, conflictId, preservedState: expected });
        this._state.bases = [...bases.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
        this._state.resolutionReceipts.push({ requestId: claimed.requestId, digest });
        if (!this._state.remote || claimed.revision >= this._state.remote.head.revision) this._state.remote = { head: claimed, manifest };
        this._state.lastCheckedAt = now(); await this._save();
        return { acknowledged: true, duplicate: false };
      });
    } finally { this._active = false; }
  }
  /** Called ONLY after explicit Host resume consent. Never renew credentials here. */
  async reauthorize(nextIdentity) {
    if (this._active) throw fail('BUSY');
    const next = identity(nextIdentity), prior = this.accountIdentity;
    if (['server', 'serverId', 'username', 'deviceId'].some(field => next[field] !== prior[field]) || next.authorizationEpoch < prior.authorizationEpoch) throw fail('SYNC_BINDING_MISMATCH');
    this._active = true;
    try {
      this.signal?.throwIfAborted();
      await this.check({ phase: 'reauthorize', bindingId: this.bindingId, projectId: this.projectId, root: this.root, accountIdentity: clone(prior), nextAccountIdentity: clone(next) });
      return await this.store.exclusive(async () => {
        this._engineBytes = undefined;
        const stored = await readJson(this.filename);
        if (canonicalJson(stored.accountIdentity) !== canonicalJson(prior) && canonicalJson(stored.accountIdentity) !== canonicalJson(next)) throw fail('SYNC_BINDING_MISMATCH');
        this.accountIdentity = identity(stored.accountIdentity); this._state = this._validateState(stored);
        await verifySyncRoot(this._state.rootIdentity);
        const digest = sha256(canonicalJson(next));
        if (!this._state.authorizationDigests.includes(digest)) {
          if (this._state.authorizationDigests.length >= 1000) throw fail('SYNC_QUOTA');
          this._state.authorizationDigests.push(digest);
        }
        this.accountIdentity = next; this._state.accountIdentity = clone(next);
        await this._save(); return { reauthorized: true, authorizationEpoch: next.authorizationEpoch };
      });
    } catch (error) {
      // Preserve an already durable next identity even if operation-lock cleanup
      // failed; a duplicate explicit resume is safe and never rewrites proposals.
      try {
        const disk = await readJson(this.filename);
        this.accountIdentity = canonicalJson(disk.accountIdentity) === canonicalJson(next) ? next : prior;
        this._state = this._validateState(disk);
      } catch { this.accountIdentity = prior; this._state = null; }
      throw error;
    } finally { this._active = false; }
  }
  async status() {
    if (this._active) return this._public();
    if (!(await exists(this.filename))) return this._public(null);
    const state = this._validateState(await readJson(this.filename));
    await verifySyncRoot(state.rootIdentity); return this._public(state);
  }
  async conflicts() {
    await this._check('conflicts');
    const state = this._active ? this._state : await exists(this.filename) ? this._validateState(await readJson(this.filename)) : null;
    if (state) await verifySyncRoot(state.rootIdentity);
    return clone(state?.remote?.manifest.conflicts || []);
  }
  async recycle() {
    if (this._active) throw fail('BUSY');
    await this._check('recycle');
    if (!(await exists(this.applierDirectory))) return [];
    if (!this._state && await exists(this.filename)) this._state = this._validateState(await readJson(this.filename));
    const applier = await this._applier(null, false); return applier.recycle();
  }
}
export function createSyncEngine(options) { return new SyncEngine(options); }
