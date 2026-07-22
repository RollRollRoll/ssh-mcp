# 任务清单（delta）：SSH MCP 本机实例控制台

> 状态：已确认（2026-07-22）
> 对应设计：[SSH MCP 本机实例控制台技术设计](../design/2026-07-22-ssh-mcp-local-console-design.md)
> 对应规格：[SSH MCP 本机实例控制台规格](../specs/2026-07-22-ssh-mcp-local-console-spec.md)

## 1. 背景与范围

本清单把已确认的本机实例控制台设计拆为 10 个可独立验收的 S/M 任务。项目是已有 Node.js/TypeScript `stdio` MCP 服务，因此采用 brownfield delta：只列控制台、审批兼容、运行时接缝、前端构建和相关验收，不重列既有 SSH、Session、Transfer 或多主机能力。

本次交付每个 SSH MCP 进程自带一个仅回环访问、与进程同生命周期的独立 React 页面。页面可查看当前实例状态和输出、提交单主机命令/Profile、处理审批及请求取消，但不提供网页终端、文件传输、跨实例聚合、远程访问或持久化。

拆分原则：

- 高风险审批仲裁、访问保护和运行时投影前置验证。
- 以“真实后端行为 → 受限 HTTP 契约 → React 交互 → 自动化测试”的窄垂直切片交付，不建立第二套执行核心。
- 测试随任务落地；最终任务只做跨切片、跨平台、MUST NOT、文档和干净构建收口。
- 未通过本清单 review 前不进入编码；执行时不覆盖或清理与本功能无关的用户改动。

## 2. 拆分假设

- **假设 A1：** 用户已选择约 10 个 S/M 任务的细粒度切法；允许必要地基任务，但功能路径优先按垂直切片验收。
- **假设 A2：** 新后端模块放在 `src/console/` 和 `src/application/`，测试继续使用 `tests/unit`、`tests/contract`、`tests/acceptance`、`tests/integration`；具体文件名可按现有命名风格微调，但不得改变任务边界。
- **假设 A3：** 每个任务先补齐能失败的本任务测试，再实现到通过；验证命令以任务完成后的根 npm scripts 为准。
- **假设 A4：** 不引入浏览器自动化运行时。React 交互使用 Vitest + `happy-dom`，HTTP/SSE/认证边界使用真实 `node:http` 契约测试，浏览器兼容矩阵在最终任务人工验证。
- **假设 A5：** HTTP body、SSE 订阅、keep-alive 和静态资源预算采用代码内固定保守常量并纳入测试，不新增 YAML、环境变量或远程监听开关。
- **假设 A6：** `web/` 与根依赖文件当前可能含用户未提交改动。实施 Task 1 前必须逐文件核对；删除旧 Cloudflare/Next/D1/Drizzle 文件属于高风险文件操作，仍需按仓库规范单独取得明确确认。
- **假设 A7：** 首批浏览器最低版本不在编码任务中自行猜定；Task 10 记录人工验证结果后再写入 README。

## 3. 任务列表

### Task 1：建立 React + Vite 静态构建与统一验证地基

- 切片：地基任务；让控制台前端成为可由 Node.js 进程分发的静态产物，并纳入根构建与测试入口。
- 规模：M。
- 涉及文件：`package.json`、`package-lock.json`、`web/package.json`、`web/vite.config.ts`、`web/tsconfig.json`、`web/index.html`、`web/src/`、`web/tests/`，以及经确认后移除的旧 Next/Vinext/Cloudflare/D1/Drizzle/Tailwind 专属文件。
- 依赖：none；可并行：可与 Task 2、Task 4 并行，文件不冲突；高风险：是，现有 `web/` 和依赖文件存在未提交改动。
- 验收标准：
  - 根目录一次 `npm ci` 可锁定根包与 `web` 依赖；新增运行时只包含设计确认的 React/Vite，组件测试增加 `happy-dom`，不引入 HTTP、WebSocket或全局状态框架。
  - Vite 生成无内联脚本、无外部资源依赖的 `dist/console/` 静态文件；入口使用 React `createRoot()`。
  - 原型视觉中可复用的普通 CSS 得以保留，但构建和运行不再依赖 Next、Vinext、Cloudflare Worker、D1、Drizzle、Tailwind/PostCSS 或 Sites 托管。
  - 根 `npm run build` 和 `npm run check` 覆盖前端 build、typecheck、组件测试与既有后端检查；`node dist/index.js` 不需要另起前端服务。
  - 构建测试证明产物清单可被后端静态资源提供器读取，且不存在远程字体、CDN、分析脚本或 Service Worker。
