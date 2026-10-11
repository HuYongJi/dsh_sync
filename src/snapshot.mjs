import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, sha256, validateId, validateManifest, validateRelativePath, MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES, MAX_FILES } from './protocol.mjs';
import { assertNoSymlinks, isLinkOrRedirect, readStableFile, writeNewFile } from './files.mjs';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.dsh', '.dsh-sync', '.inspection', '.test-tmp', '.venv', 'venv', '__pycache__', '.ssh', '.aws', '.azure', '.gnupg']);
export function isExcluded(relative, patterns = []) {
  const segments = relative.toLowerCase().split('/');
  if (segments.some(segment => SKIP_DIRECTORIES.has(segment))) return true;
  const name = segments.at(-1);
  if (name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx|keystore)$/.test(name) || /^(?:id_rsa|id_ed25519|\.?credentials(?:\.(?:json|ya?ml))?|\.npmrc|\.netrc|\.pypirc|auth\.json|tokens?\.json)$/.test(name)) return true;
  return patterns.some(pattern => path.posix.matchesGlob(relative, pattern) || path.posix.matchesGlob(`${relative}/`, pattern));
}
async function ignorePatterns(root, excluded) {
  const patterns = [...excluded];
  try {
    const { bytes } = await readStableFile(path.join(root, '.dsh-syncignore'), 64 * 1024);
    for (const line of bytes.toString('utf8').split(/\r?\n/)) {
      const rule = line.trim();
      if (!rule || rule.startsWith('#')) continue;
      assert(!rule.startsWith('!') && !rule.includes('\\') && !rule.startsWith('/'), '.dsh-syncignore supports only relative exclusion globs, not negation');
      patterns.push(rule.endsWith('/') ? `${rule}**` : rule);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return patterns;
}

/** Capture only an explicitly selected project. putBlob must durably persist bytes. */
export async function captureCheckpoint({ root, projectId, deviceId, parentId = null, sessions = [], assets = [], putBlob, excluded = [], excludedPaths = [], signal }) {
  signal?.throwIfAborted();
  root = await assertNoSymlinks(path.resolve(root));
  assert((await fs.stat(root)).isDirectory(), 'Project root must be a directory');
  let incomplete = false;
  try { await fs.lstat(path.join(root, '.dsh-sync', 'INCOMPLETE')); incomplete = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!incomplete, 'Cannot synchronize an incomplete restore');
  validateId(projectId); validateId(deviceId);
  const patterns = await ignorePatterns(root, excluded);
  const literalExclusions = excludedPaths.map(value => validateRelativePath(value).toLowerCase());
  const files = [], skipped = [], seen = new Set();
  let total = 0;
  async function add(name, bytes, executable = false) {
    signal?.throwIfAborted();
    validateRelativePath(name);
    assert(!seen.has(name.toLowerCase()), `Case-insensitive collision: ${name}`); seen.add(name.toLowerCase());
    assert(bytes.length <= MAX_BLOB_BYTES, `File too large: ${name}`);
    total += bytes.length;
    assert(total <= MAX_CHECKPOINT_BYTES && files.length < MAX_FILES, 'Checkpoint exceeds safety limits');
    const hash = sha256(bytes);
    await putBlob(hash, bytes);
    files.push({ path: name, sha256: hash, size: bytes.length, ...(executable ? { executable: true } : {}) });
  }
  async function walk(directory, relative = '') {
    await assertNoSymlinks(directory);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(name, patterns) || literalExclusions.some(value => name.toLowerCase() === value || name.toLowerCase().startsWith(`${value}/`))) { skipped.push({ path: name, reason: 'excluded' }); continue; }
      validateRelativePath(name);
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if ((await isLinkOrRedirect(absolute, stat)) || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
        skipped.push({ path: name, reason: 'link-or-special-file' }); continue;
      }
      if (stat.isDirectory()) await walk(absolute, name);
      else { const { bytes, executable } = await readStableFile(absolute); await add(`project/${name}`, bytes, executable); }
    }
  }
  await walk(root);
  const sessionIds = [];
  for (const session of sessions) {
    validateId(session.id); sessionIds.push(session.id);
    await add(`sessions/${session.id}.json`, Buffer.from(JSON.stringify(session.data)));
  }
  const assetHashes = new Set();
  for (const asset of assets) {
    const bytes = Buffer.isBuffer(asset) ? asset : (await readStableFile(await assertNoSymlinks(asset))).bytes;
    const hash = sha256(bytes);
    if (!assetHashes.has(hash)) { await add(`assets/${hash}`, bytes); assetHashes.add(hash); }
  }
  const manifest = validateManifest({ version: 1, id: randomUUID(), projectId, deviceId, parentId, createdAt: new Date().toISOString(), sourceRoot: root, sessionIds, files });
  return { manifest, skipped };
}

