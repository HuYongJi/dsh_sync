import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '../src/local-store.mjs';
import { createExclusionPolicy, readExclusionPolicy } from '../src/snapshot.mjs';
import { sha256, validateManifest } from '../src/protocol.mjs';
import { SyncClient } from '../src/client.mjs';
import { createController } from '../plugin/controller.mjs';

const base = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
const deviceId = 'legacy-fixture-device', projectId = 'legacy-fixture-project';
const ack = manifest => ({ id: manifest.id, conflict: false, heads: [manifest.id] });
async function fixture(t, { insideState = false } = {}) {
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'legacy-reliability-'));
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  const store = await new LocalStore(path.join(insideState ? root : directory, 'state[1]')).init();
  const servers = [], controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.stop();
    await Promise.all(controllers.map(controller => controller.drain()));
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    // Verify the exact resolved fixture before recursive cleanup; never real profiles.
    assert.equal(path.dirname(directory), base);
    assert.ok(path.basename(directory).startsWith('legacy-reliability-'));
    assert.equal(await fs.realpath(directory), directory);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function loopback(handler) {
    const requests = [];
    const server = http.createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks), entry = { method: request.method, url: request.url, bytes };
        requests.push(entry);
        if (handler && await handler(entry, response) === true) return;
        response.setHeader('content-type', 'application/json');
        if (request.method === 'PUT') response.end('{}');
        else if (request.method === 'POST' && request.url === '/v1/checkpoints') response.end(JSON.stringify({ ...ack(JSON.parse(bytes)), ignoredRemoteSecret: 'REMOTE-EXTRA-MUST-NOT-ESCAPE' }));
        else { response.statusCode = 404; response.end('{}'); }
      } catch { response.destroy(); }
    });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server: `http://127.0.0.1:${server.address().port}`, requests };
  }
  async function controller(server, exportSessions = async () => ({ sessions: [], assets: [], skipped: [] })) {
    let record = { kind: 'grant', payload: { server, username: 'fixture-owner', deviceId, token: 's'.repeat(43), expiresAt: '2100-01-01T00:00:00.000Z' } };
    const value = createController({ credentials: { readRecord: async () => record } }, { server, username: 'fixture-owner', stateDir: store.directory, projects: [{ id: projectId, root }] }, { exportSessions, allowLegacyCli: false });
    await value.store.saveConfig({ server, username: record.payload.username, deviceId }); controllers.push(value);
    return { value, replaceGrant: patch => { record = { ...record, payload: { ...record.payload, ...patch } }; } };
  }
  return { directory, root, store, loopback, controller };
}
async function capture(f, contents) {
  await fs.writeFile(path.join(f.root, 'a.txt'), contents);
  return f.store.capture({ root: f.root, projectId, deviceId });
}
const filename = (store, id) => path.join(store.directory, 'pending', `${id}.json`);
async function savedQueue(store) {
  return Promise.all((await store.pending()).map(async item => [item.id, await fs.readFile(filename(store, item.id), 'utf8')]));
}
async function caught(promise) {
  let failure; await assert.rejects(promise, error => { failure = error; return true; }); return failure;
}
async function syntheticQueue(store, root, { id, project = projectId, parentId = null, files = [] }) {
  const entries = [];
  for (const [name, contents] of files) {
    const bytes = Buffer.from(contents), hash = sha256(bytes); await store.putBlob(hash, bytes);
    entries.push({ path: `project/${name}`, sha256: hash, size: bytes.length });
  }
  const manifest = validateManifest({ version: 1, id, projectId: project, deviceId, parentId, createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: root, sessionIds: [], files: entries });
  await fs.writeFile(filename(store, id), JSON.stringify(manifest), { flag: 'wx' });
  return manifest;
}

