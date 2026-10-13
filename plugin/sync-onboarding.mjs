import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readStableFile, writeNewFile } from '../src/files.mjs';
import { validateId, validateBlobHash, sha256, MAX_MANIFEST_BYTES } from '../src/protocol.mjs';
import { canonicalJson, validateSyncManifest, syncManifestDigest } from '../src/sync-protocol.mjs';
import { syncRootIdentity, verifySyncRoot } from '../src/sync-local.mjs';
import { createExclusionPolicy } from '../src/snapshot.mjs';
import { projectFolderMetadata } from '../src/client.mjs';
import { accountKey, projectLabel, planLegacyMigration, rootKey, within } from './sync-planning.mjs';
import { createSyncOnboardingPicker } from './sync-onboarding-picker.mjs';

export const ONBOARDING_ACTIONS = Object.freeze(['syncclonepick', 'syncclonebrowse', 'synccloneselect', 'synccloneplan', 'syncclonecommit', 'syncpublishplan', 'syncpublishcommit']);
const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const requireValue = value => { if (!value) throw fail('BAD_REQUEST'); };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const stamp = () => new Date().toISOString();
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const active = batch => batch.items.some(item => ['pending', 'running'].includes(item.state));
const total = items => Object.fromEntries(['upload', 'download', 'delete', 'conflicts', 'blocked'].map(key => [key, items.reduce((n, item) => n + item.summary[key], 0)]));
const pathText = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const workspaceId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const phases = new Set(['pending', 'accepted', 'mkdir-started', 'root-owned', 'migration-committing', 'migration-complete', 'downloading', 'downloaded', 'registering', 'registered', 'publishing', 'paired', 'complete', 'interrupted']);

/** Additive v2 config section; old binding/operation records retain their shape. */
export function validateOnboarding(input = [], { normalizeIdentity, rootRecord, safeCodes }) {
  requireValue(Array.isArray(input) && input.length <= 100);
  const ids = new Set(), itemIds = new Set();
  return input.map(batch => {
    requireValue(exact(batch, ['id', 'kind', 'state', 'at', 'account', 'inputHash', 'descriptorHash', 'parent', 'items']) && ['clone', 'publish'].includes(batch.kind) && ['running', 'succeeded', 'partial', 'failed', 'uncertain'].includes(batch.state) && typeof batch.at === 'string' && Number.isFinite(Date.parse(batch.at)));
    validateId(batch.id); validateBlobHash(batch.inputHash); validateBlobHash(batch.descriptorHash); requireValue(!ids.has(batch.id)); ids.add(batch.id);
    requireValue(batch.parent === undefined || pathText(batch.parent));
    requireValue(Array.isArray(batch.items) && batch.items.length > 0 && batch.items.length <= 20);
    const account = normalizeIdentity(batch.account);
    const items = batch.items.map(item => {
      requireValue(exact(item, ['id', 'projectId', 'workspaceId', 'bindingId', 'label', 'root', 'state', 'phase', 'errorCode', 'rootIdentity', 'receipt']) && typeof item.label === 'string' && item.label.length <= 200 && pathText(item.root) && ['pending', 'running', 'succeeded', 'failed', 'uncertain'].includes(item.state) && phases.has(item.phase));
      validateId(item.id); validateId(item.projectId); validateId(item.bindingId); requireValue(!itemIds.has(item.id)); itemIds.add(item.id);
      requireValue(item.workspaceId === undefined || workspaceId(item.workspaceId));
      if (item.rootIdentity) rootRecord(item.rootIdentity, item.root);
      if (item.receipt) { requireValue(item.receipt.projectId === item.projectId && Number.isSafeInteger(item.receipt.revision) && item.receipt.revision > 0); validateId(item.receipt.id); validateBlobHash(item.receipt.manifestDigest); validateBlobHash(item.receipt.recordHash); }
      return { ...item, label: projectLabel(item.label), ...(item.errorCode ? { errorCode: safeCodes.has(item.errorCode) ? item.errorCode : 'SETTINGS_FAILED' } : {}) };
    });
    return { ...batch, account, items };
  });
}
export function onboardingProjection(batches) {
  return batches.map(({ id, kind, state, at, parent, items }) => ({ id, kind, state, at, ...(parent ? { parent } : {}), items: items.map(({ rootIdentity: _root, receipt: _receipt, ...item }) => ({ ...item })) }));
}

/** One durable batch admission, independent item outcomes. Deliberately no
 * cross-project transaction/rollback. Unknown native effects are never replayed.
 */
