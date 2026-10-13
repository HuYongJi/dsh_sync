import { settingsFailure } from './settings-service.mjs';
import { BIDIRECTIONAL_ACTIONS } from './bidirectional-service.mjs';

export const SETTINGS_API = '/api/dsh-personal-sync/';
export const MAX_SETTINGS_BODY = 64 * 1024;
// One native public surface. Legacy service helpers are internal compatibility,
// not routes, even when a caller supplies an otherwise valid old RPC payload.
const SETTINGS_ACTIONS = Object.freeze(['status', 'login', 'password', 'logout', 'updatestatus', 'checkupdate', 'installupdate', 'cancelupdate', ...BIDIRECTIONAL_ACTIONS]);
const messages = Object.freeze({
  BAD_REQUEST: '参数无效',
  AUTH_RENEWAL_UNCERTAIN: '登录续期结果未确认，请重新登录',
  SYNC_ARCHIVES_UNSUPPORTED: '此宿主暂不能归档会话，文件同步不受影响',
  SYNC_ARCHIVES_SKIPPED: '部分会话已延后或仅可归档，文件同步不受影响',
  SYNC_IMPORT_UNCERTAIN: '会话导入结果需核对，请保存新会话 ID，不要重复导入',
  SYNC_IMPORT_SKIPPED: '会话不支持安全导入，已保留归档',
  SYNC_IMPORT_UNATTACHED: '会话已写入但未关联项目，请核对新会话 ID',
  SYNC_REPAIR_INCOMPLETE: '中断事务的核对尚未完成，请重新预览',
  SYNC_REPAIR_UNAVAILABLE: '没有需要核对的中断事务',
  SYNC_REPAIR_CHANGED: '文件或事务已变更，请重新预览',
  SYNC_REPAIR_EXPIRED: '核对预览已过期，请重新预览',
  SYNC_COMMIT_UNCERTAIN: '云端提交仍未确认，请先核对同步状态',
  SYNC_REQUEST_CONFLICT: '请求记录不一致，请重新预览',
  SYNC_PLAN_EXPIRED: '确认已过期，请重新预览',
  SYNC_PLAN_CHANGED: '项目或设置已变更，请重新预览',
  SYNC_MANAGED_PROJECT: '此项目已使用双向同步，请在双向同步中管理',
  SYNC_CLIENT_UPGRADE_REQUIRED: '请升级同步服务器和各端插件后开启双向同步',
  SYNC_MIGRATION_REQUIRED: '请先完成项目的双向同步连接',
  SYNC_LEGACY_HEAD_MISMATCH: '旧项目出现新内容，请重新预览迁移',
  SYNC_HEAD_MISMATCH: '云端内容已变更，请重新预览',
  SYNC_ROOT_CHANGED: '项目目录已变更，已停止写入',
  SYNC_POLICY_CHANGED: '排除规则已变更，请重新核对',
  SYNC_LOCAL_CHANGED: '本机内容已变更，已保留双方内容',
  SYNC_QUOTA: '同步存储达到安全上限，请检查回收副本和队列',
  SYNC_INTEGRITY: '内容校验失败，未覆盖本机文件',
  SYNC_PROJECT_CORRUPT: '云端项目校验失败，请检查服务器存储',
  SYNC_CATALOG_CHANGED: '云端项目列表在加载期间变化，请重新打开选择器',
  SYNC_METADATA_UNSAFE: '同步元数据路径不安全，已停止写入',
  SYNC_VOLUME_CHANGED: '项目包含不同磁盘的挂载点，已停止写入',
  SYNC_NOT_IDLE: '项目任务正在运行，等待空闲后应用更新',
  SYNC_BINDING_MISMATCH: '同步绑定已变更，请重新核对授权',
  SYNC_JOURNAL_CORRUPT: '同步事务记录损坏，已停止自动操作',
  SYNC_STRUCTURAL_CONFLICT: '文件与目录或大小写冲突，请先调整冲突路径',
  SYNC_UNTRACKED_DELETE: '无法证明删除来源，已保留本机文件',
  SYNC_REMOTE_BLOB_MISSING: '云端缺少已记录的内容，请检查存储',
  SYNC_APPLY_INCOMPLETE: '本机应用尚未完成，请核对任务结果',
  SYNC_CONFLICT_CHANGED: '冲突已变化，请重新选择',
  SYNC_CANCELLED: '操作已停止，已完成内容与回收副本保留',
  SYNC_REPLAN_REQUIRED: '中断的事务需要核对，未自动重复写入',
  SYNC_DESTINATION_UNAVAILABLE: '无法规划安全的新副本路径',
  SERVER_UNAVAILABLE: '服务器暂时不可用，稍后自动重试',
  DOWNLOAD_CANCELLED: '已停止剩余下载',
  DOWNLOAD_LIMIT: '最多选择20个项目',
  DOWNLOAD_FINALIZATION_FAILED: '文件已下载，状态清理未完成',
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
  CLOUD_BROWSE_UNSUPPORTED: '请更新同步服务器',
  CLOUD_PROJECT_EMPTY: '云端项目尚无已提交内容',
  PROJECTS_PARTIAL: '部分云端项目未能加载，请重试',
  DIRECTORY_PICKER_UNAVAILABLE: '当前宿主没有可用的文件夹选择器',
  DIRECTORY_PICKER_FAILED: '文件夹选择失败，请重试',
  DIRECTORY_PICKER_EXPIRED: '文件夹选择已失效，请重新选择',
  DESTINATION_CHANGED: '目标父目录已变更，请重新选择',
  BAD_DESTINATION: '恢复目录无效，父目录必须已存在且无链接',
  DESTINATION_EXISTS: '恢复目录已存在',
  PROTECTED_DESTINATION: '不能恢复到 DSH 或已有项目目录中',
  CHECKPOINT_MISMATCH: '检查点不属于所选项目',
  RESTORE_FAILED: '下载恢复未完成，请检查不完整目录',
  IMPORT_FAILED: '会话导入未全部完成，请检查结果',
  RECOVERY_UNAVAILABLE: '没有可导入的本次下载恢复',
  RECOVERY_LIMIT: '恢复请求记录已达安全上限',
  RECOVERY_STATE_CORRUPT: '恢复记录无法安全读取，已停止恢复操作',
  PROJECT_REGISTRATION_UNCERTAIN: '项目登记结果未确认，请先核对 DSH 项目列表',
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
  const actions = new Set(SETTINGS_ACTIONS);
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
        } else if (action === 'logout') value = await service.logout(payload);
        else value = await service[action](payload, request.signal);
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
  for (const action of SETTINGS_ACTIONS) {
    ctx.connection.fetch.register({ path: SETTINGS_API + action, methods: ['POST'], requestBody: 'streaming', fetch: request => bridge.fetch(action, request) });
  }
}
