import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController as createHost } from '../plugin/controller.mjs';
import { createSettingsService, credentialKeyForProfile } from '../plugin/settings-service.mjs';
import { createSettingsHttp, SETTINGS_API } from '../plugin/settings-http.mjs';
import { createUpdateService, withUpdateStatus } from '../plugin/update-service.mjs';
import { createController as createUi } from '../client/state.mjs';

// Real production UI state -> RPC envelope -> update service/controller.
// GitHub and the native installer are deliberately mocked: NO real installations.
const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const sha = 'a'.repeat(40);
const repository = 'https://github.com/HuYongJi/dsh_sync';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, fail = false) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'update-chain-'));
  const dshHome = path.join(root, 'private'), profileDir = path.join(dshHome, 'profiles', 'test');
  await fs.mkdir(profileDir, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const latest = { ...manifest, version: '0.6.0' };
  let installedVersion = '0.5.0';
  const entered = deferred(), released = deferred();
  const installs = [], fetches = [], actions = [];
  const manager = {
    async listBundles() { return [{ name: 'dsh-personal-sync', version: installedVersion, enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }]; },
    async installBundle(spec, options) {
      installs.push({ spec, options }); entered.resolve(); await released.promise;
      if (fail) return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error', diagnostic: 'NEVER-EXPOSE-NATIVE-SECRET' }, packageResult: { exitCode: 1, kind: 'build-blocked', output: 'NEVER-EXPOSE-NATIVE-SECRET', logPath: 'NEVER-EXPOSE-NATIVE-SECRET' } };
      installedVersion = '0.6.0';
      return { changed: true, application: 'restart-required', stage: 'enable', target: 'dsh-personal-sync', bundle: 'dsh-personal-sync', packageResult: { exitCode: 0, output: 'NEVER-EXPOSE-NATIVE-SECRET', logPath: 'NEVER-EXPOSE-NATIVE-SECRET' } };
    },
    async cancelInstall() { released.resolve(); return { status: 'too-late' }; },
  };
  const ctx = { get: name => name === 'pluginManager' ? manager : undefined,
    profileContext: { dir: profileDir, home: dshHome },
    workspaceRegistry: { list: () => [], get: () => undefined },
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => { throw new Error('No credential writes for updating'); } },
  };
  const host = createHost(ctx, { stateDir: path.join(profileDir, 'sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false });
  const settings = createSettingsService(ctx, host, { profileDir, dshHome });
  const updates = createUpdateService(ctx, host, { currentVersion: '0.5.0', fetch: async (url, options) => {
    fetches.push({ url, options });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const headers = new Headers(options.headers);
    assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false);
    assert.equal(options.body, undefined);
    if (url === 'https://api.github.com/repos/HuYongJi/dsh_sync/commits?per_page=1') return Response.json([{ sha }]);
    assert.equal(url, `https://raw.githubusercontent.com/HuYongJi/dsh_sync/${sha}/package.json`);
    return Response.json(latest);
  } });
  const service = withUpdateStatus(settings, updates), bridge = createSettingsHttp(service);
  const ui = createUi({ rpc: { call: async (channel, endpoint, payload, signal) => {
    assert.equal(channel, '/api'); const action = endpoint.slice('dsh-personal-sync/'.length);
    actions.push({ action, payload: structuredClone(payload) });
    const response = await bridge.fetch(action, new Request(`http://dsh.internal${SETTINGS_API}${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: `update-${actions.length}`, method: endpoint, payload }),
    }));
    assert.equal(response.status, 200); return (await response.json()).result;
  } } });
  t.after(async () => {
    released.resolve(); ui.dispose(); bridge.dispose();
    await updates.dispose(); host.stop(); await Promise.all([updates.drain(), host.drain()]);
    assert.equal(path.dirname(root), path.resolve(base)); assert.ok(path.basename(root).startsWith('update-chain-'));
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true, force: true });
  });
  return { ui, host, settings, updates, installs, fetches, actions, entered, released };
}

test('logged-out settings can explicitly check then submit one immutable native update without secrets', async t => {
  const f = await fixture(t);
  assert.equal(await f.ui.refresh(), true);
  assert.equal(f.ui.getSnapshot().status.loggedIn, false);
  assert.equal(f.fetches.length, 0, 'opening settings must not contact GitHub');
  assert.equal(await f.ui.checkUpdate(), true);
  assert.equal(f.fetches.length, 2);
  const intent = f.ui.prepareUpdate(); assert.ok(intent);
  assert.equal(intent.version, '0.6.0'); assert.equal(intent.commit, sha);
  assert.equal(f.installs.length, 0, 'metadata check/confirmation preparation must not install');
  const accepted = f.ui.confirmUpdate(intent); await f.entered.promise;
  assert.equal(await accepted, true);
  assert.equal(f.installs.length, 1);
  assert.equal(f.installs[0].spec, `${repository}#${sha}`);
  assert.deepEqual(f.installs[0].options, { requestId: intent.requestId, enabled: true });
  assert.equal(await f.ui.confirmUpdate(intent), false);
  assert.equal(f.ui.prepareRestore, undefined);
  assert.equal(f.actions.some(item => ['sync', 'restore', 'import', 'login'].includes(item.action)), false);
  f.released.resolve(); await f.updates.drain(); await f.ui.refreshUpdate();
  const update = f.ui.getSnapshot().update;
  assert.equal(update.currentVersion, '0.5.0'); assert.equal(update.installedVersion, '0.6.0');
  assert.equal(update.state, 'restart-required'); assert.equal(update.restartRequired, true);
  assert.equal(f.ui.prepareUpdate(), null);
  assert.equal(f.installs.length, 1); assert.equal(f.fetches.length, 2, 'polling is local only');
  assert.ok(!JSON.stringify(f.ui.getSnapshot()).includes('NEVER-EXPOSE'));
  await assert.rejects(f.settings.savePreferences({ revision: f.ui.getSnapshot().status.revision, autoSync: false, projectIds: [] }), { code: 'UPDATE_RESTART_REQUIRED' });
});

test('native build approval refusal stays explicit and restart-gated instead of silently approving or retrying', async t => {
  const f = await fixture(t, true);
  await f.ui.refresh(); await f.ui.checkUpdate();
  const intent = f.ui.prepareUpdate(); assert.ok(intent);
  const accepted = f.ui.confirmUpdate(intent); await f.entered.promise; await accepted;
  f.released.resolve(); await f.updates.drain(); await f.ui.refreshUpdate();
  const update = f.ui.getSnapshot().update;
  assert.equal(update.state, 'failed'); assert.equal(update.errorCode, 'UPDATE_BUILD_APPROVAL_REQUIRED');
  assert.equal(update.restartRequired, true); assert.equal(update.currentVersion, '0.5.0');
  assert.equal(f.installs.length, 1); assert.equal(Object.hasOwn(f.installs[0].options, 'approvedBuilds'), false);
  assert.ok(!JSON.stringify(f.ui.getSnapshot()).includes('NEVER-EXPOSE'));
  assert.equal(f.ui.prepareUpdate(), null);
});
