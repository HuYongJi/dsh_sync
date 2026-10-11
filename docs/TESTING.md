# 测试与兼容性

## 可重复的主测试

```sh
node --test --test-isolation=none tests/*.test.mjs
```

当前开发验证环境为 **Windows / Node.js 25.8.1**。0.8.0 全套测试已经运行：**408 项通过，0 失败，0 跳过**。服务只监听测试进程动态分配的 loopback 端口，使用测试密码和合成数据；临时文件局限在本仓库 `.test-tmp` 的独立子目录。

`--test-isolation=none` 避免 Windows 受限环境中测试运行器为子进程建立捕获管道。未开启替代 Web GUI 服务器、未访问真实账号数据、未上传真实项目、未修改已安装 DSH 或日常 profile。

| 测试集 | 项数 | 覆盖 |
|---|---:|---|
| [核心快照测试](../tests/core.test.mjs) | 13 | 路径穿越、Windows 保留名/大小写冲突、真实 junction、二进制/Unicode、秘密排除、拒绝覆盖、父目录/根目录替换、取消标记、损坏检查、队列与锁 |
| [真实 HTTP 集成](../tests/integration.test.mjs) | 2 | 两设备登录/上传/恢复、会话封套与资产字节、并发分支、幂等提交、服务重启后 token 持续、CLI 登录到登出 |
| [安全与插件回归](../tests/regressions.test.mjs) | 8 | 含 glob 字符的 state 目录、旧队列授权边界、manifest 字节上限、原型字段 ID、失效 token 登出、原生账号切换、插件注册、controller + 真实 HTTP |
| [云端服务测试](../tests/server.test.mjs) | 15 | 认证/撤销/期限、scrypt 持久化、独占锁、校验与限额、并发提交、冲突、设备绑定、速率/并发/超时、环境启动、目录跳转 |
| [会话适配测试](../tests/adapter.test.mjs) | 20 | 完整/活动/未落盘会话、revision 与高水位、待处理 inbox、未知领域归档但拒绝续接、资源完整性、结构化路径映射、全新 ID、部分写失败、codec/stream 失败关闭 |
| [设置页 Client](../tests/settings-client.test.mjs) | 44 | 原生槽位/控件契约、密码清理、RPC-only、可用项目选择、revision 冲突、离线重试、运行中取消/退出、有限轮询、旧响应隔离、确定性 bundle |
| [设置页 Host 与完整链路](../tests/settings-host.test.mjs) | 27 | 图形登录到真实 HTTP 云服务、profile 隔离、配置持久化、每次发送前权限复核、活动取消、受保护旧队列、损坏/回滚、安全请求解析、Client 状态→Host RPC→实际同步闭环 |
| [改密 Client](../tests/password-client.test.mjs) | 20 | 三个密码框清理、CAS 身份绑定、确认不发送、长度规则、当前密码拒绝、未知结果锁定、取消/超时不重发及精简 UI |
| [改密 Host 与链路](../tests/password-host.test.mjs) | 19（含 2 个子测试） | 真实云端改密、所有旧 token 撤销、旧服务能力探测、intent 持久化/恢复、损坏回包、清理失败、秘密不落盘、Client→Host→云端闭环 |
| [改密云服务](../tests/password-server.test.mjs) | 14 | 当前密码而非 token 鉴权、Unicode/JSON 边界、原子撤销、并发 CAS、旧登录/写入竞态、重启兼容及失败原子性 |
| [GitHub 安装包](../tests/package.test.mjs) | 10 | 包入口、预构建产物一致性、仅发布白名单的独立包、缺失 Client、安装 lifecycle、可选/捆绑依赖、Cordis peer、不安全默认配置、错误模块 ID |
| [下载恢复 Client](<../tests/recovery-client.test.mjs>) | 21 | 云端浏览与旧 API 兼容、检查点单选、绑定确认、异步轮询、超时不重放、部分结果、无手填 ID/路径的原生控件对象树 |
| [下载恢复 Host](<../tests/recovery-host.test.mjs>) | 19 | 认证项目目录、真实 HTTP 下载、目录/哈希保护、重复 ID、部分导入、取消/等待、账号与并发边界 |
| [下载恢复完整链路](<../tests/recovery-integration.test.mjs>) | 3 | 生产 Client→RPC→Host→真实云服务下载、独立导入确认、陈旧 revision 拒绝、部分持久化 ID 与秘密隔离 |
| [插件更新 Client](<../tests/update-client.test.mjs>) | 30 | 置底单按钮、检查/手动更新切换、全局刷新、固定提交/确认、陈旧回调、未知结果不重放、重启屏障和原生控件对象树 |
| [插件更新 Host](<../tests/update-host.test.mjs>) | 22 | 固定匿名元数据、压缩与字节限额、可选原生 manager、提交固定、候选过期、并发锁、批准拒绝、取消/终态与 HMR dispose 互等回归 |
| [插件更新联合链路](<../tests/update-integration.test.mjs>) | 2 | 生产 Client→RPC→Host→模拟原生安装器，版本/提交固定、无秘密、重启门禁与构建批准失败 |
| [文件夹选择 Client](<../tests/folder-picker-client.test.mjs>) | 14 | 具名项目、readonly 目标、native 取消、browse 导航、严谨 DTO、过期/陈旧请求、关闭中止、destinationId-only 下载 |
| [文件夹选择 Host](<../tests/folder-picker-host.test.mjs>) | 16 | 绑定计划、真实路径/inode/链接保护、无预创建、目录碰撞、旧服务回查、NFD/扩展年时间、不可变清单校验 |
| [文件夹选择完整链路](<../tests/folder-picker-integration.test.mjs>) | 3 | 生产 UI→RPC→Host→真实 HTTP 云服务，模拟 native/browse 选择后恢复字节，旧服务已知绑定兼容 |
| [选择式下载 Client](<../tests/download-selection-client.test.mjs>) | 23 | 正向选择/移除、搜索与键盘/IME、无检查点请求或选择、单 Modal 分步、最新模式计划/确认绑定、批次与导入 |
| [批量下载 Host](<../tests/download-batch-host.test.mjs>) | 19 | 完整分组准入、唯一目录、页面关闭后继续、逐项失败、权限取消、TTL/幂等、摘要导入、锁清理警告 |
| [选择式下载联合链路](<../tests/download-selection-integration.test.mjs>) | 5 | 只下载选中项、一次批次、关闭后继续、显式导入；计划后新提交/多分支/时钟偏差仍取最新，接受后固定与重复请求幂等 |
| [最新下载 Client](<../tests/latest-download-client.test.mjs>) | 15 | 无版本 UI/选择读取、严格 latest 标记、禁止注入固定点、接受实际新内容、身份/计划/回包与导入安全 |
| [最新下载 Host](<../tests/latest-download-host.test.mjs>) | 24（含子测试） | 最后提交顺序、计划后刷新、传输固定、模式隔离、无旧版本回退、慢网络的取消/目录/身份/TTL 复核、真实内容摘要 |

