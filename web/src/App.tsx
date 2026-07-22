import { useMemo, useState } from "react";

type Host = {
  alias: string;
  environment: "开发" | "测试";
  platform: "Linux" | "Windows";
  endpoint: string;
  user: string;
  auth: string;
  root: string;
  latency: string;
  status: "connected" | "idle";
};

const hosts: Host[] = [
  {
    alias: "staging-api-01",
    environment: "测试",
    platform: "Linux",
    endpoint: "10.24.8.31:22",
    user: "deploy",
    auth: "SSH Agent",
    root: "/srv/apps",
    latency: "24 ms",
    status: "connected",
  },
  {
    alias: "dev-worker-02",
    environment: "开发",
    platform: "Linux",
    endpoint: "10.24.12.18:22",
    user: "engineer",
    auth: "Private Key",
    root: "/home/engineer",
    latency: "41 ms",
    status: "connected",
  },
  {
    alias: "qa-windows-01",
    environment: "测试",
    platform: "Windows",
    endpoint: "10.24.16.42:22",
    user: "qa-runner",
    auth: "Pageant",
    root: "D:\\workspace",
    latency: "—",
    status: "idle",
  },
];

const initialActivities = [
  {
    id: "OP-8F21",
    title: "读取应用日志",
    host: "staging-api-01",
    time: "14:32:08",
    state: "运行中",
    tone: "running",
    progress: 68,
  },
  {
    id: "OP-7D14",
    title: "同步构建产物",
    host: "dev-worker-02",
    time: "14:28:42",
    state: "已完成",
    tone: "success",
    progress: 100,
  },
  {
    id: "OP-6A90",
    title: "重启测试服务",
    host: "staging-api-01",
    time: "14:21:16",
    state: "已批准",
    tone: "approved",
    progress: 100,
  },
];

const navItems = [
  ["OV", "总览"],
  ["HS", "主机"],
  [">_", "命令"],
  ["FT", "文件传输"],
  ["SS", "会话"],
];

