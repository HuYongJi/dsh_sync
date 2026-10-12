# 0.9.0 测试层次与发布验收

## 当前发布结论

**0.9.0完整自动化回归通过：808项通过，0失败，0取消，0跳过。** 冻结源码并重新构建 Client 后，按下述完整命令执行；耗时约18分56秒。该结论覆盖本地合成数据与下述分层测试；另行获得授权的一台服务器升级验证单独列示，不代表真实用户 profile、生产 GUI 或所有部署环境已经验收。

| 发布记录 | 状态 |
| --- | --- |
| 代码／预构建入口版本 | 0.9.0；Client 已重新构建 |
| 构建来源 | 0.9.0源码与随仓库提供的预构建 Client；发布变更以 Git 提交历史为准 |
| 全量命令与环境 | `node --test --test-isolation=none tests/*.test.mjs`；Windows / Node.js25.8.1 |
| 完整结果 | **808通过／0失败／0取消／0跳过**，约1135.5秒 |
| 安装入口检查 | 已通过；独立解包后 Host、Client、bundle入口也通过，未激活插件 |
| 发布包与白名单 | [0.9.0安装包](<../dist/dsh-personal-sync-0.9.0.tgz>)，45个生产文件；不含测试、研究副本、私密部署目录或 node_modules |
| 独立校验和 | [SHA256SUMS](<../dist/SHA256SUMS>)随安装包单独提供，不嵌入其自身包体 |
| 真实 DSH profile／完整0.9.0 GUI | 未验证，不从下述模拟链路推导 |
| 授权服务器的 Linux/Node24 验证 | Node24.21.0隔离旧版→新版预检18项通过；完整备份、既有数据保留、存储升级、受控重启、HTTPS/协议2复核通过；未在生产执行登录或测试上传 |
| 真实跨物理设备、最大文件／并发压力、强杀／断电 | 未验证 |

本轮实际回归环境是 **Windows / Node.js25.8.1**；兼容目标为 Node.js24+，没有把单一 Windows 环境泛化为所有平台。Windows 未允许一个可选的普通文件符号链接夹具；相关测试仍验证了真实 hardlink 与多处 junction，不能据“0跳过”宣称所有平台的全部链接变体均已实测。上表安装包／校验和链接面向本地工作区发布目录，该目录不提交到 Git，部署包也不包含它自身；从源码克隆后可用 `node scripts/pack.mjs` 生成。原生 Git 安装使用已包含的预构建 Client，不需要用户自行构建页面。

## 如何运行

所有并行写入结束、源码及产物冻结后，才执行完整回归：

```sh
node scripts/build-client.mjs
node scripts/check-install.mjs
node --test --test-isolation=none tests/*.test.mjs
node scripts/pack.mjs
```

并行开发期间只运行自己负责的明确测试文件或名称，不运行整个通配集合，例如：

```sh
node --test --test-isolation=none tests/sync-engine.test.mjs
node --test --test-isolation=none tests/sync-repair.test.mjs
node --test --test-isolation=none --test-name-pattern='repairOutcome' tests/sync-repair.test.mjs
```

`--test-isolation=none` 用于避免 Windows 受限环境中测试运行器建立捕获子进程管道的问题。它不是关闭路径、权限或数据校验。

测试使用合成账号、文件、会话与动态 loopback TCP 端口；临时目录位于仓库 `.test-tmp` 的独立子目录。清理前核对准确绝对路径、父目录和本次创建的名称，不能批量清空其他代理的夹具。不得用真实 profile、真实会话或真实项目做破坏性恢复测试。

## 分层证据：分别能证明什么

下列链接面向源码仓库；发布包不包含测试夹具或研究副本。覆盖范围依据当前测试源码，最终是否通过以上方发布记录为准。

