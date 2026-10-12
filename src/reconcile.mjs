import { randomUUID } from 'node:crypto';
import { validateSyncManifest, fileStateEqual, conflictId, canonicalJson } from './sync-protocol.mjs';

const copy = value => structuredClone(value);
const stateOf = file => file ? { hash: file.hash, size: file.size, executable: file.executable } : null;
const sorted = map => [...map.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const variantsOf = variants => [...new Map(variants.map(value => [canonicalJson(value), copy(value)])).values()]
  .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'));
const equal = fileStateEqual;

/** Pure, per-path three-way reconciliation. A server CAS revision is NOT a local
 * common base. Proposals start from R, so excluded/unknown paths cannot disappear.
 * `bases` are only advanced by the owner after durable commit and verified apply.
 */
export function reconcileSync({ projectId, deviceId, remote, local, bases = [], isManaged = () => true, label, newId = randomUUID }) {
  const previous = remote ? validateSyncManifest(remote) : null;
  if (previous && previous.projectId !== projectId) throw Object.assign(new Error('Project mismatch'), { code: 'SYNC_PROJECT_MISMATCH' });
  const remoteFiles = new Map((previous?.files ?? []).map(file => [file.path, file]));
  const localFiles = new Map(local.map(file => [file.path, file]));
  const baseByPath = new Map(bases.map(entry => [entry.path, entry]));
  const files = new Map([...remoteFiles].map(([key, value]) => [key, copy(value)]));
  const tombstones = new Map((previous?.tombstones ?? []).map(item => [item.path, copy(item)]));
  const conflicts = new Map((previous?.conflicts ?? []).map(item => [item.path, copy(item)]));
  const paths = new Set([...remoteFiles.keys(), ...localFiles.keys(), ...baseByPath.keys(), ...tombstones.keys(), ...conflicts.keys()]);
  const operations = [], adoptions = [], frozen = [], blockers = [];
  function setFile(name, state) {
    if (state === null) files.delete(name);
    else files.set(name, { path: name, ...copy(state) });
  }
  function adopt(name, l, r) {
    if (!equal(l, r)) operations.push({ path: name, expected: copy(l), desired: copy(r) });
    adoptions.push({ path: name, state: copy(r) });
  }
  function preserveConflict(name, b, l, r) {
    const main = r ?? l; // A delete/edit conflict never discards the surviving bytes.
    const conflict = { id: conflictId(projectId, name, b), path: name, base: copy(b), main: copy(main), variants: variantsOf([r, l]) };
    conflicts.set(name, conflict); setFile(name, main);
    frozen.push({ path: name, state: copy(b), conflictId: conflict.id, preservedState: copy(l) });
  }
  for (const name of [...paths].sort()) {
    if (!isManaged(name)) continue;
    const l = stateOf(localFiles.get(name)), r = stateOf(remoteFiles.get(name)), base = baseByPath.get(name);
    let b = base?.state ?? null;
    const active = conflicts.get(name);
    if (active) {
      // A new device lacking this file did not delete it. A previously tracked
      // device can contribute a genuine delete intent. Sidecars never vote.
      if (l !== null || base) active.variants = variantsOf([...active.variants, l]);
      frozen.push({ path: name, state: copy(b), conflictId: active.id, preservedState: copy(l) });
      continue;
    }
    if (base?.ambiguous && !equal(l, r)) {
      // Explicit repair cannot turn an unknown partial publish into a clean
      // local edit merely because the remote returned to the common base.
      preserveConflict(name, b, l, r); continue;
    }
    if (base?.conflictId) {
      // Remote explicit resolution may apply only over exactly the version that
      // this device preserved. New local edits become a NEW conflict instead.
      b = base.preservedState ?? null;
      if (equal(l, b)) { adopt(name, l, r); continue; }
      if (!equal(l, r)) { preserveConflict(name, b, l, r); continue; }
    }
    if (equal(l, r)) { if (base || l !== null || tombstones.has(name)) adopt(name, l, r); continue; }
    if (!base) {
      // No common baseline: union unique additions, never infer a deletion.
      if (l === null) adopt(name, l, r);
      else if (r === null && !tombstones.has(name)) { setFile(name, l); adopt(name, l, l); }
      else preserveConflict(name, null, l, r);
      continue;
    }
    if (equal(l, b)) {
      if (r === null && b !== null && !tombstones.has(name)) {
        blockers.push({ path: name, code: 'SYNC_UNTRACKED_DELETE' }); continue;
      }
      adopt(name, l, r);
    } else if (equal(r, b)) {
      setFile(name, l);
      if (l === null && r !== null) tombstones.set(name, { path: name, prior: copy(r) });
      adopt(name, l, l);
    } else preserveConflict(name, b, l, r);
  }
  const content = { files: sorted(files), tombstones: sorted(tombstones), conflicts: sorted(conflicts), archiveRefs: copy(previous?.archiveRefs ?? []) };
  const comparable = value => canonicalJson({ files: value?.files ?? [], tombstones: value?.tombstones ?? [], conflicts: value?.conflicts ?? [], archiveRefs: value?.archiveRefs ?? [] });
  let manifest;
  try {
    manifest = validateSyncManifest({ version: 2, id: newId(), projectId, deviceId, parentId: previous?.id ?? null,
      policyRevision: previous?.policyRevision ?? 1, ...content, ...((previous?.label ?? label) === undefined ? {} : { label: previous?.label ?? label }) });
  } catch (error) {
    // A structural collision cannot be fixed by deleting a remote subtree or
    // renaming a local one behind the user's back. Preserve both and pause.
    return { manifest: null, changed: false, operations: [], adoptions: [], frozen, blockers: [{ code: 'SYNC_STRUCTURAL_CONFLICT' }], blocked: true };
  }
  return { manifest, changed: !previous || comparable(manifest) !== comparable(previous), operations, adoptions, frozen, blockers, blocked: blockers.length > 0 };
}

/** Resolve ONLY an exact active conflict. The caller owns a fresh preview, blob
 * upload, CAS and expected-local checks; this helper never touches the filesystem.
 */
export function resolveSyncConflict({ remote, conflictId: id, state, deviceId, newId = randomUUID }) {
  const previous = validateSyncManifest(remote), conflict = previous.conflicts.find(item => item.id === id);
  if (!conflict) throw Object.assign(new Error('Conflict changed'), { code: 'SYNC_CONFLICT_CHANGED' });
  const files = new Map(previous.files.map(file => [file.path, file]));
  const tombstones = new Map(previous.tombstones.map(item => [item.path, item]));
  if (state === null) {
    files.delete(conflict.path);
    if (conflict.main !== null) tombstones.set(conflict.path, { path: conflict.path, prior: copy(conflict.main) });
  } else files.set(conflict.path, { path: conflict.path, ...copy(state) });
  const manifest = validateSyncManifest({ ...previous, id: newId(), deviceId, parentId: previous.id, files: sorted(files), tombstones: sorted(tombstones), conflicts: previous.conflicts.filter(item => item.id !== id) });
  return { manifest, resolutions: [{ conflictId: id, state: copy(state) }] };
}
