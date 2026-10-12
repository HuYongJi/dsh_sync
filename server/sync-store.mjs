import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { assert, sha256, validateId, validateBlobHash } from '../src/protocol.mjs';
import { ensurePrivateDirectory, readStableFile } from '../src/files.mjs';
import {
  canonicalJson, validateSyncManifest, validateSyncTransition, validateResolutions,
  referencedBlobs, MAX_MANIFEST_BYTES, MAX_SYNC_ENTRIES, MAX_SYNC_PAGE_SIZE,
} from '../src/sync-protocol.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = MAX_MANIFEST_BYTES;
const MAX_HEAD_BYTES = 4096;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => sha256(Buffer.from(canonicalJson(value)));
const projectKey = id => sha256(Buffer.from(id));
const clone = value => structuredClone(value);
const problem = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const corrupt = () => problem(500, 'Sync project integrity error', 'SYNC_PROJECT_CORRUPT');
function exact(value, keys, name) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), `Invalid ${name}`);
  assert(Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key)), `Invalid ${name} fields`);
}
function revision(value, name = 'revision') {
  assert(Number.isSafeInteger(value) && value >= 0, `Invalid ${name}`); return value;
}
function headId(value) { return value === null ? null : validateId(value); }
function legacyHeads(value) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= MAX_SYNC_ENTRIES, 'Invalid complete legacy head set');
  const heads = value.map(validateId).sort(compare);
  assert(new Set(heads).size === heads.length, 'Duplicate legacy head'); return heads;
}
function publicHead(head) {
  const { projectId, id, revision, manifestDigest, recordHash } = head;
  return { projectId, id, revision, manifestDigest, recordHash };
}
function resultFor(entry) {
  const { projectId, id, revision, manifestDigest, requestId } = entry.record;
  return { projectId, id, revision, manifestDigest, recordHash: entry.hash, requestId };
}
function normalizedRequest(input, migrating) {
  assert(input !== null && typeof input === 'object' && !Array.isArray(input), 'Invalid commit request');
  const allowed = ['manifest', 'expectedHeadRevision', 'expectedRevision', 'expectedHeadId', 'requestId', 'resolutions', ...(migrating ? ['expectedLegacyHeads'] : [])];
  assert(Object.keys(input).every(key => allowed.includes(key)), 'Invalid commit request fields');
  const manifest = validateSyncManifest(input.manifest);
  if (input.expectedHeadRevision !== undefined && input.expectedRevision !== undefined) assert(input.expectedHeadRevision === input.expectedRevision, 'Conflicting expected revision aliases');
  const expectedHeadRevision = revision(input.expectedHeadRevision ?? input.expectedRevision, 'expected head revision');
  const expectedHeadId = headId(input.expectedHeadId), requestId = validateId(input.requestId), resolutions = validateResolutions(input.resolutions ?? []);
  assert((expectedHeadRevision === 0) === (expectedHeadId === null), 'Expected head id and revision disagree');
  const migration = migrating ? { legacyHeads: legacyHeads(input.expectedLegacyHeads) } : null;
  return { manifest, expectedHeadRevision, expectedHeadId, requestId, resolutions, migration };
}
function requestDigest(request) { return digest(request); }
function validateHead(input, key) {
  exact(input, ['version', 'projectId', 'id', 'revision', 'manifestDigest', 'recordHash'], 'head');
  assert(input.version === 2 && revision(input.revision) > 0, 'Invalid head version/revision');
  validateId(input.projectId); validateId(input.id); validateBlobHash(input.manifestDigest); validateBlobHash(input.recordHash);
  assert(projectKey(input.projectId) === key, 'Project directory mismatch');
  return input;
}
function validateRecord(input, id) {
  exact(input, ['version', 'projectId', 'revision', 'id', 'manifestDigest', 'previousRecordHash', 'requestId', 'requestDigest', 'expectedHeadRevision', 'expectedHeadId', 'resolutions', 'migration'], 'commit record');
  assert(input.version === 2 && input.projectId === id && revision(input.revision) > 0, 'Invalid commit project/version/revision');
  validateId(input.id); validateId(input.requestId); validateBlobHash(input.manifestDigest); validateBlobHash(input.requestDigest);
  if (input.previousRecordHash !== null) validateBlobHash(input.previousRecordHash);
  assert(revision(input.expectedHeadRevision) === input.revision - 1, 'Invalid commit expected revision');
  headId(input.expectedHeadId);
  assert((input.revision === 1) === (input.previousRecordHash === null) && (input.revision === 1) === (input.expectedHeadId === null), 'Invalid chain origin');
  assert(canonicalJson(input.resolutions) === canonicalJson(validateResolutions(input.resolutions)), 'Noncanonical resolutions');
  if (input.migration !== null) {
    exact(input.migration, ['legacyHeads'], 'migration provenance');
    assert(input.revision === 1 && canonicalJson(input.migration.legacyHeads) === canonicalJson(legacyHeads(input.migration.legacyHeads)), 'Invalid migration provenance');
  }
  return input;
}
async function readCanonical(filename, limit, expectedDigest) {
  const { bytes } = await readStableFile(filename, limit);
  if (expectedDigest !== undefined && sha256(bytes) !== expectedDigest) throw corrupt();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
  if (canonicalJson(value) !== text) throw corrupt();
  return { value, text };
}
async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch { /* Windows directory fsync is best effort; a published head is committed. */ }
  finally { await handle?.close().catch(() => {}); }
}
async function temporaryFile(directory, text) {
  const filename = path.join(directory, `.write-${randomBytes(20).toString('hex')}.tmp`);
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  catch (error) { await handle.close().catch(() => {}); await fs.unlink(filename).catch(() => {}); throw error; }
  await handle.close(); return filename;
}
async function immutableWrite(filename, text) {
  // Publish an already fsynced complete inode without ever overwriting a name.
  const temporary = await temporaryFile(path.dirname(filename), text);
  try {
    try { await fs.link(temporary, filename); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const { bytes } = await readStableFile(filename, Math.max(MAX_MANIFEST_BYTES, MAX_RECORD_BYTES));
      if (!bytes.equals(Buffer.from(text))) throw corrupt();
    }
  } finally { await fs.unlink(temporary).catch(() => {}); }
  await syncDirectory(path.dirname(filename));
}
async function publishHead(filename, text, committed) {
  const temporary = await temporaryFile(path.dirname(filename), text);
  try {
    await fs.rename(temporary, filename);
    // No await/fallible work between the sole commit point and the in-memory view.
    committed();
    await syncDirectory(path.dirname(filename));
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

/**
 * Open an independent v2 store under directory. No HTTP, auth database, or GC.
 * The caller owns the process/storage lock and MUST inject its global exclusive(task)
 * callback shared by legacy writes, migrations, token revocations and v2 commits.
 * verifyBlob({hash,size,executable?}) must check actual bytes and reject missing,
 * size-mismatched or hash-mismatched blobs. All historical references are checked
 * while opening; all references in each new commit are checked before publication.
 *
 * Methods (all async):
 * head(projectId) -> null | {projectId,id,revision,manifestDigest,recordHash}
 * list({limit=100,cursor=null}) -> {projects:[head | {projectId,projectKey,corrupt:true}],nextCursor}
 * changes(projectId,{afterRevision=0,untilRevision?,limit=100})
 *   -> {changes:[receipt + parentId,deviceId,policyRevision,migration],untilRevision,nextAfterRevision}
 * getCheckpoint(projectId,id) -> manifest (404 if not committed)
 * receipt(projectId,requestId) -> original receipt | null
 * commit({manifest,expectedHeadRevision,expectedHeadId,requestId,resolutions=[]}, trusted)
 * migrate(commitRequest + {expectedLegacyHeads:[id]}, trusted + {checkLegacyHeads})
 *   -> {projectId,id,revision,manifestDigest,recordHash,requestId}
 * trusted = {authenticatedDeviceId,beforeCommit}; beforeCommit() is mandatory,
 * called inside the lock on replay and again immediately before fresh publication.
 * checkLegacyHeads(projectId,expectedHeads) returns the COMPLETE current legacy
 * head-ID array inside that same lock; migration compares it, not a selected subset.
 * expectedRevision is an alias for expectedHeadRevision. Migrations require 0/null.
 *
 * Layout: projects/<sha256(projectId)>/{head.json,manifests/<sha256(id)>-<digest>.json,
 * records/<recordHash>.json}. Only head.json commits. Orphans are never listed,
 * reused ids never overwrite files, and the reachable chain rebuilds all indexes.
 * List cursors are stable lexicographic project hashes (not snapshot isolation).
 * History pagination fixes untilRevision; revisions are strictly project-local.
 */
export async function createSyncStore({ directory, exclusive, verifyBlob } = {}) {
  if (typeof directory !== 'string' || !directory || typeof exclusive !== 'function' || typeof verifyBlob !== 'function') throw new TypeError('directory, global exclusive callback and verifyBlob callback are required');
  const root = path.resolve(directory), projectDirectory = path.join(root, 'projects');
  const projects = new Map(), writing = new Set();
  const directoryFor = key => path.join(projectDirectory, key);
  const headPath = key => path.join(directoryFor(key), 'head.json');
  const recordPath = (key, hash) => path.join(directoryFor(key), 'records', `${hash}.json`);
  const manifestPath = (key, id, hash) => path.join(directoryFor(key), 'manifests', `${projectKey(id)}-${hash}.json`);
  function failProject(key, id) { projects.set(key, { key, projectId: id ?? projects.get(key)?.projectId ?? null, corrupt: true }); throw corrupt(); }
  async function verifyManifestBlobs(manifest, checked = new Map()) {
    for (const file of referencedBlobs(manifest)) {
      if (checked.get(file.hash) === file.size) continue;
      const result = await verifyBlob(clone(file));
      if (result === false) throw problem(409, 'Referenced blob failed verification');
      checked.set(file.hash, file.size);
    }
  }
  async function readManifest(key, record) {
    const { value, text } = await readCanonical(manifestPath(key, record.id, record.manifestDigest), MAX_MANIFEST_BYTES, record.manifestDigest);
    const manifest = validateSyncManifest(value);
    if (manifest.projectId !== record.projectId || manifest.id !== record.id || manifest.parentId !== record.expectedHeadId || canonicalJson(manifest) !== text) throw corrupt();
    const request = { manifest, expectedHeadRevision: record.expectedHeadRevision, expectedHeadId: record.expectedHeadId, requestId: record.requestId, resolutions: record.resolutions, migration: record.migration };
    if (requestDigest(request) !== record.requestDigest) throw corrupt();
    return manifest;
  }
  async function openProject(key) {
    let pointer;
    try { pointer = await readCanonical(headPath(key), MAX_HEAD_BYTES); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const head = validateHead(pointer.value, key), records = [], byId = new Map(), byRequest = new Map(), visited = new Set(), checked = new Map();
    let hash = head.recordHash, child = null, childManifest = null;
    while (hash !== null) {
      if (visited.has(hash)) throw corrupt(); visited.add(hash);
      const { value } = await readCanonical(recordPath(key, hash), MAX_RECORD_BYTES, hash);
      const record = validateRecord(value, head.projectId), manifest = await readManifest(key, record);
      if (byId.has(record.id) || byRequest.has(record.requestId)) throw corrupt();
      if (child) {
        if (child.revision !== record.revision + 1 || child.expectedHeadId !== record.id) throw corrupt();
        validateSyncTransition(manifest, childManifest, { resolutions: child.resolutions });
      } else if (record.revision !== head.revision || record.id !== head.id || record.manifestDigest !== head.manifestDigest) throw corrupt();
      await verifyManifestBlobs(manifest, checked);
      const entry = { hash, record, deviceId: manifest.deviceId, policyRevision: manifest.policyRevision };
      records.push(entry); byId.set(record.id, entry); byRequest.set(record.requestId, entry);
      child = record; childManifest = manifest; hash = record.previousRecordHash;
    }
    validateSyncTransition(null, childManifest, { resolutions: child.resolutions });
    if (records.length !== head.revision) throw corrupt();
    records.reverse();
    return { key, projectId: head.projectId, head, headText: pointer.text, records, byId, byRequest, corrupt: false };
  }
  // Isolate corruption to the hashed project, including a head that cannot reveal its id.
  await exclusive(async () => {
    await ensurePrivateDirectory(root); await ensurePrivateDirectory(projectDirectory);
    for (const entry of await fs.readdir(projectDirectory, { withFileTypes: true })) {
      if (!HASH.test(entry.name)) continue; // Temp/uncommitted debris is not a project index.
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw corrupt();
        const project = await openProject(entry.name);
        if (project) projects.set(entry.name, project);
      } catch { projects.set(entry.name, { key: entry.name, projectId: null, corrupt: true }); }
    }
  });

  async function projectFor(id) {
    validateId(id);
    const key = projectKey(id), observed = projects.get(key);
    if (observed?.corrupt) throw corrupt();
    if (writing.has(key)) return observed ?? null;
    // Direct pointer lookup also detects post-open pointer corruption. Reads racing
    // our own atomic replacement use the old or new verified in-memory generation.
    try {
      const pointer = await readCanonical(headPath(key), MAX_HEAD_BYTES);
      if (writing.has(key) || projects.get(key) !== observed) {
        const latest = projects.get(key); if (latest?.corrupt) throw corrupt(); return latest ?? null;
      }
      if (!observed) {
        const loaded = await openProject(key);
        if (loaded) projects.set(key, loaded);
        return loaded;
      }
      if (pointer.text !== observed.headText) return failProject(key, id);
      return observed;
    } catch (error) {
      if (writing.has(key) || projects.get(key) !== observed) {
        const latest = projects.get(key); if (latest?.corrupt) throw corrupt(); return latest ?? null;
      }
      if (!observed && error.code === 'ENOENT') return null;
      return failProject(key, id);
    }
  }
  async function verifiedEntry(project, entry) {
    try {
      const { value } = await readCanonical(recordPath(project.key, entry.hash), MAX_RECORD_BYTES, entry.hash);
      if (canonicalJson(value) !== canonicalJson(entry.record)) throw corrupt();
      return await readManifest(project.key, entry.record);
    } catch { return failProject(project.key, project.projectId); }
  }
  function pageLimit(limit = 100) { assert(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_SYNC_PAGE_SIZE, 'Invalid page limit'); return limit; }
  async function head(id) { const project = await projectFor(id); return project ? publicHead(project.head) : null; }
  async function list({ limit = 100, cursor = null } = {}) {
    pageLimit(limit); if (cursor !== null) validateBlobHash(cursor);
    const keys = [...projects.keys()].filter(key => cursor === null || key > cursor).sort(compare), selected = keys.slice(0, limit), items = [];
    for (const key of selected) {
      let project = projects.get(key);
      if (!project.corrupt) {
        try { project = await projectFor(project.projectId); } catch { project = projects.get(key); }
      }
      if (project.corrupt) items.push({ projectId: project.projectId, projectKey: key, corrupt: true });
      else items.push(publicHead(project.head));
    }
    return { projects: items, nextCursor: keys.length > selected.length ? selected.at(-1) : null };
  }
  async function changes(id, { afterRevision = 0, untilRevision, limit = 100 } = {}) {
    pageLimit(limit); revision(afterRevision, 'after revision');
    const project = await projectFor(id), current = project?.head.revision ?? 0;
    untilRevision ??= current; revision(untilRevision, 'until revision');
    assert(afterRevision <= untilRevision && untilRevision <= current, 'History revision range is invalid');
    const entries = project ? project.records.slice(afterRevision, Math.min(untilRevision, afterRevision + limit)) : [], items = [];
    for (const entry of entries) {
      await verifiedEntry(project, entry);
      items.push({ ...resultFor(entry), parentId: entry.record.expectedHeadId, deviceId: entry.deviceId, policyRevision: entry.policyRevision, migration: clone(entry.record.migration) });
    }
    const last = entries.at(-1)?.record.revision ?? afterRevision;
    return { changes: items, untilRevision, nextAfterRevision: last < untilRevision ? last : null };
  }
  async function getCheckpoint(id, checkpointId) {
    validateId(checkpointId); const project = await projectFor(id), entry = project?.byId.get(checkpointId);
    if (!entry) throw problem(404, 'Checkpoint not found');
    return clone(await verifiedEntry(project, entry));
  }
  async function receipt(id, requestId) {
    validateId(requestId); const project = await projectFor(id), entry = project?.byRequest.get(requestId);
    if (!entry) return null;
    await verifiedEntry(project, entry); return resultFor(entry);
  }
  async function mutate(input, trusted, migrating) {
    const request = normalizedRequest(input, migrating), { manifest } = request;
    if (!trusted || typeof trusted.beforeCommit !== 'function') throw new TypeError('beforeCommit authentication recheck callback is required');
    const authenticatedDeviceId = validateId(trusted.authenticatedDeviceId);
    if (manifest.deviceId !== authenticatedDeviceId) throw problem(403, 'Checkpoint device does not match the authenticated device');
    if (migrating && typeof trusted.checkLegacyHeads !== 'function') throw new TypeError('checkLegacyHeads callback is required for migration');
    const manifestText = canonicalJson(manifest), manifestDigest = sha256(Buffer.from(manifestText)), bodyDigest = requestDigest(request), key = projectKey(manifest.projectId);
    const recheckAuth = async () => { if (await trusted.beforeCommit() === false) throw problem(401, 'Unauthorized'); };
    return exclusive(async () => {
      await recheckAuth();
      const project = await projectFor(manifest.projectId), priorReceipt = project?.byRequest.get(request.requestId);
      // Request digest, including CAS/resolutions/provenance, is stable across retries.
      // Replay precedes current-head CAS so a lost acknowledgment remains recoverable.
      if (priorReceipt) {
        if (priorReceipt.record.requestDigest !== bodyDigest) throw problem(409, 'Request id already has different committed content');
        await verifiedEntry(project, priorReceipt); return resultFor(priorReceipt);
      }
      if (project?.byId.has(manifest.id)) throw problem(409, 'Checkpoint id is already committed');
      if (request.expectedHeadRevision !== (project?.head.revision ?? 0) || request.expectedHeadId !== (project?.head.id ?? null)) throw problem(409, 'Canonical head compare-and-swap failed', 'SYNC_HEAD_MISMATCH');
      if (migrating && project) throw problem(409, 'Project already has a canonical v2 head');
      if ((project?.head.revision ?? 0) === Number.MAX_SAFE_INTEGER) throw problem(409, 'Project revision exhausted');
      const previous = project ? await verifiedEntry(project, project.records.at(-1)) : null;
      validateSyncTransition(previous, manifest, { resolutions: request.resolutions });
      if (migrating) {
        const actual = await trusted.checkLegacyHeads(manifest.projectId, clone(request.migration.legacyHeads));
        if (!Array.isArray(actual) || canonicalJson([...actual].map(validateId).sort(compare)) !== canonicalJson(request.migration.legacyHeads)) throw problem(409, 'Complete legacy head set changed', 'SYNC_LEGACY_HEAD_MISMATCH');
      }
      await verifyManifestBlobs(manifest);
      const record = {
        version: 2, projectId: manifest.projectId, revision: request.expectedHeadRevision + 1,
        id: manifest.id, manifestDigest, previousRecordHash: project?.head.recordHash ?? null,
        requestId: request.requestId, requestDigest: bodyDigest, expectedHeadRevision: request.expectedHeadRevision,
        expectedHeadId: request.expectedHeadId, resolutions: request.resolutions, migration: request.migration,
      };
      const recordText = canonicalJson(record), recordHash = sha256(Buffer.from(recordText));
      assert(Buffer.byteLength(recordText) <= MAX_RECORD_BYTES, 'Commit record exceeds byte limit');
      const pointer = { version: 2, projectId: manifest.projectId, id: manifest.id, revision: record.revision, manifestDigest, recordHash }, pointerText = canonicalJson(pointer);
      const entry = { hash: recordHash, record, deviceId: manifest.deviceId, policyRevision: manifest.policyRevision };
      const next = {
        key, projectId: manifest.projectId, head: pointer, headText: pointerText, corrupt: false,
        records: [...(project?.records ?? []), entry], byId: new Map(project?.byId), byRequest: new Map(project?.byRequest),
      };
      next.byId.set(manifest.id, entry); next.byRequest.set(request.requestId, entry);
      writing.add(key);
      try {
        await ensurePrivateDirectory(path.join(directoryFor(key), 'manifests'));
        await ensurePrivateDirectory(path.join(directoryFor(key), 'records'));
        await immutableWrite(manifestPath(key, manifest.id, manifestDigest), manifestText);
        await immutableWrite(recordPath(key, recordHash), recordText);
        await recheckAuth();
        await publishHead(headPath(key), pointerText, () => projects.set(key, next));
      } finally { writing.delete(key); }
      return resultFor(entry);
    });
  }
  return Object.freeze({
    head, list, changes, getCheckpoint, receipt,
    commit: (request, trusted) => mutate(request, trusted, false),
    migrate: (request, trusted) => mutate(request, trusted, true),
  });
}
