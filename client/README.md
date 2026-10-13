# 0.11.0 原生设置页与 Client 契约

本文对应0.11.0的单一双向同步界面；构建与入口检查不表示已经安装到真实 GUI。用户操作入口见[快速开始](<../README.md>)；最终全量测试及发布产物记录见[测试说明](<../docs/TESTING.md>)。

## 页面中的三个位置

1. **账号卡片**：登录、可选“在此设备保持登录（最长90天）”、改密、退出。保持登录默认不勾选。
2. **双向同步**：两个紧凑入口，点击后才打开本地／云端多选列表；每批1–20个。先预览，再“确认并启用”。已有配对保留暂停／恢复、立即同步、冲突、回收站、会话与中断修复。
3. **插件更新**：通过原生管理器检查、确认固定提交并安装；不升级服务器或授予项目写入权限。

“本机”指 **DSH Host**。浏览器可能运行在另一台电脑；浏览器文件选择或文字路径不是 Host 写入授权。云端项目名称／源路径也只是元数据，不能成为本机目标路径。

## 配对、冲突和修复

- 页面打开、刷新、登录、选工作区、选云端项目或关闭预览，都不会自行启用配对。
- 本地选择器使用当前 Host 工作区，不预加载云端；每个已选项目单独创建新云端项目。云端选择器进入时才读取，使用相同账号／revision的30秒显示缓存，显式刷新可重新查询。缓存不是写入授权。
- 云端选择后只选择 Host 父目录，每个项目创建全新直接子目录和工作区；原有工作区不是可选目标。来源、版本数、时间和同名标识只供辨识。历史多分支明确选主要版本，保留其他差异并说明迁移围栏。
- native chooser 或 Host browse 使用原生服务及 opaque node ID；预览只规划名称，最后确认才创建。目录被占用、父目录／provider／账号变化均失效，不能自动换目标继续写。
- 确认后由 Host 持有任务与调度。Client 关闭页面只停止观察，不靠浏览器逐文件传输，不把断线当作取消或失败证明。
- 冲突默认保留双方；必须预览具体目标后确认采用本机、云端或保留双方。没有自动文本合并，旧预览不能覆盖后来的本机编辑。
- 回收恢复不覆盖占用目标；恢复内容来自校验过的副本。删除／替换记录不自动清理。
- 中断修复只在 Host 判定可修复时出现。先预览，后确认；缺失主文件可安全补回，已有新内容保留。部分写入的歧义不会因为“重试”而被当作干净修改上传。
- 政策变化使旧修复无法继续时，可用新预览显式替代；旧请求变成终态，不会因忽略规则改回去就复活旧写入。
- `lastCheckedAt` 是实际完成远端核对的时间；`lastSyncedAt` 不代表最近一次页面刷新。仅无冲突、无待应用事务时才能报告已同步。

## 会话与凭据

会话日志／附件归档与安全导入分开。列表中的归档数量不是“可续接会话数”；预览数量也不是 native 格式验证成功的保证。只有明确确认后，支持的子集才导入为新会话 ID；不会恢复 agent、待处理任务或未经适配的运行状态。

导入结果未知或部分持久化时显示已知的新 ID 与安全状态，不能自动重放。查看或导入归档不会隐式开启已暂停的文件同步。

密码只存在于当次非受控密码输入与 Host 登录／改密请求中；提交、离开表单、账号变化或卸载时清空。访问与续期秘密不返回 Client，不进入 React 共享状态、浏览器存储、日志或普通配置。保持登录的设备授权由 native 凭据服务和 Host 维护，Client 不自行刷新令牌。

过期、撤销、续期未知或身份冲突会锁定写入口并要求核对／重新登录。新登录不会自动扩大旧项目权限，恢复配对需要明确操作。错误只显示本地安全 code 映射，不展示任意远端正文或 native 诊断。

## 运行时与发布入口

[预构建 Client](<dist/client.js>)是 DSH `window.__ModuleLoader__.load({id,factory})` 模块，不是独立浏览器 ESM 应用；模块 ID 为 `dsh-personal-sync`。

[包定义](<../package.json>)声明 Client export、Web platform 和所需原生注入。运行时通过 `slots`、`connection` 注册原生 Settings section，复用宿主 React 与 `Button`、`Input`、`Checkbox`、`Modal`，不捆绑第二套 React/Vue，也不修改 Web 壳。