const destinationFailure = code => Object.assign(new Error(code), { code });
/** Native absolute paths only, while rejecting Windows device/ADS aliases on every platform. */
export async function validateRestoreDestination(value, protectedRoots = [], { reserved = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.normalize('NFC') || !path.isAbsolute(value) || /[\x00-\x1f\x7f<>"|?*]/.test(value) || /^[\\/]{2}/.test(value)) throw destinationFailure('BAD_DESTINATION');
  const windows = process.platform === 'win32';
  if (windows ? !/^[A-Za-z]:[\\/]/.test(value) : /[:\\]/.test(value)) throw destinationFailure('BAD_DESTINATION');
  const tail = windows ? value.slice(3) : value.slice(1);
  if (tail.includes(':') || tail.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw destinationFailure('BAD_DESTINATION');
  const root = path.resolve(value), key = input => windows ? path.resolve(input).toLowerCase() : path.resolve(input);
  const contains = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  const candidate = key(root);
  for (const protectedRoot of protectedRoots) {
    const spelling = key(protectedRoot);
    let real;
    try { real = key(await fs.realpath(protectedRoot)); } catch (error) { if (error.code !== 'ENOENT') throw destinationFailure('BAD_DESTINATION'); }
    if ([spelling, real].filter(Boolean).some(item => contains(candidate, item) || contains(item, candidate))) throw destinationFailure('PROTECTED_DESTINATION');
  }
  try {
    const parent = await assertNoSymlinks(path.dirname(root));
    if (!(await fs.lstat(parent)).isDirectory()) throw destinationFailure('BAD_DESTINATION');
    if (reserved) { await assertNoSymlinks(root); if (!(await fs.lstat(root)).isDirectory()) throw destinationFailure('BAD_DESTINATION'); }
    else {
      try { await fs.lstat(root); } catch (error) { if (error.code === 'ENOENT') return root; throw error; }
      throw destinationFailure('DESTINATION_EXISTS');
    }
  } catch (error) { if (error.code === 'DESTINATION_EXISTS') throw error; throw destinationFailure('BAD_DESTINATION'); }
  return root;
}

/** Never merge or overwrite. A failed restore deliberately leaves an INCOMPLETE marker. */
export async function restoreCheckpoint({ manifest, destination, getBlob, signal, beforeWrite }) {
  manifest = validateManifest(manifest);
  destination = path.resolve(destination);
  const parent = path.dirname(destination);
  await assertNoSymlinks(parent);
  const parentIdentity = await fs.lstat(parent, { bigint: true });
  let rootIdentity;
  async function verifyLocation() {
    try {
      await assertNoSymlinks(parent);
      const currentParent = await fs.lstat(parent, { bigint: true });
      if (!currentParent.isDirectory() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) throw destinationFailure('DESTINATION_CHANGED');
      if (rootIdentity) {
        await assertNoSymlinks(destination);
        const currentRoot = await fs.lstat(destination, { bigint: true });
        if (!currentRoot.isDirectory() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) throw destinationFailure('DESTINATION_CHANGED');
      }
    } catch { throw destinationFailure('DESTINATION_CHANGED'); }
  }
  async function admitWrite() {
    await verifyLocation();
    await beforeWrite?.();
    await verifyLocation();
    signal?.throwIfAborted();
  }
  await admitWrite();
  // An exclusive directory reservation is the conflict policy for all local files.
  await fs.mkdir(destination, { mode: 0o700 });
  rootIdentity = await fs.lstat(destination, { bigint: true });
  const meta = path.join(destination, '.dsh-sync');
  // Finish the marker on cancellation, but NEVER through a replaced parent/root.
  // Only constant safety metadata is written before the next cancellation check.
  await verifyLocation();
  await fs.mkdir(meta, { mode: 0o700 });
  const marker = path.join(meta, 'INCOMPLETE');
  await verifyLocation();
  await writeNewFile(marker, Buffer.from('Restore is incomplete. Do not import or run this project.\n'));
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const bytes = await getBlob(file.sha256, file.size);
    assert(Buffer.isBuffer(bytes) && bytes.length === file.size && sha256(bytes) === file.sha256, `Corrupt blob: ${file.sha256}`);
    const relative = file.path.startsWith('project/') ? file.path.slice(8) : `.dsh-sync/${file.path}`;
    const target = path.join(destination, ...relative.split('/'));
    await admitWrite();
    await writeNewFile(target, bytes, file.executable);
  }
  await admitWrite();
  await writeNewFile(path.join(meta, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  // This exact marker was exclusively created above; no arbitrary path cleanup.
  await assertNoSymlinks(marker);
  await admitWrite();
  await fs.unlink(marker);
  return { root: destination, metadataDirectory: meta, sessionIds: manifest.sessionIds };
}

export function contentFingerprint(manifest) {
  return sha256(JSON.stringify({ projectId: manifest.projectId, sourceRoot: manifest.sourceRoot, sessionIds: [...manifest.sessionIds].sort(), files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path, 'en')) }));
}
