import fs from 'node:fs/promises';
import path from 'node:path';
import { validateId } from './protocol.mjs';

export const DEFAULT_SYNC_BUDGET = 10 * 1024 ** 3;
const DEFAULT_MAX_ENTRIES = 100_000, MAX_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const count = value => Number.isSafeInteger(value) && value >= 0;
const identityFields = ['dev', 'ino', 'birthtimeNs'];
const observationFields = [...identityFields, 'size', 'nlink', 'mtimeNs', 'ctimeNs'];
const same = (a, b, fields = identityFields) => fields.every(field => a[field] === b[field]);

function identifier(value) {
  try { validateId(value); } catch { throw fail('SYNC_METADATA_UNSAFE'); }
  // Opaque protocol IDs still must not become Windows device paths.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw fail('SYNC_METADATA_UNSAFE');
  return value;
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw fail('SYNC_METADATA_UNSAFE');
  if (process.platform === 'win32' && (path.parse(value).root.length === 1 || /^\\\\[?.]\\/.test(value) || value.slice(path.parse(value).root.length).includes(':'))) throw fail('SYNC_METADATA_UNSAFE');
  const parts = value.slice(path.parse(value).root.length).split(process.platform === 'win32' ? /[\\/]/ : '/');
  if (parts.some(part => part === '.' || part === '..' || process.platform === 'win32' && /[. ]$/.test(part))) throw fail('SYNC_METADATA_UNSAFE');
  return path.resolve(value);
}
function add(a, b) {
  if (!count(a) || !count(b) || b > Number.MAX_SAFE_INTEGER - a) throw fail('SYNC_QUOTA');
  return a + b;
}

// Only filesystem observations become diagnostics. Admission/check exceptions and
// cancellation must escape unchanged, even when they have a familiar error code.
class ObservationFailure extends Error {
  constructor(code, bindingId, fsCode) {
    super(code); this.code = code; this.bindingId = bindingId; this.fsCode = fsCode;
  }
}

/** Read-only logical file-byte snapshot of plugin-owned storage, NOT disk usage.
 *
 * The Host supplies its trusted plugin stateDir and ALL bindings, including paused
 * ones. No project is enumerated: only stateDir, stateDir/v2/<id>, and each verified
 * root/.dsh-sync/v2/<id> are eligible. Ancestors are inspected, never enumerated.
 * stateDir must not equal/contain any project root. Paths are literal, not globs.
 *
 * bytes === stateBytes + sum(byBinding.bytes). stateBytes is shared state (legacy
 * spool, Host intents, archive cache, unknown/retired engine directories, etc.).
 * Binding bytes combine engine and applier storage. Overlaps are walked once;
 * the most-specific ownership boundary wins, with binding ownership winning ties.
 * A nested stateDir starts a new shared-state boundary within an applier tree.
 *
 * An absent metadata descendant is zero ONLY beneath a verified, stable owner.
 * Missing stateDir, changed/missing project roots, redirects, unsafe entries or
 * traversal limits give complete:false and path-free diagnostics. Partial counts
 * are observations, NEVER evidence of free capacity. Integer overflow throws
 * SYNC_QUOTA. check/signal failures propagate. No contents are opened or changed.
 *
 * This is a soft snapshot, not a filesystem transaction or cross-process lock.
 * The Host must serialize allocation and remeasure under its global operation
 * lock; these helpers neither reserve disk space nor perform cleanup.
 */
