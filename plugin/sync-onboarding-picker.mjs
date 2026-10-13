import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRelativePath } from '../src/protocol.mjs';
import { isExcluded } from '../src/snapshot.mjs';
import { syncRootIdentity, verifySyncRoot } from '../src/sync-local.mjs';
import { canonicalJson } from '../src/sync-protocol.mjs';

const fail = code => Object.assign(new Error(code), { code });
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const folded = value => path.resolve(value).normalize('NFC').toLowerCase();
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const binding = input => ({ revision: input.revision, server: input.server, username: input.username });
function nativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || !value.isWellFormed() || value !== value.normalize('NFC') || !path.isAbsolute(value) || /[\x00-\x1f\x7f<>"|?*]/.test(value) || /^[\\/]{2}/.test(value)) throw fail('BAD_DESTINATION');
  if (process.platform === 'win32' ? !/^[A-Za-z]:[\\/]/.test(value) : /[:\\]/.test(value)) throw fail('BAD_DESTINATION');
  const tail = value.slice(path.parse(value).root.length);
  if (tail && (tail.includes(':') || tail.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) throw fail('BAD_DESTINATION');
  return path.resolve(value);
}
export function cloneDirectoryName(label) {
  let name = String(label ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/[\\/<>:"|?*]/g, '-').trim().replace(/[. ]+$/g, '').slice(0, 100).replace(/[\uD800-\uDBFF]$/u, '').replace(/[. ]+$/g, '');
  try { validateRelativePath(name); } catch { name = 'project'; }
  if (!name.isWellFormed() || !name || name.startsWith('.') || isExcluded(name)) name = 'project';
  return name;
}

/** In-memory Host-only parent capabilities. No preview mkdir, registry writes,
 * arbitrary client paths, or filesystem-backed replacement for native browsing.
 */
export function createSyncOnboardingPicker(ctx, { admitParent, admitDestination, now = Date.now, ttlMs = 15 * 60_000 } = {}) {
  const browsers = new Map(), selections = new Map();
  function prune() { for (const map of [browsers, selections]) for (const [id, value] of map) if (value.until <= now()) map.delete(id); }
  function provider(owner) {
    let service, capability;
    try { service = ctx.get?.('directoryPicker'); capability = service?.capability(); } catch { throw fail('DIRECTORY_PICKER_UNAVAILABLE'); }
    if (!service || !['native', 'browse'].includes(capability?.kind) || typeof capability[capability.kind === 'native' ? 'pick' : 'list'] !== 'function') throw fail('DIRECTORY_PICKER_UNAVAILABLE');
    service = original(service);
    if (owner && (service !== owner.service || capability.kind !== owner.kind || original(capability) !== owner.capability)) throw fail('DIRECTORY_PICKER_EXPIRED');
    return { service, kind: capability.kind, capability };
  }
  async function parent(root) { root = nativePath(root); await admitParent(root); return syncRootIdentity(root); }
  async function verifyParent(value) { await admitParent(value.root); try { await verifySyncRoot(value); } catch { throw fail('DESTINATION_CHANGED'); } }
  function owns(input, identity, record) {
    if (!record || record.until <= now() || !same(binding(input), record.input) || !same(identity, record.identity)) throw fail('DIRECTORY_PICKER_EXPIRED');
    provider(record); return record;
  }
  async function call(owner, verb, args, context) {
    await context.check(); context.signal.throwIfAborted(); let result;
    try { result = await provider(owner).capability[verb](...args, context.signal); }
    catch { context.signal.throwIfAborted(); throw fail('DIRECTORY_PICKER_FAILED'); }
    await context.check(); provider(owner); return result;
  }
  function remember(browser, value) {
    const key = folded(value.root), previous = browser.paths.get(key);
    if (previous) { if (!same(browser.nodes.get(previous), value)) throw fail('DESTINATION_CHANGED'); return previous; }
    if (browser.nodes.size >= 8192) throw fail('DIRECTORY_PICKER_FAILED');
    const id = randomUUID(); browser.paths.set(key, id); browser.nodes.set(id, value); return id;
  }
  async function listing(browser, value, requested, context) {
    if (!value || !Array.isArray(value.crumbs) || !Array.isArray(value.entries) || value.crumbs.length > 256 || value.entries.length > 2000 || typeof value.truncated !== 'boolean') throw fail('DIRECTORY_PICKER_FAILED');
    const root = nativePath(value.path); nativePath(value.home);
    if (requested && folded(root) !== folded(requested.root)) throw fail('DIRECTORY_PICKER_FAILED');
    const current = await parent(root); if (requested && !same(current, requested)) throw fail('DESTINATION_CHANGED');
    const crumbs = [], directories = [];
    for (const [rows, output, ancestry] of [[value.crumbs, crumbs, true], [value.entries, directories, false]]) {
      const seen = new Set(); let previous;
      for (const row of rows) {
        if (!row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 255 || !row.name.isWellFormed() || row.name !== row.name.normalize('NFC') || /[\x00-\x1f\x7f]/.test(row.name) || typeof row.hidden !== 'boolean') throw fail('DIRECTORY_PICKER_FAILED');
        const absolute = nativePath(row.path), key = folded(absolute);
        if (seen.has(key) || (ancestry ? !inside(folded(root), key) || previous && !inside(key, previous) : folded(path.dirname(absolute)) !== folded(root) || row.name !== path.basename(absolute))) throw fail('DIRECTORY_PICKER_FAILED');
        seen.add(key); previous = key;
        if (row.hidden || row.name.startsWith('.') || isExcluded(row.name)) continue;
        await context.check(); let node;
        try { node = await parent(absolute); } catch (error) { if (['PROTECTED_DESTINATION', 'BAD_DESTINATION', 'SYNC_ROOT_CHANGED'].includes(error.code) || error.name === 'ValidationError') continue; throw error; }
        output.push({ id: remember(browser, node), label: row.name });
      }
    }
    await context.check(); provider(browser); await verifyParent(current);
    return { id: browser.id, path: root, currentId: remember(browser, current), crumbs, directories, selectable: true, truncated: value.truncated };
  }
  async function selectParent(owner, value, context) {
    prune(); if (selections.size >= 100) throw fail('SYNC_QUOTA');
    await verifyParent(value);
    const occupied = new Set([...selections.values()].flatMap(record => record.items.map(item => folded(item.root)))), items = [];
    for (const item of owner.items) {
      const name = cloneDirectoryName(item.label); let root;
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = path.join(value.root, attempt ? `${name}-${randomUUID().slice(0, 8)}` : name);
        if (occupied.has(folded(candidate))) continue;
        try { await admitDestination(candidate); root = candidate; break; }
        catch (error) { if (!['DESTINATION_EXISTS', 'PROTECTED_DESTINATION'].includes(error.code)) throw error; }
      }
      if (!root) throw fail('SYNC_DESTINATION_UNAVAILABLE');
      occupied.add(folded(root)); items.push({ projectId: item.projectId, label: item.label, root });
    }
    await context.check(); provider(owner); await verifyParent(value);
    const selection = { ...owner, id: randomUUID(), parent: value, items, until: now() + ttlMs };
    selections.set(selection.id, selection);
    return { destination: { id: selection.id, parent: value.root, expiresAt: new Date(selection.until).toISOString(), items } };
  }
  return {
    async pick(input, items, context) {
      prune(); const { service, kind, capability } = provider();
      const owner = { service, kind, capability: original(capability), input: binding(input), identity: context.identity, items, until: now() + ttlMs };
      if (kind === 'native') { const result = await call(owner, 'pick', [], context); return result === null ? { cancelled: true } : selectParent(owner, await parent(result), context); }
      if (browsers.size >= 16) throw fail('SYNC_QUOTA');
      const browser = { ...owner, id: randomUUID(), nodes: new Map(), paths: new Map() };
      const result = await listing(browser, await call(owner, 'list', [undefined], context), null, context);
      browsers.set(browser.id, browser); return { browser: result };
    },
    async browse(input, context) {
      const browser = owns(input, context.identity, browsers.get(input.browserId)), node = browser.nodes.get(input.nodeId);
      if (!node) throw fail('DIRECTORY_PICKER_EXPIRED');
      await verifyParent(node);
      return { browser: await listing(browser, await call(browser, 'list', [node.root], context), node, context) };
    },
    async select(input, context) {
      const browser = owns(input, context.identity, browsers.get(input.browserId)), node = browser.nodes.get(input.nodeId);
      if (!node) throw fail('DIRECTORY_PICKER_EXPIRED');
      return selectParent(browser, node, context);
    },
    resolve(input, identity) {
      prune(); const value = owns(input, identity, selections.get(input.destinationId));
      return { parent: value.parent, items: value.items.map(item => ({ ...item })), async checkParent() { provider(value); await verifyParent(value.parent); }, async check() { owns(input, identity, value); await verifyParent(value.parent); for (const item of value.items) await admitDestination(item.root); } };
    },
    stop() { browsers.clear(); selections.clear(); },
  };
}