- 验证方式：`npm ci && npm run build && npm run typecheck && npm run check`；检查 `dist/console/` 资源清单和前端构建测试。
- 覆盖：Design Decision 2、9，常规决策“静态资源/前端状态”，迁移“前端与构建”；Spec 成功标准“统一自动化验证入口”。
- 对现有的影响：替换演示站点构建链，但不改变 SSH MCP 运行行为；必须保留用户已有前端修改中仍符合规格的部分。
- [ ] 完成

### Task 2：实现统一审批协调器与首个决定唯一生效

- 切片：安全地基；把 MCP、网页、超时、取消和关闭统一收敛为一个可独立验证的审批状态机。
- 规模：M。
- 涉及文件：`src/approval/approval-service.ts`、`src/approval/approval-coordinator.ts`、`src/approval/operation-intent.ts`、`src/errors/error-codes.ts`、`tests/unit/approval.test.ts`。
- 依赖：none；可并行：可与 Task 1、Task 4 并行，文件不冲突；高风险：是，本任务修改既有核心授权路径。
- 验收标准：
  - 协调器支持 `dual` 与 `web_only` 路由、有界内存记录、统一期限、保留期和幂等关闭；所有记录只保存安全投影。
  - web-first、MCP-first、多个标签页、accept/decline/cancel/timeout/shutdown 的任意竞争只允许首个同步状态转换生效，副作用闭包调用次数始终为 0 或 1。
  - 接受前再次核对并一次性消费冻结 `OperationIntent`；摘要或任一执行字段变化使旧审批失效。
  - 网页先决定会中止尚未结束的 MCP elicitation；MCP 先决定会发布已处理状态；后到决定返回稳定 `already_resolved`，不能改变结果。
  - MCP 客户端不支持 form elicitation 时，`dual` 项仍在原审批期限内等待网页；无人决定时保守超时且副作用为零。
  - 拒绝、取消、超时、通道断开与执行失败继续具有可区分的安全错误语义，不泄露原始异常或命令。
- 验证方式：`npm test -- tests/unit/approval.test.ts && npm run typecheck`；测试使用计数闭包和可控时钟覆盖完整竞争矩阵。
- 覆盖：Design Decision 6，`ApprovalCoordinator`、审批仲裁与错误处理；Spec Requirement“双通道审批”全部 Scenario。
- 对现有的影响：替换 `ApprovalService` 的单通道失败路径；既有 MCP 调用的批准前零副作用和一次性 Intent 语义保持不变。
- [ ] 完成

### Task 3：统一命令/Profile 应用服务并显式传播审批路由

- 切片：MCP/网页来源 → 同一应用服务 → Policy/CommandRunner/SSH/TOFU 的共享执行与安全判定路径。
- 规模：M。
- 涉及文件：`src/application/command-application-service.ts`、`src/application/profile-application-service.ts`、`src/tools/command-run.ts`、`src/tools/profile-run.ts`、`src/commands/command-runner.ts`、`src/ssh/ssh-adapter.ts`、`src/ssh/host-key.ts` 及对应单元/契约测试。
- 依赖：Task 2；可并行：完成 Task 2 后可与 Task 5 并行，文件不冲突；高风险：是，审批路由贯穿既有 SSH 信任路径。
- 验收标准：
  - MCP `command_run` 和网页命令预览复用 `CommandApplicationService`；MCP `profile_run` 和网页 Profile 预览复用 `ProfileApplicationService`，不复制主机、策略、编译或运行规则。
  - 网页命令/Profile 只接受一个登记主机，产生冻结的完整预览和 `web_only` 审批；确认前不连接 SSH、不执行命令。
  - MCP 来源命令、Session、Transfer 和首次 TOFU 明确使用 `dual`；网页来源命令/Profile 及其首次 TOFU 使用 `web_only`，不得向 MCP 客户端制造无工具上下文审批。
  - Profile 在 MCP 路径继续对完整匹配低风险规则自动执行；网页路径必须展示实际编译命令并二次确认，不放宽 PolicyEngine。
  - Unicode、引号、换行和 Shell 元字符从预览到最终 Shell 输入保持完全一致；不同平台不发生隐式翻译。
  - 指纹变化继续硬拒绝；未知指纹只通过协调器处理，不能因来源不同绕过信任、认证或超时边界。
  - 12 个 MCP 工具名、输入 schema、成功/错误 structuredContent 保持兼容。
