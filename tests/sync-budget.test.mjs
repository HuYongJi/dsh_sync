import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncRootIdentity } from '../src/sync-local.mjs';
import { DEFAULT_SYNC_BUDGET, measureSyncStorage, bindingBudget, reserveSyncStorage } from '../src/sync-budget.mjs';

const parent = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (child, root) => pathKey(child) === pathKey(root) || pathKey(child).startsWith(pathKey(root) + path.sep);
const patchedStat = (info, patch) => Object.assign(Object.create(info), patch);
const usageOf = (stateBytes = 20, a = 30, b = 50) => ({ bytes: stateBytes + a + b, stateBytes, byBinding: [{ id: 'a', bytes: a }, { id: 'b', bytes: b }], complete: true, diagnostics: [], entries: 0 });

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'sync-budget-')), links = [];
  const at = relative => {
    const target = path.resolve(directory, relative);
    assert.ok(target.startsWith(directory + path.sep));
    return target;
  };
  t.after(async () => {
    t.mock.restoreAll();
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.match(path.basename(directory), /^sync-budget-[A-Za-z0-9]+$/);
    assert.equal(pathKey(await fs.realpath(directory)), pathKey(directory));
    assert.ok((await fs.lstat(directory)).isDirectory());
    // Remove the exact known junction entries before targets/parent rm. Windows
    // recursive rm can leave dangling junctions behind and then report ENOTEMPTY.
    for (const link of links.reverse()) {
      assert.equal(path.resolve(link.target), at(link.relative));
      assert.ok(within(link.destination, directory));
      let info;
      try { info = await fs.lstat(link.target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      assert.equal(pathKey(await fs.realpath(link.target)), pathKey(link.destination));
      assert.ok(info.isSymbolicLink() || pathKey(link.target) !== pathKey(link.destination));
      if (process.platform === 'win32' && link.kind === 'junction') await fs.rmdir(link.target);
      else await fs.unlink(link.target);
    }
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.equal(pathKey(await fs.realpath(directory)), pathKey(directory));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const mkdir = async relative => { const target = at(relative); await fs.mkdir(target, { recursive: true }); return target; };
  const write = async (relative, size) => { const target = at(relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.alloc(size, 97)); return target; };
  const binding = async (id, relative = `project-${id}`) => {
    const root = await mkdir(relative);
    return { id, root, rootIdentity: await syncRootIdentity(root) };
  };
  const move = async (source, destination) => {
    const from = at(source), to = at(destination);
    assert.equal(from, path.join(directory, source)); assert.equal(to, path.join(directory, destination));
    await fs.rename(from, to);
  };
  const link = async (relative, destinationRelative, file = false) => {
    const target = at(relative), destination = at(destinationRelative), kind = file ? 'file' : process.platform === 'win32' ? 'junction' : 'dir';
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(destination, target, kind);
    links.push({ relative, target, destination, kind });
    return target;
  };
  return { directory, at, mkdir, write, binding, move, link };
}
function incomplete(usage, code, bindingId) {
  assert.equal(usage.complete, false);
  assert.deepEqual(usage.diagnostics, [{ code, ...(bindingId ? { bindingId } : {}) }]);
  assert.ok(Number.isSafeInteger(usage.bytes) && usage.bytes >= 0);
  assert.equal(usage.bytes, usage.stateBytes + usage.byBinding.reduce((total, row) => total + row.bytes, 0));
  assert.throws(() => reserveSyncStorage({ usage, additionalBytes: 0 }), { code: 'SYNC_QUOTA' });
  if (usage.byBinding.length) assert.throws(() => bindingBudget({ usage, bindingId: usage.byBinding[0].id }), { code: 'SYNC_QUOTA' });
}
function readOnly(t) {
  for (const method of Object.keys(fs)) {
    if (typeof fs[method] !== 'function' || ['lstat', 'realpath', 'readdir'].includes(method)) continue;
    t.mock.method(fs, method, () => assert.fail(`measurement must not call fs.${method}`));
  }
}

test('profile accounting includes shared spool/intents/archive cache and both bindings, never project files or contents', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), a = await f.binding('a'), b = await f.binding('b');
  await f.write('state/spool/blob', 11);
  await f.write('state/bidirectional-intents-profile/request.json', 13);
  await f.write('state/session-sync/account/scope/cache/immutable', 17);
  await f.write('state/v2/retired/engine.json', 19);
  await f.write('state/v2/a/engine.json', 5); await f.write('project-a/.dsh-sync/v2/a/transactions/tx/backup/0', 7);
  await f.write('state/v2/b/blobs/blob', 2); await f.write('project-b/.dsh-sync/v2/b/conflicts/variant', 3);
  await f.write('project-a/.env', 1001); await f.write('project-b/unrelated-user-file', 1002);
  await f.write('project-a/.dsh-sync/legacy/backup', 1003); await f.write('project-a/.dsh-sync/v2/unlisted/backup', 1004);
  const readdir = fs.readdir, listed = [];
  t.mock.method(fs, 'readdir', async (target, ...args) => {
    listed.push(path.resolve(target));
    assert.ok([stateDir, f.at('project-a/.dsh-sync/v2/a'), f.at('project-b/.dsh-sync/v2/b')].some(root => within(target, root)));
    return readdir(target, ...args);
  });
  readOnly(t);
  const usage = await measureSyncStorage({ stateDir, bindings: [a, b] });
  assert.equal(usage.complete, true); assert.deepEqual(usage.diagnostics, []);
  assert.equal(usage.bytes, 77); assert.equal(usage.stateBytes, 60);
  assert.deepEqual(usage.byBinding, [{ id: 'a', bytes: 12 }, { id: 'b', bytes: 5 }]);
  assert.equal(new Set(listed.map(pathKey)).size, listed.length, 'each directory is enumerated only once');
  assert.equal(bindingBudget({ limit: 100, usage, bindingId: 'a' }), 35);
  assert.equal(bindingBudget({ limit: 100, usage, bindingId: 'b' }), 28);
});

test('literal state directory inside a project neither glob-matches nor swallows prefix siblings', async t => {
  const f = await fixture(t), binding = await f.binding('binding', 'project'), stateDir = await f.mkdir('project/cache[ab]{literal}');
  await f.write('project/cache[ab]{literal}/spool', 4); await f.write('project/cache[ab]{literal}/v2/binding/spool', 5);
  await f.write('project/cachealiteral/private', 100); await f.write('project/cache[ab]{literal}-sibling/private', 101);
  await f.write('project/.dsh-sync/v2/binding/backup', 6); await f.write('project/.dsh-sync/v2/binding-other/private', 102);
  await f.write('project/credentials.json', 103);
  const usage = await measureSyncStorage({ stateDir, bindings: [binding] });
  assert.equal(usage.complete, true); assert.equal(usage.bytes, 15); assert.equal(usage.stateBytes, 4);
  assert.deepEqual(usage.byBinding, [{ id: 'binding', bytes: 11 }]);
});

test('overlapping state and identical engine/applier roots are coalesced without double accounting', async t => {
  const f = await fixture(t), binding = await f.binding('binding', 'project'), stateDir = await f.mkdir('project/.dsh-sync');
  await f.write('project/.dsh-sync/spool/shared', 3);
  await f.write('project/.dsh-sync/v2/binding/engine.json', 4);
  await f.write('project/.dsh-sync/v2/binding/transactions/backup', 5);
  const readdir = fs.readdir, listed = [];
  t.mock.method(fs, 'readdir', async (target, ...args) => { listed.push(pathKey(target)); return readdir(target, ...args); });
  const usage = await measureSyncStorage({ stateDir, bindings: [binding] });
  assert.equal(usage.complete, true); assert.equal(usage.bytes, 12); assert.equal(usage.stateBytes, 3);
  assert.deepEqual(usage.byBinding, [{ id: 'binding', bytes: 9 }]);
  assert.equal(listed.length, new Set(listed).size);
  assert.equal(bindingBudget({ limit: 20, usage, bindingId: 'binding' }), 17);
});

test('state nested within an applier keeps shared cache separate and counts nested engine bytes once', async t => {
  const f = await fixture(t), binding = await f.binding('a', 'project'), prefix = 'project/.dsh-sync/v2/a';
  const stateDir = await f.mkdir(`${prefix}/plugin-state`);
  await f.write(`${prefix}/backup`, 7); await f.write(`${prefix}/plugin-state/session-sync/cache`, 3);
  await f.write(`${prefix}/plugin-state/v2/a/engine.json`, 5);
  const usage = await measureSyncStorage({ stateDir, bindings: [binding] });
  assert.equal(usage.complete, true); assert.equal(usage.bytes, 15); assert.equal(usage.stateBytes, 3);
  assert.deepEqual(usage.byBinding, [{ id: 'a', bytes: 12 }]);
});

test('nested project roots and multiple bindings at one project count only exact binding metadata', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state');
  const a = await f.binding('a', 'project'), b = await f.binding('b', 'project/nested'), c = { ...a, id: 'c' };
  await f.write('project/.dsh-sync/v2/a/backup', 2); await f.write('project/.dsh-sync/v2/c/backup', 3);
  await f.write('project/nested/.dsh-sync/v2/b/backup', 5); await f.write('project/nested/user-file', 100);
  const usage = await measureSyncStorage({ stateDir, bindings: [a, b, c] });
  assert.equal(usage.complete, true); assert.equal(usage.bytes, 10); assert.equal(usage.stateBytes, 0);
  assert.deepEqual(usage.byBinding, [{ id: 'a', bytes: 2 }, { id: 'b', bytes: 5 }, { id: 'c', bytes: 3 }]);
});

