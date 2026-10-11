import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createController } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { sha256 } from '../src/protocol.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-latest-password';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const binding = status => ({ revision: status.revision, server: status.server, username: status.username });
const missing = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
const listing = root => ({ path: root, home: root, entries: [], crumbs: [{ name: path.basename(root), path: root, hidden: false }], truncated: false });

// Real loopback cloud HTTP; the test-only request hook delays or corrupts a response
// without mocking SyncClient or touching a real Host profile/chooser.
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'latest-download-'));
  const profileDir = path.join(root, 'private', 'profile'), parent = path.join(root, 'destinations');
  await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(parent);
  const records = new Map(), workspaces = new Map(), imports = [], requests = [], releases = [];
  let clock = Date.now(), pickCalls = 0, hook;
  let capability = { kind: 'native', pick: async () => { pickCalls++; return parent; } }, provider = { capability: () => capability };
  const ctx = { get(name) { assert.equal(name, 'directoryPicker'); return provider; }, workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) }, credentials: {
    readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); }, deleteRecord: async key => records.delete(key),
  } };
  const controller = createController(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false, importSessions: async (_ctx, { manifest, root }) => {
    imports.push({ manifest, root });
    return { imported: manifest.sessionIds.map(sourceId => ({ sourceId, sessionId: `native-${sourceId}`, workspaceAttached: true })), skipped: [], failed: [] };
  } });
  const service = createSettingsService(ctx, controller, { profileDir, dshHome: path.join(root, 'private'), pickerOptions: { now: () => clock } });
  const bridge = createSettingsHttp(service), cloudDir = path.join(root, 'cloud');
  const cloud = await createSyncServer({ dataDir: cloudDir, username: 'owner', password });
  const handlers = cloud.listeners('request'); cloud.removeAllListeners('request');
  cloud.on('request', (req, res) => {
    const entry = { method: req.method, url: req.url }; requests.push(entry);
    void (async () => {
      const replacement = await hook?.(entry, req, res);
      if (res.destroyed) return;
      if (replacement) { res.writeHead(replacement.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(replacement.json ?? {})); }
      else for (const handler of handlers) handler.call(cloud, req, res);
    })().catch(error => { res.destroy(error); });
  });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${cloud.address().port}`;
  t.after(async () => {
    for (const release of releases) release();
    bridge.dispose(); controller.stop(); await controller.drain(); await closeSyncServer(cloud);
    assert.equal(path.dirname(root), path.resolve(base)); assert.match(path.basename(root), /^latest-download-[A-Za-z0-9]+$/);
    await fs.rm(root, { recursive: true, force: true }); await missing(root);
  });
  async function rpc(action, payload, signal) {
    const request = new Request(`http://dsh.internal${SETTINGS_API}${action}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'latest-rpc', method: `dsh-personal-sync/${action}`, payload }) });
    const response = await bridge.fetch(action, request); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.rpcId, 'latest-rpc');
    const text = JSON.stringify(body); assert.ok(!text.includes(password));
    const token = records.get(controller.credentialKey)?.payload?.token; if (token) assert.ok(!text.includes(token));
    return body.result;
  }
  async function good(action, payload, signal) { const result = await rpc(action, payload, signal); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
  async function reject(action, payload, code) { const result = await rpc(action, payload); assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code); return result; }
  const bound = binding(await good('login', { server, username: 'owner', password }));
  const client = new SyncClient(records.get(controller.credentialKey).payload);
  async function commit(projectId, id, { text = id, sourceRoot = `/remote/${projectId}`, createdAt = '2020-01-02T00:00:00.000Z', parentId = null, sessionIds = [] } = {}) {
    const files = [];
    for (const [name, bytes] of [['project/hello.txt', Buffer.from(text)], ...sessionIds.map(sessionId => [`sessions/${sessionId}.json`, Buffer.from(JSON.stringify({ id: sessionId, synthetic: true, checkpoint: id }))])]) {
      const hash = sha256(bytes); await client.uploadBlob(hash, bytes); files.push({ path: name, sha256: hash, size: bytes.length });
    }
    const manifest = { version: 1, id, projectId, deviceId: client.deviceId, parentId, createdAt, sourceRoot, sessionIds, files };
    await client.commit(manifest); return manifest;
  }
  const manifests = [];
  for (let i = 0; i < 3; i++) manifests.push(await commit(`project-${i}`, `zzz-first-${i}`, { createdAt: '2099-01-02T00:00:00.000Z' }));
  const pick = (projectIds = ['project-0'], signal) => good('downloadpick', { ...bound, latest: true, items: projectIds.map(projectId => ({ projectId })) }, signal);
  const payload = plan => ({ ...bound, latest: true, items: plan.destinations.map(item => ({ projectId: item.projectId, destinationId: item.id })), requestId: randomUUID(), confirm: true });
  async function settle() { await controller.drain(); return (await good('status', {})).download; }
  function gate(predicate = entry => entry.method === 'GET' && entry.url === '/v1/checkpoints?projectId=project-0') {
    const entered = deferred(), released = deferred(), closed = deferred(); let blocked = false;
    releases.push(released.resolve);
    hook = async (entry, _req, res) => {
      if (!blocked && predicate(entry)) { blocked = true; res.once('close', closed.resolve); entered.resolve(); await released.promise; }
    };
    return { entered: entered.promise, release: released.resolve, closed: closed.promise };
  }
  return { root, parent, profileDir, records, workspaces, imports, requests, controller, service, cloudDir, client, manifests, bound, pick, payload, settle, rpc, good, reject, commit, gate,
    setHook(value) { hook = value; }, advance(ms) { clock += ms; }, setCapability(value) { capability = value; }, replaceProvider() { provider = { capability: () => capability }; }, get pickCalls() { return pickCalls; } };
}

