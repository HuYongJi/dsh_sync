# 部署与换设备操作

本次 0.5.0 增加插件设置页检查更新与原生一键更新入口，保留 0.4.0 的云端下载恢复。未部署或修改真实服务器、日常 DSH profile，也未实际安装更新。插件更新不更新云服务器；若服务器已有 0.4.0 下载目录接口，此次无需为插件更新入口替换服务端。列举所有云端项目仍需服务端至少 0.4.0；旧服务可手动输入项目 ID 下载。保留数据与凭据，不要清空存储重新初始化。

## A. Linux 云服务（systemd + Caddy）

要求：Linux、Node.js 24+、systemd；有域名和 HTTPS 入口。服务不依赖数据库或 npm 运行时依赖。保持**单进程**，不要用多 worker/多实例共享同一数据目录。

### 1. 放置程序与专用账户

将本仓库的发布内容或解压后的 tgz `package/` 内容放到 `/opt/dsh-sync`。校验发布包旁的 SHA256SUMS。下面是部署示例，由服务器管理员执行，不是本开发会话已执行的操作：

```sh
sudo useradd --system --home /var/lib/dsh-sync --shell /usr/sbin/nologin dsh-sync
sudo install -d -m 700 -o dsh-sync -g dsh-sync /var/lib/dsh-sync
sudo install -d -m 750 -o root -g dsh-sync /etc/dsh-sync
sudo install -m 640 -o root -g dsh-sync /opt/dsh-sync/deploy/server.env.example /etc/dsh-sync/server.env
```

确认 `node --version` 为 24+，并根据真实 Node 安装位置调整 [systemd 模板](../deploy/dsh-sync.service) 的 `ExecStart`。状态目录必须是真实目录，不经过 symlink/junction。

### 2. 建立个人密码

设置至少 8 字符、建议密码管理器随机生成的独立密码。不要复用模型服务账号密码。用权限受限的编辑器创建 `/etc/dsh-sync/password`，单行 UTF-8，目录外的秘密文件不应放进任何待同步项目。

```sh
sudo install -m 640 -o root -g dsh-sync /dev/null /etc/dsh-sync/password
sudoedit /etc/dsh-sync/password
```

在 `/etc/dsh-sync/server.env` 设置用户名，参考 [环境变量模板](../deploy/server.env.example)。`SYNC_PASSWORD` 与 `SYNC_PASSWORD_FILE` 只能设置一个，推荐文件方式。

首次启动会持久化 scrypt 密码记录；**环境变量不会重置已有密码**。从未改密的旧记录仍会拒绝不匹配的 bootstrap 凭据。通过设置页成功改密后，持久化的新密码哈希是唯一依据，旧 bootstrap 密码不会被读取或用于恢复；原密码文件已过时甚至被移除，也不会阻止新版服务重启。程序不会回写管理员的密码文件。

账户找回、管理员重置与设备管理 UI 暂未实现；改密必须知道当前密码，不要删除服务数据来重新注册。

### 3. 启动本地监听

```sh
sudo install -m 644 /opt/dsh-sync/deploy/dsh-sync.service /etc/systemd/system/dsh-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-sync
curl --fail http://127.0.0.1:8787/health
```

不将 8787 暴露公网，服务也拒绝非 loopback bind。防火墙仅向公网开放你实际配置的 HTTPS 入口。默认 token 有效期 24 小时，`SYNC_TOKEN_TTL_MS` 可调整；暂不提供 refresh token。

### 4. 配置 HTTPS

按照 Caddy 的标准部署方式安装服务，使用 [Caddy 配置示例](../server/Caddyfile.example)，将占位域名换成你拥有且解析到服务器的域名：

```caddy
sync.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

在客户端用 `https://sync.example.com`，不要关闭证书校验。客户端只允许 loopback 明文 HTTP 用于本地测试，拒绝携带凭据、路径、查询或片段的 server URL，也拒绝 HTTP 重定向转发 token。

验证 `curl --fail https://sync.example.com/health`，再用 CLI 登录并只上传模拟文件。本项目尚未替你执行 Linux/systemd/Caddy/TLS 实机验证。

### 5. 备份与运维

