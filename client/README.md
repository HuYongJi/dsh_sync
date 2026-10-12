# 0.9.0 原生设置页与 Client 契约

本文对应0.9.0代码与已重新构建的 Client；入口检查通过不表示已经安装到真实 GUI。用户操作入口见[快速开始](<../README.md>)；最终全量测试及发布产物记录见[测试说明](<../docs/TESTING.md>)。

## 页面中的三个位置

1. **账号卡片**：登录、可选“在此设备保持登录（最长90天）”、改密、退出。保持登录默认不勾选。
2. **双向同步**：本机工作区与云端项目显式配对；先预览，再“确认并启用”。项目行提供暂停／恢复、立即同步、冲突、回收站、会话及适用时的“核对中断事务”。
3. **旧版云端下载与插件更新**：新目录下载和原生安装仍是独立操作，不借此授予现有目录双向写入权限。

“本机”指 **DSH Host**。浏览器可能运行在另一台电脑；浏览器文件选择或文字路径不是 Host 写入授权。云端项目名称／源路径也只是元数据，不能成为本机目标路径。

## 配对、冲突和修复

- 页面打开、刷新、登录、选工作区、选云端项目或关闭预览，都不会自行启用配对。
- 可选择已有云端项目或明确创建新项目；首次配对不把缺失的未跟踪文件视为删除。旧项目多分支迁移必须明确选择主版本，其余差异保留。
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

[包定义](<../package.json>)声明 Client export、Web platform 和所需原生注入。运行时通过 `slots`、`connection` 注册原生 Settings section，复用宿主 React 与 `Button`、`Input`、`Checkbox`、`Switch`、`Modal`，不捆绑第二套 React/Vue，也不修改 Web 壳。

兼容目标保持 **DSH 0.2.0-rc.2 / Session format4 / Cordis ~4.0.4 / Node.js24+**。可选原生插件管理器、目录选择器缺失时，仅相应功能不可用；不绕过宿主批准或兼容检查。

```sh
node scripts/build-client.mjs
node scripts/check-install.mjs
```

修改源码后必须重建并交付[预构建入口](<dist/client.js>)。当前版本为0.9.0，已完成重建与入口检查；最终 tgz／校验和仍按发布记录核对。构建成功不表示运行中的 Host 已重载；按原生安装提示重启 DSH、刷新原页面，不另起一个 Web 服务冒充原 GUI。

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
| 配对 | `pairplan`、`paircommit` | workspace ID + 云端选择；确认使用 Host plan ID、稳定 request ID、`confirm:true`。 |
| 暂停／运行 | `syncpause`、`syncrun` | 绑定 ID 与保存的身份；恢复重新验证目录及授权。 |
| 冲突 | `syncconflicts`、`syncresolveplan`、`syncresolve` | 绑定当前冲突和云端 head；选择后预览，再确认。 |
| 本机回收 | `syncrecycle`、`syncrestoreplan`、`syncrestore` | 只操作已知回收项，确认目标仍可用；不传任意文件内容或路径。 |
| 会话 | `syncarchives`、`syncarchiveplan`、`syncarchiveimport` | 档案 ID 与当前绑定；独立确认安全子集导入，不运行 agent。 |
| 显式修复 | `syncrepairplan`、`syncrepair` | 绑定已知中断事务；保留新修改／备份，检查持久化结果后决定是否可重试。 |
| 兼容下载 | `projects`、`checkpoints`、`destination*`、`download*`、`restore`、`import`、`registerproject` | 新目录、独立导入／注册确认；持久化结果不授权续写中断目录，添加工作区不勾选同步。 |
| 本地存储预算 | `syncsettings` | 显式保存1–1024GiB整数、绑定 revision CAS；不改变选择、不清理历史。 |
| 插件更新 | `updatestatus`、`checkupdate`、`installupdate`、`cancelupdate` | 固定来源与提交，由原生 manager 安装；不更新云服务。 |

