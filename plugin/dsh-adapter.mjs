import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sha256, validateId, validateManifest, validateRelativePath, MAX_BLOB_BYTES, MAX_CHECKPOINT_BYTES } from '../src/protocol.mjs';
import { assertNoSymlinks, readStableFile } from '../src/files.mjs';

// Verified against installed DSH 0.2.0-rc.2, Session format 4. See .inspection/SDK-NOTES.md.
export const SESSION_ENVELOPE_FORMAT = 'dsh-personal-sync/session';
export const SESSION_ENVELOPE_VERSION = 1;
const FORMAT_VERSION = 4;
const HASH_ID = /^sha256:([a-f0-9]{64})$/;
const MAX_EVENTS = 100_000;
const MAX_ASSETS = 2_000;
const MAX_SESSION_ASSET_BYTES = 256 * 1024 * 1024;
const IMPORT_UNSUPPORTED = /^(?:subagent\/|team\/|tool-workflow\/|goal\/|schedule\/|approval\/|sandbox\/|permission\/|plan\/|image\/|session-log-deepseek\/)/;
const IMPORT_SAFE_SOURCES = new Set(['user', 'model', 'tool', 'system-prompt', 'compact-checkpoint', 'dsh-session-title-llm']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const service = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
const safeReason = (error, fallback) => error?.adapterReason ?? fallback;
function refuse(reason) { const error = new Error(reason); error.adapterReason = reason; throw error; }
function requireCondition(value, reason) { if (!value) refuse(reason); }
function pathApi(value) { return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix; }
function sameForeignPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const api = pathApi(a);
  if (api !== pathApi(b) || !api.isAbsolute(a) || !api.isAbsolute(b)) return false;
  const normalize = value => { const normalized = api.normalize(value).replace(/[\\/]+$/, ''); return api === path.win32 ? normalized.toLowerCase() : normalized; };
  return normalize(a) === normalize(b);
}
function projectRelative(sourceRoot, value) {
  requireCondition(typeof value === 'string' && !/[\x00-\x1f]/.test(value), 'unsupported deliverable path');
  const api = pathApi(sourceRoot);
  // Reject a foreign absolute spelling rather than treating it as a relative filename.
  if (pathApi(value) !== api && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))) return undefined;
  const absolute = api.resolve(sourceRoot, value);
  const relative = api.relative(sourceRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
  const portable = relative.split(api.sep).join('/');
  try { return validateRelativePath(portable); } catch { return undefined; }
}
function assertHeader(header, id, sourceRoot) {
  requireCondition(object(header) && header.version === FORMAT_VERSION && header.id === id, 'unsupported session header or identity');
  const allowed = new Set(['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']);
  requireCondition(Object.keys(header).every(key => allowed.has(key)), 'unsupported session header field');
  requireCondition(Number.isSafeInteger(header.createdAt) && header.createdAt >= 0 && typeof header.isSeeded === 'boolean', 'invalid session header');
  requireCondition(sameForeignPath(header.cwd, sourceRoot), 'session workspace does not match snapshot root');
}