function publicPlan(plan) {
  assert.equal(plan.latest, true);
  for (const item of plan.destinations) assert.deepEqual(Object.keys(item).sort(), ['id', 'label', 'parent', 'projectId', 'root']);
}

// Timestamp and lexicographic ordering both disagree with authoritative commit order.
test('latest helper chooses last successful append commit with multiple heads and clock skew, never orphan or rejected commit', async t => {
  const f = await fixture(t), first = f.manifests[0];
  const last = await f.commit(first.projectId, 'aaa-last', { sourceRoot: '/remote/latest-name' });
  await assert.rejects(f.commit(first.projectId, 'rejected', { parentId: 'missing-parent' }), { status: 409 });
  const orphan = { ...last, id: 'orphan-newest', createdAt: '2199-01-02T00:00:00.000Z' };
  await fs.writeFile(path.join(f.cloudDir, 'checkpoints', `${sha256(Buffer.from(orphan.id))}.json`), JSON.stringify(orphan));
  const history = await f.client.list(first.projectId);
  assert.deepEqual(history.checkpoints.map(item => item.id), [first.id, last.id]); assert.deepEqual(new Set(history.heads), new Set([first.id, last.id]));
  assert.equal((await f.client.latestCheckpoint(first.projectId)).id, last.id);
  const mark = f.requests.length, plan = await f.pick(); publicPlan(plan); assert.equal(plan.destinations[0].label, 'latest-name');
  await f.good('downloadstart', f.payload(plan)); const result = await f.settle();
  assert.equal(result.latest, true); assert.equal(result.items[0].checkpointId, last.id); assert.equal(await fs.readFile(path.join(result.items[0].root, 'hello.txt'), 'utf8'), last.id);
  assert.ok(f.requests.slice(mark).every(entry => entry.method === 'GET'), 'download never writes cloud history');
  assert.deepEqual(await f.client.list(first.projectId), history);
  await assert.rejects(f.client.latestCheckpoint('no-commits'), { code: 'CLOUD_PROJECT_EMPTY' });
  const reads = f.requests.length; await assert.rejects(f.client.latestCheckpoint('../invalid')); assert.equal(f.requests.length, reads);
});

