import { createBidirectionalController, bidirectionalMessage, canRepairBinding, STORAGE_GIB, MAX_STORAGE_GIB, MAX_ONBOARDING_PROJECTS } from './bidirectional-state.mjs';

/** Native DSH React/controls are injected; this module imports no React, fetch, or storage. */
export function createBidirectionalPanel(React, { Button, Input, Checkbox, Switch, Modal }) {
  const h = React.createElement;
  const styles = {
    card: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, padding: 16, borderRadius: 'var(--dsw-radius-xl, 12px)', border: '1px solid var(--dsw-alias-settings-card-stroke)', background: 'var(--dsw-alias-settings-card-fill)', color: 'var(--dsw-alias-label-primary)' },
    column: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
    row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    between: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
    body: { margin: 0, fontSize: 13, lineHeight: '21px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
    root: { margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere', userSelect: 'text' },
    heading: { margin: 0, fontSize: 15, fontWeight: 600 },
    item: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-settings-card-stroke)' },
    list: { maxHeight: 260, overflowY: 'auto', overscrollBehavior: 'contain' },
    projectOption: { display: 'flex', flexDirection: 'column', gap: 5, width: '100%', minWidth: 0, boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid var(--dsw-alias-settings-card-stroke)', overflowWrap: 'anywhere' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 16 },
    warning: { color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' },
  };
  const labels = { idle: '空闲', scanning: '扫描中', offline: '离线待重试', uploading: '上传中', applying: '应用中', deferred: '暂缓处理', conflicted: '有冲突', blocked: '已阻止', uncertain: '结果未确认', synced: '已同步', paused: '已暂停', 'needs-login': '需要登录' };
  const body = (value, props = {}) => h('p', { style: styles.body, ...props }, value);
  const root = value => body(value, { style: styles.root });
  const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '尚无记录';
  const operationLabel = value => ({ running: '处理中…', succeeded: '已完成', failed: '未完成', uncertain: '结果未确认' })[value] ?? '等待宿主确认';
  const sameAccount = (a, b) => Boolean(a && b && a.server === b.server && a.username === b.username && a.loggedIn === b.loggedIn);

  /** Props: {connection, identity:{server,username,loggedIn}, onAuthenticationRequired?}. */
  return function BidirectionalPanel({ connection, identity, onAuthenticationRequired }) {
    const owned = React.useRef(null), identityRef = React.useRef(identity), mountEpoch = React.useRef(0), authNotice = React.useRef({ identity: '', notified: false });
    identityRef.current = identity;
    if (!owned.current || owned.current.connection !== connection) {
      owned.current?.controller.dispose();
      owned.current = { connection, controller: createBidirectionalController(connection) };
    }
    const controller = owned.current.controller, state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot), id = React.useId();
    const [workspaceSearch, setWorkspaceSearch] = React.useState(''), [projectSearch, setProjectSearch] = React.useState(''), [itemSearch, setItemSearch] = React.useState(''), [bindingSearch, setBindingSearch] = React.useState(''), [sessionSearch, setSessionSearch] = React.useState(''), [quotaDraft, setQuotaDraft] = React.useState(null);
    const quotaDraftRef = React.useRef(null);
    const stageFocus = React.useRef(null), refreshFocus = React.useRef(null), composition = React.useRef({ active: false, ended: false });
    React.useEffect(() => {
      controller.setIdentity(identityRef.current);
      const epoch = ++mountEpoch.current, stop = controller.watch();
      return () => {
        stop();
        // StrictMode's same-instance effect remount must not inherit a disposed
        // controller. Real unmount still releases it without cancelling Host jobs.
        queueMicrotask(() => { if (mountEpoch.current === epoch) controller.dispose(); });
      };
    }, [controller]);
    React.useEffect(() => {
      controller.setIdentity(identityRef.current); void controller.refresh();
      composition.current = { active: false, ended: false }; setBindingSearch(''); quotaDraftRef.current = null; setQuotaDraft(null);
    }, [controller, identity?.server, identity?.username, identity?.loggedIn]);
    const dialog = state.dialog, status = state.status, identityMatches = sameAccount(status, identity), loggedIn = identityMatches && status?.loggedIn;
    const rejectedSavedIdentity = Boolean(identity?.loggedIn && status?.loggedIn === false && status.server === identity.server && status.username === identity.username);
    const requestAuthentication = () => { try { void Promise.resolve(onAuthenticationRequired?.()).catch(() => {}); } catch { /* Read/focus failure leaves the explicit CTA available. */ } };
    React.useEffect(() => {
      const external = identityRef.current, key = JSON.stringify([external?.server, external?.username, external?.loggedIn]);
      if (authNotice.current.identity !== key) authNotice.current = { identity: key, notified: false };
      const latest = controller.getSnapshot(), current = latest.status;
      const sameSaved = current && current.server === external?.server && current.username === external?.username;
      const successfulStatusRead = !latest.error || latest.error.code === 'SYNC_UNCERTAIN';
      if (sameSaved && current.loggedIn && !latest.refreshing && successfulStatusRead) authNotice.current.notified = false;
      // This requests only the parent's account-card READ/focus action. A failed
      // callback cannot loop and no credential or login write is ever replayed.
      if (!sameSaved || !external?.loggedIn || current.loggedIn || latest.refreshing || !successfulStatusRead || authNotice.current.notified) return;
      authNotice.current.notified = true; requestAuthentication();
    }, [controller, status, state.refreshing, state.error, identity?.server, identity?.username, identity?.loggedIn, onAuthenticationRequired]);
    const locked = !state.ready || !identityMatches || Boolean(state.busy) || state.refreshing || state.uncertain;
    const canDiscover = !locked && loggedIn;
    const canAct = canDiscover && status.capability === 'supported';
    const onboarding = ['clone', 'publish'].includes(dialog?.kind);
    const selectedCount = dialog?.selectedIds?.length ?? 0;
    const storage = status?.storage, configuredGiB = storage ? storage.limitBytes / STORAGE_GIB : undefined;
    const quotaValue = quotaDraft?.value ?? (Number.isInteger(configuredGiB) && configuredGiB >= 1 && configuredGiB <= MAX_STORAGE_GIB ? String(configuredGiB) : '');
    const quotaValid = typeof quotaValue === 'string' && /^[1-9][0-9]{0,3}$/.test(quotaValue) && Number(quotaValue) <= MAX_STORAGE_GIB;
    const quotaBytes = quotaValid ? Number(quotaValue) * STORAGE_GIB : undefined;
    const quotaCurrent = Boolean(quotaDraft && status && quotaDraft.server === status.server && quotaDraft.username === status.username && quotaDraft.revision === status.revision);
    const canSaveQuota = Boolean(canAct && storage && quotaValid && quotaCurrent && quotaBytes !== storage.limitBytes);
    const editQuota = event => {
      if (!status || !storage || typeof event.target.value !== 'string') return;
      const next = { value: event.target.value, revision: status.revision, server: status.server, username: status.username };
      quotaDraftRef.current = next; setQuotaDraft(next);
    };
    const saveQuota = () => {
      const draft = quotaDraft, latest = controller.getSnapshot(), account = identityRef.current;
      if (!draft || quotaDraftRef.current !== draft || !canSaveQuota || !sameAccount(latest.status, account) || latest.status.revision !== draft.revision || latest.status.server !== draft.server || latest.status.username !== draft.username) return;
      void controller.setStorageLimit(quotaBytes).then(saved => { if (saved && quotaDraftRef.current === draft) { quotaDraftRef.current = null; setQuotaDraft(null); } });
    };
    const act = action => {
      // Even a handler captured from an old render checks the current account prop.
      if (!controller.setIdentity(identityRef.current)) return;
      void action();
    };
    React.useEffect(() => {
      if (!dialog) return;
      if (dialog.stage !== 'choose') stageFocus.current?.focus();
    }, [dialog?.kind, dialog?.stage, dialog?.plan?.id]);
    const close = () => {
      controller.closeDialog(); composition.current = { active: false, ended: false };
      queueMicrotask(() => { const target = refreshFocus.current; if (target?.isConnected && !target.disabled && target.ownerDocument.activeElement === target.ownerDocument.body) target.focus(); });
    };
    const start = action => { setWorkspaceSearch(''); setProjectSearch(''); setItemSearch(''); setSessionSearch(''); composition.current = { active: false, ended: false }; act(action); };
    const composing = event => composition.current.active || composition.current.ended || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229;
    const protectIme = event => { if (event.key === 'Escape' && composing(event)) { event.preventDefault(); event.stopPropagation(); } };
    const search = (value, setValue, label, autofocus = false) => h(Input, { type: 'search', value, onChange: event => setValue(event.target.value), 'aria-label': label, placeholder: label, autoComplete: 'off', spellCheck: false, maxLength: 1024, ...(autofocus ? { 'data-modal-autofocus': '' } : {}),
      onCompositionStart: () => { composition.current = { active: true, ended: false }; }, onCompositionEnd: () => { composition.current = { active: false, ended: true }; }, onKeyUp: () => { composition.current.ended = false; }, onBlur: () => { composition.current = { active: false, ended: false }; } });
    const matches = (row, query) => !query.trim() || `${row.label ?? row.path}\n${row.root ?? row.sourceRoot ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const visibleBindings = status?.bindings.filter(row => matches(row, bindingSearch)) ?? [];
    const binding = dialog?.bindingId ? status?.bindings.find(row => row.id === dialog.bindingId) : null;
    const workspaces = status?.workspaces.filter(row => matches(row, workspaceSearch)) ?? [], projects = state.projects.items.filter(row => matches(row, projectSearch));
    const projectNames = new Map();
    for (const row of state.projects.items) { const key = row.label.normalize('NFC').toLocaleLowerCase(); projectNames.set(key, (projectNames.get(key) ?? 0) + 1); }
    const duplicateProject = row => projectNames.get(row.label.normalize('NFC').toLocaleLowerCase()) > 1;
    const items = dialog?.items?.filter(row => matches(row, itemSearch)) ?? [], selected = dialog?.items?.find(row => row.id === dialog.selectedId), plan = dialog?.plan;
    const titles = { publish: '同步本地项目到云端', clone: '同步云端项目到本地', conflicts: '处理文件冲突', recycle: '本机回收站', archives: '会话归档', repair: '核对中断事务' };
    const reviewTitles = { publish: '确认启用双向同步', clone: '确认启用双向同步', conflicts: '确认处理冲突', recycle: '确认恢复文件', archives: '确认导入安全会话', repair: '确认修复中断事务' };
    const title = dialog?.stage === 'review' ? reviewTitles[dialog.kind] : dialog?.stage === 'legacy' ? '选择云端主要版本' : dialog?.stage === 'folder' ? '选择宿主父目录' : dialog?.stage === 'destination' ? '确认新建位置' : ['progress', 'uncertain'].includes(dialog?.stage) ? '核对同步结果' : titles[dialog?.kind] ?? '本机回收站';
    const repairReady = canAct && canRepairBinding(binding) && !dialog?.stale;
    const planReady = Boolean(canAct && plan && plan.expiresAt > Date.now() && (dialog.kind !== 'archives' || plan.eligibility === 'unchecked') && (dialog.kind !== 'repair' || repairReady));
    const itemReady = Boolean(canAct && selected && !dialog?.stale && (dialog.kind !== 'archives' || selected.state === 'available'));
    const confirmations = { publish: controller.confirmPublish, clone: controller.confirmClone, conflicts: controller.confirmResolution, recycle: controller.confirmRestore, archives: controller.confirmArchiveImport, repair: controller.confirmRepair };
    const previews = { publish: controller.planPublish, clone: controller.planClone, conflicts: controller.planResolution, recycle: controller.planRestore, archives: controller.planArchiveImport, repair: controller.planRepair };
    const confirm = () => act(() => confirmations[dialog.kind](plan));
    const planAction = () => act(() => previews[dialog.kind]());
    const idsView = ids => {
      if (!ids?.length) return null;
      const matches = ids.filter(value => !sessionSearch.trim() || value.toLowerCase().includes(sessionSearch.trim().toLowerCase()));
      return h('div', { style: styles.column }, body(`新会话 ID：${ids.length} 个（只读）`), ids.length > 100 && search(sessionSearch, setSessionSearch, '筛选新会话 ID'),
        h('ul', { style: { ...styles.body, ...styles.list }, 'aria-label': '新会话 ID' }, ...matches.slice(0, 100).map(value => h('li', { key: value }, value))),
        matches.length > 100 && body('仅显示前100个匹配 ID，请继续筛选。'));
    };
    const operationView = item => h('div', { key: item.id, style: styles.column, 'data-operation-id': item.id },
      body(operationLabel(item.state)),
      ['import', 'syncarchiveimport'].includes(item.kind) && h('div', { style: styles.column }, body(`已导入 ${item.importedCount ?? '未确认'} · 跳过 ${item.skippedCount ?? '未确认'} · 失败 ${item.failedCount ?? '未确认'}`), idsView(item.sessionIds)),
      item.errorCode && body(bidirectionalMessage(item.errorCode), { role: 'alert', style: { ...styles.body, ...styles.warning } }));
    const batchView = batch => h('div', { key: batch.id, style: styles.column, 'data-onboarding-id': batch.id },
      body(({ running: '各项目独立处理中', succeeded: '全部项目已完成', partial: '部分项目已完成', failed: '项目未完成', uncertain: '结果未确认，仅核对原请求' })[batch.state], { role: 'status', 'aria-live': 'polite' }),
      body('每个项目独立执行；失败不会回滚已完成项目，不会自动重试。'),
      batch.parent && root(`宿主父目录：${batch.parent}`),
      h('div', { style: styles.list, 'aria-label': '各项目同步结果' }, ...batch.items.map(item => h('div', { key: item.id, style: styles.item, 'data-onboarding-item': item.id },
        h('strong', null, item.label), root(item.root),
        body(({ pending: '等待处理', running: '处理中', succeeded: '已完成', failed: '未完成', uncertain: '结果未确认' })[item.state], { role: 'status' }),
        body(({ accepted: '宿主已接收', 'mkdir-started': '创建全新子目录', 'root-owned': '已确认新目录', 'migration-committing': '保留历史并迁移', 'migration-complete': '历史迁移已完成', downloading: '同步文件到本地', downloaded: '文件已同步到本地', registering: '注册新工作区', registered: '新工作区已注册', publishing: '创建云端项目并同步', paired: '双向同步已启用', complete: '本项目处理完成', interrupted: '处理已中断，请核对状态' })[item.phase] ?? '以宿主核对结果为准'),
        item.errorCode && body(bidirectionalMessage(item.errorCode), { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        item.state === 'uncertain' && body('可能已创建目录或注册工作区。不要向同一位置重复提交，仅核对原请求。', { role: 'status' })))));
    const modalFooter = dialog && h('div', { style: styles.between },
      h(Button, { type: 'button', variant: 'ghost', onClick: close }, '关闭'),
      h('div', { style: styles.row },
        (dialog.stage === 'review' || (onboarding && ['folder', 'destination', 'legacy'].includes(dialog.stage))) && h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || state.uncertain, onClick: () => controller.back() }, '返回修改'),
        dialog.stage === 'choose' && h(Button, { type: 'button', variant: 'outline', disabled: Boolean(state.busy) || state.refreshing || state.uncertain || !identity?.loggedIn, onClick: () => act(() => controller.reloadDialog()) }, dialog.kind === 'repair' ? '刷新状态' : '刷新列表'),
        dialog.stage === 'choose' && dialog.kind === 'clone' && h(Button, { type: 'button', variant: 'primary', disabled: !canDiscover || dialog.stale || !selectedCount || !state.projects.loaded, onClick: () => act(() => controller.pickCloneParent()) }, '选择宿主父目录'),
        dialog.stage === 'folder' && h(Button, { type: 'button', variant: 'primary', disabled: !canDiscover || !dialog.browser?.selectable || dialog.stale, onClick: () => act(() => controller.selectCloneParent()) }, '使用此父目录'),
        ['destination', 'legacy'].includes(dialog.stage) && h(Button, { type: 'button', variant: 'outline', disabled: !canDiscover || dialog.stale, onClick: () => act(() => controller.pickCloneParent()) }, '重新选择父目录'),
        ((dialog.stage === 'choose' && dialog.kind !== 'clone') || ['destination', 'legacy'].includes(dialog.stage)) && h(Button, { type: 'button', variant: 'primary', disabled: onboarding ? !canDiscover || dialog.stale || !selectedCount || (dialog.kind === 'clone' && (!dialog.destination || dialog.legacyChoices.some(row => !dialog.primaryLegacyIds.some(choice => choice.projectId === row.projectId)))) : dialog.kind === 'repair' ? !repairReady : !itemReady, onClick: planAction }, dialog.kind === 'archives' ? '预览导入' : '预览变更'),
        dialog.stage === 'review' && h(Button, { type: 'button', variant: 'primary', disabled: !planReady || (onboarding && plan?.summary.blocked > 0), onClick: confirm }, ({ publish: '确认并启用', clone: '确认并启用', conflicts: '确认处理', recycle: '确认恢复', archives: '确认导入新会话', repair: '确认修复并继续' })[dialog.kind]),
        ['progress', 'uncertain'].includes(dialog.stage) && h(Button, { type: 'button', variant: 'outline', disabled: Boolean(state.busy) || state.refreshing, onClick: () => act(() => controller.refresh()) }, '核对状态')));
    return h('section', { style: styles.card, 'aria-labelledby': `${id}-title`, 'aria-busy': state.refreshing || Boolean(state.busy), 'data-personal-sync': 'bidirectional' },
      h('div', { style: styles.between }, h('h3', { id: `${id}-title`, style: styles.heading }, '双向同步'),
        h(Button, { type: 'button', variant: 'ghost', ref: refreshFocus, disabled: state.refreshing || Boolean(state.busy), onClick: () => act(() => controller.refresh()) }, state.refreshing ? '读取中…' : '刷新状态')),
      body('一个双向同步：首次选择方向并预览，明确确认后持续双向同步。每批最多20个项目。'),
      h('div', { style: styles.grid, 'aria-label': '添加双向同步项目' },
        h('div', { style: styles.column, 'data-onboarding-entry': 'publish' },
          h(Button, { type: 'button', variant: 'outline', disabled: !canDiscover, onClick: () => start(() => controller.openPublish()) }, '本地项目→同步到云端'),
          body(`本地项目${identityMatches && status ? ` ${status.workspaces.length} 个` : ''} · 点击后选择；各自创建新的云端项目。`)),
        h('div', { style: styles.column, 'data-onboarding-entry': 'clone' },
          h(Button, { type: 'button', variant: 'outline', disabled: !canDiscover, onClick: () => start(() => controller.openClone()) }, '云端项目→同步到本地'),
          body('点击后读取云端列表；选择一个宿主父目录，各自新建子目录与工作区。'))),
      (!identity?.loggedIn || rejectedSavedIdentity) && h('div', { style: styles.row }, body(rejectedSavedIdentity ? '同步授权已失效，请重新登录；不会自动重发凭据。' : '请先在账号卡片登录。'), h(Button, { type: 'button', variant: 'outline', onClick: requestAuthentication }, rejectedSavedIdentity ? '重新登录' : '前往登录')),
      identity?.loggedIn && status?.capability === 'upgrade-required' && body('请升级同步服务器后使用双向同步。已有云端数据会保留，不会自动启用同步。', { role: 'status', style: { ...styles.body, ...styles.warning } }),
      identity?.loggedIn && (!state.ready || !identityMatches) && body(state.refreshing ? '正在核对账号状态…' : '状态尚未确认，请刷新。', { role: 'status' }),
      loggedIn && state.ready && status.capability === 'unknown' && body('打开本地选择器不读取云端列表；只有打开云端选择器或明确预览时才连接云端。', { role: 'status' }),
      state.error && body(state.error.message, { role: 'alert', style: { ...styles.body, ...styles.warning } }),
      state.notice && body(state.notice, { role: 'status', 'aria-live': 'polite' }),
      state.pollStopped && body('自动核对已停止；可手动刷新，不会重发未确认的写入。', { role: 'status' }),
      identityMatches && status?.warning && body(bidirectionalMessage(status.warning), { role: 'status', style: styles.warning }),
      identityMatches && status?.onboarding.length > 0 && h('details', { 'aria-label': '最近添加结果' }, h('summary', { style: styles.body }, `最近添加结果（${status.onboarding.length} 批）`),
        ...status.onboarding.slice(-10).reverse().map(batch => h('div', { key: batch.id, style: styles.item }, body(`${batch.kind === 'clone' ? '云端→本地' : '本地→云端'} · ${batch.items.length} 个项目 · ${({ running: '处理中', succeeded: '已完成', partial: '部分完成', failed: '未完成', uncertain: '结果未确认' })[batch.state]}`),
          h(Button, { type: 'button', variant: 'ghost', disabled: Boolean(state.busy) || !state.ready, 'aria-label': `查看 ${batch.items.length} 个项目的批次结果 ${batch.id}`, onClick: () => start(() => controller.openOnboardingStatus(batch.id)) }, '查看批次结果')))),
      identityMatches && status?.bindings.length === 0 && body('尚未配对项目'),
      identityMatches && status?.bindings.length > 20 && search(bindingSearch, setBindingSearch, '搜索已配对项目'),
      identityMatches && status?.bindings.length > 0 && visibleBindings.length === 0 && body('没有匹配的配对项目'),
      identityMatches && h('div', { style: { ...styles.list, maxHeight: 460 }, 'aria-label': '已配对项目' }, ...(visibleBindings.slice(0, 200).map(row => h('div', { key: row.id, style: styles.item, 'data-binding-id': row.id },
        h('div', { style: styles.between }, h('strong', { style: { fontSize: 14 } }, row.label), h('span', { role: 'status', 'aria-live': 'polite' }, labels[row.state])),
        root(row.root), body(`待上传 ${row.pendingUpload} · 待下载 ${row.pendingDownload} · 冲突 ${row.conflicts} · 回收 ${row.recycleCount}`),
        body(`会话归档 ${row.archives} · 延后 ${row.skippedArchives}`),
        (row.warningCode || row.skippedArchives > 0) && body(bidirectionalMessage(row.warningCode ?? 'SYNC_ARCHIVES_SKIPPED'), { role: 'status', style: { ...styles.body, ...styles.warning } }),
        h('div', { style: styles.between },
          h(Switch, { checked: row.enabled, label: `${row.label} 自动同步`, disabled: !state.ready || !identityMatches || Boolean(state.busy) || (!row.enabled && !canAct), onChange: enabled => act(() => controller.setEnabled(row.id, enabled)) }),
          h('div', { style: styles.row },
            h(Button, { type: 'button', variant: 'outline', disabled: !canAct || status.running, 'aria-label': `同步 ${row.label}`, onClick: () => act(() => controller.run(row.id)) }, '立即同步'),
            h(Button, { type: 'button', variant: 'ghost', disabled: !canAct || !row.conflicts, 'aria-label': `处理 ${row.label} 的冲突`, onClick: () => start(() => controller.openConflicts(row.id)) }, '冲突'),
            h(Button, { type: 'button', variant: 'ghost', disabled: !canAct || !row.recycleCount, 'aria-label': `打开 ${row.label} 的回收站`, onClick: () => start(() => controller.openRecycle(row.id)) }, '回收站'),
            row.archives > 0 && h(Button, { type: 'button', variant: 'ghost', disabled: !canAct, 'aria-label': `查看 ${row.label} 的会话归档`, onClick: () => start(() => controller.openArchives(row.id)) }, '会话'),
            canRepairBinding(row) && h(Button, { type: 'button', variant: 'outline', disabled: !canAct, 'aria-label': `核对 ${row.label} 的中断事务`, onClick: () => start(() => controller.openRepair(row.id)) }, '核对中断事务'))),
        row.errorCode && body(bidirectionalMessage(row.errorCode), { role: 'alert', style: { ...styles.body, ...styles.warning } }),
        h('details', null, h('summary', { style: styles.body }, '最近状态'), body(`检查：${when(row.lastCheckedAt)}`), body(`同步：${when(row.lastSyncedAt)}`),
          ...status.operations.filter(item => item.bindingId === row.id && ['import', 'syncarchiveimport'].includes(item.kind)).slice(-3).map(operationView)))))),
      identityMatches && visibleBindings.length > 200 && body('仅显示前200个配对项目，请继续搜索。'),
      body('删除与替换保留恢复记录，不自动清理；会话日志仅归档，不自动导入、恢复运行或启动代理。'),
      identityMatches && storage && h('details', { 'aria-label': '存储上限', 'data-personal-sync': 'storage-limit' },
        h('summary', { style: styles.body }, '存储上限'),
        h('div', { style: { ...styles.column, paddingTop: 12 }, 'aria-busy': state.busy === 'syncsettings' },
          body(`本机配置档案共享上限：${configuredGiB} GiB`),
          body(`最近核对使用：${storage.verified && storage.usedBytes !== undefined ? `${storage.usedBytes / STORAGE_GIB} GiB` : '尚未核对'}`),
          body('包含队列、归档缓存和回收副本；达到上限暂停，不自动删除。', { id: `${id}-quota-help` }),
          h('label', { style: styles.column, htmlFor: `${id}-quota` }, '新的上限（GiB，1–1024 整数）',
            h(Input, { id: `${id}-quota`, type: 'number', inputMode: 'numeric', min: 1, max: MAX_STORAGE_GIB, step: 1, value: quotaValue, disabled: !canAct, autoComplete: 'off',
              'aria-label': '存储上限 GiB', 'aria-describedby': `${id}-quota-help`, 'aria-invalid': Boolean(quotaDraft && !quotaValid), onChange: editQuota })),
          quotaDraft && !quotaValid && body('请输入 1–1024 的整数 GiB，不接受小数或自动换算。', { role: 'alert', style: { ...styles.body, ...styles.warning } }),
          quotaDraft && !quotaCurrent && body('状态已变更，请重新输入上限后再保存。', { role: 'status' }),
          h('div', { style: styles.row }, h(Button, { type: 'button', variant: 'outline', disabled: !canSaveQuota, onClick: saveQuota }, state.busy === 'syncsettings' ? '保存中…' : '保存上限')),
          body('仅调整本机共享软上限，不选择或上传项目、不清理内容，也不改变文件和清单的硬限制。'))),
      h(Modal, { open: Boolean(dialog), onClose: close, title, closeLabel: '关闭', footer: modalFooter, onKeyDownCapture: protectIme },
        dialog && h('div', { style: styles.column, ref: stageFocus, tabIndex: -1, ...(dialog.stage !== 'choose' ? { 'data-modal-autofocus': '' } : {}) },
          onboarding && dialog.stage === 'choose' && h('div', { style: styles.column },
            body(`已选择 ${selectedCount} / ${MAX_ONBOARDING_PROJECTS} 个项目`, { role: 'status', 'aria-live': 'polite' }),
            dialog.kind === 'publish' ? h('div', { style: styles.column },
              body('每个本地项目创建新的独立云端项目；不关联已有云端项目。'), search(workspaceSearch, setWorkspaceSearch, '搜索本机工作区', true),
              h('div', { style: styles.list, role: 'group', 'aria-label': '本机工作区列表' }, ...workspaces.slice(0, 100).map(row => {
                const bound = status.bindings.some(binding => binding.workspaceId === row.id), checked = dialog.selectedIds.includes(row.id);
                return h('div', { key: row.id, style: styles.item, 'data-local-workspace-id': row.id },
                  h(Checkbox, { checked, label: row.label + (bound ? ' · 已启用双向同步' : row.available ? '' : ' · 不可用'), disabled: !canDiscover || dialog.stale || !row.available || bound || (!checked && selectedCount >= MAX_ONBOARDING_PROJECTS), onChange: selected => act(() => controller.selectOnboarding(row.id, selected)) }), root(row.root));
              })),
              !workspaces.length && body('没有匹配的工作区；请先在 DSH 中添加工作区。'), workspaces.length > 100 && body('仅显示前100项，请继续搜索。')) : h('div', { style: styles.column },
              body('已有云端内容会保留；每个项目必须新建本地子目录和工作区，不关联已有工作区。'), search(projectSearch, setProjectSearch, '搜索云端项目', true),
              h('div', { style: { ...styles.list, ...styles.column, gap: 8 }, role: 'group', 'aria-label': '云端项目列表' }, ...(state.projects.loaded ? projects : []).slice(0, 100).map(row => h('div', { key: row.projectId, style: styles.projectOption, 'data-cloud-project-id': row.projectId },
                h(Checkbox, { checked: dialog.selectedIds.includes(row.projectId), label: row.label, disabled: !canDiscover || dialog.stale || !state.projects.loaded || status.bindings.some(binding => binding.projectId === row.projectId) || (!dialog.selectedIds.includes(row.projectId) && selectedCount >= MAX_ONBOARDING_PROJECTS), onChange: selected => act(() => controller.selectOnboarding(row.projectId, selected)) }),
                status.bindings.some(binding => binding.projectId === row.projectId) && body('已在本机启用双向同步，请在已有配对中管理。'),
                row.sourceRoot && root(`来源：${row.sourceRoot}`),
                row.checkpointCount !== undefined && root(`已保存 ${row.checkpointCount} 个版本${row.latestCreatedAt ? ` · 最近 ${when(row.latestCreatedAt)}` : ''}`),
                duplicateProject(row) && h('details', null, h('summary', { style: styles.root }, '区分同名项目'), root(`项目标识：${row.projectId}`))))),
              state.projects.loaded && !projects.length && body('暂无匹配的云端项目。'), projects.length > 100 && body('仅显示前100项，请继续搜索。'), state.projects.partial && body('部分云端项目读取失败，请刷新核对。', { role: 'alert' }))),
          dialog.kind === 'clone' && dialog.stage === 'folder' && dialog.browser && h('div', { style: styles.column },
            body(`为 ${selectedCount} 个项目选择一个宿主父目录。浏览和选择均不创建目录。`), root(dialog.browser.path),
            h('nav', { style: styles.row, 'aria-label': '宿主目录位置' }, ...dialog.browser.crumbs.map(node => h(Button, { key: node.id, type: 'button', variant: 'ghost', disabled: !canDiscover, onClick: () => act(() => controller.browseCloneParent(node.id)) }, node.label))),
            search(itemSearch, setItemSearch, '筛选宿主子目录'),
            h('div', { style: styles.list, 'aria-label': '宿主子目录列表' }, ...dialog.browser.directories.filter(node => matches(node, itemSearch)).slice(0, 100).map(node => h('div', { key: node.id, style: styles.item },
              h(Button, { type: 'button', variant: 'outline', disabled: !canDiscover, 'aria-label': `进入宿主目录 ${node.label}`, onClick: () => act(() => controller.browseCloneParent(node.id)) }, node.label)))),
            !dialog.browser.selectable && body('当前位置不可用，请进入可用目录或重新选择。', { role: 'status' }),
            (dialog.browser.truncated || dialog.browser.directories.length > 100) && body('目录列表有数量限制；可筛选已返回目录或进入更具体的位置。')),
          dialog.kind === 'clone' && ['destination', 'legacy'].includes(dialog.stage) && dialog.destination && h('div', { style: styles.column },
            body('已选择宿主父目录（只读）：'), root(dialog.destination.parent), body('每个项目使用以下全新子目录；尚未创建目录或注册工作区。'),
            h('div', { style: styles.list, 'aria-label': '计划新建目录' }, ...dialog.destination.items.map(item => h('div', { key: item.projectId, style: styles.item }, h('strong', null, item.label), root(item.root)))),
            dialog.stage === 'legacy' && h('div', { style: styles.column, 'aria-label': '云端主要版本' }, body('以下项目存在不同分支，请逐项选择主要版本。其余差异和历史内容仍保留，不将缺少文件当作删除。'),
              ...dialog.legacyChoices.map(project => h('div', { key: project.projectId, style: styles.column, role: 'group', 'aria-label': `${project.label} 的主要版本` }, h('strong', null, project.label),
                ...project.heads.map(head => h(Checkbox, { key: head.id, checked: dialog.primaryLegacyIds.some(choice => choice.projectId === project.projectId && choice.checkpointId === head.id), label: head.label, disabled: !canDiscover, onChange: checked => { if (checked) act(() => controller.selectCloneLegacy(project.projectId, head.id)); } })))))),
          ['conflicts', 'recycle'].includes(dialog.kind) && dialog.stage === 'choose' && h('div', { style: styles.column },
            binding && h('div', null, body(binding.label), root(binding.root)), search(itemSearch, setItemSearch, dialog.kind === 'conflicts' ? '搜索冲突文件' : '搜索回收文件', true),
            dialog.kind === 'conflicts' && body('默认保留双方。先预览目标文件，再明确确认；不提供自动文本合并。'),
            h('div', { style: styles.list, role: 'group', 'aria-label': dialog.kind === 'conflicts' ? '冲突文件列表' : '回收文件列表' }, ...items.slice(0, 100).map(item => h('div', { key: item.id, style: styles.item },
              h(Checkbox, { checked: dialog.selectedId === item.id, label: item.path, disabled: !canAct || dialog.stale, onChange: checked => { if (checked) act(() => dialog.kind === 'conflicts' ? controller.selectConflict(item.id) : controller.selectRecycle(item.id)); } }),
              dialog.kind === 'recycle' && body(`${item.reason === 'deleted' ? '已删除' : '已替换'} · ${item.size} 字节`)))),
            dialog.loaded && !items.length && body('没有匹配的记录'), items.length > 100 && body('仅显示前100项，请继续搜索。'),
            dialog.kind === 'conflicts' && selected && h('div', { style: styles.column, role: 'group', 'aria-label': '冲突处理方式' },
              ...selected.variants.map(variant => body(`${variant.label} · ${variant.deleted ? '删除版本' : `${variant.size} 字节`}`, { key: variant.id })),
              ...[['both', '保留双方（默认）'], ['local', '采用本机版本'], ['remote', '采用云端版本']].map(([choice, label]) => h(Checkbox, { key: choice, checked: dialog.choice === choice, label, disabled: !itemReady, onChange: checked => { if (checked) act(() => controller.setConflictChoice(choice)); } })))),
          dialog.kind === 'archives' && dialog.stage === 'choose' && h('div', { style: styles.column },
            binding && h('div', null, body(binding.label), root(binding.root), !binding.enabled && body('文件自动同步已暂停；查看或导入会话不会启用文件同步。')),
            body('归档不等于全部可续接。仅在明确确认后，将支持的安全会话导入为新 ID；不启动任务。'),
            dialog.counts && body(`归档 ${dialog.counts.total} · 已导入 ${dialog.counts.imported} · 未确认 ${dialog.counts.uncertain}`),
            search(itemSearch, setItemSearch, '搜索会话归档', true),
            h('div', { style: styles.list, role: 'group', 'aria-label': '会话归档列表' }, ...items.slice(0, 100).map(item => h('div', { key: item.id, style: styles.item },
              item.state === 'available' ? h(Checkbox, { checked: dialog.selectedId === item.id, label: item.label, disabled: !canAct || dialog.stale, onChange: checked => { if (checked) act(() => controller.selectArchive(item.id)); } }) : h('strong', { style: styles.heading }, item.label),
              body(`会话 ${item.sessions} · 资源 ${item.assets} · ${item.state === 'available' ? '可预览，支持情况待检查' : item.state === 'imported' ? '已处理，不重复导入' : '结果未确认，不重复导入'}`),
              idsView(item.sessionIds)))),
            dialog.loaded && !items.length && body('没有匹配的归档'), items.length > 100 && body('仅显示前100项，请继续搜索。'),
            ...(status?.operations.filter(item => item.bindingId === dialog.bindingId && ['import', 'syncarchiveimport'].includes(item.kind)).slice(-3) ?? []).map(operationView)),
          dialog.kind === 'repair' && dialog.stage === 'choose' && h('div', { style: styles.column },
            binding && h('div', null, body(binding.label), root(binding.root)),
            body('先核对中断事务。仅在安全时补回缺失的主文件；保留新的本机修改和旧备份。冲突需另行处理，其余文件可继续同步。'),
            body('预览与关闭窗口均不写入文件，修复不会丢弃旧备份。'),
            !canRepairBinding(binding) && body('当前状态不允许修复。请刷新核对，不会自动启用同步或修复根目录/授权异常。', { role: 'alert' })),
          dialog.stage === 'review' && plan && h('div', { style: styles.column },
            onboarding && h('div', { style: styles.column },
              body(`${plan.items.length} 个项目 · 确认后逐项启用持续双向同步；并非整批原子操作。`),
              dialog.kind === 'clone' ? h('div', null, body('一个宿主父目录，每个项目创建全新子目录和工作区；不关联已有工作区。'), root(plan.parent)) : body('每个本地项目创建全新云端项目，再启用持续双向同步。'),
              h('div', { style: styles.list, 'aria-label': '各项目变更预览' }, ...plan.items.map(item => h('div', { key: item.projectId, style: styles.item }, h('strong', null, item.label), root(item.root),
                body(`上传 ${item.summary.upload} · 下载 ${item.summary.download} · 删除 ${item.summary.delete} · 冲突 ${item.summary.conflicts} · 阻止 ${item.summary.blocked}`),
                item.migrationRequired && body('此项目的历史内容会保留。连接后以双向状态为准，旧客户端将不能再向此项目追加备份。')))),
              body(`合计：上传 ${plan.summary.upload} · 下载 ${plan.summary.download} · 删除 ${plan.summary.delete} · 冲突 ${plan.summary.conflicts} · 阻止 ${plan.summary.blocked}`, { 'aria-label': '批次变更摘要' }),
              plan.summary.blocked > 0 && body('存在阻止项，不能启用。请返回处理后重新预览。', { role: 'alert' }),
              body('每个项目独立报告结果；部分失败不会回滚已完成的项目。未跟踪文件不视作删除，有冲突时保留副本。')),
            dialog.kind === 'conflicts' && h('div', { style: styles.column }, root(plan.root), body(plan.summary),
              body(`选择：${({ both: '保留双方', local: '本机版本', remote: '云端版本' })[plan.choice]}`),
              h('ul', { style: { ...styles.body, ...styles.list }, 'aria-label': '冲突处理目标' }, ...plan.paths.map((name, index) => h('li', { key: index }, name)))),
            dialog.kind === 'recycle' && h('div', { style: styles.column }, body('恢复到以下位置，不覆盖现有内容：'), root(plan.target)),
            dialog.kind === 'archives' && h('div', { style: styles.column }, body(plan.label), root(plan.root),
              body(`会话 ${plan.counts.sessions} · 事件 ${plan.counts.events} · 资源 ${plan.counts.assets} · 文件 ${plan.counts.files}`),
              body('仅导入支持的安全会话为新 ID，不启动任务；归档不等于全部可续接。格式与支持情况将在导入时检查，预览数量不是可续接保证。'),
              plan.eligibility !== 'unchecked' && body(plan.eligibility === 'imported' ? '此归档已有导入记录，仅核对新 ID，不允许重复导入。' : '此归档导入结果未确认，可能已有新会话；仅核对 ID，不允许重复导入。', { role: 'alert' }),
              idsView(plan.sessionIds)),
            dialog.kind === 'repair' && h('div', { style: styles.column }, root(plan.root),
              body(`可安全补回 ${plan.summary.restore} · 保留冲突 ${plan.summary.conflicts} · 未改变 ${plan.summary.unchanged}`),
              body('仅安全补回缺失主文件；保留新修改和旧备份，冲突需另行解决，其余文件继续同步。'),
              body(`涉及 ${plan.paths.length} 条路径`), plan.paths.length > 100 && search(itemSearch, setItemSearch, '筛选待核对路径'),
              h('ul', { style: { ...styles.body, ...styles.list }, 'aria-label': '待核对路径' }, ...plan.paths.filter(name => !itemSearch.trim() || name.toLowerCase().includes(itemSearch.trim().toLowerCase())).slice(0, 100).map(name => h('li', { key: name }, name))),
              plan.paths.length > 100 && body('仅显示前100条匹配路径，可继续筛选。此输入仅筛选，不更改修复目标。')),
            body('删除与替换保留恢复记录，不自动清理。会话日志仅归档；安全会话需单独确认导入，不自动导入或启动代理。'),
            body('预览不写入文件；只有下方明确确认才提交。')),
          ['progress', 'uncertain'].includes(dialog.stage) && h('div', { style: styles.column },
            body(dialog.stage === 'uncertain' ? '结果未确认，请核对状态；不会重发写入。' : '已提交至宿主，可关闭窗口。关闭不会取消已提交操作。', { role: 'status', 'aria-live': 'polite' }),
            onboarding && (dialog.batch ? batchView(dialog.batch) : h('div', { style: styles.column }, body('宿主尚未返回逐项结果，仅核对原请求；不会自动生成新请求或重新提交。'),
              h('div', { style: styles.list, 'aria-label': '等待核对的项目' }, ...(dialog.submittedItems ?? []).map(item => h('div', { key: item.projectId, style: styles.item }, h('strong', null, item.label), root(item.root), body('等待宿主确认')))))),
            ...(!onboarding ? status?.operations.filter(item => item.id === dialog.operationId || (dialog.bindingId && item.bindingId === dialog.bindingId)) ?? [] : []).map(operationView)),
          dialog.message && body(dialog.message, { role: 'status' }),
          dialog.stale && body('状态已变更，请刷新列表后重新预览。', { role: 'status' }),
          state.busy && body('处理中…', { role: 'status' }),
          dialog.error && body(dialog.error.message, { role: 'alert', style: { ...styles.body, ...styles.warning } }))));
  };
}
