"use client";

import { useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { SECTIONS, categorizeTools, type Section } from "@/lib/sections";
import ConnectionForm from "@/components/ConnectionForm";
import Sidebar from "@/components/Sidebar";
import SectionPanel from "@/components/SectionPanel";
import AuditLogs from "@/components/AuditLogs";

export default function DashboardPage() {
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [activeSection, setActiveSection] = useState<Section>("modules");
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);

  const categorized = categorizeTools(tools);
  const activeSectionDef = SECTIONS.find(s => s.id === activeSection)!;

  function onConnected(cfg: McpConfig, t: McpTool[]) {
    setConfig(cfg);
    setTools(t);
    setActiveSection("modules");
    setSelectedTool(null);
  }

  function onDisconnect() {
    setConfig(null);
    setTools([]);
    setSelectedTool(null);
  }

  function onSelectSection(s: Section) {
    setActiveSection(s);
    setSelectedTool(null);
  }

  function onLog(log: ExecutionLog) {
    setLogs(prev => [log, ...prev]);
  }

  return (
    <div className="app-shell">
      <Sidebar
        connected={!!config}
        activeSection={activeSection}
        onSelectSection={onSelectSection}
        categorized={categorized}
        logCount={logs.length}
        onDisconnect={onDisconnect}
      />

      <div className="app-main">
        <div className="main-connection">
          <p className="main-connection-label">Connection</p>
          <ConnectionForm onConnected={onConnected} />
        </div>

        {config && (
          activeSection === "logs" ? (
            <div className="main-card">
              <AuditLogs logs={logs} onClear={() => setLogs([])} />
            </div>
          ) : (
            <SectionPanel
              section={activeSectionDef}
              tools={categorized[activeSection] ?? []}
              config={config}
              selectedTool={selectedTool}
              onSelectTool={setSelectedTool}
              onLog={onLog}
            />
          )
        )}

        {!config && (
          <div className="connect-prompt">
            <div className="connect-prompt-inner">
              <div className="connect-prompt-icon">⚡</div>
              <h2 className="connect-prompt-title">Connect to your Zoho MCP server</h2>
              <p className="connect-prompt-sub">Enter your MCP URL above to load modules, workflows, fields, blueprints, and functions.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