test('legacy shared exclusion policy keeps literal names distinct from globs and fingerprints effective changes', async t => {
  const f = await fixture(t);
  const policy = createExclusionPolicy({ excluded: ['cache/', 'pruned', 'logs/*.log'], excludedPaths: ['Private[1]'] });
  assert.equal(Object.isFrozen(policy), true);
  for (const relative of ['private[1]/secret.txt', 'PRIVATE[1]/deeper/private', 'cache/any.txt', 'pruned/nested/item.txt', 'logs/a.log', '.env', 'foo/.ssh/key']) assert.equal(policy.isExcluded(relative), true, relative);
  for (const relative of ['private1/visible.txt', 'private[1]-other/a', 'logs/a.txt']) assert.equal(policy.isExcluded(relative), false, relative);
  assert.equal(policy.fingerprint, createExclusionPolicy({ excluded: ['logs/*.log', 'cache/**', 'pruned', 'pruned'], excludedPaths: ['private[1]'] }).fingerprint);
  const ignore = path.join(f.root, '.dsh-syncignore'); await fs.writeFile(ignore, 'alpha/**\n');
  const before = await readExclusionPolicy(f.root), stat = await fs.stat(ignore);
  await fs.writeFile(ignore, 'bravo/**\n'); await fs.utimes(ignore, stat.atime, stat.mtime);
  const after = await readExclusionPolicy(f.root);
  assert.notEqual(before.fingerprint, after.fingerprint, 'same-size policy changes cannot reuse a timestamp cache');
  assert.equal(after.isExcluded('bravo/private.txt'), true); assert.equal(after.isExcluded('alpha/public.txt'), false);
  await fs.writeFile(ignore, '!not-supported\n'); await assert.rejects(readExclusionPolicy(f.root), /relative exclusion globs/);
});

test('legacy flush prevalidates a forbidden later checkpoint before even reading the first blob', async t => {
  const f = await fixture(t); await capture(f, 'one');
  await fs.mkdir(path.join(f.root, 'pruned')); await fs.writeFile(path.join(f.root, 'pruned', 'private.txt'), 'do-not-send');
  await capture(f, 'two'); const before = await savedQueue(f.store);
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'pruned\n');
  let reads = 0, uploads = 0, commits = 0;
  t.mock.method(f.store, 'getBlob', async () => { reads++; assert.fail('must validate the whole queue first'); });
  const error = await caught(f.store.flush({ uploadBlob: async () => uploads++, commit: async () => commits++ }));
  assert.equal(error.code, 'PROTECTED_QUEUE'); assert.deepEqual(error.results, []); assert.deepEqual(error.outcomes, []);
  assert.deepEqual([reads, uploads, commits], [0, 0, 0]); assert.deepEqual(await savedQueue(f.store), before);
});

for (const boundary of ['beforeUpload', 'afterUpload', 'beforeCommit']) {
  test(`legacy current ignore changes at ${boundary} block the next send or commit without rewriting the queue`, async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.root, 'z-private.txt'), 'forbidden-next');
    await capture(f, 'safe-first'); const before = await savedQueue(f.store);
    const writes = [], commits = [], options = {}, restrict = () => fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'z-private.txt\n');
    if (boundary !== 'afterUpload') options[boundary] = restrict;
    const error = await caught(f.store.flush({
      uploadBlob: async (hash, bytes) => { writes.push([hash, bytes.toString()]); if (boundary === 'afterUpload') await restrict(); },
      commit: async manifest => { commits.push(manifest.id); return ack(manifest); },
    }, projectId, options));
    assert.equal(error.code, 'PROTECTED_QUEUE'); assert.deepEqual(commits, []); assert.deepEqual(error.results, []);
    assert.equal(writes.length, boundary === 'beforeUpload' ? 0 : boundary === 'afterUpload' ? 1 : 2);
    if (boundary !== 'beforeCommit') assert.ok(writes.every(([, bytes]) => bytes !== 'forbidden-next'));
    assert.deepEqual(await savedQueue(f.store), before);
  });
}

test('legacy policy invalidation scans the entire queue again before committing a safe earlier manifest', async t => {
  const f = await fixture(t); await capture(f, 'safe-first');
  await fs.writeFile(path.join(f.root, 'z-private.txt'), 'later-only-private'); await capture(f, 'safe-second');
  const before = await savedQueue(f.store), writes = [], commits = [];
  const error = await caught(f.store.flush({
    uploadBlob: async (hash, bytes) => { writes.push(bytes.toString()); await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'z-private.txt\n'); },
    commit: async manifest => { commits.push(manifest.id); return ack(manifest); },
  }));
  assert.equal(error.code, 'PROTECTED_QUEUE'); assert.deepEqual(writes, ['safe-first']); assert.deepEqual(commits, []);
  assert.deepEqual(await savedQueue(f.store), before);
});

