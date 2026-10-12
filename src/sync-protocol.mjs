import { createHash } from 'node:crypto';
import {
  assert, validateId, validateBlobHash, validateRelativePath,
  MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES, MAX_FILES, MAX_MANIFEST_BYTES,
} from './protocol.mjs';

/** V2 is independent of the legacy wire format. File states always include executable. */
export { MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES, MAX_MANIFEST_BYTES };
export const MAX_SYNC_ENTRIES = MAX_FILES;
export const MAX_CONFLICT_VARIANTS = 256;
export const MAX_SYNC_PAGE_SIZE = 200;
const protectedSegments = new Set(['.git', 'node_modules', '.dsh', '.dsh-sync', '.inspection', '.test-tmp', '.venv', 'venv', '__pycache__', '.ssh', '.aws', '.azure', '.gnupg', '.dsh-syncignore']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hashText = text => createHash('sha256').update(text).digest('hex');
const pathKey = value => value.toLowerCase().normalize('NFC');
function record(value, name, keys, optionalKeys = []) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), `Invalid ${name}`);
  if (keys) assert(Object.keys(value).every(key => keys.includes(key) || optionalKeys.includes(key)) && keys.every(key => Object.hasOwn(value, key)), `Invalid ${name} fields`);
}
function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= maximum, `Invalid ${name}`);
  return value;
}

/** Canonical JSON for validated JSON data: lexicographic object keys, no locale dependence. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { assert(Number.isFinite(value), 'Non-finite JSON number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  record(value, 'JSON object');
  return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Mandatory exclusions cannot be overridden by an ignore policy. The ignore file is local-only. */
export function isProtectedSyncPath(relative) {
  return relative.toLowerCase().split('/').some(name => protectedSegments.has(name) || name === '.env' || name.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(name) || /^(?:id_rsa|id_ed25519|\.?credentials(?:\.(?:json|ya?ml))?|\.npmrc|\.netrc|\.pypirc|auth\.json|tokens?\.json)$/.test(name));
}

/** A portable project-relative path, with no special project/ prefix or absolute roots. */
export function validateSyncPath(value) {
  validateRelativePath(value);
  assert(value.isWellFormed() && Buffer.byteLength(value) <= 1024 && value.split('/').every(segment => Buffer.byteLength(segment) <= 255), 'Non-portable UTF-8 path');
  assert(!isProtectedSyncPath(value), 'Protected path cannot be synchronized');
  return value;
}

/** @returns {null | {hash:string,size:number,executable:boolean}} A fresh normalized state. */
export function validateFileState(value) {
  if (value === null) return null;
  record(value, 'file state', ['hash', 'size', 'executable']);
  const hash = validateBlobHash(value.hash), size = integer(value.size, 'file size', MAX_BLOB_BYTES);
  assert(typeof value.executable === 'boolean', 'Invalid executable flag');
  return { hash, size, executable: value.executable };
}
const stateKey = state => canonicalJson(state);
export function fileStateEqual(a, b) { return stateKey(validateFileState(a)) === stateKey(validateFileState(b)); }

/** Stable across union expansion: variants and canonical main do not enter the identifier. */
export function conflictId(projectId, relative, base) {
  return hashText(canonicalJson({ version: 2, projectId: validateId(projectId), path: validateSyncPath(relative), base: validateFileState(base) }));
}

/** Deduplicate and deterministically union arrays of nullable file/deleted variants. */
export function unionVariants(...groups) {
  const states = new Map();
  for (const group of groups) {
    assert(Array.isArray(group) && group.length <= MAX_CONFLICT_VARIANTS, 'Too many conflict variants');
    for (const value of group) { const state = validateFileState(value); states.set(stateKey(state), state); }
  }
  assert(states.size <= MAX_CONFLICT_VARIANTS, 'Too many conflict variants');
  return [...states].sort(([a], [b]) => compare(a, b)).map(([, state]) => state);
}

