import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleClient } from '../scripts/build-client.mjs';
import { checkInstall } from '../scripts/check-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(root, '.test-tmp');
const manifest = () => readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse);
async function installedFixture(t) {
  await mkdir(base, { recursive: true });
  const target = await mkdtemp(path.join(base, 'package-'));
  t.after(async () => {
    assert.equal(path.dirname(target), path.resolve(base));
    assert.ok(path.basename(target).startsWith('package-'));
    assert.equal(await realpath(target), target);
    await rm(target, { recursive: true, force: true });
  });
  const pkg = await manifest();
  // Only distributable files, no .git, scripts, dependencies, research or profile data.
  for (const name of ['package.json', ...pkg.files]) {
    assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'));
    await cp(path.join(root, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
  }
  return target;
}

test('GitHub install manifest resolves Host, prebuilt Client and inert bundle without activation', async () => {
  const result = await checkInstall(root);
  assert.equal(result.name, 'dsh-personal-sync');
  const pkg = await manifest();
  assert.equal(pkg.repository.url, 'git+https://github.com/HuYongJi/dsh_sync.git');
});

test('checked-in client bundle is current without running an install lifecycle', async () => {
  assert.equal(await readFile(path.join(root, 'client/dist/client.js'), 'utf8'), await bundleClient(),
    'Run node scripts/build-client.mjs and commit client/dist/client.js before publishing');
});

test('publish-whitelist-only package loads without build scripts, source checkout or installed host peers', async t => {
  const target = await installedFixture(t);
  assert.equal((await checkInstall(target)).name, 'dsh-personal-sync');
  for (const name of ['scripts', 'tests', '.inspection', '.deployment', '.test-tmp', 'node_modules', '.env']) {
    await assert.rejects(realpath(path.join(target, name)), { code: 'ENOENT' });
  }
});

test('installation check refuses an absent prebuilt client instead of relying on prepare', async t => {
  const target = await installedFixture(t);
  const client = path.join(target, 'client/dist/client.js');
  assert.equal(await realpath(client), client);
  await rm(client);
  await assert.rejects(checkInstall(target), { code: 'ENOENT' });
});

test('installation check rejects newly introduced lifecycle approval requirements', async t => {
  const target = await installedFixture(t);
  const filename = path.join(target, 'package.json');
  const pkg = JSON.parse(await readFile(filename, 'utf8'));
  pkg.scripts.prepare = 'node scripts/build-client.mjs';
  await writeFile(filename, JSON.stringify(pkg));
  await assert.rejects(checkInstall(target), /must not require prepare/);
});

test('installation check rejects optional or bundled runtime dependencies', async t => {
  const target = await installedFixture(t);
  const filename = path.join(target, 'package.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  for (const [field, value] of [['optionalDependencies', { 'unexpected-runtime': '1.0.0' }], ['bundleDependencies', ['unexpected-runtime']], ['bundledDependencies', true]]) {
    await writeFile(filename, JSON.stringify({ ...original, [field]: value }));
    await assert.rejects(checkInstall(target), new RegExp(field));
  }
});

test('installation check preserves the verified Cordis peer contract', async t => {
  const target = await installedFixture(t);
  const filename = path.join(target, 'package.json');
  const pkg = JSON.parse(await readFile(filename, 'utf8'));
  pkg.peerDependencies['@deepseek-ai/cordis'] = '*';
  await writeFile(filename, JSON.stringify(pkg));
  await assert.rejects(checkInstall(target), /verified Cordis peer range/);
});

test('installation check refuses automatic sync in the default bundle', async t => {
  const target = await installedFixture(t);
  const filename = path.join(target, 'cordis.patch.yml');
  await writeFile(filename, (await readFile(filename, 'utf8')).replace('autoSync: false', 'autoSync: true'));
  await assert.rejects(checkInstall(target), /keep automatic sync off/);
});

test('installation check refuses a prebuilt client with the wrong module ID', async t => {
  const target = await installedFixture(t);
  const filename = path.join(target, 'client/dist/client.js');
  await writeFile(filename, (await readFile(filename, 'utf8')).replace('id: "dsh-personal-sync"', 'id: "wrong-package"'));
  await assert.rejects(checkInstall(target), /wrong-package/);
});
