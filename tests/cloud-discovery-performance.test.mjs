import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { createLegacyProjectCatalog } from '../server/project-catalog.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-catalog-performance-only';
const deviceId = 'catalog-device';
const v2Manifest = (projectId, id, extra = {}) => ({ version: 2, id, projectId, deviceId, parentId: null, policyRevision: 1, files: [], tombstones: [], conflicts: [], archiveRefs: [], label: `Project ${projectId}`, ...extra });
const v1Manifest = (projectId, id, extra = {}) => ({ version: 1, id, projectId, deviceId, parentId: null, createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: `/synthetic/${projectId}`, sessionIds: [], files: [], ...extra });
const commitV2 = (client, manifest, revision = 0) => client.commitSync({ manifest, expectedHeadRevision: revision, expectedHeadId: manifest.parentId, requestId: `request-${manifest.id}` });
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'cloud-discovery-performance-'));
  let server, url;
  const requests = [];
  async function open(options = {}) {
    server = await createSyncServer({ dataDir: directory, ...options });
    server.on('request', req => requests.push(`${req.method} ${req.url}`));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  }
  await open({ username: 'owner', password });
  t.after(async () => {
    await closeSyncServer(server);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.match(path.basename(directory), /^cloud-discovery-performance-[A-Za-z0-9]+$/);
    const info = await fs.lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    await fs.rm(directory, { recursive: true, force: true });
  });
  const client = new SyncV2Client({ server: url });
  const grant = await client.loginRenewable({ username: 'owner', password, deviceId });
  return { directory, client, grant, requests, get url() { return url; }, async restart() {
    await closeSyncServer(server); await open(); client.server = url;
  } };
}
async function oldDiscovery(client) {
  assert.equal(await client.supportsV2(), true); await client.capabilities();
  const projects = []; let cursor = null;
  do { const page = await client.syncProjects({ limit: 100, cursor }); projects.push(...page.projects); cursor = page.nextCursor; } while (cursor !== null);
  const old = await client.projects(); return { projects, old };
}
function instrument(t, f) {
  const open = fs.open, parse = JSON.parse;
  let counts;
  t.mock.method(fs, 'open', async function(filename, flags, ...rest) {
    if (counts && typeof flags === 'number' && path.resolve(String(filename)).startsWith(f.directory + path.sep)) {
      const name = path.relative(f.directory, String(filename)).replaceAll('\\', '/');
      if (name.endsWith('/head.json')) counts.headReads++;
      else if (name.includes('/records/')) counts.recordReads++;
      else if (name.includes('/manifests/')) counts.v2ManifestReads++;
      else if (name.startsWith('checkpoints/')) counts.legacyManifestReads++;
      else if (name.startsWith('blobs/')) counts.blobReads++;
    }
    return open.call(this, filename, flags, ...rest);
  });
  t.mock.method(JSON, 'parse', function(text, ...rest) {
    if (counts && typeof text === 'string') {
      if (text.includes('"tombstones":') && text.includes('"files":')) counts.v2ManifestParses++;
      if (text.includes('"sourceRoot":') && text.includes('"sessionIds":')) counts.legacyManifestParses++;
    }
    return parse.call(this, text, ...rest);
  });
  return async action => {
    counts = { headReads: 0, recordReads: 0, v2ManifestReads: 0, legacyManifestReads: 0, blobReads: 0, v2ManifestParses: 0, legacyManifestParses: 0 };
    const offset = f.requests.length, started = performance.now();
    const result = await action();
    const metrics = { ...counts, requests: f.requests.slice(offset), elapsedMs: Number((performance.now() - started).toFixed(2)) };
    counts = null;
    return { result, metrics };
  };
}

