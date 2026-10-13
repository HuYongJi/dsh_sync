import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, readStableFile, assertNoSymlinks, writeNewFile } from '../src/files.mjs';
import { validateId, validateBlobHash, validateManifest, sha256, MAX_MANIFEST_BYTES } from '../src/protocol.mjs';
import { validateServerUrl } from '../src/client.mjs';
import { SyncV2Client } from '../src/sync-client.mjs';
import { createSessionSync } from './session-sync.mjs';
import { createSyncEngine } from '../src/sync-engine.mjs';
import { scanSyncProject, verifySyncRoot, syncRootIdentity, readSyncFile, createSyncApplier, DEFAULT_SYNC_QUOTA } from '../src/sync-local.mjs';
import { canonicalJson, validateSyncManifest, validateSyncPath, validateFileState, fileStateEqual, referencedBlobs, syncManifestDigest } from '../src/sync-protocol.mjs';
import { readExclusionPolicy, validateRestoreDestination } from '../src/snapshot.mjs';
import { createSyncOnboarding, validateOnboarding, onboardingProjection, ONBOARDING_ACTIONS } from './sync-onboarding.mjs';
import { measureSyncStorage, bindingBudget, reserveSyncStorage } from '../src/sync-budget.mjs';
import { probeSyncTree, probeSessionRevisions } from '../src/sync-probe.mjs';
import { reconcileSync, resolveSyncConflict } from '../src/reconcile.mjs';
import { syncFailure as failure, rootKey, within, fileState, accountIdentity, accountKey, projectLabel, planLegacyMigration, uniqueSibling, syncWorkspaceIdle } from './sync-planning.mjs';

