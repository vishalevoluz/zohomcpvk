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

// Connected Tools is grouped the same way as the Audit nav, plus Fields —
// which has tools but no nav entry of its own (see lib/sections.ts).
const TOOL_GROUPS: { id: Section; label: string; icon: string }[] = [
  ...SECTIONS,
  { id: "fields", label: "Fields", icon: "▤" },
];

export default function Sidebar({ connected, activeSection, onSelectSection, categorized, logCount, onDisconnect, allTools }: Props) {
  const [toolsOpen, setToolsOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  function toggleGroup(id: string) {
    setOpenGroups(prev => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }

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
          className={`sidebar-nav-item sidebar-nav-overview ${activeSection === "crm-dashboard" ? "active" : ""}`}
          onClick={() => onSelectSection("crm-dashboard")}
        >
          <span className="sidebar-nav-icon">⌂</span>
          <span className="sidebar-nav-text">CRM Dashboard</span>
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
              {TOOL_GROUPS.map(group => {
                const items = categorized[group.id] ?? [];
                if (items.length === 0) return null;
                const groupOpen = openGroups[group.id] ?? true;
                return (
                  <div key={group.id} className="sidebar-tools-group">
                    <button
                      className="sidebar-tools-group-header"
                      onClick={() => toggleGroup(group.id)}
                    >
                      <span className="sidebar-tools-group-icon">{group.icon}</span>
                      <span className="sidebar-tools-group-title">{group.label}</span>
                      <span className="sidebar-nav-count">{items.length}</span>
                      <span className="sidebar-tools-chevron">{groupOpen ? "▴" : "▾"}</span>
                    </button>
                    {groupOpen && items.map(t => (
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
                );
              })}
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
