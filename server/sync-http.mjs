import { assert, validateId, validateBlobHash, MAX_BLOB_BYTES, MAX_MANIFEST_BYTES } from '../src/protocol.mjs';
import { MAX_SYNC_PAGE_SIZE } from '../src/sync-protocol.mjs';

const failure = (status, code) => Object.assign(new Error(code), { status, code });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
function integer(query, key, fallback) {
  const raw = query.get(key);
  if (raw === null) return fallback;
  assert(/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)), 'Invalid paging number');
  return Number(raw);
}
function queryFields(url, fields) {
  assert([...url.searchParams.keys()].every(key => fields.includes(key)) && [...new Set(url.searchParams.keys())].every(key => url.searchParams.getAll(key).length === 1), 'Invalid query');
}
function routeId(raw) { try { return validateId(decodeURIComponent(raw)); } catch { throw failure(400, 'BAD_REQUEST'); } }

/** Exact authenticated v2 routes. Uses the SAME writer lock as legacy commits and
 * revocation. This adapter never relaxes restoration or accepts local paths.
 */
export function createSyncHttp({ sync, store, readJson, sendJson, assertTokenStillValid, verifyBlob, headsFor, projectCatalog }) {
  const checked = token => assertTokenStillValid(token, store.state);
  const legacyHeads = id => headsFor(store.state, id);
  async function send(req, res, token, value, status = 200) { checked(token); sendJson(req, res, status, value); return true; }
  return async (req, res, url, token) => {
    const pathname = url.pathname;
    if (pathname === '/v2/capabilities' && req.method === 'GET') {
      queryFields(url, []);
      return send(req, res, token, { protocol: 2, serverId: store.state.serverId, maxPageSize: MAX_SYNC_PAGE_SIZE, maxBlobBytes: MAX_BLOB_BYTES, bidirectional: true, recoverableDeletes: true, projectCatalog: true });
    }
    if (pathname === '/v2/project-catalog' && req.method === 'GET') {
      queryFields(url, ['limit', 'cursor']);
      return send(req, res, token, await projectCatalog.page({ limit: integer(url.searchParams, 'limit', 100), cursor: url.searchParams.get('cursor') }));
    }
    if (pathname === '/v2/projects' && req.method === 'GET') {
      queryFields(url, ['limit', 'cursor']);
      const page = await sync.list({ limit: integer(url.searchParams, 'limit', 100), cursor: url.searchParams.get('cursor'), summaries: true });
      return send(req, res, token, page);
    }
    if (pathname === '/v2/blobs/missing' && req.method === 'POST') {
      queryFields(url, []);
      const input = await readJson(req, 64 * 1024);
      assert(exact(input, ['blobs']) && Array.isArray(input.blobs) && input.blobs.length <= 256, 'Invalid blob inventory');
      const seen = new Map(), missing = [];
      for (const item of input.blobs) {
        assert(exact(item, ['hash', 'size']) && Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= MAX_BLOB_BYTES, 'Invalid blob inventory item');
        const hash = validateBlobHash(item.hash);
        assert(!seen.has(hash) || seen.get(hash) === item.size, 'Inconsistent blob inventory');
        if (seen.has(hash)) continue; seen.set(hash, item.size);
        try { await verifyBlob({ hash, size: item.size }); }
        catch (error) {
          if (error.code === 'ENOENT') { missing.push(hash); continue; }
          throw error;
        }
      }
      return send(req, res, token, { missing });
    }
    const match = /^\/v2\/projects\/([^/]+)\/(head|legacy|changes|checkpoints|receipts|commits|migrate)(?:\/([^/]+))?$/.exec(pathname);
    if (!match) return false;
    const projectId = routeId(match[1]), action = match[2], leaf = match[3] === undefined ? undefined : routeId(match[3]);
    if (req.method === 'GET') {
      if (action === 'head' && leaf === undefined) { queryFields(url, []); return send(req, res, token, { head: await sync.head(projectId) }); }
      if (action === 'legacy' && leaf === undefined) {
        queryFields(url, []);
        const current = await sync.head(projectId);
        if (current) throw failure(409, 'SYNC_ALREADY_MIGRATED');
        const entries = store.state.checkpoints.filter(item => item.projectId === projectId), heads = legacyHeads(projectId);
        return send(req, res, token, { projectId, heads, latestCheckpointId: entries.at(-1)?.id ?? null, checkpointCount: entries.length });
      }
      if (action === 'changes' && leaf === undefined) {
        queryFields(url, ['afterRevision', 'untilRevision', 'limit']);
        return send(req, res, token, await sync.changes(projectId, {
          afterRevision: integer(url.searchParams, 'afterRevision', 0), untilRevision: integer(url.searchParams, 'untilRevision', undefined), limit: integer(url.searchParams, 'limit', 100),
        }));
      }
      if (action === 'checkpoints' && leaf !== undefined) { queryFields(url, []); return send(req, res, token, await sync.getCheckpoint(projectId, leaf)); }
      if (action === 'receipts' && leaf !== undefined) { queryFields(url, []); return send(req, res, token, { receipt: await sync.receipt(projectId, leaf) }); }
    }
    if (req.method === 'POST' && leaf === undefined && ['commits', 'migrate'].includes(action)) {
      queryFields(url, []);
      const input = await readJson(req, MAX_MANIFEST_BYTES + 256 * 1024);
      assert(input?.manifest?.projectId === projectId, 'Project path and manifest differ');
      const beforeCommit = async () => {
        checked(token);
        if (action === 'commits' && !(await sync.head(projectId)) && legacyHeads(projectId).length) throw failure(409, 'SYNC_MIGRATION_REQUIRED');
      };
      const trusted = { authenticatedDeviceId: token.deviceId, beforeCommit, checkLegacyHeads: async id => legacyHeads(id) };
      const receipt = await (action === 'migrate' ? sync.migrate(input, trusted) : sync.commit(input, trusted));
      // The mutation already rechecked auth at its commit point. A response after
      // expiry must not misrepresent a committed write as a definitive rejection.
      sendJson(req, res, 201, receipt); return true;
    }
    throw failure(405, 'BAD_REQUEST');
  };
}