test('uncreated metadata is known zero only below verified owners; measurement does not create it', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), binding = await f.binding('new');
  readOnly(t);
  const usage = await measureSyncStorage({ stateDir, bindings: [binding] });
  assert.equal(usage.complete, true); assert.equal(usage.bytes, 0); assert.equal(usage.stateBytes, 0);
  assert.deepEqual(usage.byBinding, [{ id: 'new', bytes: 0 }]);
  assert.equal(bindingBudget({ usage, bindingId: 'new' }), DEFAULT_SYNC_BUDGET);
  t.mock.restoreAll();
  assert.deepEqual(await fs.readdir(stateDir), []); assert.deepEqual(await fs.readdir(binding.root), []);
});

test('missing plugin-owned state root is unknown, never spendable zero capacity', async t => {
  const f = await fixture(t), stateDir = f.at('missing-state');
  readOnly(t);
  const usage = await measureSyncStorage({ stateDir });
  incomplete(usage, 'SYNC_METADATA_UNSAFE');
  assert.equal(usage.bytes, 0); assert.equal(usage.entries, 0);
});

for (const replacement of [false, true]) {
  test(`missing or replaced project root is unknown before any owned enumeration (${replacement ? 'replacement' : 'missing'})`, async t => {
    const f = await fixture(t), stateDir = await f.mkdir('state'), binding = await f.binding('a', 'project');
    await f.write('state/v2/a/blob', 5); await f.move('project', 'old-project');
    if (replacement) { await f.mkdir('project'); await f.write('project/private', 7); }
    t.mock.method(fs, 'readdir', () => assert.fail('unverified root must stop enumeration'));
    incomplete(await measureSyncStorage({ stateDir, bindings: [binding] }), 'SYNC_ROOT_CHANGED', 'a');
  });
}