test('synthetic discovery measures fewer HTTP/parse operations without skipping current-byte integrity reads', async t => {
  const f = await fixture(t), bytes = Buffer.from('synthetic catalog bytes'), hash = sha256(bytes);
  await f.client.uploadBlob(hash, bytes);
  for (let project = 0; project < 3; project++) {
    const files = Array.from({ length: 512 }, (_, i) => ({ path: `file-${String(i).padStart(4, '0')}.txt`, hash, size: bytes.length, executable: false }));
    await commitV2(f.client, v2Manifest(`v2-${project}`, `v2-${project}-1`, { files }));
  }
  for (let project = 0; project < 4; project++) {
    let parentId = null;
    for (let revision = 0; revision < 12; revision++) {
      const id = `legacy-${project}-${revision}`, files = Array.from({ length: 128 }, (_, i) => ({ path: `project/file-${i}.txt`, sha256: hash, size: bytes.length }));
      await f.client.commit(v1Manifest(`legacy-${project}`, id, { parentId, files })); parentId = id;
    }
  }
  // Baseline measured before changing production code on 0fa991e with this exact
  // fixture/instrumentation: 178.22ms (one local sample, NOT a latency guarantee).
  const baseline = { requests: 4, headReads: 6, recordReads: 3, v2ManifestReads: 3, legacyManifestReads: 4, blobReads: 0, v2ManifestParses: 3, legacyManifestParses: 4, elapsedMs: 178.22 };
  const stateBefore = await fs.readFile(path.join(f.directory, 'state.json'));
  const measure = instrument(t, f), cold = await measure(() => f.client.discoverProjects()), warm = await measure(() => f.client.discoverProjects());
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'state.json')), stateBefore, 'read-only catalog must not mutate persisted schema/state');
  for (const { result, metrics } of [cold, warm]) {
    assert.equal(result.projects.length, 7); assert.equal(result.partial, undefined);
    assert.equal(metrics.requests.length, 2); assert.equal(metrics.headReads, 3);
    assert.equal(metrics.recordReads, 3); assert.equal(metrics.v2ManifestReads, 3); assert.equal(metrics.legacyManifestReads, 4);
    assert.equal(metrics.blobReads, 0); assert.equal(metrics.v2ManifestParses, 0);
  }
  assert.equal(cold.metrics.legacyManifestParses, 4); assert.equal(warm.metrics.legacyManifestParses, 0);
  const compatible = await measure(() => oldDiscovery(f.client));
  assert.equal(compatible.result.projects.length, 3); assert.equal(compatible.result.old.projects.length, 4);
  assert.equal(compatible.metrics.headReads, 3); assert.equal(compatible.metrics.v2ManifestParses, 0); assert.equal(compatible.metrics.legacyManifestParses, 0);
  t.diagnostic(JSON.stringify({ fixture: '3 v2 x 512 files; 4 legacy x 12 revisions x 128 files', baseline, cold: cold.metrics, warm: warm.metrics, oldEndpoints: compatible.metrics,
    deterministic80msRttBudgetMs: { baselineNegotiation: 320, baselineBoundIdentity: 240, catalog: 160 } }));
});