- 验证方式：`npm test -- tests/unit/command-runner.test.ts tests/unit/approval.test.ts tests/unit/ssh-adapter.test.ts tests/contract/command-run.test.ts tests/contract/profile-run.test.ts && npm run typecheck`；Linux/Windows 既有命令与 TOFU 集成测试继续通过。
- 覆盖：Design Decision 5、7，`CommandApplicationService`、`ProfileApplicationService`、TOFU route；Spec Requirement“网页发起操作”“安全展示与输入处理”，MUST NOT“网页多主机”“绕过 SSH 安全边界”。
- 对现有的影响：把工具 handler 收窄为薄适配器；既有 MCP 自动 Profile 和安全输出契约不变。
- [ ] 完成

### Task 4：建立控制台权威投影、修订通知与统一取消服务

- 切片：既有内存事实源 → 安全只读投影/变化通知 → 可验证的状态与取消契约。
- 规模：M。
- 涉及文件：`src/operations/operation-manager.ts`、`src/sessions/session-manager.ts`、`src/hosts/host-registry.ts` 或连接跟踪接缝、`src/console/runtime-revision-hub.ts`、`src/console/runtime-snapshot-projector.ts`、`src/console/operation-control-service.ts` 及对应单元测试。
- 依赖：none；可并行：可与 Task 1、Task 2 并行，文件不冲突；高风险：否。
- 验收标准：
  - `OperationManager` 和 `SessionManager` 提供稳定排序的安全只读列表及全局 change hook，不改变 MCP 查询/取消输出契约。
  - Operation 投影只含 ID、来源、类型、主机别名、状态、取消请求、时间、截断和白名单进度；Session/Transfer 只有规格允许的只读摘要。
  - Snapshot 不展开配置、认证信息、路径、任意 result、Error cause 或其他实例数据；空态不产生演示记录或主动 SSH 探测。
  - `RuntimeRevisionHub` 单调递增、合并同一事件循环重复失效并释放订阅，不保存业务事件日志或输出副本。
  - `OperationControlService` 区分待审批取消和运行中取消；重复取消、终态取消、取消/完成竞争与无法确认停止均保留真实最终状态。
  - 已请求取消立即可观察，但只有现有停止证据确认后才展示“已取消”；未知状态不得改写为成功或取消。
- 验证方式：`npm test -- tests/unit/operation-manager.test.ts tests/unit/session-manager.test.ts tests/unit/console-runtime.test.ts && npm run typecheck`。
- 覆盖：Design Decision 8，`RuntimeRevisionHub`、`RuntimeSnapshotProjector`、`OperationControlService`、Operation/Session change hook；Spec Requirement“实例状态总览”“操作状态与输出”“网页取消操作”。
- 对现有的影响：只增加内部观察接缝和安全投影，现有保留期、输出缓冲、资源预算和 MCP structuredContent 不变。
- [ ] 完成

### Task 5：交付本机访问保护、静态资源与受限 HTTP 服务骨架