表中通配分组用于阅读，不是允许注册任意路由。确切校验以[Host 路由](<../plugin/settings-http.mjs>)和[双向服务](<../plugin/bidirectional-service.mjs>)为准。通常写意图还绑定保存的 `server/username/revision`；路径仅作为显示值，不能靠修改显示字符串扩大权限。

### 状态与请求生命周期

[双向状态控制器](<bidirectional-state.mjs>)负责响应字段白名单、草稿、不可变确认意图、旧响应丢弃、身份隔离和有限只读核对。公开状态包含工作区／绑定、待上传／下载数、冲突、回收、会话归档／延后计数及安全错误码，不含 token、密码、blob 字节或完整日志。

- `pending` 不等于运行中；结果未知也不等于“没有写入”。
- 计划绑定身份、真实目录、当前策略及相应云端状态。过期或变化后重新预览，不自动换成另一项选择。
- 已接受任务由 Host 持久化意图与结果拥有。浏览器不依据超时自动再发一次写入；续查使用同一请求，不生成新请求猜测成功。
- 修复结果区分未接受、已接受待完成、完成和被新计划替代；不能把前置拒绝误报为已接受，也不能把部分结果当成全成。
- 导入一旦可能已落盘，就保留不确定结果与已知新 ID，不用新请求绕过去重。
- 页面轮询只是观察，不由页面轮询频率推导后台扫描频率。健康、可达、未暂停且未退避时，Host 约15秒核对远端，文件树元数据最多复用30秒，native 元数据每次核对；符合这些条件的调度达到5分钟阈值就强制完整核验内容。变化、未知、dirty watch、部分事务或 native 活动阻止缓存跳过；详见[运行参数](<../docs/DEPLOYMENT.md#运行参数与本地预算>)。

## 旧下载与工作区登记

下载使用同一 Modal 的选择、保存位置、核对、进度阶段；准入拒绝留在可操作阶段，不伪造进行中的任务。Host 恢复台账跨重启保存，并以身份命名空间、授权 epoch、清单／请求摘要隔离；它保存结果，不把中断目标变成可自动续写的目录。

- 已完成的最新单次恢复／当前批次成功项按记录资格独立确认导入。资格消费和预分配的新 native 会话 ID 持久化，未知结果先核对，不用新请求重复创建。
- “添加到DSH项目”单独确认 `registerproject`；Host 核对成功恢复的根目录，创建或复用 workspace。该操作不创建 native 会话／agent、不附带同步选择。
- 若要继续双向同步，工作区登记后仍须独立配对、预览、确认启用；下载、登记、导入均不是配对的替代授权。

## 存储设置

高级设置显示同一 profile 的共享预算和最近核对值；未知统计显示未核对，不猜测剩余空间。默认10GiB，可保存1–1024GiB整数，需通过 revision CAS；保存不自动清理或改变配对。计量包括插件状态及所有已知／暂停绑定的引擎、暂存与回收数据，**不是用户项目正文或云端磁盘配额**。安全／结果元数据仍可持久化，因此这是软快照预算，不是文件系统硬限制。

## 代码入口与验证层次

- [主设置适配器](<adapter.mjs>)、[账号／兼容状态](<state.mjs>)。
- [双向原生面板](<bidirectional-panel.mjs>)、[双向状态与 RPC](<bidirectional-state.mjs>)。
- [原生装配](<../plugin/index.mjs>)、[Host 双向服务](<../plugin/bidirectional-service.mjs>)、[引擎](<../src/sync-engine.mjs>)。
- [客户端契约测试](<../tests/bidirectional-client.test.mjs>)、[认证状态测试](<../tests/auth-state-client.test.mjs>)、[生产控制器到真实 HTTP 的链路测试](<../tests/bidirectional-integration.test.mjs>)。

原生控件对象树／合成 carrier 测试，不是浏览器视觉验收。生产 GUI **控制器** → RPC envelope → Host → 实际 TCP HTTP 的测试使用合成目录、账号及 SDK/provider 替身，也不等于已安装 profile 的完整 GUI 验证。历史隔离 native SDK 烟测的范围另见[测试说明](<../docs/TESTING.md>)。