/**
 * Strict v2 schema (all fields below required; unknown fields rejected except the
 * optional display-only label, a trimmed/NFC/well-formed/control-free <=200-char string):
 * {version:2,id,projectId,deviceId,parentId,policyRevision,
 *  files:[{path,hash,size,executable}], tombstones:[{path,prior:nonNullState}],
 *  conflicts:[{id:conflictId(projectId,path,base),path,base:State,main:State,variants:State[]}],
 *  archiveRefs:[{id,hash,size}]}.
 * Tombstones are retained latest-deletion records, including after recreation.
 * Arrays are canonical sets; no timestamps/absolute roots or per-device heads.
 */
export function validateSyncManifest(input) {
  record(input, 'sync manifest', ['version', 'id', 'projectId', 'deviceId', 'parentId', 'policyRevision', 'files', 'tombstones', 'conflicts', 'archiveRefs'], ['label']);
  let label;
  if (Object.hasOwn(input, 'label')) {
    assert(typeof input.label === 'string' && input.label.isWellFormed() && input.label === input.label.normalize('NFC') && !/[\p{Cc}\p{Cf}]/u.test(input.label), 'Invalid project label');
    label = input.label.trim(); assert(label.length > 0 && label.length <= 200, 'Invalid project label');
  }
  assert(input.version === 2, 'Unsupported sync manifest version');
  const id = validateId(input.id), projectId = validateId(input.projectId), deviceId = validateId(input.deviceId);
  const parentId = input.parentId === null ? null : validateId(input.parentId);
  assert(parentId !== id, 'Checkpoint cannot parent itself');
  const policyRevision = integer(input.policyRevision, 'policy revision');
  for (const key of ['files', 'tombstones', 'conflicts', 'archiveRefs']) assert(Array.isArray(input[key]) && input[key].length <= MAX_SYNC_ENTRIES, `Too many ${key}`);
  let entries = input.files.length + input.tombstones.length + input.conflicts.length + input.archiveRefs.length;
  assert(entries <= MAX_SYNC_ENTRIES, 'Sync manifest exceeds entry limit');
  const paths = new Map(), prefixSpellings = new Map(), hashes = new Map();
  let totalBytes = 0;
  function addState(state) {
    if (state === null) return;
    assert(!hashes.has(state.hash) || hashes.get(state.hash) === state.size, 'Inconsistent blob size');
    if (!hashes.has(state.hash)) {
      hashes.set(state.hash, state.size); totalBytes += state.size;
      assert(totalBytes <= MAX_CHECKPOINT_BYTES, 'Sync manifest exceeds blob byte limit');
    }
  }
  function addPath(value, seen) {
    const name = validateSyncPath(value), key = pathKey(name);
    assert(!seen.has(key), 'Duplicate or case-insensitive path collision'); seen.add(key);
    assert(!paths.has(key) || paths.get(key) === name, 'Case-insensitive path collision'); paths.set(key, name);
    const parts = name.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/'), folded = pathKey(prefix);
      assert(!prefixSpellings.has(folded) || prefixSpellings.get(folded) === prefix, 'Case-insensitive directory spelling collision'); prefixSpellings.set(folded, prefix);
    }
    return name;
  }
  const live = new Map(), filePaths = new Set(), tombstonePaths = new Set(), conflictPaths = new Set(), archives = new Set();
  const files = input.files.map(file => {
    record(file, 'file', ['path', 'hash', 'size', 'executable']);
    const name = addPath(file.path, filePaths), state = validateFileState({ hash: file.hash, size: file.size, executable: file.executable });
    addState(state); live.set(name, state);
    return { path: name, ...state };
  }).sort((a, b) => compare(a.path, b.path));
  const tombstones = input.tombstones.map(item => {
    record(item, 'tombstone', ['path', 'prior']);
    const name = addPath(item.path, tombstonePaths), prior = validateFileState(item.prior);
    assert(prior !== null, 'A tombstone requires a prior file reference'); addState(prior);
    return { path: name, prior };
  }).sort((a, b) => compare(a.path, b.path));
  const conflicts = input.conflicts.map(item => {
    record(item, 'conflict', ['id', 'path', 'base', 'main', 'variants']);
    const name = addPath(item.path, conflictPaths), base = validateFileState(item.base), main = validateFileState(item.main);
    const variants = unionVariants(item.variants);
    assert(variants.length >= 2, 'A conflict requires distinct variants');
    entries += variants.length;
    assert(entries <= MAX_SYNC_ENTRIES, 'Sync manifest exceeds variant entry limit');
    assert(variants.some(state => fileStateEqual(main, state)), 'Conflict main must be a variant');
    assert(fileStateEqual(main, live.get(name) ?? null), 'Conflict main does not match the live file state');
    assert(validateBlobHash(item.id) === conflictId(projectId, name, base), 'Invalid stable conflict identifier');
    addState(base); addState(main); variants.forEach(addState);
    return { id: item.id, path: name, base, main, variants };
  }).sort((a, b) => compare(a.path, b.path));
  const archiveRefs = input.archiveRefs.map(item => {
    record(item, 'archive reference', ['id', 'hash', 'size']);
    const archiveId = validateId(item.id), hash = validateBlobHash(item.hash), size = integer(item.size, 'archive size', MAX_BLOB_BYTES);
    assert(!archives.has(archiveId), 'Duplicate archive identifier'); archives.add(archiveId);
    addState({ hash, size });
    return { id: archiveId, hash, size };
  }).sort((a, b) => compare(a.id, b.id));
  // Historical deletions may be ancestors of a recreated tree (or vice versa).
  // Only materializable live/conflict paths participate in file/directory checks.
  const activePaths = new Set([...filePaths, ...conflictPaths]);
  for (const key of activePaths) {
    const parts = key.split('/'); parts.pop();
    while (parts.length) { assert(!activePaths.has(parts.join('/')), 'File/directory path collision'); parts.pop(); }
  }
  const manifest = { version: 2, id, projectId, deviceId, parentId, policyRevision, files, tombstones, conflicts, archiveRefs, ...(label !== undefined ? { label } : {}) };
  assert(Buffer.byteLength(canonicalJson(manifest)) <= MAX_MANIFEST_BYTES, 'Sync manifest exceeds byte limit');
  return manifest;
}