async function loadInstalledSdk() {
  // Resolve ONLY through the hosting profile's normal package resolver. Never inspect ~/.dsh,
  // credentials, an installation path, or a downloaded substitute to find an SDK.
  const [{ sessionFormatCatalog }, { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION }, { BlockAssembler, expandAssistantStream }] = await Promise.all([
    import('@deepseek-ai/dsh-session-format-catalog'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-llm'),
  ]);
  requireCondition(SESSION_FORMAT_VERSION === FORMAT_VERSION && sessionFormatCatalog.currentVersion === FORMAT_VERSION, 'unsupported installed session format');
  // Catalog validates relationships but intentionally leaves embedded streams opaque.
  // Match the JSONL provider's isolated current-generation verifier (lines 1833-1848).
  const validateAssistantStreams = events => {
    for (const event of events) {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
      const assembler = new BlockAssembler(), timed = expandAssistantStream(event.data.stream);
      for (const member of timed) assembler.push(member.chunk);
      if (event.type === 'assistant/attempt' || timed.length === 0) continue;
      const content = event.data.interrupted === true ? assembler.interruptedBlocks() : assembler.blocks();
      requireCondition(isDeepStrictEqual(event.data.message.content, content) && isDeepStrictEqual(event.data.usage, assembler.usage) && isDeepStrictEqual(event.data.message.source.replayState, assembler.replayState), 'invalid embedded assistant stream settlement');
    }
  };
  return { catalog: sessionFormatCatalog, knownEventTypes: KNOWN_SESSION_EVENT_TYPES, validateAssistantStreams };
}
function validateArtifact(sdk, header, events, inheritedEventCount) {
  requireCondition(sdk.catalog.currentVersion === FORMAT_VERSION, 'unsupported installed session format');
  requireCondition(Array.isArray(events) && events.length <= MAX_EVENTS && Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0 && inheritedEventCount <= events.length, 'invalid session event sequence');
  const normalizedHeader = { ...clone(header), delegationDepth: header.delegationDepth ?? 0 };
  // Round-trip through the installed native V4 codec and its full relationship validator.
  // Strict framing refuses torn/gapped tails instead of silently accepting a shorter log.
  const restore = sdk.catalog.createRestore(sdk.catalog.encodeCurrentHeader(normalizedHeader, inheritedEventCount), { recovery: 'strict', validation: 'current' });
  for (const event of events) restore.decodeRow(sdk.catalog.encodeCurrentEvent(clone(event)));
  const restored = restore.finish();
  sdk.validateAssistantStreams(restored.events);
  requireCondition(restored.inheritedEventCount === inheritedEventCount && restored.events.length === events.length, 'session inherited cut changed during validation');
  return { header: normalizedHeader, events: clone(restored.events), inheritedEventCount };
}
function idleLog(events) {
  let openTurn = false, openStep = false;
  const pendingCalls = new Set(), commands = new Set();
  const inbox = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case 'turn/start': requireCondition(!openTurn, 'incomplete nested turn'); openTurn = true; break;
      case 'turn/end': requireCondition(!openStep && pendingCalls.size === 0, 'incomplete tool or step'); openTurn = false; break;
      case 'step/start': requireCondition(openTurn && !openStep, 'incomplete step boundary'); openStep = true; break;
      case 'step/end': requireCondition(pendingCalls.size === 0, 'incomplete tool result'); openStep = false; break;
      case 'assistant/message':
        if (event.surfaceOp === 'append') for (const block of data.message?.content ?? []) if (block.type === 'tool-call') pendingCalls.add(block.id);
        break;
      case 'tool/call': pendingCalls.add(data.callId); break;
      case 'tool/result': if (event.surfaceOp === 'append') pendingCalls.delete(data.message?.source?.callId); break;
      case 'command/run': commands.add(data.commandId); break;
      case 'command/done': commands.delete(data.commandId); break;
      case 'agent/inbox/spliced': {
        const target = inbox[data.target], removedCount = data.removedCount ?? 0;
        requireCondition(target && Number.isSafeInteger(data.start) && data.start >= 0 && data.start <= target.length && Number.isSafeInteger(removedCount) && removedCount >= 0 && data.start + removedCount <= target.length && Array.isArray(data.inserted), 'invalid pending inbox history');
        target.splice(data.start, removedCount, ...data.inserted);
        const ids = [...inbox['next-turn'], ...inbox['next-step']].map(message => message.id);
        requireCondition(ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length, 'invalid pending inbox identities');
        break;
      }
    }
  }
  requireCondition(!openTurn && !openStep && pendingCalls.size === 0 && commands.size === 0, 'incomplete turn, tool, or command');
  requireCondition(inbox['next-turn'].length === 0 && inbox['next-step'].length === 0, 'pending agent inbox');
}
function checkImportSubset(sdk, artifact) {
  requireCondition(artifact.header.origin === undefined && (artifact.header.delegationDepth ?? 0) === 0, 'unsupported subagent session hierarchy');
  for (const event of artifact.events) {
    requireCondition(sdk.knownEventTypes.has(event.type), 'unsupported plugin event for resumable import');
    requireCondition(!IMPORT_UNSUPPORTED.test(event.type), `unsupported state domain for resumable import: ${event.type}`);
    // Message source kinds outside the understood first-party subset may own an execution
    // queue, remote parent, provider scope, or device-specific effects. Keep their archive,
    // but never infer resumability from an arbitrary string accepted by Session alone.
    const messages = event.type === 'user/message' ? [event.data] : event.data?.message ? [event.data.message] : event.type === 'agent/inbox/spliced' ? event.data.inserted : [];
    for (const message of messages) if (message?.source) requireCondition(IMPORT_SAFE_SOURCES.has(message.source.kind), 'unsupported message producer for resumable import');
  }
}
function validateRef(kind, ref) {
  requireCondition(object(ref) && HASH_ID.test(ref.attachmentId) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= MAX_BLOB_BYTES, 'invalid attachment reference');
  if (kind === 'image') requireCondition(['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType) && Number.isSafeInteger(ref.width) && ref.width > 0 && Number.isSafeInteger(ref.height) && ref.height > 0, 'invalid image reference');
  else {
    requireCondition(typeof ref.name === 'string', 'invalid file attachment name');
    validateRelativePath(ref.name);
    requireCondition(!ref.name.includes('/'), 'invalid file attachment name');
  }
  if (ref.name !== undefined) requireCondition(typeof ref.name === 'string' && !/[\\/\x00-\x1f]/.test(ref.name), 'invalid attachment display name');
}
function refKey(kind, ref) { return `${kind}:${ref.attachmentId}:${ref.name ?? ''}`; }
function resourcesOf(events, sourceRoot) {
  const refs = new Map(), rawRefs = [], deliverables = [];
  // Native content and compact-stream block objects have the same typed {type,attachment}
  // shape. Never parse message text or interpret a path string as a file to read.
  function walk(value, depth = 0) {
    requireCondition(depth <= 100, 'unsupported deeply nested session data');
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.hasOwn(value, 'attachmentId')) rawRefs.push(value);
    if (object(value) && (value.type === 'image' || value.type === 'file') && value.attachment !== undefined) {
      const kind = value.type, ref = value.attachment;
      validateRef(kind, ref);
      const key = refKey(kind, ref), existing = refs.get(key);
      requireCondition(!existing || JSON.stringify(existing.ref) === JSON.stringify(ref), 'inconsistent attachment metadata');
      refs.set(key, { kind, ref: clone(ref), sha256: ref.attachmentId.slice(7) });
      requireCondition(refs.size <= MAX_ASSETS, 'too many session attachments');
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  }
  for (const event of events) {
    walk(event.data);
    if (event.type === 'deliverables/presented') {
      requireCondition(Array.isArray(event.data.files), 'invalid presented files');
      for (const [index, file] of event.data.files.entries()) {
        const relativePath = projectRelative(sourceRoot, file.path);
        deliverables.push({ eventSeq: event.seq, index, ...(relativePath === undefined ? { external: true } : { relativePath }) });
      }
    }
  }
  // An attachmentId without a recognized complete block cannot authorize an arbitrary
  // provider read. Already-discovered references repeated in tool arguments are harmless.
  const ids = new Set([...refs.values()].map(item => item.ref.attachmentId));
  for (const ref of rawRefs) requireCondition(ids.has(ref.attachmentId), 'unsupported attachment reference outside a complete content block');
  return { attachments: [...refs.values()].sort((a, b) => refKey(a.kind, a.ref).localeCompare(refKey(b.kind, b.ref), 'en')), deliverables };
}
async function readAsset(attachments, item, { signal, check = async () => {} } = {}) {
  requireCondition(attachments, 'attachment provider unavailable');
  await check(); signal?.throwIfAborted();
  let bytes;
  if (item.kind === 'image') bytes = Buffer.from((await attachments.readImage(item.ref, signal)).data);
  else {
    const chunks = []; let size = 0;
    for await (const chunk of attachments.readFileStream(item.ref, signal)) {
      await check(); signal?.throwIfAborted();
      const data = Buffer.from(chunk); size += data.length;
      requireCondition(size <= item.ref.bytes && size <= MAX_BLOB_BYTES, 'attachment exceeds declared size'); chunks.push(data);
    }
    bytes = Buffer.concat(chunks, size);
  }
  await check(); signal?.throwIfAborted();
  requireCondition(bytes.length === item.ref.bytes && sha256(bytes) === item.sha256, 'attachment integrity check failed');
  return bytes;
}
async function activeReason(ctx, id) {
  try {
  const agents = service(ctx, 'agents'), agent = agents?.get(id);
  if (agent) {
    if (agent.status !== 'idle') return 'active running agent';
    if (typeof agent.whenIdle !== 'function') return 'busy: cannot establish agent maintenance state';
    let token;
    const idle = await Promise.race([agent.whenIdle().then(() => true), new Promise(resolve => { token = setImmediate(() => resolve(false)); })]);
    if (token) clearImmediate(token);
    if (!idle || agent.status !== 'idle') return 'active agent maintenance';
    if (agent.inbox?.hasPending) return 'pending agent inbox';
  }
  if (typeof ctx.waterfall !== 'function') return 'busy: activity admission hook unavailable';
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
  if (!Array.isArray(activity)) return 'busy: unknown activity admission result';
  if (activity.length) return 'active background job, subagent, or schedule';
  return undefined;
  } catch {
    return 'busy: unable to establish Host activity state';
  }
}

// A cache path is a Host capability, never a browser-supplied string. Its namespace
// is deliberately separate from the target workspace and from legacy restore files.
const archiveDirectories = new WeakMap();
const localKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
export async function authorizeSessionArchiveDirectory({ directory, stateDir }) {
  requireCondition(typeof directory === 'string' && path.isAbsolute(directory) && typeof stateDir === 'string' && path.isAbsolute(stateDir), 'invalid archive cache directory');
  const base = await fs.realpath(await assertNoSymlinks(path.join(stateDir, 'session-sync')));
  const root = await fs.realpath(await assertNoSymlinks(directory));
  requireCondition(within(localKey(root), localKey(base)) && localKey(root) !== localKey(base) && (await fs.lstat(root)).isDirectory(), 'archive directory is not a dedicated plugin cache');
  const token = Object.freeze({}); archiveDirectories.set(token, { root, base }); return token;
}
async function archivePath(capability, root) {
  const saved = archiveDirectories.get(capability);
  requireCondition(saved, 'invalid Host archive directory capability');
  const current = await fs.realpath(await assertNoSymlinks(saved.root));
  requireCondition(localKey(current) === localKey(saved.root) && within(localKey(current), localKey(saved.base)) && !within(localKey(current), localKey(root)) && !within(localKey(root), localKey(current)), 'archive cache overlaps or changed target workspace');
  return current;
}

/** Factory is an explicit test seam; production exports always use the installed SDK. */
export function createDshAdapter({ loadSdk = loadInstalledSdk, newId = () => `session-${randomUUID()}` } = {}) {
  let sdkPromise;
  const sdkFor = () => sdkPromise ??= loadSdk();
  return {
    /** Export coherent durable V4 archives; no user configuration or credential API is read. */
    async exportProjectSessions(ctx, root, options = {}) {
      const { onAsset, onSession, signal, check = async () => {}, maxBytes = MAX_CHECKPOINT_BYTES } = options;
      requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_CHECKPOINT_BYTES, 'invalid archive export budget');
      const selected = options.sessionIds === undefined ? undefined : new Set(options.sessionIds.map(validateId));
      let callbackError, totalBytes = 0;
      const boundary = async action => { try { signal?.throwIfAborted(); return await action(); } catch (error) { callbackError = error; throw error; } };
      const guard = () => boundary(check);
      const charge = size => { totalBytes += size; requireCondition(totalBytes <= maxBytes, 'archive export exceeds aggregate safety limit'); };
      await guard();
      root = await fs.realpath(await assertNoSymlinks(path.resolve(root)));
      const persistence = service(ctx, 'sessionPersistence');
      requireCondition(persistence && typeof persistence.list === 'function' && typeof persistence.open === 'function', 'session persistence provider unavailable');
      const sdk = await sdkFor(), sessions = [], skipped = [], assets = new Map(), assetSizes = new Map(), observations = new Map();
      const initialListing = await persistence.list({ signal });
      const included = header => sameForeignPath(header?.cwd, root) && (!selected || selected.has(header.id));
      const rootIds = listing => listing.filter(item => included(item.header)).map(item => item.header.id).sort();
      const initialIds = rootIds(initialListing);
      const liveSessions = service(ctx, 'sessions');
      const liveIds = () => (liveSessions?.list?.() ?? []).filter(item => included(item.header)).map(item => item.id).sort();
      const initialLiveIds = liveIds();
      for (const listed of initialListing) {
        const id = listed.header?.id;
        if (!included(listed.header)) continue;
        await guard();
        let handle;
        try {
          validateId(id);
          requireCondition(Number.isSafeInteger(listed.sizeBytes) && listed.sizeBytes > 0, 'incomplete: session has not materialized on disk');
          if (onSession || onAsset) requireCondition(listed.sizeBytes <= maxBytes, 'archive export exceeds aggregate safety limit');
          const activity = await activeReason(ctx, id); if (activity) refuse(activity);
          const live = service(ctx, 'sessions')?.get(id);
          if (live) await service(ctx, 'sessions').flush(live);
          const before = await persistence.stat(id, { signal });
          handle = await persistence.open(id, 'read', { signal });
          // One excess event makes a too-large log fail closed, never truncate into
          // an apparently complete archive. The SDK may internally decode the whole log.
          const read = await handle.read(0, MAX_EVENTS + 1, { signal });
          await guard();
          const header = clone(handle.header);
          assertHeader(header, id, root);
          const artifact = validateArtifact(sdk, header, read.events, handle.inheritedEventCount);
          idleLog(artifact.events);
          const resources = resourcesOf(artifact.events, root), pendingAssets = new Map(), sessionAssets = new Set();
          let byteCount = 0;
          for (const item of resources.attachments) {
            await guard();
            if (!sessionAssets.has(item.sha256)) { byteCount += item.ref.bytes; sessionAssets.add(item.sha256); }
            requireCondition(byteCount <= MAX_SESSION_ASSET_BYTES, 'session attachments exceed export safety limit');
            if (onAsset && assetSizes.has(item.sha256)) { requireCondition(assetSizes.get(item.sha256) === item.ref.bytes, 'attachment size mismatch'); continue; }
            const bytes = assets.get(item.sha256) ?? pendingAssets.get(item.sha256) ?? await readAsset(service(ctx, 'attachments'), item, { signal, check: guard });
            requireCondition(bytes.length === item.ref.bytes, 'attachment size mismatch');
            if (!assetSizes.has(item.sha256)) { charge(bytes.length); assetSizes.set(item.sha256, bytes.length); }
            if (onAsset) await boundary(() => onAsset(bytes, { hash: item.sha256, size: bytes.length }));
            else pendingAssets.set(item.sha256, bytes);
          }
          const after = await persistence.stat(id, { signal });
          const changed = !before || !after || before.revision !== after.revision || before.sizeBytes !== after.sizeBytes || JSON.stringify(before.header) !== JSON.stringify(after.header) || service(ctx, 'sessions')?.get(id) !== live || (live && live.seq !== artifact.events.length);
          requireCondition(!changed, 'active session changed during export');
          const finalActivity = await activeReason(ctx, id); if (finalActivity) refuse(finalActivity);
          // Every field is deterministic for unchanged content; polling will not mint false diffs.
          const data = { format: SESSION_ENVELOPE_FORMAT, version: SESSION_ENVELOPE_VERSION, sessionFormatVersion: FORMAT_VERSION, sessionId: id, sourceRoot: root, ...artifact, ...resources };
          const size = Buffer.byteLength(JSON.stringify(data));
          requireCondition(size <= MAX_BLOB_BYTES, 'session archive exceeds blob size limit'); charge(size);
          if (onSession) await boundary(() => onSession({ id, data }));
          else sessions.push({ id, data });
          observations.set(id, { revision: after.revision, sizeBytes: after.sizeBytes, header: JSON.stringify(after.header), live, seq: live?.seq });
          for (const [hash, bytes] of pendingAssets) assets.set(hash, bytes);
        } catch (error) {
          if (error === callbackError || signal?.aborted || (onAsset || onSession) && /(?:safety limit|blob size limit)$/.test(error?.adapterReason ?? '')) throw error;
          skipped.push({ id: typeof id === 'string' ? id : 'unknown', reason: safeReason(error, 'session validation or durable read failed') });
        } finally { if (handle) await handle.close(); }
      }
      // Called by the project snapshot owner immediately before it queues a checkpoint.
      // This is an optimistic Host execution guard, not a cross-process/filesystem transaction.
      const verifyUnchanged = async () => {
        await guard();
        const listing = await persistence.list({ signal });
        requireCondition(JSON.stringify(rootIds(listing)) === JSON.stringify(initialIds) && JSON.stringify(liveIds()) === JSON.stringify(initialLiveIds), 'active project session set changed during capture');
        for (const id of new Set([...initialIds, ...initialLiveIds])) {
          const activity = await activeReason(ctx, id); if (activity) refuse(activity);
        }
        for (const [id, observation] of observations) {
          await guard();
          const current = await persistence.stat(id, { signal }), live = service(ctx, 'sessions')?.get(id);
          requireCondition(current && current.revision === observation.revision && current.sizeBytes === observation.sizeBytes && JSON.stringify(current.header) === observation.header && live === observation.live && live?.seq === observation.seq, 'active session changed during project capture');
        }
      };
      return { sessions, assets: [...assets.values()], skipped, verifyUnchanged };
    },

    /**
     * Import ONLY the documented resumable subset as new, independent, persisted sessions.
     * Never calls agents.create/resume, sessions.create, a tool, a prompt, or an execution hook.
     * Unsupported archives remain untouched in .dsh-sync for future adapters/manual inspection.
     */
    async importProjectSessions(ctx, { manifest, root, archiveDirectory, allocateSessionId, onResult, check = async () => {}, signal }) {
      const guard = async () => { signal?.throwIfAborted(); await check(); signal?.throwIfAborted(); };
      await guard(); manifest = validateManifest(manifest);
      root = await fs.realpath(await assertNoSymlinks(path.resolve(root)));
      const meta = archiveDirectory === undefined ? path.join(root, '.dsh-sync') : await archivePath(archiveDirectory, root);
      await assertNoSymlinks(meta);
      for (const directory of new Set([meta, path.join(root, '.dsh-sync')])) {
        try { await assertNoSymlinks(path.join(directory, 'INCOMPLETE')); refuse('incomplete project restore marker exists'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const persistence = service(ctx, 'sessionPersistence');
      requireCondition(persistence && typeof persistence.create === 'function' && typeof persistence.stat === 'function', 'session persistence provider unavailable');
      const sdk = await sdkFor(), imported = [], skipped = [], failed = [], mapping = {};
      const files = new Map(manifest.files.map(file => [file.path, file]));
      async function verifiedFile(logicalPath, physicalPath) {
        await guard();
        const entry = files.get(logicalPath);
        requireCondition(entry, 'referenced file is absent from checkpoint manifest');
        const { bytes } = await readStableFile(await assertNoSymlinks(physicalPath));
        requireCondition(bytes.length === entry.size && sha256(bytes) === entry.sha256, 'checkpoint file hash or size mismatch');
        return bytes;
      }
      for (const oldId of manifest.sessionIds) {
        let id, handle, durable = false, providerWrite = false;
        try {
          const bytes = await verifiedFile(`sessions/${oldId}.json`, path.join(meta, 'sessions', `${oldId}.json`));
          const envelope = JSON.parse(bytes.toString('utf8'));
          requireCondition(object(envelope) && envelope.format === SESSION_ENVELOPE_FORMAT && envelope.version === SESSION_ENVELOPE_VERSION && envelope.sessionFormatVersion === FORMAT_VERSION, 'unsupported session envelope format/version');
          requireCondition(envelope.sessionId === oldId && envelope.sourceRoot === manifest.sourceRoot, 'session envelope identity or source root mismatch');
          const keys = new Set(['format', 'version', 'sessionFormatVersion', 'sessionId', 'sourceRoot', 'header', 'events', 'inheritedEventCount', 'attachments', 'deliverables']);
          requireCondition(Object.keys(envelope).every(key => keys.has(key)), 'unsupported session envelope field');
          assertHeader(envelope.header, oldId, envelope.sourceRoot);
          // Foreign Windows/POSIX cwd is mapped BEFORE the host's platform-specific header
          // validator; source identity and root were independently checked immediately above.
          const artifact = validateArtifact(sdk, { ...envelope.header, cwd: root }, envelope.events, envelope.inheritedEventCount);
          idleLog(artifact.events);
          checkImportSubset(sdk, artifact);
          const resources = resourcesOf(artifact.events, envelope.sourceRoot);
          // Canonical archive wrappers may reorder object keys; compare the exact
          // logical mappings, not JSON member order. No fields/subsets are relaxed.
          requireCondition(isDeepStrictEqual(resources.attachments, envelope.attachments) && isDeepStrictEqual(resources.deliverables, envelope.deliverables), 'session resource mapping mismatch');
          const assetBytes = new Map();
          let totalBytes = 0;
          for (const item of resources.attachments) {
            if (assetBytes.has(item.sha256)) continue;
            const data = await verifiedFile(`assets/${item.sha256}`, path.join(meta, 'assets', item.sha256));
            requireCondition(data.length === item.ref.bytes && sha256(data) === item.sha256, 'attachment hash or size mismatch');
            totalBytes += data.length; requireCondition(totalBytes <= MAX_SESSION_ASSET_BYTES, 'session attachments exceed import safety limit');
            assetBytes.set(item.sha256, data);
          }
          for (const item of resources.deliverables) {
            requireCondition(!item.external, 'unsupported external deliverable: not copied or remapped');
            const local = path.join(root, ...item.relativePath.split('/'));
            await verifiedFile(`project/${item.relativePath}`, local);
            artifact.events[item.eventSeq].data.files[item.index].path = local;
          }
          await guard();
          id = validateId(allocateSessionId ? await allocateSessionId(oldId) : newId());
          await guard();
          requireCondition(!manifest.sessionIds.includes(id) && !service(ctx, 'sessions')?.get(id) && !service(ctx, 'agents')?.get(id) && !(await persistence.stat(id)), 'new session identity collision');
          // Do not inherit another device's parent identity, selected executable preset,
          // delegation, or permissions. Unsupported event domains were rejected, not replayed.
          const header = { version: FORMAT_VERSION, id, createdAt: Date.now(), cwd: root, isSeeded: artifact.header.isSeeded, delegationDepth: 0 };
          const checked = validateArtifact(sdk, header, artifact.events, artifact.inheritedEventCount);
          const attachments = service(ctx, 'attachments');
          for (const item of resources.attachments) {
            await guard();
            requireCondition(attachments, 'attachment provider unavailable');
            providerWrite = true;
            const input = { data: assetBytes.get(item.sha256), ...(item.ref.name === undefined ? {} : { name: item.ref.name }) };
            const saved = item.kind === 'image' ? await attachments.saveImage({ ...input, mediaType: item.ref.mediaType }) : await attachments.saveFile(input);
            requireCondition(saved.attachmentId === item.ref.attachmentId && saved.bytes === item.ref.bytes && (item.kind !== 'image' || saved.mediaType === item.ref.mediaType && saved.width === item.ref.width && saved.height === item.ref.height) && saved.name === item.ref.name, 'attachment normalization changed immutable reference');
          }
          await guard(); providerWrite = true;
          handle = await persistence.create(checked.header, { inheritedEventCount: checked.inheritedEventCount, ...(signal ? { signal } : {}) });
          await guard(); await handle.append(checked.events, { signal });
          await guard(); await handle.flush({ signal });
          durable = true;
          await handle.close(); handle = undefined;
          mapping[oldId] = id;
          const result = { sourceId: oldId, sessionId: id, workspaceAttached: false };
          imported.push(result);
          const workspaceRegistry = service(ctx, 'workspaceRegistry');
          if (workspaceRegistry) {
            try { await guard(); const workspace = await workspaceRegistry.create(root); await guard(); await workspace.attachSession(id); result.workspaceId = workspace.id; result.workspaceAttached = true; }
            catch { result.warning = 'Session is durable but workspace attachment failed; no agent was started'; }
          }
        } catch (error) {
          const reason = safeReason(error, 'session validation or import failed');
          if (handle || durable || allocateSessionId && providerWrite) failed.push({ id: oldId, sessionId: id, reason, mayHaveDurableSession: true });
          else skipped.push({ id: oldId, reason });
        } finally {
          if (handle) try { await handle.close(); } catch { failed.push({ id: oldId, sessionId: id, reason: 'session handle close failed', mayHaveDurableSession: true }); }
        }
        if (onResult) await onResult({ sourceId: oldId, imported: clone(imported.filter(item => item.sourceId === oldId)), skipped: clone(skipped.filter(item => item.id === oldId)), failed: clone(failed.filter(item => item.id === oldId)), mapping: id && mapping[oldId] ? { [oldId]: id } : {} });
      }
      return { imported, skipped, failed, mapping };
    },
  };
}
const installedAdapter = createDshAdapter();
export const exportProjectSessions = (ctx, root, options) => installedAdapter.exportProjectSessions(ctx, root, options);
export const importProjectSessions = (ctx, options) => installedAdapter.importProjectSessions(ctx, options);