## GitHub 地址安装的验证边界

DSH 0.2.0-rc.2 的插件管理器原生识别 `https://github.com/HuYongJi/dsh_sync`，GitHub 连通检查后交给 pnpm 安装，再校验 bundle patch 与宿主 peer 版本。仓库包含预构建 Client，无需新增 `prepare`、`prepack` 或 `postinstall`。DSH profile 默认 `autoInstallPeers: false`，运行时提供已声明的宿主 SDK；不用把 peers 改成 dependencies 或安装另一份框架。

```sh
node scripts/check-install.mjs
# 也可在源码仓库中核对一个已安装或解压的包目录：
node scripts/check-install.mjs /absolute/path/to/dsh-personal-sync
```

检查真实 Host 模块导入、包 exports、Client ModuleLoader 注册和无自动同步的 patch，但**不调用 Host/Client 的 apply，不启动 DSH、不访问真实 profile，也不验证浏览器挂载或宿主服务注入**。回归测试另外将发布白名单复制到独立合成目录，确认没有源码工具、测试目录或 node_modules 仍能通过入口核验；这不是调用包管理器的替代品。已提交 Client 与源码逐字一致的测试在构建前即可发现过期产物。

实际 GitHub 下载还需要联网的包管理器烟测。应使用独立目录及缓存，以 DSH 对应的 pnpm 配置测试，保留 TLS、版本检查与默认脚本批准策略；只运行 `--ignore-scripts` 不能证明默认安装策略下成功。pnpm 11 的 `autoInstallPeers` 等设置使用测试目录内的 `pnpm-workspace.yaml`，不能仅写入 `.npmrc`。所有这些包级验证仍不等价于真实 DSH GUI 安装验收。

