import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, ensurePrivateDirectory, readJson, assertNoSymlinks, readStableFile, writeNewFile } from './files.mjs';
import { assert, sha256, validateBlobHash, validateId, validateManifest, MAX_MANIFEST_BYTES } from './protocol.mjs';
import { captureCheckpoint, contentFingerprint, readExclusionPolicy, restoreCheckpoint } from './snapshot.mjs';

function stateExclusions(root, directory, excludedPaths = []) {
  const relative = path.relative(path.resolve(root), directory);
  assert(relative !== '', 'Project root cannot be the sync state directory');
  return [...excludedPaths, ...(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : [])];
}

async function validateQueue(store, client, pending, { root, deviceId, excluded = [], excludedPaths = [], getExcludedPaths } = {}, validated = new Map()) {
  const config = await store.config(), state = await store.state(), roots = new Map(), policies = new Map();
  if (pending.length && config?.server) assert(client.server === config.server, 'Pending checkpoints are bound to another server');
  const expectedDevice = deviceId || config?.deviceId || client.deviceId;
  // Bind the ENTIRE immutable batch before reading its policy or sending bytes.
  for (const manifest of pending) {
    const source = path.resolve(manifest.sourceRoot);
    if (root) assert(source === path.resolve(root), 'Pending checkpoints are bound to another project root');
    if (expectedDevice) assert(manifest.deviceId === expectedDevice, 'Pending checkpoints are bound to another device');
    const prior = Object.hasOwn(state.projects, manifest.projectId) ? state.projects[manifest.projectId] : undefined;
    assert(!prior || path.resolve(prior.root) === source, 'Pending checkpoints are bound to another project root');
    assert(!roots.has(manifest.projectId) || roots.get(manifest.projectId) === source, 'Pending checkpoints are bound to another project root');
    roots.set(manifest.projectId, source);
  }
  for (const manifest of pending) {
    const key = manifest.projectId;
    if (!policies.has(key)) {
      const dynamic = await getExcludedPaths?.(manifest) || [];
      policies.set(key, await readExclusionPolicy(roots.get(key), { excluded, excludedPaths: stateExclusions(roots.get(key), store.directory, [...excludedPaths, ...dynamic]) }));
    }
    const policy = policies.get(key);
    // The queue objects are private to this operation. Reread the policy each
    // boundary; only unchanged effective policy may reuse a manifest scan.
    if (validated.get(manifest) === policy.fingerprint) continue;
    for (const file of manifest.files) {
      if (file.path.startsWith('project/') && policy.isExcluded(file.path.slice(8))) throw Object.assign(new Error('Queued checkpoint contains a currently excluded path; retained locally. Resolve the protected queue before retrying.'), { code: 'PROTECTED_QUEUE' });
    }
    validated.set(manifest, policy.fingerprint);
  }
}

function commitAcknowledgement(value, manifest) {
  assert(value?.id === manifest.id && typeof value.conflict === 'boolean' && Array.isArray(value.heads), 'Invalid commit acknowledgement');
  return { id: manifest.id, conflict: value.conflict, heads: value.heads.map(validateId) };
}

function attachFlushFailure(error, results, outcomes) {
  const failure = error instanceof Error && Object.isExtensible(error) ? error : Object.assign(new Error('Checkpoint flush failed', { cause: error }), { ...(error?.code ? { code: error.code } : {}) });
  // No raw acknowledgement extensions, manifests, bytes or credentials escape.
  failure.results = structuredClone(results);
  failure.outcomes = structuredClone(outcomes);
  return failure;
}

