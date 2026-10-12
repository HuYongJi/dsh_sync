import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, validateId, validateRelativePath, sha256, MAX_MANIFEST_BYTES } from './protocol.mjs';
import { atomicWrite, assertNoSymlinks, ensurePrivateDirectory, readStableFile, writeNewFile } from './files.mjs';
import { captureCheckpoint, readExclusionPolicy } from './snapshot.mjs';
import { validateFileState, fileStateEqual, isProtectedSyncPath, canonicalJson } from './sync-protocol.mjs';

export const DEFAULT_SYNC_QUOTA = 10 * 1024 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const equal = fileStateEqual;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stateOf = (bytes, executable) => ({ hash: sha256(bytes), size: bytes.length, executable });
const sameContent = (a, b) => a === null || b === null ? a === b : a.hash === b.hash && a.size === b.size && (process.platform === 'win32' || a.executable === b.executable);

export async function syncRootIdentity(root) {
  root = await assertNoSymlinks(path.resolve(root));
  const info = await fs.lstat(root, { bigint: true });
  if (!info.isDirectory()) throw fail('SYNC_ROOT_CHANGED');
  return { root, dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}
export async function verifySyncRoot(identity) {
  try {
    const current = await syncRootIdentity(identity.root);
    if (key(current.root) !== key(identity.root) || ['dev', 'ino', 'birthtimeNs'].some(field => current[field] !== identity[field])) throw fail('SYNC_ROOT_CHANGED');
    return current;
  } catch { throw fail('SYNC_ROOT_CHANGED'); }
}
function syncPath(value) {
  validateRelativePath(value);
  if (isProtectedSyncPath(value)) throw fail('SYNC_PROTECTED_PATH');
  return value;
}
export async function readSyncFile(root, relative, portablePrevious = null) {
  syncPath(relative);
  const target = path.join(root, ...relative.split('/'));
  try {
    const read = await readStableFile(target);
    // Windows does not observe a portable POSIX execute bit. Never emit an
    // executable-only edit merely because a peer materialized the file there.
    return stateOf(read.bytes, process.platform === 'win32' ? (portablePrevious?.executable ?? false) : read.executable);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Scan only an already-admitted root. Skipped paths remain UNKNOWN/unmanaged,
 * rather than being mistaken for tracked deletion. All bytes enter a local spool.
 */
export async function scanSyncProject({ root, projectId, deviceId, putBlob, excludedPaths = [], bases = [], signal, check = async () => {} }) {
  await check(); signal?.throwIfAborted();
  const identity = await syncRootIdentity(root);
  const exclusions = { excluded: ['.dsh-syncignore', '**/.dsh-syncignore'], excludedPaths };
  const policy = await readExclusionPolicy(identity.root, exclusions);
  const captured = await captureCheckpoint({ root: identity.root, projectId, deviceId, putBlob, ...exclusions, signal });
  await check(); await verifySyncRoot(identity);
  const afterPolicy = await readExclusionPolicy(identity.root, exclusions);
  if (policy.fingerprint !== afterPolicy.fingerprint) throw fail('SYNC_POLICY_CHANGED');
  const previous = new Map(bases.map(item => [item.path, item.state]));
  const files = captured.manifest.files.map(file => {
    const name = file.path.slice('project/'.length);
    return { path: name, hash: file.sha256, size: file.size, executable: process.platform === 'win32' ? (previous.get(name)?.executable ?? false) : file.executable === true };
  });
  const unknown = captured.skipped.filter(item => item.reason !== 'excluded').map(item => item.path.toLowerCase());
  const isManaged = name => !policy.isExcluded(name) && !unknown.some(item => name.toLowerCase() === item || name.toLowerCase().startsWith(`${item}/`));
  return { rootIdentity: identity, files, policyHash: policy.fingerprint, skipped: captured.skipped, isManaged,
    async verify() {
      signal?.throwIfAborted(); await check(); await verifySyncRoot(identity);
      if ((await readExclusionPolicy(identity.root, exclusions)).fingerprint !== policy.fingerprint) throw fail('SYNC_POLICY_CHANGED');
    } };
}

async function boundedJson(filename) {
  const { bytes } = await readStableFile(filename, MAX_MANIFEST_BYTES * 4);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function treeBytes(directory) {
  let total = 0;
  if (!(await exists(directory))) return 0;
  await assertNoSymlinks(directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    await assertNoSymlinks(target);
    const info = await fs.lstat(target);
    if (info.isDirectory()) total += await treeBytes(target);
    else { if (!info.isFile() || info.nlink !== 1) throw fail('SYNC_METADATA_UNSAFE'); total += info.size; }
    if (!Number.isSafeInteger(total)) throw fail('SYNC_QUOTA');
  }
  return total;
}
function metadataRoot(root, bindingId) {
  validateId(bindingId);
  return path.join(root, '.dsh-sync', 'v2', bindingId);
}
function validateJournal(input, { root, bindingId, projectId }) {
  if (!object(input) || input.version !== 1 || input.bindingId !== bindingId || input.projectId !== projectId || !object(input.rootIdentity) || key(input.rootIdentity.root) !== key(root) || !Array.isArray(input.operations) || input.operations.length > 20_000 || !['prepared', 'applying', 'applied', 'blocked', 'finalized'].includes(input.phase)) throw fail('SYNC_JOURNAL_CORRUPT');
  validateId(input.id);
  for (const field of ['dev', 'ino', 'birthtimeNs']) if (typeof input.rootIdentity[field] !== 'string' || !/^\d+$/.test(input.rootIdentity[field])) throw fail('SYNC_JOURNAL_CORRUPT');
  const seen = new Set();
  for (const [index, item] of input.operations.entries()) {
    syncPath(item.path);
    if (seen.has(item.path.toLowerCase()) || item.index !== index || !['pending', 'preserving', 'preserved', 'publishing', 'applied', 'blocked'].includes(item.phase)) throw fail('SYNC_JOURNAL_CORRUPT');
    seen.add(item.path.toLowerCase());
    validateFileState(item.expected); validateFileState(item.desired);
    if (item.backupState !== undefined && validateFileState(item.backupState) === null) throw fail('SYNC_JOURNAL_CORRUPT');
    if (item.publishAttempted !== undefined && typeof item.publishAttempted !== 'boolean') throw fail('SYNC_JOURNAL_CORRUPT');
  }
  return input;
}

/** Owns ONLY .dsh-sync/v2/<bindingId>. Old restore metadata is left untouched.
 * A durable journal plus exclusive writes preserves old bytes. It is deliberately
 * not marketed as an atomic directory swap or a cross-process filesystem lock.
 */
export async function createSyncApplier({ root, bindingId, projectId, check = async () => {}, signal, quotaBytes = DEFAULT_SYNC_QUOTA, fault = async () => {}, readOnly = false }) {
  validateId(projectId); validateId(bindingId);
  assert(Number.isSafeInteger(quotaBytes) && quotaBytes > 0, 'Invalid sync quota');
  const identity = await syncRootIdentity(root), metadata = metadataRoot(identity.root, bindingId);
  async function admit() { signal?.throwIfAborted(); await check(); await verifySyncRoot(identity); }
  async function privateDirectory(directory) { if (readOnly) throw fail('SYNC_METADATA_READONLY'); await admit(); await ensurePrivateDirectory(directory); await admit(); }
  if (readOnly) { await admit(); await assertNoSymlinks(metadata); if (!(await fs.lstat(metadata)).isDirectory()) throw fail('SYNC_METADATA_UNSAFE'); }
  else await privateDirectory(metadata);
  async function space(additional) {
    await admit();
    if (!Number.isSafeInteger(additional) || additional < 0 || await treeBytes(metadata) + additional > quotaBytes) throw fail('SYNC_QUOTA');
  }
  const transaction = id => path.join(metadata, 'transactions', validateId(id));
  const intentPath = id => path.join(metadata, 'intents', `${validateId(id)}.json`);
  const intentFor = journal => ({ version: 1, id: journal.id, bindingId, projectId, rootIdentity: journal.rootIdentity, remoteReceipt: journal.remoteReceipt ?? null,
    operations: journal.operations.map(({ path, expected, desired, index }) => ({ path, expected, desired, index })) });
  async function ensureIntent(journal) {
    if (readOnly) throw fail('SYNC_METADATA_READONLY');
    const value = intentFor(journal), filename = intentPath(journal.id), bytes = Buffer.from(canonicalJson(value));
    await admit();
    try { await writeNewFile(filename, bytes); }
    catch (error) { if (error.code !== 'EEXIST' || canonicalJson(await boundedJson(filename)) !== canonicalJson(value)) throw fail('SYNC_REQUEST_CONFLICT'); }
  }
  async function orphanJournal(id) {
    // The intent is durable BEFORE mkdir. Without it an arbitrary pre-existing
    // directory is never adopted as our transaction, even if it happens to be empty.
    const owner = await boundedJson(intentPath(id));
    if (!object(owner) || owner.id !== id || Object.keys(owner).some(key => !['version', 'id', 'bindingId', 'projectId', 'rootIdentity', 'remoteReceipt', 'operations'].includes(key))) throw fail('SYNC_JOURNAL_CORRUPT');
    const journal = validateJournal({ ...owner, phase: 'prepared', operations: owner.operations?.map(item => ({ ...item, phase: 'pending' })) }, { root: identity.root, bindingId, projectId });
    await verifySyncRoot(journal.rootIdentity); await admit();
    const directory = transaction(id), desired = new Map(journal.operations.filter(item => item.desired).map(item => [item.desired.hash, item.desired]));
    await assertNoSymlinks(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name); await assertNoSymlinks(target);
      if (entry.name === 'backup' && entry.isDirectory()) {
        if ((await fs.readdir(target)).length) throw fail('SYNC_JOURNAL_CORRUPT');
      } else if (entry.name === 'stage' && entry.isDirectory()) {
        for (const name of await fs.readdir(target)) { const state = desired.get(name); if (!state) throw fail('SYNC_METADATA_UNSAFE'); await verifyBytes(path.join(target, name), state); }
      } else if (/^journal\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(entry.name) && entry.isFile()) {
        const temporary = validateJournal(await boundedJson(target), { root: identity.root, bindingId, projectId });
        if (temporary.phase !== 'prepared' || canonicalJson(intentFor(temporary)) !== canonicalJson(owner)) throw fail('SYNC_JOURNAL_CORRUPT');
      } else throw fail('SYNC_METADATA_UNSAFE');
    }
    return journal;
  }
  async function save(journal) {
    if (readOnly) throw fail('SYNC_METADATA_READONLY');
    await admit();
    await atomicWrite(path.join(transaction(journal.id), 'journal.json'), JSON.stringify(journal));
  }
  async function load(id) {
    await admit();
    return validateJournal(await boundedJson(path.join(transaction(id), 'journal.json')), { root: identity.root, bindingId, projectId });
  }
  async function targetParent(relative) {
    const parent = path.dirname(path.join(identity.root, ...syncPath(relative).split('/')));
    await privateDirectory(parent);
    const info = await fs.lstat(parent, { bigint: true });
    if (String(info.dev) !== identity.dev) throw fail('SYNC_VOLUME_CHANGED');
    return parent;
  }
  async function current(item) { return readSyncFile(identity.root, item.path, item.expected ?? item.desired); }
  async function block(journal, item, code) {
    item.phase = 'blocked'; item.errorCode = code; journal.phase = 'blocked'; journal.errorCode = code;
    await save(journal);
    return { id: journal.id, state: 'blocked', errorCode: code, completed: journal.operations.filter(op => op.phase === 'applied').length, total: journal.operations.length };
  }
  async function verifyBytes(filename, expected) {
    const { bytes } = await readStableFile(filename);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.hash) throw fail('SYNC_INTEGRITY');
    return bytes;
  }
  async function run(journal) {
    validateJournal(journal, { root: identity.root, bindingId, projectId });
    await verifySyncRoot(journal.rootIdentity);
    if (journal.phase === 'finalized' || journal.phase === 'applied') return { id: journal.id, state: 'applied', completed: journal.operations.length, total: journal.operations.length };
    if (journal.phase === 'blocked') return { id: journal.id, state: 'blocked', errorCode: journal.errorCode, completed: journal.operations.filter(op => op.phase === 'applied').length, total: journal.operations.length };
    journal.phase = 'applying'; await save(journal);
    for (const item of journal.operations) {
      if (item.phase === 'applied') continue;
      await admit();
      const directory = transaction(journal.id), target = path.join(identity.root, ...item.path.split('/'));
      const backup = path.join(directory, 'backup', String(item.index));
      const before = await current(item);
      const backupExists = await exists(backup), backupState = item.backupState ?? item.expected;
      if (backupExists) {
        if (backupState === null) throw fail('SYNC_INTEGRITY');
        await verifyBytes(backup, backupState);
        if (!sameContent(backupState, item.expected)) return block(journal, item, 'SYNC_LOCAL_CHANGED');
      }
      if (sameContent(before, item.desired) && (item.expected === null || backupExists || equal(item.expected, item.desired))) {
        // Includes a crash after the final write but before its journal update.
        if (backupExists) await verifyBytes(backup, item.expected);
        item.phase = 'applied'; await save(journal); continue;
      }
      if (backupExists) {
        await verifyBytes(backup, item.expected);
        if (before !== null) return block(journal, item, 'SYNC_LOCAL_CHANGED');
        item.phase = 'preserved'; await save(journal);
      } else if (!sameContent(before, item.expected)) return block(journal, item, 'SYNC_LOCAL_CHANGED');
      else if (item.expected !== null) {
        await targetParent(item.path);
        item.phase = 'preserving'; await save(journal); await fault('before-preserve', journal, item);
        await admit(); await assertNoSymlinks(target);
        // No automatic overwrite rename publishes data into the project. This
        // move saves the actual old object to an exclusively owned transaction.
        if (await exists(backup)) throw fail('SYNC_METADATA_UNSAFE');
        await fs.rename(target, backup);
        let preserved;
        try { preserved = await readStableFile(backup); }
        catch { return block(journal, item, 'SYNC_LOCAL_CHANGED'); }
        item.backupState = stateOf(preserved.bytes, process.platform === 'win32' ? item.expected.executable : preserved.executable);
        await save(journal); await fault('after-preserve', journal, item);
        if (!sameContent(item.backupState, item.expected)) {
          // The source changed between its check and preservation. Put its actual
          // bytes back only if the name is still vacant. Never overwrite a racer.
          try { await admit(); await targetParent(item.path); await writeNewFile(target, preserved.bytes, preserved.executable); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          return block(journal, item, 'SYNC_LOCAL_CHANGED');
        }
        item.phase = 'preserved'; await save(journal);
      }
      if (item.desired !== null) {
        const bytes = await verifyBytes(path.join(directory, 'stage', item.desired.hash), item.desired);
        await targetParent(item.path);
        item.phase = 'publishing'; item.publishAttempted = true; await save(journal); await fault('before-publish', journal, item);
        await admit();
        try { await writeNewFile(target, bytes, item.desired.executable); }
        catch (error) { if (error.code === 'EEXIST') return block(journal, item, 'SYNC_LOCAL_CHANGED'); throw error; }
        await fault('after-publish', journal, item);
      }
      await admit();
      if (!sameContent(await current(item), item.desired)) return block(journal, item, 'SYNC_LOCAL_CHANGED');
      item.phase = 'applied'; await save(journal); await fault('after-operation', journal, item);
    }
    journal.phase = 'applied'; await save(journal);
    return { id: journal.id, state: 'applied', completed: journal.operations.length, total: journal.operations.length };
  }
  return {
    metadata, rootIdentity: identity,
    async prepare({ id = randomUUID(), operations, remoteReceipt }, getBlob) {
      await admit(); validateId(id);
      const directory = transaction(id);
      let journal;
      if (await exists(directory)) {
        journal = await exists(path.join(directory, 'journal.json')) ? await load(id) : await orphanJournal(id);
        const request = operations.map((op, index) => ({ path: op.path, expected: op.expected, desired: op.desired, index }));
        const prior = journal.operations.map(({ path, expected, desired, index }) => ({ path, expected, desired, index }));
        if (canonicalJson(request) !== canonicalJson(prior) || canonicalJson(remoteReceipt ?? null) !== canonicalJson(journal.remoteReceipt ?? null)) throw fail('SYNC_REQUEST_CONFLICT');
        if (journal.phase !== 'prepared') return { id, state: journal.phase };
      } else journal = validateJournal({ version: 1, id, bindingId, projectId, rootIdentity: identity, phase: 'prepared', remoteReceipt, operations: operations.map((op, index) => ({ path: op.path, expected: op.expected, desired: op.desired, index, phase: 'pending' })) }, { root: identity.root, bindingId, projectId });
      const incoming = new Map(journal.operations.filter(item => item.desired).map(item => [item.desired.hash, item.desired]));
      const required = [...incoming.values()].reduce((n, item) => n + item.size, 0) + journal.operations.reduce((n, item) => n + (item.expected?.size ?? 0), 0) + Buffer.byteLength(JSON.stringify(journal)) * 3 + 4096;
      await space(required);
      await ensureIntent(journal);
      if (!(await exists(directory))) { await privateDirectory(path.dirname(directory)); await admit(); await fs.mkdir(directory, { mode: 0o700 }); await fault('transaction-created', journal); }
      await privateDirectory(path.join(directory, 'backup')); await privateDirectory(path.join(directory, 'stage'));
      await save(journal);
      for (const item of incoming.values()) {
        await admit();
        const staged = path.join(directory, 'stage', item.hash);
        if (await exists(staged)) { await verifyBytes(staged, item); continue; }
        const bytes = await getBlob(item.hash, item.size);
        if (!Buffer.isBuffer(bytes) || bytes.length !== item.size || sha256(bytes) !== item.hash) throw fail('SYNC_INTEGRITY');
        await admit(); await writeNewFile(path.join(directory, 'stage', item.hash), bytes);
      }
      await fault('prepared', journal);
      return { id, state: 'prepared' };
    },
    async apply(id) { return run(await load(id)); },
    async finalize(id) { const journal = await load(id); if (journal.phase !== 'applied' && journal.phase !== 'finalized') throw fail('SYNC_APPLY_INCOMPLETE'); journal.phase = 'finalized'; await save(journal); },
    async journal(id) { return structuredClone(await load(id)); },
    /** Read-only evidence for explicit repair; never adopt an unproved backup. */
    async inspectRepair(id, { skipPaths = [] } = {}) {
      await admit(); validateId(id);
      const orphan = !(await exists(path.join(transaction(id), 'journal.json')));
      const journal = orphan ? await orphanJournal(id) : await load(id);
      const skip = new Set(skipPaths), entries = [];
      for (const item of journal.operations) {
        await admit();
        const filename = path.join(transaction(id), 'backup', String(item.index));
        let backupState = null;
        if (await exists(filename)) {
          backupState = item.backupState ?? item.expected;
          if (backupState === null) throw fail('SYNC_INTEGRITY');
          await verifyBytes(filename, backupState);
        }
        const observed = skip.has(item.path) ? null : await current(item);
        if (backupState === null && (item.backupState !== undefined || item.expected !== null && !equal(item.expected, item.desired) && (['preserved', 'publishing', 'applied'].includes(item.phase) || item.publishAttempted === true || item.phase === 'preserving' && !skip.has(item.path) && observed === null))) throw fail('SYNC_INTEGRITY');
        entries.push({ index: item.index, path: item.path, expected: item.expected, desired: item.desired, phase: item.phase,
          publishAttempted: item.publishAttempted === true || item.phase === 'publishing', backupState, current: observed });
      }
      return structuredClone({ journal, entries, orphan });
    },
    async preserveVariants(conflicts, getBlob) {
      for (const conflict of conflicts) {
        if (!/^[a-f0-9]{64}$/.test(conflict.id)) throw fail('SYNC_INTEGRITY');
        const directory = path.join(metadata, 'conflicts', conflict.id);
        await privateDirectory(directory);
        for (const value of conflict.variants) {
          if (value === null) continue;
          const state = validateFileState(value), filename = path.join(directory, state.hash);
          if (await exists(filename)) { await verifyBytes(filename, state); continue; }
          await space(state.size); const bytes = await getBlob(state.hash, state.size);
          if (!Buffer.isBuffer(bytes) || bytes.length !== state.size || sha256(bytes) !== state.hash) throw fail('SYNC_INTEGRITY');
          await admit(); await writeNewFile(filename, bytes);
        }
      }
    },
    async recycle({ verifyContents = true } = {}) {
      const parent = path.join(metadata, 'transactions'), result = [];
      if (!(await exists(parent))) return result;
      await assertNoSymlinks(parent);
      for (const id of await fs.readdir(parent)) {
        if (!(await exists(path.join(transaction(id), 'journal.json')))) { await orphanJournal(id); continue; }
        const journal = await load(id);
        for (const item of journal.operations) {
          if (!item.expected) continue;
          const filename = path.join(transaction(id), 'backup', String(item.index));
          if (!(await exists(filename))) continue;
          const backupState = item.backupState ?? item.expected;
          if (verifyContents) await verifyBytes(filename, backupState);
          else {
            await admit(); await assertNoSymlinks(filename); const info = await fs.lstat(filename);
            if (!info.isFile() || info.nlink !== 1 || info.size !== backupState.size) throw fail('SYNC_INTEGRITY');
          }
          result.push({ transactionId: id, index: item.index, path: item.path, state: backupState, reason: item.desired === null ? 'deleted' : 'replaced' });
        }
      }
      return result;
    },
    async readRecycled(id, index) {
      const journal = await load(id), item = journal.operations[index];
      if (!Number.isSafeInteger(index) || index < 0 || !item?.expected) throw fail('SYNC_RECYCLE_UNAVAILABLE');
      const backupState = item.backupState ?? item.expected;
      return { path: item.path, state: backupState, bytes: await verifyBytes(path.join(transaction(id), 'backup', String(index)), backupState) };
    },
  };
}