test('corrupt identifiers, identity paths and broad ownership layouts cannot authorize enumeration', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), binding = await f.binding('a', 'project');
  t.mock.method(fs, 'readdir', () => assert.fail('invalid input must not enumerate'));
  for (const id of ['', '../outside', 'a/b', 'a\\b', 'a:b', '*', '__proto__', 'constructor', 'nul']) {
    await assert.rejects(measureSyncStorage({ stateDir, bindings: [{ ...binding, id }] }), { code: 'SYNC_METADATA_UNSAFE' });
  }
  const windowsAliases = process.platform === 'win32' ? ['\\unqualified', '/unqualified', 'C:relative', '\\\\?\\C:\\state', 'C:\\state:stream'] : [];
  for (const value of ['', '.', 'relative/state', `${stateDir}\0`, `${stateDir}${path.sep}..${path.sep}elsewhere`, ...windowsAliases]) {
    await assert.rejects(measureSyncStorage({ stateDir: value }), { code: 'SYNC_METADATA_UNSAFE' });
  }
  await assert.rejects(measureSyncStorage({ stateDir, bindings: [binding, { ...binding, id: 'A' }] }), { code: 'SYNC_METADATA_UNSAFE' });
  await assert.rejects(measureSyncStorage({ stateDir, bindings: [{ ...binding, rootIdentity: { ...binding.rootIdentity, root: stateDir } }] }), { code: 'SYNC_ROOT_CHANGED' });
  await assert.rejects(measureSyncStorage({ stateDir, bindings: [{ ...binding, rootIdentity: { ...binding.rootIdentity, ino: '-1' } }] }), { code: 'SYNC_ROOT_CHANGED' });
  for (const broad of [binding.root, f.directory, path.parse(f.directory).root]) {
    await assert.rejects(measureSyncStorage({ stateDir: broad, bindings: [binding] }), { code: 'SYNC_METADATA_UNSAFE' });
  }
  const nested = { id: 'b', root: f.at('project/.dsh-sync/v2/a/user-project'), rootIdentity: { ...binding.rootIdentity, root: f.at('project/.dsh-sync/v2/a/user-project') } };
  await assert.rejects(measureSyncStorage({ stateDir, bindings: [binding, nested] }), { code: 'SYNC_METADATA_UNSAFE' });
});

