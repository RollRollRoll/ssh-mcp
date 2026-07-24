# SSH MCP

SSH MCP 是一个通过 MCP `stdio` Transport 提供 SSH 操作的服务。进程默认只启动 `stdio`；客户端首次调用工具且支持 form elicitation 时，会询问是否启用一个与该进程同生命周期、仅本机访问的独立网页控制台。它不是 MCP HTTP Transport，也不需要单独启动前端服务。

## 运行条件与启动

- Node.js 24–26（`>=24 <27`）
- 已配置的 SSH Agent、Pageant 或本地私钥文件（支持 `~/.ssh/...`）；服务不接收密码、私钥文本或口令
- 一份仅含开发或测试主机的 YAML 配置；未指定时默认加载 `~/.config/ssh-mcp/ssh-mcp.yml`

### 从线上包启动（推荐）

发布到 npm 后，部署机器无需克隆或构建本仓库。MCP 客户端使用 `npx` 下载并启动指定版本；SSH 配置和私钥仍只保留在部署机器本地：

```json
{
  "command": "npx",
  "args": [
    "--yes",
    "--package",
    "@rollrollroll/ssh-mcp@0.1.4",
    "ssh-mcp"
  ]
}
```

截图所示表单应填写：

- 启动命令：`npx`
- 参数 1：`--yes`
- 参数 2：`--package`
- 参数 3：`@rollrollroll/ssh-mcp@0.1.4`
- 参数 4：`ssh-mcp`

无参数时固定加载部署机器上的全局配置 `~/.config/ssh-mcp/ssh-mcp.yml`，不受 MCP 客户端工作目录影响。只有需要使用其他配置文件时，才传入 `--config <path>` 或设置 `SSH_MCP_CONFIG`。两者接受绝对路径，也接受以 `~/` 开头的当前服务用户主目录路径；服务只展开开头的 `~/`，不会进行 Shell 变量、命令或通配符展开。

生产环境建议固定精确版本，不要使用 `latest`，以避免重启时静默升级。首次启动需要访问 npm registry；之后是否可离线复用取决于本机 npm 缓存，不应把缓存当作部署保证。

发布前确认当前 npm 账号拥有 `@rollrollroll` scope 的发布权限，再执行：

```sh
npm pack --dry-run
npm publish --access public
```

当前包会在发布前自动构建，并通过 `bin` 暴露唯一的 `ssh-mcp` stdio 启动入口；发布内容只包含 `dist/`、本 README 和配置说明。

### 首次生成配置

如果既没有传入 `--config`，也没有设置 `SSH_MCP_CONFIG`，服务会加载 `~/.config/ssh-mcp/ssh-mcp.yml`。首次启动时如果该文件不存在，服务会创建父目录和配置模板，输出一次 `config.generated` 事件，然后正常退出。生成过程不会覆盖已有文件；模板中的 `localRoots` 默认为本次启动的工作目录。请编辑模板中的主机地址、用户名、认证方式和远程根目录，再以同样的命令重新启动。

省略配置参数的线上包启动形式如下：

```json
{
  "command": "npx",
  "args": [
    "--yes",
    "--package",
    "@rollrollroll/ssh-mcp@0.1.4",
    "ssh-mcp"
  ]
}
```

只有希望使用其他配置文件时，才需要显式添加 `--config ~/.config/ssh-mcp/project-a.yml`。

### 配置作用域

建议全局安装一份 SSH MCP 程序，但按项目或安全边界使用独立配置。只要允许访问的本机目录、远程主机、远程目录、低风险 Profile 或操作人员不同，就应拆成不同 YAML，并为每份配置指定独立的 `trustStore`。多个项目只有在上述授权范围完全相同时才适合共用配置。

配置可以集中保存在用户私有目录中，不必放入源码仓库。插件无参数启动时默认加载 `~/.config/ssh-mcp/ssh-mcp.yml`；需要不同授权边界时，可显式改为 `~/.config/ssh-mcp/project-a.yml` 和 `~/.config/ssh-mcp/project-b.yml`。不要把包含内部主机地址、用户名或本机路径的实际配置提交到项目仓库。

