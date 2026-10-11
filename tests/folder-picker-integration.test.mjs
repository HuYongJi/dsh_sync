import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { createController as createHost } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createController as createUi } from '../client/state.mjs';
import { SyncClient } from '../src/client.mjs';

// Production UI/RPC/Host/HTTP data flow; native folder capabilities are synthetic.
// No actual OS chooser, real DSH profile or remote user data is used.
const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-folder-flow-password';
async function fixture(t, mode = 'native') {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'folder-flow-'));
  let host, ui, cloud;
  t.after(async () => {
    ui?.dispose(); host?.stop(); await host?.drain();
    if (cloud) await closeSyncServer(cloud);
    assert.equal(path.dirname(root), path.resolve(base));
    assert.ok(path.basename(root).startsWith('folder-flow-'));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, '测试项目'), downloads = path.join(root, 'downloads');
  const dshHome = path.join(root, 'private'), profileDir = path.join(dshHome, 'profiles', 'synthetic');
  await fs.mkdir(source); await fs.mkdir(downloads); await fs.mkdir(profileDir, { recursive: true });
  const bytes = Buffer.from([0, 127, 128, 255]); await fs.writeFile(path.join(source, 'data.bin'), bytes);
  cloud = await createSyncServer({ dataDir: path.join(root, 'cloud'), username: 'owner', password });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${cloud.address().port}`, grants = new Map(), calls = [], pickerCalls = [];
  let selectedParent = downloads;
  const capability = mode === 'native' ? {
    kind: 'native', async pick(signal) { pickerCalls.push({ verb: 'pick', signal }); return selectedParent; },
  } : {
    kind: 'browse', async list(directory, signal) {
      pickerCalls.push({ verb: 'list', directory, signal });
      const current = directory ?? root;
      assert.ok([root, downloads].includes(current));
      return { path: current, home: root, crumbs: [{ name: '本机目录', path: root, hidden: false }, ...(current === downloads ? [{ name: 'downloads', path: downloads, hidden: false }] : [])],
        entries: current === root ? [{ name: 'downloads', path: downloads, hidden: false }] : [], truncated: false };
    },
  };
  const workspaces = new Map([['source-workspace', { id: 'source-workspace', path: source, title: '测试项目' }]]);
  const picker = { capability: () => capability };
  const ctx = { get: name => name === 'directoryPicker' ? picker : undefined,
    profileContext: { dir: profileDir, home: dshHome },
    workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) },
    credentials: { readRecord: async key => grants.get(key), deleteRecord: async key => grants.delete(key),
      modifyRecord: async (key, fn) => { const next = await fn(grants.get(key)); if (next !== undefined) grants.set(key, next); } },
  };
  host = createHost(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
    exportSessions: async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => {} }),
    importSessions: async () => assert.fail('folder selection/download must not import automatically'),
  });
  const service = createSettingsService(ctx, host, { profileDir, dshHome }), bridge = createSettingsHttp(service);
  ui = createUi({ rpc: { async call(channel, endpoint, payload, signal) {
    assert.equal(channel, '/api');
    const action = endpoint.slice('dsh-personal-sync/'.length); calls.push({ action, payload: structuredClone(payload) });
    const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: `folder-${calls.length}`, method: endpoint, payload }),
    }));
    assert.equal(response.status, 200); return (await response.json()).result;
  } } });
  assert.equal(await ui.refresh(), true);
  assert.equal(await ui.login({ server: origin, username: 'owner', password }), true);
  ui.setProject('source-workspace', true); assert.equal(await ui.savePreferences(), true);
  const projectId = ui.getSnapshot().status.projects[0].projectId;
  await host.push(projectId); await ui.refresh();
  return { root, source, downloads, bytes, host, ui, calls, grants, pickerCalls, projectId, selectParent(value) { selectedParent = value; } };
}
async function selectCloud(f) {
  assert.equal(await f.ui.browseProjects(), true);
  const project = f.ui.getSnapshot().cloud.projects.find(item => item.projectId === f.projectId);
  assert.equal(project.label, '测试项目'); assert.equal(project.sourceRoot, f.source);
  assert.equal(f.ui.setCloudProject(project.projectId), true);
  assert.equal(await f.ui.loadCheckpoints(), true);
  assert.equal(f.ui.getSnapshot().cloud.checkpointId, '');
  assert.equal(f.ui.selectCheckpoint(f.ui.getSnapshot().cloud.checkpoints[0].id), true);
}
async function restorePicked(f) {
  const cloud = f.ui.getSnapshot().cloud;
  assert.ok(cloud.destinationId); assert.equal(path.dirname(cloud.destination), f.downloads);
  await assert.rejects(fs.stat(cloud.destination), { code: 'ENOENT' });
  const before = f.calls.filter(item => item.action === 'restore').length;
  const intent = f.ui.prepareRestore(); assert.ok(intent);
  assert.equal(f.calls.filter(item => item.action === 'restore').length, before);
  assert.equal(await f.ui.confirmRecovery(intent), true);
  await f.host.drain(); await f.ui.refresh();
  assert.equal(f.ui.getSnapshot().status.recovery.state, 'succeeded');
  assert.deepEqual(await fs.readFile(path.join(cloud.destination, 'data.bin')), f.bytes);
  const payload = f.calls.findLast(item => item.action === 'restore').payload;
  assert.equal(payload.destinationId, cloud.destinationId); assert.equal(Object.hasOwn(payload, 'destination'), false);
  assert.equal(f.calls.some(item => item.action === 'import'), false);
  assert.equal(f.ui.getSnapshot().status.autoSync, false);
  for (const record of f.grants.values()) assert.ok(!JSON.stringify(f.ui.getSnapshot()).includes(record.payload.token));
}

test('named cloud project -> native Host parent choice -> opaque plan -> explicit verified download', async t => {
  const f = await fixture(t); await selectCloud(f);
  assert.equal(await f.ui.chooseDestination(), true);
  assert.equal(f.pickerCalls.length, 1); assert.ok(f.pickerCalls[0].signal instanceof AbortSignal);
  const previous = { id: f.ui.getSnapshot().cloud.destinationId, root: f.ui.getSnapshot().cloud.destination };
  f.selectParent(null); await f.ui.chooseDestination();
  assert.equal(f.ui.getSnapshot().cloud.destinationId, previous.id);
  assert.equal(f.ui.getSnapshot().cloud.destination, previous.root);
  await restorePicked(f);
});

test('Host directory browsing navigates issued IDs only and creates nothing before confirmed restore', async t => {
  const f = await fixture(t, 'browse'); await selectCloud(f);
  assert.equal(await f.ui.chooseDestination(), true);
  const browser = f.ui.getSnapshot().cloud.directoryBrowser;
  assert.equal(browser.path, f.root);
  const folder = browser.directories.find(item => item.label === 'downloads'); assert.ok(folder);
  assert.equal(await f.ui.browseDestination(folder.id), true);
  const inside = f.ui.getSnapshot().cloud.directoryBrowser; assert.equal(inside.path, f.downloads);
  assert.equal(await f.ui.selectDestination(inside.currentId), true);
  assert.equal(f.ui.getSnapshot().cloud.directoryBrowser, null);
  for (const call of f.calls.filter(item => ['destinationbrowse', 'destinationselect'].includes(item.action))) {
    assert.ok(call.payload.browserId); assert.ok(call.payload.nodeId);
    assert.equal(Object.hasOwn(call.payload, 'path'), false); assert.equal(Object.hasOwn(call.payload, 'root'), false);
  }
  assert.deepEqual(await fs.readdir(f.downloads), []);
  await restorePicked(f);
});

test('older cloud without project discovery still offers known bound folders without manual IDs', async t => {
  const f = await fixture(t);
  t.mock.method(SyncClient.prototype, 'projects', async () => { throw Object.assign(new Error('legacy route missing'), { code: 'CLOUD_BROWSE_UNSUPPORTED' }); });
  await selectCloud(f);
  assert.equal(await f.ui.chooseDestination(), true);
  await restorePicked(f);
});
