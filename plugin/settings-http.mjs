import { settingsFailure } from './settings-service.mjs';

export const SETTINGS_API = '/api/dsh-personal-sync/';
export const MAX_SETTINGS_BODY = 64 * 1024;
const messages = Object.freeze({
  BAD_REQUEST: '参数无效',
  UPDATE_UNAVAILABLE: '当前宿主没有可用的原生插件管理器',
  UPDATE_UNMANAGED: '此插件不是可更新的当前配置依赖，请使用原生插件管理',
  UPDATE_CHECK_FAILED: '检查插件更新失败，请稍后重试',
  UPDATE_INVALID_METADATA: '更新元数据无效或不兼容',
  UPDATE_CHECK_REQUIRED: '更新检查已失效，请重新检查',
  UPDATE_NOT_NEWER: '候选版本不是更新版本',
  UPDATE_BUILD_APPROVAL_REQUIRED: '需要在原生插件管理中确认构建脚本',
  UPDATE_INCOMPATIBLE: '更新与当前 DSH 版本不兼容',
  UPDATE_FAILED: '插件更新失败，请检查原生插件管理',
  UPDATE_UNCERTAIN: '更新结果未确认，请检查原生插件管理并重启 DSH',
  UPDATE_CANCEL_TOO_LATE: '原生管理器已开始应用更新，无法取消',
  UPDATE_RESTART_REQUIRED: '插件文件可能已变更，请先重启 DSH',
  CLOUD_BROWSE_UNSUPPORTED: '请升级同步服务器，或填写云端项目 ID',
  BAD_DESTINATION: '恢复目录无效，父目录必须已存在且无链接',
  DESTINATION_EXISTS: '恢复目录已存在',
  PROTECTED_DESTINATION: '不能恢复到 DSH 或已有项目目录中',
  CHECKPOINT_MISMATCH: '检查点不属于所选项目',
  RESTORE_FAILED: '下载恢复未完成，请检查不完整目录',
  IMPORT_FAILED: '会话导入未全部完成，请检查结果',
  RECOVERY_UNAVAILABLE: '没有可导入的本次下载恢复',
  RECOVERY_LIMIT: '本次插件运行的恢复请求已达上限',
  NOT_LOGGED_IN: '请重新登录',
  ACCOUNT_MISMATCH: '账号不一致，请重新登录',
  ACCOUNT_BOUND: '账号已绑定同步记录',
  BUSY: '操作进行中',
  CONFIG_CONFLICT: '设置已变更，请刷新',
  PROJECT_NOT_SELECTED: '项目未选择',
  PROJECT_UNAVAILABLE: '项目不可用',
  PROJECTS_UNAVAILABLE: '项目列表不可用',
  PROTECTED_QUEUE: '受保护队列已暂停',
  SETTINGS_CORRUPT: '设置损坏，自动同步已停止',
  SETTINGS_FAILED: '设置保存失败',
  LOGIN_FAILED: '登录失败',
  SERVER_UNREACHABLE: '服务器连接失败',
  DISPOSED: '插件已关闭',
  REQUEST_TOO_LARGE: '请求过大',
  UNSUPPORTED_MEDIA_TYPE: '请求格式无效',
  TIMEOUT: '操作超时',
  RATE_LIMITED: '尝试过于频繁',
  CURRENT_PASSWORD_INVALID: '当前密码错误',
  PASSWORD_TOO_WEAK: '新密码至少8位，最多1024字节',
  PASSWORD_UNCHANGED: '新旧密码不能相同',
  PASSWORD_CHANGE_REJECTED: '修改未通过验证',
  PASSWORD_CHANGE_UNSUPPORTED: '请先升级同步服务器',
  PASSWORD_CHANGE_UNCERTAIN: '结果未确认，请重新登录',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
function safeError(error, action) {
  let code = Object.hasOwn(messages, error?.code) ? error.code : undefined;
  if (!code && error?.status === 401) code = action === 'password' ? 'CURRENT_PASSWORD_INVALID' : action === 'login' ? 'LOGIN_FAILED' : 'NOT_LOGGED_IN';
  if (!code && error?.status === 429) code = 'RATE_LIMITED';
  if (!code && (error?.name === 'AbortError' || error?.name === 'TimeoutError')) code = 'TIMEOUT';
  if (!code && error?.name === 'ValidationError') code = 'BAD_REQUEST';
  if (!code && (error?.cause?.code || error?.message === 'fetch failed')) code = 'SERVER_UNREACHABLE';
  code ||= action === 'login' ? 'LOGIN_FAILED' : 'SETTINGS_FAILED';
  return { code, message: messages[code], details: {} };
}
function response(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
async function readBody(request, timeoutMs) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw settingsFailure('UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw settingsFailure('BAD_REQUEST');
  if (length !== null && Number(length) > MAX_SETTINGS_BODY) throw settingsFailure('REQUEST_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw settingsFailure('BAD_REQUEST');
  let timer, abortListener, size = 0;
  const chunks = [];
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(settingsFailure('TIMEOUT')), timeoutMs);
    abortListener = () => reject(settingsFailure('TIMEOUT'));
    request.signal.addEventListener('abort', abortListener, { once: true });
    if (request.signal.aborted) abortListener();
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SETTINGS_BODY) throw settingsFailure('REQUEST_TOO_LARGE');
      chunks.push(value);
    }
    if (length !== null && size !== Number(length)) throw settingsFailure('BAD_REQUEST');
    const bytes = Buffer.concat(chunks, size);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw settingsFailure('BAD_REQUEST'); }
    if (!object(body)) throw settingsFailure('BAD_REQUEST');
    return body;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abortListener); reader.releaseLock(); }
}

