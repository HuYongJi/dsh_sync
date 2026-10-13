import path from 'node:path';
import { assert } from '../src/protocol.mjs';
import { createController } from './controller.mjs';
import { createSettingsService, credentialKeyForProfile } from './settings-service.mjs';
import { createSettingsHttp, registerSettingsRoutes } from './settings-http.mjs';
import { createUpdateService, withUpdateStatus } from './update-service.mjs';
import { withBidirectionalSync } from './bidirectional-service.mjs';
export { createController, normalizeConfig, CREDENTIAL_KEY } from './controller.mjs';
export { credentialKeyForProfile } from './settings-service.mjs';

export const name = 'dsh-personal-sync';
export const inject = ['authorization', 'credentials', 'commands', 'sessions', 'sessionPersistence', 'agents', 'attachments', 'workspaceRegistry', 'connection', 'profileContext'];

/** Installation mounts a native Settings section (Client) and exact authenticated Host routes. */
export function apply(ctx, config = {}) {
  const profileDir = ctx.profileContext?.dir, dshHome = ctx.profileContext?.home;
  assert(typeof profileDir === 'string' && path.isAbsolute(profileDir), '个人同步需要可识别的 DSH profileContext');
  assert(typeof dshHome === 'string' && path.isAbsolute(dshHome), '个人同步需要可识别的 DSH 数据目录');
  const controller = createController(ctx, { ...config, stateDir: config.stateDir || path.join(profileDir, 'dsh-personal-sync') }, { credentialKey: credentialKeyForProfile(profileDir), allowLegacyCli: false });
  const updates = createUpdateService(ctx, controller);
  const settings = withUpdateStatus(withBidirectionalSync(ctx, controller, createSettingsService(ctx, controller, { profileDir, dshHome }), { profileDir, dshHome }), updates);
  const bridge = createSettingsHttp(settings);
  registerSettingsRoutes(ctx, bridge);
  ctx.authorization.registerFlow({ key: controller.credentialKey, label: '个人云同步', methods: [{ id: 'password', label: '登录个人同步服务器' }], run: session => controller.authorize(session) });
  const register = (name, description, action) => ctx.commands.register({ name, description, recordInput: false, handler: async ({ rawInput }) => {
    try { return { kind: 'success', text: JSON.stringify(await action(rawInput.trim()), null, 2) }; }
    catch (error) { return { kind: 'error', text: error.message }; }
  } });
  register('sync-status', '查看双向同步状态，也可使用设置 → 个人云同步', () => settings.syncstatus());
  register('sync-logout', '撤销个人同步登录并停止自动同步', () => settings.logout());
  let checking = false;
  // Only explicit v2 bindings authorize automatic sync. Retained legacy
  // preferences and queues are not upload consent, even if autoSync was enabled.
  const timer = setInterval(async () => {
    if (checking) return; checking = true;
    try {
      await settings.initialize();
      await controller.renewAuthorization();
      await settings.tickBidirectional();
    } catch { ctx.logger?.warn?.('个人同步未完成；请在设置 → 个人云同步中检查状态。'); }
    finally { checking = false; }
  }, 5000);
  timer.unref?.();
  ctx.on('dispose', async () => {
    clearInterval(timer); bridge.dispose(); updates.dispose(); settings.stopBidirectional(); controller.stop();
    // Native applying may need the HMR queue currently disposing us. Request
    // cancellation, but leave native task cleanup to its owning manager.
    await Promise.all([updates.drain({ native: false }), controller.drain(), settings.drainBidirectional()]);
  });
}
