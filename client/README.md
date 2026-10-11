# 个人云同步：DSH 原生 Web 设置页

## 发布接入

生产入口是 [Client 入口](<dist/client.js>)。它不是浏览器 ESM 入口，而是 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 模块；模块 ID 必须与包名 `dsh-personal-sync` 一致。

主包配置：

```json
{
  "exports": {
    "./client": "./client/dist/client.js"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-connection"
      ]
    }
  }
}
```

保留主包原有 Host exports、bundle patch 与其他 manifest 字段，并将客户端产物加入发布白名单。构建使用 [构建脚本](<../scripts/build-client.mjs>)，无安装或下载依赖：

```powershell
node scripts/build-client.mjs
```

运行时插件 `inject` 是 `['slots', 'connection']`；通过 `ctx.slots.inject('settings.section', ...)` 与 `ctx.slots.register()` 注册 `id: 'dsh-personal-sync'`、导航标题“个人云同步”。不修改 Web 壳。安装并启用插件后刷新当前 DSH 页面，在设置导航进入“个人云同步”；填写已部署的同步服务器源地址、账号、密码，明确选择宿主项目并保存。自动同步默认关闭。

## 已核实的安装 SDK

只读检查了当前安装的 ASAR **归档**，不是假设它是可进入的目录：

- 安装的 Desktop、DSH、Client Connection、UI Settings、UI Primitives 均为 **0.2.0-rc.2**。
- Desktop build commit：`04f392c9ddd144fa426da2045178797da6db6c11`，`dshBuildDirty: false`。
- 当前 UI 实际使用 **React**，不是 Vue。适配器只调用宿主模块加载器的 `require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')`，复用原生 `Button`、`Input`、`Checkbox`、`Switch`、`Modal`。发布产物不含独立 React/Vue 副本。
- 原生浏览器 `ctx.connection` 有 `rpc.call(channel, endpoint, payload, signal)`，**没有 `fetch` 方法**。普通浏览器和 Desktop 可由 DSH 选择不同 carrier，因此不能自己拼 localhost 地址或直接访问同步服务器。

仅新建了研究目录 `.inspection/ui-research-new/`，没有覆盖旧 SDK、读取凭据/真实会话、改安装或 profile，也没有起替代 GUI 服务器。研究目录不属于发布内容。

## Host 契约

生产页面所有操作均使用：

```js
ctx.connection.rpc.call('/api', 'dsh-personal-sync/' + action, payload, signal)
```

Host 通过 `/api/dsh-personal-sync/{action}` exact Fetch routes 接入，每个 action **只支持 POST**，包括 `status`，并支持原生 Connection envelope。当前原生 bridge 的 streaming 路由不保留 GET 兼容入口；生产页面始终经 Connection RPC，不直接 `fetch`。

请求/响应的 envelope 由 DSH Connection 与 Host 路由对接：

```js
// request
{ type: 'client-request', rpcId, method: 'dsh-personal-sync/status', payload: {} }
// HTTP 200 business success
{ type: 'server-response', rpcId, result: { ok: true, value: status } }
// HTTP 200 business error
{ type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: {} } } }
```

Host/Origin 与 DSH 浏览器会话验证发生在 exact route 分派之前；其 HTTP 401/403 拒绝不被绕过。不能注册第二个 `/api` RPC interceptor，因为 Gateway 已占用唯一 interceptor。

