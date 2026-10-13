import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, parseArgs } from '../src/cli.mjs';
import { LocalStore } from '../src/local-store.mjs';

const base = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
const retired = ['preview', 'push', 'retry', 'list', 'restore'];
test('every retired CLI command rejects before state, credentials, or network access', async t => {
  let stores = 0, network = 0, secrets = 0;
  t.mock.method(LocalStore.prototype, 'exclusive', async () => { stores++; assert.fail('No state access'); });
  t.mock.method(globalThis, 'fetch', async () => { network++; assert.fail('No network access'); });
  const env = { get SYNC_PASSWORD() { secrets++; assert.fail('No credential access'); } }, output = [];
  for (const command of retired) {
    for (const tail of [[], ['--state', path.join(base, 'must-not-open')], ['--password-file', 'must-not-read', '--root', 'invalid-old-root']]) {
      assert.throws(() => parseArgs([command, ...tail]), { code: 'LEGACY_COMMAND_REMOVED' });
      await assert.rejects(runCli([command, ...tail], { env, output: value => output.push(value) }), error => error.code === 'LEGACY_COMMAND_REMOVED' && /Bidirectional Sync/.test(error.message));
    }
  }
  assert.deepEqual([stores, network, secrets], [0, 0, 0]); assert.deepEqual(output, []);
});

test('account CLI help offers no legacy project operations and requires no local state', async t => {
  t.mock.method(LocalStore.prototype, 'exclusive', async () => assert.fail('Help must not open state'));
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const output = []; await runCli(args, { output: value => output.push(value) });
    assert.equal(output.length, 1); assert.match(output[0], /account diagnostics only/); assert.match(output[0], /Bidirectional Sync/);
    assert.doesNotMatch(output[0], /^\s+(?:preview|push|retry|list|restore)(?:\s|$)/m);
  }
  for (const command of ['status', 'logout']) for (const option of ['root', 'project', 'id', 'to', 'device', 'server', 'password-file']) assert.throws(() => parseArgs([command, '--' + option, 'unused']));
  assert.throws(() => parseArgs(['login', '--password', 'do-not-put-secrets-in-argv']));
});

test('retired CLI calls leave an existing immutable pending queue and account configuration byte-identical', async t => {
  await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'retired-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), base); assert.match(path.basename(directory), /^retired-cli-[a-zA-Z0-9]+$/);
    assert.equal(await fs.realpath(directory), directory); await fs.rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'project'), destination = path.join(directory, 'not-created'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'keep.txt'), 'synthetic retained data');
  const store = await new LocalStore(path.join(directory, 'state')).init();
  await store.saveConfig({ server: 'https://fixture.invalid', username: 'owner', deviceId: 'device-fixture', token: 's'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' });
  const queued = await store.capture({ root, projectId: 'fixture-project', deviceId: 'device-fixture' });
  const files = [path.join(store.directory, 'config.json'), path.join(store.directory, 'pending', queued.queuedId + '.json'), path.join(root, 'keep.txt')];
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Retired commands must not contact cloud'));
  for (const command of retired) await assert.rejects(runCli([command, '--state', store.directory, '--root', root, '--to', destination], { output: () => assert.fail('No legacy output') }), { code: 'LEGACY_COMMAND_REMOVED' });
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before); assert.equal((await store.pending()).length, 1);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});