| 层次 | 入口举例 | 可证明的范围／不能替代的验收 |
| --- | --- | --- |
| 纯协议与规划 | [v2 存储／协议](<../tests/sync-v2-store.test.mjs>)、[三方规划](<../tests/sync-reconcile.test.mjs>) | 严格 schema、路径／哈希／大小、规范编码、每路径基线、冲突与 tombstone 规则；不是 native GUI。 |
| 本机文件与日志 | [本机应用](<../tests/sync-local.test.mjs>)、[引擎](<../tests/sync-engine.test.mjs>)、[显式修复](<../tests/sync-repair.test.mjs>) | 合成目录中的独占写、备份、quota、当前策略、部分应用／回执／请求持久化、故障与对象重建；不是硬终止清锁或断电保证。 |
| 云端与认证 | [v2 HTTP](<../tests/sync-v2-http.test.mjs>)、[设备授权](<../tests/device-auth.test.mjs>)、[存储完整性](<../tests/server-integrity.test.mjs>) | HTTP用例使用真实监听器／TCP／磁盘，设备授权另有状态机测试；组合覆盖绑定、撤销、CAS、回执与迁移围栏，不是公网 TLS 或生产运维。 |
| Client 状态／控件 | [双向 Client](<../tests/bidirectional-client.test.mjs>)、[认证状态](<../tests/auth-state-client.test.mjs>)、[设置 Client](<../tests/settings-client.test.mjs>) | 生产状态逻辑、合成 Connection、React hooks／原生控件对象树，确认与旧响应隔离；没有真实浏览器布局、焦点或 OS 对话框。 |
| Host 业务边界 | [双向 Host](<../tests/bidirectional-host.test.mjs>)、[续期 Host](<../tests/renewal-host.test.mjs>)、[Host 恢复](<../tests/bidirectional-recovery-host.test.mjs>) | 实际 Host 服务、权限／身份／root 检查与真实 loopback 云服务；credentials、registry、活动能力等仍为替身。 |
| 生产控制器完整链路 | [双向链路](<../tests/bidirectional-integration.test.mjs>)、[下载链路](<../tests/download-selection-integration.test.mjs>)、[兼容 HTTP／CLI](<../tests/integration.test.mjs>) | **生产 GUI 控制器 → RPC envelope → Host → 实际 TCP HTTP → 合成磁盘**；SDK/provider/原生 carrier 替身不等于真实已安装 GUI。 |
| 会话与档案 | [会话同步](<../tests/session-sync.test.mjs>)、[native 适配](<../tests/adapter.test.mjs>) | 合成 native/provider 契约、档案闭包、导入子集、去重、部分持久化与新 ID；不能据此声称真实 provider 全领域可续接。 |
| 资源计量／探针 | [profile 预算](<../tests/sync-budget.test.mjs>)、[元数据探针](<../tests/sync-probe.test.mjs>) | 合成本机目录和 native 元数据替身；范围／重叠计量、未知失败关闭、确定性提示及权限检查，不是实际整盘硬配额。 |
| Host 性能路径 | [双向性能](<../tests/bidirectional-performance.test.mjs>) | 生产 Host + 实际 loopback HTTP，SDK／时钟替身；健康缓存、5分钟强制核验、新编辑、共享预算和 CAS 提额。大占用通过 stat 元数据模拟，未分配真实 GiB 数据。 |
| 历史分页规模 | [历史 Client](<../tests/sync-history-client.test.mjs>) | mock fetch 的10,001条历史元数据分页、固定终点与字段过滤；不是10,001次真实服务器提交。 |
| 旧恢复持久化 | [持久化恢复](<../tests/recovery-durable.test.mjs>) | 合成传输／SDK／registry与真实本机恢复代码，核对重建后的台账、导入消费／预分配 ID、工作区登记；不是硬进程终止或真实 native GUI。 |
| 兼容与安装包 | [legacy 可靠性](<../tests/legacy-reliability.test.mjs>)、[包验证](<../tests/package.test.mjs>)、[入口检查](<../scripts/check-install.mjs>) | v1 队列／新目录策略、构建一致性、exports 与白名单；不是原生安装器或真实 GUI 的替代品。 |

“真实 HTTP”表示执行了本项目服务并通过实际 loopback TCP/fetch 交换数据，不是仅 mock 网络；它仍使用合成数据，并非向真实账户上传。

## 0.9.0 必须核对的关键回归

### 授权与数据流

- 安装／登录不默认选择、配对或上传；旧上传授权不自动升级。
- 本机／云端选择 → 预览 → 明确确认才启用；所有目录属于 Host，而不是浏览器电脑。
- 配对、暂停、恢复与请求绑定当前账号、设备、serverId、授权 epoch 和真实根目录；重新登录后不能自动越过旧授权。
- 浏览器无直接云端 fetch、无 bearer／refresh secret；控件关闭、身份变化及未知结果不重放写操作。

### 文件、历史与修复

- 两设备双向修改、三设备不同路径并发、同路径编辑／编辑及删除／编辑冲突。
- 被忽略或未知的远端路径保留；当前本机忽略文件不通过入站同步改写。
- 全队列／当前策略检查早于第一份字节，后续每次发送／提交仍复核；旧描述符不被篡改以绕过策略。
- 捕获先于新的网络发送；丢失 ACK 查原回执，CAS 过期有限重算，不把全局 revision 当作所有路径已应用。
- 替换／删除可回收，当前新编辑不覆盖；应用到一半只推进有验证证据的路径。
- 显式修复的缺失目标独占补回、已有目标保持、坏备份／root／身份失败关闭、旧计划保留。
- 部分发布即使远端返回旧基线也保留歧义；新修复显式替代旧请求，旧请求必须成为终态。
- 只读修复结果区分未接受、pending、完成、被替代；准入前陈旧失败不能冒充“可能已写入”。