test('legacy policy change after a confirmed commit preserves its outcome and blocks a later forbidden blob', async t => {
  const f = await fixture(t), first = await capture(f, 'one');
  await fs.writeFile(path.join(f.root, 'z-private.txt'), 'later-private'); const second = await capture(f, 'two');
  const secondBytes = await fs.readFile(filename(f.store, second.queuedId), 'utf8'), writes = [];
  const error = await caught(f.store.flush({
    uploadBlob: async (_hash, bytes) => writes.push(bytes.toString()),
    commit: async manifest => { await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'z-private.txt\n'); return { ...ack(manifest), secret: 'never-project-ack-extensions' }; },
  }));
  assert.equal(error.code, 'PROTECTED_QUEUE'); assert.deepEqual(error.results, [ack(first.manifest)]);
  assert.deepEqual(error.outcomes.map(item => item.status), ['committed', 'pending']); assert.deepEqual(writes, ['one']);
  assert.equal(await fs.readFile(filename(f.store, second.queuedId), 'utf8'), secondBytes);
  assert.deepEqual((await f.store.pending()).map(item => item.id), [second.queuedId]);
});

test('legacy dynamic Host literal exclusions invalidate validation before each network boundary', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'host[1]')); await fs.writeFile(path.join(f.root, 'host[1]', 'private.txt'), 'host-private');
  await capture(f, 'safe'); let protectedPaths = [], sends = 0;
  const before = await savedQueue(f.store);
  const error = await caught(f.store.flush({ uploadBlob: async () => { sends++; protectedPaths = ['host[1]']; }, commit: async () => assert.fail('cannot commit protected host bytes') }, projectId, { getExcludedPaths: async () => protectedPaths }));
  assert.equal(error.code, 'PROTECTED_QUEUE'); assert.equal(sends, 1); assert.deepEqual(await savedQueue(f.store), before);
});

test('internal legacy retry checks current ignore policies for all queued projects before any request', async t => {
  const f = await fixture(t), cloud = await f.loopback();
  const other = path.join(f.directory, 'other'); await fs.mkdir(other);
  await syntheticQueue(f.store, f.root, { id: 'queue-a', files: [['public.txt', 'safe']] });
  await syntheticQueue(f.store, other, { id: 'queue-b', project: 'other-project', files: [['private.txt', 'forbidden']] });
  await fs.writeFile(path.join(other, '.dsh-syncignore'), 'private.txt\n');
  await f.store.saveConfig({ server: cloud.server, token: 's'.repeat(43), deviceId });
  const before = await savedQueue(f.store);
  const error = await caught(f.store.flush(new SyncClient(await f.store.config())));
  assert.equal(error.code, 'PROTECTED_QUEUE'); assert.deepEqual(cloud.requests, []); assert.deepEqual(await savedQueue(f.store), before);
  assert.deepEqual(error.results, []); assert.ok(!JSON.stringify(error.results).includes('forbidden'));
});

test('internal legacy retry cannot upload state directories whose names contain glob syntax', async t => {
  const f = await fixture(t, { insideState: true }), cloud = await f.loopback();
  await syntheticQueue(f.store, f.root, { id: 'legacy-state-queue', files: [['public.txt', 'safe'], ['state[1]/private.txt', 'STATE-MUST-NOT-SEND']] });
  await f.store.saveConfig({ server: cloud.server, token: 's'.repeat(43), deviceId });
  const before = await savedQueue(f.store);
  await assert.rejects(f.store.flush(new SyncClient(await f.store.config()), projectId), { code: 'PROTECTED_QUEUE' });
  assert.deepEqual(cloud.requests, []); assert.deepEqual(await savedQueue(f.store), before);
});

