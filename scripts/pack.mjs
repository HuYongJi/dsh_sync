import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { sha256 } from '../src/protocol.mjs';
import { assertNoSymlinks, atomicWrite } from '../src/files.mjs';
import { buildClient } from './build-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await buildClient();
const entries = [];
async function add(relative) {
  const absolute = await assertNoSymlinks(path.join(root, relative));
  const stat = await fs.lstat(absolute);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(absolute)).sort()) await add(path.posix.join(relative, name));
  } else if (stat.isFile()) entries.push({ name: `package/${relative}`, bytes: await fs.readFile(absolute), mode: relative.endsWith('cli.mjs') || relative.endsWith('main.mjs') ? 0o755 : 0o644 });
  else throw new Error(`Not a regular package file: ${relative}`);
}
for (const relative of ['package.json', ...pkg.files]) await add(relative);
function header({ name, bytes, mode }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`USTAR path too long: ${name}`);
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  const octal = (value, offset, width) => block.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
  block.fill(0x20, 148, 156); block.write('0', 156); block.write('ustar\0', 257, 6, 'ascii'); block.write('00', 263);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); return block;
}
const blocks = [];
for (const entry of entries) blocks.push(header(entry), entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
blocks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
const filename = `${pkg.name}-${pkg.version}.tgz`, destination = path.join(root, 'dist', filename);
await atomicWrite(destination, archive);
await atomicWrite(path.join(root, 'dist', 'SHA256SUMS'), `${sha256(archive)}  ${filename}\n`);
console.log(`Created ${path.relative(root, destination)} (${entries.length} files, ${archive.length} bytes)`);
console.log(`SHA256 ${sha256(archive)}`);