test('latest start refreshes plan-time content without renaming authorized root and imports the actual new manifest digest', async t => {
  const f = await fixture(t), plan = await f.pick(); publicPlan(plan);
  const plannedRoot = plan.destinations[0].root; assert.equal(path.basename(plannedRoot), 'project-0');
  const latest = await f.commit('project-0', 'new-before-click', { sourceRoot: '/remote/renamed-at-source', text: 'current cloud bytes', sessionIds: ['new-session'] });
  const input = f.payload(plan), ack = (await f.good('downloadstart', input)).download;
  assert.equal(ack.latest, true); assert.equal(ack.id, input.requestId); assert.equal(ack.items[0].checkpointId, latest.id); assert.equal(ack.items[0].root, plannedRoot);
  const result = await f.settle(), item = result.items[0]; assert.equal(result.state, 'succeeded'); assert.equal(item.canImport, true); assert.equal(item.sessionCount, 1);
  assert.equal(await fs.readFile(path.join(plannedRoot, 'hello.txt'), 'utf8'), 'current cloud bytes'); await missing(path.join(f.parent, 'renamed-at-source'));
  assert.equal(f.imports.length, 0); assert.equal((await f.service.status()).autoSync, false);
  await f.good('import', { ...f.bound, restoreId: item.restoreId, requestId: randomUUID(), confirm: true });
  assert.equal((await f.settle()).items[0].importResult.state, 'succeeded'); assert.equal(f.imports[0].manifest.id, latest.id);
  assert.equal(f.imports[0].manifest.sourceRoot, latest.sourceRoot); assert.deepEqual(f.imports[0].manifest.sessionIds, ['new-session']);
});

test('accepted latest batch pins IDs despite later commits; duplicate request never refetches or rewrites after expiry', async t => {
  const f = await fixture(t), plan = await f.pick(['project-0', 'project-1']), input = f.payload(plan), page = new AbortController();
  const gate = f.gate(entry => entry.method === 'GET' && entry.url === `/v1/blobs/${f.manifests[0].files[0].sha256}`);
  const ack = (await f.good('downloadstart', input, page.signal)).download; page.abort(); await gate.entered;
  assert.equal(ack.latest, true); assert.deepEqual(ack.items.map(item => item.checkpointId), f.manifests.slice(0, 2).map(item => item.id));
  await f.commit('project-0', 'next-run-0'); await f.commit('project-1', 'next-run-1');
  const beforeDuplicate = f.requests.length; assert.equal((await f.good('downloadstart', input)).download.id, input.requestId); assert.equal(f.requests.length, beforeDuplicate);
  await f.reject('downloadstart', { ...input, requestId: randomUUID() }, 'BUSY');
  await assert.rejects(f.controller.runUpdate(() => assert.fail('update during accepted batch')), { code: 'BUSY' });
  f.advance(16 * 60_000); gate.release(); const result = await f.settle(); assert.equal(result.state, 'succeeded');
  for (const [index, item] of result.items.entries()) assert.equal(await fs.readFile(path.join(item.root, 'hello.txt'), 'utf8'), f.manifests[index].id);
  const target = path.join(result.items[0].root, 'hello.txt'); await fs.writeFile(target, 'local edit must survive duplicate');
  const before = f.requests.length; assert.deepEqual((await f.good('downloadstart', input)).download, result); assert.equal(f.requests.length, before);
  assert.equal(await fs.readFile(target, 'utf8'), 'local edit must survive duplicate');
  await f.reject('downloadstart', { ...input, items: [...input.items].reverse() }, 'BAD_REQUEST');
  const { latest, ...oldInput } = input;
  await f.reject('downloadstart', { ...oldInput, items: input.items.map((item, index) => ({ ...item, checkpointId: result.items[index].checkpointId })) }, 'BAD_REQUEST');
  await f.reject('downloadstart', { ...input, requestId: randomUUID() }, 'DIRECTORY_PICKER_EXPIRED');
  const fresh = await f.pick(['project-0', 'project-1']); await f.good('downloadstart', f.payload(fresh));
  const next = await f.settle(); assert.deepEqual(next.items.map(item => item.checkpointId), ['next-run-0', 'next-run-1']);
  for (const item of next.items) assert.equal(await fs.readFile(path.join(item.root, 'hello.txt'), 'utf8'), item.checkpointId);
});

