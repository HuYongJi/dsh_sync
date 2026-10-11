# DSH 个人认证与跨端同步 · 0.3.2

**各终端本地运行，云端只负责认证与存储。** 不替代 DeepSeek/Codex 登录，不在云端执行你的项目。

## 安装后直接在设置页使用

在原生 **设置 → 个人云同步** 页面完成日常配置。0.3.2 登录后收起服务器、账号和密码输入，仅显示已登录用户名；同步项目改为摘要卡片，通过“管理”弹窗选择。保留改密功能及 8 位最低密码要求：

1. 在 DSH 的 Plugins 页面安装/升级本项目或新版 tgz，重新加载插件；按宿主提示重启，再刷新原 DSH 页面。
2. 打开 **设置 → 个人云同步**。
3. 填写已部署同步服务器的 **HTTPS 地址、账号、密码**，点击 **登录**。
4. 点击 **同步项目 → 管理**，从当前 DSH 项目中勾选需要同步的项目，点击弹窗中的 **保存**。
5. 点击 **立即同步**；确认结果后，可明确打开 **自动同步** 并保存，默认每 60 秒检查一次。

项目卡片只显示已选项目的简短摘要；完整列表、路径、搜索和全选/取消放在“管理”弹窗中，仍是选择要同步的项目，不是排除列表。关闭弹窗会保留未保存草稿，不会自动保存或上传；可继续编辑、显式保存，或在主页面撤销更改。自动同步开关与全局保存位于“同步状态”卡。离线后可以手动重试；同步过程中也可以取消项目、关闭自动同步并保存，或退出登录。**保存后的取消会阻止后续上传；已经发出的内容不能撤回，也不会自动删除云端历史。**

没有列出项目？先在 DSH 打开/添加该项目，再点 **刷新**。不支持在此页面直接提交任意目录路径，项目根目录只从宿主 registry 取得。目录失踪、变更、含链接或属于受保护的 DSH 配置目录时会被阻止。

### 安装失败：GitHub 地址后面出现其他插件名

如果 `ERR_PNPM_FETCH_404` 的请求类似：

```text
https://github.com/HuYongJi/dsh-openai-oauth/dsh-mcp-connector
```

而 `dshmarket`、`dsh-workbuddy-connect` 等也被拼到同一仓库地址后面，应优先排查 **npm registry（软件包源）被误设为 GitHub 仓库地址**。DSH 安装时会一并解析当前 profile 的其他直接依赖；这些名字不代表本插件依赖它们。

- **软件包源**应使用 npm registry，例如 `https://registry.npmjs.org/`，不能填写 GitHub 仓库网页。若原本使用组织私有源，先确认正确配置，不要盲目改为公共源。
- **待安装插件**填写在包名/安装地址位置。可使用新版[发布包](<dist/dsh-personal-sync-0.3.2.tgz>)；把包复制到目标电脑后，使用那台电脑上的实际绝对路径。它不是上例中的 OAuth 插件。
- DSH 的源选择优先级是：**本次安装指定的 registry → `dsh-plugin-manager` 的 registry 配置 → pnpm 自身配置**。优先纠正安装时指定的源；若仍错误，再检查宿主配置、profile/用户级 `.npmrc` 与 `NPM_CONFIG_REGISTRY` 环境变量。只改命令行中的全局源，不一定能覆盖 DSH 的设置。
- 如果目标电脑可以直接运行 pnpm，可在报错所指的 profile 目录中执行 `pnpm config get registry`，只查看有效源。无需提供完整配置或任何 token。
- 修正源后重试安装，按宿主提示重新加载/重启。`No authorization header was set` 本身不说明需要 GitHub token；`UND_ERR_DESTROYED` 重试也不能修正错误的源地址。不要为此删除 profile、会话或凭据，也不要关闭供应链检查。

以上是安装源排错，不涉及更改同步服务器地址。发布包没有设置 npm registry，也不会自动修复另一台电脑的宿主配置。

### 修改密码

点击 **修改密码**，填写当前密码、新密码和确认新密码后提交。新密码至少 8 个字符（按 Unicode 码点计数）、最多 1024 个 UTF-8 字节，且不能与当前密码相同。鉴权依据当前密码，不是仅凭登录 token；登录过期也可验证当前密码修改。

成功后所有设备的旧 token 都会失效，当前端退出登录并关闭自动同步，使用新密码重新登录即可。项目选择、队列和云端检查点均保留。超时或结果未确认时不会自动重复改密，请先重新登录确认状态。

**8 位最低长度需要云服务和插件都升级到 0.3.1 或更高版本。** 仅更新客户端不会放宽旧服务端校验；尚不支持改密的老服务会显示“请先升级同步服务器”。服务器只更新密码哈希，不回写初始化密码文件；改密后旧的 bootstrap 密码不再用于启动验证或恢复密码。

### 密码与默认行为

- 安装默认 **不选择项目、不上传、不启用自动同步**；登录及保存选择本身不调用“立即同步”。
- 密码仅用于本次登录或改密；提交、离开表单、宿主账号变化或页面卸载后清空，不写进普通配置、浏览器存储、日志或会话。
- token 保存在本插件拥有的 **按 profile 隔离的 DSH 原生凭据记录**，不会返回浏览器。
- 服务器地址、账号与项目选择保存在当前 profile 下本插件自己的状态目录，不修改宿主 profile 配置补丁。
- 有旧同步历史时，不允许将同一状态目录静默切换到另一个服务器/账号。升级、取消项目或删除 workspace 都不会把旧队列自动改绑到新身份。

### 从 0.1.0 升级