/** Canonical bytes/digest are independent of input object and set-array ordering. */
export function encodeSyncManifest(manifest) { return Buffer.from(canonicalJson(validateSyncManifest(manifest))); }
export function syncManifestDigest(manifest) { return hashText(encodeSyncManifest(manifest)); }

/** Every referenced blob, including preserved deletion/conflict data and archives (unique by hash). */
export function referencedBlobs(input) {
  const manifest = validateSyncManifest(input), refs = new Map();
  const add = state => { if (state !== null && !refs.has(state.hash)) refs.set(state.hash, { ...state }); };
  manifest.files.forEach(({ path: _path, ...state }) => add(state));
  manifest.tombstones.forEach(item => add(item.prior));
  manifest.conflicts.forEach(item => { add(item.base); add(item.main); item.variants.forEach(add); });
  manifest.archiveRefs.forEach(({ id: _id, ...state }) => add(state));
  return [...refs.values()].sort((a, b) => compare(a.hash, b.hash));
}

/** Explicit resolution envelope; merged new file states as well as existing variants are allowed. */
export function validateResolutions(input = []) {
  assert(Array.isArray(input) && input.length <= MAX_SYNC_ENTRIES, 'Invalid resolutions');
  const seen = new Set();
  return input.map(item => {
    record(item, 'resolution', ['conflictId', 'state']);
    const id = validateBlobHash(item.conflictId);
    assert(!seen.has(id), 'Duplicate conflict resolution'); seen.add(id);
    return { conflictId: id, state: validateFileState(item.state) };
  }).sort((a, b) => compare(a.conflictId, b.conflictId));
}
const liveStates = manifest => new Map(manifest.files.map(({ path: name, ...state }) => [name, state]));

/**
 * Validate a full-state successor. Omission is NEVER a tracked deletion. Tombstones,
 * archives and unresolved conflicts cannot be garbage-collected. Only explicit
 * resolutions may remove a conflict or change its canonical main. Returns the next
 * normalized manifest. Store additionally enforces CAS, auth and blob availability.
 */