test('latest protocol strictly rejects false/typed flags, injected checkpoint overrides, unknown/duplicate projects and oversized selection', async t => {
  const f = await fixture(t);
  for (const action of ['downloadpick', 'downloadbrowse', 'downloadselect', 'downloadstart']) for (const latest of [false, null, 1, 'true', {}, []]) await f.reject(action, { ...f.bound, latest }, 'BAD_REQUEST');
  for (const items of [[], [{ projectId: 'project-0' }, { projectId: 'project-0' }], [{ projectId: 'project-0', checkpointId: f.manifests[0].id }], [{ projectId: '../forged' }], [{ projectId: 'project-0', root: f.parent }]]) await f.reject('downloadpick', { ...f.bound, latest: true, items }, 'BAD_REQUEST');
  await f.reject('downloadpick', { ...f.bound, latest: true, items: Array.from({ length: 21 }, (_, i) => ({ projectId: `project-${i}` })) }, 'DOWNLOAD_LIMIT');
  await f.reject('downloadpick', { ...f.bound, latest: true, items: [{ projectId: 'unknown' }] }, 'CLOUD_PROJECT_EMPTY'); assert.equal(f.pickCalls, 0);
  const plan = await f.pick(), input = f.payload(plan);
  await f.reject('downloadstart', { ...input, checkpointId: f.manifests[0].id }, 'BAD_REQUEST');
  await f.reject('downloadstart', { ...input, items: [{ ...input.items[0], checkpointId: f.manifests[0].id }] }, 'BAD_REQUEST');
  await f.reject('downloadstart', { ...input, items: [{ ...input.items[0], projectId: 'unknown' }] }, 'DIRECTORY_PICKER_EXPIRED');
  await f.reject('downloadstart', { ...input, items: [{ ...input.items[0], destinationId: 'forged' }] }, 'DIRECTORY_PICKER_EXPIRED');
  assert.deepEqual(await fs.readdir(f.parent), []);
  f.setCapability({ kind: 'native', pick: async () => null }); assert.deepEqual(await f.pick(), { cancelled: true });
});

test('latest browse/select are marked and mode-bound; pinned batch and single historical APIs remain unchanged', async t => {
  const f = await fixture(t), old = f.manifests[0]; await f.commit(old.projectId, 'new-current');
  f.setCapability({ kind: 'browse', list: async () => listing(f.parent) });
  const latestBrowser = await f.pick(); assert.equal(latestBrowser.latest, true);
  const latestInput = { ...f.bound, latest: true, browserId: latestBrowser.browser.id, nodeId: latestBrowser.browser.currentId };
  assert.equal((await f.good('downloadbrowse', latestInput)).latest, true);
  const { latest, ...unmarked } = latestInput;
  for (const action of ['downloadbrowse', 'downloadselect', 'destinationbrowse', 'destinationselect']) await f.reject(action, unmarked, 'DIRECTORY_PICKER_EXPIRED');
  const plan = await f.good('downloadselect', latestInput); publicPlan(plan);
  const oldItem = { projectId: old.projectId, checkpointId: old.id };
  const pinnedBrowser = await f.good('downloadpick', { ...f.bound, items: [oldItem] }); assert.equal(Object.hasOwn(pinnedBrowser, 'latest'), false);
  const pinnedInput = { ...f.bound, browserId: pinnedBrowser.browser.id, nodeId: pinnedBrowser.browser.currentId };
  for (const action of ['downloadbrowse', 'downloadselect']) await f.reject(action, { ...pinnedInput, latest: true }, 'DIRECTORY_PICKER_EXPIRED');
  const pinnedPlan = await f.good('downloadselect', pinnedInput); assert.equal(Object.hasOwn(pinnedPlan, 'latest'), false); assert.equal(pinnedPlan.destinations[0].checkpointId, old.id);
  await f.reject('downloadstart', f.payload(pinnedPlan), 'DIRECTORY_PICKER_EXPIRED');
  await f.reject('downloadstart', { ...f.bound, items: [{ ...oldItem, destinationId: plan.destinations[0].id }], requestId: randomUUID(), confirm: true }, 'DIRECTORY_PICKER_EXPIRED');
  const single = await f.good('destinationpick', { ...f.bound, ...oldItem });
  const singleInput = { ...f.bound, browserId: single.browser.id, nodeId: single.browser.currentId };
  await f.reject('downloadselect', { ...singleInput, latest: true }, 'DIRECTORY_PICKER_EXPIRED');
  const singlePlan = await f.good('destinationselect', singleInput);
  await f.reject('downloadstart', { ...f.payload(plan), items: [{ projectId: old.projectId, destinationId: singlePlan.destination.id }] }, 'DIRECTORY_PICKER_EXPIRED');
  await f.reject('restore', { ...f.bound, ...oldItem, destinationId: plan.destinations[0].id, requestId: randomUUID(), confirm: true }, 'DIRECTORY_PICKER_EXPIRED');
  const oldStart = { ...f.bound, items: [{ ...oldItem, destinationId: pinnedPlan.destinations[0].id }], requestId: randomUUID(), confirm: true };
  assert.equal(Object.hasOwn((await f.good('downloadstart', oldStart)).download, 'latest'), false);
  const pinned = await f.settle(); assert.equal(Object.hasOwn(pinned, 'latest'), false); assert.equal(pinned.items[0].checkpointId, old.id);
  assert.equal(await fs.readFile(path.join(pinned.items[0].root, 'hello.txt'), 'utf8'), old.id);
  await f.good('restore', { ...f.bound, ...oldItem, destinationId: singlePlan.destination.id, requestId: randomUUID(), confirm: true }); await f.controller.drain();
  assert.equal(await fs.readFile(path.join(singlePlan.destination.root, 'hello.txt'), 'utf8'), old.id);
  const commandRoot = path.join(f.parent, 'legacy-command'); await f.controller.restore(old.id, commandRoot);
  assert.equal(await fs.readFile(path.join(commandRoot, 'hello.txt'), 'utf8'), old.id);
  await f.good('downloadstart', f.payload(plan)); assert.equal((await f.settle()).items[0].checkpointId, 'new-current');
});