export const BIDIRECTIONAL_ACTIONS = Object.freeze(['syncstatus', 'syncprojects', 'pairplan', 'paircommit', 'syncpause', 'syncrun', 'syncconflicts', 'syncresolveplan', 'syncresolve', 'syncrecycle', 'syncrestoreplan', 'syncrestore', 'syncarchives', 'syncarchiveplan', 'syncarchiveimport', 'syncrepairplan', 'syncrepair', 'syncsettings', ...ONBOARDING_ACTIONS]);
const MAX_BINDINGS = 200, MAX_OPERATIONS = 1000, PLAN_TTL = 15 * 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const requireValue = value => { if (!value) throw failure('BAD_REQUEST'); };
const validWorkspace = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const safeCodes = new Set(['BAD_REQUEST', 'BUSY', 'CONFIG_CONFLICT', 'ACCOUNT_BOUND', 'ACCOUNT_MISMATCH', 'NOT_LOGGED_IN', 'PROJECT_UNAVAILABLE', 'PROJECTS_UNAVAILABLE', 'PROJECT_NOT_SELECTED', 'SETTINGS_CORRUPT', 'SETTINGS_FAILED', 'DISPOSED', 'RATE_LIMITED', 'SERVER_UNAVAILABLE', 'UPDATE_RESTART_REQUIRED', 'SYNC_PLAN_EXPIRED', 'SYNC_PLAN_CHANGED', 'SYNC_MANAGED_PROJECT', 'SYNC_CLIENT_UPGRADE_REQUIRED', 'SYNC_MIGRATION_REQUIRED', 'SYNC_LEGACY_HEAD_MISMATCH', 'SYNC_HEAD_MISMATCH', 'SYNC_ROOT_CHANGED', 'SYNC_POLICY_CHANGED', 'SYNC_LOCAL_CHANGED', 'SYNC_QUOTA', 'SYNC_INTEGRITY', 'SYNC_PROJECT_CORRUPT', 'SYNC_METADATA_UNSAFE', 'SYNC_VOLUME_CHANGED', 'SYNC_NOT_IDLE', 'SYNC_BINDING_MISMATCH', 'SYNC_JOURNAL_CORRUPT', 'SYNC_STRUCTURAL_CONFLICT', 'SYNC_UNTRACKED_DELETE', 'SYNC_REMOTE_BLOB_MISSING', 'SYNC_APPLY_INCOMPLETE', 'SYNC_CONFLICT_CHANGED', 'SYNC_CANCELLED', 'SYNC_REPLAN_REQUIRED', 'SYNC_DESTINATION_UNAVAILABLE', 'SYNC_ARCHIVES_UNSUPPORTED', 'SYNC_ARCHIVES_SKIPPED', 'SYNC_IMPORT_UNCERTAIN', 'SYNC_IMPORT_SKIPPED', 'SYNC_IMPORT_UNATTACHED', 'SYNC_REPAIR_INCOMPLETE', 'SYNC_REPAIR_UNAVAILABLE', 'SYNC_REPAIR_CHANGED', 'SYNC_REPAIR_EXPIRED', 'SYNC_COMMIT_UNCERTAIN', 'SYNC_REQUEST_CONFLICT', 'SYNC_CATALOG_CHANGED', 'DIRECTORY_PICKER_UNAVAILABLE', 'DIRECTORY_PICKER_FAILED', 'DIRECTORY_PICKER_EXPIRED', 'DESTINATION_CHANGED', 'BAD_DESTINATION', 'DESTINATION_EXISTS', 'PROTECTED_DESTINATION', 'PROJECT_REGISTRATION_UNCERTAIN', 'CLOUD_PROJECT_EMPTY']);
const codeOf = error => safeCodes.has(error?.code) ? error.code : error?.httpStatus === 401 ? 'NOT_LOGGED_IN' : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'SYNC_CANCELLED' : error?.message === 'fetch failed' ? 'SERVER_UNAVAILABLE' : 'SETTINGS_FAILED';
const compare = (a, b) => canonicalJson(a) === canonicalJson(b);
const nowIso = () => new Date().toISOString();
async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function json(filename, max = 8 * MAX_MANIFEST_BYTES) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readStableFile(filename, max)).bytes)); }
function normalizeIdentity(value) {
  requireValue(object(value) && typeof value.username === 'string' && value.username.length > 0 && value.username.length <= 128 && Number.isSafeInteger(value.authorizationEpoch) && value.authorizationEpoch >= 0);
  return accountIdentity({ ...value, server: validateServerUrl(value.server) });
}
function rootRecord(value, root) {
  requireValue(object(value) && rootKey(value.root) === rootKey(root) && ['dev', 'ino', 'birthtimeNs'].every(key => typeof value[key] === 'string' && /^\d+$/.test(value[key])));
  return { root: path.resolve(value.root), dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}
function safeSummary(value) { return Object.fromEntries(['upload', 'download', 'delete', 'conflicts', 'blocked'].map(name => [name, Number.isSafeInteger(value?.[name]) && value[name] >= 0 ? value[name] : 0])); }

/** Adds opt-in same-directory operations WITHOUT broadening legacy restore or
 * upload consent. Only this Host owns path/account/grant/plan authority.
 */
export function withBidirectionalSync(ctx, controller, legacy, { profileDir, dshHome, isIdle = root => syncWorkspaceIdle(ctx, root), now = Date.now, random = Math.random, enableWatchers = true, planTtlMs = PLAN_TTL, sessionAdapter, onboardingFault } = {}) {
  requireValue(typeof profileDir === 'string' && path.isAbsolute(profileDir));
  const accountStatus = () => legacy.accountStatus ? legacy.accountStatus() : legacy.status();
  const scope = sha256(rootKey(profileDir)).slice(0, 24), directory = controller.store.directory;
  const filename = path.join(directory, `bidirectional-${scope}.json`), intentDirectory = path.join(directory, `bidirectional-intents-${scope}`);
  const protectedRoots = [...new Set([profileDir, dshHome, directory].filter(Boolean).map(value => path.resolve(value)))];
  const plans = new Map(), workers = new Map(), nextChecks = new Map(), failures = new Map(), watches = new Map(), recycleCounts = new Map(), hints = new Map(), dirty = new Set();
  let storageSnapshot = null;
  const life = new AbortController(); let disposed = false, ticking = false;
  const sessionSync = createSessionSync({ ctx, stateDir: directory, ...(sessionAdapter ? { adapter: sessionAdapter } : {}), getIdentity: async () => identityFor(await controller.syncAccount(), await load()),
    // The profile-wide admission below replaces the standalone helper's smaller
    // cache ceiling. Native result/ID journals remain writable for honest cleanup.
    maxCacheBytes: Number.MAX_SAFE_INTEGER, beforeCacheWrite: ({ bytes, check, signal }) => reserveShared(bytes, { check, signal }) });
  const empty = () => ({ version: 2, revision: 0, account: null, capability: 'unknown', quotaBytes: DEFAULT_SYNC_QUOTA, bindings: [], operations: [] });
  function validateConfig(input) {
    requireValue(exact(input, ['version', 'revision', 'account', 'capability', 'quotaBytes', 'bindings', 'operations', 'onboarding']) && input.version === 2 && Number.isSafeInteger(input.revision) && input.revision >= 0 && ['unknown', 'supported', 'upgrade-required'].includes(input.capability));
    requireValue(Number.isSafeInteger(input.quotaBytes) && input.quotaBytes > 0 && Array.isArray(input.bindings) && input.bindings.length <= MAX_BINDINGS && Array.isArray(input.operations) && input.operations.length <= MAX_OPERATIONS);
    const account = input.account === null ? null : normalizeIdentity(input.account), ids = new Set(), workspaceIds = new Set(), projectIds = new Set();
    const bindings = input.bindings.map(item => {
      requireValue(exact(item, ['id', 'workspaceId', 'projectId', 'label', 'root', 'rootIdentity', 'enabled', 'identity', 'enrolling', 'legacyQueueIds', 'authorizedEpochs', 'genesisPending']) && validWorkspace(item.workspaceId) && typeof item.label === 'string' && item.label.length <= 200 && typeof item.root === 'string' && path.isAbsolute(item.root) && typeof item.enabled === 'boolean' && typeof item.enrolling === 'boolean');
      validateId(item.id); validateId(item.projectId);
      requireValue(!ids.has(item.id) && !workspaceIds.has(item.workspaceId) && !projectIds.has(item.projectId)); ids.add(item.id); workspaceIds.add(item.workspaceId); projectIds.add(item.projectId);
      const identity = normalizeIdentity(item.identity); requireValue(account && accountKey(identity) === accountKey(account));
      const authorizedEpochs = item.authorizedEpochs ?? [identity.authorizationEpoch];
      requireValue(Array.isArray(authorizedEpochs) && authorizedEpochs.length > 0 && authorizedEpochs.length <= 1000 && authorizedEpochs.every(epoch => Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= identity.authorizationEpoch) && new Set(authorizedEpochs).size === authorizedEpochs.length && authorizedEpochs.includes(identity.authorizationEpoch));
      requireValue(item.genesisPending === undefined || typeof item.genesisPending === 'boolean');
      const legacyQueueIds = item.legacyQueueIds ?? []; requireValue(Array.isArray(legacyQueueIds) && legacyQueueIds.length <= 100); legacyQueueIds.forEach(validateId);
      return { id: item.id, workspaceId: item.workspaceId, projectId: item.projectId, label: projectLabel(item.label), root: path.resolve(item.root), rootIdentity: rootRecord(item.rootIdentity, item.root), enabled: item.enabled, identity, enrolling: item.enrolling, legacyQueueIds, authorizedEpochs: [...authorizedEpochs], ...(item.genesisPending === undefined ? {} : { genesisPending: item.genesisPending }) };
    });
    const requests = new Set();
    const operations = input.operations.map(item => {
      requireValue(exact(item, ['id', 'kind', 'bindingId', 'account', 'inputHash', 'descriptorHash', 'state', 'phase', 'receipt', 'errorCode', 'at', 'importedCount', 'skippedCount', 'failedCount', 'sessionIds']) && ['pair', 'run', 'resolve', 'restore', 'import', 'repair'].includes(item.kind) && ['running', 'succeeded', 'failed', 'uncertain'].includes(item.state) && typeof item.phase === 'string' && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)));
      validateId(item.id); validateId(item.bindingId); validateBlobHash(item.inputHash); validateBlobHash(item.descriptorHash);
      requireValue(!requests.has(item.id)); requests.add(item.id); normalizeIdentity(item.account);
      for (const field of ['importedCount', 'skippedCount', 'failedCount']) if (item[field] !== undefined) requireValue(Number.isSafeInteger(item[field]) && item[field] >= 0 && item[field] <= 20_000);
      if (item.sessionIds !== undefined) { requireValue(Array.isArray(item.sessionIds) && item.sessionIds.length <= 20_000 && new Set(item.sessionIds).size === item.sessionIds.length); item.sessionIds.forEach(validateId); }
      return { ...item, account: normalizeIdentity(item.account), ...(item.errorCode ? { errorCode: safeCodes.has(item.errorCode) ? item.errorCode : 'SETTINGS_FAILED' } : {}) };
    });
    const onboarding = validateOnboarding(input.onboarding, { normalizeIdentity, rootRecord, safeCodes });
    requireValue(onboarding.every(batch => account && accountKey(batch.account) === accountKey(account) && !operations.some(operation => operation.id === batch.id)));
    return { version: 2, revision: input.revision, account, capability: input.capability, quotaBytes: input.quotaBytes, bindings, operations, ...(input.onboarding ? { onboarding } : {}) };
  }
  async function load() {
    if (disposed) throw failure('DISPOSED');
    if (!(await exists(filename))) return empty();
    try { return validateConfig(await json(filename)); } catch { throw failure('SETTINGS_CORRUPT'); }
  }
  async function save(config) {
    const normalized = validateConfig(config), bytes = Buffer.from(canonicalJson(normalized));
    if (bytes.length > 8 * MAX_MANIFEST_BYTES) throw failure('SYNC_QUOTA');
    await atomicWrite(filename, bytes); return normalized;
  }
  async function usage(config, context = {}) {
    await context.check?.(); life.signal.throwIfAborted();
    const signal = context.signal ? AbortSignal.any([life.signal, context.signal]) : life.signal;
    const unregistered = (config.onboarding ?? []).filter(batch => batch.kind === 'clone').flatMap(batch => batch.items).filter(item => item.rootIdentity && !config.bindings.some(binding => binding.id === item.bindingId)).map(item => ({ id: item.bindingId, root: item.root, rootIdentity: item.rootIdentity }));
    const value = await measureSyncStorage({ stateDir: directory, bindings: [...config.bindings, ...unregistered], signal });
    await context.check?.();
    storageSnapshot = { limitBytes: config.quotaBytes, verified: value.complete, ...(value.complete ? { usedBytes: value.bytes } : {}) };
    return value;
  }
  async function reserveShared(bytes, context = {}) {
    const config = await load();
    reserveSyncStorage({ limit: config.quotaBytes, usage: await usage(config, context), additionalBytes: bytes });
    storageSnapshot = null;
  }
  async function budgetedEngine(binding, context = {}, options = {}) {
    const config = await load(), quotaBytes = bindingBudget({ limit: config.quotaBytes, usage: await usage(config, context), bindingId: binding.id });
    if (quotaBytes <= 0) throw failure('SYNC_QUOTA');
    return engineFor(binding, context, { ...options, quotaBytes });
  }
  async function spoolShared(hash, bytes, context = {}) {
    validateBlobHash(hash); await context.check?.();
    if (!(await exists(path.join(directory, 'blobs', hash)))) await reserveShared(bytes.length, context);
    await context.check?.(); await controller.store.putBlob(hash, bytes);
  }
  async function allProtected() {
    const result = new Set(protectedRoots);
    for (const root of protectedRoots) { try { result.add(await fs.realpath(root)); } catch (error) { if (error.code !== 'ENOENT') throw failure('PROJECT_UNAVAILABLE'); } }
    return [...result];
  }
  const registry = () => { const value = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry'); if (!value?.list || !value?.get) throw failure('PROJECTS_UNAVAILABLE'); return value; };
  async function exclusions(root) {
    const key = rootKey(root), roots = await allProtected();
    if (roots.some(item => within(key, rootKey(item)))) throw failure('PROJECT_UNAVAILABLE');
    return roots.filter(item => within(rootKey(item), key)).map(item => path.relative(root, item).split(path.sep).join('/'));
  }
  async function workspace(id, suppliedConfig) {
    requireValue(validWorkspace(id)); const item = registry().get(id);
    if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw failure('PROJECT_UNAVAILABLE');
    const root = path.resolve(item.path);
    if ((suppliedConfig ?? await load()).onboarding?.some(batch => batch.kind === 'clone' && batch.items.some(value => value.state !== 'succeeded' && (within(rootKey(root), rootKey(value.root)) || within(rootKey(value.root), rootKey(root)))))) throw failure('SYNC_APPLY_INCOMPLETE');
    await exclusions(root); await assertNoSymlinks(root);
    if (!(await fs.lstat(root)).isDirectory()) throw failure('PROJECT_UNAVAILABLE');
    return { id, root, label: projectLabel(item.title || path.basename(root)) };
  }
  async function workspaces() {
    const rows = [], items = registry().list(), config = await load(); requireValue(Array.isArray(items));
    for (const item of items.slice(0, MAX_BINDINGS)) {
      if (!validWorkspace(item.id) || typeof item.path !== 'string' || !path.isAbsolute(item.path)) continue;
      let available = true; try { await workspace(item.id, config); } catch { available = false; }
      rows.push({ id: item.id, root: path.resolve(item.path), label: projectLabel(item.title || path.basename(item.path)), available });
    }
    return rows;
  }
  async function identityFor(grant, config, client) {
    let serverId = grant.serverId;
    if (!serverId && client) serverId = (await client.capabilities()).serverId;
    serverId ||= config.account?.serverId;
    if (!serverId) throw failure('SYNC_CLIENT_UPGRADE_REQUIRED');
    const value = accountIdentity(grant, serverId);
    if (config.account && (config.bindings.length || config.operations.length || config.onboarding?.length) && accountKey(config.account) !== accountKey(value)) throw failure('ACCOUNT_BOUND');
    return value;
  }
  async function payloadIdentity(input, fields, { allowSignedOut = false } = {}) {
    requireValue(exact(input, ['revision', 'server', 'username', ...fields]) && Number.isSafeInteger(input.revision) && input.revision >= 0 && typeof input.server === 'string' && typeof input.username === 'string');
    requireValue(validateServerUrl(input.server) === input.server);
    const config = await load(), base = await accountStatus();
    if (config.revision !== input.revision) throw failure('CONFIG_CONFLICT');
    if (input.server !== base.server || input.username !== base.username) throw failure('ACCOUNT_MISMATCH');
    if (!base.loggedIn && !allowSignedOut) throw failure('NOT_LOGGED_IN');
    return config;
  }
  function bindingFor(config, id) { validateId(id); const binding = config.bindings.find(item => item.id === id); if (!binding) throw failure('PROJECT_UNAVAILABLE'); return binding; }
  function authorizedTask(binding, operation) {
    return accountKey(binding.identity) === accountKey(operation.account) && (binding.authorizedEpochs ?? [binding.identity.authorizationEpoch]).includes(operation.account.authorizationEpoch);
  }
  async function resolutionReady(binding, context = {}, quotaBytes) {
    if ((await engineFor(binding, context, { quotaBytes }).status()).phase) throw failure('SYNC_APPLY_INCOMPLETE');
  }
  async function admitBinding(binding, { identity: expected, allowPaused = false, allowReauthorize = false, allowGenesis = false, nextIdentity } = {}) {
    life.signal.throwIfAborted(); const config = await load(), saved = bindingFor(config, binding.id);
    if (saved.genesisPending && !allowGenesis) throw failure('SYNC_COMMIT_UNCERTAIN');
    if (!allowPaused && !saved.enabled) throw failure('PROJECT_NOT_SELECTED');
    if (saved.workspaceId !== binding.workspaceId || saved.projectId !== binding.projectId || rootKey(saved.root) !== rootKey(binding.root) || !compare(saved.rootIdentity, binding.rootIdentity)) throw failure('SYNC_BINDING_MISMATCH');
    const currentWorkspace = await workspace(saved.workspaceId);
    if (rootKey(currentWorkspace.root) !== rootKey(saved.root)) throw failure('SYNC_ROOT_CHANGED');
    await verifySyncRoot(saved.rootIdentity);
    const grant = await controller.syncAccount(), current = await identityFor(grant, config);
    if (accountKey(current) !== accountKey(saved.identity) || expected && accountKey(current) !== accountKey(expected)) throw failure('ACCOUNT_MISMATCH');
    if (!allowReauthorize && current.authorizationEpoch !== saved.identity.authorizationEpoch) throw failure('NOT_LOGGED_IN');
    if (allowReauthorize && nextIdentity && !compare(current, nextIdentity)) throw failure('ACCOUNT_MISMATCH');
    return { config, binding: saved, grant, identity: current };
  }
  function clientFor(grant, config, signal) { return new SyncV2Client({ ...grant, serverId: grant.serverId ?? config.account?.serverId, signal, timeoutMs: 60_000 }); }
  function engineFor(binding, context = {}, options = {}) {
    return createSyncEngine({ directory, bindingId: binding.id, projectId: binding.projectId, root: binding.root, accountIdentity: binding.identity, quotaBytes: options.quotaBytes ?? DEFAULT_SYNC_QUOTA,
      signal: context.signal ?? life.signal, isIdle: () => isIdle(binding.root), getExcludedPaths: () => exclusions(binding.root), captureArchives: options => sessionSync.captureArchives(options),
      getClient: options.getClient ?? (async () => { const config = await load(); return clientFor(await controller.syncAccount(), config, context.signal ?? life.signal); }),
      check: async event => {
        if (context.bindingId && context.bindingId !== binding.id) throw failure('SYNC_BINDING_MISMATCH');
        await context.check?.();
        // The hot path's controller check already invokes this exact binding's
        // live admission. Avoid re-reading the same preference/grant/root twice.
        if (context.bindingId === binding.id && context.check && !options.allowPaused && !options.allowReauthorize) return;
        await admitBinding(binding, { identity: context.identity, allowPaused: options.allowPaused, allowReauthorize: options.allowReauthorize, nextIdentity: event.nextAccountIdentity });
      } });
  }
  function headMatches(a, b) { return Boolean(a && b && ['projectId', 'id', 'revision', 'manifestDigest', 'recordHash'].every(key => a[key] === b[key])); }
  async function probes(binding, context) {
    await context.check();
    const tree = await probeSyncTree({ root: binding.root, excludedPaths: await exclusions(binding.root), signal: context.signal });
    const sessions = await probeSessionRevisions(ctx, binding.root, { signal: context.signal });
    await context.check(); return { tree, sessions };
  }
  async function periodic(binding, context, config) {
    const scoped = { ...context, bindingId: binding.id }, identity = sha256(canonicalJson({ identity: binding.identity, rootIdentity: binding.rootIdentity, revision: config.revision }));
    const previous = hints.get(binding.id), status = await engineFor(binding, scoped).status();
    const healthy = status.state === 'synced' && !status.phase && !status.repair && !status.conflicts;
    let before;
    if (previous?.identity === identity && !previous.errorCode && healthy && !dirty.has(binding.id) && now() - previous.fullAt < 300_000) {
      // Local metadata is only a bounded hint. A changed remote head ALWAYS uses
      // the full scanner and conditional applier, regardless of this hint.
      const tree = now() - previous.probedAt < 30_000 ? previous.tree : await probeSyncTree({ root: binding.root, excludedPaths: await exclusions(binding.root), signal: context.signal });
      const sessions = await probeSessionRevisions(ctx, binding.root, { signal: context.signal }); await context.check();
      before = { tree, sessions };
      if (!tree.uncertain && !sessions.uncertain && tree.fingerprint === previous.tree.fingerprint && sessions.fingerprint === previous.sessions.fingerprint) {
        const client = clientFor(context.identity, config, context.signal); let head;
        try { await client.capabilities(); head = await client.syncHead(binding.projectId); await context.check(); }
        catch (error) {
          const code = codeOf(error);
          if (code === 'NOT_LOGGED_IN') await controller.requireSyncReauthentication?.({ expectedIdentity: context.identity });
          hints.set(binding.id, { ...previous, errorCode: code });
          return { ...status, state: code === 'NOT_LOGGED_IN' || code === 'ACCOUNT_MISMATCH' ? 'blocked' : 'offline', errorCode: code };
        }
        if (headMatches(head, status.head)) {
          const checkedAt = nowIso(); hints.set(binding.id, { ...previous, tree, sessions, probedAt: tree === previous.tree ? previous.probedAt : now(), checkedAt });
          return { ...status, lastCheckedAt: checkedAt, metadataOnly: true };
        }
      }
    }
    before ??= await probes(binding, context);
    dirty.delete(binding.id);
    const result = await (await budgetedEngine(binding, scoped)).run();
    const after = result.state === 'synced' && !result.phase && !result.conflicts ? await probes(binding, context) : null;
    if (after && !dirty.has(binding.id) && !before.tree.uncertain && !before.sessions.uncertain && !after.tree.uncertain && !after.sessions.uncertain && before.tree.fingerprint === after.tree.fingerprint && before.sessions.fingerprint === after.sessions.fingerprint) {
      hints.set(binding.id, { identity, tree: after.tree, sessions: after.sessions, fullAt: now(), probedAt: now(), checkedAt: result.lastCheckedAt });
    } else hints.delete(binding.id);
    // No cache hint is ever persisted as a content proof or used to advance bases.
    try { await usage(await load(), context); } catch { storageSnapshot = null; }
    return result;
  }
  async function policyFor(root) { return readExclusionPolicy(root, { excluded: ['.dsh-syncignore', '**/.dsh-syncignore'], excludedPaths: await exclusions(root) }); }
  function putPlan(plan) {
    for (const [id, value] of plans) if (value.until <= now()) plans.delete(id);
    if (plans.size >= 100) throw failure('SYNC_QUOTA');
    const id = randomUUID(), value = { ...plan, id, until: now() + planTtlMs };
    plans.set(id, value); return value;
  }
  function getPlan(id, kind) {
    validateId(id); const plan = plans.get(id);
    if (!plan || plan.kind !== kind || plan.until <= now()) throw failure('SYNC_PLAN_EXPIRED');
    return plan;
  }
  function planBinding(input, plan, identity) {
    if (plan.revision !== input.revision || plan.server !== input.server || plan.username !== input.username || !compare(plan.identity, identity)) throw failure('SYNC_PLAN_CHANGED');
  }
  const intentPath = id => path.join(intentDirectory, `${sha256(validateId(id))}.json`);
  async function descriptorFor(operation) {
    const { bytes } = await readStableFile(intentPath(operation.id), 8 * MAX_MANIFEST_BYTES);
    if (sha256(bytes) !== operation.descriptorHash) throw failure('SETTINGS_CORRUPT');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value) || value.version !== 1 || value.id !== operation.id || value.kind !== operation.kind || value.bindingId !== operation.bindingId || !compare(value.account, operation.account)) throw failure('SETTINGS_CORRUPT');
    return value;
  }
  async function accept(config, input, descriptor, binding) {
    validateId(input.requestId);
    if (config.onboarding?.some(batch => batch.id === input.requestId)) throw failure('SYNC_REQUEST_CONFLICT');
    const digest = sha256(canonicalJson(input)), prior = config.operations.find(item => item.id === input.requestId);
    if (prior) { if (prior.inputHash !== digest || accountKey(prior.account) !== accountKey(descriptor.account)) throw failure('SYNC_PLAN_CHANGED'); return config; }
    if (config.operations.length >= MAX_OPERATIONS) throw failure('SYNC_QUOTA');
    const bytes = Buffer.from(canonicalJson(descriptor)), target = intentPath(input.requestId);
    if (!(await exists(target))) await reserveShared(bytes.length);
    try { await writeNewFile(target, bytes); }
    catch (error) { if (error.code !== 'EEXIST' || !(await readStableFile(target, 8 * MAX_MANIFEST_BYTES)).bytes.equals(bytes)) throw error; }
    const operation = { id: input.requestId, kind: descriptor.kind, bindingId: descriptor.bindingId, account: descriptor.account, inputHash: digest, descriptorHash: sha256(bytes), state: 'running', phase: 'accepted', at: nowIso() };
    return save({ ...config, ...(binding ? { revision: config.revision + 1, account: config.account ?? binding.identity, capability: 'supported', bindings: [...config.bindings.filter(item => item.id !== binding.id), binding] } : {}), operations: [...config.operations, operation] });
  }
  async function replay(input, kind) {
    requireValue(object(input) && typeof input.requestId === 'string'); validateId(input.requestId);
    const config = await load(), operation = config.operations.find(item => item.id === input.requestId);
    if (!operation) return false;
    const grant = await controller.syncAccount();
    if (operation.kind !== kind || operation.inputHash !== sha256(canonicalJson(input)) || operation.account.server !== grant.server || operation.account.username !== grant.username || operation.account.deviceId !== grant.deviceId) throw failure('SYNC_PLAN_CHANGED');
    return true;
  }
  async function updateOperation(id, patch) {
    const config = await load(), operation = config.operations.find(item => item.id === id);
    if (!operation) throw failure('SETTINGS_CORRUPT');
    Object.assign(operation, patch, { at: nowIso() });
    if (Object.hasOwn(patch, 'errorCode') && patch.errorCode === null) delete operation.errorCode;
    await save(config); return operation;
  }
  async function scan(root, projectId, identity, check, signal) {
    return scanSyncProject({ root, projectId, deviceId: identity.deviceId, signal, check, excludedPaths: await exclusions(root), putBlob: (hash, bytes) => spoolShared(hash, bytes, { check, signal }) });
  }
  function scanDigest(value) { return sha256(canonicalJson(value.files)); }
  async function pinnedHead(client, projectId, expected) {
    const current = await client.syncHead(projectId);
    if (!compare(current, expected)) throw failure('SYNC_HEAD_MISMATCH');
    return current;
  }
  async function verifyLocal(binding, expected, check) {
    await check();
    for (const item of expected) {
      validateSyncPath(item.path); validateFileState(item.state);
      if (!(await policyFor(binding.root)).isExcluded(item.path) && fileStateEqual(await readSyncFile(binding.root, item.path, item.state), item.state)) continue;
      throw failure('SYNC_LOCAL_CHANGED');
    }
    await check();
  }
  async function uploadRequest(client, request, allowedHashes, check) {
    const refs = referencedBlobs(request.manifest), missing = await client.missingBlobs(refs), sizes = new Map(refs.map(item => [item.hash, item.size]));
    for (const hash of missing) {
      await check(); if (!allowedHashes.includes(hash)) throw failure('SYNC_REMOTE_BLOB_MISSING');
      const bytes = await controller.store.getBlob(hash); if (bytes.length !== sizes.get(hash)) throw failure('SYNC_INTEGRITY');
      await check(); await client.uploadBlob(hash, bytes);
    }
  }
  async function commitDescriptor(operation, descriptor, context, binding) {
    const config = await load(), client = clientFor(context.identity, config, context.signal), request = descriptor.request;
    let receipt = operation.receipt ?? await client.syncReceipt(binding.projectId, request.requestId);
    const check = async () => {
      await context.check(); await admitBinding(binding, { identity: context.identity });
      if ((await policyFor(binding.root)).fingerprint !== descriptor.policyHash) throw failure('SYNC_POLICY_CHANGED');
      if (descriptor.resolution) await resolutionReady(binding, context, config.quotaBytes);
    };
    if (!receipt) {
      await check();
      if (descriptor.expectedLocal) await verifyLocal(binding, descriptor.expectedLocal, check);
      await uploadRequest(client, request, descriptor.allowedHashes ?? [], check);
      await check(); await updateOperation(operation.id, { phase: 'committing' }); await check();
      receipt = descriptor.migration ? await client.migrateSync(request) : await client.commitSync(request);
    }
    if (receipt.id !== request.manifest.id || receipt.projectId !== binding.projectId || receipt.manifestDigest !== syncManifestDigest(request.manifest) || receipt.requestId !== request.requestId) throw failure('SYNC_INTEGRITY');
    await updateOperation(operation.id, { receipt, phase: 'remote-accepted' });
    return receipt;
  }
  async function archiveAdmission(binding, expectedIdentity) {
    const config = await load(), grant = await controller.syncAccount(), current = await identityFor(grant, config);
    if (expectedIdentity && !compare(current, expectedIdentity)) throw failure('ACCOUNT_MISMATCH');
    await admitBinding(binding, { allowPaused: true, allowReauthorize: true, nextIdentity: current });
    return current;
  }
  function importOutcome(result) {
    const ids = [...new Set(result.sessionIds ?? [])]; ids.forEach(validateId);
    const importedCount = result.imported?.length ?? 0, skippedCount = result.skipped?.length ?? 0, failedCount = result.failed?.length ?? 0;
    const unattached = result.imported?.some(item => item.workspaceAttached !== true);
    const success = result.state === 'imported' && !failedCount && !unattached;
    return { state: success ? 'succeeded' : 'failed', phase: result.state === 'uncertain' ? 'import-uncertain' : result.state === 'skipped' ? 'import-skipped' : 'import-finished', importedCount, skippedCount, failedCount, sessionIds: ids,
      errorCode: success ? null : result.state === 'uncertain' || failedCount ? 'SYNC_IMPORT_UNCERTAIN' : unattached ? 'SYNC_IMPORT_UNATTACHED' : 'SYNC_IMPORT_SKIPPED' };
  }
  async function executeArchive(operation, descriptor, binding, context) {
    const config = await load(), identity = await identityFor(context.identity, config);
    await archiveAdmission(binding, descriptor.account);
    const check = async () => { await context.check(); await archiveAdmission(binding, descriptor.account); if (!(await isIdle(binding.root))) throw failure('SYNC_NOT_IDLE'); };
    // A reserved native ID is a terminal uncertainty, never permission to call a
    // provider twice. Lookup is local-only and also works when a prior ACK was lost.
    let result = await sessionSync.lookupImport({ root: binding.root, projectId: binding.projectId, archiveId: descriptor.archive.archiveId, identity, check, signal: context.signal });
    if (!result) {
      if (operation.phase === 'importing') throw failure('SYNC_IMPORT_UNCERTAIN');
      const client = clientFor(context.identity, config, context.signal);
      const manifest = await client.syncCheckpoint(binding.projectId, descriptor.archive.checkpointId, descriptor.archive.manifestDigest);
      const plan = await sessionSync.prepareImport({ root: binding.root, projectId: binding.projectId, archiveId: descriptor.archive.archiveId, manifest, client, identity, check, signal: context.signal });
      if (plan.wrapperDigest !== descriptor.archive.wrapperDigest) throw failure('SYNC_INTEGRITY');
      await check(); await updateOperation(operation.id, { phase: 'importing' }); await check();
      result = await sessionSync.importArchive({ plan, requestId: operation.id, identity, check, signal: context.signal });
    }
    await updateOperation(operation.id, importOutcome(result));
    try { await usage(await load(), context); } catch { storageSnapshot = null; }
    return result;
  }
  async function taskBody(id, context) {
    let config = await load(), operation = config.operations.find(item => item.id === id);
    if (!operation || operation.state === 'succeeded') return;
    const descriptor = await descriptorFor(operation), binding = bindingFor(config, operation.bindingId);
    if (descriptor.kind === 'import' ? accountKey(binding.identity) !== accountKey(descriptor.account) : !authorizedTask(binding, descriptor)) throw failure('ACCOUNT_MISMATCH');
    let result;
    try {
      await context.check();
      if (descriptor.kind === 'import') return await executeArchive(operation, descriptor, binding, context);
      if (descriptor.kind === 'repair') {
        await updateOperation(operation.id, { phase: 'repairing' });
        const repaired = await (await budgetedEngine(binding, context)).confirmReplan({ planId: descriptor.repairPlanId, requestId: operation.id });
        if (repaired.superseded) { await updateOperation(operation.id, { state: 'failed', phase: 'superseded', errorCode: 'SYNC_PLAN_CHANGED' }); return; }
        recycleCounts.delete(binding.id);
      }
      if (descriptor.request) {
        const receipt = await commitDescriptor(operation, descriptor, context, binding);
        if (descriptor.resolution) await (await budgetedEngine(binding, context)).acknowledgeResolution({ receipt, ...descriptor.resolution });
      }
      result = await (await budgetedEngine(binding, context)).run();
      if (result.errorCode === 'NOT_LOGGED_IN') await controller.requireSyncReauthentication?.({ expectedIdentity: context.identity });
      config = await load();
      const current = config.operations.find(item => item.id === id), currentBinding = bindingFor(config, binding.id);
      const success = ['synced', 'conflicted', 'deferred'].includes(result.state);
      current.state = success ? 'succeeded' : result.state === 'uncertain' ? 'uncertain' : 'failed';
      current.phase = result.state; if (result.errorCode) current.errorCode = safeCodes.has(result.errorCode) ? result.errorCode : 'SETTINGS_FAILED';
      if (success || result.head) currentBinding.enrolling = false;
      current.at = nowIso(); await save(config);
      scheduleNext(binding.id, result);
      try { await usage(config, context); } catch { storageSnapshot = null; }
    } catch (error) {
      const code = codeOf(error);
      if (code === 'NOT_LOGGED_IN') await controller.requireSyncReauthentication?.({ expectedIdentity: context.identity });
      let repairOutcome;
      if (descriptor.kind === 'repair') try { repairOutcome = await engineFor(binding, {}, { allowPaused: true, quotaBytes: config.quotaBytes }).repairOutcome(id); } catch { /* Unverifiable is not non-acceptance. */ }
      const latest = await load(), item = latest.operations.find(row => row.id === id);
      if (item) {
        const unknown = repairOutcome?.state === 'not-accepted' ? false : ['committing', 'remote-accepted', 'repairing'].includes(item.phase) && ![400, 401, 403, 409, 413, 415, 422, 426, 429].includes(error.httpStatus);
        item.state = unknown ? 'uncertain' : 'failed'; item.errorCode = code;
        if (repairOutcome?.state === 'completed') { item.state = 'succeeded'; item.phase = 'repair-finished'; delete item.errorCode; }
        if (repairOutcome?.state === 'superseded') { item.state = 'failed'; item.phase = 'superseded'; item.errorCode = 'SYNC_PLAN_CHANGED'; }
        item.at = nowIso(); await save(latest);
      }
      scheduleNext(binding.id, { state: 'blocked', errorCode: code });
    }
    return result;
  }
  function startTask(id) {
    if (disposed || workers.has(id)) return;
    const task = (async () => {
      const config = await load(), operation = config.operations.find(item => item.id === id);
      if (!operation || operation.state === 'succeeded') return;
      const binding = bindingFor(config, operation.bindingId); hints.delete(binding.id);
      await controller.runSyncOperation(context => taskBody(id, { ...context, bindingId: binding.id }), { signal: life.signal, checkBinding: () => operation.kind === 'import' ? archiveAdmission(binding, operation.account) : admitBinding(binding) });
    })().catch(() => { /* Admission was not accepted: durable task remains visible, never replayed blindly. */ }).finally(() => workers.delete(id));
    workers.set(id, task);
  }
  function scheduleNext(id, result) {
    if (result.summary?.download || result.summary?.delete) recycleCounts.delete(id);
    if (!result.phase && ['SYNC_LOCAL_CHANGED', 'SYNC_POLICY_CHANGED'].includes(result.errorCode)) { nextChecks.set(id, now() + 5000); return; }
    if (['offline', 'uncertain'].includes(result.state) || ['SERVER_UNAVAILABLE', 'RATE_LIMITED'].includes(result.errorCode)) {
      const count = Math.min(10, (failures.get(id) ?? 0) + 1); failures.set(id, count);
      nextChecks.set(id, now() + Math.min(300_000, 5000 * 2 ** (count - 1)) * (0.8 + random() * 0.4));
    } else if (result.state === 'blocked' && !['BUSY', 'SYNC_NOT_IDLE', 'CONFIG_CONFLICT', 'SYNC_CANCELLED'].includes(result.errorCode)) nextChecks.set(id, Infinity);
    else { failures.delete(id); nextChecks.set(id, now() + (result.state === 'deferred' ? 5000 : 15_000)); }
  }
  function refreshWatches(config) {
    for (const [id, watcher] of watches) if (!config.bindings.some(item => item.id === id && item.enabled)) { watcher.close(); watches.delete(id); }
    if (!enableWatchers) return;
    for (const binding of config.bindings.filter(item => item.enabled)) if (!watches.has(binding.id)) {
      try {
        const watcher = watch(binding.root, { recursive: true }, (_event, value) => {
          const relative = value?.toString().split(path.sep).join('/');
          if (relative && (relative.startsWith('.dsh-sync/') || relative === '.dsh-sync')) return;
          dirty.add(binding.id);
          if (!failures.has(binding.id)) nextChecks.set(binding.id, now() + 1000);
        });
        watcher.on('error', () => { watcher.close(); watches.delete(binding.id); }); watcher.unref?.(); watches.set(binding.id, watcher);
      } catch { /* Unsupported watching falls back to bounded periodic scans. */ }
    }
  }
  async function onboardingRoots({ ownedItemId } = {}) {
    const config = await load(), values = [...await allProtected(), ...registry().list().map(item => item.path), ...controller.config.projects.map(item => item.root), ...config.bindings.map(item => item.root), ...(config.onboarding ?? []).flatMap(batch => batch.items).filter(item => item.id !== ownedItemId).map(item => item.root)];
    // Retained unselected legacy mappings still protect their old roots. These
    // reads happen only during explicit onboarding, not on catalog/status polls.
    if (legacy.filename && await exists(legacy.filename)) {
      const retained = await json(legacy.filename, 1024 * 1024);
      if (!Array.isArray(retained.bindings)) throw failure('SETTINGS_CORRUPT');
      values.push(...retained.bindings.map(item => item.root));
    }
    return [...new Set(values.filter(value => typeof value === 'string' && path.isAbsolute(value)))];
  }
  async function admitOnboardingParent(parent) {
    const key = rootKey(parent);
    const sensitive = new Set(['.dsh', '.dsh-sync', '.ssh', '.aws', '.azure', '.gnupg', '.credentials', 'node_modules']);
    if (path.basename(parent).startsWith('.') || parent.split(/[\\/]/).some(part => sensitive.has(part.toLowerCase()))) throw failure('PROTECTED_DESTINATION');
    for (const root of await onboardingRoots()) {
      if (within(key, rootKey(root))) throw failure('PROTECTED_DESTINATION');
      try { if (within(key, rootKey(await fs.realpath(root)))) throw failure('PROTECTED_DESTINATION'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const onboarding = createSyncOnboarding(ctx, { controller, load, save, payloadIdentity, identityFor, clientFor, putPlan, getPlan, planBinding, intentPath, reserveShared, workspace, policyFor, exclusions, registry, isIdle, life, now, codeOf, fault: onboardingFault,
    scanPreview: async (root, projectId, identity, check, signal) => scanSyncProject({ root, projectId, deviceId: identity.deviceId, signal, check, excludedPaths: await exclusions(root), putBlob: async () => {} }),
    admitParent: admitOnboardingParent,
    admitDestination: async (root, options) => validateRestoreDestination(root, await onboardingRoots(options)),
    async bootstrap(item, context, options) {
      const config = await load(), quotaBytes = bindingBudget({ limit: config.quotaBytes, usage: await usage(config, context), bindingId: item.bindingId });
      if (quotaBytes <= 0) throw failure('SYNC_QUOTA');
      const engine = createSyncEngine({ directory, bindingId: item.bindingId, projectId: item.projectId, root: item.root, accountIdentity: item.identity, signal: context.signal, quotaBytes, isIdle: () => isIdle(item.root), getExcludedPaths: () => exclusions(item.root), check: context.check, getClient: async () => clientFor(await controller.syncAccount(), await load(), context.signal) });
      try { return await engine.bootstrap(options); } finally { storageSnapshot = null; }
    },
    async publish(item, identity, context) {
      await context.check(); const local = await workspace(item.workspaceId); await verifySyncRoot(item.rootIdentity);
      if (rootKey(local.root) !== rootKey(item.root)) throw failure('SYNC_ROOT_CHANGED');
      const captured = await scanSyncProject({ root: item.root, projectId: item.projectId, deviceId: identity.deviceId, signal: context.signal, check: context.check, excludedPaths: await exclusions(item.root), putBlob: async () => {} });
      if (captured.policyHash !== item.policyHash || scanDigest(captured) !== item.localDigest) throw failure('SYNC_PLAN_CHANGED');
      const binding = { id: item.bindingId, workspaceId: item.workspaceId, projectId: item.projectId, root: item.root, label: item.label, rootIdentity: item.rootIdentity, enabled: true, enrolling: true, genesisPending: true, identity, legacyQueueIds: [], authorizedEpochs: [identity.authorizationEpoch] };
      await legacy.pauseLegacyWorkspace?.(item.workspaceId); await context.check();
      let config = await load();
      if (config.bindings.some(value => value.workspaceId === binding.workspaceId || value.projectId === binding.projectId || within(rootKey(value.root), rootKey(binding.root)) || within(rootKey(binding.root), rootKey(value.root)))) throw failure('SYNC_MANAGED_PROJECT');
      await save({ ...config, revision: config.revision + 1, bindings: [...config.bindings, binding] });
      const scoped = { ...context, bindingId: binding.id, check: async () => { await context.check(); await admitBinding(binding, { allowGenesis: true }); } };
      // A publish selection authorizes a NEW cloud project, never adoption of a
      // surprise head/legacy history at its newly allocated ID (including CAS races).
      const client = clientFor(context.identity, config, context.signal); let ownedHead;
      const fresh = new Proxy(client, { get(target, property) {
        if (property === 'syncHead') return async projectId => { const head = await target.syncHead(projectId); if (head && (!ownedHead || !headMatches(head, ownedHead))) throw failure('SYNC_HEAD_MISMATCH'); return head; };
        if (property === 'legacyHeads') return async projectId => { const value = await target.legacyHeads(projectId); if (value.heads.length || value.checkpointCount) throw failure('SYNC_MIGRATION_REQUIRED'); return value; };
        if (property === 'commitSync') return async request => { if (request.expectedHeadId !== null || request.expectedHeadRevision !== 0) throw failure('SYNC_HEAD_MISMATCH'); return ownedHead = await target.commitSync(request); };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      let result;
      try { result = await (await budgetedEngine(binding, scoped, { getClient: async () => fresh })).run(); }
      catch (error) { result = { state: 'blocked', errorCode: codeOf(error) }; }
      config = await load(); const saved = bindingFor(config, binding.id);
      const provedGenesis = ownedHead && ownedHead.revision === 1 && headMatches(result.head, ownedHead);
      if (!result.head && ['SYNC_HEAD_MISMATCH', 'SYNC_MIGRATION_REQUIRED'].includes(result.errorCode)) config.bindings = config.bindings.filter(value => value.id !== binding.id);
      else if (provedGenesis) { saved.genesisPending = false; saved.enrolling = false; saved.enabled = ['synced', 'conflicted', 'deferred'].includes(result.state); }
      else {
        // Offline/deferred/unknown first publication is NOT an ordinary pairing.
        // Its durable genesis fence survives restart, resume and old pair APIs.
        // Preserve the engine's receipt/proposal journal for explicit inspection;
        // never switch an unproved create-only consent into general reconciliation.
        saved.genesisPending = true; saved.enrolling = true; saved.enabled = false;
        result = { ...result, state: result.state === 'uncertain' ? 'uncertain' : 'blocked', errorCode: 'SYNC_COMMIT_UNCERTAIN' };
      }
      await save(config); storageSnapshot = null; return result;
    },
  });
  const service = {
    ...legacy,
    status: accountStatus,
    ...onboarding.actions,
    async syncstatus(input = {}) {
      requireValue(exact(input, []));
      const config = await load(), base = await accountStatus(); let grant;
      try { grant = await controller.syncAccount(); } catch {}
      const compatible = !config.account || config.account.server === base.server && config.account.username === base.username && (!grant || config.account.deviceId === grant.deviceId);
      const bindings = [];
      for (const binding of compatible ? config.bindings : []) {
        let state = { state: binding.enabled ? 'idle' : 'paused', pendingUpload: 0, pendingDownload: 0, conflicts: 0 }, recycleCount = 0;
        const authorized = Boolean(base.loggedIn && grant && (grant.authorizationEpoch ?? 0) === binding.identity.authorizationEpoch);
        try { state = await engineFor(binding, {}, { allowPaused: true, quotaBytes: config.quotaBytes }).status(); }
        catch (error) { state = { ...state, state: 'blocked', errorCode: codeOf(error) }; }
        const hint = hints.get(binding.id);
        if (state.state === 'synced' && hint?.identity === sha256(canonicalJson({ identity: binding.identity, rootIdentity: binding.rootIdentity, revision: config.revision }))) {
          if (hint.checkedAt) state.lastCheckedAt = hint.checkedAt;
          if (hint.errorCode) state = { ...state, state: hint.errorCode === 'NOT_LOGGED_IN' ? 'blocked' : 'offline', errorCode: hint.errorCode };
        }
        if (!authorized) state = { ...state, state: base.loggedIn ? 'paused' : 'needs-login' };
        else if (!binding.enabled) state = { ...state, state: 'paused' };
        if (binding.genesisPending) state = { ...state, state: 'blocked', errorCode: 'SYNC_COMMIT_UNCERTAIN' };
        if (authorized && !base.running) try {
          const cached = recycleCounts.get(binding.id);
          if (cached && now() - cached.at < 300_000) recycleCount = cached.count;
          else if (await exists(path.join(binding.root, '.dsh-sync', 'v2', binding.id))) {
            const applier = await createSyncApplier({ root: binding.root, bindingId: binding.id, projectId: binding.projectId, signal: life.signal, check: () => admitBinding(binding, { allowPaused: true }) });
            // Idle status lists metadata only; explicit recycle reads/imports still
            // verify every byte. Do not rehash gigabytes on every GUI poll.
            recycleCount = (await applier.recycle({ verifyContents: false })).length;
            recycleCounts.set(binding.id, { at: now(), count: recycleCount });
          }
        } catch {}
        bindings.push({ id: binding.id, workspaceId: binding.workspaceId, projectId: binding.projectId, label: binding.label, root: binding.root, enabled: authorized && binding.enabled, state: state.state, repairable: Boolean(state.phase || state.repair) && ['SYNC_LOCAL_CHANGED', 'SYNC_REPLAN_REQUIRED', 'SYNC_APPLY_INCOMPLETE', 'SYNC_REPAIR_INCOMPLETE'].includes(state.errorCode), pendingUpload: state.pendingUpload ?? 0, pendingDownload: state.pendingDownload ?? 0, conflicts: state.conflicts ?? 0, recycleCount, archives: state.archives ?? 0, skippedArchives: state.skippedArchives ?? 0, ...(['SYNC_ARCHIVES_UNSUPPORTED', 'SYNC_ARCHIVES_SKIPPED'].includes(state.warningCode) ? { warningCode: state.warningCode } : {}), ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}), ...(state.lastSyncedAt ? { lastSyncedAt: state.lastSyncedAt } : {}), ...(state.errorCode ? { errorCode: safeCodes.has(state.errorCode) ? state.errorCode : 'SETTINGS_FAILED' } : {}) });
      }
      const operations = compatible ? config.operations.slice(-30).map(item => {
        const { id, kind, state, bindingId, errorCode } = item;
        const expiredImport = kind === 'import' && ['running', 'uncertain'].includes(state) && !workers.has(id) && grant && (grant.authorizationEpoch ?? 0) !== item.account.authorizationEpoch;
        return { id, kind, state: expiredImport ? 'failed' : state, bindingId, ...(expiredImport ? { errorCode: 'SYNC_IMPORT_UNCERTAIN' } : errorCode ? { errorCode } : {}),
          ...Object.fromEntries(['importedCount', 'skippedCount', 'failedCount', 'sessionIds'].filter(key => item[key] !== undefined).map(key => [key, item[key]])) };
      }) : [];
      return { revision: config.revision, server: base.server, username: base.username, loggedIn: base.loggedIn, capability: compatible ? config.capability : 'unknown', running: base.running || workers.size > 0 || onboarding.running, workspaces: await workspaces(), bindings, operations, onboarding: compatible ? onboardingProjection(config.onboarding ?? []) : [], storage: compatible && storageSnapshot?.limitBytes === config.quotaBytes ? { ...storageSnapshot } : { limitBytes: config.quotaBytes, verified: false } };
    },
    async syncsettings(input) {
      await payloadIdentity(input, ['quotaBytes']);
      const gib = 1024 ** 3;
      requireValue(Number.isSafeInteger(input.quotaBytes) && input.quotaBytes >= gib && input.quotaBytes <= 1024 * gib && input.quotaBytes % gib === 0);
      await controller.mutate(async () => {
        const config = await payloadIdentity(input, ['quotaBytes']);
        if (config.capability !== 'supported') throw failure('SYNC_CLIENT_UPGRADE_REQUIRED');
        await save({ ...config, revision: config.revision + 1, quotaBytes: input.quotaBytes });
        storageSnapshot = null; plans.clear(); hints.clear(); nextChecks.clear(); failures.clear();
      });
      return service.syncstatus();
    },
    async syncprojects(input, signal) {
      await payloadIdentity(input, []);
      return controller.runSyncOperation(async context => {
        let config = await payloadIdentity(input, []); const client = clientFor(context.identity, config, context.signal);
        let capabilities;
        try { capabilities = await client.capabilities(); }
        catch (error) {
          if (![404, 405].includes(error.httpStatus)) throw error;
          await context.check(); await save({ ...config, capability: 'upgrade-required' }); throw failure('SYNC_CLIENT_UPGRADE_REQUIRED');
        }
        const identity = await identityFor({ ...context.identity, serverId: capabilities.serverId }, config, client); await context.check();
        config = await load(); await save({ ...config, account: config.bindings.length || config.operations.length || config.onboarding?.length ? config.account : identity, capability: 'supported' });
        const result = await client.discoverProjects({ capabilities, check: context.check }); await context.check();
        return { projects: result.projects.map(row => ({ projectId: row.projectId, label: row.label, legacy: row.legacy,
          ...(row.legacy ? { checkpointCount: row.checkpointCount, latestCreatedAt: row.latestCreatedAt, ...(row.sourceRoot === undefined ? {} : { sourceRoot: row.sourceRoot }) } : {}) })), ...(result.partial ? { partial: true } : {}) };
      }, { signal, checkBinding: () => payloadIdentity(input, []) });
    },
    async pairplan(input, signal) {
      await payloadIdentity(input, ['workspaceId', 'projectId', 'primaryLegacyId']); requireValue(validWorkspace(input.workspaceId) && (input.projectId === null || typeof input.projectId === 'string'));
      if (input.projectId !== null) validateId(input.projectId); if (input.primaryLegacyId !== undefined) validateId(input.primaryLegacyId);
      return controller.runSyncOperation(async context => {
        const config = await payloadIdentity(input, ['workspaceId', 'projectId', 'primaryLegacyId']), local = await workspace(input.workspaceId), projectId = input.projectId ?? `project-${randomUUID()}`;
        const existing = config.bindings.find(item => item.workspaceId === local.id || item.projectId === projectId);
        if (existing?.genesisPending) throw failure('SYNC_COMMIT_UNCERTAIN');
        if (existing && (!existing.enrolling || existing.workspaceId !== local.id || existing.projectId !== projectId)) throw failure('SYNC_MANAGED_PROJECT');
        if (existing && config.operations.some(item => item.bindingId === existing.id && ['running', 'uncertain'].includes(item.state))) throw failure('SYNC_APPLY_INCOMPLETE');
        for (const item of config.bindings) if (item.id !== existing?.id && (within(rootKey(local.root), rootKey(item.root)) || within(rootKey(item.root), rootKey(local.root)))) throw failure('SYNC_MANAGED_PROJECT');
        const client = clientFor(context.identity, config, context.signal);
        if (!(await client.supportsV2())) throw failure('SYNC_CLIENT_UPGRADE_REQUIRED');
        const identity = await identityFor(context.identity, config, client), captured = await scan(local.root, projectId, identity, context.check, context.signal);
        const head = await client.syncHead(projectId); let remote = head ? await client.syncCheckpoint(projectId, head.id, head.manifestDigest) : null, migration = null, legacyQueueIds = [];
        if (!head) {
          const old = await client.legacyHeads(projectId);
          if (old.heads.length) {
            if (old.heads.length > 1 && input.primaryLegacyId === undefined) return { requiresLegacyChoice: true, choices: old.heads.map(id => ({ id, label: `历史分支 ${id}` })) };
            const primaryId = input.primaryLegacyId ?? old.heads[0], manifests = [];
            if (!old.heads.includes(primaryId)) throw failure('SYNC_LEGACY_HEAD_MISMATCH');
            for (const id of old.heads) { manifests.push(await client.getCheckpoint(id)); await context.check(); }
            const pending = await controller.store.pending(projectId);
            if (pending.length) {
              await controller.store.validatePending(client, projectId, { root: local.root, deviceId: identity.deviceId, excludedPaths: await exclusions(local.root) });
              legacyQueueIds = pending.map(item => item.id); manifests.push(...pending.filter(item => !old.heads.includes(item.id)));
            }
            const converted = planLegacyMigration({ projectId, deviceId: identity.deviceId, manifests, primaryId, label: local.label, isManaged: captured.isManaged });
            remote = converted.manifest;
            migration = { manifest: remote, expectedLegacyHeads: old.heads, expectedHeadRevision: 0, expectedHeadId: null };
          }
        }
        await context.check(); await captured.verify();
        const preview = reconcileSync({ projectId, deviceId: identity.deviceId, remote, local: captured.files, isManaged: captured.isManaged, label: local.label });
        const summary = { upload: captured.files.filter(file => !remote?.files.some(item => item.path === file.path && fileStateEqual(fileState(item), fileState(file)))).length, download: preview.operations.filter(item => item.desired !== null).length, delete: 0, conflicts: preview.manifest?.conflicts.length ?? 0, blocked: preview.blocked ? Math.max(1, preview.blockers.length) : 0 };
        const binding = { id: existing?.id ?? `binding-${randomUUID()}`, workspaceId: local.id, projectId, label: local.label, root: local.root, rootIdentity: captured.rootIdentity, enabled: true, identity, enrolling: true, legacyQueueIds };
        const plan = putPlan({ kind: 'pair', revision: input.revision, server: input.server, username: input.username, identity, binding, head, migration, localDigest: scanDigest(captured), policyHash: captured.policyHash, summary });
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), projectId, label: local.label, root: local.root, summary } };
      }, { signal, checkBinding: () => payloadIdentity(input, ['workspaceId', 'projectId', 'primaryLegacyId']) });
    },
    async paircommit(input, signal) {
      if (await replay(input, 'pair')) return { accepted: true, operationId: input.requestId };
      await payloadIdentity(input, ['planId', 'requestId', 'confirm']); requireValue(input.confirm === true); validateId(input.requestId);
      await controller.mutate(async () => {
        let config = await payloadIdentity(input, ['planId', 'requestId', 'confirm']); const plan = getPlan(input.planId, 'pair');
        const grant = await controller.syncAccount(), client = clientFor(grant, config, signal), identity = await identityFor(grant, config, client);
        planBinding(input, plan, identity); if (plan.summary.blocked) throw failure('SYNC_STRUCTURAL_CONFLICT');
        await verifySyncRoot(plan.binding.rootIdentity); const local = await workspace(plan.binding.workspaceId); if (rootKey(local.root) !== rootKey(plan.binding.root)) throw failure('SYNC_ROOT_CHANGED');
        const captured = await scan(local.root, plan.binding.projectId, identity, async () => { signal?.throwIfAborted(); await verifySyncRoot(plan.binding.rootIdentity); }, signal);
        if (captured.policyHash !== plan.policyHash || scanDigest(captured) !== plan.localDigest) throw failure('SYNC_PLAN_CHANGED');
        await pinnedHead(client, plan.binding.projectId, plan.head);
        if (plan.migration && !compare([...(await client.legacyHeads(plan.binding.projectId)).heads].sort(), [...plan.migration.expectedLegacyHeads].sort())) throw failure('SYNC_LEGACY_HEAD_MISMATCH');
        if (plan.until <= now()) throw failure('SYNC_PLAN_EXPIRED'); signal?.throwIfAborted();
        const descriptor = { version: 1, id: input.requestId, kind: 'pair', bindingId: plan.binding.id, account: identity, policyHash: plan.policyHash,
          ...(plan.migration ? { migration: true, request: { ...plan.migration, requestId: input.requestId }, allowedHashes: plan.migration.manifest.files.map(item => item.hash).concat(plan.migration.manifest.conflicts.flatMap(item => item.variants.filter(Boolean).map(state => state.hash))) } : {}) };
        // A mode change only narrows old upload permission; it never forwards old
        // immutable queues to a different account or silently enables old roots.
        await legacy.pauseLegacyWorkspace?.(plan.binding.workspaceId);
        config = await load(); await accept(config, input, descriptor, plan.binding); plans.delete(plan.id);
      }, { requireIdle: true });
      startTask(input.requestId); return { accepted: true, operationId: input.requestId };
    },
    async syncpause(input) {
      requireValue(typeof input?.enabled === 'boolean');
      const admission = { allowSignedOut: input.enabled === false };
      await payloadIdentity(input, ['bindingId', 'enabled'], admission);
      await controller.mutate(async () => {
        const config = await payloadIdentity(input, ['bindingId', 'enabled'], admission), binding = bindingFor(config, input.bindingId);
        // Narrowing permission is always possible for this authenticated Host
        // operator, including a missing root or expired cloud grant. Resuming is
        // stricter and rechecks the actual root and fresh cloud identity.
        if (input.enabled) {
          const grant = await controller.syncAccount(), identity = await identityFor(grant, config);
          await admitBinding(binding, { allowPaused: true, allowReauthorize: true, nextIdentity: identity });
          if (!compare(identity, binding.identity)) {
            const engine = await budgetedEngine(binding, {}, { allowPaused: true, allowReauthorize: true });
            if (await exists(engine.filename)) await engine.reauthorize(identity);
            binding.identity = identity;
          }
          binding.authorizedEpochs = [...new Set([...(binding.authorizedEpochs ?? []), identity.authorizationEpoch])];
          for (const operation of config.operations) if (operation.kind !== 'import' && operation.bindingId === binding.id && authorizedTask(binding, operation) && operation.state === 'failed' && ['NOT_LOGGED_IN', 'SYNC_CANCELLED', 'ACCOUNT_MISMATCH', 'BUSY'].includes(operation.errorCode)) {
            operation.state = ['committing', 'remote-accepted'].includes(operation.phase) ? 'uncertain' : 'running'; delete operation.errorCode;
          }
        }
        binding.enabled = input.enabled; config.revision++; await save(config); plans.clear(); hints.delete(binding.id); nextChecks.delete(binding.id); failures.delete(binding.id); refreshWatches(config);
      });
      return service.syncstatus();
    },
    async syncrun(input) {
      if (await replay(input, 'run')) return { accepted: true, operationId: input.requestId };
      await payloadIdentity(input, ['bindingId', 'requestId']); validateId(input.requestId);
      await controller.mutate(async () => {
        const config = await payloadIdentity(input, ['bindingId', 'requestId']), binding = bindingFor(config, input.bindingId); await admitBinding(binding);
        if (binding.enrolling) throw failure('SYNC_MIGRATION_REQUIRED');
        await accept(config, input, { version: 1, id: input.requestId, kind: 'run', bindingId: binding.id, account: binding.identity });
      }, { requireIdle: true });
      startTask(input.requestId); return { accepted: true, operationId: input.requestId };
    },
    async syncconflicts(input, signal) {
      await payloadIdentity(input, ['bindingId']);
      const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        const client = clientFor(context.identity, config, context.signal), head = await client.syncHead(binding.projectId);
        const manifest = head ? await client.syncCheckpoint(binding.projectId, head.id, head.manifestDigest) : null;
        await context.check();
        return { conflicts: (manifest?.conflicts ?? []).map(item => ({ id: item.id, path: item.path, variants: item.variants.map(value => ({ id: value === null ? 'deleted' : sha256(canonicalJson(value)), label: value === null ? '删除记录' : `内容 ${value.hash.slice(0, 10)} · ${value.executable ? '可执行' : '普通文件'}`,  deleted: value === null, size: value?.size ?? 0 })) })) };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId']); await admitBinding(binding); } });
    },
    async syncresolveplan(input, signal) {
      await payloadIdentity(input, ['bindingId', 'conflictId', 'choice']); validateBlobHash(input.conflictId); requireValue(['local', 'remote', 'both'].includes(input.choice));
      const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        await resolutionReady(binding, context, config.quotaBytes);
        const client = clientFor(context.identity, config, context.signal), head = await client.syncHead(binding.projectId);
        if (!head) throw failure('SYNC_CONFLICT_CHANGED');
        const remote = await client.syncCheckpoint(binding.projectId, head.id, head.manifestDigest), conflict = remote.conflicts.find(item => item.id === input.conflictId);
        if (!conflict) throw failure('SYNC_CONFLICT_CHANGED');
        const policy = await policyFor(binding.root); if (policy.isExcluded(conflict.path)) throw failure('SYNC_POLICY_CHANGED');
        const local = await readSyncFile(binding.root, conflict.path, conflict.main);
        if (local) { const { bytes } = await readStableFile(path.join(binding.root, ...conflict.path.split('/'))); if (sha256(bytes) !== local.hash) throw failure('SYNC_LOCAL_CHANGED'); await spoolShared(local.hash, bytes, context); }
        let desired = input.choice === 'remote' ? conflict.main : local;
        if (input.choice === 'both') desired ??= conflict.variants.find(Boolean) ?? null;
        const resolved = resolveSyncConflict({ remote, conflictId: conflict.id, state: desired, deviceId: context.identity.deviceId });
        const expectedLocal = [{ path: conflict.path, state: local }], paths = [conflict.path], allowedHashes = local ? [local.hash] : [];
        if (input.choice === 'both') {
          const occupied = new Set([...remote.files.map(item => item.path.toLowerCase()), ...remote.conflicts.map(item => item.path.toLowerCase())]);
          for (const variant of conflict.variants.filter(Boolean)) {
            if (fileStateEqual(variant, desired)) continue;
            const name = await uniqueSibling(conflict.path, `conflict-${variant.hash.slice(0, 8)}`, occupied, relative => exists(path.join(binding.root, ...relative.split('/'))));
            resolved.manifest.files.push({ path: name, ...variant }); expectedLocal.push({ path: name, state: null }); paths.push(name);
          }
        }
        resolved.manifest = validateSyncManifest(resolved.manifest);
        await context.check(); await verifyLocal(binding, expectedLocal, context.check); await resolutionReady(binding, context, config.quotaBytes);
        const identity = await identityFor(context.identity, config), plan = putPlan({ kind: 'resolve', revision: input.revision, server: input.server, username: input.username, identity, bindingId: binding.id, policyHash: policy.fingerprint,
          request: { manifest: resolved.manifest, resolutions: resolved.resolutions, expectedHeadRevision: head.revision, expectedHeadId: head.id }, expectedLocal, allowedHashes, resolution: { path: conflict.path, conflictId: conflict.id, expectedLocal: local } });
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), root: binding.root, paths, summary: input.choice === 'both' ? '保留所有内容副本，不覆盖新的本机修改' : input.choice === 'local' ? '以本机内容解决冲突，历史副本保留' : '采用云端内容，本机原内容先保留回收副本' } };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId', 'conflictId', 'choice']); await admitBinding(binding); } });
    },
    async syncresolve(input, signal) { return confirmWrite('resolve', input, signal); },
    async syncrecycle(input, signal) {
      await payloadIdentity(input, ['bindingId']); const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        const rows = await engineFor(binding, context, { allowPaused: true, quotaBytes: config.quotaBytes }).recycle(); await context.check();
        return { items: rows.map(item => ({ id: `${item.transactionId}_${item.index}`, path: item.path, size: item.state.size, reason: item.reason })) };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId']); await admitBinding(binding, { allowPaused: true }); } });
    },
    async syncrestoreplan(input, signal) {
      await payloadIdentity(input, ['bindingId', 'itemId']); requireValue(typeof input.itemId === 'string');
      const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})_(\d{1,5})$/.exec(input.itemId); requireValue(match);
      const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        const applier = await createSyncApplier({ root: binding.root, bindingId: binding.id, projectId: binding.projectId, check: context.check, signal: context.signal });
        const recycled = await applier.readRecycled(match[1], Number(match[2]));
        const client = clientFor(context.identity, config, context.signal), head = await client.syncHead(binding.projectId); if (!head) throw failure('SYNC_PLAN_CHANGED');
        const remote = await client.syncCheckpoint(binding.projectId, head.id, head.manifestDigest), occupied = new Set([...remote.files.map(item => item.path.toLowerCase()), ...remote.conflicts.map(item => item.path.toLowerCase())]);
        let target = recycled.path;
        const collides = [...occupied].some(item => item === target.toLowerCase() || item.startsWith(`${target.toLowerCase()}/`) || target.toLowerCase().startsWith(`${item}/`));
        if (collides || await exists(path.join(binding.root, ...target.split('/')))) target = await uniqueSibling(target, 'recovered', occupied, name => exists(path.join(binding.root, ...name.split('/'))));
        const policy = await policyFor(binding.root); if (policy.isExcluded(target)) throw failure('SYNC_POLICY_CHANGED');
        await spoolShared(recycled.state.hash, recycled.bytes, context);
        const manifest = validateSyncManifest({ ...remote, id: randomUUID(), deviceId: context.identity.deviceId, parentId: remote.id, files: [...remote.files, { path: target, ...recycled.state }] });
        await context.check();
        const identity = await identityFor(context.identity, config), plan = putPlan({ kind: 'restore', revision: input.revision, server: input.server, username: input.username, identity, bindingId: binding.id, policyHash: policy.fingerprint,
          request: { manifest, expectedHeadRevision: head.revision, expectedHeadId: head.id, resolutions: [] }, expectedLocal: [{ path: target, state: null }], allowedHashes: [recycled.state.hash] });
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), root: binding.root, target: path.join(binding.root, ...target.split('/')) } };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId', 'itemId']); await admitBinding(binding); } });
    },
    async syncrestore(input, signal) { return confirmWrite('restore', input, signal); },
    async syncarchives(input, signal) {
      await payloadIdentity(input, ['bindingId']); const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        const identity = await archiveAdmission(binding), client = clientFor(context.identity, config, context.signal);
        const result = await sessionSync.listArchives(binding, { identity, client, check: context.check, signal: context.signal });
        return { archives: result.archives.map(item => ({ id: item.archiveId, label: projectLabel(item.label), state: item.state, sessions: item.counts.sessions, assets: item.counts.assets, ...(item.sessionIds ? { sessionIds: item.sessionIds } : {}) })), counts: { total: result.counts.archives, imported: result.counts.imported, uncertain: result.counts.uncertain } };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId']); await archiveAdmission(binding); } });
    },
    async syncarchiveplan(input, signal) {
      await payloadIdentity(input, ['bindingId', 'archiveId']); validateId(input.archiveId);
      const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        const identity = await archiveAdmission(binding), client = clientFor(context.identity, config, context.signal), head = await client.syncHead(binding.projectId);
        if (!head) throw failure('SYNC_PLAN_CHANGED');
        const manifest = await client.syncCheckpoint(binding.projectId, head.id, head.manifestDigest);
        const prepared = await sessionSync.prepareImport({ root: binding.root, projectId: binding.projectId, archiveId: input.archiveId, manifest, client, identity, check: context.check, signal: context.signal });
        await context.check();
        const plan = putPlan({ kind: 'import', revision: input.revision, server: input.server, username: input.username, identity, bindingId: binding.id, prepared,
          archive: { archiveId: input.archiveId, checkpointId: head.id, manifestDigest: head.manifestDigest, wrapperDigest: prepared.wrapperDigest } });
        const prior = prepared.eligibility === 'unchecked' ? null : await sessionSync.lookupImport({ root: binding.root, projectId: binding.projectId, archiveId: input.archiveId, identity, check: context.check, signal: context.signal });
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), root: binding.root, label: `会话归档 ${input.archiveId.slice(-10)}`, eligibility: prepared.eligibility,
          counts: { sessions: prepared.counts.sessions, events: prepared.counts.events, assets: prepared.counts.assets, files: prepared.counts.archivedFiles }, ...(prior ? { sessionIds: prior.sessionIds } : {}) } };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId', 'archiveId']); await archiveAdmission(binding); } });
    },
    async syncarchiveimport(input, signal) {
      if (await replay(input, 'import')) return { accepted: true, operationId: input.requestId };
      await payloadIdentity(input, ['planId', 'requestId', 'confirm']); requireValue(input.confirm === true); validateId(input.requestId);
      await controller.mutate(async () => {
        const config = await payloadIdentity(input, ['planId', 'requestId', 'confirm']), plan = getPlan(input.planId, 'import'), binding = bindingFor(config, plan.bindingId);
        const identity = await archiveAdmission(binding); planBinding(input, plan, identity);
        if (plan.prepared.eligibility !== 'unchecked') throw failure(plan.prepared.eligibility === 'uncertain' ? 'SYNC_IMPORT_UNCERTAIN' : 'SYNC_PLAN_CHANGED');
        if (!(await isIdle(binding.root))) throw failure('SYNC_NOT_IDLE');
        signal?.throwIfAborted(); if (plan.until <= now()) throw failure('SYNC_PLAN_EXPIRED');
        await accept(config, input, { version: 1, id: input.requestId, kind: 'import', bindingId: binding.id, account: identity, archive: plan.archive }); plans.delete(plan.id);
      }, { requireIdle: true });
      startTask(input.requestId); return { accepted: true, operationId: input.requestId };
    },
    async syncrepairplan(input, signal) {
      await payloadIdentity(input, ['bindingId']); const config = await load(), binding = bindingFor(config, input.bindingId);
      return controller.runSyncOperation(async context => {
        const engine = await budgetedEngine(binding, context), prepared = await engine.prepareReplan();
        await context.check();
        const identity = await identityFor(context.identity, config), plan = putPlan({ kind: 'repair', revision: input.revision, server: input.server, username: input.username, identity, bindingId: binding.id, prepared });
        plan.until = Math.min(plan.until, Date.parse(prepared.expiresAt));
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), root: binding.root, paths: prepared.paths.map(item => item.path), summary: prepared.summary } };
      }, { signal, checkBinding: async () => { await payloadIdentity(input, ['bindingId']); await admitBinding(binding); } });
    },
    async syncrepair(input, signal) {
      if (await replay(input, 'repair')) return { accepted: true, operationId: input.requestId };
      await payloadIdentity(input, ['planId', 'requestId', 'confirm']); requireValue(input.confirm === true); validateId(input.requestId);
      await controller.mutate(async () => {
        const config = await payloadIdentity(input, ['planId', 'requestId', 'confirm']), plan = getPlan(input.planId, 'repair'), binding = bindingFor(config, plan.bindingId);
        const identity = await identityFor(await controller.syncAccount(), config); planBinding(input, plan, identity); await admitBinding(binding);
        if (!(await isIdle(binding.root))) throw failure('SYNC_NOT_IDLE');
        signal?.throwIfAborted(); if (plan.until <= now()) throw failure('SYNC_PLAN_EXPIRED');
        await accept(config, input, { version: 1, id: input.requestId, kind: 'repair', bindingId: binding.id, account: identity, repairPlanId: plan.prepared.id }); plans.delete(plan.id);
      }, { requireIdle: true });
      startTask(input.requestId); return { accepted: true, operationId: input.requestId };
    },
    async tickBidirectional() {
      if (disposed || ticking || workers.size) return; ticking = true;
      try {
        const config = await load(), base = await accountStatus();
        if (!base.loggedIn) { refreshWatches({ ...config, bindings: [] }); return; }
        if (base.running || onboarding.running) return;
        if (await onboarding.tick()) return;
        const grant = await controller.syncAccount();
        const allowedBindings = config.bindings.filter(binding => binding.enabled && !binding.genesisPending && binding.identity.authorizationEpoch === (grant.authorizationEpoch ?? 0) && binding.identity.server === grant.server && binding.identity.username === grant.username && binding.identity.deviceId === grant.deviceId);
        refreshWatches({ ...config, bindings: allowedBindings });
        for (const operation of config.operations) if (['running', 'uncertain'].includes(operation.state)) {
          const binding = config.bindings.find(item => item.id === operation.bindingId);
          const importAllowed = operation.kind === 'import' && binding && operation.account.server === grant.server && operation.account.username === grant.username && operation.account.deviceId === grant.deviceId && operation.account.authorizationEpoch === (grant.authorizationEpoch ?? 0);
          if ((importAllowed || operation.kind !== 'import' && allowedBindings.some(item => item.id === binding?.id) && authorizedTask(binding, operation)) && (nextChecks.get(binding.id) ?? 0) <= now()) { startTask(operation.id); return; }
        }
        let processed = 0;
        for (const binding of allowedBindings) {
          if (!binding.enabled || binding.enrolling || (nextChecks.get(binding.id) ?? 0) > now()) continue;
          if (processed++ >= 3) break;
          try {
            const result = await controller.runSyncOperation(async context => {
              const value = await periodic(binding, context, config);
              if (value.errorCode === 'NOT_LOGGED_IN') await controller.requireSyncReauthentication?.({ expectedIdentity: context.identity });
              return value;
            }, { signal: life.signal, checkBinding: () => admitBinding(binding) });
            scheduleNext(binding.id, result);
          } catch (error) { scheduleNext(binding.id, { state: 'blocked', errorCode: codeOf(error) }); }
          if (disposed) break;
        }
      } finally { ticking = false; }
    },
    stopBidirectional() { onboarding.stop(); disposed = true; life.abort(); for (const watcher of watches.values()) watcher.close(); watches.clear(); plans.clear(); },
    async drainBidirectional() { await Promise.allSettled([...workers.values(), onboarding.drain()]); },
    // Test/diagnostic handle is a plugin-owned preference path, never a native profile path.
    bidirectionalFilename: filename,
  };
  async function confirmWrite(kind, input, signal) {
    if (await replay(input, kind)) return { accepted: true, operationId: input.requestId };
    await payloadIdentity(input, ['planId', 'requestId', 'confirm']); requireValue(input.confirm === true); validateId(input.requestId);
    await controller.mutate(async () => {
      const config = await payloadIdentity(input, ['planId', 'requestId', 'confirm']), plan = getPlan(input.planId, kind), binding = bindingFor(config, plan.bindingId);
      const grant = await controller.syncAccount(), identity = await identityFor(grant, config); planBinding(input, plan, identity); await admitBinding(binding);
      if (kind === 'resolve') await resolutionReady(binding, {}, config.quotaBytes);
      const client = clientFor(grant, config, signal), current = await client.syncHead(binding.projectId);
      if (current?.id !== plan.request.expectedHeadId || current?.revision !== plan.request.expectedHeadRevision) throw failure('SYNC_HEAD_MISMATCH');
      if ((await policyFor(binding.root)).fingerprint !== plan.policyHash) throw failure('SYNC_POLICY_CHANGED');
      await verifyLocal(binding, plan.expectedLocal, async () => { signal?.throwIfAborted(); await admitBinding(binding); });
      if (plan.until <= now()) throw failure('SYNC_PLAN_EXPIRED'); signal?.throwIfAborted();
      if (kind === 'resolve') await resolutionReady(binding, {}, config.quotaBytes);
      const descriptor = { version: 1, id: input.requestId, kind, bindingId: binding.id, account: identity, policyHash: plan.policyHash, request: { ...plan.request, requestId: input.requestId }, expectedLocal: plan.expectedLocal, allowedHashes: plan.allowedHashes, ...(plan.resolution ? { resolution: plan.resolution } : {}) };
      await accept(config, input, descriptor); plans.delete(plan.id);
    }, { requireIdle: true });
    startTask(input.requestId); return { accepted: true, operationId: input.requestId };
  }
  controller.setAdditionalIdentityAdmission?.(async proposed => {
    const config = await load();
    if (config.account && (config.bindings.length || config.onboarding?.length) && ['server', 'username', 'deviceId'].some(key => proposed[key] !== config.account[key])) throw failure('ACCOUNT_BOUND');
  });
  legacy.setWorkspaceSelectionGuard?.(async workspaceId => { if ((await load()).bindings.some(item => item.workspaceId === workspaceId)) throw failure('SYNC_MANAGED_PROJECT'); });
  return service;
}