test('legacy aggregate is built once per immutable checkpoint generation, not every page or auth write', async t => {
  const history = Array.from({ length: 20_000 }, (_, i) => ({ id: `checkpoint-${i}`, projectId: `project-${i % 20}`, createdAt: '2025-01-01T00:00:00.000Z' }));
  let visited = 0;
  const counted = values => new Proxy(values, { get(target, key, receiver) {
    if (key === Symbol.iterator) return function* () { for (const row of target) { visited++; yield row; } };
    return Reflect.get(target, key, receiver);
  } });
  const store = { state: { checkpoints: counted(history) } }, catalog = createLegacyProjectCatalog({ store, metadataFor: async entry => ({ label: entry.projectId, sourceRoot: `/synthetic/${entry.projectId}`, latestCheckpointId: entry.id }) });
  // Reproduce the former /v1/projects aggregate over the same counted array;
  // this is a measured synthetic operation count, not a cloud/server benchmark.
  const oldStarted = performance.now();
  for (let i = 0; i < 10; i++) {
    const projects = new Map(), latest = new Map();
    for (const entry of store.state.checkpoints) {
      const prior = projects.get(entry.projectId);
      if (prior) { prior.checkpointCount++; if (Date.parse(entry.createdAt) > Date.parse(prior.latestCreatedAt)) prior.latestCreatedAt = entry.createdAt; }
      else projects.set(entry.projectId, { projectId: entry.projectId, checkpointCount: 1, latestCreatedAt: entry.createdAt });
      latest.set(entry.projectId, entry);
    }
    assert.equal(projects.size, 20); assert.equal(latest.size, 20);
  }
  const oldLoopEntryVisits = visited, tenOldAggregateMs = Number((performance.now() - oldStarted).toFixed(2)); assert.equal(oldLoopEntryVisits, 200_000); visited = 0;
  const started = performance.now(), first = catalog.index(); assert.equal(first.length, 20); assert.equal(visited, 20_000);
  const buildMs = Number((performance.now() - started).toFixed(2));
  visited = 0; const warmStarted = performance.now();
  for (let i = 0; i < 10; i++) assert.equal((await catalog.list()).projects.length, 20);
  const tenWarmAggregateMs = Number((performance.now() - warmStarted).toFixed(2)); assert.equal(visited, 0);
  store.state = { ...store.state, tokens: [] }; assert.equal(catalog.index(), first); assert.equal(visited, 0);
  const entry = { id: 'new-latest', projectId: 'project-0', createdAt: '2024-01-01T00:00:00.000Z' };
  store.state = { ...store.state, checkpoints: counted([...history, entry]) };
  const next = catalog.index(); assert.notEqual(next, first); assert.equal(visited, 20_001);
  const row = (await catalog.list()).projects.find(item => item.projectId === entry.projectId);
  assert.equal(row.latestCheckpointId, entry.id); assert.equal(row.checkpointCount, 1001); assert.equal(row.latestCreatedAt, '2025-01-01T00:00:00.000Z');
  t.diagnostic(JSON.stringify({ history: 20_000, projects: 20, buildMs, tenOldAggregateMs, tenWarmAggregateMs, tenWarmListings: { oldLoopEntryVisits, indexedEntryVisits: 0 }, newGenerationEntryVisits: visited }));
});

test('bounded mixed pages read only selected latest manifests and fence commit/restart generations', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.client.commit(v1Manifest(`legacy-${i}`, `legacy-${i}-first`));
  for (let i = 0; i < 3; i++) await commitV2(f.client, v2Manifest(`canonical-${i}`, `canonical-${i}-first`));
  const measure = instrument(t, f), first = await measure(() => f.client.projectCatalog({ limit: 2 }));
  assert.equal(first.result.projects.length, 2); assert.ok(first.result.nextCursor);
  assert.equal(first.metrics.legacyManifestReads + first.metrics.v2ManifestReads, 2);
  assert.equal(first.metrics.blobReads, 0);
  const rows = [...first.result.projects]; let cursor = first.result.nextCursor;
  while (cursor !== null) { const page = await f.client.projectCatalog({ limit: 2, cursor }); rows.push(...page.projects); cursor = page.nextCursor; }
  assert.equal(rows.length, 8); assert.equal(new Set(rows.map(row => row.projectId)).size, 8);
  const keys = rows.map(row => sha256(Buffer.from(row.projectId))); assert.deepEqual(keys, [...keys].sort());
  const capped = await f.client.discoverProjects({ limit: 2, maxPages: 1 }); assert.equal(capped.partial, true); assert.equal(capped.projects.length, 2);
  await f.client.commit(v1Manifest('legacy-0', 'legacy-0-next', { parentId: 'legacy-0-first' }));
  await assert.rejects(f.client.projectCatalog({ limit: 2, cursor: first.result.nextCursor }), { code: 'SYNC_CATALOG_CHANGED', httpStatus: 409 });
  const second = await f.client.projectCatalog({ limit: 2 });
  await commitV2(f.client, v2Manifest('canonical-0', 'canonical-0-next', { parentId: 'canonical-0-first' }), 1);
  await assert.rejects(f.client.projectCatalog({ limit: 2, cursor: second.nextCursor }), { code: 'SYNC_CATALOG_CHANGED' });
  const third = await f.client.projectCatalog({ limit: 2 }); await f.restart();
  await assert.rejects(f.client.projectCatalog({ limit: 2, cursor: third.nextCursor }), { code: 'SYNC_CATALOG_CHANGED' });
  for (const route of ['/v2/project-catalog?limit=0', '/v2/project-catalog?limit=201', '/v2/project-catalog?limit=1&limit=2', '/v2/project-catalog?unknown=1', '/v2/project-catalog?cursor=invalid']) await assert.rejects(f.client.requestV2(route), { httpStatus: 400 });
});