## 额外通过：真实已安装 SDK / JSONL provider 烟测

主测试之外，还使用本次安装归档中提取的**真实 Cordis、SessionStore、Session format catalog、LLM stream assembler 和 JSONL persistence provider**，在完全独立的合成目录完成了一次闭环：

1. 持久化一个含 7 条完整事件、非空 assistant stream 的模拟会话。
2. 真实 provider `create → append → flush → list → open → read`。
3. 适配器导出 → 核心文件快照/新目录恢复 → 适配器以新 ID 导入。
4. 真实 provider 读回事件逐项相等，cwd 已映射；没有创建 live Session 或 Agent，没有发起模型请求。

当前开发工作区保留 [烟测脚本](../.inspection/native-smoke/run-smoke.mjs) 与 [原始结果](../.inspection/native-smoke/run-yGUbiN/result.json)。依赖来自安装归档，未下载；研究副本与合成目录不随发布包分发。

这验证了真实 native codec/persistence 的接口与普通会话往返，**仍不是当前桌面 GUI/profile 的安装集成**，也没有在该烟测中覆盖真实图像 provider 的归一化、workspaceRegistry 或运行中 Agent 生命周期。

## 0.2.0 设置页额外核实

本次又只读核实安装归档中的原生 React Settings slot、Connection、workspaceRegistry、profileContext 和 AuthorizationService；相关 SDK 仍为 0.2.0-rc.2。Client 通过实际 Connection RPC 编解码的合成 carrier 检查；Host 另有 26 项源码契约断言，以及 13 项独立复核回归（包括执行原生 AuthorizationService 源码的 begin/commit/record-updated 闭环）。研究记录见 [Host 接口与复核笔记](../.inspection/UI-HOST-NOTES.md)，研究副本不随包发布。

新加入的完整链路测试使用**生产 Client 状态模块 + 生产 Host RPC/设置服务 + 真实 loopback HTTP 云服务**，完成页面式登录、选择保存、手动同步与退出；没有写 YAML，没有通过 CLI 登录，也没有浏览器直接访问云端。

这些是隔离合成测试，**并非真实浏览器中的视觉验收，也未替换当前运行 GUI/profile**。未能确认原应用的前端 HMR watcher，因此只交付明确构建的 Client bundle，实际安装/升级后仍应重载并刷新原页面。

## 0.3.0 改密与精简设置页

新增三组 48 项测试，完整测试共 165 项通过。改密路径覆盖正确/错误当前密码、过期 token、强度与确认、全设备旧 token 撤销、两次并发改密只一成功、旧密码验证中的登录不能跨过改密提交签发 token、既有数据不变和服务重启。

特意验证了不能误判的边界：HTTP200 超限/损坏回包与 5xx 均按未知结果处理；本地响应校验的 status=400 不能冒充 HTTP400 拒绝；旧服务 capability 缺失时不发送密码；先落盘无秘密 intent，成功/未知都禁止旧授权恢复，直到新登录完成。operation.lock 清理失败不能把已确认改密成功报告成未修改。旧 bootstrap 文件陈旧或消失不影响已改密状态重启。

Client tests 还验证大段帮助/安全段落与说明 tooltip 确实删除，而非隐藏；密码 Modal 使用原生控件，身份/revision 变化、提交、取消、离开表单、卸载均清空秘密。实际浏览器视觉验收和真实日常 profile 升级不在本次自动化验证范围内。

