import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/protocol.mjs';
import { createSyncApplier, scanSyncProject, syncRootIdentity, verifySyncRoot } from '../src/sync-local.mjs';
import { LocalStore } from '../src/local-store.mjs';
import { conflictId } from '../src/sync-protocol.mjs';

const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const state = text => ({ hash: sha256(Buffer.from(text)), size: Buffer.byteLength(text), executable: false });
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'sync-local-')), root = path.join(directory, 'project');
  await fs.mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.match(path.basename(directory), /^sync-local-[A-Za-z0-9]+$/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const blobs = new Map();
  function bytes(text) { const value = Buffer.from(text); blobs.set(sha256(value), value); return state(text); }
  const create = extra => createSyncApplier({ root, bindingId: 'binding', projectId: 'project', ...extra });
  const getBlob = async hash => blobs.get(hash);
  return { directory, root, create, bytes, getBlob };
}

test('same-directory apply creates/replaces/deletes with verified recoverable copies', async t => {
  const f = await fixture(t), old = f.bytes('old'), next = f.bytes('next'), removed = f.bytes('removed');
  await fs.writeFile(path.join(f.root, 'edit.txt'), 'old'); await fs.writeFile(path.join(f.root, 'delete.txt'), 'removed');
  const applier = await f.create();
  await applier.prepare({ id: 'tx', operations: [
    { path: 'edit.txt', expected: old, desired: next },
    { path: 'delete.txt', expected: removed, desired: null },
    { path: 'dir/create.txt', expected: null, desired: next },
  ], remoteReceipt: { id: 'revision-1' } }, f.getBlob);
  assert.equal(await fs.readFile(path.join(f.root, 'edit.txt'), 'utf8'), 'old', 'preparation must not modify user files');
  assert.equal((await applier.apply('tx')).state, 'applied');
  assert.equal(await fs.readFile(path.join(f.root, 'edit.txt'), 'utf8'), 'next');
  await assert.rejects(fs.stat(path.join(f.root, 'delete.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.root, 'dir/create.txt'), 'utf8'), 'next');
  const copies = await applier.recycle(); assert.equal(copies.length, 2);
  assert.equal((await applier.readRecycled('tx', 1)).bytes.toString(), 'removed');
  await applier.finalize('tx');
  assert.equal((await applier.apply('tx')).state, 'applied');
});

test('local edit after plan never gets overwritten or recycled as the wrong version', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a'), 'old');
  const applier = await f.create();
  await applier.prepare({ id: 'tx', operations: [{ path: 'a', expected: f.bytes('old'), desired: f.bytes('cloud') }] }, f.getBlob);
  await fs.writeFile(path.join(f.root, 'a'), 'new local edit');
  const result = await applier.apply('tx'); assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SYNC_LOCAL_CHANGED');
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'new local edit');
  assert.equal((await applier.recycle()).length, 0);
});

test('crash after preserve resumes from durable backup without repeating destructive work', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a'), 'old');
  let crash = true;
  const first = await f.create({ fault: async phase => { if (phase === 'after-preserve' && crash) { crash = false; throw new Error('synthetic crash'); } } });
  await first.prepare({ id: 'tx', operations: [{ path: 'a', expected: f.bytes('old'), desired: f.bytes('cloud') }] }, f.getBlob);
  await assert.rejects(first.apply('tx'), /synthetic crash/);
  await assert.rejects(fs.stat(path.join(f.root, 'a')), { code: 'ENOENT' });
  const resumed = await f.create(); assert.equal((await resumed.apply('tx')).state, 'applied');
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'cloud');
  assert.equal((await resumed.readRecycled('tx', 0)).bytes.toString(), 'old');
});

test('crash after publish recognizes desired bytes and keeps only one recycle entry', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a'), 'old');
  const first = await f.create({ fault: async phase => { if (phase === 'after-publish') throw new Error('synthetic crash'); } });
  await first.prepare({ id: 'tx', operations: [{ path: 'a', expected: f.bytes('old'), desired: f.bytes('cloud') }] }, f.getBlob);
  await assert.rejects(first.apply('tx'), /synthetic crash/);
  const resumed = await f.create(); assert.equal((await resumed.apply('tx')).state, 'applied');
  assert.equal((await resumed.recycle()).length, 1);
  assert.equal((await resumed.apply('tx')).state, 'applied');
});

test('external recreation after preserve is not overwritten on restart', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a'), 'old');
  const first = await f.create({ fault: async phase => { if (phase === 'after-preserve') throw new Error('synthetic crash'); } });
  await first.prepare({ id: 'tx', operations: [{ path: 'a', expected: f.bytes('old'), desired: f.bytes('cloud') }] }, f.getBlob);
  await assert.rejects(first.apply('tx'));
  await fs.writeFile(path.join(f.root, 'a'), 'external');
  const resumed = await f.create(); assert.equal((await resumed.apply('tx')).state, 'blocked');
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'external');
  assert.equal((await resumed.readRecycled('tx', 0)).bytes.toString(), 'old');
});

