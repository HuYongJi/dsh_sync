import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, validateId, MAX_FILES } from './protocol.mjs';
import { canonicalJson, validateSyncPath } from './sync-protocol.mjs';
import { readExclusionPolicy } from './snapshot.mjs';
import { isLinkOrRedirect } from './files.mjs';
import { syncRootIdentity, verifySyncRoot } from './sync-local.mjs';

export const MAX_PROBE_ENTRIES = MAX_FILES;
export const MAX_PROBE_DEPTH = 64;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const uncertain = () => { throw new Error('SYNC_PROBE_UNCERTAIN'); };
const safeError = code => Object.assign(new Error(code), { code });
const safeGuardCodes = new Set(['ACCOUNT_MISMATCH', 'ACCOUNT_BOUND', 'NOT_LOGGED_IN', 'DISPOSED', 'PROJECT_NOT_SELECTED', 'PROJECT_UNAVAILABLE', 'CONFIG_CONFLICT', 'SYNC_CANCELLED', 'SYNC_ROOT_CHANGED', 'SYNC_POLICY_CHANGED', 'SYNC_BINDING_MISMATCH', 'SYNC_NOT_IDLE']);
function admission(check, signal) {
  const failures = new WeakSet();
  return {
    async check() {
      try { signal?.throwIfAborted(); await check(); signal?.throwIfAborted(); }
      catch (error) {
        const safe = safeError(signal?.aborted || error?.name === 'AbortError' ? 'SYNC_CANCELLED' : safeGuardCodes.has(error?.code) ? error.code : 'SYNC_PROBE_UNAVAILABLE');
        failures.add(safe); throw safe;
      }
    },
    rethrow(error) { if (failures.has(error)) throw error; },
  };
}
function statRecord(stat) {
  // Do not silently fall back to millisecond/mtime-only observations: same-size
  // writes with restored mtime must still change the ctime observation.
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'mode', 'nlink'];
  if (fields.some(name => typeof stat[name] !== 'bigint')) uncertain();
  return Object.fromEntries(fields.map(name => [name, String(stat[name])]));
}
function entryKind(entry) { return entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unknown'; }

/** NON-authoritative unchanged hint, not file contents or a coherent snapshot.
 * The caller may skip a whole engine run ONLY after a successful fully-synced
 * state, an unchanged remote head and matching certain tree/session probes. It
 * MUST force content verification at least every five minutes, on dirty watch
 * events, pending/repair/conflict state, uncertainty, or any probe error. This
 * result never authorizes capture, upload, restoration, or application of bytes.
 * Only the bounded root .dsh-syncignore policy is read; payload files are statted.
 * files is a count; metadata records remain private. Uncertain fingerprints are
 * null, and rootIdentity/policyHash may be null if their observation failed.
 */
export async function probeSyncTree({ root, excludedPaths = [], check = async () => {}, signal }) {
  const gate = admission(check, signal), records = [], filesSeen = [], directories = [], names = new Set();
  let rootIdentity = null, policyHash = null, files = 0, entriesSeen = 0;
  const result = () => ({ fingerprint: null, rootIdentity, policyHash, files, uncertain: true });
  try {
    await gate.check(); rootIdentity = await syncRootIdentity(root); await gate.check();
    const exclusions = { excluded: ['.dsh-syncignore', '**/.dsh-syncignore'], excludedPaths };
    const policy = await readExclusionPolicy(rootIdentity.root, exclusions); policyHash = policy.fingerprint; await gate.check();
    async function stat(filename) {
      await gate.check(); const value = await fs.lstat(filename, { bigint: true }); await gate.check();
      if (await isLinkOrRedirect(filename, value)) uncertain();
      await gate.check(); return value;
    }
    async function entries(directory, expectedCount) {
      await gate.check(); const handle = await fs.opendir(directory, { bufferSize: 64 });
      const rows = []; let failure;
      try {
        for (;;) {
          await gate.check(); const entry = await handle.read(); await gate.check(); if (!entry) break;
          // Count excluded names too: a huge flat ignored directory listing must
          // not bypass work/memory bounds. Excluded subtrees are never opened.
          if (expectedCount === undefined ? ++entriesSeen > MAX_PROBE_ENTRIES : rows.length >= expectedCount) uncertain();
          rows.push({ name: entry.name, kind: entryKind(entry) });
        }
      } catch (error) { failure = error; throw error; }
      finally { try { await handle.close(); } catch (error) { if (!failure) throw error; } }
      return rows.sort((a, b) => compare(a.name, b.name));
    }
    async function walk(directory, relative, depth, expected) {
      if (depth > MAX_PROBE_DEPTH) uncertain();
      const before = await stat(directory);
      if (!before.isDirectory() || expected && !equal(statRecord(before), expected)) uncertain();
      const observation = statRecord(before), listing = await entries(directory);
      if (!equal(statRecord(await stat(directory)), observation)) uncertain();
      directories.push({ directory, observation, listing });
      if (relative) records.push({ path: relative, kind: 'directory', ...observation });
      for (const entry of listing) {
        await gate.check(); const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (policy.isExcluded(name)) continue;
        validateSyncPath(name);
        const folded = name.toLowerCase(); if (names.has(folded)) uncertain(); names.add(folded);
        if (entry.kind !== 'directory' && entry.kind !== 'file') uncertain();
        const filename = path.join(directory, entry.name), info = await stat(filename), record = statRecord(info);
        if (entry.kind === 'directory' && info.isDirectory()) await walk(filename, name, depth + 1, record);
        else if (entry.kind === 'file' && info.isFile() && info.nlink === 1n) {
          if (++files > MAX_FILES) uncertain();
          records.push({ path: name, kind: 'file', ...record }); filesSeen.push({ filename, record });
        } else uncertain();
      }
      if (!equal(statRecord(await stat(directory)), observation)) uncertain();
    }
    await walk(rootIdentity.root, '', 0);
    // A second pass refuses detected races, but is deliberately NOT advertised as
    // a filesystem transaction or protection from edits after an observation.
    for (const file of filesSeen) {
      const current = await stat(file.filename);
      if (!current.isFile() || current.nlink !== 1n || !equal(statRecord(current), file.record)) uncertain();
    }
    for (const directory of [...directories].reverse()) {
      const current = await stat(directory.directory);
      if (!current.isDirectory() || !equal(statRecord(current), directory.observation) || !equal(await entries(directory.directory, directory.listing.length), directory.listing)) uncertain();
      if (!equal(statRecord(await stat(directory.directory)), directory.observation)) uncertain();
    }
    await gate.check(); await verifySyncRoot(rootIdentity);
    const afterPolicy = await readExclusionPolicy(rootIdentity.root, exclusions); await gate.check();
    if (afterPolicy.fingerprint !== policyHash) uncertain();
    await verifySyncRoot(rootIdentity); await gate.check();
    records.sort((a, b) => compare(a.path, b.path));
    return { fingerprint: sha256(canonicalJson({ version: 1, kind: 'metadata-hint', rootIdentity, root: directories[0].observation, policyHash, records })), rootIdentity, policyHash, files, uncertain: false };
  } catch (error) { gate.rethrow(error); await gate.check(); return result(); }
}

function boundedHeader(header) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) uncertain();
  let nodes = 0, units = 0;
  function visit(value, depth) {
    if (++nodes > 256 || depth > 8) uncertain();
    if (typeof value === 'string') { units += value.length; if (units > 16_384) uncertain(); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) uncertain();
    for (const [name, member] of Object.entries(value)) { units += name.length; if (units > 16_384) uncertain(); visit(member, depth + 1); }
  }
  visit(header, 0); return canonicalJson(header);
}

