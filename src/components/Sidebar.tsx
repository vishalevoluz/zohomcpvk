"use client";

import { useState } from "react";
import { SECTIONS, type Section } from "@/lib/sections";
import type { McpTool } from "@/types/mcp";

interface Props {
  connected: boolean;
  activeSection: Section;
  onSelectSection: (s: Section) => void;
  categorized: Record<Section, McpTool[]>;
  logCount: number;
  onDisconnect: () => void;
  allTools: McpTool[];
}

export default function Sidebar({ connected, activeSection, onSelectSection, categorized, logCount, onDisconnect, allTools }: Props) {
  const [toolsOpen, setToolsOpen] = useState(true);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-icon">⚡</div>
        <span className="sidebar-brand-name">EvoAudit</span>
      </div>

      {connected && (
        <div className="sidebar-status">
          <span className="status-dot connected" />
          Connected
        </div>
      )}

      <p className="sidebar-nav-label">Dashboard</p>

      <nav className="sidebar-nav">
        <button
          className={`sidebar-nav-item sidebar-nav-overview ${activeSection === "crm-overview" ? "active" : ""}`}
          onClick={() => onSelectSection("crm-overview")}
        >
          <span className="sidebar-nav-icon">◉</span>
          <span className="sidebar-nav-text">CRM Overview</span>
        </button>

        <div className="sidebar-divider" />
        <p className="sidebar-nav-label" style={{ marginTop: 4 }}>Audit</p>

        {SECTIONS.map(sec => {
          const count = categorized[sec.id]?.length ?? 0;
          return (
            <button
              key={sec.id}
              className={`sidebar-nav-item ${activeSection === sec.id ? "active" : ""}`}
              onClick={() => onSelectSection(sec.id)}
            >
              <span className="sidebar-nav-icon">{sec.icon}</span>
              <span className="sidebar-nav-text">{sec.label}</span>
              {connected && count > 0 && (
                <span className="sidebar-nav-count">{count}</span>
              )}
            </button>
          );
        })}

        <div className="sidebar-divider" />

        <button
          className={`sidebar-nav-item ${activeSection === "logs" ? "active" : ""}`}
          onClick={() => onSelectSection("logs")}
        >
          <span className="sidebar-nav-icon">◎</span>
          <span className="sidebar-nav-text">Audit Logs</span>
          {logCount > 0 && <span className="sidebar-nav-count">{logCount}</span>}
        </button>

        <button
          className={`sidebar-nav-item ${activeSection === "integrations" ? "active" : ""}`}
          onClick={() => onSelectSection("integrations")}
        >
          <span className="sidebar-nav-icon">⧉</span>
          <span className="sidebar-nav-text">Integrations</span>
        </button>
      </nav>

      {connected && allTools.length > 0 && (
        <div className="sidebar-tools-section">
          <button
            className="sidebar-tools-header"
            onClick={() => setToolsOpen(o => !o)}
          >
            <span className="sidebar-tools-title">Connected Tools</span>
            <span className="sidebar-nav-count">{allTools.length}</span>
            <span className="sidebar-tools-chevron">{toolsOpen ? "▴" : "▾"}</span>
          </button>
          {toolsOpen && (
            <div className="sidebar-tools-list">
              {allTools.map(t => (
                <div
                  key={t.name}
                  className="sidebar-tool-item"
                  title={t.description ?? t.name}
                >
                  <span className="sidebar-tool-dot" />
                  <span className="sidebar-tool-name">{t.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {connected && (
        <div className="sidebar-footer">
          <button className="sidebar-disconnect" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      )}
    </aside>
  );
}
