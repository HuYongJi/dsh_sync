import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncV2Client } from '../src/sync-client.mjs';
import { sha256 } from '../src/protocol.mjs';
import { syncManifestDigest } from '../src/sync-protocol.mjs';

const entry = revision => ({ projectId: 'project', id: `checkpoint-${revision}`, revision, manifestDigest: sha256(`manifest-${revision}`), recordHash: sha256(`record-${revision}`), requestId: `request-${revision}`, parentId: revision === 1 ? null : `checkpoint-${revision - 1}`, deviceId: 'device', policyRevision: 1, migration: null });

test('10,001 simulated committed metadata entries paginate at a fixed endpoint while later commits arrive', async t => {
  // This isolates the client cursor/validation scale, not 10,001 physical server
  // commits. Real HTTP/store proof is covered separately by v2-store/http tests.
  const rows = Array.from({ length: 10_001 }, (_, index) => entry(index + 1)), calls = [];
  let current = rows.length;
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url), after = Number(parsed.searchParams.get('afterRevision')), limit = Number(parsed.searchParams.get('limit'));
    assert.equal(parsed.pathname, '/v2/projects/project/changes'); assert.ok(limit <= 200);
    const until = parsed.searchParams.has('untilRevision') ? Number(parsed.searchParams.get('untilRevision')) : current;
    calls.push({ after, until, limit });
    const changes = rows.slice(after, Math.min(until, after + limit)).map(item => ({ ...item, token: 'never-retain', password: 'never-retain' }));
    if (calls.length === 1) { rows.push(entry(++current), entry(++current)); }
    return Response.json({ changes, untilRevision: until, nextAfterRevision: after + changes.length < until ? after + changes.length : null, refreshToken: 'never-retain' });
  });
  const client = new SyncV2Client({ server: 'https://synthetic.invalid', token: 'a'.repeat(43) }), seen = [];
  let afterRevision = 0, untilRevision;
  do {
    const page = await client.syncChanges('project', { afterRevision, untilRevision, limit: 200 });
    untilRevision = page.untilRevision; seen.push(...page.changes); afterRevision = page.nextAfterRevision;
  } while (afterRevision !== null);
  assert.equal(seen.length, 10_001); assert.equal(seen.at(-1).revision, 10_001); assert.equal(calls.length, 51);
  assert.equal(new Set(seen.map(item => item.id)).size, 10_001); assert.ok(calls.every(item => item.until === 10_001));
  assert.equal(JSON.stringify(seen).includes('never-retain'), false);
});

test('latest canonical content reads only head and checkpoint beyond the legacy 10,000 history ceiling', async t => {
  const manifest = { version: 2, id: 'checkpoint-10001', projectId: 'project', deviceId: 'device', parentId: 'checkpoint-10000', policyRevision: 1, files: [], tombstones: [], conflicts: [], archiveRefs: [], label: 'Synthetic' };
  const committed = { ...entry(10_001), manifestDigest: syncManifestDigest(manifest) }, calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const route = new URL(url).pathname; calls.push(route);
    if (route.endsWith('/head')) return Response.json({ head: committed });
    assert.equal(route, '/v2/projects/project/checkpoints/checkpoint-10001'); return Response.json(manifest);
  });
  const client = new SyncV2Client({ server: 'https://synthetic.invalid', token: 'a'.repeat(43) }), head = await client.syncHead('project');
  assert.deepEqual(await client.syncCheckpoint('project', head.id, head.manifestDigest), manifest);
  assert.equal(calls.length, 2); assert.ok(calls.every(route => !route.includes('/changes') && !route.includes('/v1/')));
});

test('history pages reject gaps, foreign projects, malformed parents and cursor expansion', async t => {
  const client = new SyncV2Client({ server: 'https://synthetic.invalid', token: 'a'.repeat(43) });
  const good = { changes: [entry(1), entry(2)], untilRevision: 2, nextAfterRevision: null };
  for (const bad of [
    { ...good, changes: [entry(1)] },
    { ...good, changes: [entry(1), entry(3)] },
    { ...good, changes: [entry(1), { ...entry(2), projectId: 'foreign' }] },
    { ...good, changes: [entry(1), { ...entry(2), parentId: 'unrelated' }] },
    { ...good, nextAfterRevision: 2 },
    { ...good, untilRevision: 3 },
  ]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json(bad));
    await assert.rejects(client.syncChanges('project', { afterRevision: 0, untilRevision: 2, limit: 2 })); mocked.mock.restore();
  }
  await assert.rejects(client.syncChanges('project', { limit: 201 }));
  await assert.rejects(client.syncChanges('project', { afterRevision: -1 }));
});