兼容目标保持 **DSH 0.2.0-rc.2 / Session format4 / Cordis ~4.0.4 / Node.js24+**。可选原生插件管理器缺失时仅更新功能不可用；不绕过宿主批准或兼容检查。云端首次接入需要同版本 Host directory picker 的 native 或 browse 能力；缺失时明确提示配置宿主服务，不用浏览器本地文件框或任意路径输入替代。旧下载 RPC 仍不存在。

```sh
node scripts/build-client.mjs
node scripts/check-install.mjs
```

修改源码后必须重建并交付[预构建入口](<dist/client.js>)。当前版本为0.11.0，重建、入口检查与最终 tgz／校验和按发布记录核对。构建成功不表示运行中的 Host 已重载；按原生安装提示重启 DSH、刷新原页面，不另起一个 Web 服务冒充原 GUI。

## RPC 是唯一浏览器通道

生产 Client 通过宿主 Connection 调用：

```js
ctx.connection.rpc.call('/api', 'dsh-personal-sync/' + action, payload, signal)
```

浏览器不直接调用云同步服务器，不自行拼 localhost URL，不持有云端 bearer／refresh secret。Host exact POST streaming 路由复用 DSH 的 Host/Origin 与浏览器会话权限边界；不注册第二个 `/api` interceptor，不开放 CORS 绕过。

```js
// 业务 envelope；外层 Host 权限拒绝仍可使用 HTTP 401/403。
{ type: 'client-request', rpcId, method: 'dsh-personal-sync/syncstatus', payload: {} }
{ type: 'server-response', rpcId, result: { ok: true, value: publicStatus } }
{ type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: {} } } }
```

### 当前动作分组

| 目的 | 动作 | 权限与确认边界 |
| --- | --- | --- |
| 账号 | `status`、`login`、`password`、`logout` | 登录可带 `remember:true`；秘密仅进入相应 Host 请求。 |
| 双向状态／发现 | `syncstatus`、`syncprojects` | 公开状态投影与显式云端发现；浏览不授予写入权限。 |
| 本地批量接入 | `syncpublishplan`、`syncpublishcommit` | 已选工作区 IDs；每个项目新建云端项目，固定批次计划＋原请求 ID＋明确确认。 |
| 云端批量接入 | `syncclonepick`、`syncclonebrowse`、`synccloneselect`、`synccloneplan`、`syncclonecommit` | 一个 Host 父目录、各自新建子目录；只传云端项目 IDs 和宿主签发的选择／计划 IDs。 |
| 旧双向配对兼容 | `pairplan`、`paircommit` | 保留0.10客户端兼容，不在新版首次接入界面提供已有目录关联。 |
| 暂停／运行 | `syncpause`、`syncrun` | 绑定 ID 与保存的身份；恢复重新验证目录及授权。 |
| 冲突 | `syncconflicts`、`syncresolveplan`、`syncresolve` | 绑定当前冲突和云端 head；选择后预览，再确认。 |
| 本机回收 | `syncrecycle`、`syncrestoreplan`、`syncrestore` | 只操作已知回收项，确认目标仍可用；不传任意文件内容或路径。 |
| 会话 | `syncarchives`、`syncarchiveplan`、`syncarchiveimport` | 档案 ID 与当前绑定；独立确认安全子集导入，不运行 agent。 |
| 显式修复 | `syncrepairplan`、`syncrepair` | 绑定已知中断事务；保留新修改／备份，检查持久化结果后决定是否可重试。 |
| 本地存储预算 | `syncsettings` | 显式保存1–1024GiB整数、绑定 revision CAS；不改变选择、不清理历史。 |
| 插件更新 | `updatestatus`、`checkupdate`、`installupdate`、`cancelupdate` | 固定来源与提交，由原生 manager 安装；不更新云服务。 |

共33个精确动作：账号4个、更新4个、双向25个（含7个批量接入动作）。已移除的旧上传／下载／恢复动作即使携带有效旧请求体也返回404，不读取正文或调用内部服务。确切校验以[Host 路由](<../plugin/settings-http.mjs>)和[双向服务](<../plugin/bidirectional-service.mjs>)为准。通常写意图还绑定保存的 `server/username/revision`；路径仅作为显示值，不能靠修改显示字符串扩大权限。

### 状态与请求生命周期

[双向状态控制器](<bidirectional-state.mjs>)负责响应字段白名单、草稿、不可变确认意图、旧响应丢弃、身份隔离和有限只读核对。公开状态包含工作区／绑定、待上传／下载数、冲突、回收、会话归档／延后计数及安全错误码，不含 token、密码、blob 字节或完整日志。