export async function measureSyncStorage({ stateDir, bindings = [], check = async () => {}, signal, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  stateDir = absolute(stateDir);
  if (!Array.isArray(bindings) || typeof check !== 'function' || signal !== undefined && typeof signal?.throwIfAborted !== 'function') throw fail('SYNC_METADATA_UNSAFE');
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw fail('SYNC_QUOTA');
  if (key(stateDir) === key(path.parse(stateDir).root)) throw fail('SYNC_METADATA_UNSAFE');
  const ids = new Set();
  const records = bindings.map(binding => {
    if (!object(binding)) throw fail('SYNC_METADATA_UNSAFE');
    const id = identifier(binding.id), root = absolute(binding.root), identity = binding.rootIdentity;
    if (ids.has(id.toLowerCase())) throw fail('SYNC_METADATA_UNSAFE');
    ids.add(id.toLowerCase());
    if (!object(identity) || key(absolute(identity.root)) !== key(root) || identityFields.some(field => typeof identity[field] !== 'string' || !/^\d+$/.test(identity[field]))) throw fail('SYNC_ROOT_CHANGED');
    return { id, root, identity: { ...Object.fromEntries(identityFields.map(field => [field, identity[field]])) } };
  });
  const boundaries = [{ directory: stateDir, bindingId: undefined }];
  for (const binding of records) {
    boundaries.push({ directory: path.join(stateDir, 'v2', binding.id), bindingId: binding.id, anchor: stateDir });
    boundaries.push({ directory: path.join(binding.root, '.dsh-sync', 'v2', binding.id), bindingId: binding.id, anchor: binding.root });
  }
  for (const boundary of boundaries) {
    boundary.key = key(boundary.directory);
    // A corrupt layout must never broaden an owned traversal into user files,
    // including another binding nested within an applier/engine directory.
    if (records.some(binding => inside(key(binding.root), boundary.key))) throw fail('SYNC_METADATA_UNSAFE');
  }
  boundaries.sort((a, b) => b.key.length - a.key.length || Number(Boolean(b.bindingId)) - Number(Boolean(a.bindingId)));
  const byBinding = records.map(({ id }) => ({ id, bytes: 0 })), rows = new Map(byBinding.map(row => [row.id, row]));
  const directories = new Map(), observed = new Map(), missing = new Map(), inodes = new Map();
  const diagnostics = [];
  let bytes = 0, stateBytes = 0, entries = 0;
  const result = () => ({ bytes, stateBytes, byBinding, complete: diagnostics.length === 0, diagnostics, entries });
  const owner = target => boundaries.find(boundary => inside(key(target), boundary.key));
  const fault = (code, bindingId) => { throw new ObservationFailure(code, bindingId); };
  async function admit() { signal?.throwIfAborted(); await check(); signal?.throwIfAborted(); }
  async function io(method, target, options, bindingId) {
    signal?.throwIfAborted();
    let value;
    try { value = await fs[method](target, options); }
    catch (error) { signal?.throwIfAborted(); throw new ObservationFailure('SYNC_METADATA_UNSAFE', bindingId, error?.code); }
    signal?.throwIfAborted();
    return value;
  }
  function validStat(info, bindingId) {
    if (!info || info.isSymbolicLink() || !info.isFile() && !info.isDirectory() ||
        observationFields.some(field => typeof info[field] !== 'bigint') ||
        identityFields.some(field => info[field] < 0n) || info.size < 0n || info.nlink < 1n ||
        info.isFile() && info.nlink !== 1n) fault('SYNC_METADATA_UNSAFE', bindingId);
  }
  async function inspect(target, { bindingId, directory = false, absentBelow } = {}) {
    await admit();
    const volume = path.parse(target).root;
    const parts = target.slice(volume.length).split(path.sep).filter(Boolean);
    let current = volume, info;
    for (let index = 0; index <= parts.length; index++) {
      if (index) current = path.join(current, parts[index - 1]);
      const currentKey = key(current), previous = directories.get(currentKey);
      try { info = await io('lstat', current, { bigint: true }, bindingId); }
      catch (error) {
        if (!(error instanceof ObservationFailure)) throw error;
        if (error.fsCode === 'ENOENT') {
          if (previous) fault('SYNC_ROOT_CHANGED', bindingId);
          if (absentBelow && currentKey !== key(absentBelow) && inside(currentKey, key(absentBelow))) {
            missing.set(currentKey, { target: current, bindingId, absentBelow });
            return null;
          }
        }
        throw error;
      }
      validStat(info, bindingId);
      if ((index < parts.length || directory) && !info.isDirectory()) fault('SYNC_METADATA_UNSAFE', bindingId);
      if (previous && !same(previous.info, info)) fault('SYNC_ROOT_CHANGED', bindingId);
      if (key(await io('realpath', current, undefined, bindingId)) !== currentKey) fault('SYNC_METADATA_UNSAFE', bindingId);
      if (info.isDirectory() && !previous) directories.set(currentKey, { target: current, info, bindingId });
    }
    return info;
  }
  async function verifyBinding(binding) {
    let info;
    try { info = await inspect(binding.root, { bindingId: binding.id, directory: true }); }
    catch (error) {
      if (error instanceof ObservationFailure && error.fsCode === 'ENOENT') fault('SYNC_ROOT_CHANGED', binding.id);
      throw error;
    }
    if (identityFields.some(field => String(info[field]) !== binding.identity[field])) fault('SYNC_ROOT_CHANGED', binding.id);
  }
  async function walk(root) {
    const pending = [root];
    while (pending.length) {
      if (entries >= maxEntries) fault('SYNC_QUOTA', owner(pending.at(-1))?.bindingId);
      const target = pending.pop(), scope = owner(target);
      if (!scope) fault('SYNC_METADATA_UNSAFE');
      const info = await inspect(target, { bindingId: scope.bindingId });
      entries++;
      const inode = `${info.dev}:${info.ino}`, previous = inodes.get(inode);
      if (previous !== undefined && previous !== key(target)) fault('SYNC_METADATA_UNSAFE', scope.bindingId);
      inodes.set(inode, key(target));
      observed.set(key(target), { target, info, bindingId: scope.bindingId });
      if (info.isDirectory()) {
        const names = await io('readdir', target, undefined, scope.bindingId);
        const after = await inspect(target, { bindingId: scope.bindingId, directory: true });
        if (!same(info, after, observationFields)) fault('SYNC_METADATA_UNSAFE', scope.bindingId);
        if (names.length > maxEntries - entries - pending.length) fault('SYNC_QUOTA', scope.bindingId);
        const seen = new Set();
        for (const name of names.sort().reverse()) {
          if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name) ||
              process.platform === 'win32' && (/[. ]$/.test(name) || name.includes(':'))) fault('SYNC_METADATA_UNSAFE', scope.bindingId);
          const child = path.join(target, name), childKey = key(child);
          if (key(path.dirname(child)) !== key(target) || seen.has(childKey)) fault('SYNC_METADATA_UNSAFE', scope.bindingId);
          seen.add(childKey); pending.push(child);
        }
      } else {
        if (info.size > MAX_BYTES) throw fail('SYNC_QUOTA');
        const size = Number(info.size);
        bytes = add(bytes, size);
        if (scope.bindingId) rows.get(scope.bindingId).bytes = add(rows.get(scope.bindingId).bytes, size);
        else stateBytes = add(stateBytes, size);
      }
    }
  }
  try {
    await admit();
    for (const binding of records) await verifyBinding(binding);
    await inspect(stateDir, { directory: true });
    const roots = [{ directory: stateDir, key: key(stateDir) }];
    for (const boundary of boundaries) {
      if (!boundary.anchor) continue;
      if (await inspect(boundary.directory, { bindingId: boundary.bindingId, directory: true, absentBelow: boundary.anchor })) roots.push(boundary);
    }
    roots.sort((a, b) => a.key.length - b.key.length);
    const coalesced = [];
    for (const root of roots) if (!coalesced.some(parent => inside(root.key, parent.key))) coalesced.push(root);
    for (const root of coalesced) await walk(root.directory);
    // Recheck all observed objects, not only the directory most recently walked.
    // Changes cannot turn a partial/stale scan into spendable capacity.
    for (const observation of observed.values()) {
      const current = await inspect(observation.target, { bindingId: observation.bindingId });
      if (!same(observation.info, current, observationFields)) fault('SYNC_METADATA_UNSAFE', observation.bindingId);
    }
    for (const observation of [...missing.values()]) {
      if (await inspect(observation.target, observation)) fault('SYNC_METADATA_UNSAFE', observation.bindingId);
    }
    for (const binding of records) await verifyBinding(binding);
    for (const observation of directories.values()) await inspect(observation.target, { bindingId: observation.bindingId, directory: true });
    signal?.throwIfAborted();
  } catch (error) {
    if (!(error instanceof ObservationFailure)) throw error;
    diagnostics.push({ code: error.code, ...(error.bindingId ? { bindingId: error.bindingId } : {}) });
  }
  return result();
}