从 0.1.0 升级到 0.2.0 或后续版本后，请在设置页**重新登录并核对项目选择**。默认状态目录改为当前 profile 的 `dsh-personal-sync` 子目录，原生凭据 key 也按 profile 隔离；不会自动复制旧的全局 token、状态目录或队列。旧配置不删除；若已有高级 `stateDir` 配置，则仍以它为存储位置。

原有 `/v1` 同步接口保持兼容；0.3.2 仅调整客户端界面，若云服务已是 0.3.1，无需为此次布局更新更换服务。此次提供新版插件与构建产物，**未自动部署到真实服务器、替换桌面端/profile，或执行实际 GUI 安装验收**。

## 云服务与兼容性

客户端设置页不会自动部署云服务。已有服务器可直接填写地址；尚未部署时，参考 [Linux 部署说明](<docs/DEPLOYMENT.md>)。使用 HTTPS，不要关闭证书校验；仅本机测试允许 loopback HTTP。

当前适配 **DSH 0.2.0-rc.2 / Session format 4 / Cordis 4.0.4 / Node.js 24+**。Client 使用宿主 React、原生设置槽位和 Connection RPC，不捆绑另一套 React，也不修改 DSH Web 壳。

## 同步能力与边界

- 单用户 scrypt 密码认证、按设备签发有期限 token、退出撤销；验证当前密码后原子改密并撤销所有旧 token。
- 实际项目文件、已落盘会话日志、DSH 图片/文件附件、项目目录内的产物。
- SHA-256 内容寻址、不可变检查点、离线重试、幂等提交与多端冲突分支保留。
- 显式恢复到 **尚不存在的新目录**；检查内容后再导入为新会话 ID，不覆盖旧目录、不启动 agent。

**归档不等于全部都能续接。** 普通完整空闲会话可以导入；goal、schedule、权限状态、subagent/team/workflow、图像 offload、未知插件领域等日志在可验证时保留存档，但未适配状态不会直接导入为可执行会话。活动任务会延后，不取消正在运行的 DSH 会话。

默认排除 `.git`、`node_modules`、`.dsh`、虚拟环境、缓存、常见密钥/凭据文件、同步状态及符号链接/junction/硬链接。Host 还保护真实 DSH home/profile 路径；旧队列若含现在禁止上传的路径会被整份阻止并保留本机，不能靠重试绕过。

**文件和会话正文仍可能包含秘密；这不是通用秘密扫描器，也不是端到端加密。** 启用前请确认项目与服务器可信。更多见 [安全边界](<docs/SECURITY.md>)。

额外排除规则写在项目根目录的 `.dsh-syncignore`，每行一个相对 glob，不支持 `!` 反向包含：

```text
logs/**
**/*.log
private-data/**
```

默认单文件 64MiB、单检查点总量 1GiB、20,000 文件、manifest 8MiB。

## 换设备恢复与高级命令

图形化检查点浏览/恢复暂未加入；保留以下高级命令。在来源端用 `/sync-status` 查看项目的云端 `projectId`，不是本机 workspace ID。新设备安装插件并在设置页登录同一账号后，可逐条执行：

```text
/sync-list CLOUD_PROJECT_ID
/sync-restore {"id":"CHECKPOINT_ID","to":"E:\\new-project"}
/sync-import {"root":"E:\\new-project"}
```

恢复目标必须不存在；检查恢复文件后再导入。随后在 DSH 打开恢复目录，在设置页选择它；完整恢复目录的 manifest 会使其继续原云端项目历史。不根据名字相同或路径相同自动合并其他项目。

另保留 `/sync-push CLOUD_PROJECT_ID` 和 `/sync-logout`。前者只能上传已授权项目，命令完成后执行；后者也关闭自动同步。重复导入会创建另一份新会话，首次结果请保存。

独立 CLI 仍可用于运维或仅文件同步：

```sh
node src/cli.mjs login --server https://sync.example.com --username owner --password-file /outside-project/password.txt
node src/cli.mjs preview --project demo --root /work/demo
node src/cli.mjs push --project demo --root /work/demo
```

CLI 默认使用 `~/.dsh-sync`，接受 `--state DIRECTORY`，**不读取 GUI 的原生凭据、不自动继承 GUI 项目选择**；CLI 的 root 参数是单独的显式授权。正常 GUI 使用不需要这些命令。

## 开发与验证

```sh
node scripts/build-client.mjs
node --test --test-isolation=none tests/*.test.mjs
node scripts/pack.mjs
```

构建/服务/CLI 只依赖 Node 内置模块，打包会先构建 Client，并按 [包白名单](<package.json>) 收集代码。研究用安装副本、部署资料、测试数据、真实配置或 token 均不会入包。

已验证的测试层次和限制见 [测试报告](<docs/TESTING.md>)：包含 Client 状态/原生控件契约、Host RPC、真实 HTTP 云服务、取消与账号隔离，以及隔离 native SDK 烟测；不把这些测试冒称为当前日常 GUI 已安装成功。

### 代码入口

- [原生设置页](<client/adapter.mjs>) / [Client 状态与 RPC](<client/state.mjs>)
- [Host 装配](<plugin/index.mjs>) / [同步控制器](<plugin/controller.mjs>)
- [设置与项目白名单](<plugin/settings-service.mjs>) / [受保护设置路由](<plugin/settings-http.mjs>)
- [会话适配](<plugin/dsh-adapter.mjs>) / [快照恢复](<src/snapshot.mjs>) / [本地队列](<src/local-store.mjs>)
- [云服务](<server/index.mjs>) / [独立 CLI](<src/cli.mjs>)

后续：真实隔离 profile 的 GUI 验收、图形化恢复/冲突处理、更多会话领域适配、端到端加密、设备管理、存储配额与 GC。