### 从本地源码启动

本地开发时，安装依赖并构建后启动 MCP stdio 服务：

```sh
npm ci
npm run build
node dist/index.js
```

默认加载 `~/.config/ssh-mcp/ssh-mcp.yml`。需要使用其他文件时，可以传入 `--config /absolute/path/to/ssh-mcp.yml`，也可以通过绝对路径或 `~/` 路径设置 `SSH_MCP_CONFIG`。启动参数只用于覆盖默认配置位置；它不是独立业务 CLI。标准输出只承载 MCP JSON-RPC 帧，诊断输出写入标准错误。

配置和 MCP transport 就绪后，服务立即以纯 `stdio` 模式工作，不加载前端资产，也不监听端口。客户端首次调用任一工具时只询问一次是否启用网页控制台；拒绝、取消或客户端不支持 form elicitation 时，本进程始终保持纯 `stdio`。

用户同意后，服务才尝试监听 `127.0.0.1` 的随机端口。成功时标准错误会输出一次结构化 `console.ready` 事件，其中 `accessUrl` 是本进程的完整控制台地址：

```json
{"level":"info","event":"console.ready","state":"active","accessUrl":"http://<随机实例>.localhost:<随机端口>/#access_token=<一次性令牌>"}
```

客户端同时支持 MCP URL elicitation 时，控制台就绪后会再显示一次安全导航确认；用户接受后由客户端在本机浏览器打开完整地址。客户端只支持 form elicitation 或 URL 导航请求失败时，首次工具结果的 `_sshMcp.console.accessUrl` 会提供同一个一次性地址，客户端应把它展示为可点击链接；`console.ready` 仍保留诊断入口。SSH MCP 服务端不会调用系统 `open` 命令。每个启用控制台的进程使用不同的随机回环端口、实例 Origin 和凭证；进程退出后旧地址失效。

MCP Elicitation 只能取得用户对启用控制台的同意，不能提升 Codex 宿主进程的沙箱权限。如果监听被拒绝，首次工具结果会附加 `CONSOLE_LISTEN_DENIED` 告警及安全白名单内的系统错误码（例如 `EPERM`），原工具仍继续通过 `stdio` 执行。请调整任务权限后重启 MCP；服务不会自行绕过沙箱。

## 本机控制台

控制台展示当前实例的服务状态、登记主机、操作与输出、审批，以及已有 Session/Transfer 的只读摘要。网页可以：

- 对一台登记主机提交单次命令，或运行 YAML 中已定义的低风险 Profile；
- 在完整冻结预览中核对目标、实际命令、影响、摘要和期限，再明确接受或取消；
- 处理 MCP 来源的待审批操作；
- 请求取消运行中的操作，并显示真实的最终状态；
- 通过 SSE 自动同步本进程状态，连接中断时立即禁用写操作。

网页不提供交互终端、Session 输入或尺寸修改、文件上传下载、多主机网页操作、跨实例发现、配置管理、历史审计或远程访问。

### 访问凭证边界

`accessUrl` 本身具有控制本进程的能力，应像临时秘密一样处理：只通过客户端的 URL elicitation、首次工具结果或 `console.ready` 在本机可信浏览器中打开，不要共享或持久化。页面会把 fragment 中的一次性令牌换成 host-only、HttpOnly、Secure、SameSite=Strict 会话 Cookie，并立即从地址栏清除 fragment；令牌不会进入 URL query、Web Storage 或页面持久状态。仅在客户端缺少可用 URL elicitation 时，地址才会作为兼容回退进入首次工具结果和模型上下文。

控制台获准启用后固定监听 `127.0.0.1` 的随机端口，且没有 YAML、环境变量或页面开关可改为局域网/远程监听。仅能连接本机并不等于已经授权；每个 API 请求仍需同时通过实例 Origin、会话和请求来源检查。