## 0.3.1 八位密码边界

初始化、浏览器、Host 和云端改密的最低长度统一为 8 个 Unicode 码点。回归测试覆盖 7 个 ASCII 字符、汉字、emoji 被拒绝，恰好 8 个被接受；显式检查 7 个 emoji 虽有 14 个 UTF-16 code units 仍不合格。保留空格不 trim、1024 个 UTF-8 字节上限、确认密码、新旧非同一密码及无秘密持久化的检查。

生产 Client 状态模块 → Host RPC → loopback 云服务的链路分别以 8 位 ASCII 和 8 个 emoji 改密，核对旧密码登录失败、两个设备的旧 token 被撤销、新密码重新登录成功且自动同步仍关闭。首次初始化也覆盖 7/8 码点和 UTF-8 上限，拒绝时不残留账户状态或锁。这些是合成数据与隔离服务测试，不是实际桌面或线上部署验收。

## 0.3.2 紧凑设置页

Client 对象树回归覆盖：登录后整个登录表单不挂载、只显示宿主确认的用户名；仅 `loggedIn` 变化也立即清空未提交密码；退出、过期和改密后恢复空密码表单。项目主卡只显示已选草稿的最多 3 个名称及剩余数量，完整搜索/选择/路径仅在原生管理 Modal 打开时挂载，仍为同步白名单。

管理弹窗验证搜索与批量选择、关闭保留未保存草稿且不发 RPC、全局撤销、显式保存成功才关闭、保存失败留在弹窗、保存中旧关闭 handler 不能绕过锁定，以及冲突时弹窗内刷新。运行中仍可取消项目和关闭自动同步后保存；不可用项目能取消但不能重新选择。

只读核对了 rc.2 原生 Modal/Input/Checkbox 契约，构建复用宿主控件。此处仍是对象树/接口测试，**未执行真实浏览器的视觉、焦点或窄屏验收，也未安装到日常 profile**；不能将构建完成等同于当前 GUI 已更新。

## 0.4.0 图形化下载恢复

新增下载相关测试区分三个层次：Client 状态/原生控件对象树、Host 与真实 loopback 云服务、生产 Client → 原生 RPC envelope → Host → 真实 HTTP/磁盘的完整下载链路。云端目录只列出已提交检查点所属项目；旧服务器可使用已知项目 ID 查询。

重点验证显式选择/确认、不自动上传或导入、跨账号/版本的陈旧意图、异步状态读取、重复请求不重做，以及新目录、受保护路径、大小/哈希、失败标记、部分导入的新会话 ID。下载成功与导入成功分别报告，未知结果不能自动重发。

下载链路使用合成二进制文件与合成会话档案；链路中的 credentials/workspaceRegistry 和会话导入为隔离 mock。真正 native 会话 codec/provider 的既有验证见上文，不把这些测试或重建 bundle 冒称为当前日常 GUI 的安装、视觉、焦点或实机跨设备验收。

## 0.5.0 一键更新

更新测试分为 Client 状态与原生控件对象树、Host 更新服务与控制器，以及生产 Client → RPC envelope → Host 的联合测试。GitHub 元数据与 `pluginManager` 安装器全部为合成替身，**不执行真实 pnpm、下载外部代码、改写真实 profile 或安装目录**。

已只读核实 DSH 0.2.0-rc.2 的原生 `ctx.get('pluginManager')` 可选访问、`listBundles` 直接依赖判断、固定 Git 提交替换、`restart-required`、构建批准与版本检查、取消/应用阶段和 HMR 队列契约。测试验证无隐式检查/安装、匿名固定域请求、版本和提交校验、大小/时间限制、压缩响应、候选过期、严格 RPC 参数、重复/陈旧意图、并发拒绝、结果脱敏、重启屏障和取消状态。插件 dispose 的合成用例还验证不与原生 applying/HMR 互相等待。

