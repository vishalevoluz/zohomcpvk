"use client";

import { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { SECTIONS, categorizeTools, type Section } from "@/lib/sections";
import ConnectWizard from "@/components/ConnectWizard";
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
import { useRuleCoverage } from "@/lib/useRuleCoverage";
import { useModuleRecordCounts } from "@/lib/useModuleRecordCounts";
import { useOrgCurrency } from "@/lib/useOrgCurrency";
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
  const ruleCoverage = useRuleCoverage(config, tools, crm.entityData, onLog);
  const moduleRecordCounts = useModuleRecordCounts(config, tools, crm.entityData, onLog);
  const orgCurrency = useOrgCurrency(config, tools, onLog);

  function fetchAllData() {
    crm.fetchAll();
    crmRecords.refetch();
    pipelineStages.refetch();
    ruleCoverage.refetch();
    moduleRecordCounts.refetch();
    orgCurrency.refetch();
  }

  const resolvedEntityCount = CRM_ENTITIES.filter(e => isEntityResolved(crm.entityData[e.type])).length;
  const coreResolved = resolvedEntityCount === CRM_ENTITIES.length;

  // Once the core CRM entities resolve, the secondary hooks that feed
  // BusinessView/CRMOverviewDashboard (record samples, pipeline stages, rule
  // coverage, org currency) are still fetching in the background and swap
  // their skeleton placeholders for real, differently-sized content shortly
  // after reveal — visibly shifting the page right after the user sees it.
  // They ride the same MCP round-trip as the core entities and typically
  // settle within a second or two of them, so holding the loader up a bit
  // longer past coreResolved lets that settle before reveal instead of the
  // user watching it happen. Resets whenever coreResolved goes false again
  // (a manual refresh re-triggers the full loader, same as before).
  const [loaderHoldElapsed, setLoaderHoldElapsed] = useState(false);
  useEffect(() => {
    if (!config || !coreResolved) {
      setLoaderHoldElapsed(false);
      return;
    }
    const timer = setTimeout(() => setLoaderHoldElapsed(true), 1200);
    return () => clearTimeout(timer);
  }, [config, coreResolved]);

  const isPrefetching = !!config && (!coreResolved || !loaderHoldElapsed);

  // The connect wizard can be scrolled well down its own (much taller) page;
  // swapping it out for the dashboard doesn't reset that scroll position on
  // its own, so without this the dashboard can render already scrolled past
  // its own top and land wherever that pixel offset happens to fall — e.g.
  // partway down the CRM Overview section. Fires once per connect, right as
  // the full-page loader hands off to the real dashboard, not on every
  // render and not on a later manual refresh (isPrefetching flipping back
  // to true doesn't reset wasConnected).
  const wasConnected = useRef(false);
  useLayoutEffect(() => {
    if (config && !isPrefetching && !wasConnected.current) {
      window.scrollTo({ top: 0 });
      wasConnected.current = true;
    }
    if (!config) wasConnected.current = false;
  }, [config, isPrefetching]);

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

  if (!config) {
    return (
      <div className="landing-page wizard-standalone">
        <header className="landing-nav">
          <Link href="/" className="landing-logo">
            <span className="landing-logo-mark">
              <ShieldCheck size={15} strokeWidth={2} />
            </span>
            <span>Evo<span className="landing-logo-accent">Audit</span></span>
          </Link>
          <Link href="/" className="landing-btn">Back to home</Link>
        </header>

        <div className="wizard-standalone-body">
          <div className="wizard-page">
            <div className="wizard-page-intro">
              <h2>Connect to your Zoho MCP server</h2>
              <p>Follow the steps below to load modules, workflows, fields, blueprints, and functions.</p>
            </div>
            <ConnectWizard onConnected={onConnected} />
          </div>
        </div>
      </div>
    );
  }

  // Gates the entire app shell behind a single full-page loading screen
  // whenever core CRM data isn't resolved yet — both on the initial connect
  // and on every later manual refresh, so refreshing shows the same loader
  // instead of a slim inline bar under an already-rendered dashboard.
  if (isPrefetching) {
    return (
      <div className="evo-loader-page">
        <div className="evo-loader-wrap">
          <div className="evo-loader-badge">
            <span className="spinner spinner-lg" />
            <span className="evo-loader-name">Evo<span className="landing-logo-accent">Audit</span></span>
          </div>
          <div className="evo-loader-status">
            Loading {resolvedEntityCount}/{CRM_ENTITIES.length} data sources
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        connected
        activeSection={activeSection}
        onSelectSection={onSelectSection}
        categorized={categorized}
        logCount={logs.length}
        onDisconnect={onDisconnect}
        allTools={tools}
      />

      <div className="app-main">
        <ConnectedStatus config={config} onDisconnect={onDisconnect} />

        {/* Keep audit panels mounted so loaded data survives section switches.
            No loading fallback needed here — isPrefetching is guaranteed false
            by the time this renders (see the full-page loader early-return above). */}
        <div style={{ display: activeSection === "crm-dashboard" ? undefined : "none" }}>
          <BusinessView
            entityData={crm.entityData}
            recordSamples={crmRecords.data}
            pipelineStages={pipelineStages.data}
            ruleCoverage={ruleCoverage.data}
            moduleRecordCounts={moduleRecordCounts.data}
            currencySymbol={orgCurrency.symbol}
            fetchAll={fetchAllData}
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
            pipelineStageCount={pipelineStages.data.items.length}
            pipelineStages={pipelineStages.data}
            ruleCoverage={ruleCoverage.data}
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
      </div>
    </div>
  );
}