| action | payload | value |
| --- | --- | --- |
| `status` | `{}` | 公共状态 |
| `login` | `{server, username, password}` | 公共状态，不含 token/password |
| `password` | `{revision, server, username, currentPassword, newPassword}` | 公共状态，成功后 `loggedIn:false`、`autoSync:false`，可带 `passwordChanged:true` |
| `preferences` | `{revision, autoSync, projectIds}` | 新公共状态 |
| `sync` | `{}` 或 `{projectId: 本机宿主项目ID}` | `{scheduled:true}`，亦兼容公共状态 |
| `logout` | `{}` | 公共状态，可带 `warning` |
| `projects` | `{revision, server, username}` | `{projects:[{projectId, label, sourceRoot?, checkpointCount, latestCreatedAt}], partial?, legacy?}` |
| `checkpoints` | 上述身份绑定 + `{projectId}` | `{checkpoints:[{id, projectId, deviceId, parentId, createdAt, fileCount, totalBytes}], heads:[ID]}` |
| `destinationpick` | 上述身份绑定 + `{projectId, checkpointId}` | `{destination:Plan}`、`{browser:Browser}` 或 `{cancelled:true}` |
| `destinationbrowse` | 上述身份绑定 + `{browserId, nodeId}` | `{browser:Browser}` |
| `destinationselect` | 上述身份绑定 + `{browserId, nodeId}` | `{destination:Plan}` |
| `restore` | 上述身份绑定 + `{projectId, checkpointId, destinationId, confirm:true, requestId}` | `{recovery}`，接受后异步下载；旧 `destination` 字符串保留兼容但新界面不发送 |
| `import` | 上述身份绑定 + `{restoreId, confirm:true, requestId}` | `{recovery}`，单次恢复或当前批次成功项的显式导入 |
| `downloadpick` | 上述身份绑定 + `{latest:true,items:[{projectId}]}` | `{latest:true,parent,destinations}`、`{latest:true,browser}` 或 `{cancelled:true}` |
| `downloadbrowse` | 上述身份绑定 + `{latest:true,browserId,nodeId}` | `{latest:true,browser}`，只接受同模式批次句柄 |
| `downloadselect` | 上述身份绑定 + `{latest:true,browserId,nodeId}` | `{latest:true,parent,destinations}`，目标固定，内容在开始时取最新 |
| `downloadstart` | 上述身份绑定 + `{latest:true,items:[{projectId,destinationId}],requestId,confirm:true}` | `{download:DownloadStatus}`，其中 `download.latest:true` |
| `updatestatus` | `{}` | `{update}`，只读本机状态，不请求 GitHub |
| `checkupdate` | `{}` | `{update}`，显式检查固定仓库版本 |
| `installupdate` | `{candidateId, requestId, confirm:true}` | `{update}`，原生安装接受后异步执行 |
| `cancelupdate` | `{requestId}` | `{update}`，只请求取消本插件自己的安装 |

公共状态：

```js
{
  revision, server, username, loggedIn, expiresAt?, autoSync, intervalMs,
  projects: [{ id, label, root, selected, available, projectId?, warning? }],
  pending, running, lastResult?: { at, ok, message }, warning?,
  recovery?: {
    id, kind: 'restore' | 'import', state: 'running' | 'succeeded' | 'failed', root,
    checkpointId?, sessionCount?, importedCount?, skippedCount?, failedCount?, errorCode?,
    sessions?: [{sourceId, sessionId?, outcome: 'imported' | 'skipped' | 'failed', workspaceAttached?}]
  }
}
```

`projectIds` 是宿主列举的本机 opaque ID，不是云端 `projectId`，更不是任意路径。前端只把 `root` 作为文本显示；Host 才是权限边界。已选择但失踪的项目可取消，不能新增勾选。`CONFIG_CONFLICT` 禁止盲目重试；刷新重新读取 revision 并重新选择后才能保存。

## 0.3.0 改密与简洁界面

设置页只保留字段、操作按钮、项目路径和必要状态，移除了常驻教程、安全段落、冗余 tooltip 和长退出说明。操作错误和结果用简短中文显示。

“修改密码”使用原生 Modal 和三个 uncontrolled password 输入：当前密码、新密码、确认新密码。自 0.3.1 起，新密码按 Unicode codepoints 检查至少 8 位，并限制 1024 个 UTF-8 字节；不 trim。确认新密码仅在本地比较，不发送。弹窗绑定打开时保存的 server/username/revision，不能把尚未登录的新地址当成改密目标。