for (const location of ['state', 'state/v2/a', 'state/spool/redirect', 'project/.dsh-sync', 'project/.dsh-sync/v2/a', 'project/.dsh-sync/v2/a/redirect']) {
  test(`directory symlink/junction is rejected before following ${location}`, async t => {
    const f = await fixture(t), binding = await f.binding('a', 'project');
    if (location !== 'state') await f.mkdir('state');
    await f.mkdir('elsewhere'); await f.write('elsewhere/private', 29);
    try { await f.link(location, 'elsewhere'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS disallows synthetic link fixtures'); return; } throw error; }
    const readdir = fs.readdir;
    t.mock.method(fs, 'readdir', async (target, ...args) => {
      assert.ok(!within(target, f.at(location)), 'must not enumerate redirect or descendants');
      return readdir(target, ...args);
    });
    const usage = await measureSyncStorage({ stateDir: f.at('state'), bindings: [binding] });
    assert.equal(usage.complete, false); assert.equal(usage.diagnostics[0].code, 'SYNC_METADATA_UNSAFE');
    assert.ok(!JSON.stringify(usage.diagnostics).includes('private'));
    assert.throws(() => bindingBudget({ usage, bindingId: 'a' }), { code: 'SYNC_QUOTA' });
  });
}

test('linked project ancestor is not accepted using a plausible root identity', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), actual = await f.binding('a', 'actual');
  try { await f.link('project', 'actual'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS disallows synthetic link fixtures'); return; } throw error; }
  const binding = { ...actual, root: f.at('project'), rootIdentity: { ...actual.rootIdentity, root: f.at('project') } };
  incomplete(await measureSyncStorage({ stateDir, bindings: [binding] }), 'SYNC_METADATA_UNSAFE', 'a');
});

test('file symlinks and hard-linked owned files are not counted as storage capacity', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state');
  const original = await f.write('external/original', 31), linked = f.at('state/hard-link');
  await fs.link(original, linked);
  incomplete(await measureSyncStorage({ stateDir }), 'SYNC_METADATA_UNSAFE');
  const otherState = await f.mkdir('other-state');
  try { await f.link('other-state/symlink', 'external/original', true); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS disallows file symlink fixture; hardlink rejection was exercised'); return; } throw error; }
  incomplete(await measureSyncStorage({ stateDir: otherState }), 'SYNC_METADATA_UNSAFE');
});

test('unrelated user symlinks and hardlinks are not visited or mistaken for owned data', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('project/state'), binding = await f.binding('a', 'project');
  await f.write('project/state/owned', 7); await f.write('elsewhere/user-data', 37);
  await fs.link(f.at('elsewhere/user-data'), f.at('project/user-hardlink'));
  try { await f.link('project/user-redirect', 'elsewhere'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  const usage = await measureSyncStorage({ stateDir, bindings: [binding] });
  assert.equal(usage.complete, true); assert.equal(usage.bytes, 7);
});

test('non-directory metadata ancestors and inaccessible entries yield path-free unknown diagnostics', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), binding = await f.binding('a', 'project');
  await f.write('project/.dsh-sync', 1);
  incomplete(await measureSyncStorage({ stateDir, bindings: [binding] }), 'SYNC_METADATA_UNSAFE', 'a');
  const target = await f.write('state/synthetic-secret-name', 2), lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (name, ...args) => {
    if (pathKey(name) === pathKey(target)) throw Object.assign(new Error('synthetic-secret-name credentials'), { code: 'EACCES' });
    return lstat(name, ...args);
  });
  const usage = await measureSyncStorage({ stateDir });
  incomplete(usage, 'SYNC_METADATA_UNSAFE');
  assert.equal(JSON.stringify(usage.diagnostics), '[{"code":"SYNC_METADATA_UNSAFE"}]');
});