export class LocalStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  async init() {
    await ensurePrivateDirectory(this.directory);
    for (const name of ['blobs', 'pending']) await ensurePrivateDirectory(path.join(this.directory, name));
    return this;
  }
  async exclusive(action) {
    await this.init();
    const filename = path.join(this.directory, 'operation.lock');
    let lock;
    try { lock = await fs.open(filename, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Another sync operation is active (or an unclean shutdown left operation.lock; verify no sync process is running before removing it).'); throw error; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await action(); }
    finally { await lock.close(); await assertNoSymlinks(filename); await fs.unlink(filename); }
  }
  async config() { return readJson(path.join(this.directory, 'config.json'), null); }
  async saveConfig(config) { await atomicWrite(path.join(this.directory, 'config.json'), JSON.stringify(config, null, 2)); }
  async state() { return readJson(path.join(this.directory, 'state.json'), { projects: {} }); }
  async saveState(state) { await atomicWrite(path.join(this.directory, 'state.json'), JSON.stringify(state, null, 2)); }
  async putBlob(hash, bytes) {
    validateBlobHash(hash); assert(sha256(bytes) === hash, 'Invalid local blob hash');
    const filename = path.join(this.directory, 'blobs', hash);
    try { await writeNewFile(filename, bytes); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert(sha256((await readStableFile(await assertNoSymlinks(filename))).bytes) === hash, 'Corrupt existing spool blob');
    }
  }
  async getBlob(hash) {
    validateBlobHash(hash);
    const { bytes } = await readStableFile(await assertNoSymlinks(path.join(this.directory, 'blobs', hash)));
    assert(sha256(bytes) === hash, 'Corrupt local spool blob'); return bytes;
  }
  async pending(projectId) {
    const items = [];
    for (const name of await fs.readdir(path.join(this.directory, 'pending'))) {
      if (!name.endsWith('.json')) continue;
      const filename = await assertNoSymlinks(path.join(this.directory, 'pending', name));
      const { bytes } = await readStableFile(filename, MAX_MANIFEST_BYTES);
      const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
      assert(name === `${manifest.id}.json`, 'Invalid pending checkpoint filename');
      if (!projectId || manifest.projectId === projectId) items.push(manifest);
    }
    // Follow the parent chain, rather than wall-clock order (device clocks can move).
    const remaining = new Map(items.map(item => [item.id, item])), ordered = [];
    while (remaining.size) {
      const ready = [...remaining.values()].filter(item => !remaining.has(item.parentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      assert(ready.length > 0, 'Cycle in local checkpoint queue');
      for (const item of ready) { ordered.push(item); remaining.delete(item.id); }
    }
    return ordered;
  }
  async capture(options) {
    const state = await this.state(), prior = Object.hasOwn(state.projects, options.projectId) ? state.projects[options.projectId] : undefined;
    const root = path.resolve(options.root);
    assert(!prior || path.resolve(prior.root) === root, 'Project ID is mapped to another directory on this device');
    const queued = await this.pending(options.projectId);
    assert(queued.every(item => path.resolve(item.sourceRoot) === root && item.deviceId === options.deviceId), 'Pending checkpoints belong to another root or device; finish or explicitly discard them first');
    if (queued.length >= 100) throw Object.assign(new Error('Offline queue has 100 checkpoints; upload it before capturing more'), { code: 'QUEUE_FULL' });
    const last = queued.at(-1);
    const restored = !last && !prior ? await readJson(path.join(root, '.dsh-sync', 'manifest.json'), null) : null;
    if (restored) assert(validateManifest(restored).projectId === options.projectId, 'Restored directory belongs to another project ID');
    const excludedPaths = stateExclusions(root, this.directory, options.excludedPaths);
    const captured = await captureCheckpoint({ ...options, root, excludedPaths, parentId: last?.id ?? prior?.head ?? restored?.id ?? null, putBlob: (hash, bytes) => this.putBlob(hash, bytes) });
    await options.beforeQueue?.();
    const fingerprint = contentFingerprint(captured.manifest);
    if (fingerprint === (last ? contentFingerprint(last) : prior?.fingerprint)) return { ...captured, unchanged: true, queuedId: last?.id ?? prior?.head };
    await atomicWrite(path.join(this.directory, 'pending', `${captured.manifest.id}.json`), JSON.stringify(captured.manifest));
    return { ...captured, unchanged: false, queuedId: captured.manifest.id };
  }
  /** Local-only admission, also usable before capture so protected queues stay untouched. */
  async validatePending(client, projectId, options = {}) {
    const pending = await this.pending(projectId);
    await validateQueue(this, client, pending, options);
    return pending;
  }
  /** Success retains the legacy ack array. Failures carry confirmed results + phase-specific outcomes. */
  async flush(client, projectId, options = {}) {
    const { beforeUpload, beforeCommit, beforeFlush } = options, results = [], outcomes = [];
    let current;
    try {
      const pending = await this.pending(projectId), validated = new Map();
      for (const manifest of pending) {
        for (const file of manifest.files) Object.freeze(file);
        Object.freeze(manifest.files); Object.freeze(manifest.sessionIds); Object.freeze(manifest);
      }
      const revalidate = async () => {
        client.signal?.throwIfAborted();
        await validateQueue(this, client, pending, options, validated);
        client.signal?.throwIfAborted();
      };
      await beforeFlush?.();
      await revalidate();
      for (const manifest of pending) {
        current = { id: manifest.id, projectId: manifest.projectId, status: 'pending', phase: 'upload' };
        outcomes.push(current);
        const uploaded = new Set();
        for (const file of manifest.files) {
          if (uploaded.has(file.sha256)) continue;
          const bytes = await this.getBlob(file.sha256);
          assert(bytes.length === file.size, 'Invalid local blob size');
          await beforeUpload?.(manifest, file);
          await revalidate();
          await client.uploadBlob(file.sha256, bytes); uploaded.add(file.sha256);
        }
        current.phase = 'precommit';
        await beforeCommit?.(manifest);
        await revalidate();
        current.phase = 'commit';
        const result = commitAcknowledgement(await client.commit(manifest), manifest);
        // Record a confirmed remote commit BEFORE any fallible local bookkeeping.
        results.push(result); current.status = 'local-finalization-failed'; current.phase = 'finalize';
        const state = await this.state();
        state.projects[manifest.projectId] = { root: manifest.sourceRoot, head: manifest.id, fingerprint: contentFingerprint(manifest) };
        await this.saveState(state);
        const pendingFile = path.join(this.directory, 'pending', `${manifest.id}.json`);
        await assertNoSymlinks(pendingFile); await fs.unlink(pendingFile);
        current.status = 'committed'; current.phase = 'complete'; current = undefined;
      }
      return results;
    } catch (error) {
      if (current?.phase === 'commit') {
        // Only a fully read HTTP refusal is definitive; a validator's status=400
        // can instead mean a malformed acknowledgement AFTER a durable commit.
        current.status = error?.definitive === true || ([400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(error?.httpStatus)) ? 'rejected' : 'commit-uncertain';
      }
      throw attachFlushFailure(error, results, outcomes);
    }
  }
  async restore(client, id, destination, { projectId, signal = client.signal, beforeWrite } = {}) {
    const manifest = await client.getCheckpoint(id);
    if (projectId !== undefined && manifest.projectId !== projectId) throw Object.assign(new Error('Checkpoint project mismatch'), { code: 'CHECKPOINT_MISMATCH' });
    signal?.throwIfAborted();
    const result = await restoreCheckpoint({ manifest, destination, signal, beforeWrite, getBlob: (hash, size) => client.downloadBlob(hash, size) });
    return { ...result, manifest };
  }
}
export function newDeviceId() { return `device-${randomUUID()}`; }
