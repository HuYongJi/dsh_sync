import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNoSymlinks, isLinkOrRedirect } from '../src/files.mjs';
import { validateRelativePath } from '../src/protocol.mjs';
import { projectFolderMetadata } from '../src/client.mjs';
import { isExcluded } from '../src/snapshot.mjs';

const fail = code => Object.assign(new Error(code), { code });
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const sameIdentity = (a, b) => ['server', 'username', 'deviceId', 'token'].every(field => a?.[field] === b?.[field]);
const sameBinding = (a, b) => ['revision', 'server', 'username'].every(field => a?.[field] === b?.[field]);
function nativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.normalize('NFC') || !path.isAbsolute(value) || /[\x00-\x1f\x7f<>"|?*]/.test(value) || /^[\\/]{2}/.test(value)) throw fail('BAD_DESTINATION');
  const windows = process.platform === 'win32';
  if (windows ? !/^[A-Za-z]:[\\/]/.test(value) : /[:\\]/.test(value)) throw fail('BAD_DESTINATION');
  const tail = windows ? value.slice(3) : value.slice(1);
  if (tail && (tail.includes(':') || tail.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) throw fail('BAD_DESTINATION');
  return path.resolve(value);
}
const directoryIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
/** A validated remote basename is a suggestion only, never a local root. */
export function proposedDirectoryName(sourceRoot) {
  let value = projectFolderMetadata(sourceRoot).label.normalize('NFC').replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '-').replace(/[. ]+$/g, '').slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '').replace(/[. ]+$/g, '');
  try { validateRelativePath(value); } catch { value = 'project'; }
  if (!value || value.startsWith('.') || isExcluded(value)) value = 'project';
  return value;
}