for (const patch of [{ nlink: 0n }, { nlink: 2n }, { nlink: 1.5 }, { size: -1n }, { size: Number.MAX_SAFE_INTEGER + 1 }]) {
  test(`invalid file stat is unknown (${Object.keys(patch)[0]} ${String(Object.values(patch)[0])})`, async t => {
    const f = await fixture(t), stateDir = await f.mkdir('state'), target = await f.write('state/blob', 1), lstat = fs.lstat;
    t.mock.method(fs, 'lstat', async (name, ...args) => {
      const info = await lstat(name, ...args);
      return pathKey(name) === pathKey(target) ? patchedStat(info, patch) : info;
    });
    incomplete(await measureSyncStorage({ stateDir }), 'SYNC_METADATA_UNSAFE');
  });
}

test('single-file and aggregate byte integer overflow throw typed SYNC_QUOTA', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state');
  const a = await f.write('state/a', 1), b = await f.write('state/b', 1), lstat = fs.lstat;
  let tooLarge = true;
  t.mock.method(fs, 'lstat', async (name, ...args) => {
    const info = await lstat(name, ...args);
    if (pathKey(name) === pathKey(a)) return patchedStat(info, { size: BigInt(Number.MAX_SAFE_INTEGER) + (tooLarge ? 1n : 0n) });
    if (pathKey(name) === pathKey(b)) return patchedStat(info, { size: 1n });
    return info;
  });
  await assert.rejects(measureSyncStorage({ stateDir }), { code: 'SYNC_QUOTA' });
  tooLarge = false;
  await assert.rejects(measureSyncStorage({ stateDir }), { code: 'SYNC_QUOTA' });
});

test('entry bound returns unknown instead of quietly truncating and invalid bounds fail before IO', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state');
  await f.write('state/first', 1); await f.write('state/second', 2);
  const usage = await measureSyncStorage({ stateDir, maxEntries: 2 });
  incomplete(usage, 'SYNC_QUOTA'); assert.ok(usage.entries <= 2);
  const full = await measureSyncStorage({ stateDir, maxEntries: 3 });
  assert.equal(full.complete, true); assert.equal(full.entries, 3); assert.equal(full.bytes, 3);
  t.mock.method(fs, 'lstat', () => assert.fail('invalid limits must fail before filesystem access'));
  for (const maxEntries of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', 1n, null]) {
    await assert.rejects(measureSyncStorage({ stateDir, maxEntries }), { code: 'SYNC_QUOTA' });
  }
});

