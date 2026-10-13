import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateManifest, validateRelativePath, sha256, validateId } from '../src/protocol.mjs';
import { captureCheckpoint, restoreCheckpoint, isExcluded, contentFingerprint } from '../src/snapshot.mjs';
import { LocalStore } from '../src/local-store.mjs';
import { validateServerUrl } from '../src/client.mjs';
import { parseArgs, runCli } from '../src/cli.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
async function temporary(t) {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'core-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(base)); assert.ok(path.basename(dir).startsWith('core-')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
function manifest(files = []) {
  return { version: 1, id: randomUUID(), projectId: 'demo', deviceId: 'device-a', parentId: null, createdAt: new Date().toISOString(), sourceRoot: 'C:\\demo', sessionIds: [], files };
}
test('portable path validation rejects traversal, device files, ADS and aliases', () => {
  for (const name of ['../x', '/x', 'a/../b', 'C:/x', 'a\\b', 'a//b', 'NUL.txt', 'COM1', 'lpt¹.txt', 'a. ', 'a\u0000b', 'a/']) assert.throws(() => validateRelativePath(name));
  assert.equal(validateRelativePath('中文/notes.md'), '中文/notes.md');
  assert.throws(() => validateId('constructor'));
  const file = { path: 'project/a', sha256: sha256('a'), size: 1 };
  for (const second of ['project/A', 'project/a/b']) assert.throws(() => validateManifest(manifest([file, { ...file, path: second }])));
  assert.throws(() => validateManifest(manifest([{ ...file, path: 'project/.dsh-sync/token' }])));
});
test('manifest strips unknown fields and enforces session and asset bindings', () => {
  assert.equal(validateManifest({ ...manifest(), token: 'never forward' }).token, undefined);
  assert.throws(() => validateManifest({ ...manifest(), sessionIds: ['session-a'] }));
  assert.throws(() => validateManifest(manifest([{ path: 'assets/wrong', sha256: sha256('x'), size: 1 }])));
});
test('HTTPS is mandatory, no credential URLs, redirects or path-based endpoint ambiguity', () => {
  assert.equal(validateServerUrl('https://sync.example.test'), 'https://sync.example.test');
  assert.equal(validateServerUrl('http://127.0.0.1:19876'), 'http://127.0.0.1:19876');
  for (const url of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/api', 'https://example.test?token=x', 'ftp://localhost']) assert.throws(() => validateServerUrl(url));
});
test('secret/cache exclusions cannot be undone by ignore rules', () => {
  for (const name of ['.env', '.env.production', 'dir/id_rsa', '.ssh/key', '.npmrc', 'node_modules/x', 'file.pem']) assert.equal(isExcluded(name), true);
  assert.equal(isExcluded('dist/output.zip'), false);
  assert.equal(isExcluded('logs/debug.log', ['logs/**']), true);
});
test('roundtrip preserves binary, Unicode, session envelopes and assets; refuses overwrite', async t => {
  const temp = await temporary(t), root = path.join(temp, 'source'); await fs.mkdir(root);
  await fs.mkdir(path.join(root, '中文'));
  await fs.writeFile(path.join(root, '中文', 'bin.dat'), Buffer.from([0, 255, 1, 3]));
  await fs.writeFile(path.join(root, '.env'), 'SECRET=not uploaded');
  await fs.writeFile(path.join(root, 'notes.md'), '# hello');
  await fs.writeFile(path.join(root, '.dsh-syncignore'), '*.log\n');
  await fs.writeFile(path.join(root, 'secret.log'), 'excluded');
  const blobs = new Map();
  const captured = await captureCheckpoint({ root, projectId: 'demo', deviceId: 'device-a', sessions: [{ id: 'session-a', data: { version: 1, messages: ['opaque history'] } }], assets: [Buffer.from('asset')], putBlob: async (hash, bytes) => blobs.set(hash, bytes) });
  assert.ok(!captured.manifest.files.some(file => /\.env|secret\.log/.test(file.path)));
  assert.equal(captured.skipped.length, 2);
  assert.equal(contentFingerprint(captured.manifest), contentFingerprint({ ...captured.manifest, id: 'different-id', createdAt: '2000-01-01T00:00:00.000Z' }));
  const target = path.join(temp, 'target');
  const restored = await restoreCheckpoint({ manifest: captured.manifest, destination: target, getBlob: async hash => blobs.get(hash) });
  assert.deepEqual(await fs.readFile(path.join(target, '中文', 'bin.dat')), Buffer.from([0, 255, 1, 3]));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, '.dsh-sync', 'sessions', 'session-a.json'))), { version: 1, messages: ['opaque history'] });
  assert.equal(restored.root, target);
  await assert.rejects(fs.stat(path.join(target, '.dsh-sync', 'INCOMPLETE')), { code: 'ENOENT' });
  await assert.rejects(restoreCheckpoint({ manifest: captured.manifest, destination: target, getBlob: async hash => blobs.get(hash) }), { code: 'EEXIST' });
});
test('corrupt restore leaves an explicit incomplete marker and cannot escape destination', async t => {
  const temp = await temporary(t), target = path.join(temp, 'bad');
  await assert.rejects(restoreCheckpoint({ manifest: manifest([{ path: 'project/a.txt', sha256: sha256('ok'), size: 2 }]), destination: target, getBlob: async () => Buffer.from('NO') }), /Corrupt/);
  assert.ok((await fs.readFile(path.join(target, '.dsh-sync', 'INCOMPLETE'), 'utf8')).includes('incomplete'));
  await assert.rejects(captureCheckpoint({ root: target, projectId: 'demo', deviceId: 'a', putBlob: async () => assert.fail('must not upload partial restores') }), /incomplete restore/);
  const invalid = manifest([{ path: 'project/../../escape', sha256: sha256('x'), size: 1 }]);
  await assert.rejects(restoreCheckpoint({ manifest: invalid, destination: path.join(temp, 'never-created'), getBlob: async () => Buffer.from('x') }));
  await assert.rejects(fs.stat(path.join(temp, 'never-created')), { code: 'ENOENT' });
});
test('cancellation after directory reservation still writes only an incomplete safety marker', async t => {
  const temp = await temporary(t), target = path.join(temp, 'cancelled'), abort = new AbortController();
  const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    const result = await mkdir(directory, ...args);
    if (directory === target) abort.abort();
    return result;
  });
  await assert.rejects(restoreCheckpoint({ manifest: manifest(), destination: target, signal: abort.signal, getBlob: async () => assert.fail('cancelled before data') }), { name: 'AbortError' });
  assert.ok(await fs.stat(path.join(target, '.dsh-sync', 'INCOMPLETE')));
  await assert.rejects(fs.stat(path.join(target, '.dsh-sync', 'manifest.json')), { code: 'ENOENT' });
});
test('a replaced parent cannot receive metadata after restore reserved its original directory', async t => {
  const temp = await temporary(t), parent = path.join(temp, 'parent'), parked = path.join(temp, 'parent-original');
  await fs.mkdir(parent);
  const target = path.join(parent, 'restore'), meta = path.join(target, '.dsh-sync'), mkdir = fs.mkdir;
  let replaced = false;
  t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    const result = await mkdir(directory, ...args);
    if (directory === meta && !replaced) {
      replaced = true;
      assert.equal(await fs.realpath(parent), parent);
      assert.equal(path.dirname(parent), temp); assert.equal(path.dirname(parked), temp);
      await fs.rename(parent, parked);
      await mkdir(parent); await mkdir(target);
    }
    return result;
  });
  await assert.rejects(restoreCheckpoint({ manifest: manifest(), destination: target, getBlob: async () => assert.fail('no data read') }), { code: 'DESTINATION_CHANGED' });
  assert.deepEqual(await fs.readdir(target), []);
});
test('a replaced reserved root cannot receive project bytes or a completion manifest', async t => {
  const temp = await temporary(t), target = path.join(temp, 'restore'), parked = path.join(temp, 'restore-original');
  const bytes = Buffer.from('safe bytes');
  await assert.rejects(restoreCheckpoint({ manifest: manifest([{ path: 'project/data.bin', sha256: sha256(bytes), size: bytes.length }]), destination: target,
    getBlob: async () => {
      assert.equal(await fs.realpath(target), target);
      assert.equal(path.dirname(target), temp); assert.equal(path.dirname(parked), temp);
      await fs.rename(target, parked); await fs.mkdir(target); return bytes;
    },
  }), { code: 'DESTINATION_CHANGED' });
  assert.deepEqual(await fs.readdir(target), []);
  assert.ok(await fs.stat(path.join(parked, '.dsh-sync', 'INCOMPLETE')));
});
test('symlink/junction project entries excluded; destination parents cannot be links', async t => {
  const temp = await temporary(t), root = path.join(temp, 'root'), outside = path.join(temp, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'not selected');
  const link = path.join(root, 'linked');
  try { await fs.symlink(outside, link, 'junction'); } catch (error) { if (error.code === 'EPERM') { t.skip('OS disallows creating link fixtures'); return; } throw error; }
  // Explicitly remove this known fixture link before recursive cleanup on Windows.
  t.after(async () => { try { if (process.platform === 'win32') await fs.rmdir(link); else await fs.unlink(link); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
  const captured = await captureCheckpoint({ root, projectId: 'demo', deviceId: 'device-a', putBlob: async () => {} });
  assert.equal(captured.manifest.files.length, 0); assert.equal(captured.skipped[0].reason, 'link-or-special-file');
  await assert.rejects(restoreCheckpoint({ manifest: manifest(), destination: path.join(link, 'escape'), getBlob: async () => Buffer.alloc(0) }), /Symbolic/);
  if (process.platform === 'win32') await fs.rmdir(link); else await fs.unlink(link);
});
test('local spool persists offline, retries same checkpoint id, and deduplicates unchanged snapshots', async t => {
  const temp = await temporary(t), root = path.join(temp, 'root'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'a.txt'), 'one');
  const store = await new LocalStore(path.join(temp, 'state')).init();
  const first = await store.exclusive(() => store.capture({ root, projectId: 'demo', deviceId: 'device-a' }));
  await assert.rejects(store.flush({ uploadBlob: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await store.pending()).length, 1);
  const second = await store.capture({ root, projectId: 'demo', deviceId: 'device-a' });
  assert.equal(second.unchanged, true); assert.equal(second.queuedId, first.manifest.id);
  const commits = [];
  await store.flush({ uploadBlob: async () => {}, commit: async item => { commits.push(item.id); return { id: item.id, conflict: false, heads: [item.id] }; } });
  assert.deepEqual(commits, [first.manifest.id]); assert.equal((await store.pending()).length, 0);
  assert.equal((await store.capture({ root, projectId: 'demo', deviceId: 'device-a' })).unchanged, true);
  await fs.writeFile(path.join(root, 'a.txt'), 'two');
  const third = await store.capture({ root, projectId: 'demo', deviceId: 'device-a' });
  assert.equal(third.manifest.parentId, first.manifest.id);
});
test('state locks serialize operations and state directory is never captured', async t => {
  const temp = await temporary(t), root = path.join(temp, 'root'); await fs.mkdir(root);
  const store = await new LocalStore(path.join(root, 'state-private')).init();
  await store.saveConfig({ token: 'never-upload' });
  await store.exclusive(async () => { await assert.rejects(store.exclusive(async () => {}), /Another sync/); });
  const result = await store.capture({ root, projectId: 'demo', deviceId: 'device-a' });
  assert.equal(result.manifest.files.length, 0);
});
test('CLI rejects command-line passwords and retired project operations before opening state', async t => {
  assert.throws(() => parseArgs(['login', '--password', 'not-safe']));
  const temp = await temporary(t), state = path.join(temp, 'unopened-state'), output = [];
  await assert.rejects(runCli(['preview', '--state', state, '--root', temp, '--project', 'demo'], { output: data => output.push(data) }), { code: 'LEGACY_COMMAND_REMOVED' });
  assert.deepEqual(output, []);
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});
