"use client";

import { useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import ConnectionForm from "@/components/ConnectionForm";
import ToolsList from "@/components/ToolsList";
import ExecuteTool from "@/components/ExecuteTool";
import AuditLogs from "@/components/AuditLogs";

type Tab = "tools" | "execute" | "logs";

export default function DashboardPage() {
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [tab, setTab] = useState<Tab>("tools");
  const [logs, setLogs] = useState<ExecutionLog[]>([]);

  function onConnected(cfg: McpConfig, t: McpTool[]) {
    setConfig(cfg);
    setTools(t);
    setTab("tools");
    setSelectedTool(null);
  }

  function onSelectTool(tool: McpTool) {
    setSelectedTool(tool);
    setTab("execute");
  }

  function onLog(log: ExecutionLog) {
    setLogs(prev => [log, ...prev]);
  }

  const successCount = logs.filter(l => l.status === "success").length;
  const errorCount = logs.filter(l => l.status === "error").length;

  return (
    <main className="page">
      <header className="page-header">
        <div className="header-left">
          <div className="header-icon" aria-hidden="true">⚡</div>
          <div>
            <h1 className="page-title">Zoho MCP Dashboard</h1>
            <p className="page-subtitle">
              {config
                ? <><span className="status-dot connected" /> Connected — {tools.length} tools available</>
                : <><span className="status-dot" /> Not connected</>}
            </p>
          </div>
        </div>
      </header>

      <section className="section">
        <p className="section-label">Connection</p>
        <ConnectionForm onConnected={onConnected} />
      </section>

      {config && (
        <>
          <div className="metrics-row">
            <div className="metric">
              <span className="metric-label">Tools</span>
              <span className="metric-value">{tools.length}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Executions</span>
              <span className="metric-value">{logs.length}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Success</span>
              <span className="metric-value success">{successCount}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Errors</span>
              <span className="metric-value error">{errorCount}</span>
            </div>
          </div>

          <div className="tabs">
            {(["tools", "execute", "logs"] as Tab[]).map(t => (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {t === "tools" ? "Tools" : t === "execute" ? "Execute" : `Audit logs${logs.length ? ` (${logs.length})` : ""}`}
              </button>
            ))}
          </div>

          <section className="tab-content">
            {tab === "tools" && <ToolsList tools={tools} onSelect={onSelectTool} />}
            {tab === "execute" && (
              <ExecuteTool config={config} tools={tools} selectedTool={selectedTool} onLog={onLog} />
            )}
            {tab === "logs" && <AuditLogs logs={logs} onClear={() => setLogs([])} />}
          </section>
        </>
      )}
    </main>
  );
}
