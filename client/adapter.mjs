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
    const [cloudOpen, setCloudOpen] = React.useState(false);
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
        if (!sameIdentity(next.status, previous.status) || next.status?.loggedIn !== previous.status?.loggedIn || next.busy !== previous.busy || deriveView(next).updateBlocked !== deriveView(previous).updateBlocked) clearSecrets();
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
      if (!controller.getSnapshot().status || deriveView(controller.getSnapshot()).updateBlocked) return;
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
    const openCloud = () => {
      if (!deriveView(controller.getSnapshot()).canBrowse) return;
      clearSecrets(); setCloudOpen(true); void controller.browseProjects();
    };
    const closeCloud = () => { setCloudOpen(false); controller.cancelRecoveryIntent(); };
    const cloud = state.cloud;
    const intent = cloud.intent;
    const recovery = status?.recovery;
    const updater = state.update;
    const updateIntent = state.updateIntent;
    const updateLabel = state.updateUncertain ? '结果未确认' : state.busy === 'checkupdate' ? '检查中…' : ({ idle: '尚未检查', checking: '检查中…', available: '有新版本', 'up-to-date': '已是最新版本', installing: '原生安装中…', cancelling: '正在请求取消…', 'restart-required': '待重启 DSH', cancelled: '已取消（非回滚）', failed: '更新未完成', uncertain: '结果未确认' }[updater?.state] ?? '尚未检查');
    const projects = filterProjects(status?.projects ?? [], search);
    const checkedIds = new Set(state.draft.projectIds);
    const selectedProjects = (status?.projects ?? []).filter(project => checkedIds.has(project.id));
    const loginState = state.loading ? '读取中' : !state.ready ? '状态未确认' : status?.loggedIn ? '已登录' : '未登录';
    const passwordOpen = sameIdentity(status, passwordIdentity) && passwordBinding.current === passwordIdentity;
    const body = (content, extra = {}) => h('p', { style: styles.body, ...extra }, content);
    const recoveryResult = recovery && h('div', { style: styles.form, role: 'status', 'aria-live': 'polite', 'data-personal-sync': 'recovery-result' },
      body(`${recovery.kind === 'restore' ? '下载' : '导入'}${recovery.state === 'running' ? '进行中…（Host 后台运行，可关闭页面）' : recovery.state === 'succeeded' ? '完成' : '未完成'}`),
      body(recovery.root, { style: styles.root }),
      recovery.kind === 'restore' && recovery.sessionCount !== undefined && body(`会话归档 ${recovery.sessionCount} 个；归档不等于可续接会话`),
      recovery.kind === 'import' && body(`已导入 ${recovery.importedCount ?? '未确认'} · 已跳过 ${recovery.skippedCount ?? '未确认'} · 失败 ${recovery.failedCount ?? '未确认'}`),
      view.recoveryError && body(view.recoveryError, { role: 'alert', style: { ...styles.body, ...styles.warning } }),
      recovery.state === 'failed' && body(recovery.kind === 'restore' ? '目录可能不完整，勿作为完整副本使用；请检查后使用新目录。' : '部分会话可能已写入，请检查下方结果，勿重复导入。', { style: { ...styles.body, ...styles.warning } }),
      recovery.sessions?.length > 0 && h('div', { style: styles.list, 'aria-label': '会话导入结果' }, ...recovery.sessions.map(item => h('div', { key: item.sourceId, style: styles.project },
        body(`${item.sourceId} → ${item.sessionId ?? '无新会话 ID'} · ${{ imported: '已导入', skipped: '已跳过', failed: '失败' }[item.outcome]}`),
        item.workspaceAttached === false && body('未关联工作区；请按会话 ID 手动检查，勿重复导入。', { style: { ...styles.body, ...styles.warning } })) )));
    return h('section', { style: styles.page, 'aria-label': '个人云同步', 'aria-busy': state.loading || state.refreshing || Boolean(state.busy), 'data-personal-sync': 'settings' },
      h('div', { style: styles.between },
        h('h2', { style: { ...styles.heading, fontSize: 18 } }, '个人云同步'),
        h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing,
          onClick: () => { clearSecrets(); void controller.refresh(); } }, state.refreshing ? '刷新中…' : state.conflict ? '刷新并重新选择' : '刷新')),
      state.error && !passwordOpen && !projectManagerOpen && h('div', { role: 'alert', style: { ...styles.card, ...styles.error }, 'data-personal-sync': 'error' }, state.error.message),
      state.notice && body(state.notice, { role: 'status', 'aria-live': 'polite' }),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-update-title`, 'data-personal-sync': 'update-summary' },
        h('div', { style: styles.between },
          h('h3', { id: `${id}-update-title`, style: styles.heading }, '插件更新'),
          h('span', { style: styles.badge, role: 'status', 'aria-live': 'polite' }, updater?.supported === false ? '此宿主不可用' : updateLabel)),
        body(`运行版本 ${updater?.currentVersion ?? '未确认'}`),
        updater?.installedVersion && updater.installedVersion !== updater.currentVersion && body(`已安装 ${updater.installedVersion} · 待重启`),
        body('固定来源：GitHub HuYongJi/dsh_sync（仓库发布版本）；仅点击检查时访问 GitHub，无需云账号登录。'),
        updater?.candidate && body(`目标版本 ${updater.candidate.version} · 提交 ${updater.candidate.commit}`, { style: styles.root }),
        view.updaterBusy && body('更新器忙碌；其他设置、登录、密码、上传和恢复操作已锁定。Host 后台运行，可关闭页面。', { role: 'status' }),
        (view.restartRequired || state.updateUncertain) && body('插件文件可能已变更；确认安装结束后，必须重启 DSH 再刷新页面（仅刷新无效）。不会自动重启；重启前禁止同步、恢复、导入和修改设置。', { style: { ...styles.body, ...styles.warning } }),
        state.updateUncertain && body('更新结果未确认，不会自动重装；自动核对次数有限，之后请手动核对更新状态并检查 DSH Plugins。', { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        view.updateError && body(view.updateError, { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        body('使用 DSH 原生插件管理器；脚本可能需要在 DSH Plugins 手动审批，兼容性与安全检查不会绕过。'),
        (state.dirty || state.conflict) && body('更新前请先保存或撤销同步设置更改。'),
        h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'outline', disabled: !view.canCheckUpdate, onClick: () => { clearSecrets(); void controller.checkUpdate(); } }, '检查更新'),
          h(Button, { type: 'button', variant: 'primary', disabled: !view.canUpdate, onClick: () => { clearSecrets(); controller.prepareUpdate(); } }, '一键更新'),
          h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing, onClick: () => { void controller.refreshUpdate(); } }, '核对更新状态'),
          (view.updaterBusy || state.busy === 'installupdate' || state.busy === 'cancelupdate') && h(Button, { type: 'button', variant: 'outline', disabled: !view.canCancelUpdate, onClick: () => { void controller.cancelUpdate(); } }, '取消更新'))),
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
          h(Button, { type: 'button', variant: 'outline', disabled: !status || view.updateBlocked, onClick: openProjects }, '管理'))),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-cloud-title`, 'data-personal-sync': 'cloud-summary' },
        h('div', { style: styles.between },
          h('h3', { id: `${id}-cloud-title`, style: styles.heading }, '云端下载'),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'outline', disabled: !view.canBrowse, onClick: openCloud }, '浏览云端'),
            recovery?.kind === 'restore' && recovery.state === 'succeeded' && h(Button, { type: 'button', variant: 'outline', disabled: !view.canImport,
              onClick: () => { clearSecrets(); controller.prepareImport(); } }, '导入安全会话'))),
        !recovery && body('下载到 Host 全新目录，不会自动加入同步项目。'),
        recoveryResult,
        state.recoveryUncertain && body('请求结果未确认，请刷新状态；先检查目标目录和会话 ID，勿重复下载或导入，也勿通过重新登录或重启来重试。', { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        cloud.error && !cloudOpen && h('div', { role: 'alert', style: styles.error }, cloud.error.message)),
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
      h(Modal, { open: Boolean(updateIntent), onClose: () => controller.cancelUpdateIntent(), title: '确认更新插件？', closeLabel: '取消' },
        updateIntent && h('div', { style: styles.form },
          body(`运行版本 ${updateIntent.currentVersion} → 目标版本 ${updateIntent.version}`),
          body('来源：GitHub HuYongJi/dsh_sync；仅安装本次检查确认的精确提交。'),
          body(`提交 ${updateIntent.commit}`, { style: styles.root }),
          body('由 DSH 原生插件管理器安装，不更新云同步服务器，不自动重启，也不会自动启用同步。'),
          body('原生安装可能需要脚本审批，请在 DSH Plugins 中手动检查。保留兼容性、安全检查和原生审批，不会自动授权或添加版本豁免。'),
          body('安装开始后即使失败或取消，文件也可能已变更；结束后必须重启 DSH 再刷新页面（仅刷新无效）。取消不保证回滚。', { style: { ...styles.body, ...styles.warning } }),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: () => controller.cancelUpdateIntent() }, '取消'),
            h(Button, { type: 'button', variant: 'primary', disabled: !view.canUpdate, onClick: () => { void controller.confirmUpdate(updateIntent); } }, '确认更新')))),
      h(Modal, { open: cloudOpen, onClose: closeCloud, title: '云端下载', closeLabel: '关闭' },
        cloudOpen && h('div', { style: styles.form },
          body('云端仅提供项目 ID；名称来自本机已知项目。请选择明确检查点，不会自动选择分支。'),
          cloud.projects.length > 0 && h('div', { style: styles.list, 'aria-label': '云端项目' }, ...cloud.projects.map(project => {
            const local = status?.projects.find(item => item.projectId === project.projectId);
            return h('div', { key: project.projectId, style: styles.project },
              h(Button, { type: 'button', variant: 'ghost', disabled: !view.canBrowse || Boolean(state.recoveryPending), onClick: () => {
                if (controller.setCloudProject(project.projectId)) void controller.loadCheckpoints();
              } }, `${project.projectId}${local ? ` · ${local.label}` : ''}`),
              body(`${project.checkpointCount} 个检查点 · ${when(project.latestCreatedAt)}`));
          })),
          h('label', { style: styles.label, htmlFor: `${id}-cloud-project` }, '项目 ID（可手动输入，无需项目浏览支持）',
            h(Input, { id: `${id}-cloud-project`, value: cloud.projectId, onChange: event => controller.setCloudProject(event.target.value),
              disabled: !view.canBrowse || Boolean(state.recoveryPending), maxLength: 100, autoComplete: 'off', spellCheck: false, 'data-modal-autofocus': '' })),
          h(Button, { type: 'button', variant: 'outline', disabled: !view.canBrowse || !cloud.projectId || Boolean(state.recoveryPending),
            onClick: () => { void controller.loadCheckpoints(); } }, state.busy === 'checkpoints' ? '读取中…' : '读取检查点'),
          cloud.heads.length > 1 && body(`存在 ${cloud.heads.length} 个 head 冲突分支，请逐项核对后只选择一个检查点。`, { style: { ...styles.body, ...styles.warning } }),
          cloud.loaded && !cloud.checkpoints.length && body('暂无检查点'),
          cloud.checkpoints.length > 0 && h('div', { style: styles.list, role: 'group', 'aria-label': '检查点列表（单选）' }, ...cloud.checkpoints.map(checkpoint => h('div', { key: checkpoint.id, style: styles.project },
            h(Checkbox, { checked: cloud.checkpointId === checkpoint.id, label: `${checkpoint.id}${cloud.heads.includes(checkpoint.id) ? ' · head' : ''}`,
              disabled: !view.canBrowse || Boolean(state.recoveryPending), onChange: selected => controller.selectCheckpoint(selected ? checkpoint.id : '') }),
            body(`${when(checkpoint.createdAt)} · 设备 ${checkpoint.deviceId} · ${checkpoint.fileCount} 个文件 · ${checkpoint.totalBytes} 字节`),
            body(`父检查点 ${checkpoint.parentId ?? '无'}`)))),
          h('label', { style: styles.label, htmlFor: `${id}-cloud-destination` }, '目标：DSH Host 机器上的绝对路径（非浏览器机器）',
            h(Input, { id: `${id}-cloud-destination`, value: cloud.destination, onChange: event => controller.setDestination(event.target.value),
              disabled: !view.canBrowse || Boolean(state.recoveryPending), maxLength: 4096, autoComplete: 'off', spellCheck: false, placeholder: 'E:\\restored\\new-project 或 /srv/restored/new-project' })),
          body('父目录必须存在，目标目录必须不存在；不会合并或覆盖，不自动注册项目、启用上传或执行任务。'),
          body('会话归档不等于可续接会话；下载后可另行确认导入安全子集。'),
          recoveryResult,
          recovery?.kind === 'restore' && recovery.state === 'succeeded' && h(Button, { type: 'button', variant: 'outline', disabled: !view.canImport,
            onClick: () => { clearSecrets(); controller.prepareImport(); } }, '导入安全会话'),
          cloud.error && h('div', { role: 'alert', style: styles.error }, cloud.error.message),
          state.error && h('div', { role: 'alert', style: styles.error }, state.error.message),
          (state.dirty || state.conflict) && body('请先保存或撤销本机同步设置更改。'),
          state.recoveryUncertain && body('结果未确认，勿重复提交；请刷新状态。', { role: 'alert', style: styles.warning }),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: closeCloud }, '关闭'),
            h(Button, { type: 'button', variant: 'outline', disabled: Boolean(state.busy) || state.refreshing, onClick: () => { void controller.refresh(); } }, '核对状态'),
            h(Button, { type: 'button', variant: 'primary', disabled: !view.canRestore, onClick: () => controller.prepareRestore() }, '下载到新目录')))),
      h(Modal, { open: Boolean(intent), onClose: () => controller.cancelRecoveryIntent(), title: intent?.kind === 'import' ? '确认导入安全会话？' : '确认云端下载？', closeLabel: '取消' },
        intent && h('div', { style: styles.form },
          body(`${intent.server} · ${intent.username}`),
          intent.kind === 'restore' ? h('div', null,
            body(`项目 ${intent.projectId} · 检查点 ${intent.checkpointId}`), body(`DSH Host 目标：${intent.destination}`),
            body('确认父目录已存在、目标目录不存在。下载不注册或选择项目，不开启自动上传，不执行任务。'))
            : h('div', null, body(`最近成功下载：${intent.root}`),
              body('仅导入该目录的安全会话子集，可能注册工作区，但不会选择同步项目、开启上传或执行任务。归档不等于可续接；跳过、失败或未关联工作区时请检查结果，勿重复导入。')),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: () => controller.cancelRecoveryIntent() }, '取消'),
            h(Button, { type: 'button', variant: 'primary', disabled: intent.kind === 'restore' ? !view.canRestore : !view.canImport,
              onClick: () => { void controller.confirmRecovery(intent); } }, intent.kind === 'restore' ? '确认下载' : '确认导入')))),
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