- 切片：随机实例能力 URL → fragment 换会话 → 受保护静态/API Origin 的本机访问闭环。
- 规模：M。
- 涉及文件：`src/console/console-auth-guard.ts`、`src/console/console-server.ts`、`src/console/static-assets.ts`、`src/console/http-errors.ts`、`tests/contract/console-auth.test.ts`、`tests/contract/console-server.test.ts`。
- 依赖：Task 1；可并行：可与 Task 3 并行，文件不冲突；高风险：是，访问凭证是本功能唯一授权边界。
- 验收标准：
  - 服务只绑定 `127.0.0.1:0`，生成独立随机 `*.localhost` 实例 Origin 和至少 256 bit token；无端口、监听地址或远程访问配置入口。
  - 静态 shell 从 fragment 读取 token，经同源 `POST /api/v1/session` 换取 host-only、HttpOnly、Secure、SameSite=Strict 的会话 Cookie，并立即清除 fragment；token 不进入 query、Web Storage、HTML 或普通日志。
  - 每个受保护请求精确校验回环 socket、Host、Origin、Fetch Metadata 和会话摘要；无凭证、错误凭证、跨实例凭证和不可信来源不返回任何实例数据或产生副作用。
  - 只服务构建清单中的 `/` 和 `/assets/*`；阻止目录穿越、任意磁盘路径、CORS、非白名单 method/path 与反向代理 header。
  - 所有响应带设计规定的 CSP、frame、referrer、MIME、cache header；写请求只接受有限 JSON 和固定自定义 header。
  - 请求体、URL、header、keep-alive 和连接预算有固定上限；错误使用统一 envelope，不回显凭证、stack、配置路径或原始异常。
- 验证方式：`npm test -- tests/contract/console-auth.test.ts tests/contract/console-server.test.ts && npm run typecheck`；同时启动两个测试服务做 Host/Cookie/token 交叉矩阵。
- 覆盖：Design Decision 4、常规决策“HTTP/监听/Cookie/CSRF/页面安全”，`ConsoleAuthGuard` 与 `ConsoleServer` 骨架；Spec Requirement“本机访问保护”，MUST NOT“非回环监听”“仅凭本机授权”“登录/用户/角色”“跨实例聚合”。
- 对现有的影响：新增的 HTTP 仅是实例私有控制台接口，不添加 MCP HTTP Transport 或通用业务 API。
- [ ] 完成

### Task 6：打通实例状态、操作输出与 SSE 自动同步页面

- 切片：真实 RuntimeSnapshot/输出 cursor → 受限只读 API/SSE → React 中文总览和详情页。
- 规模：M。
- 涉及文件：`src/console/console-server.ts`、`src/console/read-routes.ts`、`web/src/console-client.ts`、`web/src/console-reducer.ts`、`web/src/components/`、`web/tests/console-state.test.tsx`、`tests/contract/console-read.test.ts`。
- 依赖：Task 1、Task 4、Task 5；可并行：否；高风险：否。
- 验收标准：
  - `GET /api/v1/snapshot` 只返回当前实例权威安全快照；`GET /api/v1/operations/:id/output` 沿用现有 cursor、最大读取、截断和过期语义。
  - `GET /api/v1/events` 在连接时发送 `ready`，变化时只发送 revision/scope，关闭时发送 `offline`；限制订阅数并在断开后释放资源，不传大输出或维护重放日志。
  - React 页面完成 fragment 会话引导，展示实例在线状态、主机、活动操作、审批计数、Session/Transfer 只读摘要、稳定排序、明确空态和操作输出 stdout/stderr 区分。
  - 新输出、状态和进度无需手动刷新即可出现；刷新、多标签页和断线重连都以新快照覆盖旧状态。
  - 断线或同步未完成时页面显示明确文字状态，并禁用所有写入口；重连完成 `ready + snapshot` 后才恢复。
  - 主机、错误与远程输出只按文本渲染；HTML/脚本样式数据不会执行、自动打开链接或发往外部服务。
- 验证方式：`npm test -- tests/contract/console-read.test.ts && npm --workspace web test -- console-state && npm run typecheck`；契约测试覆盖 SSE ready/invalidation/offline、cursor 和断线释放。
- 覆盖：Design Decision 3、8，Snapshot/SSE/输出同步与 React 状态模型；Spec Requirement“实例状态总览”“操作状态与输出”“实时同步与恢复”“安全展示与输入处理”。
- 对现有的影响：只投影既有事实源，不增加磁盘状态、浏览器持久化或主动连接主机。
- [ ] 完成

### Task 7：交付网页命令与 Profile 的预览确认执行闭环

