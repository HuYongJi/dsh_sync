import { createController, deriveView } from './state.mjs';
import { createBidirectionalPanel } from './bidirectional-panel.mjs';

// DSH 0.2.0-rc.2 uses React slots; both React and controls come from its module loader.
export function createClientPlugin(require) {
  const React = require('react');
  const { Button, Input, Checkbox, Switch, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const BidirectionalPanel = createBidirectionalPanel(React, { Button, Input, Checkbox, Switch, Modal });
  const styles = {
    page: { maxWidth: 820, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
    card: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRadius: 'var(--dsw-radius-xl, 12px)', border: '1px solid var(--dsw-alias-settings-card-stroke)', background: 'var(--dsw-alias-settings-card-fill)', boxSizing: 'border-box' },
    row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    between: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
    body: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '21px', overflowWrap: 'anywhere' },
    heading: { margin: 0, fontSize: 15, fontWeight: 600 },
    label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 },
    form: { display: 'flex', flexDirection: 'column', gap: 12 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12 },
    badge: { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-alias-settings-card-stroke)', borderRadius: 999, padding: '3px 9px', fontSize: 12 },
    root: { margin: '4px 0 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '19px', overflowWrap: 'anywhere', userSelect: 'text' },
    summary: { minWidth: 0, flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 },
    warning: { color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' },
    error: { color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary))' },
  };
  const sameIdentity = (status, binding) => Boolean(status && binding && status.server === binding.server && status.username === binding.username && status.revision === binding.revision);
  const bindingOf = status => Object.freeze({ server: status.server, username: status.username, revision: status.revision });

  function SettingsPage({ controller, connection }) {
    // Account/local status/native updates are separate from project operations.
    // All project operations belong to the single bidirectional panel below.
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const status = state.status;
    const view = deriveView(state);
    const id = React.useId();
    const [server, setServer] = React.useState(status?.server ?? '');
    const [username, setUsername] = React.useState(status?.username ?? '');
    const [remember, setRemember] = React.useState(false);
    const [logoutIdentity, setLogoutIdentity] = React.useState(null);
    const [passwordIdentity, setPasswordIdentity] = React.useState(null);
    // Secrets live in uncontrolled native inputs, never React/controller state or storage.
    const password = React.useRef(null);
    const currentPassword = React.useRef(null);
    const newPassword = React.useRef(null);
    const confirmPassword = React.useRef(null);
    const passwordBinding = React.useRef(null);
    const logoutBinding = React.useRef(null);
    const clearSecrets = () => {
      for (const ref of [password, currentPassword, newPassword, confirmPassword]) if (ref.current) ref.current.value = '';
    };
    const closePassword = () => {
      clearSecrets();
      passwordBinding.current = null;
      setPasswordIdentity(null);
      controller.cancelPasswordChange();
    };
    const closeLogout = () => {
      clearSecrets();
      logoutBinding.current = null;
      setLogoutIdentity(null);
    };
    React.useEffect(() => {
      let previous = controller.getSnapshot();
      // Invalidate immediately on Host changes, before React can render a stale submit handler.
      const unsubscribe = controller.subscribe(() => {
        const next = controller.getSnapshot();
        const identityChanged = !sameIdentity(next.status, previous.status) || next.status?.loggedIn !== previous.status?.loggedIn;
        const runtimeChanged = next.update?.currentVersion !== previous.update?.currentVersion;
        const updateGateChanged = deriveView(next).updateBlocked !== deriveView(previous).updateBlocked;
        if (identityChanged || runtimeChanged || updateGateChanged || next.busy !== previous.busy) clearSecrets();
        // Store first: cancelling an in-flight password request can notify this subscription again.
        previous = next;
        if (passwordBinding.current && (identityChanged || runtimeChanged || updateGateChanged)) closePassword();
        if (logoutBinding.current && (identityChanged || runtimeChanged || updateGateChanged)) closeLogout();
      });
      const stop = controller.watch();
      return () => {
        clearSecrets();
        passwordBinding.current = null;
        logoutBinding.current = null;
        unsubscribe();
        controller.cancelPasswordChange();
        stop();
      };
    }, [controller]);
    React.useEffect(() => {
      clearSecrets();
      setServer(status?.server ?? '');
      setUsername(status?.username ?? '');
      setRemember(false);
    }, [status?.server, status?.username, status?.loggedIn]);
    const login = event => {
      event.preventDefault();
      const secret = password.current?.value ?? '';
      clearSecrets();
      void controller.login({ server, username, password: secret, ...(remember ? { remember: true } : {}) }).finally(clearSecrets);
    };
    const openPassword = () => {
      const latest = controller.getSnapshot();
      if (!deriveView(latest).canChangePassword) return;
      clearSecrets();
      const binding = bindingOf(latest.status);
      passwordBinding.current = binding;
      setPasswordIdentity(binding);
    };
    const changePassword = event => {
      event.preventDefault();
      const binding = passwordIdentity;
      const input = { currentPassword: currentPassword.current?.value ?? '', newPassword: newPassword.current?.value ?? '', confirmPassword: confirmPassword.current?.value ?? '' };
      clearSecrets();
      if (!binding || passwordBinding.current !== binding || !sameIdentity(controller.getSnapshot().status, binding)) return;
      void controller.changePassword(binding, input).then(changed => {
        if (changed && passwordBinding.current === binding) closePassword();
      }).finally(clearSecrets);
    };
    const openLogout = () => {
      const latest = controller.getSnapshot();
      if (!deriveView(latest).canLogout) return;
      closePassword();
      const binding = bindingOf(latest.status);
      logoutBinding.current = binding;
      setLogoutIdentity(binding);
    };
    const logout = () => {
      clearSecrets();
      if (!logoutIdentity || logoutBinding.current !== logoutIdentity || !sameIdentity(controller.getSnapshot().status, logoutIdentity)) return;
      closeLogout();
      void controller.logout();
    };
    const blurSecrets = event => { if (!event.currentTarget.contains(event.relatedTarget)) clearSecrets(); };
    const updater = state.update;
    const updateIntent = state.updateIntent;
    const installing = ['installing', 'cancelling'].includes(updater?.state) || ['installupdate', 'cancelupdate'].includes(state.busy);
    const updateLabel = state.updateUncertain ? '结果未确认' : state.busy === 'checkupdate' ? '检查中…' : ({ idle: '尚未检查', checking: '检查中…', available: '有新版本', 'up-to-date': '已是最新版本', installing: '更新中…', cancelling: '更新中…', 'restart-required': '待重启', cancelled: '已取消', failed: '更新未完成', uncertain: '结果未确认' }[updater?.state] ?? '尚未检查');
    const manualUpdate = updater?.state === 'available' && Boolean(updater.candidate) && !state.updateError;
    const updateAction = installing ? '更新中…' : view.restartRequired ? '待重启' : manualUpdate ? '手动更新' : '检查更新';
    const loginState = state.loading ? '读取中' : !state.ready ? '状态未确认' : status?.loggedIn ? '已登录' : '未登录';
    const passwordOpen = sameIdentity(status, passwordIdentity) && passwordBinding.current === passwordIdentity;
    const logoutOpen = status?.loggedIn === true && sameIdentity(status, logoutIdentity) && logoutBinding.current === logoutIdentity;
    const body = (content, extra = {}) => h('p', { style: styles.body, ...extra }, content);
    return h('section', { style: styles.page, 'aria-label': '个人云同步', 'aria-busy': state.loading || state.refreshing || Boolean(state.busy), 'data-personal-sync': 'settings' },
      h('div', { style: styles.between },
        h('h2', { style: { ...styles.heading, fontSize: 18 } }, '个人云同步'),
        h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing,
          onClick: () => { clearSecrets(); void controller.refresh(); } }, state.refreshing ? '刷新中…' : '刷新')),
      state.error && !passwordOpen && h('div', { role: 'alert', style: { ...styles.card, ...styles.error }, 'data-personal-sync': 'error' }, state.error.message),
      state.notice && body(state.notice, { role: 'status', 'aria-live': 'polite' }),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-account-title`, 'data-personal-sync': 'account-summary' },
        h('div', { style: styles.between },
          h('h3', { id: `${id}-account-title`, style: styles.heading }, '账号'),
          h('span', { style: styles.badge, role: 'status', 'aria-live': 'polite', 'data-personal-sync': 'login-status' }, loginState)),
        status?.loggedIn
          ? h('div', { style: styles.form }, body(status.username, { 'aria-label': '已登录用户名', 'data-personal-sync': 'account-username', style: { ...styles.body, fontSize: 15, color: 'var(--dsw-alias-label-primary)' } }), body(status.server, { style: styles.root, 'aria-label': '已连接服务器' }))
          : h('form', { onSubmit: login, noValidate: true, autoComplete: 'off', style: styles.form, onBlur: blurSecrets },
            h('label', { style: styles.label, htmlFor: `${id}-server` }, '服务器',
              h(Input, { id: `${id}-server`, type: 'url', value: server, disabled: !view.canLogin,
                onChange: event => { closePassword(); setServer(event.target.value); },
                placeholder: 'https://sync.example.com', autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, maxLength: 2048 })),
            h('div', { style: styles.grid },
              h('label', { style: styles.label, htmlFor: `${id}-username` }, '账号',
                h(Input, { id: `${id}-username`, type: 'text', value: username, disabled: !view.canLogin,
                  onChange: event => { closePassword(); setUsername(event.target.value); },
                  autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, maxLength: 128 })),
              h('label', { style: styles.label, htmlFor: `${id}-password` }, '密码',
                h(Input, { id: `${id}-password`, type: 'password', ref: password, disabled: !view.canLogin, autoComplete: 'off',
                  autoCapitalize: 'none', spellCheck: false, maxLength: 1024 }))),
            h(Checkbox, { checked: remember, label: '在此设备保持登录（最长90天）', disabled: !view.canLogin, onChange: value => setRemember(value), 'data-personal-sync': 'remember-device' }),
            h('div', { style: styles.row },
              h(Button, { type: 'submit', variant: 'primary', disabled: !view.canLogin, 'aria-busy': state.busy === 'login' }, state.busy === 'login' ? '登录中…' : '登录'))),
        h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'outline', disabled: !view.canChangePassword, onClick: openPassword }, '修改密码'),
          h(Button, { type: 'button', variant: 'ghost', disabled: !view.canLogout, onClick: openLogout }, state.busy === 'logout' ? '退出中…' : '退出登录')),
        status?.warning && body(status.warning, { role: 'status', style: { ...styles.body, ...styles.warning } })),
      h(BidirectionalPanel, { connection, identity: { server: status?.server ?? '', username: status?.username ?? '', loggedIn: status?.loggedIn === true }, onAuthenticationRequired: () => { clearSecrets(); return controller.refresh().then(() => { if (!controller.getSnapshot().status?.loggedIn) password.current?.focus?.(); }); } }),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-update-title`, 'data-personal-sync': 'update-summary' },
        h('div', { style: styles.between },
          h('div', { style: styles.summary },
            h('h3', { id: `${id}-update-title`, style: styles.heading }, '插件更新'),
            h('span', { style: styles.body, role: 'status', 'aria-live': 'polite' }, `当前版本 ${updater?.currentVersion ?? '未确认'} · ${updater?.supported === false ? '此宿主不可用' : updateLabel}`)),
          h(Button, { type: 'button', variant: 'primary', disabled: installing || view.restartRequired || (manualUpdate ? !view.canUpdate : !view.canCheckUpdate),
            onClick: () => { clearSecrets(); if (manualUpdate) controller.prepareUpdate(); else void controller.checkUpdate(); } }, updateAction)),
        view.restartRequired && !installing && body('请重启 DSH', { role: 'status' }),
        view.updateError && body(view.updateError, { role: 'alert', style: { ...styles.body, ...styles.warning } })),
      h(Modal, { open: Boolean(updateIntent), onClose: () => { clearSecrets(); controller.cancelUpdateIntent(); }, title: '确认更新插件？', closeLabel: '取消' },
        updateIntent && h('div', { style: styles.form },
          body(`${updateIntent.currentVersion} → ${updateIntent.version}`),
          body('更新后需重启 DSH'),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: () => { clearSecrets(); controller.cancelUpdateIntent(); } }, '取消'),
            h(Button, { type: 'button', variant: 'primary', disabled: !view.canUpdate, onClick: () => { clearSecrets(); void controller.confirmUpdate(updateIntent); } }, '确认更新')))),
      h(Modal, { open: logoutOpen, onClose: closeLogout, title: '退出登录？', closeLabel: '取消',
        footer: h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'ghost', onClick: closeLogout }, '取消'),
          h(Button, { type: 'button', variant: 'primary', disabled: !view.canLogout, 'data-modal-autofocus': '', onClick: logout }, '退出登录')) }),
      h(Modal, { open: passwordOpen, onClose: closePassword, title: '修改密码', closeLabel: '取消' },
        passwordOpen && h('form', { id: `${id}-password-form`, onSubmit: changePassword, onBlur: blurSecrets, noValidate: true, autoComplete: 'off', style: styles.form },
          ...[[currentPassword, 'current-password', '当前密码'], [newPassword, 'new-password', '新密码'], [confirmPassword, 'confirm-password', '确认新密码']].map(([ref, name, label]) =>
            h('label', { key: name, style: styles.label, htmlFor: `${id}-${name}` }, label,
              h(Input, { id: `${id}-${name}`, type: 'password', ref, disabled: !view.canChangePassword, autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, maxLength: 1024,
                ...(name === 'current-password' ? { 'data-modal-autofocus': '' } : {}) }))),
          state.error && h('div', { role: 'alert', style: styles.error }, state.error.message),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: closePassword }, '取消'),
            h(Button, { type: 'submit', variant: 'primary', disabled: !view.canChangePassword, 'aria-busy': state.busy === 'password' }, state.busy === 'password' ? '提交中…' : '修改密码')))));
  }

  return {
    name: 'dsh-personal-sync-settings',
    inject: ['slots', 'connection'],
    apply(ctx) {
      const controller = createController(ctx.connection);
      ctx.effect(() => () => controller.dispose(), 'dsh-personal-sync: settings controller');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-personal-sync', order: 45,
        label: () => '个人云同步', inject: () => ({ controller, connection: ctx.connection }),
      }, SettingsPage));
      ctx.on('connection/reset', () => { void controller.refreshIfWatching(); });
    },
  };
}
