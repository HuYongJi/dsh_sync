import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ownPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const CURRENT_VERSION = ownPackage.version;
export const UPDATE_COMMITS_URL = 'https://api.github.com/repos/HuYongJi/dsh_sync/commits?per_page=1';
const PACKAGE = 'dsh-personal-sync';
const REPOSITORY = 'https://github.com/HuYongJi/dsh_sync';
const RAW = 'https://raw.githubusercontent.com/HuYongJi/dsh_sync/';
const original = Symbol.for('cordis.original'); // Installed Cordis trace proxies expose their original service.
const object = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const failure = code => Object.assign(new Error(code), { code });
const requireValue = condition => { if (!condition) throw failure('BAD_REQUEST'); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value.toLowerCase());
export function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return undefined;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function newerVersion(value, baseline) {
  const next = stableVersion(value), previous = stableVersion(baseline);
  if (!next || !previous) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}
function metadata(value) {
  const bad = () => { throw failure('UPDATE_INVALID_METADATA'); };
  if (!object(value) || value.name !== PACKAGE || !stableVersion(value.version)) bad();
  if (!object(value.dsh) || !object(value.dsh.bundle) || value.dsh.bundle.patch !== './cordis.patch.yml'
    || !object(value.dsh.client) || value.dsh.client.platform !== 'web'
    || !Array.isArray(value.dsh.client.inject)
    || !['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-connection'].every(name => value.dsh.client.inject.includes(name))
    || !object(value.exports) || value.exports['.'] !== './plugin/index.mjs' || value.exports['./client'] !== './client/dist/client.js') bad();
  if (!object(value.peerDependencies)) bad();
  for (const [name, version] of Object.entries(ownPackage.peerDependencies)) if (value.peerDependencies[name] !== version) bad();
  for (const [name, version] of Object.entries(value.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-') && version !== '0.2.0-rc.2') bad();
  }
  if (value.scripts !== undefined && !object(value.scripts)) bad();
  // The fixed repository currently needs no package lifecycle hooks. Do not silently
  // introduce another executable surface; native dependency build policy remains authoritative.
  if (['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'].some(key => Object.hasOwn(value.scripts || {}, key))) bad();
  return value.version;
}

/** Optional native manager only; no package-manager process, profile writes or cloud credentials. */
export function createUpdateService(ctx, controller, {
  fetch: fetchImpl = globalThis.fetch, now = Date.now, currentVersion = CURRENT_VERSION,
  timeoutMs = 15_000, candidateTtlMs = 15 * 60_000, checkIntervalMs = 30_000, maxRequests = 1000,
} = {}) {
  requireValue(Boolean(stableVersion(currentVersion)) && typeof fetchImpl === 'function');
  requireValue([timeoutMs, candidateTtlMs, maxRequests].every(value => Number.isSafeInteger(value) && value > 0) && Number.isSafeInteger(checkIntervalMs) && checkIntervalMs >= 0 && maxRequests <= 10_000);
  const lifetime = new AbortController(), jobs = new Map();
  let disposed = false, checking, admitting = false, admissionTask, candidate, latest, lastCheck = -Infinity;
  let state = 'idle', errorCode, restartRequired = false;
  const open = () => { if (disposed) throw failure('DISPOSED'); };
  const profile = () => ctx.profileContext?.dir;
  const identity = manager => manager[original] || manager;
  async function availability() {
    let manager;
    try {
      manager = ctx.get?.('pluginManager');
      if (!manager || !['listBundles', 'installBundle', 'cancelInstall'].every(name => typeof manager[name] === 'function')) return { supported: false, errorCode: 'UPDATE_UNAVAILABLE' };
      const rows = await manager.listBundles();
      if (!Array.isArray(rows)) return { supported: false, errorCode: 'UPDATE_UNAVAILABLE' };
      const matches = rows.filter(row => row?.name === PACKAGE), row = matches[0];
      const installedVersion = stableVersion(row?.version) ? row.version : undefined;
      if (matches.length !== 1 || row.installed !== true || row.readOnlyReason || row.error || typeof row.enabled !== 'boolean' || !installedVersion) {
        return { supported: false, ...(installedVersion ? { installedVersion } : {}), errorCode: 'UPDATE_UNMANAGED' };
      }
      if (installedVersion !== currentVersion) {
        restartRequired = true; controller.markUpdateRestartRequired();
        if (!latest) { state = 'restart-required'; errorCode = 'UPDATE_RESTART_REQUIRED'; candidate = undefined; }
      }
      return { supported: true, installedVersion, manager, row };
    } catch { return { supported: false, errorCode: 'UPDATE_UNAVAILABLE' }; }
  }
  function snapshot(available, job = latest) {
    const expired = !job && candidate && now() >= candidate.expiresAt;
    const record = job?.value || (expired && state === 'available' ? { state: 'idle', errorCode: 'UPDATE_CHECK_REQUIRED' } : { state, ...(errorCode ? { errorCode } : {}) });
    const selected = job?.candidate || candidate;
    const visibleCandidate = selected && (job || now() < selected.expiresAt) ? selected.value : undefined;
    return { currentVersion, ...(available.installedVersion ? { installedVersion: available.installedVersion } : {}), supported: available.supported,
      ...record, restartRequired, ...(visibleCandidate ? { candidate: { ...visibleCandidate } } : {}),
      ...(!available.supported && !record.errorCode ? { errorCode: available.errorCode } : {}) };
  }
  async function status(job) { return { update: snapshot(await availability(), job) }; }
  async function publicJson(url, maximum, signal) {
    const abort = new AbortController(), combined = AbortSignal.any([lifetime.signal, abort.signal, ...(signal ? [signal] : [])]);
    let reader, listener;
    const stopped = new Promise((_, reject) => {
      listener = () => reject(failure('UPDATE_CHECK_FAILED'));
      combined.addEventListener('abort', listener, { once: true });
      if (combined.aborted) listener();
    });
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const operation = (async () => {
        const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { accept: 'application/json' }, signal: combined });
        combined.throwIfAborted();
        if (!response?.ok || response.redirected || (response.url && response.url !== url)) throw failure('UPDATE_CHECK_FAILED');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) throw failure('UPDATE_INVALID_METADATA');
        reader = response.body?.getReader();
        if (!reader) throw failure('UPDATE_INVALID_METADATA');
        const chunks = []; let size = 0;
        for (;;) {
          combined.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maximum) throw failure('UPDATE_INVALID_METADATA');
          chunks.push(value);
        }
        // Fetch exposes decoded bytes, but Content-Length can describe gzip/br bytes.
        // Always bound the decoded stream above; compare lengths only without encoding.
        const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
        if (length !== null && (!encoding || encoding === 'identity') && Number(length) !== size) throw failure('UPDATE_INVALID_METADATA');
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
        catch { throw failure('UPDATE_INVALID_METADATA'); }
      })();
      return await Promise.race([operation, stopped]);
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', listener);
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
      abort.abort();
    }
  }
  async function finish(job, result) {
    if (result?.application === 'cancelled') job.value = { requestId: job.id, state: 'cancelled' };
    else if (result?.error?.code === 'incompatible-version') job.value = { requestId: job.id, state: 'failed', errorCode: 'UPDATE_INCOMPATIBLE' };
    else if (result?.packageResult?.kind === 'build-blocked' || Array.isArray(result?.pendingBuilds) && result.pendingBuilds.length) job.value = { requestId: job.id, state: 'failed', errorCode: 'UPDATE_BUILD_APPROVAL_REQUIRED' };
    else if (result?.application === 'failed') job.value = { requestId: job.id, state: 'failed', errorCode: 'UPDATE_FAILED' };
    else {
      const available = await availability();
      const confirmed = ['applied', 'restart-required'].includes(result?.application) && result.target === PACKAGE && result.bundle === PACKAGE
        && !result.error && result.packageResult?.exitCode === 0 && result.packageResult.timedOut !== true
        && available.supported && identity(available.manager) === job.managerIdentity && available.installedVersion === job.candidate.value.version;
      job.value = { requestId: job.id, state: confirmed ? 'restart-required' : 'uncertain', ...(confirmed ? {} : { errorCode: 'UPDATE_UNCERTAIN' }) };
    }
  }
  function cancel(job) {
    if (job.cancelTask || job.settled) return job.cancelTask;
    job.value = { requestId: job.id, state: 'cancelling' };
    const task = Promise.resolve().then(() => job.manager.cancelInstall(job.id)).then(result => {
      if (job.settled) return;
      if (result?.status === 'too-late') job.value = { requestId: job.id, state: 'installing', errorCode: 'UPDATE_CANCEL_TOO_LATE' };
      else if (result?.status !== 'cancelled') job.value = { requestId: job.id, state: 'installing', errorCode: 'UPDATE_UNCERTAIN' };
      // Native 'cancelled' joins the original outcome; only that outcome finalizes the job.
    }).catch(() => { if (!job.settled) job.value = { requestId: job.id, state: 'installing', errorCode: 'UPDATE_UNCERTAIN' }; });
    job.cancelTask = task;
    return task;
  }
  const service = {
    async updatestatus(input = {}) { requireValue(exact(input, [])); open(); return status(); },
    async checkupdate(input = {}, signal) {
      requireValue(exact(input, [])); open();
      if (checking || admitting || latest && !latest.settled) throw failure('BUSY');
      // After any native attempt only a process restart/manual inspection can authorize
      // another attempt. A harmless recheck returns the retained outcome, never reinstalls.
      if (restartRequired) return status();
      if (now() - lastCheck < checkIntervalMs) throw failure('RATE_LIMITED');
      candidate = undefined; state = 'checking'; errorCode = undefined; lastCheck = now();
      const task = (async () => {
        const available = await availability();
        if (!available.supported) { state = 'idle'; errorCode = available.errorCode; return { update: snapshot(available) }; }
        if (restartRequired) return { update: snapshot(available) };
        try {
          const commits = await publicJson(UPDATE_COMMITS_URL, 256 * 1024, signal);
          if (!Array.isArray(commits) || !object(commits[0]) || typeof commits[0].sha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(commits[0].sha)) throw failure('UPDATE_INVALID_METADATA');
          const commit = commits[0].sha.toLowerCase();
          const version = metadata(await publicJson(`${RAW}${commit}/package.json`, 128 * 1024, signal));
          open(); signal?.throwIfAborted();
          const current = await availability();
          if (!current.supported || identity(current.manager) !== identity(available.manager) || current.installedVersion !== available.installedVersion || current.row.enabled !== available.row.enabled || profile() !== startingProfile) throw failure('UPDATE_CHECK_REQUIRED');
          if (!newerVersion(version, currentVersion) || !newerVersion(version, current.installedVersion)) { state = 'up-to-date'; return { update: snapshot(current) }; }
          const checkedAt = now();
          candidate = { value: { id: randomUUID(), version, commit, checkedAt: new Date(checkedAt).toISOString() }, expiresAt: checkedAt + candidateTtlMs,
            managerIdentity: identity(current.manager), profileDir: startingProfile, installedVersion: current.installedVersion, enabled: current.row.enabled };
          state = 'available'; return { update: snapshot(current) };
        } catch (error) {
          candidate = undefined; state = 'failed';
          errorCode = ['UPDATE_INVALID_METADATA', 'UPDATE_CHECK_REQUIRED'].includes(error?.code) ? error.code : 'UPDATE_CHECK_FAILED';
          return { update: snapshot(available) };
        }
      })();
      checking = task;
      try { return await task; } finally { if (checking === task) checking = undefined; }
    },
    async installupdate(input, signal) {
      requireValue(exact(input, ['candidateId', 'requestId', 'confirm']) && validId(input.candidateId) && validId(input.requestId) && input.confirm === true);
      open();
      const prior = jobs.get(input.requestId);
      if (prior) { if (prior.candidate.value.id !== input.candidateId) throw failure('BAD_REQUEST'); return status(prior); }
      if (checking || admitting || latest && !latest.settled) throw failure('BUSY');
      if (restartRequired) throw failure('UPDATE_RESTART_REQUIRED');
      if (jobs.size >= maxRequests) throw failure('RATE_LIMITED');
      if (!candidate || candidate.value.id !== input.candidateId || now() >= candidate.expiresAt) throw failure('UPDATE_CHECK_REQUIRED');
      admitting = true;
      try {
        const admission = controller.runUpdate(async control => {
          open(); signal?.throwIfAborted();
          const available = await availability(), selected = candidate;
          if (!available.supported) throw failure(available.errorCode);
          if (!selected || now() >= selected.expiresAt || selected.value.id !== input.candidateId || identity(available.manager) !== selected.managerIdentity
            || profile() !== selected.profileDir || available.installedVersion !== selected.installedVersion || available.row.enabled !== selected.enabled) throw failure('UPDATE_CHECK_REQUIRED');
          if (!newerVersion(selected.value.version, currentVersion) || !newerVersion(selected.value.version, available.installedVersion)) throw failure('UPDATE_NOT_NEWER');
          open(); signal?.throwIfAborted();
          const job = { id: input.requestId, candidate: selected, manager: available.manager, managerIdentity: selected.managerIdentity,
            value: { requestId: input.requestId, state: 'installing' }, settled: false };
          // No await between claiming the controller barrier and invoking native install.
          control.begin(); restartRequired = true; jobs.set(job.id, job); latest = job;
          let native;
          try { native = job.manager.installBundle(`${REPOSITORY}#${selected.value.commit}`, { enabled: available.row.enabled, requestId: job.id }); }
          catch (error) { native = Promise.reject(error); }
          job.task = Promise.resolve(native).then(result => finish(job, result)).catch(() => {
            job.value = { requestId: job.id, state: 'uncertain', errorCode: 'UPDATE_UNCERTAIN' };
          }).finally(() => { job.settled = true; control.settled(); });
          return { update: snapshot(available, job) };
        });
        admissionTask = admission;
        return await admission;
      } finally { admitting = false; admissionTask = undefined; }
    },
    async cancelupdate(input) {
      requireValue(exact(input, ['requestId']) && validId(input.requestId)); open();
      const job = jobs.get(input.requestId);
      if (!job || job !== latest) throw failure('BAD_REQUEST');
      if (!job.settled) cancel(job);
      return status(job);
    },
    dispose() { disposed = true; lifetime.abort(); if (latest && !latest.settled) cancel(latest); },
    async drain({ native = true } = {}) {
      await Promise.allSettled([checking, admissionTask].filter(Boolean));
      // HMR may dispose this plugin while holding the same queue native applying
      // needs. Teardown must not join native work; the manager owns its cleanup.
      if (native) await Promise.allSettled([latest?.task, latest?.cancelTask].filter(Boolean));
    },
  };
  // Profile identity is never accepted from the browser; changing it invalidates candidates.
  const startingProfile = profile();
  return service;
}

export function withUpdateStatus(settings, updates) {
  return { ...settings,
    async status() { const update = await updates.updatestatus(); return { ...await settings.status(), ...update }; },
    updatestatus: input => updates.updatestatus(input),
    checkupdate: (input, signal) => updates.checkupdate(input, signal),
    installupdate: (input, signal) => updates.installupdate(input, signal),
    cancelupdate: input => updates.cancelupdate(input),
  };
}
