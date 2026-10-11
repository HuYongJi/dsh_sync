import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const installHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'];

/** For trusted project packages only: evaluates modules, not a security sandbox.
 * Does not apply the plugin, start services or access a profile. */
export async function checkInstall(directory = sourceRoot) {
  const root = await realpath(directory);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-personal-sync');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports?.['.'], pkg.main);
  assert.equal(pkg.exports?.['./package.json'], './package.json');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-connection']);
  for (const hook of installHooks) assert.equal(pkg.scripts?.[hook], undefined, `GitHub installation must not require ${hook}`);
  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.deepEqual(Object.keys(pkg[field] ?? {}), [], `${field}: runtime dependencies must come from Node or the DSH host`);
  }
  for (const field of ['bundleDependencies', 'bundledDependencies']) {
    assert.deepEqual(pkg[field] ?? [], [], `${field}: do not bundle host dependencies`);
  }
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/cordis'], '~4.0.4', 'Keep the verified Cordis peer range');
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-plugin-manager'], '0.2.0-rc.2', 'Keep the verified native update contract');
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-plugin-manager']?.optional, true, 'Plugin updates must remain an optional Host capability');
  assert.ok(pkg.files?.includes('client/dist/client.js'), 'Explicitly publish the prebuilt client entry');
  for (const name of ['dsh-session', 'dsh-llm', 'dsh-session-format-catalog', 'dsh-client-ui-settings', 'dsh-client-connection']) {
    assert.equal(pkg.peerDependencies?.[`@deepseek-ai/${name}`], '0.2.0-rc.2', 'Do not bypass host compatibility checks');
  }

  async function entry(relative) {
    assert.equal(typeof relative, 'string', 'Missing package entry');
    assert.ok(relative.startsWith('./') && !relative.includes('\\'), 'Entries must be package-relative');
    const target = await realpath(path.resolve(root, relative));
    const suffix = path.relative(root, target);
    assert.ok(suffix && !suffix.startsWith('..') && !path.isAbsolute(suffix), 'Entry escapes the package');
    assert.ok((await stat(target)).isFile(), `Missing entry: ${relative}`);
    return target;
  }
  const hostPath = await entry(pkg.main);
  const clientPath = await entry(pkg.exports?.['./client']);
  const patchPath = await entry(pkg.dsh?.bundle?.patch);
  for (const bin of Object.values(pkg.bin ?? {})) await entry(bin);
  const require = createRequire(path.join(root, 'package.json'));
  assert.equal(await realpath(require.resolve(pkg.name)), hostPath);
  assert.equal(await realpath(require.resolve(`${pkg.name}/client`)), clientPath);
  assert.equal(await realpath(require.resolve(`${pkg.name}/package.json`)), path.join(root, 'package.json'));

  // This bundle deliberately has one inert insertion, not an arbitrary user-written YAML document.
  const patch = (await readFile(patchPath, 'utf8')).replace(/^\s*#.*$/gm, '').trim().replace(/\r\n/g, '\n');
  assert.equal(patch, '- insert:\n    - id: dsh-personal-sync\n      name: dsh-personal-sync\n      config:\n        autoSync: false\n        projects: []', 'Installation must keep automatic sync off and select no projects');
  const host = await import(pathToFileURL(hostPath).href);
  assert.equal(host.name, pkg.name);
  assert.equal(typeof host.apply, 'function');

  let client;
  vm.runInNewContext(await readFile(clientPath, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { assert.equal(client, undefined); client = value; } } },
  }, { filename: clientPath, timeout: 2000 });
  assert.equal(client?.id, pkg.name);
  assert.equal(typeof client.factory, 'function');
  const required = [];
  const plugin = client.factory(name => { required.push(name); return {}; });
  assert.deepEqual(required, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.equal(plugin.name, 'dsh-personal-sync-settings');
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'connection']);
  return { name: pkg.name, version: pkg.version, host: pkg.main, client: pkg.exports['./client'], patch: pkg.dsh.bundle.patch };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkInstall(process.argv[2]);
  console.log(`Install entries verified: ${result.name}@${result.version} (Host, Client, bundle patch; no activation)`);
}
