import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { createController as createHost } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createController as createUi } from '../client/state.mjs';
import { SyncClient } from '../src/client.mjs';
import { sha256 } from '../src/protocol.mjs';

// Real Client state -> RPC -> Host -> loopback cloud. Picker and import SDK are
// synthetic: no real OS dialog, native installation, user data, or agent execution.
const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-selection-batch-password';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'download-selection-'));
  let host, server; const clients = [], releases = [];
  t.after(async () => {
    releases.forEach(release => release()); clients.forEach(client => client.dispose());
    host?.stop(); await host?.drain(); if (server) await closeSyncServer(server);
    assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('download-selection-'));
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true, force: true });
  });
  const dshHome = path.join(root, 'private'), profileDir = path.join(dshHome, 'profiles', 'test'), parent = path.join(root, 'downloads');
  await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(parent);
  const sources = [];
  for (const key of ['a', 'b', 'c']) {
    const directory = path.join(root, key, 'project'); await fs.mkdir(directory, { recursive: true });
    const bytes = Buffer.from(`synthetic project ${key}\0\u00ff`); await fs.writeFile(path.join(directory, 'data.bin'), bytes);
    sources.push({ id: `workspace-${key}`, key, directory, bytes });
  }
  server = await createSyncServer({ dataDir: path.join(root, 'cloud'), username: 'owner', password });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, grants = new Map(), calls = [], imports = [];
  let picks = 0;
  const picker = { capability: () => ({ kind: 'native', async pick(signal) { assert.ok(signal instanceof AbortSignal); picks++; return parent; } }) };
  const workspaces = new Map(sources.map(item => [item.id, { id: item.id, path: item.directory, title: `Project ${item.key}` }]));
  const ctx = { profileContext: { dir: profileDir, home: dshHome }, get: name => name === 'directoryPicker' ? picker : undefined,
    workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) },
    credentials: { readRecord: async key => grants.get(key), deleteRecord: async key => grants.delete(key),
      modifyRecord: async (key, callback) => { const record = await callback(grants.get(key)); if (record !== undefined) grants.set(key, record); } },
  };
  host = createHost(ctx, { stateDir: path.join(profileDir, 'sync') }, {
    credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
    exportSessions: async (_ctx, cwd) => { const source = sources.find(item => item.directory === cwd); return { sessions: [{ id: `session-${source.key}`, data: { synthetic: true, source: source.key } }], assets: [], skipped: [], verifyUnchanged: async () => {} }; },
    importSessions: async (_ctx, { manifest, root: restored }) => {
      const source = sources.find(item => item.directory === manifest.sourceRoot); assert.ok(source);
      assert.deepEqual(await fs.readFile(path.join(restored, 'data.bin')), source.bytes);
      imports.push({ projectId: manifest.projectId, root: restored });
      return { imported: [{ sourceId: `session-${source.key}`, sessionId: `new-session-${source.key}`, workspaceAttached: true }], skipped: [], failed: [] };
    },
  });
  const service = createSettingsService(ctx, host, { profileDir, dshHome }), bridge = createSettingsHttp(service);
  function mount() {
    const ui = createUi({ rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); const action = endpoint.slice('dsh-personal-sync/'.length);
      calls.push({ action, payload: structuredClone(payload) });
      const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId: `selected-${calls.length}`, method: endpoint, payload }),
      }));
      assert.equal(response.status, 200); return (await response.json()).result;
    } } }); clients.push(ui); return ui;
  }
  const ui = mount(); await ui.refresh(); assert.equal(await ui.login({ server: origin, username: 'owner', password }), true);
  for (const source of sources) ui.setProject(source.id, true);
  assert.equal(await ui.savePreferences(), true);
  for (const source of sources) { source.projectId = ui.getSnapshot().status.projects.find(item => item.id === source.id).projectId; await host.push(source.projectId); }
  await ui.refresh();
  return { root, parent, sources, host, service, ui, mount, calls, imports, grants, releases, picks: () => picks };
}
async function selectTwo(f, ui = f.ui) {
  const uploadDraft = [...ui.getSnapshot().draft.projectIds];
  const before = f.calls.length;
  assert.equal(await ui.browseProjects(), true);
  assert.equal(await ui.addDownloadProject(f.sources[0].projectId), true);
  assert.equal(await ui.addDownloadProject(f.sources[1].projectId), true);
  assert.equal(ui.getSnapshot().downloadSelection.length, 2);
  assert.ok(ui.getSnapshot().downloadSelection.every(item => !Object.hasOwn(item, 'checkpointId') && !Object.hasOwn(item, 'checkpoints')));
  assert.equal(f.calls.slice(before).some(item => item.action === 'checkpoints'), false, 'adding projects never asks the browser to choose snapshots');
  assert.deepEqual(ui.getSnapshot().draft.projectIds, uploadDraft);
  assert.ok(f.calls.slice(before).every(item => !['preferences', 'sync', 'restore', 'downloadstart', 'import'].includes(item.action)));
  assert.equal(await ui.chooseDownloadDestination(), true);
  const plan = ui.getSnapshot().downloadPlan;
  assert.equal(plan.latest, true); assert.equal(plan.parent, f.parent); assert.equal(plan.destinations.length, 2); assert.equal(f.picks(), 1);
  assert.ok(plan.destinations.every(item => !Object.hasOwn(item, 'checkpointId')));
  assert.equal(new Set(plan.destinations.map(item => item.root.toLowerCase())).size, 2, 'same folder names need distinct safe children');
  assert.deepEqual(await fs.readdir(f.parent), [], 'selection must not create download directories');
  return plan;
}

