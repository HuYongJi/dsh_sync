#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { LocalStore, newDeviceId } from './local-store.mjs';
import { SyncClient, validateServerUrl } from './client.mjs';
import { assert, validateId } from './protocol.mjs';
import { readStableFile, assertNoSymlinks } from './files.mjs';

const HELP = `dsh-sync (Node.js 24+)
  login --server https://sync.example.com --username owner --password-file FILE
  logout
  status
  preview --project ID --root DIRECTORY
  push --project ID --root DIRECTORY
  retry [--project ID]
  list --project ID
  restore --id CHECKPOINT --to NEW_DIRECTORY
All commands accept --state DIRECTORY (default ~/.dsh-sync).
Login passwords are read only from --password-file or SYNC_PASSWORD, never a command-line argument.
CLI push captures project files only. Install the DSH plugin for sessions and attachments.
Restore does not execute files or import sessions. Use /sync-import in DSH after review.
`;
export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  const allowed = new Set(['server', 'username', 'password-file', 'device', 'state', 'project', 'root', 'id', 'to']);
  for (let i = 0; i < rest.length; i += 2) {
    assert(rest[i].startsWith('--') && allowed.has(rest[i].slice(2)) && rest[i + 1] && !rest[i + 1].startsWith('--'), 'Expected a supported --option VALUE');
    const key = rest[i].slice(2); assert(!Object.hasOwn(options, key), 'Duplicate option'); options[key] = rest[i + 1];
  }
  return { command, options };
}
export async function runCli(argv, { env = process.env, output = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) } = {}) {
  const { command, options: o } = parseArgs(argv);
  if (['help', '--help', '-h'].includes(command)) { output(HELP); return; }
  assert(['login', 'logout', 'status', 'preview', 'push', 'retry', 'list', 'restore'].includes(command), 'Unknown command; use help');
  const store = new LocalStore(o.state || path.join(os.homedir(), '.dsh-sync'));
  await store.exclusive(async () => {
    const config = await store.config();
    if (command === 'login') {
      assert(o.server && o.username, 'login requires --server and --username');
      const server = validateServerUrl(o.server), deviceId = validateId(o.device || config?.deviceId || newDeviceId());
      const pending = await store.pending();
      assert(!pending.length || pending.every(item => item.deviceId === deviceId), 'Retry queued checkpoints before changing device');
      const hasHistory = pending.length || Object.keys((await store.state()).projects).length;
      assert(!hasHistory || !config?.server || (config.server === server && config.username === o.username && config.deviceId === deviceId), 'Use a new --state directory when changing server/account/device with existing sync history');
      const password = o['password-file'] ? (await readStableFile(await assertNoSymlinks(o['password-file']), 8192)).bytes.toString('utf8').replace(/\r?\n$/, '') : env.SYNC_PASSWORD;
      assert(typeof password === 'string' && password.length > 0, 'Supply --password-file or SYNC_PASSWORD');
      const result = await new SyncClient({ server }).login({ username: o.username, password, deviceId });
      await store.saveConfig({ server, username: o.username, deviceId, ...result });
      output({ loggedIn: true, server, deviceId, expiresAt: result.expiresAt }); return;
    }
    if (command === 'status') {
      output({ server: config?.server, deviceId: config?.deviceId, loggedIn: Boolean(config?.token && Date.parse(config.expiresAt) > Date.now()), pending: (await store.pending()).map(item => ({ id: item.id, projectId: item.projectId })), projects: (await store.state()).projects }); return;
    }
    if (command === 'preview') {
      assert(o.project && o.root, 'preview requires --project and --root');
      const { captureCheckpoint } = await import('./snapshot.mjs');
      const root = path.resolve(o.root), relative = path.relative(root, store.directory);
      assert(relative !== '', 'Cannot synchronize the state directory itself');
      const excludedPaths = !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : [];
      const captured = await captureCheckpoint({ root, projectId: o.project, deviceId: config?.deviceId || 'preview', excludedPaths, putBlob: async () => {} });
      output({ networkUsed: false, files: captured.manifest.files.map(file => file.path), bytes: captured.manifest.files.reduce((n, file) => n + file.size, 0), skipped: captured.skipped, sessions: 'CLI preview does not export DSH sessions' }); return;
    }
    assert(config?.token, 'Login first with this state directory (native DSH credentials are not read by the CLI)');
    const client = new SyncClient(config);
    if (command === 'logout') {
      const result = await client.logout(); delete config.token; delete config.expiresAt; await store.saveConfig(config); output({ loggedOut: true, ...result });
    } else if (command === 'list') {
      output(await client.list(o.project));
    } else if (command === 'retry') {
      if (o.project) validateId(o.project); output({ uploaded: await store.flush(client, o.project) });
    } else if (command === 'push') {
      assert(o.project && o.root, 'push requires --project and --root');
      const captured = await store.capture({ root: o.root, projectId: o.project, deviceId: config.deviceId });
      const uploaded = await store.flush(client, o.project, { root: o.root, deviceId: config.deviceId });
      output({ checkpointId: captured.queuedId, unchanged: captured.unchanged, skipped: captured.skipped, uploaded });
    } else if (command === 'restore') {
      assert(o.id && o.to && path.isAbsolute(o.to), 'restore requires --id and absolute --to');
      const result = await store.restore(client, o.id, o.to);
      output({ root: result.root, sessionIds: result.sessionIds, imported: false });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
