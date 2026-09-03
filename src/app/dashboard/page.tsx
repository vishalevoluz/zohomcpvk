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
import { useMandatoryFields } from "@/lib/useMandatoryFields";
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
  const mandatoryFields = useMandatoryFields(config, tools, crm.entityData.modules.items, isEntityResolved(crm.entityData.modules), onLog);
  const orgCurrency = useOrgCurrency(config, tools, onLog);

  function fetchAllData() {
    crm.fetchAll();
    crmRecords.refetch();
    pipelineStages.refetch();
    ruleCoverage.refetch();
    moduleRecordCounts.refetch();
    mandatoryFields.refetch();
    orgCurrency.refetch();
  }

  const resolvedEntityCount = CRM_ENTITIES.filter(e => isEntityResolved(crm.entityData[e.type])).length;

  // HealthScoreDashboard (the "CRM Health Score" panel at the top of the CRM
  // Dashboard) computes its own "resolved" flag from pipelineStages and
  // mandatoryFields too, not just crm.entityData - see buildHealthAuditModel's
  // `resolved` line and BusinessView's `pipelineStagesResolved`. Those two ride
  // separate fetch chains (getLayouts -> getPipelines, getLayouts -> mandatory
  // field scan) that don't always land inside the old fixed 1200ms hold below,
  // so the full-page loader used to hand off before they were actually done,
  // exposing HealthScoreDashboard's own "Checking…" / "-" skeleton state under
  // the sidebar instead of a finished dashboard. Folding both into the same
  // gate the loader watches means it now only clears once the panel it's
  // covering has real content to show.
  const pipelineStagesReady = !pipelineStages.data.loading && (pipelineStages.data.lastFetched !== null || pipelineStages.data.error !== null);
  const mandatoryFieldsReady = !mandatoryFields.data.loading && mandatoryFields.data.lastFetched !== null;
  const TOTAL_LOAD_STEPS = CRM_ENTITIES.length + 2;
  const resolvedLoadSteps = resolvedEntityCount + (pipelineStagesReady ? 1 : 0) + (mandatoryFieldsReady ? 1 : 0);
  const coreResolved = resolvedLoadSteps === TOTAL_LOAD_STEPS;

  // Even with the stricter gate above, a few other secondary hooks (record
  // samples, rule coverage, org currency) still ride the same MCP round-trip
  // and can swap in real content a beat after coreResolved flips - this short
  // hold lets that settle before reveal instead of the user watching it shift.
  // Resets whenever coreResolved goes false again (a manual refresh re-triggers
  // the full loader, same as before).
  const [loaderHoldElapsed, setLoaderHoldElapsed] = useState(false);
  useEffect(() => {
    if (!config || !coreResolved) {
      setLoaderHoldElapsed(false);
      return;
    }
    const timer = setTimeout(() => setLoaderHoldElapsed(true), 600);
    return () => clearTimeout(timer);
  }, [config, coreResolved]);

  const isPrefetching = !!config && (!coreResolved || !loaderHoldElapsed);

  // The connect wizard can be scrolled well down its own (much taller) page;
  // swapping it out for the dashboard doesn't reset that scroll position on
  // its own, so without this the dashboard can render already scrolled past
  // its own top and land wherever that pixel offset happens to fall - e.g.
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
  // whenever core CRM data isn't resolved yet - both on the initial connect
  // and on every later manual refresh, so refreshing shows the same loader
  // instead of a slim inline bar under an already-rendered dashboard.
  if (isPrefetching) {
    // Held at 99% (never a false-looking 100%) until loaderHoldElapsed
    // actually flips isPrefetching to false - coreResolved alone means every
    // entity call returned, not that the secondary hooks riding along with
    // them have settled yet (see the isPrefetching comment above).
    const loaderPct = coreResolved ? 99 : Math.min(99, Math.round((resolvedLoadSteps / TOTAL_LOAD_STEPS) * 100));
    return (
      <div className="evo-loader-page">
        <div className="evo-loader-wrap">
          <div className="evo-loader-badge">
            <span className="spinner spinner-lg" />
            <span className="evo-loader-name">Evo<span className="landing-logo-accent">Audit</span></span>
          </div>
          <div className="evo-loader-progress-track" role="progressbar" aria-valuenow={loaderPct} aria-valuemin={0} aria-valuemax={100}>
            <div className="evo-loader-progress-fill" style={{ width: `${loaderPct}%` }} />
          </div>
          <div className="evo-loader-progress-pct">{loaderPct}%</div>
          <div className="evo-loader-status">
            Loading {resolvedLoadSteps}/{TOTAL_LOAD_STEPS} data sources
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
            No loading fallback needed here - isPrefetching is guaranteed false
            by the time this renders (see the full-page loader early-return above). */}
        <div style={{ display: activeSection === "crm-dashboard" ? undefined : "none" }}>
          <BusinessView
            entityData={crm.entityData}
            recordSamples={crmRecords.data}
            pipelineStages={pipelineStages.data}
            ruleCoverage={ruleCoverage.data}
            moduleRecordCounts={moduleRecordCounts.data}
            mandatoryFields={mandatoryFields.data}
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
