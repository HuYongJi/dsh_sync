import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createController, deriveView, parseCloudProjects, parseDestination, parseDirectoryBrowser } from '../client/state.mjs';
import { createClientPlugin } from '../client/adapter.mjs';

// Synthetic React/Connection contracts only; no real Host picker, filesystem writes or GUI claims.
const binding = { revision: 3, server: 'https://synthetic.example.test', username: 'synthetic' };
const uuid = 'a0000000-0000-4000-8000-000000000001';
const checkpoint = { id: 'checkpoint-one', projectId: 'project-one', deviceId: 'device-one', parentId: null, createdAt: '2026-01-01T00:00:00.000Z', fileCount: 4, totalBytes: 100 };
const listing = { checkpoints: [checkpoint, { ...checkpoint, id: 'checkpoint-two' }], heads: ['checkpoint-one', 'checkpoint-two'] };
const project = { projectId: 'project-one', label: '云端项目文件夹', sourceRoot: 'E:\\synthetic\\source', checkpointCount: 2, latestCreatedAt: checkpoint.createdAt };
const plan = { id: 'destination-one', root: 'E:\\synthetic\\saved\\cloud-project', parent: 'E:\\synthetic\\saved' };
const browser = { id: 'browser-one', path: 'E:\\synthetic', currentId: 'node-root', crumbs: [{ id: 'node-root', label: 'synthetic' }], directories: [{ id: 'node-saved', label: '保存目录' }], selectable: false, truncated: false };
const nested = { ...browser, path: plan.parent, currentId: 'node-saved', crumbs: [...browser.crumbs, { id: 'node-saved', label: '保存目录' }], directories: [], selectable: true };
const updater = (extra = {}) => ({ currentVersion: '0.5.0', supported: true, state: 'idle', restartRequired: false, ...extra });
const status = (extra = {}) => ({ ...binding, loggedIn: true, running: false, autoSync: false, pending: 0, intervalMs: 60000, projects: [{ id: 'workspace-one', projectId: project.projectId, label: '本机项目名称', root: project.sourceRoot, selected: true, available: true }], update: updater(), ...extra });
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: 'untrusted-secret', details: { secret: 'untrusted-secret' } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 40; ++i) await Promise.resolve(); }
function timers() {
  let id = 0; const jobs = new Map();
  return { jobs, setTimeout(fn, ms) { jobs.set(++id, { fn, ms }); return id; }, clearTimeout(key) { jobs.delete(key); },
    run(ms) { const item = [...jobs].find(([, job]) => job.ms === ms); assert.ok(item); jobs.delete(item[0]); item[1].fn(); } };
}
const reads = call => ok(call.action === 'projects' ? { projects: [project] } : call.action === 'checkpoints' ? listing : status());
function connection(handler) {
  const calls = [];
  return { calls, connection: { rpc: { async call(channel, endpoint, payload, signal) { const call = { channel, endpoint, action: endpoint.split('/').at(-1), payload, signal }; calls.push(call); return handler(call); } } } };
}
function setup(t, handler = call => call.action === 'destinationpick' ? ok({ destination: plan }) : reads(call)) {
  const mock = connection(handler); const clock = timers();
  const controller = createController(mock.connection, { ...clock, crypto: { randomUUID: () => uuid } });
  t.after(() => controller.dispose()); return { ...mock, clock, controller };
}
async function select(controller) {
  await controller.refresh(); await controller.browseProjects();
  assert.equal(controller.setCloudProject(project.projectId), true); await controller.loadCheckpoints();
  assert.equal(controller.getSnapshot().cloud.checkpointId, ''); controller.selectCheckpoint(checkpoint.id);
}