/** Native metadata ONLY. Verified against the read-only DSH 0.2.0-rc.2 SDK
 * copies: persistence.list/stat, sessions.list/get/seq, agent.whenIdle/inbox and
 * workspace/session-activity. No SDK imports, open/read/flush, events, attachments,
 * agent creation/resume/cancellation, or execution hooks. Missing capabilities and
 * all unknown/active/error outcomes are uncertain, never a stable unavailable hint.
 */
export async function probeSessionRevisions(ctx, root, { check = async () => {}, signal } = {}) {
  const gate = admission(check, signal), unknown = { fingerprint: null, uncertain: true };
  try {
    await gate.check(); const rootIdentity = await syncRootIdentity(root); await gate.check();
    const service = name => typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
    const persistence = service('sessionPersistence'), sessions = service('sessions'), agents = service('agents');
    if (typeof persistence?.list !== 'function' || typeof persistence?.stat !== 'function' || typeof sessions?.list !== 'function' || typeof sessions?.get !== 'function' || typeof agents?.get !== 'function' || typeof ctx?.waterfall !== 'function') return unknown;
    const inRoot = header => {
      if (!header || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) uncertain();
      return key(header.cwd) === key(rootIdentity.root);
    };
    function storedRows(values) {
      if (!Array.isArray(values) || values.length > MAX_FILES) uncertain();
      const seen = new Set();
      return values.filter(value => inRoot(value?.header)).map(value => {
        const id = validateId(value.header.id);
        if (seen.has(id) || typeof value.revision !== 'string' || !value.revision || value.revision.length > 4096 || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) uncertain();
        seen.add(id); return { id, header: boundedHeader(value.header), revision: value.revision, sizeBytes: value.sizeBytes };
      }).sort((a, b) => compare(a.id, b.id));
    }
    function liveRows() {
      const values = sessions.list(); if (!Array.isArray(values) || values.length > MAX_FILES) uncertain();
      const seen = new Set();
      return values.filter(value => inRoot(value?.header)).map(value => {
        const id = validateId(value.id);
        if (seen.has(id) || value.header.id !== id || sessions.get(id) !== value || !Number.isSafeInteger(value.seq) || value.seq < 0) uncertain();
        seen.add(id); return { id, header: boundedHeader(value.header), seq: value.seq, object: value };
      }).sort((a, b) => compare(a.id, b.id));
    }
    async function idle(id) {
      await gate.check(); const agent = agents.get(id);
      if (agent) {
        if (agent.status !== 'idle' || typeof agent.whenIdle !== 'function' || agent.inbox?.hasPending !== false) uncertain();
        let immediate;
        try {
          const settled = await Promise.race([Promise.resolve(agent.whenIdle()).then(() => true), new Promise(resolve => { immediate = setImmediate(() => resolve(false)); })]);
          if (!settled || agents.get(id) !== agent || agent.status !== 'idle' || agent.inbox?.hasPending !== false) uncertain();
        } finally { if (immediate) clearImmediate(immediate); }
      }
      await gate.check(); const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])); await gate.check();
      if (!Array.isArray(activity) || activity.length) uncertain();
    }
    const first = storedRows(await persistence.list({ signal })); await gate.check(); const live = liveRows();
    const ids = [...new Set([...first.map(item => item.id), ...live.map(item => item.id)])].sort(compare);
    const firstById = new Map(first.map(item => [item.id, item]));
    if (ids.length > MAX_FILES || live.some(item => !firstById.has(item.id))) uncertain();
    for (const id of ids) {
      await idle(id); await gate.check();
      const current = storedRows([await persistence.stat(id, { signal })]); await gate.check();
      if (current.length !== 1 || !equal(current[0], firstById.get(id))) uncertain();
    }
    const final = storedRows(await persistence.list({ signal })); await gate.check(); const finalLive = liveRows();
    const omitObject = values => values.map(({ object: _object, ...item }) => item);
    if (!equal(first, final) || !equal(omitObject(live), omitObject(finalLive)) || finalLive.some((item, index) => item.object !== live[index].object)) uncertain();
    for (const id of ids) {
      await idle(id); await gate.check();
      const current = storedRows([await persistence.stat(id, { signal })]); await gate.check();
      if (current.length !== 1 || !equal(current[0], firstById.get(id))) uncertain();
    }
    const endLive = liveRows();
    if (!equal(omitObject(live), omitObject(endLive)) || endLive.some((item, index) => item.object !== live[index].object)) uncertain();
    if (service('sessionPersistence') !== persistence || service('sessions') !== sessions || service('agents') !== agents) uncertain();
    await verifySyncRoot(rootIdentity); await gate.check();
    return { fingerprint: sha256(canonicalJson({ version: 1, kind: 'native-metadata-hint', rootIdentity, stored: first, live: omitObject(live) })), uncertain: false };
  } catch (error) { gate.rethrow(error); await gate.check(); return unknown; }
}