test('internal legacy retry rereads ignore policy during loopback upload instead of trusting its initial scan', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'z-private.txt'), 'must-stay-local'); await capture(f, 'safe');
  const cloud = await f.loopback(async entry => {
    if (entry.method === 'PUT') await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'z-private.txt\n');
  });
  await f.store.saveConfig({ server: cloud.server, token: 's'.repeat(43), deviceId });
  const before = await savedQueue(f.store);
  const error = await caught(f.store.flush(new SyncClient(await f.store.config()))); assert.equal(error.code, 'PROTECTED_QUEUE');
  assert.equal(cloud.requests.length, 1); assert.equal(cloud.requests[0].bytes.toString(), 'safe');
  assert.deepEqual(error.results, []); assert.deepEqual(await savedQueue(f.store), before);
});

test('legacy flush reports earlier commits when a later upload fails', async t => {
  const f = await fixture(t), first = await capture(f, 'one'), second = await capture(f, 'two');
  const error = await caught(f.store.flush({ uploadBlob: async (_hash, bytes) => { if (bytes.toString() === 'two') throw new Error('offline fixture'); }, commit: async manifest => ({ ...ack(manifest), ignored: 'sensitive-extra' }) }));
  assert.match(error.message, /offline fixture/); assert.deepEqual(error.results, [ack(first.manifest)]);
  assert.deepEqual(error.outcomes, [
    { id: first.queuedId, projectId, status: 'committed', phase: 'complete' },
    { id: second.queuedId, projectId, status: 'pending', phase: 'upload' },
  ]);
  assert.deepEqual((await f.store.pending()).map(item => item.id), [second.queuedId]); assert.equal((await f.store.state()).projects[projectId].head, first.queuedId);
});

for (const stage of ['saveState', 'unlink']) {
  test(`legacy confirmed commit survives a ${stage} local-finalization failure in structured results`, async t => {
    const f = await fixture(t), first = await capture(f, 'one'), second = await capture(f, 'two');
    if (stage === 'saveState') {
      const save = f.store.saveState.bind(f.store);
      t.mock.method(f.store, 'saveState', async state => { if (state.projects[projectId].head === second.queuedId) throw new Error('disk full fixture'); return save(state); });
    } else {
      const unlink = fs.unlink;
      t.mock.method(fs, 'unlink', async target => { if (target === filename(f.store, second.queuedId)) throw new Error('pending cleanup fixture'); return unlink(target); });
    }
    const before = await fs.readFile(filename(f.store, second.queuedId), 'utf8');
    const error = await caught(f.store.flush({ uploadBlob: async () => {}, commit: async manifest => ack(manifest) }));
    assert.deepEqual(error.results, [ack(first.manifest), ack(second.manifest)]);
    assert.deepEqual(error.outcomes.map(item => item.status), ['committed', 'local-finalization-failed']); assert.equal(error.outcomes[1].phase, 'finalize');
    assert.equal(await fs.readFile(filename(f.store, second.queuedId), 'utf8'), before);
    t.mock.restoreAll();
    const retried = await f.store.flush({ uploadBlob: async () => {}, commit: async manifest => ack(manifest) });
    assert.deepEqual(retried, [ack(second.manifest)]); assert.deepEqual(await f.store.pending(), []);
  });
}

for (const rejection of ['uncertain', 'definitive', 'malformed-ack']) {
  test(`legacy ${rejection} commit distinguishes remote uncertainty from confirmed earlier commits`, async t => {
    const f = await fixture(t), first = await capture(f, 'one'), second = await capture(f, 'two');
    const error = await caught(f.store.flush({ uploadBlob: async () => {}, commit: async manifest => {
      if (manifest.id === first.queuedId) return ack(manifest);
      if (rejection === 'malformed-ack') return { id: 'wrong', conflict: false, heads: [] };
      throw Object.assign(new Error('fixture commit failure'), rejection === 'definitive' ? { httpStatus: 403 } : { status: 400 });
    } }));
    assert.deepEqual(error.results, [ack(first.manifest)]);
    assert.deepEqual(error.outcomes.map(item => item.status), ['committed', rejection === 'definitive' ? 'rejected' : 'commit-uncertain']);
    assert.equal(error.outcomes[1].id, second.queuedId); assert.equal(error.outcomes[1].phase, 'commit');
    assert.deepEqual((await f.store.pending()).map(item => item.id), [second.queuedId]);
  });
}

