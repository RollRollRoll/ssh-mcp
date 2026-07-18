# 任务清单：SSH MCP

> 状态：已确认（2026-07-17）  
> 日期：2026-07-17  
> 对应设计：[SSH MCP 技术设计](../design/2026-07-17-ssh-mcp-design.md)  
> 对应规格：[SSH MCP Spec](../specs/2026-07-17-ssh-mcp-spec.md)

## 1. 背景与范围

本清单把已确认的 SSH MCP 技术设计拆为 13 个可独立验收的 S/M 任务。仓库当前是 greenfield，仅有规格与设计文档，因此任务覆盖从 Node.js/TypeScript 工程基线到 MCP、SSH、终端、文件传输、多主机和 CI 验收的完整实现。

拆分原则：

- 先完成审批、主机信任、SSH 接缝、状态机等高风险地基，再实现业务能力。
- 功能任务按“工具接口 → 领域逻辑 → SSH/文件接缝 → 测试”的垂直切片交付。
- 测试随任务实现，不把功能测试集中推迟到最后。
- 不实现生产主机、动态连接、秘密采集、隧道、自动重试、恢复、审计或独立 UI/API。

## 2. 拆分假设

- **假设 A1：** npm 包名暂用 `ssh-mcp`；包发布不是本版验收条件。
- **假设 A2：** 源码使用 `src/`，测试使用 `tests/unit`、`tests/contract`、`tests/integration`、`tests/acceptance`。
- **假设 A3：** 没有 ESLint/Prettier 等额外质量工具；类型检查与 Vitest 是统一本地检查入口，避免引入设计外依赖。
- **假设 A4：** CI 使用 GitHub Actions，Linux job 可使用 Docker，Windows job 可启用系统 OpenSSH Server。若仓库最终托管平台不同，只替换 Task 13 的 CI 配置文件，不改变前 12 个任务。
- **假设 A5：** 每个任务先写本任务验收测试，再完成实现；验证命令以任务完成后存在的 npm scripts 为准。

## 3. 任务列表

### Task 1：建立 TypeScript、MCP stdio 与测试工程基线