Host 会验证当前密码，成功后撤销云端所有旧 token、退出本机登录并关闭自动同步。Client 只显示“密码已修改，请重新登录”，不会自动重复改密。旧服务由 Host 无秘密 capability probe 检出，显示升级提示；若 probe 已失败则未发出改密，保留有效登录。

超时/取消/未知结果仅触发一次只读 status 校验，并锁定未确认的登录/自动同步，旧 `loggedIn:true` 回包不能重新启用上传；显式登录成功后解除。所有密码框在提交、取消、离开表单、身份或 revision 变化及卸载时清空。

## 0.3.2 紧凑账号与项目管理

- 已登录时仅显示宿主确认的用户名、登录状态和改密/退出操作，不挂载服务器、账号、密码输入及登录表单。退出、过期或改密要求重登时恢复表单；登录状态切换也会立即清空秘密。
- “同步项目”主卡只显示已选项目数量和最多 3 个名称，超出显示剩余数量；未选项目和路径不平铺。右侧“管理”打开原生 **管理同步项目** Modal，搜索、全选/取消、复选框及项目路径只在打开时挂载。仍是同步项目白名单，不是排除列表。
- 选择修改使用原有 controller draft。“关闭”（含关闭按钮/遮罩/Escape）仅收起管理器，保留草稿并在主卡显示“未保存”，不会隐式保存/上传；“保存”成功后关闭，失败留在弹窗显示安全错误。保存期间不允许关闭，revision 冲突/状态未知可在弹窗内刷新。
- 自动同步开关、全局保存/撤销和立即同步位于“同步状态”卡。运行中仍可取消项目/关闭自动同步后保存；有未保存草稿时不能立即同步。主页面撤销更改会恢复已保存的项目与自动同步设置。
- 复用宿主 Modal 的焦点约束、Escape 和焦点恢复。搜索框使用 `data-modal-autofocus`，不自行实现对话框或创建第二套 React；主题样式沿用宿主变量。此界面调整不修改 Host RPC、云端接口或 8 位密码策略。

## 0.4.0 云端下载

- “云端下载”提供云端项目、检查点与显式下载确认。0.6.0 已把最初的手填 ID/绝对路径改为具名项目文件夹和宿主目标选择；冲突分支仍需明确选择，远端 sourceRoot 不能授权本机绝对写入位置。
- 只读浏览不授权上传；无需选择任何本机同步项目。浏览数据与确认意图绑定保存的 server/username/revision，身份或版本变化后失效。远端响应只保留已验证字段，额外秘密字段不会进入状态。
- 下载不是浏览器文件保存：目标在 DSH Host 机器，必须是不存在的新目录且父目录存在。Host 拒绝受保护目录、已注册工作区内目录、已有目录和跳转路径。
- `restore/import` 返回任务状态后由 Host 继续执行。页面轮询 `status.recovery`，关闭页面只停止轮询，同一登录下重新打开读取已有结果；任务记录仅存于本次插件生命周期，不会带到新登录。超时/断线先读取状态，不自动重放写操作；请先检查已有目录和新会话。
- 下载成功只保存项目文件与档案。用户检查后再确认“导入安全会话”，仅导入支持的安全子集为新 ID，不启动 agent、不自动勾选上传。部分失败、跳过或 workspace 挂载失败需人工核对，页面显示计数和会话 ID，不能用“已归档”等同于“全部可续接”。
- 导入只接受当前成功恢复的 `restoreId`。插件重启后的旧恢复目录仍可检查后使用 `/sync-import`，不是让浏览器提交任意目录读取。上传/自动同步的原有语义不变，不包含自动拉取或冲突合并。

## 0.5.0 可选原生更新入口

设置页增加“插件更新”卡和确认弹窗，复用原生 Button/Input/Modal 等现有控件。检查更新独立于个人同步登录：页面打开只读取本机 `update` 状态，不自动请求 GitHub。用户点击检查后，Host 查询固定仓库默认分支，取得新稳定版本与固定提交；前端不能提交任意 URL/spec/registry/路径或脚本批准。

`UpdateStatus` 是普通 `status.update` 与四个更新 RPC 的公共值：