- 切片：React 单主机表单 → HTTP 预览 → 冻结 `web_only` 审批 → 共享应用服务精确执行一次。
- 规模：M。
- 涉及文件：`src/console/action-routes.ts`、`src/console/console-server.ts`、`web/src/components/command-form.tsx`、`web/src/components/profile-form.tsx`、`web/src/components/operation-preview-dialog.tsx`、`tests/contract/console-actions.test.ts`、`web/tests/console-actions.test.tsx`。
- 依赖：Task 2、Task 3、Task 5、Task 6；可并行：否；高风险：是，网页首次获得远程副作用能力。
- 验收标准：
  - 命令/Profile 预览 endpoint 只接受单个登记主机和严格 Zod JSON；空命令、未知主机、未知/不适用 Profile、额外字段或资源超限在 SSH 副作用前失败。
  - 预览完整展示主机、平台、命令或实际编译 Profile、影响摘要、digest 和期限；关闭、取消或超时不执行。
  - 表单任一影响字段变化都会废弃旧 approvalId/digest 并重新预览；错误摘要或已处理预览不能执行。
  - 明确接受只消费冻结意图一次，并通过共享应用服务执行；重复提交、响应丢失和多标签页竞争不能重复副作用。
  - 网页来源全程为 `web_only`，包括首次 TOFU；MCP 客户端不会收到无对应工具调用的审批请求。
  - Unicode、中文、引号、换行与 Shell 元字符在表单、预览、Intent 和最终执行内容中逐字保持。
- 验证方式：`npm test -- tests/contract/console-actions.test.ts && npm --workspace web test -- console-actions && npm run typecheck`；Linux/Windows 测试分别覆盖命令、Profile 和首次 TOFU。
- 覆盖：Design Decision 5、7，Command/Profile Application Services 与预览 API；Spec Requirement“网页发起操作”全部 Scenario，MUST NOT“网页多主机”“绕过 SSH 安全边界”。
- 对现有的影响：增加比 MCP 低风险 Profile 更严格的网页确认，不改变 MCP Profile 自动执行规则。
- [ ] 完成

### Task 8：交付网页双通道审批、操作取消与无障碍交互闭环

- 切片：待审批/可取消状态 → HTTP 决定或取消 → React 即时收敛、竞态反馈和键盘操作。
- 规模：M。
- 涉及文件：`src/console/action-routes.ts`、`web/src/components/approval-dialog.tsx`、`web/src/components/operation-detail.tsx`、`web/src/console-reducer.ts`、`tests/contract/console-control.test.ts`、`web/tests/console-control.test.tsx`。
- 依赖：Task 2、Task 4、Task 6、Task 7；可并行：否，共享控制台动作路由与 reducer；高风险：是，必须证明竞态不产生第二次副作用。
- 验收标准：
  - MCP 来源 `dual` 审批在网页显示与 MCP 客户端相同的完整安全意图、digest 和期限；网页可接受、拒绝或取消。
  - 网页先决定、MCP 先决定、多个标签页及 accept/decline/cancel 并发时，页面收敛到唯一 resolution；后到请求明确显示“已处理”。
  - 运行中可取消操作点击后立即显示“已请求取消”，最终仍按真实 completed/failed/cancelled/unknown 展示；重复取消幂等且不影响其他操作。
  - 不存在、终态、跨实例或不可取消对象被拒绝或返回既有终态，不产生其他副作用。
  - 审批对话框打开后焦点进入并圈定，Escape 执行取消，关闭后焦点回触发控件；接受、拒绝、取消和查看完整内容均可由键盘完成。
  - 所有在线、等待、运行、成功、失败、取消、超时、未知和断线状态都有文字标签，不只依赖颜色。
- 验证方式：`npm test -- tests/contract/console-control.test.ts && npm --workspace web test -- console-control && npm run typecheck`；竞态测试断言每项副作用次数不超过 1。
- 覆盖：Design `ApprovalCoordinator`、`OperationControlService`、React 可用性；Spec Requirement“双通道审批”“网页取消操作”“控制台可用性”。
- 对现有的影响：网页成为 MCP 审批的并行决定通道，但不改变 MCP 工具调用的最终安全结果和错误分类。
- [ ] 完成

### Task 9：把控制台纳入 MCP 进程启动、关闭、日志与兼容路径

