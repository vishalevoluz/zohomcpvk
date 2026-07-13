"use client";

import { useState, useMemo, useRef, useLayoutEffect } from "react";
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
import { useCrmEntities, CRM_ENTITIES, isEntityResolved } from "@/lib/useCrmEntities";
import { useCrmRecordSamples } from "@/lib/useCrmRecordSamples";
import { usePipelineStages } from "@/lib/usePipelineStages";
import { findDealsApiName } from "@/lib/flowMapModel";

export default function DashboardPage() {
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [activeSection, setActiveSection] = useState<Section>("crm-dashboard");
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);

  const categorized = useMemo(() => categorizeTools(tools), [tools]);
  const activeSectionDef = SECTIONS.find(s => s.id === activeSection)!;
  const crm = useCrmEntities(config, tools, onLog);
  const crmRecords = useCrmRecordSamples(
    config,
    tools,
    crm.entityData.modules.items,
    isEntityResolved(crm.entityData.modules),
    crm.entityData.blueprints.items,
    onLog,
  );
  const dealsApiName = findDealsApiName(crm.entityData);
  const pipelineStages = usePipelineStages(config, tools, dealsApiName, onLog);

  function fetchAllData() {
    crm.fetchAll();
    crmRecords.refetch();
    pipelineStages.refetch();
  }

  const resolvedEntityCount = CRM_ENTITIES.filter(e => isEntityResolved(crm.entityData[e.type])).length;
  const isPrefetching = !!config && resolvedEntityCount < CRM_ENTITIES.length;

  const wasConnected = useRef(false);
  useLayoutEffect(() => {
    // Newly-mounted dashboard content pushes page height way past the connect
    // form's — keep the viewport pinned where the user was instead of letting
    // the browser jump it around as that content streams in.
    if (config && !wasConnected.current) {
      window.scrollTo({ top: 0 });
    }
    wasConnected.current = !!config;
  }, [config]);

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
          <>
            <ConnectedStatus config={config} onDisconnect={onDisconnect} />
            {isPrefetching && (
              <div className="connect-progress">
                <span className="spinner" />
                <span className="connect-progress-label">
                  Loading {resolvedEntityCount}/{CRM_ENTITIES.length} data sources…
                </span>
                <div className="connect-progress-track">
                  <div
                    className="connect-progress-fill"
                    style={{ width: `${(resolvedEntityCount / CRM_ENTITIES.length) * 100}%` }}
                  />
                </div>
                <span className="connect-progress-pct">
                  {Math.round((resolvedEntityCount / CRM_ENTITIES.length) * 100)}%
                </span>
              </div>
            )}
          </>
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
                recordSamples={crmRecords.data}
                pipelineStages={pipelineStages.data}
                fetchAll={fetchAllData}
                onSelectSection={onSelectSection}
              />
              <CRMOverviewDashboard
                config={config}
                tools={tools}
                onLog={onLog}
                entityData={crm.entityData}
                fetchEntity={crm.fetchEntity}
                fetchAll={fetchAllData}
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