## 客户端能力基线

客户端需要支持 MCP `2025-11-25`、stdio 和工具调用；支持 form elicitation 时，首次工具调用可以询问是否启用控制台，后续风险审批也可直接在 MCP 客户端处理；同时支持 URL elicitation 时，控制台就绪后可在用户二次同意下直接交给本机浏览器打开。`hosts_list` 不需要业务审批，但首次调用仍会触发一次控制台启用询问。客户端不支持 form elicitation 时不会启动控制台；只缺少 URL elicitation 时，控制台地址会通过首次工具结果的 `_sshMcp.console.accessUrl` 返回。需要审批的操作无人决定则保守超时，绝不会提前执行。网页来源操作只在网页审批，不会向 MCP 客户端制造无对应工具上下文的审批。

服务固定提供 12 个工具：`hosts_list`、`command_run`、`profile_run`、`session_open`、`session_write`、`session_read`、`session_resize`、`session_close`、`file_upload`、`file_download`、`operation_get`、`operation_cancel`。长操作应使用后两个工具查询进度和请求取消。

## 安全边界

主机、账号、认证方式、Shell、根目录和低风险 Profile 都在启动时从 YAML 加载并冻结。首次连接使用 TOFU 表单确认主机密钥；指纹发生变化时一律拒绝，不能在任务内绕过。文件和目录操作只允许配置根内的普通文件/目录，并拒绝链接、重解析点和目录树内挂载点。

完整配置及默认预算见 [配置说明](docs/configuration.md)。

## 验证

```sh
npm run check
npm run test:integration:linux
```

Windows 集成单独使用 `npm run test:integration:windows`，需要由受控 Windows OpenSSH Server 提供测试环境。

### 浏览器验证范围

本版本已在 **Codex 内置浏览器（Chromium 内核，2026-07-22 应用构建）** 实测 `*.localhost`、Secure 会话交换、fragment 清理、CSP 下静态加载、SSE 更新/断线禁写、纯文本渲染和键盘焦点流程。该浏览器未暴露可复现的内核版本号，因此不声明最低版本。

Chrome/Edge、Firefox 和 Safari 尚未完成独立版本矩阵验证，本版本不声明它们的最低支持版本，也不会为兼容性增加 query token 或 Web Storage 降级。若目标浏览器不能完成会话交换或 SSE 连接，请更换已验证的本机浏览器，而不要放宽服务安全边界。

### 故障判断

- 标准错误没有 `console.ready`：尚未触发工具调用、用户未同意、客户端不支持 form elicitation，或控制台启动失败；这不表示 MCP `stdio` 不可用。
- `console.start_failed` 或首次工具结果包含 `CONSOLE_LISTEN_DENIED`：运行环境拒绝本机控制台监听；`details.systemErrorCode` 会保留白名单内的系统错误码（例如 `EPERM`），但不会输出原始消息、路径或堆栈。调整任务权限并重启 MCP 后再试。
- 已有 `console.ready` 但浏览器没有打开：客户端可能未声明 URL elicitation；检查首次工具结果是否包含 `_sshMcp.console.accessUrl`，或从该诊断事件手动复制完整地址。
- 页面显示“连接已断开（写操作已禁用）”：实例已退出或实时连接不可用；旧页面不会自动连接到新实例，请使用新进程输出的新地址。
- 地址打不开：确认复制了完整 fragment 地址、进程仍在运行，并且浏览器支持 `*.localhost` 指向本机回环地址。
- 页面能打开但不能写：不要手工改 Host、Origin、Cookie 或请求头；重新从最新 `console.ready` 地址建立会话。

## 非目标

本版本不提供动态主机或凭据管理、生产主机、规则写入、多人权限或长期审计、独立业务 CLI、MCP HTTP Transport、通用业务 API、远程管理 UI、端口/代理/X11/认证代理转发、断点续传或元数据保留、自动重试/事务/回滚、跨重启恢复，以及 Linux 与 Windows 之间的命令、路径或规则翻译。