- 切片：`startServer()` 分阶段启动 → 一次性能力 URL → MCP/控制台共同可用 → 有界统一关闭与失败回滚。
- 规模：M。
- 涉及文件：`src/server.ts`、`src/index.ts`、`src/observability/logger.ts`、`src/console/console-server.ts`、`tests/contract/server-bootstrap.test.ts`、`tests/contract/console-lifecycle.test.ts`。
- 依赖：Task 3、Task 5、Task 6、Task 7、Task 8；可并行：否，汇合所有运行时能力；高风险：是，启动/关闭失败不能留下半活动实例或污染协议流。
- 验收标准：
  - `startServer()` 可注入 ConsoleServerFactory；生产顺序为组装事实源、建立未宣布回环 listener、连接 MCP stdio、标记 ready 后一次性输出 `console.ready`。
  - 控制台静态资源、监听或 MCP transport 任一步失败都会反向关闭已建立资源，实例不报告完整可用；运行期 HTTP 致命错误触发统一 shutdown。
  - 正常关闭先 quiesce 并通知页面 offline，再结算 pending 审批、停止 Operation/Session/SSH/MCP，最后有界关闭 SSE、keep-alive socket 和 listener；重复 shutdown 返回同一结果。
  - `console.ready` 的完整 URL 只写结构化 stderr 专用白名单一次；普通日志不允许 URL、token、Cookie、命令、Profile 参数或输出，stdout 仍只含合法 MCP JSON-RPC。
  - 同机同时启动至少两个真实实例时，端口、Origin、token、Cookie、状态、审批和操作完全隔离；进程退出后旧 URL/凭证不可用且不连接新实例。
  - 不修改 YAML schema、不自动打开浏览器、不增加第二个启动命令；12 个 MCP 工具契约和现有服务器测试保持通过。
- 验证方式：`npm test -- tests/contract/server-bootstrap.test.ts tests/contract/console-lifecycle.test.ts tests/contract/mcp-inspector.test.ts && npm run typecheck`；子进程测试同时捕获 stdout/stderr 并验证退出后旧地址失效。
- 覆盖：Design Decision 1，启动/关闭、日志、MCP 兼容与迁移；Spec Requirement“实例启动与关闭”，MUST NOT“自动打开浏览器”“退出后持久化”“污染 MCP stdout”。
- 对现有的影响：控制台成为实例必备组成部分；兼容旧 MCP 调用，但不再允许“无控制台仍报告完整启动”。版本回退使用旧构建产物，无数据迁移或状态恢复。
- [ ] 完成

### Task 10：完成安全边界、跨平台、构建与使用文档收口

- 切片：交付收口；把所有切片放入可重复的规格、平台、MUST NOT、干净构建和人工浏览器兼容矩阵。
- 规模：M。
- 涉及文件：`tests/acceptance/spec-coverage.test.ts`、`tests/acceptance/must-not.test.ts`、`tests/integration/linux/command.test.ts`、`tests/integration/windows/command.test.ts`、`README.md`、`docs/configuration.md`、`package.json` 及必要 CI 配置。
- 依赖：Task 1 至 Task 9；可并行：否，最终汇合；高风险：否，核心风险应由前置任务先行暴露。
- 验收标准：
  - 规格全部 Scenario 和成功标准均映射到自动化测试 ID；10 条 Requirement、12 条 MUST NOT 以及旧主规格未被覆盖的禁止项都有明确测试落点。
  - 更新旧 MN-007：只允许设计规定的实例私有本机 Console HTTP 模块，继续拒绝 MCP HTTP Transport、通用业务 API、远程监听、网页终端/文件写、多主机、配置管理和其他启动入口。
  - 源码级与运行时测试证明无登录/角色、终端输入、文件选择/拖放/上传下载、跨实例发现、持久化、Web Storage、外部 URL/遥测、`dangerouslySetInnerHTML` 或自动打开浏览器。
  - Linux/Windows OpenSSH 集成覆盖网页单命令、Profile、输出、取消和首次 TOFU；既有 MCP 命令/Profile/Session/Transfer/TOFU 测试继续通过。
  - Chrome/Edge、Firefox、Safari 人工矩阵验证 `*.localhost`、Secure Cookie、fragment 清理、CSP、SSE 重连和键盘流程；只把实际通过的最低版本写入 README，不引入查询 token 或 Web Storage 降级。
  - README 说明每进程控制台、从 stderr 取得 URL、仅本机能力凭证边界、页面能力/非目标、浏览器范围和故障表现；配置文档明确本版无新增 YAML/环境变量。
  - 干净环境执行根 `npm ci && npm run check` 通过，Linux/Windows 集成命令分别通过；生产包包含 `dist/console/` 且运行不需要开发依赖或独立前端进程。