- 定期停止服务后备份**整个** `/var/lib/dsh-sync`，再重启；不要只备份 blob。
- 状态包含密码哈希、有效 token 哈希和完整检查点索引；云端 blob/会话是明文，备份也要加密保护。
- 正常退出释放 `.lock`。进程崩溃或被强杀后遗留锁时，先确认没有使用该目录的进程，备份目录，再由管理员移除**该数据目录中**的陈旧锁。禁止在进程仍运行时移除锁。
- 登录与改密共享每来源 15 分钟 20 次的默认限制，并共享并发 scrypt 限额。不会信任 `X-Forwarded-For`；Caddy 后按代理的 socket 来源计数，个人单账户共享这项额度。
- 默认请求总时限 30 秒，慢速大文件可能超时并保留待上传检查点；单文件上限 64MiB。
- 首版无自动 GC、用户存储配额、密码恢复、多用户隔离或多实例协调。监控磁盘占用；不要手工删除检查点还引用的 blob。

## B. 客户端安装

在 DSH Plugins 页面安装/升级 0.5.0 包（或本项目绝对目录），按宿主提示重新加载或重启，然后刷新原 DSH 页面。安装包同时声明 Host bundle 与已构建的 Client 入口；其默认值不授权任何项目、不启用自动上传。遵守 Host 的版本检查，不建议通过 version exemption 跳过兼容约束。

打开 **设置 → 个人云同步**，填写服务器 HTTPS 地址、账号、密码并登录；登录后输入框收起，显示当前用户名。点击 **同步项目 → 管理**，勾选当前宿主项目后点击弹窗中的 **保存**；关闭弹窗只收起界面，未保存草稿仍需保存或撤销。首次使用建议先手动点击 **立即同步**，再选择是否开启自动同步。日常配置无需编辑 YAML 或运行终端命令。

必须匹配以下宿主 peers（见 [包定义](../package.json)）：

- `@deepseek-ai/cordis`: `~4.0.4`
- `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-format-catalog`, `@deepseek-ai/dsh-llm`: `0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-connection`: `0.2.0-rc.2`
- `@deepseek-ai/dsh-plugin-manager`: `0.2.0-rc.2`（可选，仅更新入口使用，缺失不阻断同步）
- Node.js 24+（可使用 DSH 管理的运行时）

服务/CLI 本身不加载这些 peers。不要为服务端安装一整套 DSH；直接运行 [服务入口](../server/main.mjs) 即可。

发布包包含 Client bundle，但没有为你修改运行中的客户端，也没有确认开发 HMR watcher；不能假定改源码就会更新当前网页。重载 Host 插件并刷新原页面，不要另起一个 Web 服务器冒充原应用更新。优先在独立测试 profile 验证。

### 0.5.0 客户端一键更新

首次先通过原生 Plugins 安装 0.5.0，再重启 DSH 并刷新页面，取得更新入口。后续进入 **个人云同步 → 插件更新**，点击 **检查更新**，发现新版本后点击 **一键更新**并确认；无需个人同步服务器登录。

元数据来自固定仓库 `HuYongJi/dsh_sync` 默认分支，安装地址锁定到检查时的完整 Git 提交。维护者需要递增稳定版 `X.Y.Z`、构建并提交预构建 Client，再推送到该分支；仅生成本地 tgz 或仅创建 GitHub Release 并不会让此检查发现新版本。无需设置 npm registry 为 GitHub 地址，不复制账号 token。

安装由原生插件管理器负责，保留启用选择与宿主安全策略。未提供 manager、非当前 profile 直接依赖、兼容拒绝或需要构建脚本批准时，在原生 Plugins 中人工处理，不自动卸载/降低校验。不要手动修改正在运行的安装树。

更新会拒绝与本插件的上传、下载或设置事务并发。原生安装启动后，即使失败、取消或断线，也可能已替换部分包文件；先查看状态/原生安装记录，然后 **完整重启 DSH，再刷新页面**，不要仅刷新网页或盲目重复点击。不会自动重启，也不会替你升级云服务。建议安装前结束其他活跃任务；本次验证不执行真实安装或进程重启。

### 0.3.1 密码策略升级

首次初始化和修改密码均要求至少 8 个 Unicode 码点，上限仍为 1024 个 UTF-8 字节；其他改密规则不变。云服务与各设备插件都需要更新，不能只修改网页提示。已有密码无需更改，也不要重置存储。