function admittedUsage(limit, usage) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !object(usage) || usage.complete !== true ||
      !count(usage.bytes) || !count(usage.stateBytes) || !Array.isArray(usage.byBinding) ||
      !Array.isArray(usage.diagnostics) || usage.diagnostics.length) throw fail('SYNC_QUOTA');
  const ids = new Set(); let total = usage.stateBytes;
  for (const row of usage.byBinding) {
    if (!object(row) || !count(row.bytes)) throw fail('SYNC_QUOTA');
    try { identifier(row.id); } catch { throw fail('SYNC_QUOTA'); }
    if (ids.has(row.id.toLowerCase())) throw fail('SYNC_QUOTA');
    ids.add(row.id.toLowerCase()); total = add(total, row.bytes);
  }
  if (total !== usage.bytes || total > limit) throw fail('SYNC_QUOTA');
  return usage;
}

/** Total bytes ONE binding may own, including its existing engine + applier data.
 * Subtract OTHER bindings and shared state, not this binding's existing data twice.
 * Zero is possible when other data exhausts the cap; do not pass zero to engines
 * whose constructor requires a positive quota. Invalid/unknown/over-cap is QUOTA.
 */
export function bindingBudget({ limit = DEFAULT_SYNC_BUDGET, usage, bindingId } = {}) {
  admittedUsage(limit, usage);
  const row = usage.byBinding.find(item => item.id === bindingId);
  if (!row) throw fail('SYNC_QUOTA');
  return limit - (usage.bytes - row.bytes);
}

/** Assert a serialized Host allocation fits, returning bytes left afterwards.
 * This is admission only: it does NOT mutate usage, allocate, lock, persist a
 * reservation, or garbage-collect. Remeasure before the next allocation.
 */
export function reserveSyncStorage({ limit = DEFAULT_SYNC_BUDGET, usage, additionalBytes } = {}) {
  admittedUsage(limit, usage);
  if (!count(additionalBytes) || additionalBytes > limit - usage.bytes) throw fail('SYNC_QUOTA');
  return limit - usage.bytes - additionalBytes;
}
