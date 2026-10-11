import { createController, deriveView, filterProjects } from './state.mjs';

// DSH 0.2.0-rc.2 uses React slots; both React and controls come from its module loader.
export function createClientPlugin(require) {
  const React = require('react');
  const { Button, Input, Checkbox, Switch, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
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
    project: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-settings-card-stroke)' },
    list: { maxHeight: 350, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 6 },
    summary: { minWidth: 0, flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 },
    summaryList: { margin: 0, paddingLeft: 20, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '21px', overflowWrap: 'anywhere' },
    warning: { color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' },
    error: { color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary))' },
  };
  const when = value => {
    if (!value) return '尚无记录';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '未知时间';
  };
  const sameIdentity = (status, binding) => Boolean(status && binding && status.server === binding.server && status.username === binding.username && status.revision === binding.revision);

  function SettingsPage({ controller }) {
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const status = state.status;
    const view = deriveView(state);
    const id = React.useId();
    const [server, setServer] = React.useState(status?.server ?? '');
    const [username, setUsername] = React.useState(status?.username ?? '');
    const [search, setSearch] = React.useState('');
    const [projectManagerOpen, setProjectManagerOpen] = React.useState(false);
    const [confirmLogout, setConfirmLogout] = React.useState(false);
    const [passwordIdentity, setPasswordIdentity] = React.useState(null);
    // Secrets live in uncontrolled native inputs, never React/controller state or storage.
    const password = React.useRef(null);
    const currentPassword = React.useRef(null);
    const newPassword = React.useRef(null);
    const confirmPassword = React.useRef(null);
    const passwordBinding = React.useRef(null);
    const clearSecrets = () => {
      for (const ref of [password, currentPassword, newPassword, confirmPassword]) if (ref.current) ref.current.value = '';
    };
    const closePassword = () => {
      clearSecrets();
      passwordBinding.current = null;
      setPasswordIdentity(null);
      controller.cancelPasswordChange();
    };
    React.useEffect(() => {
      let previous = controller.getSnapshot();
      // Invalidate immediately on Host changes, before React can render a stale submit handler.
      const unsubscribe = controller.subscribe(() => {
        const next = controller.getSnapshot();
        if (!sameIdentity(next.status, previous.status) || next.status?.loggedIn !== previous.status?.loggedIn || next.busy !== previous.busy) clearSecrets();
        previous = next;
        if (passwordBinding.current && !sameIdentity(next.status, passwordBinding.current)) closePassword();
      });
      const stop = controller.watch();
      return () => {
        clearSecrets();
        passwordBinding.current = null;
        unsubscribe();
        controller.cancelPasswordChange();
        stop();
      };
    }, [controller]);
    React.useEffect(() => {
      clearSecrets();
      setServer(status?.server ?? '');
      setUsername(status?.username ?? '');
    }, [status?.server, status?.username, status?.loggedIn]);
    const login = event => {
      event.preventDefault();
      const secret = password.current?.value ?? '';
      clearSecrets();
      void controller.login({ server, username, password: secret }).finally(clearSecrets);
    };
    const openPassword = () => {
      const latest = controller.getSnapshot();
      if (!deriveView(latest).canChangePassword) return;
      clearSecrets();
      const binding = Object.freeze({ server: latest.status.server, username: latest.status.username, revision: latest.status.revision });
      passwordBinding.current = binding;
      setPasswordIdentity(binding);
    };
    const changePassword = event => {
      event.preventDefault();
      const binding = passwordBinding.current;
      const input = { currentPassword: currentPassword.current?.value ?? '', newPassword: newPassword.current?.value ?? '', confirmPassword: confirmPassword.current?.value ?? '' };
      clearSecrets();
      if (!sameIdentity(controller.getSnapshot().status, binding)) { closePassword(); return; }
      void controller.changePassword(binding, input).then(changed => {
        if (changed && passwordBinding.current === binding) closePassword();
      }).finally(clearSecrets);
    };
    const blurSecrets = event => { if (!event.currentTarget.contains(event.relatedTarget)) clearSecrets(); };
    const openProjects = () => {
      if (!controller.getSnapshot().status) return;
      clearSecrets();
      setSearch('');
      setProjectManagerOpen(true);
    };
    // Closing only hides the editor; the existing draft/save contract stays explicit.
    const closeProjects = () => {
      if (controller.getSnapshot().busy === 'preferences') return;
      clearSecrets();
      setProjectManagerOpen(false);
      setSearch('');
    };
    const saveProjects = () => {
      clearSecrets();
      void controller.savePreferences().then(saved => { if (saved) closeProjects(); });
    };
    const projects = filterProjects(status?.projects ?? [], search);
    const checkedIds = new Set(state.draft.projectIds);
    const selectedProjects = (status?.projects ?? []).filter(project => checkedIds.has(project.id));
    const loginState = state.loading ? '读取中' : !state.ready ? '状态未确认' : status?.loggedIn ? '已登录' : '未登录';
    const passwordOpen = sameIdentity(status, passwordIdentity) && passwordBinding.current === passwordIdentity;
    const body = (content, extra = {}) => h('p', { style: styles.body, ...extra }, content);
    return h('section', { style: styles.page, 'aria-label': '个人云同步', 'aria-busy': state.loading || state.refreshing || Boolean(state.busy), 'data-personal-sync': 'settings' },
      h('div', { style: styles.between },
        h('h2', { style: { ...styles.heading, fontSize: 18 } }, '个人云同步'),
        h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing,
          onClick: () => { clearSecrets(); void controller.refresh(); } }, state.refreshing ? '刷新中…' : state.conflict ? '刷新并重新选择' : '刷新')),
      state.error && !passwordOpen && !projectManagerOpen && h('div', { role: 'alert', style: { ...styles.card, ...styles.error }, 'data-personal-sync': 'error' }, state.error.message),
      state.notice && body(state.notice, { role: 'status', 'aria-live': 'polite' }),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-account-title` },
        h('div', { style: styles.between },
          h('h3', { id: `${id}-account-title`, style: styles.heading }, '账号'),
          h('span', { style: styles.badge, role: 'status', 'aria-live': 'polite', 'data-personal-sync': 'login-status' }, loginState)),
        status?.loggedIn
          ? body(status.username, { 'aria-label': '已登录用户名', 'data-personal-sync': 'account-username', style: { ...styles.body, fontSize: 15, color: 'var(--dsw-alias-label-primary)' } })
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
            h('div', { style: styles.row },
              h(Button, { type: 'submit', variant: 'primary', disabled: !view.canLogin, 'aria-busy': state.busy === 'login' }, state.busy === 'login' ? '登录中…' : '登录'))),
        h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'outline', disabled: !view.canChangePassword, onClick: openPassword }, '修改密码'),
          h(Button, { type: 'button', variant: 'ghost', disabled: !view.canLogout,
            onClick: () => { closePassword(); setConfirmLogout(true); } }, state.busy === 'logout' ? '退出中…' : '退出登录')),
        status?.warning && body(status.warning, { role: 'status', style: { ...styles.body, ...styles.warning } })),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-projects-title`, 'data-personal-sync': 'projects-summary' },
        h('div', { style: { ...styles.between, alignItems: 'flex-start' } },
          h('div', { style: styles.summary },
            h('h3', { id: `${id}-projects-title`, style: styles.heading }, '同步项目'),
            body(status ? `仅同步所选项目，已选择 ${view.selectedCount} 项` : '读取中'),
            selectedProjects.length > 0
              ? h('ul', { style: styles.summaryList, 'aria-label': '已选同步项目' }, ...selectedProjects.slice(0, 3).map(project =>
                h('li', { key: project.id }, project.label + (project.available ? '' : ' · 不可用'))))
              : status && body(status.projects.length ? '暂未选择项目' : '暂无项目'),
            selectedProjects.length > 3 && body(`另有 ${selectedProjects.length - 3} 个项目`),
            state.dirty && h('span', { style: styles.body, role: 'status' }, '未保存')),
          h(Button, { type: 'button', variant: 'outline', disabled: !status, onClick: openProjects }, '管理'))),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-status-title` },
        h('div', { style: styles.between },
          h('h3', { id: `${id}-status-title`, style: styles.heading }, '同步状态'),
          h('span', { style: styles.badge, role: 'status', 'aria-live': 'polite' }, !state.ready ? '状态未确认' : status?.running ? '同步中' : state.scheduled ? '已提交' : status?.pending ? '待重试' : '空闲')),
        body(`待上传 ${status?.pending ?? '—'} · 可用项目 ${view.selectedAvailable}`),
        status?.lastResult && h('div', { role: 'status', 'aria-live': 'polite' },
          body(`${status.lastResult.ok ? '成功' : '未完成'} · ${when(status.lastResult.at)}`),
          body(status.lastResult.message, { style: { ...styles.body, ...(status.lastResult.ok ? {} : styles.warning) } })),
        h('div', { style: styles.between },
          h('strong', { style: { fontSize: 14 } }, '自动同步'),
          h(Switch, { checked: state.draft.autoSync, label: '自动同步',
            disabled: !view.editable || (!status?.loggedIn && !state.draft.autoSync), onChange: enabled => controller.setAutoSync(enabled) })),
        h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'primary', disabled: !view.canSave, 'aria-busy': state.busy === 'preferences',
            onClick: () => { clearSecrets(); void controller.savePreferences(); } }, state.busy === 'preferences' ? '保存中…' : '保存'),
          h(Button, { type: 'button', variant: 'ghost', disabled: !view.editable || !state.dirty, onClick: () => controller.discardChanges() }, '撤销更改'),
          h(Button, { type: 'button', variant: 'outline', disabled: !view.canSync, 'aria-busy': state.busy === 'sync',
            onClick: () => { clearSecrets(); void controller.sync(); } }, state.busy === 'sync' ? '提交中…' : '立即同步'))),
      h(Modal, { open: projectManagerOpen, onClose: closeProjects, title: '管理同步项目', closeLabel: '关闭',
        footer: projectManagerOpen && h('div', { style: styles.between },
          h('span', { style: styles.body, role: 'status' }, state.dirty ? '未保存' : `已选择 ${view.selectedCount} 项`),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', disabled: state.busy === 'preferences', onClick: closeProjects }, '关闭'),
            h(Button, { type: 'button', variant: 'primary', disabled: !view.canSave, 'aria-busy': state.busy === 'preferences', onClick: saveProjects }, state.busy === 'preferences' ? '保存中…' : '保存'))) },
        projectManagerOpen && h('div', { style: styles.form },
          h(Input, { type: 'search', value: search, onChange: event => setSearch(event.target.value), disabled: !status,
            placeholder: '搜索项目', 'aria-label': '搜索项目', autoComplete: 'off', spellCheck: false, 'data-modal-autofocus': '' }),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', disabled: !view.editable || !projects.some(project => project.available),
              onClick: () => controller.selectVisible(search, true) }, search.trim() ? '全选搜索结果' : '全选可用项目'),
            h(Button, { type: 'button', variant: 'ghost', disabled: !view.editable || !projects.some(project => checkedIds.has(project.id)),
              onClick: () => controller.selectVisible(search, false) }, search.trim() ? '取消搜索结果' : '全部取消')),
          status?.projects.length === 0 ? body('暂无项目')
            : projects.length === 0 && status ? body('无匹配项目')
              : h('div', { style: styles.list, role: 'group', 'aria-label': '项目列表' }, ...projects.map(project => {
                const checked = checkedIds.has(project.id);
                return h('div', { key: project.id, style: styles.project },
                  h(Checkbox, { checked, label: project.label + (project.available ? '' : ' · 不可用'),
                    disabled: !view.editable || (!project.available && !checked),
                    onChange: selected => controller.setProject(project.id, selected) }),
                  h('p', { style: styles.root }, project.root));
              })),
          state.error && h('div', { role: 'alert', style: styles.error }, state.error.message),
          (!state.ready || state.conflict) && h(Button, { type: 'button', variant: 'outline', disabled: Boolean(state.busy) || state.refreshing,
            onClick: () => { void controller.refresh(); } }, state.refreshing ? '刷新中…' : state.conflict ? '刷新并重新选择' : '刷新'))),
      h(Modal, { open: confirmLogout, onClose: () => { clearSecrets(); setConfirmLogout(false); }, title: '退出登录？', closeLabel: '取消',
        footer: h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'ghost', onClick: () => { clearSecrets(); setConfirmLogout(false); } }, '取消'),
          h(Button, { type: 'button', variant: 'primary', disabled: !view.canLogout, 'data-modal-autofocus': '',
            onClick: () => { clearSecrets(); setConfirmLogout(false); void controller.logout(); } }, '退出登录')) }),
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
        label: () => '个人云同步', inject: () => ({ controller }),
      }, SettingsPage));
      ctx.on('connection/reset', () => { void controller.refreshIfWatching(); });
    },
  };
}
