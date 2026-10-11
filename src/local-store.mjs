import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, ensurePrivateDirectory, readJson, assertNoSymlinks, readStableFile, writeNewFile } from './files.mjs';
import { assert, sha256, validateBlobHash, validateManifest, MAX_MANIFEST_BYTES } from './protocol.mjs';
import { captureCheckpoint, contentFingerprint, restoreCheckpoint } from './snapshot.mjs';

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
    assert(queued.length < 100, 'Offline queue has 100 checkpoints; upload it before capturing more');
    const last = queued.at(-1);
    const restored = !last && !prior ? await readJson(path.join(root, '.dsh-sync', 'manifest.json'), null) : null;
    if (restored) assert(validateManifest(restored).projectId === options.projectId, 'Restored directory belongs to another project ID');
    const relativeState = path.relative(root, this.directory);
    assert(relativeState !== '', 'Project root cannot be the sync state directory');
    const excludedPaths = [...(options.excludedPaths || [])];
    if (!relativeState.startsWith(`..${path.sep}`) && relativeState !== '..' && !path.isAbsolute(relativeState)) excludedPaths.push(relativeState.split(path.sep).join('/'));
    const captured = await captureCheckpoint({ ...options, root, excludedPaths, parentId: last?.id ?? prior?.head ?? restored?.id ?? null, putBlob: (hash, bytes) => this.putBlob(hash, bytes) });
    await options.beforeQueue?.();
    const fingerprint = contentFingerprint(captured.manifest);
    if (fingerprint === (last ? contentFingerprint(last) : prior?.fingerprint)) return { ...captured, unchanged: true, queuedId: last?.id ?? prior?.head };
    await atomicWrite(path.join(this.directory, 'pending', `${captured.manifest.id}.json`), JSON.stringify(captured.manifest));
    return { ...captured, unchanged: false, queuedId: captured.manifest.id };
  }
  async flush(client, projectId, { root, deviceId, beforeUpload, beforeCommit } = {}) {
    const results = [], config = await this.config(), pending = await this.pending(projectId);
    if (pending.length && config?.server) assert(client.server === config.server, 'Pending checkpoints are bound to another server');
    // Validate the entire queue before sending even its first blob.
    for (const manifest of pending) {
      if (root) assert(path.resolve(manifest.sourceRoot) === path.resolve(root), 'Pending checkpoints are bound to another project root');
      const expectedDevice = deviceId || config?.deviceId || client.deviceId;
      if (expectedDevice) assert(manifest.deviceId === expectedDevice, 'Pending checkpoints are bound to another device');
    }
    for (const manifest of pending) {
      const uploaded = new Set();
      for (const file of manifest.files) {
        if (uploaded.has(file.sha256)) continue;
        const bytes = await this.getBlob(file.sha256);
        await beforeUpload?.(manifest, file);
        await client.uploadBlob(file.sha256, bytes); uploaded.add(file.sha256);
      }
      await beforeCommit?.(manifest);
      const result = await client.commit(manifest);
      const state = await this.state();
      state.projects[manifest.projectId] = { root: manifest.sourceRoot, head: manifest.id, fingerprint: contentFingerprint(manifest) };
      await this.saveState(state);
      const pendingFile = path.join(this.directory, 'pending', `${manifest.id}.json`);
      await assertNoSymlinks(pendingFile); await fs.unlink(pendingFile);
      results.push(result);
    }
    return results;
  }
  async restore(client, id, destination) {
    const manifest = await client.getCheckpoint(id);
    const result = await restoreCheckpoint({ manifest, destination, getBlob: (hash, size) => client.downloadBlob(hash, size) });
    return { ...result, manifest };
  }
}
export function newDeviceId() { return `device-${randomUUID()}`; }
