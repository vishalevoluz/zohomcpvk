"use client";

import { useState, useMemo } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { SECTIONS, categorizeTools, type Section } from "@/lib/sections";
import ConnectionForm from "@/components/ConnectionForm";
import ConnectedStatus from "@/components/ConnectedStatus";
import Sidebar from "@/components/Sidebar";
import SectionPanel from "@/components/SectionPanel";
import ModulesAudit from "@/components/ModulesAudit";
import WorkflowAudit from "@/components/WorkflowAudit";
import BlueprintAudit from "@/components/BlueprintAudit";
import FunctionAudit from "@/components/FunctionAudit";
import FieldsExplorer from "@/components/FieldsExplorer";
import AuditLogs from "@/components/AuditLogs";
import IntegrationsPanel from "@/components/IntegrationsPanel";
import CRMOverviewDashboard from "@/components/CRMOverviewDashboard";
import BusinessView from "@/components/BusinessView";
import { useCrmEntities } from "@/lib/useCrmEntities";

export default function DashboardPage() {
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [activeSection, setActiveSection] = useState<Section>("crm-dashboard");
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);

  const categorized = useMemo(() => categorizeTools(tools), [tools]);
  const activeSectionDef = SECTIONS.find(s => s.id === activeSection)!;
  const crm = useCrmEntities(config, tools, onLog);

  function onConnected(cfg: McpConfig, t: McpTool[]) {
    setConfig(cfg);
    setTools(t);
    setActiveSection("crm-dashboard");
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
        allTools={tools}
      />

      <div className="app-main">
        {/* Connection bar — always visible at the top */}
        {config ? (
          <ConnectedStatus config={config} onDisconnect={onDisconnect} />
        ) : (
          <div className="main-connection">
            <p className="main-connection-label">Connection</p>
            <ConnectionForm onConnected={onConnected} />
          </div>
        )}

        {config && (
          <>
            {/* Keep audit panels mounted so loaded data survives section switches */}
            <div style={{ display: activeSection === "crm-dashboard" ? undefined : "none" }}>
              <BusinessView
                entityData={crm.entityData}
                fetchAll={crm.fetchAll}
                onSelectSection={onSelectSection}
              />
              <CRMOverviewDashboard
                config={config}
                tools={tools}
                onLog={onLog}
                entityData={crm.entityData}
                fetchEntity={crm.fetchEntity}
                fetchAll={crm.fetchAll}
                lastRefresh={crm.lastRefresh}
                onSelectSection={onSelectSection}
              />
            </div>
            <div className="main-card" style={{ display: activeSection === "modules" ? undefined : "none" }}>
              <ModulesAudit config={config} tools={categorized.modules} allTools={tools} onLog={onLog} />
            </div>
            <div className="main-card" style={{ display: activeSection === "workflows" ? undefined : "none" }}>
              <WorkflowAudit config={config} tools={categorized.workflows} allTools={tools} onLog={onLog} />
            </div>
            <div className="main-card" style={{ display: activeSection === "blueprints" ? undefined : "none" }}>
              <BlueprintAudit config={config} tools={categorized.blueprints} allTools={tools} onLog={onLog} />
            </div>
            <div className="main-card" style={{ display: activeSection === "functions" ? undefined : "none" }}>
              <FunctionAudit config={config} tools={categorized.functions} allTools={tools} onLog={onLog} />
            </div>
            <div className="main-card" style={{ display: activeSection === "fields" ? undefined : "none" }}>
              <FieldsExplorer config={config} allTools={tools} onLog={onLog} />
            </div>

            {activeSection === "logs" && (
              <div className="main-card">
                <AuditLogs logs={logs} onClear={() => setLogs([])} />
              </div>
            )}

            {activeSection === "integrations" && (
              <div className="main-card">
                <IntegrationsPanel />
              </div>
            )}

            {!["crm-dashboard", "modules", "workflows", "blueprints", "functions", "fields", "logs", "integrations"].includes(activeSection) && (
              <SectionPanel
                section={activeSectionDef}
                tools={categorized[activeSection] ?? []}
                config={config}
                selectedTool={selectedTool}
                onSelectTool={setSelectedTool}
                onLog={onLog}
              />
            )}
          </>
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