export function createSyncOnboarding(ctx, host) {
  const { controller, load, save, payloadIdentity, identityFor, clientFor, putPlan, getPlan, planBinding, intentPath, reserveShared, workspace, scanPreview, policyFor, exclusions, registry, admitParent, admitDestination, isIdle, bootstrap, publish, life, now, codeOf, fault = async () => {} } = host;
  const workers = new Map(), acceptedGuards = new Map(); let stopped = false;
  const picker = createSyncOnboardingPicker(ctx, { admitParent, admitDestination, now });
  function identifiers(values, local = false) { requireValue(Array.isArray(values) && values.length > 0 && values.length <= 20 && new Set(values).size === values.length); values.forEach(value => local ? requireValue(workspaceId(value)) : validateId(value)); return values; }
  function nativeRegistry() { const value = registry(); if (typeof value.create !== 'function') throw fail('PROJECTS_UNAVAILABLE'); return value; }
  function unclaimed(config, projectId, root, localId) {
    if (config.bindings.some(item => item.projectId === projectId || localId && item.workspaceId === localId || root && (within(rootKey(root), rootKey(item.root)) || within(rootKey(item.root), rootKey(root))))) throw fail('SYNC_MANAGED_PROJECT');
    if ((config.onboarding ?? []).filter(active).some(batch => batch.items.some(item => item.projectId === projectId || localId && item.workspaceId === localId || root && rootKey(item.root) === rootKey(root)))) throw fail('SYNC_MANAGED_PROJECT');
  }
  async function connect(context) {
    let config = await load(); const client = clientFor(context.identity, config, context.signal);
    let capabilities;
    try { capabilities = await client.capabilities(); }
    catch (error) { if ([404, 405].includes(error.httpStatus)) throw fail('SYNC_CLIENT_UPGRADE_REQUIRED'); throw error; }
    const identity = await identityFor({ ...context.identity, serverId: capabilities.serverId }, config, client);
    await context.check(); config = await load();
    await save({ ...config, account: config.account ?? identity, capability: 'supported' });
    return { config, client, identity };
  }
  async function remote(client, projectId, check, primary) {
    const head = await client.syncHead(projectId); await check();
    if (head) { const manifest = await client.syncCheckpoint(projectId, head.id, head.manifestDigest); await check(); return { head, manifest, label: projectLabel(manifest.label, projectId) }; }
    const old = await client.legacyHeads(projectId); await check();
    if (!old.heads.length) throw fail('CLOUD_PROJECT_EMPTY');
    const manifests = [];
    for (const id of old.heads) { manifests.push(await client.getCheckpoint(id)); await check(); }
    const label = projectLabel(projectFolderMetadata(manifests[0].sourceRoot).label, projectId);
    if (primary === undefined && old.heads.length > 1) return { choices: old.heads.map(id => ({ id, label: `历史分支 ${id}` })), label };
    const policy = createExclusionPolicy({ excluded: ['.dsh-syncignore', '**/.dsh-syncignore'] });
    const converted = planLegacyMigration({ projectId, deviceId: client.deviceId, manifests, primaryId: primary ?? old.heads[0], label, isManaged: name => !policy.isExcluded(name) });
    return { head: null, manifest: converted.manifest, label, migration: { expectedLegacyHeads: old.heads, expectedHeadRevision: 0, expectedHeadId: null } };
  }
  function read(input, fields, signal, action) {
    return controller.runSyncOperation(async context => { await payloadIdentity(input, fields); return action(context); }, { signal, checkBinding: () => payloadIdentity(input, fields) });
  }
  async function immutable(batch) {
    const { bytes } = await readStableFile(intentPath(batch.id), 8 * MAX_MANIFEST_BYTES);
    if (sha256(bytes) !== batch.descriptorHash) throw fail('SETTINGS_CORRUPT');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value) || value.version !== 1 || value.id !== batch.id || value.kind !== batch.kind || !same(value.account, batch.account) || !Array.isArray(value.items) || value.items.length !== batch.items.length || value.items.some((item, index) => ['id', 'root', 'projectId', 'bindingId', 'label'].some(key => item[key] !== batch.items[index][key]))) throw fail('SETTINGS_CORRUPT');
    return value;
  }
  const outcome = items => items.some(item => ['pending', 'running'].includes(item.state)) ? 'running' : items.some(item => item.state === 'uncertain') ? 'uncertain' : items.every(item => item.state === 'succeeded') ? 'succeeded' : items.some(item => item.state === 'succeeded') ? 'partial' : 'failed';
  async function mark(id, index, patch, binding) {
    const config = await load(), batch = config.onboarding.find(item => item.id === id);
    if (!batch) throw fail('SETTINGS_CORRUPT');
    Object.assign(batch.items[index], patch); batch.at = stamp(); batch.state = outcome(batch.items);
    if (binding) {
      if (config.bindings.some(item => item.id !== binding.id && (item.projectId === binding.projectId || item.workspaceId === binding.workspaceId || within(rootKey(item.root), rootKey(binding.root)) || within(rootKey(binding.root), rootKey(item.root))))) throw fail('SYNC_MANAGED_PROJECT');
      config.bindings = [...config.bindings.filter(item => item.id !== binding.id), binding]; config.revision++;
    }
    await save(config); return batch.items[index];
  }
  async function owned(batch, context) {
    const config = await load(), current = config.onboarding?.find(item => item.id === batch.id);
    if (!current || !same(current.account, batch.account)) throw fail('ACCOUNT_MISMATCH');
    const identity = await identityFor(context.identity, config);
    if (!same(identity, batch.account)) throw fail('NOT_LOGGED_IN');
    life.signal.throwIfAborted(); return config;
  }
  async function cloneItem(batch, descriptor, index, context) {
    const item = descriptor.items[index], native = nativeRegistry(), provider = original(native);
    const check = async () => {
      await context.check(); await owned(batch, context); await acceptedGuards.get(batch.id)?.(); await verifySyncRoot(descriptor.parentIdentity); await admitParent(descriptor.parentIdentity.root);
      if (original(nativeRegistry()) !== provider) throw fail('PROJECT_REGISTRATION_UNCERTAIN');
    };
    await check(); await admitDestination(item.root, { ownedItemId: item.id });
    await mark(batch.id, index, { phase: 'mkdir-started' }); await check(); await fault('before-mkdir', item);
    try { await fs.mkdir(item.root, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw fail('DESTINATION_EXISTS'); throw error; }
    // Nothing that can register/apply follows until the returned root identity is
    // durable. A crash here leaves mkdir-started, which is terminal uncertainty.
    const rootIdentity = await syncRootIdentity(item.root);
    await mark(batch.id, index, { phase: 'root-owned', rootIdentity }); await fault('root-owned', item);
    const rootCheck = async () => { await check(); await verifySyncRoot(rootIdentity); if (!(await isIdle(item.root))) throw fail('SYNC_NOT_IDLE'); };
    let config = await owned(batch, context), client = clientFor(context.identity, config, context.signal), head = item.head;
    if (item.migration) {
      await rootCheck(); await mark(batch.id, index, { phase: 'migration-committing' }); await rootCheck();
      head = await client.migrateSync({ ...item.migration, manifest: item.manifest, requestId: item.id });
      if (head.projectId !== item.projectId || head.id !== item.manifest.id || head.manifestDigest !== syncManifestDigest(item.manifest) || head.requestId !== item.id) throw fail('SYNC_INTEGRITY');
      await mark(batch.id, index, { phase: 'migration-complete', receipt: head });
    }
    await rootCheck(); await mark(batch.id, index, { phase: 'downloading' });
    const options = { requestId: item.id, head, manifest: item.manifest, rootIdentity };
    await bootstrap({ ...item, rootIdentity, identity: batch.account }, { ...context, check: rootCheck }, options);
    await mark(batch.id, index, { phase: 'downloaded' }); await rootCheck();
    // Native create canonicalizes and can reuse a registration. Reject any known
    // existing row first; a rejected create is NEVER retried, even after restart.
    if (native.list().some(row => typeof row.path === 'string' && rootKey(row.path) === rootKey(item.root))) throw fail('PROJECT_REGISTRATION_UNCERTAIN');
    await mark(batch.id, index, { phase: 'registering' }); await rootCheck(); await fault('before-register', item);
    const workspace = await native.create(item.root, item.label);
    if (!workspaceId(workspace?.id) || !pathText(workspace.path) || rootKey(workspace.path) !== rootKey(item.root)) throw fail('PROJECT_REGISTRATION_UNCERTAIN');
    await mark(batch.id, index, { phase: 'registered', workspaceId: workspace.id }); await fault('registered', item);
    await rootCheck();
    if (!native.list().some(row => row.id === workspace.id && rootKey(row.path) === rootKey(item.root)) || native.get(workspace.id)?.path !== workspace.path) throw fail('PROJECT_REGISTRATION_UNCERTAIN');
    // Registration can await arbitrary native I/O. Verify the initial tree again;
    // this public bootstrap call does no scanning/spooling/upload on replay.
    await bootstrap({ ...item, rootIdentity, identity: batch.account }, { ...context, check: rootCheck }, options);
    const binding = { id: item.bindingId, workspaceId: workspace.id, projectId: item.projectId, label: item.label, root: item.root, rootIdentity, enabled: true, enrolling: false, identity: batch.account, legacyQueueIds: [], authorizedEpochs: [batch.account.authorizationEpoch] };
    await rootCheck(); await mark(batch.id, index, { state: 'succeeded', phase: 'complete' }, binding);
  }
  async function execute(id, context) {
    const batch = (await load()).onboarding.find(item => item.id === id), descriptor = await immutable(batch);
    await owned(batch, context);
    for (let index = 0; index < batch.items.length; index++) {
      let progress = (await load()).onboarding.find(item => item.id === id).items[index];
      if (progress.state === 'running') { await mark(id, index, { state: 'uncertain', errorCode: progress.phase === 'registering' || progress.phase === 'registered' ? 'PROJECT_REGISTRATION_UNCERTAIN' : 'SYNC_APPLY_INCOMPLETE' }); continue; }
      if (progress.state !== 'pending') continue;
      try {
        await context.check(); await owned(batch, context);
        await mark(id, index, { state: 'running', phase: 'accepted' });
        if (batch.kind === 'clone') await cloneItem(batch, descriptor, index, context);
        else {
          await mark(id, index, { phase: 'publishing' });
          const item = descriptor.items[index], result = await publish(item, batch.account, context);
          await mark(id, index, { state: ['synced', 'conflicted', 'deferred'].includes(result.state) ? 'succeeded' : result.state === 'uncertain' ? 'uncertain' : 'failed', phase: 'complete', ...(result.errorCode ? { errorCode: codeOf({ code: result.errorCode }) } : {}) });
        }
      } catch (error) {
        progress = (await load()).onboarding.find(item => item.id === id).items[index];
        const uncertain = ['mkdir-started', 'registering', 'registered', 'migration-committing'].includes(progress.phase) && error.code !== 'DESTINATION_EXISTS';
        await mark(id, index, { state: uncertain ? 'uncertain' : 'failed', errorCode: ['registering', 'registered'].includes(progress.phase) ? 'PROJECT_REGISTRATION_UNCERTAIN' : codeOf(error) });
      }
    }
  }
  function start(id) {
    if (stopped || workers.has(id)) return;
    const task = controller.runSyncOperation(context => execute(id, context), { signal: life.signal, checkBinding: async () => {
      const batch = (await load()).onboarding?.find(item => item.id === id);
      if (!batch) throw fail('SETTINGS_CORRUPT');
      const identity = await identityFor(await controller.syncAccount(), await load());
      if (!same(identity, batch.account)) throw fail('NOT_LOGGED_IN');
    } }).catch(() => { /* Durable pending/running item markers own recovery. */ }).finally(() => { workers.delete(id); acceptedGuards.delete(id); });
    workers.set(id, task);
  }
  async function commit(kind, input, signal) {
    requireValue(exact(input, ['revision', 'server', 'username', 'planId', 'requestId', 'confirm']) && input.confirm === true); validateId(input.requestId);
    const hash = sha256(canonicalJson(input));
    let previous = (await load()).onboarding?.find(batch => batch.id === input.requestId);
    if (previous) {
      const grant = await controller.syncAccount();
      if (previous.kind !== kind || previous.inputHash !== hash || ['server', 'username', 'deviceId'].some(key => previous.account[key] !== grant[key])) throw fail('SYNC_REQUEST_CONFLICT');
      return { accepted: true, operationId: previous.id };
    }
    await payloadIdentity(input, ['planId', 'requestId', 'confirm']);
    await controller.mutate(async () => {
      let config = await payloadIdentity(input, ['planId', 'requestId', 'confirm']);
      if (config.operations.some(item => item.id === input.requestId) || (config.onboarding ?? []).some(item => item.id === input.requestId)) throw fail('SYNC_REQUEST_CONFLICT');
      const plan = getPlan(input.planId, kind), grant = await controller.syncAccount(), client = clientFor(grant, config, signal);
      const identity = await identityFor(grant, config, client); planBinding(input, plan, identity);
      if (original(registry()) !== plan.registryProvider) throw fail('SYNC_PLAN_CHANGED');
      if ((config.onboarding?.length ?? 0) >= 100 || config.bindings.length + (config.onboarding ?? []).filter(active).reduce((n, batch) => n + batch.items.length, 0) + plan.items.length > 200) throw fail('SYNC_QUOTA');
      const check = async () => { signal?.throwIfAborted(); life.signal.throwIfAborted(); if (!same(identity, await identityFor(await controller.syncAccount(), await load()))) throw fail('ACCOUNT_MISMATCH'); };
      if (kind === 'clone') await plan.selection.check();
      for (const item of plan.items) {
        unclaimed(config, item.projectId, item.root, item.workspaceId); await check();
        if (kind === 'clone') {
          if (!same(await client.syncHead(item.projectId), item.head)) throw fail('SYNC_HEAD_MISMATCH');
          if (item.migration && !same([...(await client.legacyHeads(item.projectId)).heads].sort(), [...item.migration.expectedLegacyHeads].sort())) throw fail('SYNC_LEGACY_HEAD_MISMATCH');
        } else {
          const local = await workspace(item.workspaceId); await verifySyncRoot(item.rootIdentity);
          if (rootKey(local.root) !== rootKey(item.root)) throw fail('SYNC_ROOT_CHANGED');
          const captured = await scanPreview(local.root, item.projectId, identity, check, signal);
          if (captured.policyHash !== item.policyHash || sha256(canonicalJson(captured.files)) !== item.localDigest) throw fail('SYNC_PLAN_CHANGED');
          if (await client.syncHead(item.projectId)) throw fail('SYNC_HEAD_MISMATCH');
          const legacy = await client.legacyHeads(item.projectId);
          if (legacy.heads.length || legacy.checkpointCount) throw fail('SYNC_MIGRATION_REQUIRED');
        }
      }
      if (plan.until <= now()) throw fail('SYNC_PLAN_EXPIRED'); await check();
      const descriptor = { version: 1, id: input.requestId, kind, account: identity, ...(kind === 'clone' ? { parentIdentity: plan.selection.parent } : {}), items: plan.items };
      const bytes = Buffer.from(canonicalJson(descriptor)); if (bytes.length > 8 * MAX_MANIFEST_BYTES) throw fail('SYNC_QUOTA');
      await reserveShared(bytes.length); await check();
      try { await writeNewFile(intentPath(input.requestId), bytes); }
      catch (error) { if (error.code !== 'EEXIST' || !(await readStableFile(intentPath(input.requestId), 8 * MAX_MANIFEST_BYTES)).bytes.equals(bytes)) throw error; }
      const batch = { id: input.requestId, kind, account: identity, inputHash: hash, descriptorHash: sha256(bytes), state: 'running', at: stamp(), ...(kind === 'clone' ? { parent: plan.selection.parent.root } : {}), items: plan.items.map(item => ({ id: item.id, projectId: item.projectId, bindingId: item.bindingId, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), label: item.label, root: item.root, state: 'pending', phase: 'pending' })) };
      config = await load(); await save({ ...config, revision: config.revision + 1, account: config.account ?? identity, capability: 'supported', onboarding: [...(config.onboarding ?? []), batch] });
      if (kind === 'clone') acceptedGuards.set(batch.id, plan.selection.checkParent);
    }, { requireIdle: true });
    start(input.requestId); return { accepted: true, operationId: input.requestId };
  }
  const actions = {
    async syncclonepick(input, signal) {
      await payloadIdentity(input, ['projectIds']); identifiers(input.projectIds); nativeRegistry();
      return read(input, ['projectIds'], signal, async context => {
        const { config, client, identity } = await connect(context), items = [];
        for (const projectId of input.projectIds) { unclaimed(config, projectId); const value = await remote(client, projectId, context.check); items.push({ projectId, label: value.label }); }
        return picker.pick(input, items, { ...context, identity });
      });
    },
    async syncclonebrowse(input, signal) { await payloadIdentity(input, ['browserId', 'nodeId']); validateId(input.browserId); validateId(input.nodeId); return read(input, ['browserId', 'nodeId'], signal, async context => picker.browse(input, { ...context, identity: await identityFor(context.identity, await load()) })); },
    async synccloneselect(input, signal) { await payloadIdentity(input, ['browserId', 'nodeId']); validateId(input.browserId); validateId(input.nodeId); return read(input, ['browserId', 'nodeId'], signal, async context => picker.select(input, { ...context, identity: await identityFor(context.identity, await load()) })); },
    async synccloneplan(input, signal) {
      await payloadIdentity(input, ['destinationId', 'primaryLegacyIds']); validateId(input.destinationId); nativeRegistry();
      const primary = new Map();
      if (input.primaryLegacyIds !== undefined) { requireValue(Array.isArray(input.primaryLegacyIds) && input.primaryLegacyIds.length <= 20); for (const item of input.primaryLegacyIds) { requireValue(exact(item, ['projectId', 'checkpointId']) && !primary.has(item.projectId)); primary.set(validateId(item.projectId), validateId(item.checkpointId)); } }
      return read(input, ['destinationId', 'primaryLegacyIds'], signal, async context => {
        const { config, client, identity } = await connect(context), selection = picker.resolve(input, identity), choices = [], items = [];
        requireValue([...primary.keys()].every(id => selection.items.some(item => item.projectId === id)));
        await selection.check();
        for (const destination of selection.items) {
          unclaimed(config, destination.projectId, destination.root);
          const value = await remote(client, destination.projectId, context.check, primary.get(destination.projectId));
          if (value.choices) { choices.push({ projectId: destination.projectId, label: value.label, heads: value.choices }); continue; }
          const policy = createExclusionPolicy({ excluded: ['.dsh-syncignore', '**/.dsh-syncignore'], excludedPaths: await exclusions(destination.root) });
          const summary = { upload: 0, download: value.manifest.files.filter(file => !policy.isExcluded(file.path)).length, delete: 0, conflicts: value.manifest.conflicts.length, blocked: 0 };
          items.push({ ...destination, id: randomUUID(), bindingId: `binding-${randomUUID()}`, head: value.head, manifest: value.manifest, ...(value.migration ? { migration: value.migration } : {}), summary });
        }
        await selection.check(); await context.check();
        if (choices.length) return { requiresLegacyChoice: true, choices };
        const plan = putPlan({ kind: 'clone', revision: input.revision, server: input.server, username: input.username, identity, selection, items, registryProvider: original(nativeRegistry()) });
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), parent: selection.parent.root, items: items.map(({ projectId, label, root, summary, migration }) => ({ projectId, label, root, summary, migrationRequired: Boolean(migration) })), summary: total(items) } };
      });
    },
    syncclonecommit: (input, signal) => commit('clone', input, signal),
    async syncpublishplan(input, signal) {
      await payloadIdentity(input, ['workspaceIds']); identifiers(input.workspaceIds, true);
      return read(input, ['workspaceIds'], signal, async context => {
        const { config, identity } = await connect(context), items = [];
        for (const workspaceId of input.workspaceIds) {
          const local = await workspace(workspaceId), projectId = `project-${randomUUID()}`;
          unclaimed(config, projectId, local.root, workspaceId);
          if (items.some(item => within(rootKey(item.root), rootKey(local.root)) || within(rootKey(local.root), rootKey(item.root)))) throw fail('SYNC_MANAGED_PROJECT');
          const captured = await scanPreview(local.root, projectId, identity, context.check, context.signal);
          items.push({ id: randomUUID(), bindingId: `binding-${randomUUID()}`, workspaceId, projectId, root: local.root, label: local.label, rootIdentity: captured.rootIdentity, localDigest: sha256(canonicalJson(captured.files)), policyHash: captured.policyHash, summary: { upload: captured.files.length, download: 0, delete: 0, conflicts: 0, blocked: 0 } });
        }
        await context.check();
        const plan = putPlan({ kind: 'publish', revision: input.revision, server: input.server, username: input.username, identity, items, registryProvider: original(registry()) });
        return { plan: { id: plan.id, expiresAt: new Date(plan.until).toISOString(), items: items.map(({ workspaceId, projectId, label, root, summary }) => ({ workspaceId, projectId, label, root, summary })), summary: total(items) } };
      });
    },
    syncpublishcommit: (input, signal) => commit('publish', input, signal),
  };
  return { actions, get running() { return workers.size > 0; }, async tick() {
    if (workers.size) return true;
    const config = await load(), candidates = (config.onboarding ?? []).filter(active);
    if (!candidates.length) return false;
    const grant = await controller.syncAccount(), identity = await identityFor(grant, config);
    const batch = candidates.find(item => same(item.account, identity));
    if (!batch) return false; start(batch.id); return true;
  }, stop() { stopped = true; picker.stop(); }, async drain() { await Promise.allSettled([...workers.values()]); } };
}