test('warm legacy metadata cache rechecks same-size bytes and never substitutes older history', async t => {
  const f = await fixture(t);
  await f.client.commit(v1Manifest('legacy', 'old', { sourceRoot: '/synthetic/older' }));
  await f.client.commit(v1Manifest('legacy', 'latest', { parentId: 'old', sourceRoot: '/synthetic/latest' }));
  await f.client.commit(v1Manifest('healthy', 'healthy'));
  assert.equal((await f.client.discoverProjects()).projects.find(row => row.projectId === 'legacy').label, 'latest');
  const filename = path.join(f.directory, 'checkpoints', `${sha256(Buffer.from('latest'))}.json`), before = await fs.stat(filename), contents = await fs.readFile(filename, 'utf8');
  const corrupt = contents.replace('/synthetic/latest', '/synthetic/secret'); assert.equal(corrupt.length, contents.length);
  await fs.writeFile(filename, corrupt); await fs.utimes(filename, before.atime, before.mtime);
  const raw = await f.client.projectCatalog(); assert.equal(raw.partial, true); assert.equal(raw.projects.find(row => row.projectId === 'legacy').corrupt, true);
  assert.ok(!JSON.stringify(raw).includes('/synthetic/secret')); assert.ok(!JSON.stringify(raw).includes('/synthetic/older'));
  const result = await f.client.discoverProjects(); assert.equal(result.partial, true); assert.deepEqual(result.projects.map(row => row.projectId), ['healthy']);
  assert.deepEqual((await f.client.projects()).projects.map(row => row.projectId), ['healthy']);
  await assert.rejects(f.client.latestCheckpoint('legacy'), { httpStatus: 500 });
});

test('warm v2 head/record/manifest corruption remains fail-closed with no migrated legacy fallback', async t => {
  for (const mode of ['head', 'record', 'manifest', 'historical-record-on-reopen']) await t.test(mode, async sub => {
    const f = await fixture(sub);
    await f.client.commit(v1Manifest('migrated', 'legacy-old'));
    const first = v2Manifest('migrated', 'first');
    const receipt = await f.client.migrateSync({ manifest: first, expectedHeadRevision: 0, expectedHeadId: null, requestId: 'migrate-first', expectedLegacyHeads: ['legacy-old'] });
    await commitV2(f.client, v2Manifest('healthy', 'healthy-first'));
    if (mode === 'historical-record-on-reopen') await commitV2(f.client, v2Manifest('migrated', 'second', { parentId: 'first' }), 1);
    assert.equal((await f.client.discoverProjects()).projects.length, 2);
    const root = path.join(f.directory, 'sync-v2', 'projects', sha256(Buffer.from('migrated')));
    const filename = mode === 'head' ? path.join(root, 'head.json') : mode === 'manifest' ? path.join(root, 'manifests', `${sha256(Buffer.from('first'))}-${receipt.manifestDigest}.json`) : path.join(root, 'records', `${receipt.recordHash}.json`);
    const contents = await fs.readFile(filename, 'utf8');
    await fs.writeFile(filename, contents.replace('first', 'wrong'));
    if (mode === 'historical-record-on-reopen') await f.restart();
    const result = await f.client.discoverProjects();
    assert.equal(result.partial, true); assert.deepEqual(result.projects.map(row => row.projectId), ['healthy']);
    assert.ok(result.projects.every(row => row.legacy === false));
    await assert.rejects(f.client.syncHead('migrated'), { code: 'SYNC_PROJECT_CORRUPT' });
  });
});