```js
{
  currentVersion, installedVersion?, supported, restartRequired,
  state: 'idle' | 'checking' | 'available' | 'up-to-date' | 'installing' |
    'cancelling' | 'restart-required' | 'cancelled' | 'failed' | 'uncertain',
  candidate?: {id, version, commit, checkedAt}, requestId?, errorCode?
}
```

- 确认意图绑定候选 ID、版本、40 位提交与当前运行版本，只发送 `{candidateId,requestId,confirm:true}`。重复点击、陈旧回调或检查后分支移动不会换成另一个未确认版本。
- 实际替换仅调用当前 profile 的原生 `pluginManager.installBundle`，服务缺失时仅更新功能不可用。运行版本与已安装版本分开显示；完整重启 DSH 前不能显示新版已经运行。
- `installing/cancelling` 轮询本机更新状态，即使未登录同步账号也可观察。关闭页面不会自动取消安装；重新打开通过普通状态获知任务。未知回包不重发安装，自动只读核对有界，用户仍可手动刷新。
- 更新期间锁定其他写操作；原生安装启动后的失败/取消/未知结果同样可能需要重启，不能靠刷新 UI 清除屏障。安装结束后仍允许退出同步账号。确认框说明需要完整重启 DSH 再刷新，不自动重启或更新服务器。
- 错误只呈现本地安全映射；构建脚本批准和兼容拒绝交回原生 Plugins，不能借此绕过批准或关闭检查。不会把原生安装日志、环境变量、诊断路径或同步凭据回传浏览器。
- 首次仍需安装含更新入口的 0.5.0；后续需维护者递增稳定版本并把预构建 Client 一起推送到固定仓库默认分支。这不是 GitHub Releases 检查，也不是同版本强制重装工具。

主测试使用合成 Connection、原生控件对象树与 native manager mock，元数据响应也为合成。已只读核对 rc.2 的 manager/可选 `ctx.get`/安装生命周期契约，但没有运行真实 pnpm 安装、修改真实 profile 或验收实际 GUI 更新。

## 0.6.0 简洁布局与文件夹选择

更新卡位于所有主设置卡片最后，只显示版本、状态和单个操作：`检查更新 → 手动更新`。更新中/待重启时仍只有该按钮的禁用状态，移除常驻来源/安全说明、独立核对/取消按钮；页面顶部刷新继续核对结果。确认弹窗仅显示版本变化和重启要求，内部候选/提交绑定、原生批准与重启屏障不变。

下载弹窗只保留项目文件夹、检查点、保存位置、操作及条件结果，不显示常驻教程。项目 ID 仍是内部身份，但不能手填；路径只读展示，不挂载目标路径输入框。文件夹名称来自校验过的清单，源路径只作显示；旧目录接口缺名称时补读检查点，缺整个目录接口时仅回查已有绑定，无法枚举的新设备提示升级服务。

可选 Host `directoryPicker` 经 `ctx.get` 获取：`capability().kind === 'native'` 调用 `pick(signal)`，`browse` 调用 `list(undefined|已发放路径, signal)`。没有挂载第二个 Gateway，也不调用浏览器 `showDirectoryPicker` 或宿主 `createDirectory`。browse 在原生 Modal 中呈现受限文件夹/导航，选择请求只有已发放的 ID：

```js
Plan = {id, root, parent}
Browser = {id, path, currentId, crumbs:[{id,label}], directories:[{id,label}], selectable, truncated}
```

Host 把选定的真实父目录转为短期计划，自动建议不存在的新子目录（冲突时使用安全兄弟名称），确认前不创建目录。Client 新流程只发送 `destinationId`，显示的最终路径不会反向授权任意路径。取消原生选择保留此前有效选择；变更项目/检查点/账号/revision 或更新门禁会清空计划并取消选择请求，关闭页面也中止尚未完成的选择。已经接受的下载仍按原有 Host 异步任务规则继续，不混淆两者。

