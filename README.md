# SSH MCP

SSH MCP 是一个仅通过 MCP `stdio` Transport 提供的 SSH 操作服务。它面向具备 `tools` 和 `form elicitation` 能力的 MCP 客户端；客户端先展示完整操作与摘要，再由用户一次性批准。

## 运行条件与启动

- Node.js 24–26（`>=24 <27`）
- 已配置的 SSH Agent、Pageant 或本地私钥文件（支持 `~/.ssh/...`）；服务不接收密码、私钥文本或口令
- 一份仅含开发或测试主机的 YAML 配置

安装依赖后，启动 MCP stdio 服务：

```sh
npm ci
npm run build
node dist/index.js --config /absolute/path/to/ssh-mcp.yml
```

也可以以绝对路径设置 `SSH_MCP_CONFIG`。启动参数只用于定位配置文件；它不是独立业务 CLI。标准输出只承载 MCP JSON-RPC 帧，诊断输出写入标准错误。

## 客户端能力基线

客户端需要支持 MCP `2025-11-25`、stdio、工具调用和 form elicitation。`hosts_list` 可在没有审批表单的客户端中使用；任何需要副作用的工具在客户端不能呈现表单时返回 `APPROVAL_UNSUPPORTED`，不会连接 SSH 主机或读写文件。

服务固定提供 12 个工具：`hosts_list`、`command_run`、`profile_run`、`session_open`、`session_write`、`session_read`、`session_resize`、`session_close`、`file_upload`、`file_download`、`operation_get`、`operation_cancel`。长操作应使用后两个工具查询进度和请求取消。

## 安全边界

主机、账号、认证方式、Shell、根目录和低风险 Profile 都在启动时从 YAML 加载并冻结。首次连接使用 TOFU 表单确认主机密钥；指纹发生变化时一律拒绝，不能在任务内绕过。文件和目录操作只允许配置根内的普通文件/目录，并拒绝链接、重解析点和目录树内挂载点。

完整配置及默认预算见 [配置说明](docs/configuration.md)。

## 验证

```sh
npm run check
npm run test:contract
npm run test:integration:linux
npm run test:acceptance
```

Windows 集成单独使用 `npm run test:integration:windows`，需要由受控 Windows OpenSSH Server 提供测试环境。

## 非目标

本版本不提供动态主机或凭据管理、生产主机、规则写入、多人权限或长期审计、独立 CLI/HTTP/UI、端口/代理/X11/认证代理转发、断点续传或元数据保留、自动重试/事务/回滚、跨重启恢复，以及 Linux 与 Windows 之间的命令、路径或规则翻译。