test('latest plan group remains atomic: partial/mixed selections and cross-project plan injection reject without files', async t => {
  const f = await fixture(t), first = await f.pick(['project-0', 'project-1']), second = await f.pick(['project-0', 'project-1']);
  const input = f.payload(first), other = f.payload(second);
  for (const items of [[input.items[0]], [input.items[0], other.items[1]], [input.items[0], { ...input.items[1], destinationId: input.items[0].destinationId }], [{ ...input.items[0], projectId: 'project-1' }, { ...input.items[1], projectId: 'project-0' }]]) {
    await f.reject('downloadstart', { ...input, items });
  }
  assert.deepEqual(await fs.readdir(f.parent), []);
});

test('empty, malformed, wrong-project and missing/corrupt latest responses reject entire admission without older fallback', async t => {
  const f = await fixture(t), plan = await f.pick(['project-0', 'project-1']), input = f.payload(plan), last = f.manifests[1];
  const catalog = await f.client.list(last.projectId);
  const cases = [
    { route: '/v1/checkpoints?projectId=project-1', json: { checkpoints: [], heads: [] }, code: 'CLOUD_PROJECT_EMPTY' },
    { route: '/v1/checkpoints?projectId=project-1', json: { checkpoints: [{ ...catalog.checkpoints[0], projectId: 'wrong-project' }], heads: catalog.heads }, code: 'BAD_REQUEST' },
    { route: '/v1/checkpoints?projectId=project-1', json: { checkpoints: catalog.checkpoints, heads: ['forged'] }, code: 'BAD_REQUEST' },
    { route: `/v1/checkpoints/${last.id}`, json: { ...last, projectId: 'wrong-project' }, code: 'CHECKPOINT_MISMATCH' },
    { route: `/v1/checkpoints/${last.id}`, json: { ...last, files: [{ ...last.files[0], sha256: 'corrupt' }] }, code: 'BAD_REQUEST' },
    { route: `/v1/checkpoints/${last.id}`, json: { ...last, deviceId: 'different-device' }, code: 'BAD_REQUEST' },
    { route: `/v1/checkpoints/${last.id}`, json: {}, status: 404, code: 'SETTINGS_FAILED' },
  ];
  for (const scenario of cases) {
    f.setHook(entry => entry.url === scenario.route ? scenario : undefined);
    await f.reject('downloadstart', input, scenario.code); await f.controller.drain();
    assert.deepEqual(await fs.readdir(f.parent), []); assert.equal((await f.service.status()).download, undefined);
  }
  f.setHook(undefined);
  const corruptLatest = await f.commit(last.projectId, 'corrupt-newest');
  const filename = path.join(f.cloudDir, 'checkpoints', `${sha256(Buffer.from(corruptLatest.id))}.json`);
  await fs.writeFile(filename, JSON.stringify({ ...corruptLatest, sourceRoot: '/remote/tampered' }));
  const before = f.requests.length; await f.reject('downloadstart', input); await f.controller.drain();
  assert.ok(!f.requests.slice(before).some(entry => entry.url === `/v1/checkpoints/${last.id}`), 'never fall back to an older valid snapshot');
  assert.deepEqual(await fs.readdir(f.parent), []);
});

