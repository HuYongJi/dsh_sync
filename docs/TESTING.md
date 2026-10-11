# 测试与兼容性

## 可重复的主测试

```sh
node --test --test-isolation=none tests/*.test.mjs
```

当前开发验证环境为 **Windows / Node.js 25.8.1**。全套测试已经运行：**179 项通过，0 失败，0 跳过**。服务只监听测试进程动态分配的 loopback 端口，使用测试密码和合成数据；临时文件局限在本仓库 `.test-tmp` 的独立子目录。

`--test-isolation=none` 避免 Windows 受限环境中测试运行器为子进程建立捕获管道。未开启替代 Web GUI 服务器、未访问真实账号数据、未上传真实项目、未修改已安装 DSH 或日常 profile。

| 测试集 | 项数 | 覆盖 |
|---|---:|---|
| [核心快照测试](../tests/core.test.mjs) | 10 | 路径穿越、Windows 保留名/大小写冲突、真实 junction、二进制/Unicode、秘密排除、恢复拒绝覆盖、损坏检查、离线队列、锁、CLI preview |
| [真实 HTTP 集成](../tests/integration.test.mjs) | 2 | 两设备登录/上传/恢复、会话封套与资产字节、并发分支、幂等提交、服务重启后 token 持续、CLI 登录到登出 |
| [安全与插件回归](../tests/regressions.test.mjs) | 8 | 含 glob 字符的 state 目录、旧队列授权边界、manifest 字节上限、原型字段 ID、失效 token 登出、原生账号切换、插件注册、controller + 真实 HTTP |
| [云端服务测试](../tests/server.test.mjs) | 15 | 认证/撤销/期限、scrypt 持久化、独占锁、校验与限额、并发提交、冲突、设备绑定、速率/并发/超时、环境启动、目录跳转 |
| [会话适配测试](../tests/adapter.test.mjs) | 20 | 完整/活动/未落盘会话、revision 与高水位、待处理 inbox、未知领域归档但拒绝续接、资源完整性、结构化路径映射、全新 ID、部分写失败、codec/stream 失败关闭 |
| [设置页 Client](../tests/settings-client.test.mjs) | 44 | 原生槽位/控件契约、密码清理、RPC-only、可用项目选择、revision 冲突、离线重试、运行中取消/退出、有限轮询、旧响应隔离、确定性 bundle |
| [设置页 Host 与完整链路](../tests/settings-host.test.mjs) | 27 | 图形登录到真实 HTTP 云服务、profile 隔离、配置持久化、每次发送前权限复核、活动取消、受保护旧队列、损坏/回滚、安全请求解析、Client 状态→Host RPC→实际同步闭环 |
| [改密 Client](../tests/password-client.test.mjs) | 20 | 三个密码框清理、CAS 身份绑定、确认不发送、长度规则、当前密码拒绝、未知结果锁定、取消/超时不重发及精简 UI |
| [改密 Host 与链路](../tests/password-host.test.mjs) | 19（含 2 个子测试） | 真实云端改密、所有旧 token 撤销、旧服务能力探测、intent 持久化/恢复、损坏回包、清理失败、秘密不落盘、Client→Host→云端闭环 |
| [改密云服务](../tests/password-server.test.mjs) | 14 | 当前密码而非 token 鉴权、Unicode/JSON 边界、原子撤销、并发 CAS、旧登录/写入竞态、重启兼容及失败原子性 |

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