联合测试覆盖未登录个人云账号时检查/确认固定提交安装、仅原生 manager 调用、不转发任何 token/密码、运行版与已安装版分开显示、脚本批准拒绝不自动重试，以及安装后其他写操作被锁定。安装包检查额外验证 native manager peer 精确且可选。

这些是契约/状态测试，不宣称验证了当前桌面 GUI 的一键安装、真实 GitHub 网络、代理配置、pnpm 缓存行为或完整重启。实际验收仍需用户批准的独立 profile；此次未发布仓库提交，也未执行客户端更新。

## 0.6.0 精简界面与文件夹选择

对象树测试验证更新卡确实为最后一个主设置卡，仅一个检查/手动更新按钮，其他说明和独立核对/取消按钮未挂载。已有新版本但存在未保存设置时，仍显示禁用的“手动更新”，不会变回检查并再次联网。下载页没有手填 ID/目标路径控件；项目名称、只读最终路径和必要条件错误保留。

真实 loopback 服务覆盖已提交目录名称与原始清单 SHA/索引一致性，保留旧索引、源路径 NFD 和扩展 ISO 年的兼容。legacy 路径仅使用已知绑定，不按名字猜项目，部分失败明确报告。联合链路验证选 native 父目录/浏览目录句柄后才得到计划，目录尚不存在，最终仅提交 destinationId，确认后才下载字节，取消保留原选择、不自动导入。

原生目录能力只依据提取的 rc.2 WorkspaceController/生成契约只读核实；具体 picker 后端与系统对话框未实际启动，使用合成能力替身，不把对象树或 HTTP 测试冒称实机视觉验收。恢复补充根目录/父目录替换测试：即使处于元数据标记阶段也不能向替换后的目录写入；位置不变时取消仍保留常量安全标记。

## 0.7.0 选择式项目管理与批次下载

新增 Client 测试覆盖已选列表/搜索添加/移除的正向语义，确保不改上传白名单；方向键/Enter、Tab 不添加、IME、Escape、指针焦点、空结果与 100 项候选上限均有对象树/事件回归。版本刷新仅在明确的 latest 模式跟随唯一 head，显式历史版本不会被替换；对话框通过内部阶段切换，而非叠加多层。

Host 批次测试使用真实 loopback 云服务和磁盘，原生选择器/会话导入为合成替身。覆盖同名目录原子预留、完整同组全部准入、页面中止后仍执行剩余项、单项独立失败、权限/取消停止剩余项、过期/幂等/容量、摘要校验、每项显式导入与部分持久化 ID。专门注入本机锁文件收尾失败，确认文件成功结果不被改写，同时有固定警告而非吞错或自动清理。

生产 Client → RPC → Host → HTTP 联合用例只选 3 个云端项目中的 2 个，验证原生父目录只选择一次、同名项目落到不同新目录、只发一次 downloadstart（没有浏览器逐项 restore 循环）、关闭页面后仍完成整批，以及两个项目分别确认导入。未知回包不自动重放。

这里只验证合成事件与数据链路，未实际启动 OS 目录对话框、安装进真实 profile 或做浏览器视觉/焦点实机验收；没有为了预览另起替代 GUI，也没有下载另一份 React 或其他运行时依赖。

## 0.8.0 云端最新内容

新增测试确认新图形界面不再请求或呈现检查点/版本列表，添加项目只改变包含选择。latest 计划、浏览与任务回包需要显式模式标记，不能接受旧固定点降级；真正固定的检查点 ID 仅在 Host 结果内部保留。

真实 loopback 用例制造多个 head 与严重设备时钟偏差，验证取最后成功提交，而非时间最大、唯一 head 或孤立/拒绝的提交。选完保存位置后再提交新内容，下载仍取新内容且不改变已确认路径；传输中新增内容不混入，重复同 requestId 不再次查最新或写入，新请求才取得新内容。已有目录和其他云端历史不受影响。

慢速准入测试覆盖页面/Host/退出取消、原生 token、revision、provider、父目录替换、占用及新增保护根、计划过期；所有失败都发生在目标创建前。最新实际清单决定导入摘要与资格，后续独立完整性错误与权限错误仍按原有批次策略报告。