test('planning validates latest cloud metadata before opening any chooser', async t => {
  const f = await fixture(t), last = f.manifests[0];
  f.setHook(entry => entry.url === `/v1/checkpoints/${last.id}` ? { json: { ...last, projectId: 'wrong-project' } } : undefined);
  await f.reject('downloadpick', { ...f.bound, latest: true, items: [{ projectId: last.projectId }] }, 'CHECKPOINT_MISMATCH');
  assert.equal(f.pickCalls, 0); assert.deepEqual(await fs.readdir(f.parent), []);
});

test('TTL expiry during real latest HTTP resolution rejects before acknowledgement or any target creation', async t => {
  const f = await fixture(t), plan = await f.pick(), gate = f.gate(), starting = f.rpc('downloadstart', f.payload(plan));
  await gate.entered; f.advance(15 * 60_000); gate.release();
  const result = await starting; assert.equal(result.ok, false); assert.equal(result.error.code, 'DIRECTORY_PICKER_EXPIRED'); await f.controller.drain();
  assert.deepEqual(await fs.readdir(f.parent), []); assert.equal((await f.service.status()).download, undefined);
});

test('page abort cancels actual preaccept latest HTTP, consumes no request ID, and shared guards stay busy while resolving', async t => {
  const f = await fixture(t), plan = await f.pick(), input = f.payload(plan), gate = f.gate(), page = new AbortController();
  const starting = f.rpc('downloadstart', input, page.signal); await gate.entered;
  assert.equal((await f.service.status()).running, true);
  await f.reject('downloadstart', { ...input, requestId: randomUUID() }, 'BUSY');
  await f.reject('preferences', { revision: f.bound.revision, autoSync: false, projectIds: [] }, 'BUSY');
  await assert.rejects(f.controller.runUpdate(() => assert.fail('update during latest resolution')), { code: 'BUSY' });
  page.abort(); const result = await starting; assert.equal(result.ok, false); assert.equal(result.error.code, 'TIMEOUT');
  await gate.closed; await f.controller.drain(); assert.deepEqual(await fs.readdir(f.parent), []); assert.equal((await f.service.status()).download, undefined);
  gate.release(); f.setHook(undefined);
  await f.good('downloadstart', input); assert.equal((await f.settle()).state, 'succeeded');
});

test('slow latest lookup rechecks token, revision, parent identity, protected roots and picker provider before acceptance', async t => {
  for (const scenario of ['token', 'revision', 'parent', 'provider', 'occupied', 'protected']) await t.test(scenario, async t => {
    const f = await fixture(t), plan = await f.pick(), gate = f.gate(), starting = f.rpc('downloadstart', f.payload(plan)); await gate.entered;
    let expected;
    if (scenario === 'token') {
      const grant = f.records.get(f.controller.credentialKey); f.records.set(f.controller.credentialKey, { ...grant, payload: { ...grant.payload, token: 'z'.repeat(43) } }); expected = 'ACCOUNT_MISMATCH';
    } else if (scenario === 'revision') {
      const preferences = JSON.parse(await fs.readFile(f.service.filename, 'utf8')); await fs.writeFile(f.service.filename, JSON.stringify({ ...preferences, revision: preferences.revision + 1 })); expected = 'CONFIG_CONFLICT';
    } else if (scenario === 'parent') {
      const moved = path.join(f.root, 'moved-parent'); assert.equal(path.dirname(moved), f.root); assert.equal(f.parent, path.join(f.root, 'destinations'));
      await fs.rename(f.parent, moved); await fs.mkdir(f.parent); expected = 'DESTINATION_CHANGED';
    } else if (scenario === 'occupied') { await fs.mkdir(plan.destinations[0].root); expected = 'DESTINATION_EXISTS'; }
    else if (scenario === 'protected') { f.workspaces.set('new-registration', { id: 'new-registration', path: f.parent }); expected = 'PROTECTED_DESTINATION'; }
    else { f.replaceProvider(); expected = 'DIRECTORY_PICKER_EXPIRED'; }
    gate.release(); const result = await starting; assert.equal(result.ok, false); assert.equal(result.error.code, expected); await f.controller.drain();
    if (scenario === 'occupied') assert.deepEqual(await fs.readdir(plan.destinations[0].root), []); else assert.deepEqual(await fs.readdir(f.parent), []);
    assert.equal((await f.service.status()).download, undefined);
  });
});