- 切片：地基任务；提供所有后续任务共享的可构建、可测试进程骨架。
- 规模：M。
- 涉及文件：`package.json`、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`、`src/index.ts`、`src/server.ts`、`tests/contract/server-bootstrap.test.ts`。
- 依赖：none；可并行：否；高风险：否。
- 验收标准：
  - Node.js 24 LTS 下可用 npm 从锁文件安装依赖，并完成 ESM TypeScript 构建。
  - 锁定设计指定的 MCP SDK v1、Zod、`ssh2`、`yaml`、TypeScript 和 Vitest 依赖，不引入 HTTP 服务框架或自动重连 SSH 包装库。
  - MCP 服务可通过 stdio 完成初始化与工具列表请求；stdout 不出现诊断文本。
  - `npm run build`、`npm run typecheck`、`npm test` 三个入口可运行，失败时返回非零退出码。
  - 启动入口只接受配置定位参数/环境变量，不提供主机、命令或传输 CLI。
- 验证方式：`npm ci && npm run build && npm run typecheck && npm test -- tests/contract/server-bootstrap.test.ts`。
- 覆盖：设计 3.1、3.2、4、5.1 `Bootstrap/StdioMcpServer`；规格 Requirement「MCP 行为与输入校验」的能力发现基础；MUST NOT「独立 CLI、HTTP API、网页或桌面管理界面」。
- [x] 完成

### Task 2：交付严格配置加载与登记主机发现

- 切片：配置文件 → 不可变主机注册表 → `hosts_list` MCP 工具的首条端到端能力。
- 规模：M。
- 涉及文件：`src/config/schema.ts`、`src/config/loader.ts`、`src/hosts/host-registry.ts`、`src/tools/hosts-list.ts`、`tests/unit/config.test.ts`、`tests/contract/hosts-list.test.ts`。
- 依赖：Task 1；可并行：可与 Task 3 并行，文件不冲突；高风险：否。
- 验收标准：
  - YAML 1.2 配置按严格 Schema 读取，拒绝未知字段、自定义标签、别名、重复主机、0/11 台主机、非法环境、平台/Shell 不匹配和非绝对敏感路径。
  - 配置接受 1 台和 10 台唯一的 development/test 主机，并支持 Agent、Pageant、本地私钥文件三种判别联合。
  - 配置 Schema 不存在 password、passphrase、动态 host/port/username 等 MCP 输入字段。
  - `hosts_list` 按别名字典序返回公开字段和当前进程可观察连接状态，不联网、不显示认证配置。
  - `lowRiskProfiles` 默认为空；配置只在启动时读取一次，MCP 无配置写入口。
  - 不支持的配置版本和损坏配置阻止服务进入可操作状态。
- 验证方式：`npm test -- tests/unit/config.test.ts tests/contract/hosts-list.test.ts && npm run typecheck`。
- 覆盖：设计 3.6、5.1 `ConfigLoader/HostRegistry`、6.1；规格 Requirement「登记主机边界」「认证与敏感信息隔离」的配置边界；MUST NOT 1、2、3、4、6、7、12、13 的前置约束。
- [x] 完成

### Task 3：建立不可变操作意图、审批、错误、脱敏与日志契约

- 切片：安全地基任务；把任意需审批输入转换为一次性、可验证、无秘密的授权结果。
- 规模：M。
- 涉及文件：`src/approval/operation-intent.ts`、`src/approval/approval-service.ts`、`src/errors/error-contract.ts`、`src/observability/logger.ts`、`tests/unit/approval.test.ts`、`tests/unit/redaction.test.ts`。
- 依赖：Task 1；可并行：可与 Task 2 并行，文件不冲突；高风险：是，前置验证 MCP form elicitation 的客户端能力与中断行为。
- 验收标准：
  - `OperationIntent` 使用稳定 canonical JSON 和 SHA-256 摘要，创建后不可变；主机集合、命令、输入、路径、递归或覆盖任一变化都会得到不同摘要。
  - form elicitation 展示同一 Intent 生成的完整操作信息；接受只消费一次，拒绝、取消、2 分钟超时或断链都返回 `sideEffects=none`。
  - 客户端未声明 form elicitation 时返回 `APPROVAL_UNSUPPORTED`，不静默降级。
  - 稳定错误结构包含 code、finalState、retriable、sideEffects 和已脱敏关联字段。
  - stdout 只用于 MCP；stderr 单行 JSON 日志不包含命令全文、输入内容、私钥路径/内容、Agent 报文或完整配置。
  - 测试以假审批客户端证明批准前 SSH 和文件系统执行调用数为 0。
- 验证方式：`npm test -- tests/unit/approval.test.ts tests/unit/redaction.test.ts && npm run typecheck`。
- 覆盖：设计 3.2、5.1 `ApprovalService/SecretRedactor/ErrorMapper/Logger`、9.1、11、12、13；规格 Requirement「MCP 行为与输入校验」「操作授权」「结果与错误契约」；MUST NOT 1、2、4、5、10。
- [x] 完成

### Task 4：实现严格主机信任、SSH 认证与平台探针

- 切片：登记主机 → 主机密钥确认 → 认证 → 固定平台探针的单主机连接闭环。
- 规模：M。
- 涉及文件：`src/ssh/host-key.ts`、`src/ssh/trust-store.ts`、`src/ssh/ssh-adapter.ts`、`src/ssh/platform-probe.ts`、`tests/unit/trust-store.test.ts`、`tests/integration/linux/connection.test.ts`、`tests/fixtures/openssh-linux/`。
- 依赖：Task 2、Task 3；可并行：完成前置后可与 Task 5 并行，文件不冲突；高风险：是，前置验证异步 `hostVerifier`、Agent/Pageant 与真实 OpenSSH 事件语义。
- 验收标准：
  - 每次连接都安装 `hostVerifier`；未知密钥展示别名、配置地址、算法和完整 SHA-256 指纹，接受后才认证。
  - 已信任原始公钥字节一致时直接认证；变化时报告旧/新指纹并硬拒绝，当前任务无绕过入口。
  - JSON 信任库使用 version 1、锁文件、重读、同目录临时文件和原子替换；损坏、锁失败或权限错误关闭失败。
  - 认证只使用 Agent、Pageant 或本地私钥文件；缺失 Agent、空 Agent、加密私钥未预载和交互认证分别返回稳定类别，不采集秘密。
  - Linux/Windows 固定只读探针验证声明平台与 Shell；不兼容时返回 `PLATFORM_MISMATCH`，不猜测或切换语言。
  - `ssh2` 适配层不暴露端口、代理、X11、Agent 转发或隧道能力，也不自动重连。
  - Linux OpenSSH 容器验证首次信任、一致信任、密钥变化、认证成功/失败和连接超时。
- 验证方式：`npm test -- tests/unit/trust-store.test.ts && npm run test:integration:linux -- connection && npm run typecheck`。
- 覆盖：设计 3.3、3.4、5.1 `TrustStore/SshAdapter`、6.2、9.2；规格 Requirement「主机身份信任」「认证与敏感信息隔离」「跨平台行为」；MUST NOT 1、4、8、11、13。
- [x] 完成

### Task 5：实现操作状态机、有界输出与通用查询取消

- 切片：地基任务；让后续命令和传输运行器共享可独立验证的生命周期契约。
- 规模：M。
- 涉及文件：`src/operations/state-machine.ts`、`src/operations/output-buffer.ts`、`src/operations/operation-manager.ts`、`src/tools/operation-control.ts`、`tests/unit/operation-manager.test.ts`、`tests/contract/operation-control.test.ts`。
- 依赖：Task 2；可并行：可与 Task 4 并行，文件不冲突；高风险：是，前置验证取消确认、输出淘汰和竞态状态不会误报。
- 验收标准：
  - 状态机只允许设计定义的转换，并区分 awaiting_approval、running、completed、failed、timed_out、cancelled、partial_failure、unknown。
  - 取消只有在运行器确认停止时进入 cancelled；10 秒内无法确认进入 unknown，且 `retriable=false`。
  - 假时钟覆盖连接/命令/会话/传输/审批/取消和 15 分钟结果保留预算，不存在无限等待。
  - 8 MiB 原始字节环形缓冲保持 frame 到达顺序、stdout/stderr 标签、UTF-8/base64 无损表达、cursor、minCursor 和精确 droppedBytes。
  - `operation_get` 每次默认返回 64 KiB、最大 256 KiB；旧 cursor 明示截断，未来 cursor 返回 `INVALID_CURSOR`。
  - `operation_cancel` 对未开始、运行中和终态操作具有设计规定的幂等行为；不自动重试或重放。
  - 活动操作最多 32 个，过期 ID 与未知 ID 返回不同稳定错误。
- 验证方式：`npm test -- tests/unit/operation-manager.test.ts tests/contract/operation-control.test.ts && npm run typecheck`。
- 覆盖：设计 5.1 `OperationManager`、7.11–7.12、8.1、8.3、10、11；规格 Requirement「单次命令执行」的输出边界、「长任务、超时与取消」「结果与错误契约」；MUST NOT 9、10、12。
- [x] 完成

### Task 6：交付单主机原始命令执行闭环

- 切片：`command_run` → 一次性审批 → SSH exec → 增量输出/终态/取消的首条远程操作能力。
- 规模：M。
- 涉及文件：`src/commands/command-builder.ts`、`src/commands/command-runner.ts`、`src/tools/command-run.ts`、`tests/contract/command-run.test.ts`、`tests/integration/linux/command.test.ts`、`tests/integration/windows/command.test.ts`。
- 依赖：Task 3、Task 4、Task 5；可并行：可与 Task 9 并行，文件不冲突；高风险：否，SSH 与状态风险已由前置任务收敛。
- 验收标准：
  - 严格拒绝空命令、未知主机和额外字段；本任务阶段 `hosts` 长度必须为 1，Task 12 再把同一契约扩展到 1–10 台显式主机。
  - 原始命令始终请求精确审批，批准后返回 `operationId/state=running`，拒绝时不连接。
  - Linux 使用登记 POSIX Shell；Windows 使用登记 PowerShell 和 UTF-16LE `EncodedCommand`，不做跨平台翻译。
  - 成功、非零退出、SSH 故障、连接超时、命令超时分别产生可区分结果，并保留已有 stdout/stderr/exitCode/signal。
  - TERM 被服务端确认时取消；忽略信号或强制断链不能误报 cancelled。
  - 中文、CRLF、无效 UTF-8 和超过缓冲范围的输出均按 Task 5 契约读取。
- 验证方式：`npm test -- tests/contract/command-run.test.ts && npm run test:integration:linux -- command`；Windows 环境执行 `npm run test:integration:windows -- command`。
- 覆盖：设计 7.2、9.3；规格 Requirement「操作授权」「单次命令执行」「跨平台行为」「结果与错误契约」；MUST NOT 10、13。
- [ ] 完成

### Task 7：交付结构化低风险 Profile 自动执行

- 切片：只读 YAML Profile → 参数策略校验 → 平台命令编译 → 无逐次审批执行。
- 规模：M。
- 涉及文件：`src/policy/profile-schema.ts`、`src/policy/policy-engine.ts`、`src/policy/profile-compiler.ts`、`src/tools/profile-run.ts`、`tests/unit/policy.test.ts`、`tests/contract/profile-run.test.ts`。
- 依赖：Task 6；可并行：否，复用命令运行器并修改工具注册；高风险：是，需证明组合命令不能绕过自动执行边界。
- 验收标准：
  - Profile 只接受显式 hostAliases、单一平台、固定 executable/Cmdlet、fixedArgs 和 enum/integer/boolean/remotePath 参数。
  - 本任务阶段 `profile_run.hosts` 长度必须为 1；Task 12 再扩展到 1–10 台，并保持同一策略语义。
  - 默认 Profile 集为空；MCP 无新增、修改、删除、放宽或覆盖 Profile 的工具。
  - Linux 和 PowerShell 编译器对每个参数做类型/范围/路径校验和字面量转义；自由文本、换行、NUL、管道、重定向、命令替换和部分匹配不进入自动路径。
  - 完整匹配的 Profile 自动执行；不完整或不确定时整体返回 `POLICY_REQUIRES_APPROVAL`，不自动改调 `command_run`，也不执行安全子集。
  - Profile 仍沿用 Task 6 的平台、输出、超时和错误契约。
- 验证方式：`npm test -- tests/unit/policy.test.ts tests/contract/profile-run.test.ts && npm run typecheck`。
- 覆盖：设计 3.5、5.1 `PolicyEngine/CommandCompiler`、6.1 lowRiskProfiles、7.3；规格 Requirement「操作授权」「跨平台行为」；MUST NOT 2、6、10、13。
- [ ] 完成

### Task 8：交付持久 PTY 交互会话

- 切片：session_open/write/read/resize/close 五类交互 → 独占 SSH PTY → 状态、审批、输出游标和空闲关闭。
- 规模：M。
- 涉及文件：`src/sessions/session-manager.ts`、`src/sessions/session-input-queue.ts`、`src/tools/session-tools.ts`、`tests/unit/session-manager.test.ts`、`tests/contract/session-tools.test.ts`、`tests/integration/linux/session.test.ts`、`tests/integration/windows/session.test.ts`。
- 依赖：Task 6、Task 7；可并行：否，需串行修改工具注册；高风险：是，需验证 PTY 事件、控制字符与关闭确认竞态。
- 验收标准：
  - `session_open` 精确审批后为单台登记主机创建独占连接和 PTY，返回唯一 ID、平台、Shell、active 状态和 cursor。
  - 同一会话保持目录和 Shell 上下文；不同会话的连接、输入队列、输出和生命周期相互隔离。
  - `session_write` 的 UTF-8/base64 输入逐次审批并严格串行；控制字符不被服务推测或重放。
  - `session_read` 遵循 Task 5 的有界缓冲与 cursor 契约；`session_resize` 精确审批后调用 `setWindow`。
  - `session_close` 无需审批且幂等；无效、关闭、断开会话拒绝写入，不创建或恢复会话。
  - 30 分钟空闲触发关闭；20 个活动会话上限；关闭记录保留 15 分钟；网络中断不自动重连。
  - Linux 与 Windows 真实测试覆盖持久上下文、中文、控制字符、尺寸变化、并发会话和断连。
- 验证方式：`npm test -- tests/unit/session-manager.test.ts tests/contract/session-tools.test.ts && npm run test:integration:linux -- session`；Windows 环境执行 `npm run test:integration:windows -- session`。
- 覆盖：设计 5.1 `SessionManager`、7.4–7.8、8.2、9.4；规格 Requirement「交互会话」「长任务、超时与取消」「跨平台行为」；MUST NOT 10、12、13。
- [ ] 完成

### Task 9：实现本地、Linux 与 Windows 路径安全守卫

- 切片：用户路径 → 词法边界 → canonical/逐段链接校验 → 可供传输安全使用的路径句柄。
- 规模：M。
- 涉及文件：`src/paths/local-path-guard.ts`、`src/paths/linux-path-guard.ts`、`src/paths/windows-path-guard.ts`、`src/paths/windows-reparse-probe.ts`、`tests/unit/path-guards.test.ts`、`tests/integration/windows/path-guard.test.ts`。
- 依赖：Task 4；可并行：可与 Task 6 并行，文件不冲突；高风险：是，优先验证 Windows SFTP 属性与重解析点探针的组合关闭失败策略。
- 验收标准：
  - 审批前只做字符串与 Schema 校验；批准前不 lstat、realpath、读取文件或执行远端探针。
  - 本地路径按运行平台处理绝对路径、根边界、`..`、逐段 lstat/realpath、可用时 `O_NOFOLLOW` 和打开后复核。
  - Linux 远端按 POSIX 路径段比较，使用 SFTP realpath/lstat 拒绝越界和任意 symlink。
  - Windows 正确处理盘符、分隔符和不区分大小写比较；固定 PowerShell `LiteralPath` 探针逐段拒绝 symlink、junction、mount point 和其他 ReparsePoint。
  - 用户路径只作为 base64 JSON 数据进入固定探针，不能形成 PowerShell 片段；SFTP/探针不一致或无法确认时返回 `PATH_DENIED`。
  - 每个文件打开前重新校验；检测到 TOCTOU 变化时停止且不访问越界目标。
- 验证方式：`npm test -- tests/unit/path-guards.test.ts && npm run typecheck`；Windows 环境执行 `npm run test:integration:windows -- path-guard`。
- 覆盖：设计 5.1 `PathGuard`、9.5、风险 2/3；规格 Requirement「文件与目录传输」的越界/链接场景、「跨平台行为」；MUST NOT 9、13。
- [ ] 完成

### Task 10：交付单文件上传与下载

- 切片：file_upload/file_download → 精确审批 → 路径守卫 → SFTP 流 → 临时文件/原子提交 → 进度结果。
- 规模：M。
- 涉及文件：`src/transfers/file-transfer.ts`、`src/transfers/atomic-target.ts`、`src/tools/file-transfer-tools.ts`、`tests/unit/file-transfer.test.ts`、`tests/contract/file-transfer-tools.test.ts`、`tests/integration/linux/file-transfer.test.ts`、`tests/integration/windows/file-transfer.test.ts`。
- 依赖：Task 3、Task 4、Task 5、Task 9；可并行：否，需修改工具注册；高风险：是，需验证跨平台原子替换能力与取消后的临时文件状态。
- 验收标准：
  - 上传/下载只接受已登记主机和已配置根下的绝对路径，始终展示源、目标、覆盖与主机后审批。
  - 本任务阶段传输目标主机必须恰好 1 台；Task 12 再扩展到 1–10 台并处理下载目录隔离。
  - 审批后才读取源元数据/内容、连接远端或创建临时目标。
  - 普通文件通过流传输，字节数和进度按实际值报告；二进制内容无编码或换行转换，传输后内容一致。
  - 目标不存在时写同目录 `.ssh-mcp-<uuid>.part`，完成、关闭并校验字节数后再 rename。
  - `overwrite=false` 时目标存在即停止；`overwrite=true` 只在可保持旧目标或原子替换时执行，否则返回 `ATOMIC_REPLACE_UNSUPPORTED`。
  - 超时/取消/失败不把不完整目标报告为成功；临时文件清理失败在 sideEffects 中明确报告。
  - 无续传、chmod/chown/utimes 或符号链接复制调用。
- 验证方式：`npm test -- tests/unit/file-transfer.test.ts tests/contract/file-transfer-tools.test.ts && npm run test:integration:linux -- file-transfer`；Windows 环境执行对应脚本。
- 覆盖：设计 5.1 `TransferService`、7.9–7.10、9.6、10；规格 Requirement「操作授权」「长任务、超时与取消」「文件与目录传输」「结果与错误契约」；MUST NOT 9、10。
- [ ] 完成

### Task 11：交付递归目录传输与逐项部分失败

- 切片：已批准目录 → 安全枚举 → 稳定逐文件传输 → 逐项进度与聚合终态。
- 规模：M。
- 涉及文件：`src/transfers/directory-walker.ts`、`src/transfers/directory-transfer.ts`、`src/transfers/file-transfer.ts`、`tests/unit/directory-transfer.test.ts`、`tests/integration/linux/directory-transfer.test.ts`、`tests/integration/windows/directory-transfer.test.ts`。
- 依赖：Task 10；可并行：否，共享传输实现；高风险：否，路径和单文件风险已由前置任务收敛。
- 验收标准：
  - `recursive=false` 遇到目录时拒绝；`recursive=true` 按相对路径稳定字典序枚举并保持普通文件内容和目录层级。
  - 每个枚举项和传输前都再次执行路径守卫；任意 symlink、junction 或 reparse point 明确失败且不跟随/复制。
  - 单主机目录内逐文件执行，报告当前项、已传字节、完成项数量及每项结果。
  - 目标目录已存在时拒绝，不静默合并、重命名或目录替换；`overwrite=true` 不放宽此规则。
  - 部分文件失败、超时或取消时分别列出成功、失败、未执行项，整体为 partial_failure/cancelled/unknown，不回滚已完成项。
  - 中断后重新调用从头执行，不使用偏移续传，也不宣称保留权限、所有者或时间。
- 验证方式：`npm test -- tests/unit/directory-transfer.test.ts && npm run test:integration:linux -- directory-transfer`；Windows 环境执行对应脚本。
- 覆盖：设计 9.6；规格 Requirement「文件与目录传输」的递归、链接、部分失败和进度场景；MUST NOT 9、10。
- [ ] 完成

### Task 12：交付命令、Profile 与传输的多主机协作

- 切片：显式主机集合 → 完整集合审批/策略 → 并行或顺序子操作 → 逐主机与整体终态。
- 规模：M。
- 涉及文件：`src/multihost/multi-host-coordinator.ts`、`src/commands/command-runner.ts`、`src/transfers/directory-transfer.ts`、`src/tools/command-run.ts`、`src/tools/profile-run.ts`、`src/tools/file-transfer-tools.ts`、`tests/unit/multi-host.test.ts`、`tests/acceptance/multi-host.test.ts`。
- 依赖：Task 7、Task 11；可并行：否，汇合并修改命令/Profile/传输工具；高风险：是，需验证取消与聚合优先级不会覆盖逐主机事实。
- 验收标准：
  - 命令、Profile、上传、下载接受 1–10 个唯一登记别名；2–10 台按多主机语义，0、重复、未知、11 台在任何主机执行前整体拒绝。
  - Intent 摘要绑定完整有序主机集合；集合或顺序变化需新审批/匹配。
  - parallel 模式最多并行 10 个独立连接；sequential 严格按请求顺序启动。
  - 任一主机失败不终止其他已启动主机；每台保留独立输出、进度、错误与终态，整体按 unknown 优先和部分失败规则聚合。
  - 取消后不启动剩余主机，分别尝试停止运行项，并保留已完成项；不回滚成功主机。
  - 多主机下载写入 `<localTarget>/<hostAlias>/...`，主机间不会互相覆盖。
  - 验收覆盖 2 台成功、10 台边界、11 台拒绝和至少 1 台失败的部分结果。
- 验证方式：`npm test -- tests/unit/multi-host.test.ts tests/acceptance/multi-host.test.ts && npm run typecheck`。
- 覆盖：设计 5.1 `MultiHostCoordinator`、9.7、14；规格 Requirement「多主机协作」及关联命令/传输场景；MUST NOT 6、10。
- [ ] 完成

### Task 13：建立 Linux/Windows CI、MCP 合同验收与使用文档

- 切片：交付收口；把已实现能力放入可重复的协议、平台、安全和文档验收矩阵。
- 规模：M。
- 涉及文件：`.github/workflows/ci.yml`、`package.json`、`package-lock.json`、`tests/acceptance/spec-coverage.test.ts`、`tests/contract/mcp-inspector.test.ts`、`README.md`、`docs/configuration.md`。
- 依赖：Task 8、Task 12；可并行：否，最终汇合；高风险：否，真实平台风险应已在对应能力任务中暴露。
- 验收标准：
  - Linux CI 从干净环境执行 npm ci、build、typecheck、unit、contract、Linux OpenSSH integration 和 acceptance。
  - Windows CI 在受支持 runner 上启用系统 OpenSSH Server/SFTP，执行 PowerShell、PTY、盘符/大小写/reparse point、文件/目录与取消测试。
  - MCP Inspector 验证 stdio framing、工具发现、严格输入、form elicitation、结构化结果和状态查询/取消。
  - `spec-coverage` 将规格每个 Scenario 映射到至少一个自动化测试 ID，并单独验证批准前零副作用和 13 条 MUST NOT。
  - README 说明 Node 24、启动方式、客户端能力基线和非目标；配置文档说明完整 YAML、Agent/Pageant/私钥准备、TOFU、路径根、Profile 和默认预算，不包含真实秘密。
  - `npm run check` 在干净环境统一执行 build/typecheck/不依赖外部主机的测试并返回 0；平台集成脚本可分别运行。
  - 工具清单只有设计定义的 12 个 MCP 工具，没有规则写入、凭据管理、动态主机、转发、恢复、审计、HTTP 或 UI 入口。
- 验证方式：`npm ci && npm run check && npm run test:contract && npm run test:integration:linux && npm run test:acceptance`；在 Windows runner 执行 `npm run test:integration:windows`；CI 两个 job 均通过。
- 覆盖：设计 3.7、3.8、4、15、16、18、21；规格全部成功标准、Requirement「MCP 行为与输入校验」「结果与错误契约」及全部 MUST NOT 的最终回归。
- [ ] 完成

## 4. 依赖与并行视图

### 4.1 拓扑顺序

```text
T1
├─ T2 ─┬─ T4 ─┬─ T6 ─ T7 ─ T8 ─┐
│      │      │                 │
│      │      └─ T9 ─ T10 ─ T11 ─ T12 ─ T13
│      └─ T5 ────────────────┘
└─ T3 ─── T4 / T6 / T8 / T10
```

精确依赖：

- T1 → T2、T3。
- T2 → T4、T5。
- T3 → T4。
- T2 + T3 → T4。
- T3 + T4 + T5 → T6。
- T6 → T7 → T8。
- T4 → T9。
- T3 + T4 + T5 + T9 → T10 → T11。
- T7 + T11 → T12。
- T8 + T12 → T13。

### 4.2 可并行波次

- Wave 1：T1。
- Wave 2：T2 ∥ T3；两者不修改同一实现文件。
- Wave 3：T4 ∥ T5；SSH/信任与操作状态文件互不冲突。
- Wave 4：T6 ∥ T9；命令切片与路径守卫文件互不冲突。
- Wave 5：T7。
- Wave 6：T8。
- Wave 7：T10 → T11。
- Wave 8：T12。
- Wave 9：T13。

执行时若同一工作区不能安全合并并行改动，按任务编号串行执行即可，不改变依赖正确性。

### 4.3 Checkpoint

- CP1（T1–T3 后）：`npm run build && npm run typecheck && npm test`；确认 MCP、配置和审批零副作用契约稳定。
- CP2（T4–T6、T9 后）：运行 Linux connection/command 集成测试与 Windows path-guard 测试；确认最不确定接缝可行。
- CP3（T7–T10 后）：运行全部 unit/contract、Linux command/session/file 测试；确认单机能力闭环。
- CP4（T11–T12 后）：运行目录与多主机 acceptance；确认部分失败、取消和无回滚。
- CP5（T13）：Linux/Windows CI、MCP Inspector 和规格覆盖全部通过。

## 5. 拆分探针结论

| 探针维度 | 判定 | 任务落点 / 理由 |
|---|---|---|
| 数据迁移 | 不适用 | greenfield 且无数据库；信任库 version 1 是新建文件，不存在旧数据迁移。 |
| 种子/初始数据 | 需任务（仅测试） | T4 的固定主机密钥/OpenSSH fixture、T9 的 Windows reparse fixture；生产不写演示主机或默认秘密。 |
| 接口契约 | 需任务 | T1/T2/T5–T8/T10/T12 落地 12 个 MCP 工具。 |
| 测试 | 需任务 | 测试嵌入 T1–T12；T13 汇总 Inspector、跨平台 CI 和 Scenario 覆盖。 |
| 回滚/降级 | 不适用 | 纯新增 greenfield、无破坏性迁移或远端部署；运行失败关闭进程即可，不增加 feature flag。 |
| 可观察性 | 需任务 | T3 落地稳定错误、脱敏和 stderr JSON；各能力任务验证状态/进度。 |
| 配置与环境变量 | 需任务 | T2 实现 YAML/配置定位；T13 提供配置与 Agent/Pageant 环境说明。 |
| 依赖安装 | 需任务 | T1 安装并锁定设计依赖；T13 锁定 MCP Inspector 测试依赖。 |
| 构建/CI | 需任务 | T1 建 build/typecheck/test；T13 建 Linux/Windows CI 与统一检查。 |
| 集成点 | 需任务 | T3 MCP Elicitation、T4 `ssh2`/OpenSSH、T9 Windows PowerShell 探针、T13 MCP Inspector。 |
| 文档 | 需任务 | T13 提供 README 与配置、安全边界说明。 |

## 6. 设计覆盖核对

| 设计组件 / 决策 | 任务落点 |
|---|---|
| TypeScript / Node.js 24 / ESM / npm | T1 |
| MCP SDK v1、stdio、稳定协议、自定义操作句柄 | T1、T3、T5、T13 |
| `ConfigLoader` / `HostRegistry` / YAML | T2 |
| `ApprovalService` / immutable Intent | T3 |
| `SecretRedactor` / `ErrorMapper` / `Logger` | T3 |
| JSON `TrustStore` / TOFU / 指纹变化拒绝 | T4 |
| `ssh2`、Agent/Pageant/私钥、平台探针 | T4 |
| `OperationManager` / OutputBuffer / 状态机 | T5 |
| 原始命令执行 | T6 |
| 结构化 `PolicyEngine` / CommandCompiler | T7 |
| `SessionManager` / PTY | T8 |
| Local/Linux/Windows `PathGuard` | T9 |
| `TransferService` 单文件 | T10 |
| 递归目录与部分失败 | T11 |
| `MultiHostCoordinator` | T12 |
| Linux/Windows/Inspector 分层测试 | T4、T6、T8–T13 |
| 版本与兼容、无服务重启恢复 | T2、T5、T8、T13 |

## 7. Spec Requirement 覆盖核对

| Requirement | 任务落点 |
|---|---|
| MCP 行为与输入校验 | T1、T2、T3、T13 |
| 登记主机边界 | T2、T12 |
| 主机身份信任 | T4 |
| 认证与敏感信息隔离 | T2、T3、T4 |
| 操作授权 | T3、T6、T7、T8、T10 |
| 单次命令执行 | T5、T6 |
| 交互会话 | T8 |
| 长任务、超时与取消 | T5、T6、T8、T10–T12 |
| 文件与目录传输 | T9–T11 |
| 多主机协作 | T12 |
| 跨平台行为 | T4、T6–T10、T13 |
| 结果与错误契约 | T3、T5、T6、T10–T13 |

## 8. MUST NOT 覆盖核对

| MUST NOT | 任务落点 |
|---|---|
| 1. 不接受临时主机地址、账号或秘密 | T2 Schema；T4 认证；T13 工具清单回归 |
| 2. 不允许 MCP 修改低风险规则 | T2 只读配置；T7 无写入口；T13 回归 |
| 3. 不操作生产/未标记主机 | T2 配置拒绝；T13 回归 |
| 4. 不提供凭据生命周期/MFA | T2、T4；T13 工具清单回归 |
| 5. 不提供多人权限/长期审计 | T3 仅 stderr；T13 工具清单回归 |
| 6. 不接受通配符、动态组或 >10 主机 | T2、T7、T12 |
| 7. 不提供独立 CLI/HTTP/UI | T1、T13 |
| 8. 不提供转发、代理、X11 或隧道 | T4、T13 |
| 9. 不续传、保元数据、复制/跟随链接 | T9–T11、T13 |
| 10. 不自动重试、事务或回滚 | T5、T6、T8、T10–T12 |
| 11. 指纹变化后不可任务内绕过 | T4、T13 |
| 12. 不跨服务重启恢复会话/任务 | T2、T5、T8、T13 |
| 13. 不跨 Linux/Windows 翻译 | T4、T6、T7、T9、T13 |

## 9. 延后与明确不纳入

以下内容来自规格和设计的后续版本/非目标，不在本清单增加占位任务：

- 实验性 MCP Tasks 或 HTTP Transport。
- 密码、密钥口令、MFA、Keychain 和凭据生命周期。
- 连接池、自动重连、跳板、端口/代理/X11/Agent 转发和隧道。
- 文件续传、权限/时间/所有者保留、符号链接复制或跟随。
- 动态主机组、大规模编排、事务、回滚、跨重启恢复。
- 多用户、角色、长期审计、合规报表和独立 UI/API。

## 10. Review 门禁

本清单通过 Review 的条件：

- 13 个任务的边界、依赖顺序和高风险前置得到确认。
- 每个任务都有可独立判断的验收标准和验证命令。
- 11 个拆分探针维度均已明确判定。
- 设计组件、12 项 Requirement 和 13 条 MUST NOT 均有任务落点。
- 没有引入规格/设计之外的产品能力或实现任务。

**未通过 Review 的任务清单，不进入编码。** 用户明确确认后，才能使用 `agent-toolkit:execute-task` 逐项执行。
