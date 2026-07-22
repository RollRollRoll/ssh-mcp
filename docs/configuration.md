# 配置说明

服务只读取一份 YAML 1.2 配置。配置在启动时校验并深冻结；不支持 YAML 锚点、别名或标签。除 `privateKeyFile.path` 可使用 `~/.ssh/...` 外，所有路径必须是绝对路径；任何路径都不得包含 `..`。主机环境只能是 `development` 或 `test`，主机数量为 1–10 台。

本机控制台**没有新增 YAML 字段或环境变量**。每次成功启动 SSH MCP 实例时，控制台固定随进程启动，只监听 `127.0.0.1` 的随机端口，并在标准错误的 `console.ready` 事件中给出本实例访问地址。监听地址、端口、实例名、访问令牌、远程访问和自动打开浏览器均不可配置；访问凭证也不得写入本文件。

下面是一个完整结构示例。示例地址、用户名和路径均为占位符，不能直接用于生产，也不包含任何真实秘密。

```yaml
version: 1
trustStore: /absolute/state/ssh-mcp/trust.json
localRoots:
  - /absolute/workspace
limits:
  connectTimeoutMs: 15000
  commandTimeoutMs: 300000
  sessionIdleTimeoutMs: 1800000
  transferTimeoutMs: 1800000
  approvalTimeoutMs: 120000
  cancelConfirmationTimeoutMs: 10000
  outputBufferBytes: 8388608
  resultRetentionMs: 900000
hosts:
  - alias: linux-test
    environment: test
    platform: linux
    host: 192.0.2.10
    port: 22
    username: developer
    auth:
      type: agent
      socket: /absolute/run/ssh-agent.sock
    shell:
      type: posix
      command: /bin/sh
    remoteRoots:
      - /srv/test-project
  - alias: windows-test
    environment: development
    platform: windows
    host: 192.0.2.20
    port: 22
    username: developer
    auth:
      type: privateKeyFile
      path: ~/.ssh/windows-test-ed25519
    shell:
      type: powershell
      command: powershell.exe
    remoteRoots:
      - 'C:\\Work\\TestProject'
lowRiskProfiles:
  - id: list-build-output
    hostAliases: [linux-test]
    platform: linux
    executable: /usr/bin/find
    fixedArgs: [/srv/test-project/build, -maxdepth, '1', -type, f]
    parameters: []
```

## 认证准备

`auth` 只能选择一种方式：

- `agent`：指定本机 SSH Agent 的绝对 socket 路径。
- `pageant`：仅在支持 Pageant 的本机环境中使用，不提供额外凭据字段。
- `privateKeyFile`：指定本机私钥文件的绝对路径，或使用 `~/.ssh/...` 引用当前服务进程用户 SSH 目录内的私钥。`~/.ssh/...` 会在配置加载时展开为绝对路径，但不允许用 `..` 逃出该目录。服务进程会读取指定文件到内存并作为 `privateKey` 交给 `ssh2`，但不会扫描整个 `.ssh` 目录，也不会从 YAML 或 MCP 参数接收私钥内容、密码或密钥口令，不会持久化、记录或回显这些内容；服务同样不生成或轮换私钥。

请在启动服务前由操作系统或现有 SSH 工具准备 Agent、Pageant 或私钥文件及其权限。不要把密码、私钥内容、口令或令牌写入 YAML、环境变量、日志或 MCP 工具参数。

## 主机身份与 TOFU

`trustStore` 是服务写入已确认主机公钥指纹的本地文件。首次连接时，支持 form elicitation 的 MCP 客户端会展示别名、算法和指纹，由用户确认后才认证；拒绝、超时或客户端不支持表单时都不会认证。以后指纹变化会关闭拒绝，不能通过配置或本次任务临时覆盖。

## 根目录、Profile 与预算

`localRoots` 和每台主机的 `remoteRoots` 是文件传输的唯一允许根。路径比较按平台语义执行，拒绝越界、链接和重解析点；目录传输还拒绝源树中的挂载点。`lowRiskProfiles` 只在 YAML 中定义，工具调用不能新增、修改或放宽它。Profile 只能引用登记主机，Windows Profile 还必须声明 `commandType: cmdlet` 或 `native`。

未写出的 `limits` 使用上例中的默认值：连接 15 秒、命令 5 分钟、会话空闲 30 分钟、传输 30 分钟、审批 2 分钟、取消确认 10 秒、输出 8 MiB、终态保留 15 分钟。预算到期或网络中断而无法确认远端结果时，状态会明确为 `unknown`，不会自动重试。

这些既有实例预算同样约束网页来源操作。网页不能放宽连接、命令、审批、取消确认、输出缓冲或保留期限，也不能新增或修改 Profile。MCP 客户端不能提供审批表单时，MCP 来源的待审批操作可以在同一 `approvalTimeoutMs` 内由本机控制台决定；到期仍无有效决定时不会执行。
