#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { LocalStore, newDeviceId } from './local-store.mjs';
import { SyncClient, validateServerUrl } from './client.mjs';
import { assert, validateId } from './protocol.mjs';
import { readStableFile, assertNoSymlinks } from './files.mjs';

const HELP = `dsh-sync (Node.js 24+; account diagnostics only)
  login --server https://sync.example.com --username owner --password-file FILE
  logout
  status
All commands accept --state DIRECTORY (default ~/.dsh-sync).
Login passwords are read only from --password-file or SYNC_PASSWORD, never a command-line argument.
Project synchronization is available only in DSH Settings → Personal Cloud Sync → Bidirectional Sync.
This CLI does not read native DSH credentials or authorize project synchronization.
`;
const REMOVED_COMMANDS = new Set(['preview', 'push', 'retry', 'list', 'restore']);
export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  // Reject retired operations before opening a state directory or reading any
  // credential. Existing queues and cloud history are intentionally untouched.
  if (REMOVED_COMMANDS.has(command)) throw Object.assign(new Error('Legacy project commands have been removed. Use DSH Settings → Personal Cloud Sync → Bidirectional Sync; existing data has not been deleted.'), { code: 'LEGACY_COMMAND_REMOVED' });
  assert(['help', '--help', '-h', 'login', 'logout', 'status'].includes(command), 'Unknown command; use help');
  const options = {};
  const allowed = new Set(command === 'login' ? ['server', 'username', 'password-file', 'device', 'state'] : ['state']);
  for (let i = 0; i < rest.length; i += 2) {
    assert(rest[i].startsWith('--') && allowed.has(rest[i].slice(2)) && rest[i + 1] && !rest[i + 1].startsWith('--'), 'Expected a supported --option VALUE');
    const key = rest[i].slice(2); assert(!Object.hasOwn(options, key), 'Duplicate option'); options[key] = rest[i + 1];
  }
  return { command, options };
}
export async function runCli(argv, { env = process.env, output = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) } = {}) {
  const { command, options: o } = parseArgs(argv);
  if (['help', '--help', '-h'].includes(command)) { output(HELP); return; }
  const store = new LocalStore(o.state || path.join(os.homedir(), '.dsh-sync'));
  await store.exclusive(async () => {
    const config = await store.config();
    if (command === 'login') {
      assert(o.server && o.username, 'login requires --server and --username');
      const server = validateServerUrl(o.server), deviceId = validateId(o.device || config?.deviceId || newDeviceId());
      const pending = await store.pending();
      assert(!pending.length || pending.every(item => item.deviceId === deviceId), 'Existing checkpoint history is bound to another device; use a new --state directory');
      const hasHistory = pending.length || Object.keys((await store.state()).projects).length;
      assert(!hasHistory || !config?.server || (config.server === server && config.username === o.username && config.deviceId === deviceId), 'Use a new --state directory when changing server/account/device with existing sync history');
      const password = o['password-file'] ? (await readStableFile(await assertNoSymlinks(o['password-file']), 8192)).bytes.toString('utf8').replace(/\r?\n$/, '') : env.SYNC_PASSWORD;
      assert(typeof password === 'string' && password.length > 0, 'Supply --password-file or SYNC_PASSWORD');
      const result = await new SyncClient({ server }).login({ username: o.username, password, deviceId });
      await store.saveConfig({ server, username: o.username, deviceId, ...result });
      output({ loggedIn: true, server, deviceId, expiresAt: result.expiresAt }); return;
    }
    if (command === 'status') {
      output({ server: config?.server, deviceId: config?.deviceId, loggedIn: Boolean(config?.token && Date.parse(config.expiresAt) > Date.now()) }); return;
    }
    assert(config?.token, 'Login first with this state directory (native DSH credentials are not read by the CLI)');
    const result = await new SyncClient(config).logout();
    delete config.token; delete config.expiresAt;
    await store.saveConfig(config); output({ loggedOut: true, ...result });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