### 认证、归档与迁移

- 记住设备为原生续期授权，不保存密码；30天 idle／90天 absolute、轮换、撤销、改密及未知续期要求重登。
- 空闲日志、附件、产物档案的拥有权与闭包；当前捕获引用去重，历史引用追加保留，不凭缓存内容取得上传权。
- 活动／暂不支持的归档提示与文件通道分离；安全子集导入明确确认、新会话 ID、未知结果不重复导入、无 agent 启动。
- 存储版本2升级、旧项目完整 head 集合迁移、明确主版本、所有旧分支／历史保留，v1 写入／latest 围栏和历史 ID 读取。
- 已有真实服务器／目录可复用的前提是正确停服、完整备份、更新代码；不把只读升级检查称为已执行部署。

### 已接入、仍需纳入最终全量的回归

- profile 共享10GiB软预算：只计经验证的插件状态与所有已知／暂停绑定维护区，重叠合并；未知不猜容量。新分配在 Host 锁下准入，保存1–1024GiB整数上限需 revision CAS，不改选择、不 GC。
- 健康缓存：约15秒远端检查，树元数据最多复用30秒，native 元数据每次检查；达到5分钟完整内容核验阈值不能继续跳过。变化、未知、dirty watch、部分事务或 native 活动使缓存失效；暂停、不可达、退避和任务互斥不被当作实时承诺。
- 旧恢复台账跨重启按身份／epoch／摘要核对；中断目标失败／取消且不续写合并。成功资格、消费标记和预分配 native ID 持久化；单独 registerproject 不创建会话／agent、不授权同步。
- 下载单 Modal 选择 → 保存位置 → 核对 → 进度，拒绝准入不伪造进度；登记成功后继续双向同步仍需独立配对。

上述定向回归已由实现负责人确认通过，但不在这里累加成最终全量总数。历史规模用例的10,001是**模拟元数据条目数**，既不是物理提交数，也不是新的全套测试数量。

## 历史 isolated native SDK 烟测

历史开发记录曾在完全独立的合成目录，使用当时核对过的真实 Cordis、SessionStore、Session format catalog、LLM stream assembler 与 JSONL persistence provider，验证普通完整会话的持久化、导出、文件新目录恢复和新 ID 导入往返。

其意义是当时的 native codec／persistence 基础契约，不是当前0.9.0完整 GUI、所有会话领域、图像 provider、工作区注册或运行中 agent 生命周期验收。没有因此证明当前日常 profile 已成功安装。研究副本、提取的 SDK 和烟测夹具不随发布包分发；本文不发布或链接这些研究产物。

## 包与安装验证

```sh
node scripts/check-install.mjs
node scripts/check-install.mjs /absolute/path/to/unpacked-package
```

[检查脚本](<../scripts/check-install.mjs>)核对模块导入、exports、ModuleLoader 注册和默认安全配置，不调用实际 profile 的 Host/Client apply，也不等价于包管理器安装。

[打包脚本](<../scripts/pack.mjs>)根据[包定义白名单](<../package.json>)收集生产内容。应核对 tgz、校验和、版本及预构建 Client，不包含凭据、部署私料、真实配置、测试数据、研究副本或 node_modules。只生成本地包，不表示已经推送或升级任一运行实例。

若做真实 GitHub／包管理器安装烟测，必须使用用户批准的独立目录、缓存和测试 profile，保留 TLS、版本检查与脚本批准；只用 `--ignore-scripts` 的成功不能代替默认安装策略测试。

## 仍需独立实机验收

经用户明确批准后，使用隔离 profile 和合成数据：

1. 安装最终0.9.0包，完整重启／刷新原 DSH 页面，核对原生控件、焦点、中文输入法、窄窗口和系统目录对话框。
2. 在两个真实 Host 登录、显式配对，验证 A↔B 修改、离线后恢复、活动会话延后、冲突与删除回收。
3. 核对真实 native credentials 续期／撤销、重新登录后的显式恢复；检查浏览器和普通状态中无秘密。
4. 用普通会话及附件／产物验证归档，再单独导入新 ID；未适配领域必须明确拒绝续接，不启动 agent。
5. 核对真实 Host／进程重启、长断网和不确定结果；**硬进程终止可能遗留锁，不能假设自动清锁或自动回滚**。
6. 单独完成 Linux/systemd/Caddy/TLS、防火墙、完整备份与恢复、磁盘压力验收。

不得把“构建完成”“所有模拟测试通过”或历史 isolated smoke，改写成“真实安装／生产 GUI／真实跨设备已验收”。先记录最终结果，再由用户决定发布、部署与真实数据授权。
