import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSyncTree, probeSessionRevisions, MAX_PROBE_ENTRIES, MAX_PROBE_DEPTH } from '../src/sync-probe.mjs';

// Synthetic, uniquely owned fixtures only. These tests never read a native DSH
// profile, persisted event log, asset provider, or unrelated credentials.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(repo, '.test-tmp');
async function fixture(t) {
  await fs.mkdir(temporary, { recursive: true }); const base = await fs.mkdtemp(path.join(temporary, 'sync-probe-owned-'));
  const root = path.join(base, 'root'); await fs.mkdir(root);
  const owns = target => { const value = path.resolve(target); assert.equal(path.dirname(base), temporary); assert.ok(path.basename(base).startsWith('sync-probe-owned-')); assert.ok(value === base || value.startsWith(base + path.sep)); return value; };
  t.after(async () => { const target = owns(base); assert.equal(await fs.realpath(target), target); await fs.rm(target, { recursive: true, force: true }); });
  async function file(name, value = 'synthetic') { const filename = owns(path.join(root, ...name.split('/'))); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, value); return filename; }
  return { base, root, file, owns };
}
const probe = (f, options = {}) => probeSyncTree({ root: f.root, ...options });
const assertUnknown = value => { assert.equal(value.uncertain, true); assert.equal(value.fingerprint, null); };

test('unchanged portable trees have repeatable metadata hints, not file hashes', async t => {
  const f = await fixture(t); await f.file('a.txt'); await f.file('nested/b.txt', 'other');
  const a = await probe(f), b = await probe(f); assert.equal(a.uncertain, false); assert.deepEqual(a, b); assert.equal(a.files, 2);
  assert.match(a.fingerprint, /^[a-f0-9]{64}$/); assert.match(a.policyHash, /^[a-f0-9]{64}$/); assert.equal(a.rootIdentity.root, f.root);
  assert.deepEqual(Object.keys(a).sort(), ['files', 'fingerprint', 'policyHash', 'rootIdentity', 'uncertain']);
});

test('same-size byte changes with restored mtime still change the bigint ctime fingerprint', async t => {
  const f = await fixture(t), filename = await f.file('item.txt', 'AAAA'), date = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(filename, date, date); const before = await fs.lstat(filename, { bigint: true }), a = await probe(f);
  await fs.writeFile(filename, 'BBBB'); await fs.utimes(filename, date, date);
  const after = await fs.lstat(filename, { bigint: true }), b = await probe(f);
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs); assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.equal(b.uncertain, false); assert.notEqual(a.fingerprint, b.fingerprint);
});

test('creation, deletion and empty directory changes alter the hint', async t => {
  const f = await fixture(t), a = await probe(f); const filename = await f.file('created.txt'); const b = await probe(f);
  assert.equal(b.files, 1); assert.notEqual(a.fingerprint, b.fingerprint);
  const owned = f.owns(filename); assert.equal(owned, path.join(f.root, 'created.txt')); await fs.unlink(owned);
  const c = await probe(f); assert.equal(c.files, 0); assert.notEqual(b.fingerprint, c.fingerprint);
  await fs.mkdir(path.join(f.root, 'empty')); const d = await probe(f); assert.notEqual(c.fingerprint, d.fingerprint);
});

test('root replacement changes identity and an observed mid-probe swap is uncertain', async t => {
  const f = await fixture(t); await f.file('item.txt'); const a = await probe(f); let checks = 0, moved = false;
  const old = f.owns(path.join(f.base, 'old-root')), source = f.owns(f.root); assert.equal(source, path.join(f.base, 'root')); assert.equal(old, path.join(f.base, 'old-root'));
  const b = await probe(f, { async check() { if (++checks === 6) { await fs.rename(source, old); await fs.mkdir(source); moved = true; } } });
  assert.equal(moved, true); assertUnknown(b);
  const c = await probe(f); assert.equal(c.uncertain, false); assert.notDeepEqual(c.rootIdentity, a.rootIdentity); assert.notEqual(c.fingerprint, a.fingerprint);
});

