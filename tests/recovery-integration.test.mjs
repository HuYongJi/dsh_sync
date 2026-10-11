import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { LocalStore } from '../src/local-store.mjs';
import { createController as createHost } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createController as createUi } from '../client/state.mjs';

// Production Client -> native envelope -> production Host -> real HTTP/disk.
// Credentials/registry and session import are isolated mocks, NOT a live DSH GUI.
const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'synthetic-recovery-integration-password';
async function fixture(t, partial = false) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'recovery-chain-'));
  let server, host, ui;
  t.after(async () => {
    ui?.dispose(); host?.stop(); await host?.drain();
    if (server) await closeSyncServer(server);
    assert.equal(path.dirname(root), path.resolve(base));
    assert.ok(path.basename(root).startsWith('recovery-chain-'));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'), dshHome = path.join(root, 'host-private'), profileDir = path.join(dshHome, 'profiles', 'test');
  await fs.mkdir(source); await fs.mkdir(profileDir, { recursive: true });
  const bytes = Buffer.from([0, 1, 128, 255]);
  await fs.writeFile(path.join(source, 'synthetic.bin'), bytes);
  server = await createSyncServer({ dataDir: path.join(root, 'cloud'), username: 'owner', password });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const uploader = new SyncClient({ server: origin });
  await uploader.login({ username: 'owner', password, deviceId: 'source-device' });
  const store = await new LocalStore(path.join(root, 'source-state')).init();
  const captured = await store.capture({ root: source, projectId: 'synthetic-project', deviceId: 'source-device',
    sessions: [{ id: 'archive-one', data: { fixture: 'synthetic archive for mocked import only' } }] });
  await store.flush(uploader);
  const records = new Map();
  let imports = 0;
  host = createHost({
    credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, callback) => { const value = await callback(records.get(key)); if (value !== undefined) records.set(key, value); },
      deleteRecord: async key => records.delete(key),
    },
    workspaceRegistry: { list: () => [], get: () => undefined },
  }, { stateDir: path.join(profileDir, 'dsh-personal-sync') }, {
    credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false,
    importSessions: async (_ctx, { manifest, root: destination }) => {
      ++imports;
      assert.equal(manifest.id, captured.manifest.id);
      assert.deepEqual(await fs.readFile(path.join(destination, 'synthetic.bin')), bytes);
      return partial
        ? { imported: [], skipped: [], failed: [{ id: 'archive-one', sessionId: 'partly-durable-session', mayHaveDurableSession: true, reason: 'synthetic-private-exception' }] }
        : { imported: [{ sourceId: 'archive-one', sessionId: 'new-session-one', workspaceAttached: true }], skipped: [], failed: [] };
    },
  });
  const ctx = { workspaceRegistry: { list: () => [], get: () => undefined } };
  const service = createSettingsService(ctx, host, { profileDir, dshHome });
  const bridge = createSettingsHttp(service);
  const actions = [];
  ui = createUi({ rpc: { call: async (channel, endpoint, payload, signal) => {
    assert.equal(channel, '/api');
    assert.ok(endpoint.startsWith('dsh-personal-sync/'));
    const action = endpoint.slice('dsh-personal-sync/'.length);
    actions.push({ action, payload: structuredClone(payload) });
    const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${actions.length}`, method: endpoint, payload }),
    }));
    assert.equal(response.status, 200);
    return (await response.json()).result;
  } } });
  assert.equal(await ui.refresh(), true);
  assert.equal(await ui.login({ server: origin, username: 'owner', password }), true);
  return { root, bytes, captured, host, ui, service, actions, records, imports: () => imports };
}
async function download(f) {
  assert.equal(await f.ui.browseProjects(), true);
  assert.deepEqual(f.ui.getSnapshot().cloud.projects.map(item => item.projectId), ['synthetic-project']);
  f.ui.setCloudProject('synthetic-project');
  assert.equal(await f.ui.loadCheckpoints(), true);
  const id = f.captured.manifest.id;
  assert.equal(f.ui.getSnapshot().cloud.checkpointId, '');
  f.ui.selectCheckpoint(id);
  const destination = path.join(f.root, 'downloaded');
  f.ui.setDestination(destination);
  const intent = f.ui.prepareRestore();
  assert.ok(intent);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.equal(f.imports(), 0);
  assert.equal(await f.ui.confirmRecovery(intent), true);
  await f.host.drain();
  assert.equal(await f.ui.refresh(), true);
  const recovery = f.ui.getSnapshot().status.recovery;
  assert.equal(recovery.kind, 'restore'); assert.equal(recovery.state, 'succeeded');
  assert.equal(recovery.root, destination); assert.equal(recovery.sessionCount, 1);
  assert.deepEqual(await fs.readFile(path.join(destination, 'synthetic.bin')), f.bytes);
  assert.equal(f.imports(), 0, 'successful download must not import sessions automatically');
  assert.equal(f.ui.getSnapshot().status.autoSync, false);
  assert.equal(f.actions.some(item => item.action === 'sync' || item.action === 'preferences'), false);
  return recovery;
}

test('download UI state uses native RPC to browse, restore verified bytes, then explicitly import', async t => {
  const f = await fixture(t);
  const restored = await download(f);
  const intent = f.ui.prepareImport(); assert.ok(intent);
  assert.equal(f.imports(), 0);
  assert.equal(await f.ui.confirmRecovery(intent), true);
  await f.host.drain(); await f.ui.refresh();
  const recovery = f.ui.getSnapshot().status.recovery;
  assert.equal(recovery.kind, 'import'); assert.equal(recovery.state, 'succeeded');
  assert.equal(recovery.importedCount, 1); assert.equal(f.imports(), 1);
  assert.deepEqual(recovery.sessions, [{ sourceId: 'archive-one', sessionId: 'new-session-one', outcome: 'imported', workspaceAttached: true }]);
  assert.equal(await f.ui.confirmRecovery(intent), false, 'one intent cannot be replayed');
  assert.equal(f.imports(), 1);
  const request = f.actions.find(item => item.action === 'import').payload;
  assert.equal(request.restoreId, restored.id); assert.equal(request.confirm, true);
  assert.equal(request.username, 'owner'); assert.ok(Number.isSafeInteger(request.revision));
  const publicState = JSON.stringify(f.ui.getSnapshot());
  assert.ok(!publicState.includes(password));
  for (const record of f.records.values()) assert.ok(!publicState.includes(record.payload.token));
});

test('stale GUI confirmation is rejected by Host revision before any destination is created', async t => {
  const f = await fixture(t);
  await f.ui.browseProjects(); f.ui.setCloudProject('synthetic-project'); await f.ui.loadCheckpoints();
  f.ui.selectCheckpoint(f.captured.manifest.id);
  const destination = path.join(f.root, 'stale-intent-target'); f.ui.setDestination(destination);
  const intent = f.ui.prepareRestore(); assert.ok(intent);
  const before = await f.service.status();
  await f.service.savePreferences({ revision: before.revision, autoSync: false, projectIds: [] });
  assert.equal(await f.ui.confirmRecovery(intent), false);
  await f.host.drain();
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.equal(f.ui.getSnapshot().status.revision, before.revision + 1);
  assert.equal(f.ui.getSnapshot().cloud.checkpointId, '');
  assert.equal(f.imports(), 0);
  assert.equal(f.actions.filter(item => item.action === 'restore').length, 1);
});

test('recovery chain preserves partial-import durable IDs without exposing exception text', async t => {
  const f = await fixture(t, true); await download(f);
  const intent = f.ui.prepareImport(); assert.ok(intent);
  assert.equal(await f.ui.confirmRecovery(intent), true);
  await f.host.drain(); await f.ui.refresh();
  const recovery = f.ui.getSnapshot().status.recovery;
  assert.equal(recovery.state, 'failed'); assert.equal(recovery.failedCount, 1);
  assert.equal(recovery.errorCode, 'IMPORT_FAILED');
  assert.deepEqual(recovery.sessions, [{ sourceId: 'archive-one', sessionId: 'partly-durable-session', outcome: 'failed' }]);
  assert.ok(!JSON.stringify(f.ui.getSnapshot()).includes('synthetic-private-exception'));
  assert.equal(f.ui.prepareImport(), null, 'partial import cannot blindly recreate another set of sessions');
});
