#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createSyncServer, closeSyncServer } from './index.mjs';

function integerEnvironment(value, fallback, name, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`Invalid ${name}`);
  return number;
}

/** Start only a loopback listener. Put a separately configured TLS proxy in front of it. */
export async function startFromEnvironment(env = process.env) {
  if (!env.SYNC_DATA_DIR) throw new Error('SYNC_DATA_DIR is required');
  if (env.SYNC_PASSWORD_FILE && env.SYNC_PASSWORD !== undefined) throw new Error('Set only SYNC_PASSWORD_FILE or SYNC_PASSWORD, not both');
  let password = env.SYNC_PASSWORD;
  const passwordFile = env.SYNC_PASSWORD_FILE;
  // Resolve bootstrap material only after the locked, validated state says it is
  // needed. After rotation even a deleted/obsolete password file is irrelevant.
  const loadBootstrapPassword = async () => {
    if (!passwordFile) return password;
    try {
      const info = await fs.stat(passwordFile);
      if (!info.isFile() || info.size > 4096) throw new Error('Invalid password file');
      return (await fs.readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
    } catch { throw new Error('Cannot read SYNC_PASSWORD_FILE as a small UTF-8 file'); }
  };
  const port = integerEnvironment(env.SYNC_PORT, 8787, 'SYNC_PORT', 0, 65535);
  const host = env.SYNC_HOST || '127.0.0.1';
  const tokenTtlMs = integerEnvironment(env.SYNC_TOKEN_TTL_MS, 24 * 60 * 60 * 1000, 'SYNC_TOKEN_TTL_MS', 1, 365 * 24 * 60 * 60 * 1000);
  const server = await createSyncServer({ dataDir: env.SYNC_DATA_DIR, username: env.SYNC_USERNAME, loadBootstrapPassword, tokenTtlMs });
  // Reduce accidental exposure to later child processes. No credentials are logged.
  if (env === process.env) delete process.env.SYNC_PASSWORD;
  password = undefined;
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening);
      try { server.listen({ port, host }); }
      catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
    });
  } catch (error) { await closeSyncServer(server); throw error; }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let server;
  try {
    server = await startFromEnvironment();
    const address = server.address();
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    console.log(`DSH sync listening on http://${host}:${address.port} (loopback only; use a TLS proxy for remote access)`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await closeSyncServer(server); }
      catch { console.error('DSH sync shutdown failed; inspect storage permissions before restarting'); process.exitCode = 1; }
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    server.on('error', async () => { console.error('DSH sync listener failed'); process.exitCode = 1; await stop(); });
  } catch (error) {
    // Avoid printing native filesystem errors containing storage paths or credentials.
    const safe = error.code ? 'Unable to initialize storage or listener' : error.message;
    console.error(`DSH sync startup failed: ${safe}`);
    process.exitCode = 1;
  }
}