计划与原生 provider、登录凭据、本机父目录身份及检查点绑定；重新校验链接、保护目录与 inode。15 分钟有效期只限制新任务准入，不中断已接受的长下载；同一请求重试返回已记录结果，不能重做文件写入。目录选择 SDK 契约已只读核实，测试仍是 mock 原生能力 + 真实 loopback 云服务，未验证真实系统对话框或实际 GUI 视觉。

## 0.7.0 选择式下载管理与 Host 批次（历史固定模式）

以下固定版本字段继续供旧客户端/高级接口兼容；当前图形界面已由下一节的 0.8.0 最新内容模式取代，不再提供版本选择。

下载使用“选择要下载的项目”面板：上方仅列已选项目，逐项移除；下方是可搜索的添加下拉列表，已选项不再出现在候选中。最多 20 项，**选择表示下载，不是排除，也不更改上传白名单**。Input + 同一 Modal 内的 listbox 组合支持方向键、Enter、指针选择；Tab 不添加，Escape 先收起候选，中文输入法提交不误触发添加。没有借用原生 Menu 的菜单快捷键（其 Tab 会激活菜单项），也不把 listbox 放到 Modal 焦点范围之外。

无冲突时显式标为“最新版本”，只取唯一 head；多个 head 必须展开选择。版本列表按需显示，显式历史选择在刷新后仍保留，消失时变为未解决，不偷偷切换最新。项目目录重新打开会刷新，不清空已选草稿。保存位置只选一次，Host 为同名/大小写近似项目规划不同的新子目录。

界面只使用一个下载 Modal，内部切换选择、文件夹浏览、确认、进度和导入；正常页面没有整个目录/历史/结果的堆叠。最终确认包含每个确切版本与目标路径、文件/大小摘要；一次 `downloadstart` 接受完整批次，不由浏览器逐项目调用 `restore`。关闭页面只停止观察，Host 继续；重开读取当前登录下的批次结果，不自动重发。

```js
DownloadPlan = { parent, destinations: [{projectId, checkpointId, id, root, parent, label}] }
DownloadStatus = {
  id, state: 'running' | 'succeeded' | 'partial' | 'failed', completed, total,
  warningCode?: 'DOWNLOAD_FINALIZATION_FAILED',
  items: [{ projectId, checkpointId, restoreId, root, label,
    state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled',
    sessionCount?, errorCode?, canImport, importResult?: Recovery }]
}
```

`status.download` 为可选公共状态；未接受任务时可以没有该字段。selection/plan/intent 是不可变的本次页面控制器状态，项目、版本、身份或运行时变化都会使旧计划/确认失效。所有批次目标在确认前验证，确认后逐个执行；单项独立失败继续其他项目，权限/账号/配置/取消失败停止剩余项。状态清理失败不会覆盖已经验证成功的文件结果，但会返回独立 warning。

仅当前批次成功项可通过既有 `import` 动作单独确认导入，`canImport` 在导入准入时消费，`importResult` 保存安全计数与可能已落盘的新会话 ID。未确认回包不自动重试；不创建 agent，不默认同步新目录。批次在 Host 内存保留，不提供进程重启续传。旧单项目 API 与命令保持兼容，不是新界面的逐项派发实现。

## 0.8.0 直接下载云端最新内容

选择面板只保留项目名称和移除操作，添加时不请求检查点、不规划目录。删除了版本按钮、历史列表、分支选择、刷新版本和基于旧清单的日期/数量统计；项目只需保持已选状态，版本由 Host 在开始新批次时处理。

四个批次动作显式发送 `latest:true`。`downloadpick` 仅提交项目 ID；规划结果为 `{latest:true,parent,destinations:[{projectId,id,root,parent,label}]}`，不含 checkpointId。browse/select 也必须保持最新模式标记，取消仍返回 `{cancelled:true}`。`downloadstart` 仅提交项目与目标句柄，禁止额外注入固定版本字段；新前端不降级接受旧模式计划或回包。