test('internal legacy loopback retry retains confirmed IDs and uncertainty without remote acknowledgement extras', async t => {
  const f = await fixture(t), first = await capture(f, 'one'), second = await capture(f, 'two');
  const cloud = await f.loopback(async (entry, response) => {
    if (entry.method === 'POST' && JSON.parse(entry.bytes).id === second.queuedId) { response.destroy(); return true; }
  });
  await f.store.saveConfig({ server: cloud.server, token: 's'.repeat(43), deviceId });
  const error = await caught(f.store.flush(new SyncClient(await f.store.config())));
  assert.deepEqual(error.results, [ack(first.manifest)]); assert.equal(error.outcomes[1].status, 'commit-uncertain');
  const publicOutcome = JSON.stringify({ results: error.results, outcomes: error.outcomes });
  assert.ok(!publicOutcome.includes('REMOTE-EXTRA')); assert.ok(!publicOutcome.includes('s'.repeat(43)));
});

test('legacy offline controller ticks capture each current idle checkpoint before a failed network flush', async t => {
  const f = await fixture(t), cloud = await f.loopback(async (_entry, response) => { response.destroy(); return true; });
  let verified = 0;
  const { value: controller } = await f.controller(cloud.server, async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => verified++ }));
  await fs.writeFile(path.join(f.root, 'a.txt'), 'first-offline'); await controller.tick();
  const [first] = await f.store.pending(), immutable = await fs.readFile(filename(f.store, first.id), 'utf8');
  await fs.writeFile(path.join(f.root, 'a.txt'), 'latest-offline'); const secondTick = await controller.tick();
  const pending = await f.store.pending(); assert.equal(pending.length, 2); assert.equal(pending[1].parentId, first.id);
  assert.equal((await f.store.getBlob(pending[1].files[0].sha256)).toString(), 'latest-offline');
  assert.equal(await fs.readFile(filename(f.store, first.id), 'utf8'), immutable);
  assert.equal(secondTick.results[0].checkpointId, pending[1].id); assert.equal(secondTick.results[0].outcomes[0].status, 'pending');
  await controller.tick(); assert.equal((await f.store.pending()).length, 2); assert.equal(verified, 3);
});

test('legacy active native sessions defer capture but may flush a previously valid immutable queue', async t => {
  const f = await fixture(t), old = await capture(f, 'old-idle'), cloud = await f.loopback();
  const { value: controller } = await f.controller(cloud.server, async () => ({ sessions: [], assets: [], skipped: [{ id: 'active-session', reason: 'active' }] }));
  await fs.writeFile(path.join(f.root, 'a.txt'), 'current-active');
  t.mock.method(controller.store, 'capture', async () => assert.fail('cannot capture active sessions'));
  const result = await controller.push(projectId);
  assert.equal(result.deferred, true); assert.deepEqual(result.retried, [ack(old.manifest)]); assert.deepEqual(await f.store.pending(), []);
  assert.ok(cloud.requests.filter(item => item.method === 'PUT').every(item => item.bytes.toString() === 'old-idle'));
});

test('legacy controller refuses a protected later checkpoint without adding or rewriting queue entries', async t => {
  const f = await fixture(t); await capture(f, 'first'); await fs.writeFile(path.join(f.root, 'private.txt'), 'legacy-private'); await capture(f, 'second');
  const cloud = await f.loopback(), { value: controller } = await f.controller(cloud.server);
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), 'private.txt\n'); const before = await savedQueue(f.store);
  await assert.rejects(controller.push(projectId), { code: 'PROTECTED_QUEUE' });
  assert.deepEqual(cloud.requests, []); assert.deepEqual(await savedQueue(f.store), before);
});

