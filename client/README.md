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

公共状态：

```js
{
  revision, server, username, loggedIn, expiresAt?, autoSync, intervalMs,
  projects: [{ id, label, root, selected, available, projectId?, warning? }],
  pending, running, lastResult?: { at, ok, message }, warning?
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

## 源码、安全与生命周期

- [状态模块](<state.mjs>)：无框架校验、公共响应字段白名单、不可变状态、并发互斥、过期响应丢弃、超时与取消、有限排队确认及挂载期轮询。
- [设置页适配器](<adapter.mjs>)：中文原生设置槽位适配器；没有自建应用、storage 或日志。
- 密码是不受控的 `type=password` 输入，不进入 React state 或共享状态；提交立即清空、提交结算再清空、焦点离开表单或组件卸载时清空。宿主返回的服务器或账号发生变化时，先清空未提交密码再替换表单身份，防止把旧密码带到新目的地。只在本次登录/改密请求中发送给 DSH Host。
- 错误使用本地安全中文 code 映射，不展示可能回显输入的任意异常文本或错误体。公共状态也不保留额外 token/password 字段。
- 未登录不允许上传；登录、修改选择、保存选择都不调用 `sync`。开启自动同步必须显式操作开关并保存，由 Host 执行调度。
- `pending` 是待上传/重试的检查点数量，不代表运行中。即使自动同步关闭或队列中有已取消项目，仍可手动重试当前所选项目；只有 `running` 或尚待确认的 `scheduled` 才阻止重复提交。
- 同步运行中仍可编辑选择、关闭自动同步并保存，或退出登录。Host 会先取消并等待活动操作，再提交设置/退出；已发送内容不能撤回。运行中继续禁止账号重登和新同步。
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