/** In-memory capabilities only. Browsing belongs to the native Host provider, never fs.readdir. */
export function createDestinationPicker(ctx, { admitParent, admitDestination, now = Date.now, ttlMs = 15 * 60_000, maxBrowsers = 16, maxNodes = 8192, maxPlans = 128 } = {}) {
  const browsers = new Map(), plans = new Map();
  function prune() {
    for (const [id, value] of browsers) if (now() >= value.expires) browsers.delete(id);
    for (const [id, value] of plans) if (now() >= value.expires) plans.delete(id);
  }
  function provider(expected, kind) {
    let service, capability;
    try { service = ctx.get?.('directoryPicker'); capability = service?.capability(); }
    catch { throw fail('DIRECTORY_PICKER_UNAVAILABLE'); }
    if (!service || !capability || !['native', 'browse'].includes(capability.kind) || typeof capability[capability.kind === 'native' ? 'pick' : 'list'] !== 'function') throw fail('DIRECTORY_PICKER_UNAVAILABLE');
    if ((expected && original(service) !== expected) || (kind && capability.kind !== kind)) throw fail('DIRECTORY_PICKER_EXPIRED');
    return { service: original(service), capability };
  }
  async function call(owner, verb, args, signal, check) {
    signal.throwIfAborted();
    const { capability } = provider(owner.service, owner.kind);
    if (capability.kind !== owner.kind || typeof capability[verb] !== 'function') throw fail('DIRECTORY_PICKER_UNAVAILABLE');
    let result;
    try { result = await capability[verb](...args, signal); }
    catch { signal.throwIfAborted(); throw fail('DIRECTORY_PICKER_FAILED'); }
    await check(); provider(owner.service, owner.kind); signal.throwIfAborted(); return result;
  }
  async function realDirectory(value, { selecting = false } = {}) {
    const directory = nativePath(value);
    await admitParent(directory, { selecting });
    try {
      await assertNoSymlinks(directory);
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory() || await isLinkOrRedirect(directory, stat)) throw fail('BAD_DESTINATION');
      return { path: directory, identity: directoryIdentity(stat) };
    } catch (error) { if (error.code === 'PROTECTED_DESTINATION') throw error; throw fail('BAD_DESTINATION'); }
  }
  async function revalidate(node, options) {
    let actual;
    try { actual = await realDirectory(node.path, options); }
    catch (error) { if (error.code === 'PROTECTED_DESTINATION') throw error; throw fail('DESTINATION_CHANGED'); }
    if (!unchanged(actual.identity, node.identity)) throw fail('DESTINATION_CHANGED');
    return actual;
  }
  function ownedBrowser(input, identity) {
    prune();
    const browser = browsers.get(input.browserId);
    if (!browser || !sameBinding(input, browser.input) || !sameIdentity(identity, browser.identity)) throw fail('DIRECTORY_PICKER_EXPIRED');
    provider(browser.service, browser.kind);
    const node = browser.nodes.get(input.nodeId);
    if (!node) throw fail('DIRECTORY_PICKER_EXPIRED');
    return { browser, node };
  }
  function remember(browser, node) {
    const previous = browser.paths.get(key(node.path));
    if (previous) {
      if (!unchanged(browser.nodes.get(previous).identity, node.identity)) throw fail('DESTINATION_CHANGED');
      return previous;
    }
    if (browser.nodes.size >= maxNodes) throw fail('DIRECTORY_PICKER_FAILED');
    const id = randomUUID(); browser.nodes.set(id, node); browser.paths.set(key(node.path), id); return id;
  }
  async function projectListing(browser, listing, requested, check) {
    if (!listing || typeof listing !== 'object' || !Array.isArray(listing.crumbs) || !Array.isArray(listing.entries) || listing.crumbs.length > 256 || listing.entries.length > 2000 || typeof listing.truncated !== 'boolean') throw fail('DIRECTORY_PICKER_FAILED');
    let directory;
    try { directory = nativePath(listing.path); nativePath(listing.home); }
    catch { throw fail('DIRECTORY_PICKER_FAILED'); }
    if (requested && key(requested.path) !== key(directory)) throw fail('DIRECTORY_PICKER_FAILED');
    const current = await realDirectory(directory), seen = new Set(), ancestors = new Set();
    if (requested && !unchanged(current.identity, requested.identity)) throw fail('DESTINATION_CHANGED');
    let lastCrumb;
    for (const [entries, crumbs] of [[listing.crumbs, true], [listing.entries, false]]) {
      for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 255 || /[\x00-\x1f\x7f]/.test(entry.name) || entry.name !== entry.name.normalize('NFC') || typeof entry.hidden !== 'boolean') throw fail('DIRECTORY_PICKER_FAILED');
        let absolute;
        try { absolute = nativePath(entry.path); } catch { throw fail('DIRECTORY_PICKER_FAILED'); }
        const target = key(absolute), currentKey = key(directory), keys = crumbs ? ancestors : seen;
        if (keys.has(target)) throw fail('DIRECTORY_PICKER_FAILED'); keys.add(target);
        if (crumbs) {
          if (!inside(currentKey, target) || (lastCrumb && !inside(target, lastCrumb))) throw fail('DIRECTORY_PICKER_FAILED');
          lastCrumb = target;
        } else if (key(path.dirname(absolute)) !== currentKey || entry.name !== path.basename(absolute)) throw fail('DIRECTORY_PICKER_FAILED');
      }
    }
    const currentId = remember(browser, current), crumbs = [], directories = [];
    for (const [entries, output] of [[listing.crumbs, crumbs], [listing.entries, directories]]) {
      for (const entry of entries) {
        if (entry.hidden || entry.name.startsWith('.') || isExcluded(entry.name)) continue;
        await check();
        let node;
        try { node = await realDirectory(entry.path); }
        catch (error) { if (['BAD_DESTINATION', 'PROTECTED_DESTINATION'].includes(error.code)) continue; throw error; }
        output.push({ id: remember(browser, node), label: entry.name });
      }
    }
    let selectable = true;
    try { await admitParent(directory, { selecting: true }); } catch { selectable = false; }
    await check(); provider(browser.service, browser.kind); await revalidate(current);
    return { id: browser.id, path: directory, currentId, crumbs, directories, selectable, truncated: listing.truncated };
  }
  async function plan(owner, parent, identity, check) {
    prune(); if (plans.size >= maxPlans) throw fail('DIRECTORY_PICKER_FAILED');
    const actual = await realDirectory(parent.path, { selecting: true });
    if (parent.identity && !unchanged(parent.identity, actual.identity)) throw fail('DESTINATION_CHANGED');
    const name = proposedDirectoryName(owner.sourceRoot);
    let root;
    for (let attempt = 0; attempt < 10; attempt++) {
      root = path.join(actual.path, attempt ? `${name}-${randomUUID().slice(0, 8)}` : name);
      try { await admitDestination(root); break; }
      catch (error) { if (!['DESTINATION_EXISTS', 'PROTECTED_DESTINATION'].includes(error.code) || attempt === 9) throw error; root = undefined; }
    }
    await check(); provider(owner.service, owner.kind); await revalidate(actual, { selecting: true });
    const id = randomUUID(), record = { id, root, parent: actual, identity: { ...identity }, input: { ...owner.input }, expires: now() + ttlMs };
    plans.set(id, record);
    return { id, root, parent: actual.path };
  }
  return {
    async pick(input, manifest, context) {
      const { identity, signal, check } = context;
      prune();
      const { service, capability } = provider();
      const owner = { service, kind: capability.kind, input: { ...input }, sourceRoot: manifest.sourceRoot };
      if (capability.kind === 'native') {
        const selected = await call(owner, 'pick', [], signal, check);
        if (selected === null) return { cancelled: true };
        return { destination: await plan(owner, { path: selected }, identity, check) };
      }
      if (browsers.size >= maxBrowsers) throw fail('DIRECTORY_PICKER_FAILED');
      const listing = await call(owner, 'list', [undefined], signal, check);
      const browser = { ...owner, id: randomUUID(), identity: { ...identity }, expires: now() + ttlMs, nodes: new Map(), paths: new Map() };
      const value = await projectListing(browser, listing, undefined, check);
      browsers.set(browser.id, browser); return { browser: value };
    },
    async browse(input, context) {
      const { browser, node } = ownedBrowser(input, context.identity);
      await revalidate(node); await context.check();
      const listing = await call(browser, 'list', [node.path], context.signal, context.check);
      return { browser: await projectListing(browser, listing, node, context.check) };
    },
    async select(input, context) {
      const { browser, node } = ownedBrowser(input, context.identity);
      await revalidate(node, { selecting: true });
      return { destination: await plan(browser, node, context.identity, context.check) };
    },
    // Synchronous admission runs AFTER the controller's idempotency lookup. TTL is
    // checked only here, never by an already accepted restore's write guard.
    resolve(input, identity) {
      prune(); const record = plans.get(input.destinationId);
      if (!record || !sameBinding(input, record.input) || !sameIdentity(identity, record.identity) || input.projectId !== record.input.projectId || input.checkpointId !== record.input.checkpointId) throw fail('DIRECTORY_PICKER_EXPIRED');
      let targetIdentity;
      return { root: record.root, async check({ reserved = false } = {}) {
        await revalidate(record.parent, { selecting: true });
        await admitDestination(record.root, { reserved });
        if (reserved) {
          const current = await realDirectoryForReserved(record.root);
          if (targetIdentity && !unchanged(current, targetIdentity)) throw fail('DESTINATION_CHANGED');
          targetIdentity ??= current;
        }
      } };
    },
  };
}
async function realDirectoryForReserved(root) {
  try { await assertNoSymlinks(root); const stat = await fs.lstat(root, { bigint: true }); if (!stat.isDirectory()) throw fail('DESTINATION_CHANGED'); return directoryIdentity(stat); }
  catch { throw fail('DESTINATION_CHANGED'); }
}