test('selected projects submit one Host batch; closing the page cannot drop remaining downloads', async t => {
  const f = await fixture(t); const plan = await selectTwo(f);
  const entered = deferred(), release = deferred(); f.releases.push(release.resolve);
  const original = SyncClient.prototype.downloadBlob; let blocked = false;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (...args) {
    const bytes = await original.apply(this, args);
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return bytes;
  });
  const intent = f.ui.prepareDownload(); assert.ok(intent);
  assert.equal(await f.ui.confirmDownload(intent), true);
  await Promise.race([entered.promise, f.host.drain().then(() => assert.fail('download finished before the expected blob gate'))]);
  assert.equal(await f.ui.confirmDownload(intent), false);
  f.ui.dispose(); release.resolve(); await f.host.drain();
  const ui = f.mount(); await ui.refresh();
  const download = ui.getSnapshot().status.download;
  assert.equal(download.state, 'succeeded'); assert.equal(download.completed, 2); assert.equal(download.total, 2);
  assert.deepEqual(new Set(download.items.map(item => item.projectId)), new Set(f.sources.slice(0, 2).map(item => item.projectId)));
  for (const item of download.items) {
    const source = f.sources.find(value => value.projectId === item.projectId);
    assert.deepEqual(await fs.readFile(path.join(item.root, 'data.bin')), source.bytes);
    assert.ok(plan.destinations.some(value => value.root === item.root));
  }
  assert.equal((await fs.readdir(f.parent)).length, 2);
  assert.equal(f.calls.filter(item => item.action === 'downloadstart').length, 1);
  assert.equal(f.calls.filter(item => item.action === 'restore').length, 0, 'no browser-managed per-project restore loop');
  const payload = f.calls.find(item => item.action === 'downloadstart').payload;
  assert.equal(payload.latest, true); assert.equal(payload.items.length, 2);
  assert.ok(payload.items.every(item => Object.hasOwn(item, 'destinationId') && !Object.hasOwn(item, 'checkpointId') && !Object.hasOwn(item, 'root') && !Object.hasOwn(item, 'destination')));
  assert.equal(f.imports.length, 0); assert.equal(ui.getSnapshot().status.autoSync, false);
});

