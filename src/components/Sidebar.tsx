"use client";

import { SECTIONS, type Section } from "@/lib/sections";
import type { McpTool } from "@/types/mcp";

interface Props {
  connected: boolean;
  activeSection: Section;
  onSelectSection: (s: Section) => void;
  categorized: Record<Section, McpTool[]>;
  logCount: number;
  onDisconnect: () => void;
}

export default function Sidebar({ connected, activeSection, onSelectSection, categorized, logCount, onDisconnect }: Props) {
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

      <p className="sidebar-nav-label">Sections</p>

      <nav className="sidebar-nav">
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
      </nav>

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
