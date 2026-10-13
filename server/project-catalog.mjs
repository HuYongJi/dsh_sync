import { randomBytes } from 'node:crypto';
import { assert, sha256 } from '../src/protocol.mjs';
import { MAX_SYNC_PAGE_SIZE } from '../src/sync-protocol.mjs';

const keyFor = id => sha256(Buffer.from(id));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const changed = () => Object.assign(new Error('Project catalog changed; restart pagination'), { status: 409, code: 'SYNC_CATALOG_CHANGED' });
const cursorPattern = /^([a-f0-9]{32})\.([a-f0-9]{64})$/;

/** Read-only derived index. store.state.checkpoints is validated on open and
 * replaced, never mutated, at the legacy commit point. Token/password writes
 * retain that array: they must not cause O(history) catalog work again.
 */
export function createLegacyProjectCatalog({ store, metadataFor }) {
  let checkpointGeneration, cached;
  function index() {
    const checkpoints = store.state.checkpoints;
    if (checkpoints === checkpointGeneration) return cached;
    const projects = new Map();
    for (const entry of checkpoints) {
      let row = projects.get(entry.projectId);
      if (!row) {
        row = { key: keyFor(entry.projectId), projectId: entry.projectId, checkpointCount: 0, latestCreatedAt: entry.createdAt };
        projects.set(entry.projectId, row);
      }
      row.checkpointCount++;
      if (Date.parse(entry.createdAt) > Date.parse(row.latestCreatedAt)) row.latestCreatedAt = entry.createdAt;
      row.entry = entry; // Authoritative append order, never timestamps/older fallback.
    }
    cached = Object.freeze([...projects.values()].sort((a, b) => compare(a.key, b.key)).map(Object.freeze));
    checkpointGeneration = checkpoints;
    return cached;
  }
  async function summary(row) {
    const metadata = await metadataFor(row.entry);
    return { projectId: row.projectId, checkpointCount: row.checkpointCount, latestCreatedAt: row.latestCreatedAt, ...metadata };
  }
  async function list() {
    const projects = []; let partial = false;
    for (const row of index()) {
      try { projects.push(await summary(row)); }
      catch { partial = true; } // Missing/corrupt latest never selects older history.
    }
    projects.sort((a, b) => a.projectId.localeCompare(b.projectId, 'en'));
    return { projects, ...(partial ? { partial: true } : {}) };
  }
  return Object.freeze({ index, summary, list });
}

/** One bounded metadata page across both protocols. No disk schema/index writes.
 * A random in-memory generation binds cursors to this process and both validated
 * index generations. Never splice pages after a commit/restart/corruption change.
 */
export function createProjectCatalog({ store, sync, legacy }) {
  let cached;
  function snapshot() {
    const v2 = sync.catalog(), v1 = legacy.index();
    if (cached?.v2 === v2 && cached?.v1 === v1) return cached;
    const rows = new Map(v1.map(row => [row.key, { key: row.key, legacy: true, row }]));
    // Hashed keys also fence legacy fallback when a corrupt v2 pointer cannot
    // disclose its project id. A migrated project's old checkpoint is not latest.
    for (const row of v2) rows.set(row.key, { key: row.key, legacy: false });
    cached = { v1, v2, generation: randomBytes(16).toString('hex'), rows: [...rows.values()].sort((a, b) => compare(a.key, b.key)) };
    return cached;
  }
  async function page({ limit = 100, cursor = null } = {}) {
    assert(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_SYNC_PAGE_SIZE, 'Invalid page limit');
    let after = null, expectedGeneration;
    if (cursor !== null) {
      assert(typeof cursor === 'string' && cursorPattern.test(cursor), 'Invalid catalog cursor');
      [, expectedGeneration, after] = cursorPattern.exec(cursor);
    }
    const current = snapshot();
    if (expectedGeneration && expectedGeneration !== current.generation) throw changed();
    // Binary seek means warm later pages do not rescan/sort every project.
    let start = 0, end = current.rows.length;
    if (after !== null) while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (current.rows[middle].key <= after) start = middle + 1; else end = middle;
    }
    const selected = current.rows.slice(start, start + limit), projects = [];
    let partial = false;
    for (const item of selected) {
      let row;
      if (item.legacy) {
        try { row = { ...await legacy.summary(item.row), legacy: true }; }
        catch { row = { projectId: item.row.projectId, projectKey: item.key, legacy: true, corrupt: true }; }
      } else row = { ...await sync.summary(item.key), legacy: false };
      if (row.corrupt) partial = true;
      projects.push(row);
    }
    if (sync.catalog() !== current.v2 || legacy.index() !== current.v1) throw changed();
    return { serverId: store.state.serverId, generation: current.generation, projects, partial,
      nextCursor: start + selected.length < current.rows.length ? `${current.generation}.${selected.at(-1).key}` : null };
  }
  return Object.freeze({ page });
}