test('batch success permits each selected project to import only by separate explicit confirmation', async t => {
  const f = await fixture(t); await selectTwo(f);
  assert.equal(await f.ui.confirmDownload(f.ui.prepareDownload()), true);
  await f.host.drain(); await f.ui.refresh();
  for (const original of f.ui.getSnapshot().status.download.items) {
    assert.equal(original.canImport, true);
    const intent = f.ui.prepareDownloadImport(original.restoreId); assert.ok(intent);
    const before = f.imports.length;
    assert.equal(await f.ui.confirmDownloadImport(intent), true);
    await f.host.drain(); await f.ui.refresh();
    assert.equal(f.imports.length, before + 1);
    const item = f.ui.getSnapshot().status.download.items.find(value => value.restoreId === original.restoreId);
    assert.equal(item.canImport, false); assert.equal(item.importResult.state, 'succeeded'); assert.equal(item.importResult.importedCount, 1);
    assert.equal(await f.ui.confirmDownloadImport(intent), false);
  }
  assert.equal(new Set(f.imports.map(item => item.root)).size, 2);
  for (const record of f.grants.values()) assert.ok(!JSON.stringify(f.ui.getSnapshot()).includes(record.payload.token));
});

test('one independent batch failure is reported without suppressing other selected project downloads', async t => {
  const f = await fixture(t); await selectTwo(f);
  const badHash = sha256(f.sources[0].bytes), original = SyncClient.prototype.downloadBlob;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (hash, ...args) {
    if (hash === badHash) throw new Error('SYNTHETIC-PRIVATE-FAILURE');
    return original.call(this, hash, ...args);
  });
  assert.equal(await f.ui.confirmDownload(f.ui.prepareDownload()), true);
  await f.host.drain(); await f.ui.refresh();
  const download = f.ui.getSnapshot().status.download;
  assert.equal(download.state, 'partial'); assert.equal(download.completed, 2);
  const failed = download.items.find(item => item.projectId === f.sources[0].projectId);
  const succeeded = download.items.find(item => item.projectId === f.sources[1].projectId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.canImport, false);
  assert.ok(await fs.stat(path.join(failed.root, '.dsh-sync', 'INCOMPLETE')));
  assert.equal(succeeded.state, 'succeeded'); assert.deepEqual(await fs.readFile(path.join(succeeded.root, 'data.bin')), f.sources[1].bytes);
  assert.ok(!JSON.stringify(download).includes('SYNTHETIC-PRIVATE-FAILURE'));
  assert.equal(f.imports.length, 0);
});

async function commitCloudContent(client, projectId, value, { createdAt, parentId = null, sourceRoot } = {}) {
  const catalog = await client.list(projectId);
  const previous = await client.getCheckpoint(catalog.checkpoints.at(-1).id);
  const bytes = Buffer.from(value), hash = sha256(bytes);
  await client.uploadBlob(hash, bytes);
  const manifest = { ...previous, id: randomUUID(), parentId, createdAt: createdAt ?? new Date().toISOString(),
    ...(sourceRoot ? { sourceRoot } : {}),
    files: previous.files.map(file => file.path === 'project/data.bin' ? { ...file, sha256: hash, size: bytes.length } : file),
  };
  await client.commit(manifest);
  return { manifest, bytes };
}
async function selectOneLatest(f) {
  await f.ui.browseProjects();
  assert.equal(await f.ui.addDownloadProject(f.sources[0].projectId), true);
  assert.equal(await f.ui.chooseDownloadDestination(), true);
  const plan = f.ui.getSnapshot().downloadPlan;
  assert.equal(plan.latest, true); assert.equal(plan.destinations.length, 1);
  return plan;
}