test('current policy and literal state[1] exclusions are respected without reading excluded payloads', async t => {
  const f = await fixture(t); await f.file('state[1]/secret.txt', 'private'); const publicFile = await f.file('state1/public.txt', 'visible');
  const ignore = await f.file('.dsh-syncignore', 'ignored.txt\n'); await f.file('ignored.txt', 'excluded'); await f.file('visible.txt'); await f.file('.env', 'synthetic secret');
  const a = await probe(f, { excludedPaths: ['state[1]'] }); assert.equal(a.files, 2); assert.equal(a.uncertain, false);
  await fs.writeFile(path.join(f.root, 'state[1]', 'secret.txt'), 'private edit');
  const b = await probe(f, { excludedPaths: ['state[1]'] }); assert.equal(a.fingerprint, b.fingerprint);
  await fs.writeFile(publicFile, 'changed public file'); const c = await probe(f, { excludedPaths: ['state[1]'] }); assert.notEqual(b.fingerprint, c.fingerprint);
  await fs.writeFile(ignore, 'visible.txt\n'); const d = await probe(f, { excludedPaths: ['state[1]'] }); assert.notEqual(c.policyHash, d.policyHash); assert.notEqual(c.fingerprint, d.fingerprint);
});

test('policy changes during observation force uncertainty instead of caching stale exclusion authority', async t => {
  const f = await fixture(t); const ignore = await f.file('.dsh-syncignore', 'one.txt\n'); await f.file('one.txt'); await f.file('two.txt'); let checks = 0;
  const result = await probe(f, { async check() { if (++checks === 6) await fs.writeFile(ignore, 'two.txt\n'); } });
  assertUnknown(result); assert.equal((await probe(f)).files, 1);
});

test('payload files are never opened/read; only the bounded ignore policy may be read', async t => {
  const f = await fixture(t), ignore = await f.file('.dsh-syncignore', 'private/\n');
  await f.file('payload.txt', 'MUST-NOT-READ'); await f.file('private/data.txt', 'MUST-NOT-READ'); await f.file('nested/.dsh-syncignore', 'MUST-NOT-READ');
  const open = fs.open.bind(fs), observed = [];
  t.mock.method(fs, 'open', async (filename, ...args) => { assert.equal(path.resolve(filename), ignore); observed.push(filename); return open(filename, ...args); });
  t.mock.method(fs, 'readFile', () => assert.fail('probe must not readFile any project payload'));
  const result = await probe(f); assert.equal(result.uncertain, false); assert.equal(result.files, 1); assert.equal(observed.length, 2);
});

test('overlarge or unsafe ignore files produce an uncertain result without reading payload bytes', async t => {
  const f = await fixture(t); await f.file('.dsh-syncignore', 'x'.repeat(65 * 1024)); await f.file('payload.txt');
  assertUnknown(await probe(f));
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), '!unsafe-negation\n'); assertUnknown(await probe(f));
});

test('hardlinks are unknown rather than fingerprinted as ordinary managed files', async t => {
  const f = await fixture(t), filename = await f.file('ordinary.txt');
  try { await fs.link(filename, path.join(f.root, 'alias.txt')); }
  catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('synthetic hardlink creation unavailable in this sandbox'); return; } throw error; }
  assertUnknown(await probe(f));
});

test('directory symlinks/junctions are unknown and never traversed', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'not-selected'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'hidden.txt'), 'not selected');
  const link = path.join(f.root, 'redirect');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('synthetic link creation unavailable in this sandbox'); return; } throw error; }
  const opendir = fs.opendir.bind(fs);
  t.mock.method(fs, 'opendir', (directory, ...args) => { assert.notEqual(path.resolve(directory), link); assert.notEqual(path.resolve(directory), outside); return opendir(directory, ...args); });
  assertUnknown(await probe(f));
});

test('admission/cancellation failures stay errors with safe constant codes and no raw paths', async t => {
  const f = await fixture(t); await f.file('file.txt');
  await assert.rejects(probe(f, { check: async () => { throw Object.assign(new Error(`private: ${f.root}`), { code: 'ACCOUNT_MISMATCH' }); } }), error => error.code === 'ACCOUNT_MISMATCH' && error.message === 'ACCOUNT_MISMATCH');
  await assert.rejects(probe(f, { check: async () => { throw new Error(`private: ${f.root}`); } }), error => error.code === 'SYNC_PROBE_UNAVAILABLE' && !error.message.includes(f.root));
  const signal = AbortSignal.abort(new Error(`private: ${f.root}`)); await assert.rejects(probe(f, { signal }), { code: 'SYNC_CANCELLED' });
  const abort = new AbortController(); let calls = 0;
  await assert.rejects(probe(f, { signal: abort.signal, check: async () => { if (++calls === 8) abort.abort(); } }), { code: 'SYNC_CANCELLED' });
});