test('pre-cancelled and mid-check cancelled scans propagate cancellation without granting capacity', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'); await f.write('state/blob', 1);
  const aborted = new AbortController(), reason = new Error('synthetic cancellation'); aborted.abort(reason);
  const mock = t.mock.method(fs, 'lstat', () => assert.fail('pre-cancelled scan must not inspect'));
  await assert.rejects(measureSyncStorage({ stateDir, signal: aborted.signal }), error => error === reason);
  mock.mock.restore();
  const live = new AbortController(); let checks = 0;
  await assert.rejects(measureSyncStorage({ stateDir, signal: live.signal, check: async () => { if (++checks === 3) live.abort(reason); } }), error => error === reason);
  assert.equal(checks, 3);
});

test('check admission failures propagate unchanged even when their code resembles a filesystem diagnostic', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), failure = Object.assign(new Error('synthetic authorization changed'), { code: 'SYNC_METADATA_UNSAFE' });
  let checks = 0;
  await assert.rejects(measureSyncStorage({ stateDir, check: async () => { if (++checks === 3) throw failure; } }), error => error === failure);
});

test('project replaced during enumeration invalidates the snapshot without scanning the replacement', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), binding = await f.binding('a', 'project');
  await f.write('state/blob', 3); await f.write('project/.dsh-sync/v2/a/backup', 5);
  const readdir = fs.readdir; let changed = false;
  t.mock.method(fs, 'readdir', async (target, ...args) => {
    if (pathKey(target) === pathKey(stateDir) && !changed) {
      changed = true; await f.move('project', 'previous-project'); await f.mkdir('project'); await f.write('project/new-user-file', 100);
    }
    assert.notEqual(pathKey(target), pathKey(binding.root));
    return readdir(target, ...args);
  });
  incomplete(await measureSyncStorage({ stateDir, bindings: [binding] }), 'SYNC_ROOT_CHANGED', 'a');
});

test('state root replaced after readdir is unknown rather than an empty fresh directory', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'); await f.write('state/blob', 3);
  const readdir = fs.readdir; let changed = false;
  t.mock.method(fs, 'readdir', async (target, ...args) => {
    const names = await readdir(target, ...args);
    if (pathKey(target) === pathKey(stateDir) && !changed) { changed = true; await f.move('state', 'previous-state'); await f.mkdir('state'); }
    return names;
  });
  incomplete(await measureSyncStorage({ stateDir }), 'SYNC_ROOT_CHANGED');
});

test('in-place file growth after counting is detected by final metadata revalidation', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), target = await f.write('state/blob', 3), lstat = fs.lstat;
  let reads = 0;
  t.mock.method(fs, 'lstat', async (name, ...args) => {
    if (pathKey(name) === pathKey(target) && ++reads === 2) await fs.writeFile(target, Buffer.alloc(100));
    return lstat(name, ...args);
  });
  incomplete(await measureSyncStorage({ stateDir }), 'SYNC_METADATA_UNSAFE');
});

test('metadata created after initially verified absence is unknown, not a silently omitted subtree', async t => {
  const f = await fixture(t), stateDir = await f.mkdir('state'), binding = await f.binding('a', 'project'), lstat = fs.lstat;
  const missing = f.at('state/v2'); let probes = 0;
  t.mock.method(fs, 'lstat', async (name, ...args) => {
    if (pathKey(name) === pathKey(missing) && ++probes === 2) await f.write('state/v2/a/new-blob', 11);
    return lstat(name, ...args);
  });
  incomplete(await measureSyncStorage({ stateDir, bindings: [binding] }), 'SYNC_METADATA_UNSAFE', 'a');
});