test('interrupted staging can be retried with the same exact intent; changed request rejected', async t => {
  const f = await fixture(t), applier = await f.create();
  const input = { id: 'tx', operations: [{ path: 'a', expected: null, desired: f.bytes('cloud') }] };
  await assert.rejects(applier.prepare(input, async () => { throw new Error('offline'); }), /offline/);
  await applier.prepare(input, f.getBlob); assert.equal((await applier.apply('tx')).state, 'applied');
  await assert.rejects(applier.prepare({ ...input, operations: [] }, f.getBlob), { code: 'SYNC_REQUEST_CONFLICT' });
});

test('corrupt transfer, quota, protected path and cancellation fail before touching user data', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a'), 'old');
  const operations = [{ path: 'a', expected: f.bytes('old'), desired: f.bytes('cloud') }];
  await assert.rejects((await f.create({ quotaBytes: 1 })).prepare({ id: 'quota', operations }, f.getBlob), { code: 'SYNC_QUOTA' });
  await assert.rejects((await f.create()).prepare({ id: 'corrupt', operations }, async () => Buffer.from('bad')), { code: 'SYNC_INTEGRITY' });
  await assert.rejects((await f.create()).prepare({ id: 'secret', operations: [{ path: '.env', expected: null, desired: f.bytes('secret') }] }, f.getBlob), { code: 'SYNC_PROTECTED_PATH' });
  const abort = new AbortController(), applier = await f.create({ signal: abort.signal });
  await applier.prepare({ id: 'cancel', operations }, f.getBlob); abort.abort();
  await assert.rejects(applier.apply('cancel'), { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'old');
});

test('root replacement rejects an old plan even at the same path', async t => {
  const f = await fixture(t), identity = await syncRootIdentity(f.root);
  const moved = path.join(f.directory, 'original');
  assert.equal(path.resolve(f.root), path.join(path.resolve(f.directory), 'project'));
  assert.equal(path.resolve(moved), path.join(path.resolve(f.directory), 'original'));
  await fs.rename(f.root, moved); await fs.mkdir(f.root);
  await assert.rejects(verifySyncRoot(identity), { code: 'SYNC_ROOT_CHANGED' });
});

test('conflict alternatives are immutable excluded copies and unchanged observations deduplicate', async t => {
  const f = await fixture(t), local = f.bytes('local'), remote = f.bytes('remote'), applier = await f.create();
  await fs.writeFile(path.join(f.root, 'a'), 'local');
  const conflict = { id: conflictId('project', 'a', null), variants: [local, remote, null] };
  await applier.preserveVariants([conflict], f.getBlob); await applier.preserveVariants([conflict], f.getBlob);
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'local');
  assert.equal((await fs.readdir(path.join(applier.metadata, 'conflicts', conflict.id))).length, 2);
});

test('scan excludes local ignore authority and metadata and marks ignored descendants unmanaged', async t => {
  const f = await fixture(t), spool = await new LocalStore(path.join(f.directory, 'state')).init();
  await fs.mkdir(path.join(f.root, 'private')); await fs.writeFile(path.join(f.root, 'private', 'x.txt'), 'no upload');
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'private/\n'); await fs.writeFile(path.join(f.root, 'ok.txt'), 'yes');
  await f.create();
  const scan = await scanSyncProject({ root: f.root, projectId: 'project', deviceId: 'device', putBlob: (hash, bytes) => spool.putBlob(hash, bytes) });
  assert.deepEqual(scan.files.map(item => item.path), ['ok.txt']); assert.equal(scan.isManaged('private/x.txt'), false);
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'private/\nok.txt\n');
  await assert.rejects(scan.verify(), { code: 'SYNC_POLICY_CHANGED' });
});

test('crash after transaction mkdir reconstructs only an intent-owned empty journal and does not poison recycle', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a'), 'old');
  const input = { id: 'orphan', operations: [{ path: 'a', expected: f.bytes('old'), desired: f.bytes('cloud') }] };
  const first = await f.create({ fault: async phase => { if (phase === 'transaction-created') throw new Error('synthetic pre-journal crash'); } });
  await assert.rejects(first.prepare(input, f.getBlob), /pre-journal crash/);
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'old');
  const resumed = await f.create(); assert.deepEqual(await resumed.recycle(), []);
  await resumed.prepare(input, f.getBlob); assert.equal((await resumed.apply('orphan')).state, 'applied');
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'cloud');
  assert.equal((await resumed.readRecycled('orphan', 0)).bytes.toString(), 'old');
});

test('an unknown transaction or unexpected orphan contents are never adopted or deleted', async t => {
  const f = await fixture(t), input = { id: 'orphan', operations: [{ path: 'a', expected: null, desired: f.bytes('cloud') }] };
  const first = await f.create({ fault: async phase => { if (phase === 'transaction-created') throw new Error('synthetic pre-journal crash'); } });
  await assert.rejects(first.prepare(input, f.getBlob));
  const target = path.join(first.metadata, 'transactions', 'orphan', 'unrelated.txt'); await fs.writeFile(target, 'preserve unrelated');
  const resumed = await f.create(); await assert.rejects(resumed.prepare(input, f.getBlob), { code: 'SYNC_METADATA_UNSAFE' });
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve unrelated');
  const unknown = path.join(first.metadata, 'transactions', 'unknown'); await fs.mkdir(unknown);
  await assert.rejects(resumed.prepare({ ...input, id: 'unknown' }, f.getBlob));
  await assert.rejects(fs.stat(path.join(f.root, 'a')), { code: 'ENOENT' });
});
