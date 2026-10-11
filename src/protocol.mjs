import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const MAX_CHECKPOINT_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 20_000;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; this.status = 400; }
}
export function assert(condition, message) { if (!condition) throw new ValidationError(message); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function validateId(value) {
  assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value), 'Invalid identifier');
  assert(!['constructor', 'prototype', '__proto__'].includes(value.toLowerCase()), 'Reserved identifier');
  return value;
}
export function validateBlobHash(value) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256');
  return value;
}
export function validateRelativePath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'Invalid relative path');
  assert(value === value.normalize('NFC'), 'Paths must use NFC Unicode normalization');
  assert(!/[\\\x00-\x1f\x7f<>:"|?*]/.test(value), 'Non-portable path');
  const segments = value.split('/');
  for (const segment of segments) {
    assert(segment.length > 0 && segment !== '.' && segment !== '..' && segment.length <= 255, 'Invalid path segment');
    assert(!/[. ]$/.test(segment), 'Trailing dot/space is not portable');
    assert(!/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment), 'Reserved Windows path');
  }
  return value;
}
function record(value, name) { assert(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${name}`); }
export function validateManifest(input) {
  record(input, 'manifest');
  assert(input.version === 1, 'Unsupported checkpoint version');
  const id = validateId(input.id), projectId = validateId(input.projectId), deviceId = validateId(input.deviceId);
  const parentId = input.parentId === null ? null : validateId(input.parentId);
  assert(parentId !== id, 'Checkpoint cannot parent itself');
  assert(typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt)) && new Date(input.createdAt).toISOString() === input.createdAt, 'Invalid checkpoint timestamp');
  assert(typeof input.sourceRoot === 'string' && input.sourceRoot.length <= 4096 && !/[\x00-\x1f]/.test(input.sourceRoot) && (path.posix.isAbsolute(input.sourceRoot) || path.win32.isAbsolute(input.sourceRoot)), 'Invalid source root');
  assert(Array.isArray(input.sessionIds) && input.sessionIds.length <= MAX_FILES, 'Invalid sessions');
  const sessionIds = input.sessionIds.map(validateId);
  assert(new Set(sessionIds).size === sessionIds.length, 'Duplicate session');
  assert(Array.isArray(input.files) && input.files.length <= MAX_FILES, 'Too many checkpoint files');
  let total = 0;
  const seen = new Set(), hashes = new Map(), sessionFiles = new Set();
  const files = input.files.map(file => {
    record(file, 'file');
    const name = validateRelativePath(file.path), hash = validateBlobHash(file.sha256);
    assert(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_BLOB_BYTES, 'Invalid file size');
    assert(file.executable === undefined || typeof file.executable === 'boolean', 'Invalid executable flag');
    const key = name.toLowerCase();
    assert(!seen.has(key), 'Case-insensitive path collision'); seen.add(key);
    if (name.startsWith('project/')) {
      assert(name.length > 8, 'Missing project file path');
      assert(!name.slice(8).split('/').some(part => ['.git', '.dsh-sync'].includes(part.toLowerCase())), 'Unsafe project metadata path');
    } else if (name.startsWith('sessions/')) {
      const match = /^sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})\.json$/.exec(name);
      assert(match && sessionIds.includes(match[1]), 'Unlisted session file');
      sessionFiles.add(match[1]);
    } else {
      assert(name === `assets/${hash}`, 'Invalid asset path');
    }
    assert(!hashes.has(hash) || hashes.get(hash) === file.size, 'Inconsistent blob size');
    hashes.set(hash, file.size);
    total += file.size;
    assert(total <= MAX_CHECKPOINT_BYTES, 'Checkpoint exceeds size limit');
    return { path: name, sha256: hash, size: file.size, ...(file.executable ? { executable: true } : {}) };
  });
  for (const key of seen) {
    const parts = key.split('/'); parts.pop();
    while (parts.length) { assert(!seen.has(parts.join('/')), 'File/directory path collision'); parts.pop(); }
  }
  assert(sessionIds.every(id => sessionFiles.has(id)), 'Missing session file');
  const manifest = { version: 1, id, projectId, deviceId, parentId, createdAt: input.createdAt, sourceRoot: input.sourceRoot, sessionIds, files };
  assert(Buffer.byteLength(JSON.stringify(manifest)) <= MAX_MANIFEST_BYTES, 'Checkpoint manifest exceeds byte limit');
  return manifest;
}
export function encodeManifest(manifest) { return Buffer.from(JSON.stringify(validateManifest(manifest))); }