test('folder DTOs allowlist/freeze readable metadata and validate optional partial/legacy flags', () => {
  const projects = parseCloudProjects({ projects: [{ ...project, token: 'untrusted-secret' }], partial: true, legacy: false });
  assert.deepEqual(projects, [project]); assert.ok(Object.isFrozen(projects) && Object.isFrozen(projects[0]));
  assert.equal(parseCloudProjects({ projects: [{ projectId: 'older-project', checkpointCount: 0, latestCreatedAt: null }] })[0].label, undefined);
  const parsed = parseDirectoryBrowser({ ...browser, token: 'untrusted-secret', directories: [{ ...browser.directories[0], path: 'untrusted-secret' }] });
  assert.deepEqual(parsed, browser);
  for (const item of [parsed, parsed.crumbs, parsed.crumbs[0], parsed.directories, parsed.directories[0]]) assert.equal(Object.isFrozen(item), true);
  const destination = parseDestination({ ...plan, password: 'untrusted-secret' }); assert.deepEqual(destination, plan); assert.ok(Object.isFrozen(destination));
  for (const patch of [{ partial: 'false' }, { legacy: 1 }, { partial: null }]) assert.throws(() => parseCloudProjects({ projects: [project], ...patch }), { code: 'INVALID_RESPONSE' });
  for (const patch of [{ label: '' }, { label: 'bad\nlabel' }, { label: 'a'.repeat(1025) }, { sourceRoot: 'relative' }]) assert.throws(() => parseCloudProjects({ projects: [{ ...project, ...patch }] }), { code: 'INVALID_RESPONSE' });
});

test('folder DTOs reject malformed IDs, paths, flags, duplicate rows and unbounded lists', () => {
  for (const id of ['', '../escape', '_prefix', 'constructor', 'Constructor', 'prototype', '__proto__', 'a'.repeat(101)]) {
    assert.throws(() => parseDestination({ ...plan, id }), { code: 'INVALID_RESPONSE' });
    for (const patch of [{ id }, { currentId: id }, { crumbs: [{ id, label: 'bad' }] }, { directories: [{ id, label: 'bad' }] }]) assert.throws(() => parseDirectoryBrowser({ ...browser, ...patch }), { code: 'INVALID_RESPONSE' });
  }
  for (const path of ['', 'relative', 'C:relative', '\\relative', '/bad\npath', '/' + 'a'.repeat(4096)]) {
    assert.throws(() => parseDestination({ ...plan, root: path }), { code: 'INVALID_RESPONSE' });
    assert.throws(() => parseDestination({ ...plan, parent: path }), { code: 'INVALID_RESPONSE' });
    assert.throws(() => parseDirectoryBrowser({ ...browser, path }), { code: 'INVALID_RESPONSE' });
  }
  for (const patch of [{ selectable: 1 }, { truncated: 'true' }, { crumbs: null }, { directories: [browser.directories[0], browser.directories[0]] }, { directories: [{ id: 'x', label: '' }] },
    { directories: Array.from({ length: 2001 }, (_, i) => ({ id: `folder${i}`, label: 'folder' })) }, { crumbs: Array.from({ length: 257 }, (_, i) => ({ id: `crumb${i}`, label: 'folder' })) }]) assert.throws(() => parseDirectoryBrowser({ ...browser, ...patch }), { code: 'INVALID_RESPONSE' });
  for (const root of ['/srv/synthetic/new', '\\\\host\\share\\new']) assert.equal(parseDestination({ ...plan, root }).root, root);
});

