import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { assert, MAX_BLOB_BYTES } from './protocol.mjs';

export async function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    assert(stat.isDirectory() && !(await isLinkOrRedirect(current, stat)), `Unsafe directory: ${current}`);
  }
}
export async function isLinkOrRedirect(target, stat) {
  if (stat?.isSymbolicLink()) return true;
  const expected = path.resolve(target), actual = await fs.realpath(target);
  return process.platform === 'win32' ? expected.toLowerCase() !== actual.toLowerCase() : expected !== actual;
}
export async function assertNoSymlinks(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    assert(!(await isLinkOrRedirect(current, stat)), `Symbolic links/junctions are not allowed: ${current}`);
  }
  return resolved;
}
export async function atomicWrite(filename, bytes) {
  await ensurePrivateDirectory(path.dirname(filename));
  const temp = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, filename);
}
export async function readJson(filename, fallback) {
  try { await assertNoSymlinks(filename); return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
export async function readStableFile(filename, maxBytes = MAX_BLOB_BYTES) {
  await assertNoSymlinks(filename);
  const before = await fs.lstat(filename);
  assert(before.isFile() && !before.isSymbolicLink(), `Not a regular file: ${filename}`);
  assert(before.nlink === 1, `Hard-linked files are not synchronized: ${filename}`);
  assert(before.size <= maxBytes, `File exceeds ${maxBytes} bytes: ${filename}`);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    assert(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, 'File changed while opening');
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      assert(bytesRead > 0, 'File truncated during snapshot'); position += bytesRead;
    }
    const after = await handle.stat();
    const named = await fs.lstat(filename);
    assert(!named.isSymbolicLink() && named.dev === opened.dev && named.ino === opened.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && named.size === after.size && named.mtimeMs === after.mtimeMs, `File changed during snapshot; retry when idle: ${filename}`);
    return { bytes, executable: (before.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}
export async function writeNewFile(filename, bytes, executable = false) {
  await ensurePrivateDirectory(path.dirname(filename));
  const handle = await fs.open(filename, 'wx', executable ? 0o700 : 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