/** Exact routes only: the native Connection owns cookie identity + Host/Origin admission. */
export function createSettingsHttp(service, { bodyTimeoutMs = 10_000, maxActive = 16 } = {}) {
  let disposed = false, active = 0;
  const loginAttempts = [];
  const actions = new Set(['status', 'login', 'password', 'preferences', 'sync', 'logout', 'projects', 'checkpoints', 'restore', 'import', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']);
  return {
    async fetch(action, request) {
      let rpcId, payload;
      if (!actions.has(action)) return response({ error: { code: 'BAD_REQUEST', message: messages.BAD_REQUEST } }, 404);
      if (disposed) return response({ error: { code: 'DISPOSED', message: messages.DISPOSED } }, 503);
      if (active >= maxActive) return response({ error: { code: 'BUSY', message: messages.BUSY } }, 503);
      active++;
      try {
        // new URL(request.url).origin is dsh.internal, not the browser origin. Do not
        // compare against it or bypass the native Connection's outer admission gate.
        if (new URL(request.url).pathname !== SETTINGS_API + action) throw settingsFailure('BAD_REQUEST');
        if (request.method !== 'POST') return response({ error: { code: 'BAD_REQUEST', message: messages.BAD_REQUEST } }, 405);
        const body = await readBody(request, bodyTimeoutMs);
        if (Object.hasOwn(body, 'type')) {
          if (!exact(body, ['type', 'rpcId', 'method', 'payload']) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.rpcId) || body.method !== `dsh-personal-sync/${action}` || !object(body.payload)) throw settingsFailure('BAD_REQUEST');
          rpcId = body.rpcId; payload = body.payload;
        } else payload = body; // CLI-style isolated probes; production Client uses native RPC.
        request.signal.throwIfAborted();
        let value;
        if (action === 'status') {
          if (!exact(payload, [])) throw settingsFailure('BAD_REQUEST');
          value = await service.status();
        } else if (action === 'login' || action === 'password') {
          const now = Date.now();
          while (loginAttempts.length && loginAttempts[0] < now - 60_000) loginAttempts.shift();
          if (loginAttempts.length >= 8) throw settingsFailure('RATE_LIMITED');
          loginAttempts.push(now);
          value = action === 'login' ? await service.login(payload, request.signal) : await service.password(payload, request.signal);
        } else if (action === 'preferences') value = await service.savePreferences(payload, request.signal);
        else if (action === 'sync') value = await service.sync(payload);
        else if (['projects', 'checkpoints', 'restore', 'import', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate'].includes(action)) value = await service[action](payload, request.signal);
        else value = await service.logout(payload);
        return response(rpcId ? { type: 'server-response', rpcId, result: { ok: true, value } } : value);
      } catch (error) {
        const safe = safeError(error, action);
        if (rpcId) return response({ type: 'server-response', rpcId, result: { ok: false, error: safe } });
        const status = safe.code === 'REQUEST_TOO_LARGE' ? 413 : safe.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : safe.code === 'TIMEOUT' ? 408 : ['CONFIG_CONFLICT', 'BUSY', 'ACCOUNT_BOUND'].includes(safe.code) ? 409 : safe.code === 'RATE_LIMITED' ? 429 : 400;
        return response({ error: safe }, status);
      } finally {
        if (payload) for (const field of ['password', 'currentPassword', 'newPassword', 'confirmPassword']) {
          if (Object.hasOwn(payload, field)) payload[field] = '';
        }
        active--;
      }
    },
    dispose() { disposed = true; },
  };
}
export function registerSettingsRoutes(ctx, bridge) {
  for (const action of ['status', 'login', 'password', 'preferences', 'sync', 'logout', 'projects', 'checkpoints', 'restore', 'import', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate']) {
    ctx.connection.fetch.register({ path: SETTINGS_API + action, methods: ['POST'], requestBody: 'streaming', fetch: request => bridge.fetch(action, request) });
  }
}