1. 保留原服务数据目录，先备份并停止旧服务，再替换服务代码、启动新版；不要清空数据重新初始化。
2. 确认公网 HTTPS `/health` 能正常访问，且包含 `X-DSH-Sync-Password-Change: 1` 响应头。代理应保留此头；客户端据此识别改密能力，避免把旧服务误报为密码错误。
3. 升级插件并刷新页面，在 **修改密码** 中输入当前密码、新密码和确认密码。成功后所有旧 token 撤销，当前端关闭自动同步并要求用新密码重新登录。
4. 超时/断线表示结果未确认，不自动重复改密；重新登录确认有效密码。新密码、当前密码都不会写进普通配置或队列。
5. 改密后的服务器状态含密码 revision，缺少此字段的旧记录按 0 兼容。请不要回退到不理解该改密流程的旧服务版本。

### 从 0.1.0 升级与状态隔离

- 重新在设置页登录并核对项目选择；不会自动搬迁旧的全局 token/队列，也不删除旧数据。
- 默认状态位置是 `profileContext.dir/dsh-personal-sync`；非敏感设置写入其中带 profile 哈希的 preferences 文件，token 写入本插件自己的 profile-scoped 原生 credential key。
- 高级配置已有 `stateDir` 时仍使用该位置。不要让不相关账号/profile 共用状态目录。
- GUI 默认不回退全局 CLI token；CLI 是独立运维工具，默认仍使用 `~/.dsh-sync`，需自己的显式登录。
- 每台设备使用自己的 deviceId；**不要通过网盘复制 state/token 目录**。
- 跨窗口设置使用 revision 冲突检查；遇到提示请刷新重新选择，不要盲目重复保存。
- 保存取消选择会停止后续上传，已发送的内容不能撤回；未选项目的队列保留在本机但不会被 GUI 后台发送。

详见 [设置页使用说明](../README.md) 和 [设置页实现契约](../client/README.md)。

## C. 换设备恢复

1. 在新设备设置页登录同一云服务器账号；无需预先授权上传项目。
2. 打开 **云端下载** 浏览项目，再查询检查点与多个 heads。项目目录需要服务端 0.4.0 的认证 `GET /v1/projects`；旧服务可手动输入来源设备 `/sync-status` 中的云端 `projectId`。不要把本机 workspace ID 当作云端 projectId。
3. 明确选择一个检查点并确认下载到**不存在**的绝对目录。该路径位于 **DSH Host 机器**，不是远程浏览器所在机器；父目录必须存在，目标不能嵌套在 DSH 配置/状态目录或现有注册工作区中。不会自动选择“最后修改时间最新”的分支，也不会合并文件。
4. 下载由 Host 异步执行，同一登录下重新打开页面可查看当前插件生命周期内的状态；退出后的新登录不会展示旧任务。检查恢复文件；失败可能留下 `INCOMPLETE` 标记，不得导入，不会自动清理用户目录，选择另一个新目录重新恢复。
5. 页面在下载成功后提供单独确认的 **导入安全会话**。新会话独立，不复制原始层级或运行状态；查看成功/跳过/失败计数、新会话 ID 和 workspace 挂载状态。关闭页面或回包丢失不是回滚，先查状态，不要重复提交。
6. 在 DSH 打开恢复后的目录，然后在设置页勾选该项目并保存。完整恢复目录的 manifest 会沿用原云端项目 ID，并以原检查点作为 parent；独立创建的同名/同路径项目不会被自动合并。两设备继续修改会形成分支，不删除另一方。
7. 用户自行打开新会话继续，不会自动执行任何代码。历史消息正文的旧绝对路径保持不变，只有明确识别的结构化 workspace/产物路径被映射。

原 `/sync-list`、`/sync-restore`、`/sync-import {"root":"恢复目录绝对路径"}` 命令仍可使用。图形任务记录不跨插件重启持久化；重启后已有完整恢复目录可检查后使用命令导入，不需要再次下载。自动同步仍只上传，不自动拉取或合并。

导入时若发生持久化写入失败，DSH API 没有通用删除/回滚接口；返回 `failed` 和可能已创建的新 ID。先检查该新 ID，不要无脑重复导入。重复成功导入也会建立新副本，不是原位覆盖。