test('native destination choice is checkpoint-bound, performs no writes, and cancel silently preserves its plan', async t => {
  let response = { destination: plan };
  const { controller, calls } = setup(t, call => call.action === 'destinationpick' ? ok(response) : reads(call));
  await controller.refresh(); assert.equal(await controller.chooseDestination(), false);
  await select(controller); assert.equal(await controller.chooseDestination(), true);
  assert.deepEqual(calls.at(-1).payload, { ...binding, projectId: project.projectId, checkpointId: checkpoint.id });
  assert.equal(calls.at(-1).channel, '/api'); assert.equal(calls.at(-1).endpoint, 'dsh-personal-sync/destinationpick');
  assert.equal(controller.getSnapshot().cloud.destination, plan.root); assert.equal(controller.getSnapshot().cloud.destinationId, plan.id);
  response = { cancelled: true }; assert.equal(await controller.chooseDestination(), false);
  assert.equal(controller.getSnapshot().cloud.destinationId, plan.id); assert.equal(controller.getSnapshot().cloud.error, null);
  assert.equal(calls.some(call => ['restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('Host browser only accepts issued IDs and selectable current folder; settings stay locked until selection', async t => {
  const { controller, calls } = setup(t, call => call.action === 'destinationpick' ? ok({ browser }) : call.action === 'destinationbrowse' ? ok({ browser: call.payload.nodeId === 'node-root' ? browser : nested }) : call.action === 'destinationselect' ? ok({ destination: plan }) : reads(call));
  await select(controller); await controller.chooseDestination();
  let view = deriveView(controller.getSnapshot());
  for (const key of ['editable', 'canSync', 'canLogin', 'canLogout', 'canChangePassword', 'canCheckUpdate', 'canUpdate', 'canRestore']) assert.equal(view[key], false, key);
  assert.equal(controller.setAutoSync(true), false); assert.equal(await controller.sync(), false); assert.equal(await controller.savePreferences(), false);
  assert.equal(await controller.selectDestination(), false); const count = calls.length;
  assert.equal(await controller.browseDestination('/raw/path'), false); assert.equal(await controller.browseDestination('unissued'), false); assert.equal(calls.length, count);
  assert.equal(await controller.browseDestination('node-saved'), true);
  assert.deepEqual(calls.at(-1).payload, { ...binding, browserId: browser.id, nodeId: 'node-saved' });
  assert.equal(await controller.browseDestination('node-root'), true); assert.equal(await controller.browseDestination('node-saved'), true);
  assert.equal(await controller.selectDestination(), true);
  assert.deepEqual(calls.at(-1).payload, { ...binding, browserId: browser.id, nodeId: 'node-saved' });
  assert.equal(controller.getSnapshot().cloud.directoryBrowser, null); assert.equal(deriveView(controller.getSnapshot()).canRestoreDestination, true);
  assert.equal(calls.some(call => ['restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('new restore intent retains readonly root but sends destinationId only, binds selection, and consumes double clicks', async t => {
  let current = status(); const write = deferred();
  const { controller, calls } = setup(t, call => call.action === 'destinationpick' ? ok({ destination: plan }) : call.action === 'restore' ? write.promise : call.action === 'status' ? ok(current) : reads(call));
  await select(controller); await controller.chooseDestination(); const intent = controller.prepareRestore();
  assert.equal(intent.destination, plan.root); assert.equal(intent.destinationId, plan.id); assert.ok(Object.isFrozen(intent));
  assert.equal(await controller.confirmRecovery({ ...intent, destinationId: 'foreign' }), false);
  const pending = controller.confirmRecovery(intent); assert.equal(await controller.confirmRecovery(intent), false);
  assert.deepEqual(calls.at(-1).payload, { ...binding, projectId: project.projectId, checkpointId: checkpoint.id, destinationId: plan.id, confirm: true, requestId: uuid });
  current = status({ recovery: { id: uuid, kind: 'restore', state: 'succeeded', root: plan.root, checkpointId: checkpoint.id, sessionCount: 1 } });
  write.resolve(ok({ recovery: current.recovery })); assert.equal(await pending, true);
  assert.equal(calls.filter(call => call.action === 'restore').length, 1); assert.equal(controller.getSnapshot().recoveryPending, null);
  assert.equal(calls.some(call => ['import', 'sync', 'preferences'].includes(call.action)), false);
});

test('folder plans/intents invalidate on project/checkpoint, identity, revision, runtime and update barriers', async t => {
  for (const change of ['project', 'checkpoint', { revision: 4 }, { username: 'other' }, { server: 'https://other.example.test' }, { loggedIn: false }, { update: updater({ currentVersion: '0.6.0' }) }, { update: updater({ state: 'installing', restartRequired: true, requestId: uuid }) }]) {
    let current = status();
    const { controller, calls } = setup(t, call => call.action === 'status' ? ok(current) : call.action === 'destinationpick' ? ok({ destination: plan }) : reads(call));
    await select(controller); await controller.chooseDestination(); const intent = controller.prepareRestore();
    if (change === 'project') controller.setCloudProject('project-two');
    else if (change === 'checkpoint') controller.selectCheckpoint('checkpoint-two');
    else { current = status(change); await controller.refresh(); }
    const cloud = controller.getSnapshot().cloud;
    assert.equal(cloud.destinationId, ''); assert.equal(cloud.destination, ''); assert.equal(cloud.directoryBrowser, null); assert.equal(cloud.intent, null);
    assert.equal(await controller.confirmRecovery(intent), false); assert.equal(calls.some(call => call.action === 'restore'), false);
  }
});

test('native picker stale replies are aborted/ignored when identity or runtime changes during its local status read', async t => {
  for (const patch of [{ revision: 4 }, { update: updater({ currentVersion: '0.6.0' }) }, { update: updater({ state: 'installing', restartRequired: true, requestId: uuid }) }]) {
    let current = status(); const late = deferred();
    const { controller, calls } = setup(t, call => call.action === 'destinationpick' ? late.promise : call.action === 'status' ? ok(current) : reads(call));
    await select(controller); const choosing = controller.chooseDestination();
    const request = calls.at(-1); current = status(patch); await controller.refresh();
    assert.equal(request.signal.aborted, true); assert.equal(await choosing, false);
    late.resolve(ok({ destination: plan })); await settle();
    assert.equal(controller.getSnapshot().cloud.destinationId, ''); assert.equal(controller.getSnapshot().busy, null);
  }
});

test('native picker unmount/dispose/close abort signals and late delivery cannot overwrite a newer plan', async t => {
  for (const closeKind of ['unmount', 'dispose', 'close']) {
    const late = deferred(); let first = true;
    const { controller, calls } = setup(t, call => call.action === 'destinationpick' ? (first ? (first = false, late.promise) : ok({ destination: { ...plan, id: 'new-plan' } })) : reads(call));
    const stop = controller.watch(); await settle(); await select(controller);
    const choosing = controller.chooseDestination(); const call = calls.at(-1);
    if (closeKind === 'unmount') stop(); else if (closeKind === 'dispose') controller.dispose(); else controller.closeDestinationBrowser();
    assert.equal(call.signal.aborted, true); assert.equal(await choosing, false);
    if (closeKind !== 'dispose') { await controller.chooseDestination(); assert.equal(controller.getSnapshot().cloud.destinationId, 'new-plan'); }
    late.resolve(ok({ destination: plan })); await settle();
    assert.equal(controller.getSnapshot().cloud.destinationId, closeKind === 'dispose' ? '' : 'new-plan');
    stop();
  }
});

test('picker timeout is bounded and late completion cannot create a plan or any write', async t => {
  const late = deferred(); const { controller, clock, calls } = setup(t, call => call.action === 'destinationpick' ? late.promise : reads(call));
  await select(controller); const choosing = controller.chooseDestination();
  assert.equal(deriveView(controller.getSnapshot()).canSync, false); clock.run(60000);
  assert.equal(await choosing, false); assert.equal(calls.at(-1).signal.aborted, true);
  assert.equal(controller.getSnapshot().cloud.error.code, 'TIMEOUT');
  late.resolve(ok({ destination: plan })); await settle(); assert.equal(controller.getSnapshot().cloud.destinationId, '');
  assert.equal(calls.some(call => ['restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('expired/mismatched browser and malformed picker replies fail closed without reflecting untrusted errors', async t => {
  for (const reply of [{}, null, { cancelled: false }, { cancelled: true, destination: plan }, { destination: { ...plan, id: 'constructor' } }, { browser: { ...browser, selectable: 'yes' } }]) {
    const { controller } = setup(t, call => call.action === 'destinationpick' ? ok(reply) : reads(call));
    await select(controller); assert.equal(await controller.chooseDestination(), false);
    assert.equal(controller.getSnapshot().cloud.error.code, 'INVALID_RESPONSE'); assert.equal(controller.getSnapshot().cloud.destinationId, '');
  }
  for (const code of ['DIRECTORY_PICKER_UNAVAILABLE', 'DIRECTORY_PICKER_FAILED', 'DIRECTORY_PICKER_EXPIRED', 'DESTINATION_CHANGED', 'CHECKPOINT_MISMATCH']) {
    const { controller } = setup(t, call => call.action === 'destinationpick' ? failure(code) : reads(call));
    await select(controller); assert.equal(await controller.chooseDestination(), false); assert.equal(controller.getSnapshot().cloud.error.code, code);
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('untrusted-secret'), false);
  }
  for (const result of [failure('DIRECTORY_PICKER_EXPIRED'), ok({ browser: { ...nested, id: 'different-browser' } })]) {
    const { controller } = setup(t, call => call.action === 'destinationpick' ? ok({ browser }) : call.action === 'destinationbrowse' ? result : reads(call));
    await select(controller); await controller.chooseDestination(); assert.equal(await controller.browseDestination('node-saved'), false);
    assert.equal(controller.getSnapshot().cloud.directoryBrowser, null); assert.equal(controller.getSnapshot().cloud.destinationId, '');
  }
});

test('destination expired/changed restore refusals clear handles and remain definite failures, never retries', async t => {
  for (const code of ['DIRECTORY_PICKER_EXPIRED', 'DESTINATION_CHANGED']) {
    const { controller, calls } = setup(t, call => call.action === 'destinationpick' ? ok({ destination: plan }) : call.action === 'restore' ? failure(code) : reads(call));
    await select(controller); await controller.chooseDestination(); const intent = controller.prepareRestore();
    assert.equal(await controller.confirmRecovery(intent), false); assert.equal(controller.getSnapshot().cloud.error.code, code);
    assert.equal(controller.getSnapshot().cloud.destinationId, ''); assert.equal(controller.getSnapshot().recoveryUncertain, false);
    assert.equal(await controller.confirmRecovery(intent), false); assert.equal(calls.filter(call => call.action === 'restore').length, 1);
  }
});

function mockReact() {
  const cells = []; let cursor = 0; let effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }, useId() { return 'mock-folder'; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = value; }]; },
    useEffect(effect, deps) { const i = cursor++; if (!cells[i] || deps.some((value, at) => value !== cells[i].deps[at])) { const item = { deps, effect, cleanup: cells[i]?.cleanup }; cells[i] = item; effects.push(item); } },
  };
  return { React, render(Component, props) { cursor = 0; return Component(props); }, mount() { const pending = effects; effects = []; for (const item of pending) { item.cleanup?.(); item.cleanup = item.effect(); } }, unmount() { for (const cell of cells) cell?.cleanup?.(); } };
}
function nodes(root) { return !root || typeof root !== 'object' ? [] : [root, ...(root.props?.children ?? []).flatMap(nodes), ...nodes(root.props?.footer)]; }
function text(root) { return typeof root === 'string' || typeof root === 'number' ? String(root) : !root || typeof root !== 'object' ? '' : (root.props?.children ?? []).map(text).join(' '); }
function button(root, label) { const found = nodes(root).find(node => node.type === 'native:Button' && text(node) === label); assert.ok(found, `missing ${label}`); return found; }
function modal(page, title) { return nodes(page.tree()).find(node => node.type === 'native:Modal' && node.props.title === title); }
function pageSetup(t, handler) {
  const hooks = mockReact(); const mock = connection(handler); const cleanups = []; let slot;
  const primitives = Object.fromEntries(['Button', 'Input', 'Checkbox', 'Switch', 'Modal'].map(name => [name, `native:${name}`]));
  const required = []; const plugin = createClientPlugin(name => { required.push(name); return name === 'react' ? hooks.React : primitives; });
  plugin.apply({ connection: mock.connection, effect(effect) { cleanups.push(effect()); }, on() {}, slots: { inject(_name, register) { register(); }, register(spec, Component) { slot = { Component, props: spec.inject() }; } } });
  t.after(() => { hooks.unmount(); cleanups.forEach(cleanup => cleanup?.()); });
  return { ...mock, ...hooks, required, controller: slot.props.controller, tree: () => hooks.render(slot.Component, slot.props) };
}
const managerTitle = '选择要下载的项目';
const batchPlan = { latest: true, parent: plan.parent, destinations: [{ ...plan, projectId: project.projectId, label: project.label }] };
async function openCloud(page) { page.tree(); page.mount(); await settle(); button(page.tree(), '选择项目').props.onClick(); await settle(); return modal(page, managerTitle); }
async function chooseProject(page) {
  await openCloud(page);
  nodes(modal(page, managerTitle)).find(node => node.props?.role === 'combobox').props.onFocus();
  nodes(modal(page, managerTitle)).find(node => node.props?.role === 'option').props.onClick(); await settle();
  button(modal(page, managerTitle), '完成').props.onClick();
}

test('native React add dropdown uses readable folder labels, supports legacy metadata and concise partial/empty states', async t => {
  for (const metadata of [{ projects: [project], partial: true }, { projects: [{ projectId: project.projectId, checkpointCount: 2, latestCreatedAt: checkpoint.createdAt }], legacy: true }, { projects: [{ projectId: 'unknown', checkpointCount: 0, latestCreatedAt: null }] }, { projects: [] }]) {
    const page = pageSetup(t, call => call.action === 'projects' ? ok(metadata) : reads(call)); await openCloud(page);
    nodes(modal(page, managerTitle)).find(node => node.props?.role === 'combobox').props.onFocus(); const cloud = modal(page, managerTitle);
    assert.equal(nodes(cloud).filter(node => node.type === 'native:Input').length, 1);
    assert.match(text(cloud), metadata.partial ? /云端项目文件夹/ : metadata.legacy ? /本机项目名称/ : metadata.projects.length ? /项目文件夹/ : /暂无云端项目/);
    if (metadata.partial) assert.match(text(cloud), /部分项目读取失败/);
    assert.doesNotMatch(text(cloud), /project-one|项目 ID|手动输入|绝对路径|归档不等于|不自动/);
    assert.deepEqual(page.required, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  }
});

test('native React single cloud Modal browses folders/crumbs, disables unsuitable parent and rejects stale callbacks', async t => {
  const page = pageSetup(t, call => call.action === 'downloadpick' ? ok({ latest: true, browser }) : call.action === 'downloadbrowse' ? ok({ latest: true, browser: call.payload.nodeId === 'node-root' ? browser : nested }) : call.action === 'downloadselect' ? ok(batchPlan) : reads(call));
  await chooseProject(page); button(page.tree(), '保存位置').props.onClick(); await settle();
  let picker = modal(page, '选择保存位置'); assert.equal(picker.props.open, true); assert.equal(button(picker, '选择此文件夹').props.disabled, true);
  assert.equal(nodes(picker).some(node => node.type === 'native:Input'), false);
  assert.equal(nodes(page.tree()).filter(node => node.type === 'native:Modal' && node.props.open).length, 1);
  const old = button(picker, '保存目录').props.onClick; old(); await settle();
  picker = modal(page, '选择保存位置'); assert.equal(button(picker, '选择此文件夹').props.disabled, false);
  const before = page.calls.length; old(); await settle(); assert.equal(page.calls.length, before);
  button(picker, 'synthetic').props.onClick(); await settle(); button(modal(page, '选择保存位置'), '保存目录').props.onClick(); await settle();
  button(modal(page, '选择保存位置'), '选择此文件夹').props.onClick(); await settle();
  assert.equal(modal(page, '选择保存位置').props.open, false); assert.ok(text(page.tree()).includes(plan.parent));
  assert.equal(nodes(page.tree()).some(node => node.type === 'native:Input'), false);
  button(page.tree(), '下载所选').props.onClick(); const confirm = modal(page, '确认下载所选项目');
  assert.equal(confirm.props.open, true); assert.ok(text(confirm).includes(plan.root)); assert.ok(text(confirm).includes(project.label));
  assert.equal(nodes(page.tree()).filter(node => node.type === 'native:Modal' && node.props.open).length, 1);
  assert.equal(page.calls.some(call => ['downloadstart', 'restore', 'import', 'sync', 'preferences'].includes(call.action)), false);
});

test('native React folder close/unmount aborts native picker and never falls back to a browser-computer picker', async t => {
  const late = deferred(); const page = pageSetup(t, call => call.action === 'downloadpick' ? late.promise : reads(call));
  await chooseProject(page);
  button(page.tree(), '保存位置').props.onClick(); const request = page.calls.at(-1);
  page.unmount(); await settle(); assert.equal(request.signal.aborted, true);
  late.resolve(ok(batchPlan)); await settle(); assert.equal(page.controller.getSnapshot().downloadPlan, null);
  const source = await readFile(new URL('../client/adapter.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(/\r?\n/)[0], "import { createController, deriveView, filterProjects } from './state.mjs';");
  assert.doesNotMatch(source, /showDirectoryPicker|webkitdirectory|setDestination\(|cloud-project|cloud-destination|createDirectory/);
});