- `pending` 不等于运行中；结果未知也不等于“没有写入”。
- `syncstatus.onboarding`公开有界批次／项目结果：最多100批、每批20项。批次 ID 等于原确认 requestId；丢失ACK只能核对该ID，不能换ID重放写入。按项目显示结果，保留已完成和未完成目录。
- 本地首次发布只有自己的原始提交回执被验证才解除创建保护；没有回执／结果未知时暂停，普通恢复、旧配对 API 与 tick 都不能把它关联到意外云端 head。当前没有通用的初始化回执恢复入口，不应建议用户删除元数据。
- 首次云端物化使用下载专用 bootstrap，不调用普通扫描／归档上传。只有基线、目录所有权与工作区登记确认完成才发布正常配对；未知登记不重复调用 create。
- 计划绑定身份、真实目录、当前策略及相应云端状态。过期或变化后重新预览，不自动换成另一项选择。
- 已接受任务由 Host 持久化意图与结果拥有。浏览器不依据超时自动再发一次写入；续查使用同一请求，不生成新请求猜测成功。
- 修复结果区分未接受、已接受待完成、完成和被新计划替代；不能把前置拒绝误报为已接受，也不能把部分结果当成全成。
- 导入一旦可能已落盘，就保留不确定结果与已知新 ID，不用新请求绕过去重。
- 账号卡片只在观察到 Host 忙碌时以受限频率只读核对状态；空闲、读取失败、认证拒绝或离开页面时停止，旧队列不触发轮询或上传。插件更新仍独立核对已接受的更新任务。
- 页面轮询只是观察，不由页面轮询频率推导后台扫描频率。健康、可达、未暂停且未退避时，Host 约15秒核对远端，文件树元数据最多复用30秒，native 元数据每次核对；符合这些条件的调度达到5分钟阈值就强制完整核验内容。变化、未知、dirty watch、部分事务或 native 活动阻止缓存跳过；详见[运行参数](<../docs/DEPLOYMENT.md#运行参数与本地预算>)。

## 已移除的旧入口

账号 Client 的传输白名单仍仅含8个账号／更新动作，不保留旧项目选择、自动上传、备份下载／恢复或登记控制器方法。新的创建目录及批量接入由独立双向控制器的 syncclone／syncpublish 动作负责，不恢复旧 RPC。已保存的旧设置与旧状态字段不能恢复这些功能。

Host 计时器只初始化、续期并调度明确的双向绑定，不调用旧上传 tick；原生命令仅提供双向状态与退出。内部数据兼容辅助代码和既有记录仍保留，不能通过旧浏览器 RPC 重新暴露。会话新 ID 导入与本机回收恢复仍属于明确配对的双向功能，不受此次旧入口移除影响。

## 存储设置

高级设置显示同一 profile 的共享预算和最近核对值；未知统计显示未核对，不猜测剩余空间。默认10GiB，可保存1–1024GiB整数，需通过 revision CAS；保存不自动清理或改变配对。计量包括插件状态、已知／暂停绑定和已证明所有权的未完成新目录维护区中的引擎、暂存与回收数据，**不是用户项目正文或云端磁盘配额**。安全／结果元数据仍可持久化，因此这是软快照预算，不是文件系统硬限制。

## 代码入口与验证层次

- [主设置适配器](<adapter.mjs>)、[账号／更新状态](<state.mjs>)。
- [双向原生面板](<bidirectional-panel.mjs>)、[双向状态与 RPC](<bidirectional-state.mjs>)。
- [原生装配](<../plugin/index.mjs>)、[Host 双向服务](<../plugin/bidirectional-service.mjs>)、[引擎](<../src/sync-engine.mjs>)。
- [客户端契约测试](<../tests/bidirectional-client.test.mjs>)、[认证状态测试](<../tests/auth-state-client.test.mjs>)、[生产控制器到真实 HTTP 的链路测试](<../tests/bidirectional-integration.test.mjs>)。

原生控件对象树／合成 carrier 测试，不是浏览器视觉验收。生产 GUI **控制器** → RPC envelope → Host → 实际 TCP HTTP 的测试使用合成目录、账号及 SDK/provider 替身，也不等于已安装 profile 的完整 GUI 验证。历史隔离 native SDK 烟测的范围另见[测试说明](<../docs/TESTING.md>)。
