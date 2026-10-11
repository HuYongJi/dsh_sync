import { createController, deriveView, filterProjects } from './state.mjs';

// DSH 0.2.0-rc.2 uses React slots; both React and controls come from its module loader.
export function createClientPlugin(require) {
  const React = require('react');
  const { Button, Input, Checkbox, Switch, Modal, IconFolderCloseRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const folderIcon = IconFolderCloseRegular ? h('span', { 'aria-hidden': 'true', style: { display: 'inline-flex', flexShrink: 0 } }, h(IconFolderCloseRegular, { size: 16 })) : null;
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
    const [cloudStage, setCloudStage] = React.useState('select');
    const [downloadSearch, setDownloadSearch] = React.useState('');
    const [suggestionsOpen, setSuggestionsOpen] = React.useState(false);
    const [activeSuggestion, setActiveSuggestion] = React.useState('');
    const [downloadNotice, setDownloadNotice] = React.useState('');
    const downloadInput = React.useRef(null);
    const comboRoot = React.useRef(null);
    const stageFocus = React.useRef(null);
    const mainRefresh = React.useRef(null);
    const composition = React.useRef({ active: false, ended: false });
    const cloudLife = React.useRef(0);
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
        if (!sameIdentity(next.status, previous.status) || next.status?.loggedIn !== previous.status?.loggedIn || next.update?.currentVersion !== previous.update?.currentVersion || deriveView(next).updateBlocked !== deriveView(previous).updateBlocked) { ++cloudLife.current; setCloudOpen(false); setSuggestionsOpen(false); setDownloadSearch(''); setDownloadNotice(''); }
        previous = next;
        if (passwordBinding.current && !sameIdentity(next.status, passwordBinding.current)) closePassword();
      });
      const stop = controller.watch();
      return () => {
        clearSecrets();
        passwordBinding.current = null;
        ++cloudLife.current;
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
      if (!controller.getSnapshot().status || deriveView(controller.getSnapshot()).updateBlocked || deriveView(controller.getSnapshot()).pickingDestination) return;
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
      clearSecrets(); ++cloudLife.current; composition.current = { active: false, ended: false }; setDownloadSearch(''); setSuggestionsOpen(false); setActiveSuggestion(''); setCloudStage('select'); setCloudOpen(true);
      void controller.browseProjects();
    };
    const closeCloud = () => {
      ++cloudLife.current; composition.current = { active: false, ended: false }; setCloudOpen(false); setSuggestionsOpen(false); controller.closeDownloadBrowser(); controller.cancelDownloadIntent();
      // Native Modal restores its invoker; an accepted download disables that button.
      queueMicrotask(() => { const target = mainRefresh.current; if (target?.isConnected && !target.disabled && target.ownerDocument.activeElement === target.ownerDocument.body) target.focus(); });
    };
    const cloud = state.cloud;
    const intent = state.downloadIntent;
    const downloads = state.downloadSelection;
    const download = status?.download;
    const directoryBrowser = state.downloadBrowser;
    const downloadTitle = ({ select: '选择要下载的项目', folders: '选择保存位置', review: '确认下载所选项目', progress: '下载进度', import: '导入安全会话？' })[cloudStage];
    const showProgress = () => { clearSecrets(); setCloudStage('progress'); setCloudOpen(true); void controller.refresh(); };
    const chooseDownloadFolder = () => {
      clearSecrets(); const lifetime = cloudLife.current;
      void controller.chooseDownloadDestination().then(() => { if (cloudLife.current === lifetime && controller.getSnapshot().downloadBrowser) { setCloudStage('folders'); setCloudOpen(true); } });
    };
    React.useEffect(() => {
      if (!cloudOpen || cloudStage === 'select') return;
      stageFocus.current?.focus();
    }, [cloudOpen, cloudStage]);
    React.useEffect(() => {
      if (!cloudOpen || !suggestionsOpen || !comboRoot.current) return;
      const doc = comboRoot.current.ownerDocument;
      const outside = event => { if (!comboRoot.current?.contains(event.target)) setSuggestionsOpen(false); };
      doc.addEventListener('pointerdown', outside);
      return () => doc.removeEventListener('pointerdown', outside);
    }, [cloudOpen, suggestionsOpen]);
    const recovery = status?.recovery;
    const updater = state.update;
    const updateIntent = state.updateIntent;
    const installing = ['installing', 'cancelling'].includes(updater?.state) || ['installupdate', 'cancelupdate'].includes(state.busy);
    const updateLabel = state.updateUncertain ? '结果未确认' : state.busy === 'checkupdate' ? '检查中…' : ({ idle: '尚未检查', checking: '检查中…', available: '有新版本', 'up-to-date': '已是最新版本', installing: '更新中…', cancelling: '更新中…', 'restart-required': '待重启', cancelled: '已取消', failed: '更新未完成', uncertain: '结果未确认' }[updater?.state] ?? '尚未检查');
    const manualUpdate = updater?.state === 'available' && Boolean(updater.candidate) && !state.updateError;
    const updateAction = installing ? '更新中…' : view.restartRequired ? '待重启' : manualUpdate ? '手动更新' : '检查更新';
    const projectLabel = project => project?.label ?? status?.projects.find(item => item.projectId === project?.projectId)?.label ?? '项目文件夹';
    const chosenIds = new Set(downloads.map(item => item.projectId));
    const query = downloadSearch.trim().toLocaleLowerCase();
    const unchosen = cloud.projects.filter(item => !chosenIds.has(item.projectId) && (!query || `${projectLabel(item)}\n${item.sourceRoot ?? ''}`.toLocaleLowerCase().includes(query)));
    const suggestions = unchosen.slice(0, 100);
    const activeOption = suggestions.find(item => item.projectId === activeSuggestion);
    const dropdownOpen = cloudOpen && cloudStage === 'select' && suggestionsOpen;
    const addSuggested = projectId => {
      const project = suggestions.find(item => item.projectId === projectId);
      if (!project || !deriveView(controller.getSnapshot()).canBrowse || controller.getSnapshot().downloadSelection.length >= 20) return;
      const lifetime = cloudLife.current;
      setSuggestionsOpen(false); setActiveSuggestion(''); setDownloadSearch('');
      void controller.addDownloadProject(projectId).then(() => {
        if (cloudLife.current !== lifetime) return;
        if (controller.getSnapshot().downloadSelection.some(item => item.projectId === projectId)) setDownloadNotice(`已添加 ${projectLabel(project)}`);
        // Only restore input after its own selection; never steal a later outside click.
        const input = downloadInput.current;
        if (input && (!input.ownerDocument.activeElement || input.ownerDocument.activeElement === input || input.ownerDocument.activeElement === input.ownerDocument.body)) input.focus();
      });
    };
    const composingKey = event => composition.current.active || composition.current.ended || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229;
    const comboEscape = event => {
      if (event.key !== 'Escape' || !dropdownOpen || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault(); event.stopPropagation();
      if (!composingKey(event)) { setSuggestionsOpen(false); setActiveSuggestion(''); }
    };
    const comboKey = event => {
      if (composingKey(event) || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') { comboEscape(event); return; }
      if (event.key === 'Tab') { setSuggestionsOpen(false); setActiveSuggestion(''); return; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); setSuggestionsOpen(true);
        const current = suggestions.findIndex(item => item.projectId === activeSuggestion);
        const index = current < 0 ? (event.key === 'ArrowDown' ? 0 : suggestions.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        setActiveSuggestion(suggestions[index]?.projectId ?? '');
      } else if (event.key === 'Enter' && dropdownOpen) {
        event.preventDefault(); if (activeOption) addSuggested(activeOption.projectId);
      }
    };
    React.useEffect(() => {
      if (dropdownOpen && activeOption) comboRoot.current?.querySelector(`[id="${id}-download-option-${activeOption.projectId}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }, [dropdownOpen, activeOption?.projectId]);
    const projects = filterProjects(status?.projects ?? [], search);
    const checkedIds = new Set(state.draft.projectIds);
    const selectedProjects = (status?.projects ?? []).filter(project => checkedIds.has(project.id));
    const loginState = state.loading ? '读取中' : !state.ready ? '状态未确认' : status?.loggedIn ? '已登录' : '未登录';
    const passwordOpen = sameIdentity(status, passwordIdentity) && passwordBinding.current === passwordIdentity;
    const body = (content, extra = {}) => h('p', { style: styles.body, ...extra }, content);
    const recoveryResult = !download && recovery && h('div', { style: styles.form, role: 'status', 'aria-live': 'polite', 'data-personal-sync': 'recovery-result' },
      body(`${recovery.kind === 'restore' ? '下载' : '导入'}${recovery.state === 'running' ? '进行中…' : recovery.state === 'succeeded' ? '完成' : '未完成'}`),
      body(recovery.root, { style: styles.root }),
      recovery.kind === 'restore' && recovery.sessionCount !== undefined && body(`会话归档 ${recovery.sessionCount} 个`),
      recovery.kind === 'import' && body(`已导入 ${recovery.importedCount ?? '未确认'} · 已跳过 ${recovery.skippedCount ?? '未确认'} · 失败 ${recovery.failedCount ?? '未确认'}`),
      view.recoveryError && body(view.recoveryError, { role: 'alert', style: { ...styles.body, ...styles.warning } }),
      recovery.state === 'failed' && body(recovery.kind === 'restore' ? '目录可能不完整，请使用新目录重试' : '部分会话可能已写入，勿重复导入', { style: { ...styles.body, ...styles.warning } }),
      recovery.sessions?.length > 0 && h('div', { style: styles.list, 'aria-label': '会话导入结果' }, ...recovery.sessions.map(item => h('div', { key: item.sourceId, style: styles.project },
        body(`${item.sourceId} → ${item.sessionId ?? '无新会话 ID'} · ${{ imported: '已导入', skipped: '已跳过', failed: '失败' }[item.outcome]}`),
        item.workspaceAttached === false && body('未关联工作区，勿重复导入', { style: { ...styles.body, ...styles.warning } })) )));
    return h('section', { style: styles.page, 'aria-label': '个人云同步', 'aria-busy': state.loading || state.refreshing || Boolean(state.busy), 'data-personal-sync': 'settings' },
      h('div', { style: styles.between },
        h('h2', { style: { ...styles.heading, fontSize: 18 } }, '个人云同步'),
        h(Button, { ref: mainRefresh, type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing,
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
          h(Button, { type: 'button', variant: 'outline', disabled: !status || view.updateBlocked || view.pickingDestination, onClick: openProjects }, '管理'))),
      h('section', { style: styles.card, 'aria-labelledby': `${id}-cloud-title`, 'data-personal-sync': 'cloud-summary' },
        h('div', { style: styles.between },
          h('div', { style: styles.summary }, h('h3', { id: `${id}-cloud-title`, style: styles.heading }, '云端下载'),
            body(`已选择 ${downloads.length} 个项目`),
            downloads.length > 0 && h('ul', { style: styles.summaryList, 'aria-label': '所选下载项目' }, ...downloads.slice(0, 3).map(row => h('li', { key: row.projectId }, row.label))),
            downloads.length > 3 && body(`另有 ${downloads.length - 3} 个项目`)),
          h(Button, { type: 'button', variant: 'outline', 'aria-label': downloads.length ? '管理下载项目' : '选择下载项目', disabled: !view.canBrowse, onClick: openCloud }, downloads.length ? '管理' : '选择项目')),
        h('div', { style: styles.between },
          h('div', { style: styles.summary }, body('保存位置'), body(state.downloadPlan?.parent ?? '尚未选择', { style: styles.root, 'aria-label': '下载保存位置' })),
          h(Button, { type: 'button', variant: 'outline', disabled: !view.canChooseDownloadDestination, onClick: chooseDownloadFolder }, state.busy === 'downloadpick' ? '选择中…' : '保存位置')),
        h('div', { style: styles.row },
          h(Button, { type: 'button', variant: 'primary', disabled: !view.canDownload, onClick: () => { clearSecrets(); if (controller.prepareDownload()) { setCloudStage('review'); setCloudOpen(true); } } }, '下载所选'),
          download && h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing, onClick: showProgress }, '查看下载进度')),
        download && body(`下载${({ running: '进行中…', succeeded: '完成', partial: '部分完成', failed: '未完成' })[download.state]} · ${download.completed}/${download.total}`, { role: 'status', 'aria-live': 'polite' }),
        view.downloadWarning && body(view.downloadWarning, { role: 'alert', style: styles.warning }),
        !download && !cloudOpen && recoveryResult,
        (state.downloadUncertain || state.recoveryUncertain) && !cloudOpen && body('结果未确认，请刷新；勿重复提交', { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        state.downloadError && !cloudOpen && h('div', { role: 'alert', style: styles.error }, state.downloadError.message)),
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
      h('section', { style: styles.card, 'aria-labelledby': `${id}-update-title`, 'data-personal-sync': 'update-summary' },
        h('div', { style: styles.between },
          h('div', { style: styles.summary },
            h('h3', { id: `${id}-update-title`, style: styles.heading }, '插件更新'),
            h('span', { style: styles.body, role: 'status', 'aria-live': 'polite' }, `当前版本 ${updater?.currentVersion ?? '未确认'} · ${updater?.supported === false ? '此宿主不可用' : updateLabel}`)),
          h(Button, { type: 'button', variant: 'primary', disabled: installing || view.restartRequired || (manualUpdate ? !view.canUpdate : !view.canCheckUpdate),
            onClick: () => { clearSecrets(); if (manualUpdate) controller.prepareUpdate(); else void controller.checkUpdate(); } }, updateAction)),
        view.restartRequired && !installing && body('请重启 DSH', { role: 'status' }),
        view.updateError && body(view.updateError, { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        (state.dirty || state.conflict) && body('请先保存或撤销更改')),
      h(Modal, { open: Boolean(updateIntent), onClose: () => controller.cancelUpdateIntent(), title: '确认更新插件？', closeLabel: '取消' },
        updateIntent && h('div', { style: styles.form },
          body(`${updateIntent.currentVersion} → ${updateIntent.version}`),
          body('更新后需重启 DSH'),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: () => controller.cancelUpdateIntent() }, '取消'),
            h(Button, { type: 'button', variant: 'primary', disabled: !view.canUpdate, onClick: () => { void controller.confirmUpdate(updateIntent); } }, '确认更新')))),
      h(Modal, { open: cloudOpen, onClose: closeCloud, title: downloadTitle, closeLabel: '关闭', onKeyDownCapture: comboEscape,
        footer: cloudOpen && h('div', { style: styles.between },
          h('span', { style: styles.body, role: 'status' }, cloudStage === 'select' ? `已选择 ${downloads.length} 个项目` : ''),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'ghost', onClick: closeCloud }, cloudStage === 'select' ? '完成' : '关闭'),
            cloudStage === 'review' && intent?.kind === 'download' && h(Button, { type: 'button', variant: 'primary', disabled: !view.canDownload, onClick: () => {
              if (controller.getSnapshot().downloadIntent !== intent) return;
              const lifetime = cloudLife.current;
              void controller.confirmDownload(intent).then(() => { if (cloudLife.current === lifetime) setCloudStage('progress'); });
            } }, '确认下载'),
            cloudStage === 'import' && intent?.kind === 'import' && h(Button, { type: 'button', variant: 'primary', disabled: !view.canRecover, onClick: () => {
              if (controller.getSnapshot().downloadIntent !== intent) return;
              const lifetime = cloudLife.current;
              void controller.confirmDownloadImport(intent).then(() => { if (cloudLife.current === lifetime) setCloudStage('progress'); });
            } }, '确认导入'))) },
        cloudOpen && h('div', { style: styles.form, ref: stageFocus, tabIndex: -1, ...(cloudStage !== 'select' ? { 'data-modal-autofocus': '' } : {}) },
          cloudStage === 'select' && h('div', { style: styles.form },
            !downloads.length && body('尚未选择项目，请在下方添加'),
            downloads.length > 0 && h('ul', { style: { ...styles.list, listStyle: 'none', margin: 0, padding: 0 }, 'aria-label': '已选择的下载项目' }, ...downloads.map((row, index) => h('li', { key: row.projectId, style: styles.project },
              h('div', { style: styles.between },
                h('strong', { style: { ...styles.row, fontSize: 14 } }, folderIcon, row.label),
                h('div', { style: styles.row },
                  h(Button, { type: 'button', variant: 'ghost', disabled: !view.canBrowse, 'data-download-remove': '', 'aria-label': `移除 ${row.label}`, onClick: event => {
                    const list = event.currentTarget?.closest?.('ul');
                    if (controller.removeDownloadProject(row.projectId)) { setDownloadNotice(`已移除 ${row.label}`); queueMicrotask(() => { const buttons = list?.querySelectorAll?.('[data-download-remove]'); const target = buttons?.[Math.min(index, (buttons?.length ?? 0) - 1)]; (target?.isConnected ? target : downloadInput.current)?.focus(); }); }
                  } }, '移除'))),
              downloads.some(other => other !== row && other.label === row.label) && row.sourceRoot && body(row.sourceRoot, { style: styles.root })))),
            h('div', { ref: comboRoot, style: { ...styles.form, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-settings-card-stroke)' },
              onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) { setSuggestionsOpen(false); setActiveSuggestion(''); } } },
              h('label', { style: styles.label, htmlFor: `${id}-download-add` }, '添加项目',
                h(Input, { ref: downloadInput, id: `${id}-download-add`, type: 'text', role: 'combobox', value: downloadSearch, placeholder: '搜索云端项目…', autoComplete: 'off', spellCheck: false, maxLength: 1024,
                  'data-modal-autofocus': '', 'aria-autocomplete': 'list', 'aria-expanded': dropdownOpen, 'aria-controls': dropdownOpen ? `${id}-download-options` : undefined,
                  'aria-activedescendant': dropdownOpen && activeOption ? `${id}-download-option-${activeOption.projectId}` : undefined,
                  'aria-describedby': downloads.length >= 20 ? `${id}-download-help` : undefined, readOnly: !view.canBrowse, 'aria-disabled': !view.canBrowse || downloads.length >= 20,
                  onFocus: () => { if (deriveView(controller.getSnapshot()).canBrowse) setSuggestionsOpen(true); },
                  onClick: () => { if (deriveView(controller.getSnapshot()).canBrowse) setSuggestionsOpen(true); },
                  onChange: event => { setDownloadSearch(event.target.value); setActiveSuggestion(''); setSuggestionsOpen(true); }, onKeyDown: comboKey,
                  onCompositionStart: () => { composition.current = { active: true, ended: false }; }, onCompositionEnd: () => { composition.current = { active: false, ended: true }; }, onKeyUp: () => { composition.current.ended = false; } })),
              downloads.length >= 20 && body('最多选择20个项目', { id: `${id}-download-help` }),
              dropdownOpen && h('div', { id: `${id}-download-options`, role: 'listbox', 'aria-label': '可添加的云端项目', style: { ...styles.card, maxHeight: 220, overflowY: 'auto', padding: 4, gap: 0 } },
                ...suggestions.map(project => h('div', { key: project.projectId, id: `${id}-download-option-${project.projectId}`, role: 'option', 'aria-selected': activeOption?.projectId === project.projectId,
                  'aria-disabled': !view.canBrowse || downloads.length >= 20, style: { padding: '9px 12px', borderRadius: 8, cursor: 'pointer', background: activeOption?.projectId === project.projectId ? 'var(--dsw-alias-settings-card-stroke)' : 'transparent' },
                  onPointerDown: event => event.preventDefault(), onPointerMove: () => setActiveSuggestion(project.projectId), onClick: () => addSuggested(project.projectId) },
                  h('span', { style: styles.row }, folderIcon, projectLabel(project)),
                  cloud.projects.some(other => other.projectId !== project.projectId && projectLabel(other) === projectLabel(project)) && project.sourceRoot && body(project.sourceRoot, { style: styles.root })))),
              dropdownOpen && !suggestions.length && !cloud.error && body(cloud.projectsLoaded ? (query ? '无匹配项目' : cloud.projects.length ? '所有项目已添加' : '暂无云端项目') : '读取中…', { role: 'status' }),
              dropdownOpen && unchosen.length > 100 && body('仅显示前100项，请继续搜索'),
              body(downloadNotice, { role: 'status', 'aria-live': 'polite' })),
            state.busy === 'projects' && body('读取中…', { role: 'status' }),
            cloud.projectsLoaded && !cloud.projects.length && body('暂无云端项目'),
            cloud.partial && body('部分项目读取失败', { role: 'alert', style: styles.warning }),
            cloud.error && body(cloud.error.message, { role: 'alert', style: styles.error })),
          cloudStage === 'folders' && directoryBrowser && h('div', { style: styles.form },
            h('div', { style: styles.row, 'aria-label': '文件夹导航' }, ...directoryBrowser.crumbs.map(crumb => h(Button, { key: crumb.id, type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing,
              onClick: () => { if (controller.getSnapshot().downloadBrowser === directoryBrowser) void controller.browseDownloadDestination(crumb.id); } }, crumb.label))),
            body(directoryBrowser.path, { style: styles.root }),
            h('div', { style: styles.list, 'aria-label': '文件夹列表' }, ...directoryBrowser.directories.map(folder => h(Button, { key: folder.id, type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.refreshing,
              onClick: () => { if (controller.getSnapshot().downloadBrowser === directoryBrowser) void controller.browseDownloadDestination(folder.id); } }, folder.label))),
            !directoryBrowser.directories.length && body('暂无子文件夹'), directoryBrowser.truncated && body('仅显示部分文件夹'),
            h(Button, { type: 'button', variant: 'primary', disabled: !directoryBrowser.selectable || Boolean(state.busy) || state.refreshing, onClick: () => {
              const lifetime = cloudLife.current;
              if (controller.getSnapshot().downloadBrowser === directoryBrowser) void controller.selectDownloadDestination(directoryBrowser.currentId).then(selected => { if (selected && cloudLife.current === lifetime) closeCloud(); });
            } }, '选择此文件夹')),
          cloudStage === 'review' && intent?.kind === 'download' && h('div', { style: styles.form },
            body(`将下载 ${intent.items.length} 个项目`), body('下载云端最新内容'),
            ...intent.items.map(item => h('div', { key: item.projectId, style: styles.project }, h('strong', null, item.label), body(item.root, { style: styles.root }))),
            body('新建目录，不覆盖现有文件'), body('关闭窗口后继续下载')),
          cloudStage === 'import' && intent?.kind === 'import' && h('div', { style: styles.form }, body(intent.label), body(intent.root, { style: styles.root }), body('仅导入安全会话，不启动代理。导入后请核对结果，勿重复提交。')),
          cloudStage === 'progress' && h('div', { style: styles.form },
            download && body(`下载${({ running: '进行中…', succeeded: '完成', partial: '部分完成', failed: '未完成' })[download.state]} · ${download.completed}/${download.total}`, { role: 'status', 'aria-live': 'polite' }),
            view.downloadWarning && body(view.downloadWarning, { role: 'alert', style: styles.warning }),
            download?.state === 'running' && body('可以关闭此窗口，下载在宿主中继续。'),
            ...(download?.items ?? []).map(item => h('div', { key: item.restoreId, style: styles.project },
              h('div', { style: styles.between }, h('strong', null, item.label), body(({ pending: '等待中', running: '下载中…', succeeded: '完成', failed: '失败', cancelled: '已停止' })[item.state])),
              view.downloadItemErrors[item.restoreId] && body(view.downloadItemErrors[item.restoreId], { style: styles.warning }),
              item.state === 'failed' && body('目录可能不完整，请重新选择新目录后重试', { style: styles.warning }),
              h('details', null, h('summary', { style: styles.body }, '详情'), body(item.root, { style: styles.root }),
                item.sessionCount !== undefined && body(`会话归档 ${item.sessionCount} 个`),
                item.importResult && h('div', { style: styles.form },
                  body(`已导入 ${item.importResult.importedCount ?? '未确认'} · 已跳过 ${item.importResult.skippedCount ?? '未确认'} · 失败 ${item.importResult.failedCount ?? '未确认'}`),
                  item.importResult.state === 'failed' && body('部分会话可能已写入，勿重复导入', { style: styles.warning }),
                  ...(item.importResult.sessions ?? []).map(session => h('div', { key: session.sourceId },
                    body(`${session.sourceId} → ${session.sessionId ?? '无新会话 ID'} · ${{ imported: '已导入', skipped: '已跳过', failed: '失败' }[session.outcome]}`),
                    session.workspaceAttached === false && body('未关联工作区，勿重复导入', { style: styles.warning }))))),
              item.canImport && h(Button, { type: 'button', variant: 'outline', disabled: !view.canRecover, 'aria-label': `导入 ${item.label} 的安全会话`, onClick: () => { if (controller.prepareDownloadImport(item.restoreId)) setCloudStage('import'); } }, '导入安全会话'))),
            h(Button, { type: 'button', variant: 'outline', disabled: Boolean(state.busy) || state.refreshing, onClick: () => { void controller.refresh(); } }, '核对状态')),
          state.downloadError && body(state.downloadError.message, { role: 'alert', style: styles.error }),
          state.downloadUncertain && body('结果未确认，请核对状态；勿重复提交。', { role: 'alert', style: styles.warning }),
          (state.dirty || state.conflict) && body('请先保存或撤销本机同步设置更改。'))),
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