async function peer(t, respond) {
  const requests = [], token = 'x'.repeat(43);
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const value = respond(req.url, req, res);
    if (res.writableEnded) return;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  return { requests, client: new SyncV2Client({ server: `http://127.0.0.1:${server.address().port}`, token, serverId: 'peer-server' }) };
}
const oldCapabilities = { protocol: 2, serverId: 'peer-server', bidirectional: true, recoverableDeletes: true };
const legacyRow = id => ({ projectId: id, checkpointCount: 1, latestCreatedAt: '2025-01-01T00:00:00.000Z', label: id, sourceRoot: `/synthetic/${id}`, latestCheckpointId: `${id}-old` });

test('0.9 protocol-2 fallback is feature-negotiated and masks corrupt migrated ids including anonymous keys', async t => {
  const f = await peer(t, route => {
    if (route === '/v2/capabilities') return oldCapabilities;
    if (route === '/v2/projects?limit=100') return { projects: [
      { projectId: 'migrated-known', corrupt: true },
      { projectId: null, projectKey: sha256(Buffer.from('migrated-anonymous')), corrupt: true },
    ], nextCursor: null };
    if (route === '/v1/projects') return { projects: ['migrated-known', 'migrated-anonymous', 'legacy-safe'].map(legacyRow) };
    assert.fail(`Unexpected synthetic route: ${route}`);
  });
  const result = await f.client.discoverProjects(); assert.equal(result.partial, true); assert.deepEqual(result.projects.map(row => row.projectId), ['legacy-safe']);
  assert.deepEqual(f.requests, ['/v2/capabilities', '/v2/projects?limit=100', '/v1/projects']);
});

test('incomplete old-server canonical pages cannot authorize fallback to unexamined legacy projects', async t => {
  const f = await peer(t, route => {
    if (route === '/v2/capabilities') return oldCapabilities;
    if (route === '/v2/projects?limit=1') return { projects: [{ projectId: 'broken', corrupt: true }], nextCursor: 'a'.repeat(64) };
    assert.fail(`Unsafe fallback route: ${route}`);
  });
  assert.deepEqual(await f.client.discoverProjects({ limit: 1, maxPages: 1 }), { serverId: 'peer-server', projects: [], partial: true });
  assert.equal(f.requests.length, 2);
});

test('client discards an interrupted catalog generation and restarts without duplicates or stale labels', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.client.commit(v1Manifest(`project-${i}`, `first-${i}`, { sourceRoot: `/synthetic/old-${i}` }));
  const original = f.client.projectCatalog.bind(f.client); let changed = false, starts = 0, changedId;
  t.mock.method(f.client, 'projectCatalog', async options => {
    if (options.cursor === null) starts++;
    const page = await original(options);
    if (!changed) {
      changed = true; changedId = page.projects[0].projectId;
      await f.client.commit(v1Manifest(changedId, 'updated', { parentId: page.projects[0].latestCheckpointId, sourceRoot: '/synthetic/current-label' }));
    }
    return page;
  });
  const result = await f.client.discoverProjects({ limit: 1 });
  assert.equal(starts, 2); assert.equal(result.projects.length, 3); assert.equal(new Set(result.projects.map(row => row.projectId)).size, 3);
  assert.equal(result.projects.find(row => row.projectId === changedId).label, 'current-label');
});