- 验证方式：`npm ci && npm run check && npm run test:contract && npm run test:acceptance && npm run test:integration:linux`；Windows runner 执行 `npm run test:integration:windows`；按文档完成浏览器人工矩阵。
- 覆盖：Design Decision 2、9，测试策略、风险与 Deferred；Spec 全部成功标准、全部 Requirement 和 MUST NOT 的最终回归。
- 对现有的影响：更新旧“禁止网页”验收和使用说明，但不放宽本机控制台之外的任何既有安全边界。
- [ ] 完成

## 4. 拆分探针结论

| 探针维度 | 判定 | 任务落点 / 理由 |
|---|---|---|
| 数据迁移 | 不适用 | 新状态全部在进程内存；无数据库、schema、索引或回填 |
| 种子数据 / 初始数据 | 不适用 | 页面必须读取真实实例；演示数据反而违反规格 |
| 接口契约落地 | 需任务 | Task 5–8 落地严格白名单的静态、会话、快照、SSE、输出、预览、决定和取消接口 |
| 测试 | 需任务（嵌入 + 收口） | Task 1–9 各自携带单元/契约/组件测试；Task 10 完成跨切片验收 |
| 回滚 / 降级 | 需任务（并入 Task 9） | 启动失败反向回滚资源；版本回退使用旧产物。无破坏性数据迁移，不增加 feature flag |
| 可观测性 | 需任务 | Task 9 落地 `console.ready`/拒绝/停止事件及严格脱敏 |
| 配置与环境变量 | 不适用 | 设计明确不修改 YAML、不新增环境变量或远程监听选项；Task 10 文档核实 |
| 依赖安装 | 需任务 | Task 1 锁定 Vite/React/`happy-dom` 并移除不再需要的站点运行链 |
| 构建 / CI | 需任务 | Task 1 建立统一构建入口；Task 10 完成干净构建、跨平台及必要 CI 收口 |
| 集成点 | 需任务 | Task 3 接共享执行/TOFU，Task 4 接事实源，Task 9 接进程生命周期，Task 10 做跨平台回归 |
| 文档 | 需任务 | Task 10 更新 README 和配置文档；访问 URL 是用户操作入口，不能延后 |

## 5. 迁移 / 回滚索引

- 数据迁移：不适用；无持久数据或 schema 变化。
- 行为兼容：Task 2、Task 3、Task 9；保持 12 个 MCP 工具契约，唯一行为修改是无 MCP form 能力时允许网页在原期限内兜底。
- 构建迁移：Task 1；把 `web/` 从演示站点运行链迁为 Vite 静态产物。
- 启动失败回滚：Task 9；分阶段启动失败时反向释放所有已建立资源。
- 版本降级：Task 9；使用旧构建产物即可，不迁移或恢复控制台内存状态。

## 6. 依赖与并行视图

### 6.1 拓扑顺序

```text
Wave 1:  T1（Vite/构建） ∥ T2（审批协调器） ∥ T4（投影/修订/取消）
Wave 2:  T3（共享应用服务与 route，依赖 T2） ∥ T5（本机 HTTP 安全，依赖 T1）
Wave 3:  T6（只读状态 + SSE 页面，依赖 T1/T4/T5）
Wave 4:  T7（网页命令/Profile，依赖 T2/T3/T5/T6）
Wave 5:  T8（审批/取消/无障碍，依赖 T2/T4/T6/T7）
Wave 6:  T9（进程生命周期集成，依赖 T3/T5/T6/T7/T8）
Wave 7:  T10（全量收口，依赖 T1–T9）
```

同一 Wave 仅列不修改同一批文件的任务。Task 7 与 Task 8 均会修改控制台动作路由和 React reducer，因此明确串行，避免并行冲突。

### 6.2 Checkpoint

- **Checkpoint A（Task 1、2、4 后）：** 前端静态构建、审批竞态单测、事实源投影/取消单测全部通过；确认三个地基可独立工作。
- **Checkpoint B（Task 3、5 后）：** MCP 契约与 TOFU route 回归通过；双实例认证交叉矩阵通过；确认核心安全路径再开放网页读 API。
- **Checkpoint C（Task 6、7 后）：** 可从页面读取真实状态并执行一次经确认的命令/Profile；断线禁写、摘要绑定和 Unicode 保持通过。
- **Checkpoint D（Task 8、9 后）：** 双通道竞态、取消、焦点、启动/关闭、多实例和 stdout 纯净性通过。
- **Checkpoint E（Task 10）：** 根 `npm run check`、Linux/Windows 集成、全部覆盖映射和人工浏览器矩阵完成。