test('binding budget is a profile-wide total ceiling, never a per-binding multiplied limit or remaining-only quota', () => {
  const usage = usageOf();
  assert.equal(DEFAULT_SYNC_BUDGET, 10 * 1024 ** 3);
  assert.equal(bindingBudget({ limit: 150, usage, bindingId: 'a' }), 80);
  assert.equal(bindingBudget({ limit: 150, usage, bindingId: 'b' }), 100);
  assert.equal(bindingBudget({ limit: 100, usage, bindingId: 'a' }), 30, 'current owned data is not subtracted twice');
  assert.equal(bindingBudget({ usage, bindingId: 'a' }), DEFAULT_SYNC_BUDGET - 70);
  assert.equal(bindingBudget({ limit: 100, usage: usageOf(20, 0, 80), bindingId: 'a' }), 0);
  assert.throws(() => bindingBudget({ limit: 99, usage, bindingId: 'a' }), { code: 'SYNC_QUOTA' });
  assert.throws(() => bindingBudget({ limit: 150, usage, bindingId: 'unmeasured' }), { code: 'SYNC_QUOTA' });
});

test('serialized reservation checks the global cap without mutation, allocation, cleanup, or overflow', () => {
  const usage = usageOf(), before = structuredClone(usage);
  assert.equal(reserveSyncStorage({ limit: 150, usage, additionalBytes: 0 }), 50);
  assert.equal(reserveSyncStorage({ limit: 150, usage, additionalBytes: 49 }), 1);
  assert.equal(reserveSyncStorage({ limit: 150, usage, additionalBytes: 50 }), 0);
  assert.equal(reserveSyncStorage({ usage, additionalBytes: 0 }), DEFAULT_SYNC_BUDGET - 100);
  assert.throws(() => reserveSyncStorage({ limit: 150, usage, additionalBytes: 51 }), { code: 'SYNC_QUOTA' });
  assert.throws(() => reserveSyncStorage({ limit: Number.MAX_SAFE_INTEGER, usage, additionalBytes: Number.MAX_SAFE_INTEGER }), { code: 'SYNC_QUOTA' });
  assert.deepEqual(usage, before);
  const huge = usageOf(Number.MAX_SAFE_INTEGER - 1, 1, 0);
  assert.equal(bindingBudget({ limit: Number.MAX_SAFE_INTEGER, usage: huge, bindingId: 'a' }), 1);
  assert.equal(reserveSyncStorage({ limit: Number.MAX_SAFE_INTEGER, usage: huge, additionalBytes: 0 }), 0);
});

test('zero/invalid caps, byte counts, unknown snapshots, corrupt totals and unsafe integer sums fail closed', () => {
  const usage = usageOf();
  for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '150', 150n, null]) {
    assert.throws(() => bindingBudget({ limit, usage, bindingId: 'a' }), { code: 'SYNC_QUOTA' });
    assert.throws(() => reserveSyncStorage({ limit, usage, additionalBytes: 0 }), { code: 'SYNC_QUOTA' });
  }
  for (const additionalBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null, undefined]) {
    assert.throws(() => reserveSyncStorage({ usage, additionalBytes }), { code: 'SYNC_QUOTA' });
  }
  const corrupt = [
    null, {}, { ...usage, complete: false }, { ...usage, complete: undefined }, { ...usage, diagnostics: [{ code: 'SYNC_ROOT_CHANGED' }] },
    { ...usage, diagnostics: undefined }, { ...usage, bytes: 99 }, { ...usage, bytes: NaN }, { ...usage, stateBytes: -1 },
    { ...usage, byBinding: [{ id: 'a', bytes: 30 }, { id: 'A', bytes: 50 }] }, { ...usage, byBinding: [{ id: '../a', bytes: 80 }] },
    { ...usage, byBinding: [{ id: 'a', bytes: 79.5 }] }, { ...usage, bytes: Number.MAX_SAFE_INTEGER, stateBytes: Number.MAX_SAFE_INTEGER, byBinding: [{ id: 'a', bytes: 1 }] },
  ];
  for (const value of corrupt) {
    assert.throws(() => bindingBudget({ limit: Number.MAX_SAFE_INTEGER, usage: value, bindingId: 'a' }), { code: 'SYNC_QUOTA' });
    assert.throws(() => reserveSyncStorage({ limit: Number.MAX_SAFE_INTEGER, usage: value, additionalBytes: 0 }), { code: 'SYNC_QUOTA' });
  }
});
