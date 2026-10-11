import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { LocalStore } from '../src/local-store.mjs';
import { runCli } from '../src/cli.mjs';
const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const password = 'fixture-only-password-123456789';
async function setup(t) {
  await fs.mkdir(base, { recursive: true });
  const temp = await fs.mkdtemp(path.join(base, 'integration-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) await closeSyncServer(server);
    assert.equal(path.dirname(temp), path.resolve(base)); assert.ok(path.basename(temp).startsWith('integration-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  async function start() {
    const server = await createSyncServer({ dataDir: path.join(temp, 'server'), username: 'owner', password });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  }
  return { temp, start };
}
test('real HTTP two-device sync restores files/sessions/assets and preserves concurrent branches across restart', async t => {
  const { temp, start } = await setup(t);
  let host = await start();
  const a = new SyncClient({ server: host.url }), b = new SyncClient({ server: host.url });
  await a.login({ username: 'owner', password, deviceId: 'device-a' });
  await b.login({ username: 'owner', password, deviceId: 'device-b' });
  const rootA = path.join(temp, 'project-a'), rootB = path.join(temp, 'project-b');
  await fs.mkdir(rootA); await fs.writeFile(path.join(rootA, 'artifact.bin'), Buffer.from([0, 128, 255]));
  const storeA = await new LocalStore(path.join(temp, 'state-a')).init(), storeB = await new LocalStore(path.join(temp, 'state-b')).init();
  const session = { id: 'session-fixture', data: { format: 4, messages: ['Synthetic, not a real user session'] } };
  const first = await storeA.capture({ root: rootA, projectId: 'demo', deviceId: 'device-a', sessions: [session], assets: [Buffer.from('synthetic attachment')] });
  assert.equal((await storeA.flush(a))[0].conflict, false);
  await storeB.restore(b, first.manifest.id, rootB);
  assert.deepEqual(await fs.readFile(path.join(rootB, 'artifact.bin')), Buffer.from([0, 128, 255]));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(rootB, '.dsh-sync', 'sessions', 'session-fixture.json'))), session.data);
  await fs.writeFile(path.join(rootA, 'artifact.bin'), 'A edit'); await fs.writeFile(path.join(rootB, 'artifact.bin'), 'B edit');
  const branchA = await storeA.capture({ root: rootA, projectId: 'demo', deviceId: 'device-a' });
  const branchB = await storeB.capture({ root: rootB, projectId: 'demo', deviceId: 'device-b' });
  assert.equal(branchA.manifest.parentId, first.manifest.id); assert.equal(branchB.manifest.parentId, first.manifest.id);
  assert.equal((await storeA.flush(a))[0].conflict, false);
  const conflict = (await storeB.flush(b))[0]; assert.equal(conflict.conflict, true);
  assert.deepEqual(new Set(conflict.heads), new Set([branchA.manifest.id, branchB.manifest.id]));
  assert.equal((await b.commit(branchB.manifest)).id, branchB.manifest.id);
  const token = a.token;
  await closeSyncServer(host.server); host = await start();
  const resumed = new SyncClient({ server: host.url, token });
  const catalog = await resumed.list('demo'); assert.equal(catalog.checkpoints.length, 3); assert.equal(catalog.heads.length, 2);
  await resumed.logout(); await assert.rejects(resumed.list('demo'), /Login required/);
  await assert.rejects(new SyncClient({ server: host.url, token }).list('demo'), { status: 401 });
});
test('CLI local fixture login/push/list/restore/status/logout never prints credentials', async t => {
  const { temp, start } = await setup(t), host = await start();
  const root = path.join(temp, 'root'), state = path.join(temp, 'cli-state'), dest = path.join(temp, 'restored');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'hello.txt'), 'hello');
  const outputs = [], output = value => outputs.push(value), env = { SYNC_PASSWORD: password };
  const run = args => runCli([...args, '--state', state], { env, output });
  await run(['login', '--server', host.url, '--username', 'owner']);
  await run(['push', '--project', 'demo', '--root', root]);
  const id = outputs.at(-1).checkpointId;
  await run(['list', '--project', 'demo']); assert.equal(outputs.at(-1).checkpoints[0].id, id);
  await run(['restore', '--id', id, '--to', dest]); assert.equal(await fs.readFile(path.join(dest, 'hello.txt'), 'utf8'), 'hello');
  await run(['status']); assert.equal(outputs.at(-1).loggedIn, true);
  const config = JSON.parse(await fs.readFile(path.join(state, 'config.json')));
  assert.ok(!JSON.stringify(outputs).includes(config.token)); assert.ok(!JSON.stringify(outputs).includes(password));
  await run(['logout']); await run(['status']); assert.equal(outputs.at(-1).loggedIn, false);
});