## 7. 覆盖核对表

### 7.1 Design Decisions 与组件

| Design 条目 | 任务落点 |
|---|---|
| Decision 1：同进程 Console | Task 9 |
| Decision 2：React + Vite 静态客户端 | Task 1、Task 10 |
| Decision 3：JSON HTTP + SSE | Task 5、Task 6、Task 7、Task 8 |
| Decision 4：独立 localhost Origin + fragment 会话 | Task 5、Task 9 |
| Decision 5：受限 Console API，不暴露 MCP Transport | Task 3、Task 5、Task 10 |
| Decision 6：统一 ApprovalCoordinator | Task 2、Task 8 |
| Decision 7：显式 ApprovalRoute | Task 3、Task 7 |
| Decision 8：权威快照 + SSE 失效通知 | Task 4、Task 6 |
| Decision 9：Vitest + happy-dom | Task 1、Task 6–8、Task 10 |
| ConsoleServer / ConsoleAuthGuard | Task 5、Task 9 |
| RuntimeRevisionHub / RuntimeSnapshotProjector | Task 4、Task 6 |
| ApprovalCoordinator | Task 2、Task 8 |
| Command/Profile Application Services | Task 3、Task 7 |
| OperationControlService | Task 4、Task 8 |
| OperationManager / SessionManager change hooks | Task 4 |
| React 总览、预览、审批和取消交互 | Task 6、Task 7、Task 8 |
| 启动回滚、日志、MCP 兼容 | Task 9、Task 10 |

### 7.2 Spec Requirements

| Spec Requirement | 任务落点 |
|---|---|
| 实例启动与关闭 | Task 9、Task 10 |
| 本机访问保护 | Task 5、Task 9 |
| 实例状态总览 | Task 4、Task 6 |
| 操作状态与输出 | Task 4、Task 6 |
| 网页发起操作 | Task 3、Task 7 |
| 双通道审批 | Task 2、Task 8 |
| 网页取消操作 | Task 4、Task 8 |
| 实时同步与恢复 | Task 4、Task 6 |
| 安全展示与输入处理 | Task 3、Task 5–8、Task 10 |
| 控制台可用性 | Task 6、Task 8、Task 10 |

### 7.3 MUST NOT

| Spec MUST NOT | 任务落点 |
|---|---|
| 非回环监听或接受请求 | Task 5、Task 10 |
| 仅凭本机位置授权 | Task 5、Task 10 |
| 登录、用户、角色或凭证管理 | Task 5、Task 10 |
| 自动打开浏览器 | Task 9、Task 10 |
| 网页交互终端/会话写入口 | Task 4、Task 6、Task 10 |
| 网页上传下载/目录传输 | Task 4、Task 6、Task 10 |
| 网页多主机操作 | Task 3、Task 7、Task 10 |
| 跨实例聚合、发现或控制 | Task 5、Task 9、Task 10 |
| 退出后持久化或恢复状态 | Task 4、Task 9、Task 10 |
| 审计导出、外部通知或遥测 | Task 1、Task 5、Task 10 |
| 绕过 SSH/策略/审批/取消/输出边界 | Task 2、Task 3、Task 7、Task 8 |
| 污染 MCP stdio stdout | Task 9、Task 10 |

反向核对：所有任务均可追溯到已确认 design/spec；未新增交互终端、文件写、多主机网页执行、远程访问、配置管理、数据库、历史、通知、遥测或第三方集成。

## 8. 待解问题 / 延后

- 浏览器最低版本延后到 Task 10 的真实人工矩阵后定稿；不能用不安全凭证存储作为兼容降级。
- 交互终端、网页文件传输、网页多主机和远程访问均属于后续独立规格，不进入本清单。
- HTTP/SSE 预算和控制台安全元数据的具体常量/字段名在对应任务内按设计约束落定并由测试锁住，不暴露为配置。