test('entry budget bounds even excluded names and closes the directory handle on refusal', async t => {
  const f = await fixture(t); let reads = 0, closed = 0;
  t.mock.method(fs, 'opendir', async directory => { assert.equal(directory, f.root); return { async read() { reads++; return { name: `.env.${reads}`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; }, async close() { closed++; } }; });
  const result = await probe(f); assertUnknown(result); assert.equal(result.files, 0); assert.equal(reads, MAX_PROBE_ENTRIES + 1); assert.equal(closed, 1);
});

test('depth and portable path limits conservatively force a full scan', async t => {
  const f = await fixture(t); let directory = f.root;
  for (let index = 0; index <= MAX_PROBE_DEPTH; index++) { directory = path.join(directory, 'x'); await fs.mkdir(directory); }
  assertUnknown(await probe(f));
  const g = await fixture(t); let emitted = false;
  t.mock.method(fs, 'opendir', async () => ({ async read() { if (emitted) return null; emitted = true; return { name: 'x'.repeat(256), isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; }, async close() {} }));
  assertUnknown(await probe(g));
});

test('unstable directory listings and missing bigint ctimeNs cannot yield a certain hint', async t => {
  const f = await fixture(t); await f.file('original.txt'); const opendir = fs.opendir.bind(fs); let changed = false;
  const mocked = t.mock.method(fs, 'opendir', async (directory, ...args) => {
    const handle = await opendir(directory, ...args);
    return { async read() { const entry = await handle.read(); if (!entry && !changed) { changed = true; await fs.writeFile(path.join(f.root, 'racer.txt'), 'created during enumeration'); } return entry; }, close: () => handle.close() };
  });
  assertUnknown(await probe(f)); assert.equal(changed, true); mocked.mock.restore();
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (filename, ...args) => { const value = await lstat(filename, ...args); if (path.basename(filename) === 'original.txt') { const incomplete = Object.create(value); incomplete.ctimeNs = undefined; return incomplete; } return value; });
  assertUnknown(await probe(f));
});

test('filesystem errors and absent roots do not expose paths or a comparable partial fingerprint', async t => {
  const f = await fixture(t);
  const result = await probeSyncTree({ root: path.join(f.root, 'private-missing-root') }); assertUnknown(result); assert.equal(result.rootIdentity, null); assert.equal(result.policyHash, null);
  t.mock.method(fs, 'opendir', async () => { throw new Error('DO-NOT-EXPOSE-PRIVATE-PATH'); });
  const failed = await probe(f); assertUnknown(failed); assert.ok(!JSON.stringify(failed).includes('DO-NOT-EXPOSE'));
});

function native(root, options = {}) {
  const row = { header: { version: 4, id: 'session-a', createdAt: 1000, cwd: root, isSeeded: false }, revision: 'revision-a', sizeBytes: 256 };
  const records = new Map([['session-a', row]]), live = options.live === false ? [] : [{ id: 'session-a', header: row.header, seq: 3 }], calls = [];
  for (const item of live) { Object.defineProperty(item, 'log', { get() { assert.fail('NO event/log access'); } }); Object.defineProperty(item, 'events', { get() { assert.fail('NO event/log access'); } }); }
  const idle = { status: 'idle', inbox: { hasPending: false }, whenIdle: async () => {} };
  const agent = options.agent === undefined ? idle : options.agent;
  const services = {
    sessionPersistence: {
      async list(value) { calls.push(['list', value]); await options.onList?.(records, calls); return structuredClone([...records.values()]); },
      async stat(id, value) { calls.push(['stat', id, value]); await options.onStat?.(records, calls); return structuredClone(records.get(id)); },
      open() { assert.fail('NO native open/events/assets'); }, flush() { assert.fail('NO native flush'); }, create() { assert.fail('NO native create'); },
    },
    sessions: { list: () => live, get: id => live.find(item => item.id === id), flush() { assert.fail('NO live flush'); }, create() { assert.fail('NO live creation'); } },
    agents: { get: id => id === 'session-a' ? agent : undefined, create() { assert.fail('NO agent start'); }, resume() { assert.fail('NO agent resume'); } },
  };
  const ctx = { get(name) { assert.notEqual(name, 'attachments'); return services[name]; }, async waterfall(event, payload, next) { assert.equal(event, 'workspace/session-activity'); assert.equal(payload.sessionId, 'session-a'); return options.activity === undefined ? next() : options.activity; } };
  return { ctx, services, records, row, live, calls, agent };
}

test('native revision probes are stable list/stat metadata-only hints including live seq and full header', async t => {
  const f = await fixture(t), n = native(f.root);
  const a = await probeSessionRevisions(n.ctx, f.root), b = await probeSessionRevisions(n.ctx, f.root); assert.equal(a.uncertain, false); assert.deepEqual(a, b);
  assert.equal(n.calls.filter(call => call[0] === 'stat').length, 4); assert.equal(n.calls.filter(call => call[0] === 'list').length, 4);
  n.row.revision = 'revision-b'; const c = await probeSessionRevisions(n.ctx, f.root); assert.equal(c.uncertain, false); assert.notEqual(c.fingerprint, b.fingerprint);
  n.live[0].seq++; const d = await probeSessionRevisions(n.ctx, f.root); assert.equal(d.uncertain, false); assert.notEqual(c.fingerprint, d.fingerprint);
  n.row.header.agentPreset = 'different-header'; const e = await probeSessionRevisions(n.ctx, f.root); assert.notEqual(d.fingerprint, e.fingerprint);
});

test('native probes ignore other admitted roots and perform no filesystem content reads', async t => {
  const f = await fixture(t), n = native(f.root); n.records.set('other-session', { header: { ...n.row.header, id: 'other-session', cwd: path.join(f.base, 'other-root') }, revision: 'foreign', sizeBytes: 100 });
  t.mock.method(fs, 'open', () => assert.fail('NO payload/ignore/event content reads in native metadata probe'));
  t.mock.method(fs, 'readFile', () => assert.fail('NO payload content reads'));
  const result = await probeSessionRevisions(n.ctx, f.root); assert.equal(result.uncertain, false); assert.ok(n.calls.filter(call => call[0] === 'stat').every(call => call[1] === 'session-a'));
});

test('native running/maintenance/pending/unknown activity never yields a certain fingerprint', async t => {
  const f = await fixture(t);
  for (const options of [
    { agent: { status: 'running' } },
    { agent: { status: 'idle', inbox: { hasPending: false }, whenIdle: () => new Promise(() => {}) } },
    { agent: { status: 'idle', inbox: { hasPending: true }, whenIdle: async () => {} } },
    { agent: { status: 'idle', inbox: { hasPending: false } } },
    { activity: [{ kind: 'job' }] }, { activity: {} },
  ]) assertUnknown(await probeSessionRevisions(native(f.root, options).ctx, f.root));
});

test('missing native capabilities, provider errors, unmaterialized sessions and metadata races are uncertain', async t => {
  const f = await fixture(t); assertUnknown(await probeSessionRevisions({}, f.root));
  const absent = native(f.root); delete absent.services.sessionPersistence.stat; assertUnknown(await probeSessionRevisions(absent.ctx, f.root));
  const broken = native(f.root); broken.services.sessionPersistence.list = async () => { throw new Error('PRIVATE-PROVIDER-PATH'); };
  const failure = await probeSessionRevisions(broken.ctx, f.root); assertUnknown(failure); assert.ok(!JSON.stringify(failure).includes('PRIVATE'));
  const pending = native(f.root); delete pending.row.sizeBytes; assertUnknown(await probeSessionRevisions(pending.ctx, f.root));
  const racer = native(f.root, { onStat(records) { records.get('session-a').revision += '-raced'; } }); assertUnknown(await probeSessionRevisions(racer.ctx, f.root));
  const dynamic = native(f.root, { onList(_records, calls) { if (calls.filter(call => call[0] === 'list').length === 2) dynamic.live[0].seq++; } }); assertUnknown(await probeSessionRevisions(dynamic.ctx, f.root));
});

test('native probe guards/cancellation propagate safe errors without invoking mutation APIs', async t => {
  const f = await fixture(t), n = native(f.root);
  await assert.rejects(probeSessionRevisions(n.ctx, f.root, { check: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'ACCOUNT_MISMATCH' }); } }), { code: 'ACCOUNT_MISMATCH', message: 'ACCOUNT_MISMATCH' });
  await assert.rejects(probeSessionRevisions(n.ctx, f.root, { signal: AbortSignal.abort() }), { code: 'SYNC_CANCELLED' });
  assert.equal(n.calls.length, 0);
});