Host 先检查重复 requestId：重试只返回原结果，不重新解析“最新”。新请求则在独占准入中重新读取每个项目已提交索引的最后一项，验证清单并固定实际 ID；按成功提交顺序，不按设备时钟或 heads 数量，因此多分支无需额外选择，但历史和其他分支不会删除或合并。读取后的新提交留给下一次下载，没有跨项目全局事务快照承诺。

即使最新清单的源文件夹改名，实际目标仍是用户已经确认的计划路径。慢速读取之后再次验证 TTL、parent/provider、账号与 revision，确认前取消不会写文件；接受后沿用任务级取消与完整性检查，不能中途换成另一份内容。每项真正下载的清单摘要继续决定显式导入资格。

公共 `DownloadStatus` 对最新任务增加 `latest:true`，内部仍带真实 checkpointId 用于校验/导入，但界面不展示或让用户选择。旧状态可只读展示；最新确认只能与同模式、同 requestId/项目/目标的实际状态匹配，不要求它等于浏览器曾缓存的旧检查点。旧无 latest 标志的固定接口及命令仍兼容，`latest:false` 或模式句柄交叉使用会被拒绝。

## 源码、安全与生命周期

- [状态模块](<state.mjs>)：无框架校验、公共响应字段白名单、不可变状态、并发互斥、过期响应丢弃、超时与取消、有限排队确认及挂载期轮询。
- [设置页适配器](<adapter.mjs>)：中文原生设置槽位适配器；没有自建应用、storage 或日志。
- 密码是不受控的 `type=password` 输入，不进入 React state 或共享状态；提交立即清空、提交结算再清空、焦点离开表单或组件卸载时清空。宿主返回的服务器或账号发生变化时，先清空未提交密码再替换表单身份，防止把旧密码带到新目的地。只在本次登录/改密请求中发送给 DSH Host。
- 错误使用本地安全中文 code 映射，不展示可能回显输入的任意异常文本或错误体。公共状态也不保留额外 token/password 字段。
- 未登录不允许上传；登录、修改选择、保存选择都不调用 `sync`。开启自动同步必须显式操作开关并保存，由 Host 执行调度。
- `pending` 是待上传/重试的检查点数量，不代表运行中。即使自动同步关闭或队列中有已取消项目，仍可手动重试当前所选项目；只有 `running` 或尚待确认的 `scheduled` 才阻止重复提交。
- 上传运行中仍可编辑选择、关闭自动同步并保存，或退出登录。Host 会先取消并等待活动上传，再提交设置/退出；已发送内容不能撤回。下载/导入期间其他设置写入锁定，退出会取消并等待任务；native 导入中已落盘的会话不回滚。运行中继续禁止账号重登和新同步。
- `PROTECTED_QUEUE` 表示旧队列含受保护路径：宿主保留队列但不上传，页面提示检查而不绕过保护。
- 页面打开、手动刷新与 DSH connection reset 读取状态；仅页面仍挂载且有 `pending/running/scheduled` 时轮询。运行时约 3 秒、仅待上传约 10 秒；出错停止，关闭页面停止轮询。自动上传不由浏览器轮询驱动。
- dirty 草稿不会被同 revision 轮询覆盖；revision 变化不自动套用新版本覆盖外部选择。
- 页面保持简洁，详细安全边界移至[安全文档](<../docs/SECURITY.md>)；删除说明文字不改变权限检查，也不会执行项目代码、启动代理或自动恢复会话。

## 验证边界

[Client 测试](<../tests/settings-client.test.mjs>)和[改密 Client 测试](<../tests/password-client.test.mjs>)使用合成 Connection 与 React hooks/control mocks 验证状态、可访问属性、secret 生命周期、ID 白名单、冲突、busy、错误、取消/轮询、模块加载器产物及无框架副本约束。

```powershell
node --test --test-isolation=none tests/settings-client.test.mjs tests/password-client.test.mjs
```

Mock 测试与只读 SDK 核实不是在真实用户 profile 安装后的 GUI 验证。本次没有操作真实 profile；如进行隔离 native smoke 或未来真实 GUI 验证，须分别记录，不能把 mock 通过称为真实 GUI 集成通过。
