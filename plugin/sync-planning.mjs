import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateManifest, validateId, sha256 } from '../src/protocol.mjs';
import { validateSyncManifest, validateSyncPath, isProtectedSyncPath, conflictId, unionVariants, canonicalJson } from '../src/sync-protocol.mjs';

export const syncFailure = code => Object.assign(new Error(code), { code });
export const rootKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
export const fileState = file => file ? { hash: file.hash, size: file.size, executable: file.executable } : null;
export const accountKey = value => sha256(canonicalJson({ server: value.server, serverId: value.serverId, username: value.username, deviceId: value.deviceId }));
export function accountIdentity(value, serverId = value.serverId) {
  return { server: value.server, serverId: validateId(serverId), username: value.username, deviceId: validateId(value.deviceId), authorizationEpoch: value.authorizationEpoch ?? 0 };
}
export function projectLabel(value, fallback = '项目') {
  const label = String(value ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '');
  return label || fallback;
}

/** An explicit migration is an inclusion union, NEVER historical deletion inference.
 * All legacy records stay immutable. Missing paths can reflect historical ignores.
 * Different nonmissing variants become conflicts; the explicitly chosen primary
 * supplies the display/main value. Structural collisions fail closed at validation.
 */
export function planLegacyMigration({ projectId, deviceId, manifests, primaryId, label, isManaged = () => true, newId = randomUUID }) {
  if (!Array.isArray(manifests) || !manifests.length || manifests.length > 200) throw syncFailure('SYNC_MIGRATION_REQUIRED');
  const items = manifests.map(validateManifest);
  if (items.some(item => item.projectId !== projectId) || new Set(items.map(item => item.id)).size !== items.length) throw syncFailure('CHECKPOINT_MISMATCH');
  const primary = items.find(item => item.id === primaryId);
  if (!primary) throw syncFailure('SYNC_LEGACY_HEAD_MISMATCH');
  const ordered = [primary, ...items.filter(item => item !== primary).sort((a, b) => a.id.localeCompare(b.id, 'en'))], paths = new Map();
  let skipped = 0;
  for (const manifest of ordered) for (const file of manifest.files) {
    if (!file.path.startsWith('project/')) continue;
    const name = file.path.slice(8);
    if (isProtectedSyncPath(name) || !isManaged(name)) { skipped++; continue; }
    validateSyncPath(name);
    const state = { hash: file.sha256, size: file.size, executable: file.executable === true };
    const variants = paths.get(name) ?? []; variants.push(state); paths.set(name, variants);
  }
  const files = [], conflicts = [];
  for (const [name, states] of paths) {
    const variants = unionVariants(states), main = states[0];
    files.push({ path: name, ...main });
    if (variants.length > 1) conflicts.push({ id: conflictId(projectId, name, null), path: name, base: null, main, variants });
  }
  try {
    const manifest = validateSyncManifest({ version: 2, id: newId(), projectId, deviceId, parentId: null, policyRevision: 1, files, tombstones: [], conflicts, archiveRefs: [], label: projectLabel(label, projectId) });
    return { manifest, skipped, archivedCheckpoints: items.map(item => item.id) };
  } catch { throw syncFailure('SYNC_STRUCTURAL_CONFLICT'); }
}

/** A generated sibling must be free in BOTH the local tree and pinned cloud state.
 * Actual vacancy/root identity is rechecked at confirmation and exclusive apply.
 */
export async function uniqueSibling(relative, suffix, occupied, localExists) {
  validateSyncPath(relative);
  const ext = path.posix.extname(relative), parent = path.posix.dirname(relative);
  const stem = path.posix.basename(relative, ext).slice(0, 90).replace(/[\uD800-\uDBFF]$/u, '');
  const tag = suffix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'copy';
  for (let index = 0; index < 1000; index++) {
    const leaf = `${stem}-${tag}${index ? `-${index}` : ''}${ext.slice(0, 32)}`;
    const name = parent === '.' ? leaf : `${parent}/${leaf}`;
    validateSyncPath(name);
    const folded = name.toLowerCase();
    if ([...occupied].some(item => item === folded || item.startsWith(`${folded}/`) || folded.startsWith(`${item}/`))) continue;
    if (await localExists(name)) continue;
    occupied.add(folded); return name;
  }
  throw syncFailure('SYNC_DESTINATION_UNAVAILABLE');
}

/** Read-only native maintenance/activity admission; never stop/start an agent.
 * Missing/unknown capabilities fail closed for incoming project writes.
 */
export async function syncWorkspaceIdle(ctx, root) {
  try {
    const get = name => ctx[name] ?? ctx.get?.(name), sessions = get('sessions'), persistence = get('sessionPersistence'), agents = get('agents');
    if (typeof sessions?.list !== 'function' || typeof persistence?.list !== 'function' || typeof agents?.get !== 'function' || typeof ctx.waterfall !== 'function') return false;
    const ids = new Set();
    for (const session of sessions.list()) if (typeof session.header?.cwd === 'string' && rootKey(session.header.cwd) === rootKey(root)) ids.add(session.id);
    for (const session of await persistence.list()) if (typeof session.header?.cwd === 'string' && rootKey(session.header.cwd) === rootKey(root)) ids.add(session.header.id);
    for (const id of ids) {
      validateId(id); const agent = agents.get(id);
      if (agent) {
        if (agent.status !== 'idle' || agent.inbox?.hasPending || typeof agent.whenIdle !== 'function') return false;
        let timer;
        const idle = await Promise.race([agent.whenIdle().then(() => true), new Promise(resolve => { timer = setImmediate(() => resolve(false)); })]);
        if (timer) clearImmediate(timer);
        if (!idle || agent.status !== 'idle' || agent.inbox?.hasPending) return false;
      }
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
      if (!Array.isArray(activity) || activity.length) return false;
    }
    return true;
  } catch { return false; }
}