export default function Home() {
  const [selectedHost, setSelectedHost] = useState(hosts[0].alias);
  const [activeNav, setActiveNav] = useState("总览");
  const [command, setCommand] = useState("uname -a && uptime");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const currentHost = useMemo(
    () => hosts.find((host) => host.alias === selectedHost) ?? hosts[0],
    [selectedHost],
  );

  function submitOperation() {
    setApprovalOpen(false);
    setSubmitted(true);
    window.setTimeout(() => setSubmitted(false), 3200);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">&gt;_</span>
          <span>
            <strong>SSH</strong>
            <small>MCP CONTROL</small>
          </span>
        </div>

        <nav className="nav-list">
          {navItems.map(([icon, label]) => (
            <button
              className={activeNav === label ? "nav-item active" : "nav-item"}
              key={label}
              onClick={() => setActiveNav(label)}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="security-state">
            <span className="shield" aria-hidden="true">◆</span>
            <div>
              <strong>安全策略已启用</strong>
              <span>审批 · TOFU · 路径边界</span>
            </div>
          </div>
          <p>v0.1.0 <span>·</span> MCP 2025-11-25</p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">SECURE REMOTE OPERATIONS</p>
            <h1>{activeNav === "总览" ? "运维工作台" : activeNav}</h1>
          </div>
          <div className="topbar-actions">
            <div className="service-pill">
              <span className="pulse-dot" />
              <span><strong>MCP 服务在线</strong><small>stdio transport</small></span>
            </div>
            <button className="icon-button" aria-label="通知" type="button">
              <span aria-hidden="true">◎</span><i>2</i>
            </button>
            <button className="avatar" aria-label="账户：CJ" type="button">CJ</button>
          </div>
        </header>

        <div className="content">
          <section className="hero-strip">
            <div className="hero-copy">
              <span className="section-index">01 / CONTROL</span>
              <h2>每一次远程操作，<br /><em>都清晰、可控。</em></h2>
              <p>统一查看受控主机、运行任务与审批状态。服务仅面向开发和测试环境，不接收密码或私钥文本。</p>
            </div>
            <div className="summary-grid" aria-label="服务摘要">
              <article>
                <span className="summary-label">登记主机</span>
                <strong>03</strong>
                <small><b>02</b> 当前可达</small>
              </article>
              <article>
                <span className="summary-label">进行中</span>
                <strong>01</strong>
                <small>输出缓冲正常</small>
              </article>
              <article>
                <span className="summary-label">今日操作</span>
                <strong>18</strong>
                <small><b>100%</b> 已审批</small>
              </article>
            </div>
          </section>

          <section className="dashboard-grid">
            <article className="panel topology-panel">
              <header className="panel-heading">
                <div>
                  <span className="section-index">02 / HOST MAP</span>
                  <h3>连接拓扑</h3>
                </div>
                <span className="live-label"><i />实时状态</span>
              </header>

              <div className="network-map">
                <div className="origin-card">
                  <span className="origin-symbol" aria-hidden="true">M</span>
                  <div><strong>MCP Core</strong><small>12 tools ready</small></div>
                  <span className="online-tag">ONLINE</span>
                </div>
                <div className="connector" aria-hidden="true"><span /></div>
                <div className="host-stack">
                  {hosts.map((host) => (
                    <button
                      className={selectedHost === host.alias ? "host-card selected" : "host-card"}
                      key={host.alias}
                      onClick={() => setSelectedHost(host.alias)}
                      type="button"
                    >
                      <span className={`host-status ${host.status}`} />
                      <span className="host-main">
                        <strong>{host.alias}</strong>
                        <small>{host.platform} · {host.endpoint}</small>
                      </span>
                      <span className="host-meta">
                        <b>{host.environment}</b>
                        <small>{host.latency}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="host-detail">
                <div>
                  <span>当前主机</span>
                  <strong>{currentHost.alias}</strong>
                </div>
                <dl>
                  <div><dt>登录用户</dt><dd>{currentHost.user}</dd></div>
                  <div><dt>认证方式</dt><dd>{currentHost.auth}</dd></div>
                  <div><dt>允许根目录</dt><dd>{currentHost.root}</dd></div>
                </dl>
                <button className="text-action" type="button">查看配置 <span>↗</span></button>
              </div>
            </article>

            <article className="panel activity-panel">
              <header className="panel-heading">
                <div>
                  <span className="section-index">03 / ACTIVITY</span>
                  <h3>操作队列</h3>
                </div>
                <button className="text-action" type="button">全部记录 <span>→</span></button>
              </header>

              <div className="activity-list">
                {initialActivities.map((activity) => (
                  <div className="activity-item" key={activity.id}>
                    <div className="activity-topline">
                      <span className={`activity-state ${activity.tone}`}><i />{activity.state}</span>
                      <time>{activity.time}</time>
                    </div>
                    <strong>{activity.title}</strong>
                    <span className="activity-host">{activity.host} <b>·</b> {activity.id}</span>
                    <div className="progress-track"><span style={{ width: `${activity.progress}%` }} /></div>
                  </div>
                ))}
              </div>

              <div className="audit-note">
                <span aria-hidden="true">✓</span>
                <p><strong>审批链完整</strong>所有副作用操作均已展示完整参数与摘要。</p>
              </div>
            </article>
          </section>

          <section className="command-dock" aria-label="快速执行命令">
            <div className="command-label">
              <span className="prompt-mark" aria-hidden="true">&gt;_</span>
              <div><strong>快速命令</strong><small>执行前将请求一次性审批</small></div>
            </div>
            <label className="command-input">
              <span>$</span>
              <input
                aria-label="要执行的命令"
                onChange={(event) => setCommand(event.target.value)}
                spellCheck={false}
                value={command}
              />
            </label>
            <label className="host-select">
              <span>目标</span>
              <select
                aria-label="目标主机"
                onChange={(event) => setSelectedHost(event.target.value)}
                value={selectedHost}
              >
                {hosts.map((host) => <option key={host.alias}>{host.alias}</option>)}
              </select>
            </label>
            <button
              className="primary-button"
              disabled={!command.trim()}
              onClick={() => setApprovalOpen(true)}
              type="button"
            >
              检查并运行 <span>→</span>
            </button>
          </section>
        </div>
      </section>

      {approvalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setApprovalOpen(false)}>
          <section
            aria-labelledby="approval-title"
            aria-modal="true"
            className="approval-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <span className="approval-mark" aria-hidden="true">!</span>
              <div>
                <p className="eyebrow">ONE-TIME APPROVAL</p>
                <h2 id="approval-title">确认远程操作</h2>
              </div>
              <button aria-label="关闭审批弹窗" onClick={() => setApprovalOpen(false)} type="button">×</button>
            </header>
            <p className="modal-intro">请确认本次操作的完整范围。批准仅对当前摘要有效，内容发生变化后需要重新确认。</p>
            <dl className="approval-details">
              <div><dt>目标主机</dt><dd>{currentHost.alias}<small>{currentHost.user}@{currentHost.endpoint}</small></dd></div>
              <div><dt>执行命令</dt><dd><code>{command}</code></dd></div>
              <div><dt>工作目录</dt><dd><code>{currentHost.root}</code></dd></div>
              <div><dt>操作摘要</dt><dd><code>sha256: 7b4f…e91a</code></dd></div>
            </dl>
            <div className="boundary-note"><span>◆</span><p><strong>安全边界</strong>命令将在登记主机上执行；不会发送本地凭据内容，也不会访问配置根目录之外的路径。</p></div>
            <footer>
              <button className="secondary-button" onClick={() => setApprovalOpen(false)} type="button">取消</button>
              <button className="primary-button" onClick={submitOperation} type="button">批准并执行 <span>→</span></button>
            </footer>
          </section>
        </div>
      )}

      {submitted && (
        <div className="toast" role="status">
          <span>✓</span><div><strong>操作已提交</strong><small>正在等待 staging 输出…</small></div>
        </div>
      )}
    </main>
  );
}