export function validateSyncTransition(previous, input, { resolutions = [] } = {}) {
  const next = validateSyncManifest(input), resolved = validateResolutions(resolutions);
  if (previous === null) {
    assert(next.parentId === null, 'Initial checkpoint must have no parent');
    assert(next.tombstones.length === 0, 'Initial checkpoint cannot infer historical tombstones');
    assert(resolved.length === 0, 'No prior conflict to resolve');
    return next;
  }
  const prior = validateSyncManifest(previous);
  assert(prior.projectId === next.projectId && next.parentId === prior.id && next.id !== prior.id, 'Checkpoint must extend the canonical project head');
  assert(next.policyRevision >= prior.policyRevision, 'Policy revision cannot decrease');
  assert(prior.label === undefined || next.label !== undefined, 'Project label cannot be silently omitted');
  const oldLive = liveStates(prior), newLive = liveStates(next);
  const oldTombs = new Map(prior.tombstones.map(item => [item.path, item.prior])), newTombs = new Map(next.tombstones.map(item => [item.path, item.prior]));
  for (const [name, state] of oldLive) {
    if (!newLive.has(name)) assert(newTombs.has(name) && fileStateEqual(newTombs.get(name), state), 'Tracked deletion requires an explicit tombstone matching its prior file');
  }
  for (const [name, state] of oldTombs) {
    assert(newTombs.has(name), 'Prior tombstones cannot be removed');
    if (!fileStateEqual(newTombs.get(name), state)) assert(oldLive.has(name) && !newLive.has(name) && fileStateEqual(newTombs.get(name), oldLive.get(name)), 'Tombstone prior may change only on a new tracked deletion');
  }
  for (const [name, state] of newTombs) {
    if (!oldTombs.has(name)) assert(oldLive.has(name) && !newLive.has(name) && fileStateEqual(state, oldLive.get(name)), 'Tombstone requires a tracked prior deletion');
  }
  const oldConflicts = new Map(prior.conflicts.map(item => [item.id, item])), newConflicts = new Map(next.conflicts.map(item => [item.id, item]));
  const resolutionsById = new Map(resolved.map(item => [item.conflictId, item.state]));
  for (const resolution of resolved) {
    const conflict = oldConflicts.get(resolution.conflictId);
    assert(conflict, 'Resolution refers to an unknown conflict');
    assert(!next.conflicts.some(item => item.path === conflict.path), 'Explicitly resolved conflict must be removed');
    assert(fileStateEqual(newLive.get(conflict.path) ?? null, resolution.state), 'Resolution does not match the resulting live state');
  }
  for (const old of prior.conflicts) {
    if (resolutionsById.has(old.id)) continue;
    const current = newConflicts.get(old.id);
    assert(current && current.path === old.path && fileStateEqual(current.base, old.base), 'Unresolved conflict cannot be removed or replaced');
    assert(fileStateEqual(current.main, old.main), 'Unresolved conflict main cannot change');
    const keys = new Set(current.variants.map(stateKey));
    assert(old.variants.every(state => keys.has(stateKey(state))), 'Conflict variants must be a deduplicated union');
  }
  for (const current of next.conflicts) {
    if (!oldConflicts.has(current.id)) {
      // A delete/edit conflict may materialize the surviving edit on creation;
      // the deletion remains an explicit variant and its tombstone is retained.
      const survivingEdit = !oldLive.has(current.path) && oldTombs.has(current.path) && current.main !== null && current.variants.some(state => state === null);
      assert(survivingEdit || fileStateEqual(current.main, oldLive.get(current.path) ?? null), 'New conflict must preserve the canonical live state');
    }
  }
  const archives = new Map(next.archiveRefs.map(item => [item.id, item]));
  for (const old of prior.archiveRefs) assert(canonicalJson(archives.get(old.id) ?? null) === canonicalJson(old), 'Archive references are immutable and cannot be removed');
  return next;
}