test('logout and Host lifetime abort cancel unaccepted latest network calls and drain without files', async t => {
  for (const action of ['logout', 'stop']) await t.test(action, async t => {
    const f = await fixture(t), plan = await f.pick(), gate = f.gate(), starting = f.rpc('downloadstart', f.payload(plan)); await gate.entered;
    let loggingOut;
    if (action === 'logout') loggingOut = f.service.logout({}); else f.controller.stop();
    const result = await starting; assert.equal(result.ok, false); await gate.closed; await f.controller.drain();
    if (loggingOut) assert.equal((await loggingOut).loggedIn, false);
    assert.deepEqual(await fs.readdir(f.parent), []); gate.release();
  });
});

test('actual latest session eligibility replaces plan-time eligibility and digest tampering still prevents native import', async t => {
  const f = await fixture(t); await f.commit('project-0', 'with-session', { sessionIds: ['old-session'] });
  const plan = await f.pick(['project-0', 'project-1']);
  await f.commit('project-0', 'without-session'); const latest = await f.commit('project-1', 'new-session-point', { sessionIds: ['new-session'] });
  await f.good('downloadstart', f.payload(plan)); const result = await f.settle();
  assert.equal(result.items[0].canImport, false); assert.equal(result.items[0].sessionCount, 0); assert.equal(result.items[1].canImport, true);
  await f.reject('import', { ...f.bound, restoreId: result.items[0].restoreId, requestId: randomUUID(), confirm: true }, 'RECOVERY_UNAVAILABLE');
  const filename = path.join(result.items[1].root, '.dsh-sync', 'manifest.json');
  await fs.writeFile(filename, JSON.stringify({ ...latest, sourceRoot: '/remote/tampered-after-download' }));
  await f.good('import', { ...f.bound, restoreId: result.items[1].restoreId, requestId: randomUUID(), confirm: true });
  assert.equal((await f.settle()).items[1].importResult.errorCode, 'IMPORT_FAILED'); assert.equal(f.imports.length, 0);
});

test('postaccept latest integrity failure stays per item while HTTP permission failure stops remaining selections', async t => {
  for (const failure of ['integrity', 'permission']) await t.test(failure, async t => {
    const f = await fixture(t), latest = await f.commit('project-1', 'current-second'), plan = await f.pick(['project-0', 'project-1', 'project-2']);
    if (failure === 'integrity') await fs.writeFile(path.join(f.cloudDir, 'blobs', latest.files[0].sha256), Buffer.alloc(latest.files[0].size, 0x58));
    else f.setHook(entry => entry.url === `/v1/blobs/${latest.files[0].sha256}` ? { status: 403 } : undefined);
    await f.good('downloadstart', f.payload(plan)); const result = await f.settle(); assert.equal(result.latest, true); assert.equal(result.state, 'partial'); assert.equal(result.completed, 3);
    assert.equal(result.items[0].state, 'succeeded'); assert.equal(result.items[1].checkpointId, latest.id);
    if (failure === 'integrity') { assert.deepEqual(result.items.map(item => item.state), ['succeeded', 'failed', 'succeeded']); assert.equal(result.items[1].errorCode, 'RESTORE_FAILED'); }
    else { assert.deepEqual(result.items.map(item => item.state), ['succeeded', 'cancelled', 'cancelled']); assert.ok(result.items.slice(1).every(item => item.errorCode === 'ACCOUNT_MISMATCH')); await missing(result.items[2].root); }
  });
});