test('legacy controller tick and status preserve earlier confirmed and later uncertain commit outcomes safely', async t => {
  const f = await fixture(t), first = await capture(f, 'one'), second = await capture(f, 'two');
  const cloud = await f.loopback(async (entry, response) => {
    if (entry.method === 'POST' && JSON.parse(entry.bytes).id === second.queuedId) { response.destroy(); return true; }
  });
  const { value: controller } = await f.controller(cloud.server);
  const tick = await controller.tick(), status = await controller.status(), report = tick.results[0];
  assert.deepEqual(report.uploaded, [ack(first.manifest)]); assert.equal(report.outcomes[1].status, 'commit-uncertain');
  assert.deepEqual(status.lastResult.results[0], report); assert.equal(report.checkpointId, second.queuedId);
  assert.ok(!JSON.stringify(status.lastResult).includes('REMOTE-EXTRA')); assert.ok(!JSON.stringify(status.lastResult).includes('s'.repeat(43)));
});

test('legacy absent source roots and invalid current ignore rules fail closed before upload', async t => {
  const f = await fixture(t); await capture(f, 'local-only');
  await fs.writeFile(path.join(f.root, '.dsh-syncignore'), '!unsupported\n');
  let sends = 0; const client = { uploadBlob: async () => sends++, commit: async () => assert.fail('no commit') };
  const before = await savedQueue(f.store);
  await assert.rejects(f.store.flush(client), /relative exclusion globs/);
  assert.equal(sends, 0); assert.deepEqual(await savedQueue(f.store), before);
  const missingRoot = path.join(f.directory, 'not-created');
  await syntheticQueue(f.store, missingRoot, { id: 'missing-root-checkpoint', project: 'missing-root-project', files: [['public.txt', 'not-currently-authorized']] });
  await assert.rejects(f.store.flush(client, 'missing-root-project'), { code: 'ENOENT' }); assert.equal(sends, 0);
});

test('legacy send hooks cannot rewrite the in-memory immutable manifest after validation', async t => {
  const f = await fixture(t); await capture(f, 'safe'); const before = await savedQueue(f.store);
  await assert.rejects(f.store.flush({ uploadBlob: async () => assert.fail('never send a mutated manifest') }, projectId, {
    beforeUpload: async manifest => { manifest.files[0].path = 'project/new-path'; },
  }), { name: 'TypeError' });
  assert.deepEqual(await savedQueue(f.store), before);
});

test('legacy full offline queue can flush before recapturing without losing its latest idle state', async t => {
  const f = await fixture(t), cloud = await f.loopback();
  let parentId = null;
  for (let i = 0; i < 100; i++) {
    const manifest = await syntheticQueue(f.store, f.root, { id: `full-queue-${i}`, parentId }); parentId = manifest.id;
  }
  await fs.writeFile(path.join(f.root, 'a.txt'), 'latest-after-capacity');
  await assert.rejects(f.store.capture({ root: f.root, projectId, deviceId }), { code: 'QUEUE_FULL' });
  assert.deepEqual(await fs.readdir(path.join(f.store.directory, 'blobs')), [], 'a full queue must not accumulate orphan capture bytes');
  const { value: controller } = await f.controller(cloud.server), result = await controller.push(projectId);
  assert.equal(result.uploaded.length, 101); assert.deepEqual(await f.store.pending(), []);
  const commits = cloud.requests.filter(item => item.method === 'POST').map(item => JSON.parse(item.bytes));
  assert.equal(commits.length, 101); assert.equal(commits.at(-1).parentId, parentId);
  assert.equal(commits.at(-1).files[0].sha256, sha256('latest-after-capacity'));
});

test('legacy controller credential revalidation still prevents a send after native grant changes', async t => {
  const f = await fixture(t), cloud = await f.loopback(); await fs.writeFile(path.join(f.root, 'a.txt'), 'safe');
  let change;
  const { value: controller, replaceGrant } = await f.controller(cloud.server, async () => ({ sessions: [], assets: [], skipped: [], verifyUnchanged: async () => change() }));
  change = () => replaceGrant({ token: 'n'.repeat(43) });
  const error = await caught(controller.push(projectId));
  assert.equal(error.code, 'ACCOUNT_MISMATCH'); assert.deepEqual(cloud.requests, []); assert.equal((await f.store.pending()).length, 1);
});
