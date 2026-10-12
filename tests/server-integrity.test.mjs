import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer, closeSyncServer } from '../server/index.mjs';
import { SyncClient } from '../src/client.mjs';
import { sha256 } from '../src/protocol.mjs';

const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'integrity-'));
  const server = await createSyncServer({ dataDir: directory, username: 'owner', password: 'synthetic-integrity-only' });
  t.after(async () => {
    await closeSyncServer(server);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(base));
    assert.match(path.basename(directory), /^integrity-[A-Za-z0-9]+$/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new SyncClient({ server: `http://127.0.0.1:${server.address().port}` });
  await client.login({ username: 'owner', password: 'synthetic-integrity-only', deviceId: 'fixture-device' });
  const manifest = (id, files = [], extra = {}) => ({ version: 1, id, projectId: id, deviceId: 'fixture-device', parentId: null,
    createdAt: '2025-01-01T00:00:00.000Z', sourceRoot: '/synthetic-project', sessionIds: [], files, ...extra });
  return { directory, client, manifest };
}

test('same-size corrupted stored blobs cannot acknowledge upload or checkpoint success', async t => {
  const { directory, client, manifest } = await fixture(t);
  const bytes = Buffer.from('good'), hash = sha256(bytes);
  await client.uploadBlob(hash, bytes);
  const target = path.join(directory, 'blobs', hash);
  await fs.writeFile(target, Buffer.from('evil'));
  await assert.rejects(client.uploadBlob(hash, bytes), { httpStatus: 409 });
  await assert.rejects(client.commit(manifest('corrupt', [{ path: 'project/file.txt', sha256: hash, size: bytes.length }])), { httpStatus: 409 });
  assert.equal((await client.list('corrupt')).checkpoints.length, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'evil', 'immutable object must not be silently repaired/replaced');
});

test('new checkpoint roots must be displayable and a corrupt project does not hide healthy projects', async t => {
  const { directory, client, manifest } = await fixture(t);
  for (const sourceRoot of ['\\root-relative', '/bad\u007f', '/bad\ud800']) {
    await assert.rejects(client.commit(manifest('invalid', [], { sourceRoot })), { httpStatus: 400 });
  }
  await client.commit(manifest('healthy'));
  await client.commit(manifest('broken'));
  await fs.writeFile(path.join(directory, 'checkpoints', `${sha256(Buffer.from('broken'))}.json`), '{}');
  const listing = await client.projects();
  assert.equal(listing.partial, true);
  assert.deepEqual(listing.projects.map(item => item.projectId), ['healthy']);
  await assert.rejects(client.getCheckpoint('broken'), { httpStatus: 500 });
});