以上使用生产状态/RPC/Host、真实测试云服务与合成 picker/会话导入，不代表真实 GUI、原生系统对话框或线上部署已验收；没有修改真实安装/profile。

## 注意测试层次

- HTTP 集成启动了本项目真实服务器，通过真实 `fetch` 和磁盘存储验证；不是仅 mock 网络。
- 会话适配主测试使用显式注入的 mock SDK/provider，依据本次安装的实际接口构造；**不是当前桌面 profile 的生产集成测试**。
- 插件 controller 测试中的授权/会话 service 为隔离 mock，云服务是真 HTTP。通过该测试不意味着当前 UI 已新增登录页或安装了插件。
- Linux systemd、Caddy TLS、跨真实 Windows/Linux 机器、长时间断网/断电和真实 DSH GUI 都需要后续实机验收。

## 实测修复的回归

1. Windows junction 的 `lstat().isSymbolicLink()` 可能为 false；增加 realpath 对比和祖先检查。
2. 类似 `state[1]` 的字面目录不能当作未转义 glob；改用字面包含关系，避免 token 被收进项目。
3. 插件先发送旧队列再检查新 root 会违反授权范围；现在先检查完整待发队列。
4. 可解析但大于 8MiB 的 manifest 必须在入队前拒绝，防止队列无法再读取。
5. 过期 token 的 401 不应阻止本地退出；网络故障则明确远端撤销未确认。
6. `toString` 等项目 ID 不能命中对象原型，使用 own-key 检查。
7. 客户端 token 格式与服务的 32-byte base64url 对齐。
8. 配置 `null/false` 不能回退旧权限；native/local/preferences 身份必须完整一致，不可跨 profile 或账号发送队列。
9. workspace 在第一份 blob 后被删除时，后续 blob/commit 必须停止；历史队列也重验受保护目录。
10. 原生 Node→Request bridge 不允许 GET streaming body，因此设置 API 全部采用 POST；客户端只走 Connection。
11. pending 是待重试而非运行，不能永远禁用“立即同步”；运行中也必须能保存取消选择和退出。
12. 登录响应只能取 token/expiry，不能覆盖可信 server；旧损坏 grant 不应阻断本地退出或误报新登录失败。
13. 宿主身份刷新时清空旧密码，防止未提交的密码被带到新地址；取消/停止与原生提交、配置落盘之间有回滚/等待。

## 后续实机验收清单

在用户批准的独立测试 profile 中：

- 安装/升级 bundle、确认 native peer 版本，刷新原页面后在设置导航看到“个人云同步”；核对表单、控件和移动/窄窗口布局。
- 不改 YAML、不用 CLI，仅通过页面输入服务器/账号/密码登录；确认登录输入收起、用户名正确，退出/过期后密码框为空。通过“同步项目 → 管理”选择并保存，检查搜索、键盘焦点、关闭保留草稿与保存错误展示；重启后配置仍在，其他 profile 不共享登录。
- 将云服务与插件都升级到 0.3.1，在简洁页面打开修改密码；验证新密码 7 位拒绝、8 位接受、错误当前密码被拒绝、正确时所有旧 token 失效、重新登录成功、项目/检查点保留；用测试实例验证旧 bootstrap 文件不需要更新。
- 创建普通会话，包含文本、已完成工具调用、图片/文件附件、项目内产物。
- 页面点击立即同步并查看结果，再开启自动同步；同步中取消选择/关闭自动并保存，或退出登录；运行中不得将不完整检查点标成可恢复。
- 用第二个独立 profile 与新目录恢复/导入，确认新会话 ID、workspace 注册和附件渲染；不自动运行。
- 验证含 goal、subagent、未知插件事件等日志仍保留存档，未适配的续接明确拒绝。
- 双端离线修改并上线，确认多个 heads、无本地覆盖；人为终止上传后重试。
- 完成 Linux HTTPS 反代、防火墙、备份恢复和磁盘监控验收。

不得直接用真实会话试验破坏性恢复。测试通过后再由用户决定是否部署和授权数据上传。