test('latest GUI downloads the last cloud commit made after picking, regardless of clock skew or branches', async t => {
  const f = await fixture(t), plan = await selectOneLatest(f);
  const client = new SyncClient([...f.grants.values()][0].payload), projectId = f.sources[0].projectId;
  const original = (await client.list(projectId)).checkpoints.at(-1).id;
  const future = await commitCloudContent(client, projectId, 'older commit with a future device clock', { createdAt: '2099-01-01T00:00:00.000Z' });
  const last = await commitCloudContent(client, projectId, 'actual last successfully committed cloud data', { createdAt: '2001-01-01T00:00:00.000Z', sourceRoot: path.join(f.root, 'renamed-source') });
  assert.equal((await client.list(projectId)).heads.length, 3);
  const intent = f.ui.prepareDownload(); assert.ok(intent);
  assert.ok(intent.items.every(item => !Object.hasOwn(item, 'checkpointId')));
  assert.equal(await f.ui.confirmDownload(intent), true);
  await f.host.drain(); await f.ui.refresh();
  const download = f.ui.getSnapshot().status.download, item = download.items[0];
  assert.equal(download.latest, true); assert.equal(download.state, 'succeeded');
  assert.equal(item.checkpointId, last.manifest.id);
  assert.equal(item.root, plan.destinations[0].root, 'latest source rename must never move the user-confirmed target');
  assert.deepEqual(await fs.readFile(path.join(item.root, 'data.bin')), last.bytes);
  assert.deepEqual(new Set((await client.list(projectId)).heads), new Set([original, future.manifest.id, last.manifest.id]), 'other cloud branches/history remain intact');
  assert.equal(f.calls.some(call => call.action === 'checkpoints'), false);
  assert.equal(f.imports.length, 0);
});

test('latest batch pins its admission read; later commits and duplicate requests cannot change accepted bytes', async t => {
  const f = await fixture(t), plan = await selectOneLatest(f);
  const client = new SyncClient([...f.grants.values()][0].payload), projectId = f.sources[0].projectId;
  const chosen = await commitCloudContent(client, projectId, 'pinned-at-admission');
  const entered = deferred(), release = deferred(); f.releases.push(release.resolve);
  const downloadBlob = SyncClient.prototype.downloadBlob; let blocked = false;
  t.mock.method(SyncClient.prototype, 'downloadBlob', async function (hash, ...args) {
    const bytes = await downloadBlob.call(this, hash, ...args);
    if (!blocked && hash === sha256(chosen.bytes)) { blocked = true; entered.resolve(); await release.promise; }
    return bytes;
  });
  assert.equal(await f.ui.confirmDownload(f.ui.prepareDownload()), true);
  await Promise.race([entered.promise, f.host.drain().then(() => assert.fail('expected chosen content to reach the in-flight gate'))]);
  const newer = await commitCloudContent(client, projectId, 'arrived-after-admission', { parentId: chosen.manifest.id });
  release.resolve(); await f.host.drain(); await f.ui.refresh();
  const first = f.ui.getSnapshot().status.download;
  assert.equal(first.items[0].checkpointId, chosen.manifest.id);
  assert.deepEqual(await fs.readFile(path.join(plan.destinations[0].root, 'data.bin')), chosen.bytes);
  const payload = f.calls.findLast(call => call.action === 'downloadstart').payload;
  const request = SyncClient.prototype.request; let cloudReads = 0;
  t.mock.method(SyncClient.prototype, 'request', function (...args) { cloudReads++; return request.apply(this, args); });
  assert.deepEqual((await f.service.downloadstart(payload)).download, first);
  assert.equal(cloudReads, 0, 'idempotent replay must not resolve a different latest commit');
  assert.equal(await f.ui.chooseDownloadDestination(), true);
  const secondPlan = f.ui.getSnapshot().downloadPlan;
  assert.notEqual(secondPlan.destinations[0].root, plan.destinations[0].root);
  assert.equal(await f.ui.confirmDownload(f.ui.prepareDownload()), true);
  await f.host.drain(); await f.ui.refresh();
  assert.equal(f.ui.getSnapshot().status.download.items[0].checkpointId, newer.manifest.id);
  assert.deepEqual(await fs.readFile(path.join(secondPlan.destinations[0].root, 'data.bin')), newer.bytes);
  assert.deepEqual(await fs.readFile(path.join(plan.destinations[0].root, 'data.bin')), chosen.bytes, 'a new latest download must not overwrite the previous copy');
});