test('catalog rechecks authorization after metadata I/O and never returns data to a revoked token', async t => {
  const f = await fixture(t); await f.client.commit(v1Manifest('legacy', 'first'));
  const other = new SyncV2Client({ server: f.url, token: f.grant.token, serverId: f.grant.serverId });
  const filename = path.join(f.directory, 'checkpoints', `${sha256(Buffer.from('first'))}.json`), open = fs.open;
  let revoked = false;
  t.mock.method(fs, 'open', async function(name, flags, ...rest) {
    const handle = await open.call(this, name, flags, ...rest);
    if (!revoked && path.resolve(String(name)) === filename && typeof flags === 'number') {
      revoked = true; assert.equal((await other.logout()).remoteRevoked, true);
    }
    return handle;
  });
  await assert.rejects(f.client.projectCatalog(), { code: 'NOT_LOGGED_IN', httpStatus: 401 }); assert.equal(revoked, true);
});

test('client fences each page to account identity and bounds repeated catalog restarts', async t => {
  const generation = 'a'.repeat(32), id = 'legacy', key = sha256(Buffer.from(id));
  let mode = 'wrong-account';
  const f = await peer(t, (route, req, res) => {
    if (route === '/v2/capabilities') return { ...oldCapabilities, projectCatalog: true };
    if (route === '/v2/project-catalog?limit=1') return { serverId: mode === 'wrong-account' ? 'other-account' : 'peer-server', generation,
      projects: [{ ...legacyRow(id), legacy: true }], nextCursor: `${generation}.${key}`, partial: false };
    if (route.startsWith('/v2/project-catalog?limit=1&cursor=')) { res.statusCode = 409; return { code: 'SYNC_CATALOG_CHANGED' }; }
    assert.fail(`Unexpected synthetic route: ${route}`);
  });
  await assert.rejects(f.client.discoverProjects({ limit: 1 }), { code: 'ACCOUNT_MISMATCH' });
  mode = 'changing'; const before = f.requests.length;
  await assert.rejects(f.client.discoverProjects({ limit: 1 }), { code: 'SYNC_CATALOG_CHANGED' });
  assert.equal(f.requests.length - before, 7, 'one capabilities request plus three bounded two-page attempts');
  const beforeEpoch = f.requests.length; let checks = 0;
  await assert.rejects(f.client.discoverProjects({ limit: 1, check: async () => { if (++checks >= 2) throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_MISMATCH' }); } }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.requests.length - beforeEpoch, 2, 'stop after first response when authorization epoch changed');
});

test('catalog client rejects malformed paging/metadata and strips unrelated response fields', async t => {
  const generation = 'a'.repeat(32), validRow = { ...legacyRow('legacy'), legacy: true }, valid = { serverId: 'peer-server', generation, projects: [validRow], nextCursor: null, partial: false };
  let response = valid;
  const f = await peer(t, () => response);
  response = { ...valid, secret: 'not-displayable', projects: [{ ...validRow, credential: 'not-displayable' }] };
  assert.ok(!JSON.stringify(await f.client.projectCatalog({ limit: 2 })).includes('not-displayable'));
  for (const patch of [
    { generation: 'wrong' }, { partial: 'yes' }, { nextCursor: `${generation}.${'b'.repeat(64)}` },
    { projects: [validRow, validRow] }, { projects: [{ ...validRow, label: 'not-the-folder' }] },
    { projects: [{ ...validRow, sourceRoot: '../secret' }] }, { projects: [{ ...validRow, checkpointCount: -1 }] },
    { projects: [{ ...validRow, latestCheckpointId: '../unsafe' }] },
    { projects: [{ projectId: 'legacy', projectKey: 'b'.repeat(64), legacy: true, corrupt: true }], partial: true },
    { projects: [{ projectId: 'legacy', projectKey: sha256(Buffer.from('legacy')), legacy: true, corrupt: true }] },
  ]) {
    response = { ...valid, ...patch }; await assert.rejects(f.client.projectCatalog({ limit: 2 }));
  }
  response = { ...valid, generation: 'b'.repeat(32) };
  await assert.rejects(f.client.projectCatalog({ limit: 2, cursor: `${generation}.${'0'.repeat(64)}` }));
});
