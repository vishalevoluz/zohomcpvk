"use client";

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Megaphone, UserPlus, Users, Briefcase, Building2, FileText,
  Settings2, GitBranch, AlertTriangle, ArrowRight, ArrowDown, Circle,
} from "lucide-react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { HealthZone } from "@/lib/businessScore";
import type { RecordSampleStageId, RecordSampleState, PipelineStagesState } from "@/lib/flowMapModel";
import {
  buildJourneyModel,
  type JourneyStageCard as JourneyStageCardModel,
  type JourneyStageId,
  type JourneyConnection,
  type ConfidenceLevel,
} from "@/lib/journeyMap";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  recordSamples: Record<RecordSampleStageId, RecordSampleState>;
  pipelineStages: PipelineStagesState;
  ruleCoverage: RuleCoverage | null;
  onSelectSection: (s: Section) => void;
}

const STAGE_ICONS: Record<JourneyStageId, LucideIcon> = {
  leads: UserPlus,
  campaigns: Megaphone,
  contacts: Users,
  deals: Briefcase,
  accounts: Building2,
  invoices: FileText,
};

// The primary, always-flowing lead-to-cash path — everything else (Campaigns
// as an alternate entry point, Invoices branching off Deals) is real but
// secondary, and rendered smaller/quieter so the eye lands on this first.
const PRIMARY_STAGE_IDS = new Set<JourneyStageId>(["leads", "contacts", "deals", "accounts"]);

// Same wording as the CRM Health Score gauge's zone banding (see
// businessScore.ts) reused here for stage cards and summary tiles, so
// "Healthy"/"Needs Attention"/etc. mean one consistent thing across the
// whole dashboard.
const ZONE_LABEL: Record<HealthZone, string> = {
  healthy: "Excellent",
  "needs-attention": "Needs Attention",
  "at-risk": "At Risk",
  critical: "Critical",
};

const CONFIDENCE_SHORT: Record<ConfidenceLevel, string> = { high: "High", medium: "Medium", low: "Low" };
const CONFIDENCE_TOOLTIP: Record<ConfidenceLevel, string> = {
  high: "Verified using sampled CRM records.",
  medium: "Verified using workflows, automation rules, layouts, approvals, or validation rules.",
  low: "Only module existence is confirmed — no configuration or record evidence yet.",
};

function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  return (
    <span className={`jc-confidence jc-confidence-${level}`} data-tooltip={CONFIDENCE_TOOLTIP[level]}>
      <span className="jc-confidence-dot" />
      {CONFIDENCE_SHORT[level]}
    </span>
  );
}

function AutomationChip({ automation }: { automation: JourneyStageCardModel["automation"] }) {
  if (automation.kind === "not-applicable") return null;
  if (automation.kind === "loading") {
    return <span className="jc-automation jc-automation-loading"><Circle size={9} /> Checking…</span>;
  }
  const live = automation.kind === "live";
  const b = automation.breakdown;
  const checks = b
    ? [
        { label: "Workflow", on: b.workflowActive > 0 },
        { label: "Assignment Rule", on: b.assignment > 0 },
        { label: "Validation Rule", on: b.validation > 0 },
        { label: "Approval Process", on: b.approval > 0 },
        { label: "Layout Rule", on: b.layout > 0 },
      ].filter(c => c.on)
    : [];
  return (
    <div className={`jc-automation jc-automation-${live ? "live" : "gap"}`}>
      <Settings2 size={11} />
      <span>{live ? "Automated" : "Not automated"}</span>
      {checks.length > 0 && (
        <div className="jc-automation-pop">
          {checks.map(c => <span key={c.label} className="jc-automation-pop-item">✓ {c.label}</span>)}
        </div>
      )}
    </div>
  );
}

function StageCard({
  stage, primary, dimmed, onOpen, onHoverStart, onHoverEnd,
}: {
  stage: JourneyStageCardModel;
  primary: boolean;
  dimmed: boolean;
  onOpen: () => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}) {
  const Icon = STAGE_ICONS[stage.id];
  const loading = stage.status === "loading";
  const zoneKey = loading ? "loading" : !stage.connected ? "not-connected" : stage.healthZone;
  const zoneLabel = loading ? "Checking…" : !stage.connected ? "Not Connected" : ZONE_LABEL[stage.healthZone];

  return (
    <button
      type="button"
      className={`jc-stage-card ${primary ? "primary" : "secondary"} zone-${zoneKey} ${dimmed ? "jc-dimmed" : ""}`}
      onClick={onOpen}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div className="jc-stage-head">
        <span className="jc-stage-icon"><Icon size={primary ? 16 : 13} strokeWidth={2} /></span>
        <span className="jc-stage-name">{stage.label}</span>
        <span className={`jc-stage-dot zone-${zoneKey}`} />
      </div>

      <div className="jc-stage-health-block">
        <span className="jc-stage-health-value">{loading ? "…" : `${stage.healthPct}%`}</span>
        <span className={`jc-stage-health-label zone-${zoneKey}`}>{zoneLabel}</span>
      </div>

      {!loading && <AutomationChip automation={stage.automation} />}

      {stage.id === "deals" && stage.blueprint && (
        <div className={`jc-blueprint-chip ${stage.blueprint.active > 0 ? "live" : stage.blueprint.total > 0 ? "gap" : "empty"}`}>
          <GitBranch size={11} />
          {stage.blueprint.total === 0 ? "No blueprint" : `${stage.blueprint.active}/${stage.blueprint.total} blueprint active`}
        </div>
      )}

      <div className="jc-stage-foot">
        <span className="jc-stage-records">
          {stage.recordCount === null ? "—" : `${stage.recordCount.toLocaleString()} verified`}
        </span>
        <ConfidenceBadge level={stage.confidence} />
      </div>
    </button>
  );
}

function ConnectorH({ connection, dimmed }: { connection: JourneyConnection; dimmed: boolean }) {
  return (
    <div className={`jc-connector jc-connector-h kind-${connection.kind} ${dimmed ? "jc-dimmed" : ""}`} data-tooltip={connection.detail}>
      <span className="jc-connector-label">
        {connection.kind === "broken" && <AlertTriangle size={10} />}
        {connection.shortLabel}
      </span>
      <span className="jc-connector-track"><span className="jc-connector-line" /></span>
      <ArrowRight size={13} className="jc-connector-arrow" />
    </div>
  );
}

function ConnectorV({ connection, dashed, dimmed }: { connection: JourneyConnection; dashed?: boolean; dimmed: boolean }) {
  return (
    <div className={`jc-connector jc-connector-v kind-${connection.kind} ${dashed ? "dashed" : ""} ${dimmed ? "jc-dimmed" : ""}`} data-tooltip={connection.detail}>
      <span className="jc-connector-label">
        {connection.kind === "broken" && <AlertTriangle size={10} />}
        {connection.shortLabel}
      </span>
      <span className="jc-connector-track"><span className="jc-connector-line" /></span>
      <ArrowDown size={13} className="jc-connector-arrow" />
    </div>
  );
}

function SummaryTile({ value, label, description, tone }: { value: string; label: string; description: string; tone: "healthy" | "warning" | "critical" | "neutral" }) {
  return (
    <div className={`jc-summary-tile tone-${tone}`}>
      <span className="jc-summary-value">{value}</span>
      <span className="jc-summary-label">{label}</span>
      <span className="jc-summary-desc">{description}</span>
    </div>
  );
}

export default function BusinessJourneyCard({ entityData, recordSamples, pipelineStages, ruleCoverage, onSelectSection }: Props) {
  const [openStageId, setOpenStageId] = useState<JourneyStageId | null>(null);
  const [hoveredId, setHoveredId] = useState<JourneyStageId | null>(null);

  const model = useMemo(
    () => buildJourneyModel(entityData, recordSamples, pipelineStages, ruleCoverage),
    [entityData, recordSamples, pipelineStages, ruleCoverage],
  );

  const byId = useMemo(() => new Map(model.stages.map(s => [s.id, s])), [model.stages]);
  const conn = useMemo(() => new Map(model.connections.map(c => [c.id, c])), [model.connections]);
  const openStage = openStageId ? byId.get(openStageId) ?? null : null;
  const s = model.summary;

  // Hover a stage → highlight it plus everything it's directly connected to;
  // fade the rest of the chart so the eye follows one path at a time.
  const related = useMemo(() => {
    if (!hoveredId) return null;
    const set = new Set<JourneyStageId>([hoveredId]);
    model.connections.forEach(c => {
      if (c.fromId === hoveredId) set.add(c.toId);
      if (c.toId === hoveredId) set.add(c.fromId);
    });
    return set;
  }, [hoveredId, model.connections]);

  function stage(id: JourneyStageId) {
    return byId.get(id) as JourneyStageCardModel;
  }
  function edge(id: string) {
    return conn.get(id) as JourneyConnection;
  }
  function stageDimmed(id: JourneyStageId) {
    return related !== null && !related.has(id);
  }
  function connDimmed(id: string) {
    const c = edge(id);
    return hoveredId !== null && c.fromId !== hoveredId && c.toId !== hoveredId;
  }
  function hoverProps(id: JourneyStageId) {
    return { onHoverStart: () => setHoveredId(id), onHoverEnd: () => setHoveredId(prev => (prev === id ? null : prev)) };
  }

  const modulesComplete = s.modulesConnected === s.modulesTotal;
  const automationComplete = s.automatedStages === s.automatedTotal;

  return (
    <div className="journey-view">
      <div className="business-view-section journey-card">
        <div className="journey-card-header">
          <div>
            <h3 className="business-view-section-title" style={{ marginBottom: 2 }}>Business Journey Map</h3>
            <p className="business-view-sub" style={{ margin: 0 }}>
              Where customers enter, where they move next, and where the journey breaks down.
            </p>
          </div>
          <div className="jc-legend">
            <span className="jc-legend-item" data-tooltip-below="Runs automatically or is confirmed by real records.">
              <span className="jc-legend-swatch kind-automated" />Automated
            </span>
            <span className="jc-legend-item" data-tooltip-below="No automation is watching this step — someone has to do it by hand.">
              <span className="jc-legend-swatch kind-manual" />Manual
            </span>
            <span className="jc-legend-item" data-tooltip-below="The expected connection is missing or misconfigured.">
              <span className="jc-legend-swatch kind-broken" />Broken
            </span>
          </div>
        </div>

        <div className="jc-summary-grid">
          <SummaryTile
            value={model.resolved ? `${s.overallHealthPct}%` : "—"}
            label="Journey Health"
            description={model.resolved ? ZONE_LABEL[s.overallHealthZone] : "Loading"}
            tone={!model.resolved ? "neutral" : s.overallHealthZone === "healthy" ? "healthy" : s.overallHealthZone === "critical" ? "critical" : "warning"}
          />
          <SummaryTile
            value={`${s.modulesConnected}/${s.modulesTotal}`}
            label="Modules Connected"
            description={modulesComplete ? "Complete" : `${s.modulesTotal - s.modulesConnected} missing`}
            tone={modulesComplete ? "healthy" : "warning"}
          />
          <SummaryTile
            value={`${s.automatedStages}/${s.automatedTotal}`}
            label="Automated Stages"
            description={automationComplete ? "Complete" : `${s.automatedTotal - s.automatedStages} gaps`}
            tone={automationComplete ? "healthy" : "warning"}
          />
          <SummaryTile
            value={String(s.brokenConnections)}
            label="Broken Connections"
            description={s.brokenConnections === 0 ? "All clear" : "Needs attention"}
            tone={s.brokenConnections === 0 ? "healthy" : "critical"}
          />
          <SummaryTile
            value={`${s.activeBlueprints}/${s.totalBlueprints}`}
            label="Active Blueprints"
            description={s.activeBlueprints > 0 ? "Configured" : s.totalBlueprints > 0 ? "Inactive" : "None set up"}
            tone={s.activeBlueprints > 0 ? "healthy" : "neutral"}
          />
          <SummaryTile
            value={s.recordsSampled.toLocaleString()}
            label="Records Sampled"
            description={s.recordsSampled > 0 ? "Verified" : "Pending"}
            tone={s.recordsSampled > 0 ? "healthy" : "neutral"}
          />
        </div>

        <div className="jc-grid-scroll">
          <div className="jc-grid">
            <div className="jc-cell jc-secondary-cell" style={{ gridColumn: 3, gridRow: 1 }}>
              <StageCard stage={stage("campaigns")} primary={false} dimmed={stageDimmed("campaigns")} onOpen={() => setOpenStageId("campaigns")} {...hoverProps("campaigns")} />
              <span className="jc-secondary-tag">Secondary entry point</span>
            </div>
            <div className="jc-cell jc-connector-cell" style={{ gridColumn: 3, gridRow: 2 }}>
              <ConnectorV connection={edge("campaigns-to-contacts")} dashed dimmed={connDimmed("campaigns-to-contacts")} />
            </div>

            <div className="jc-cell" style={{ gridColumn: 1, gridRow: 3 }}>
              <StageCard stage={stage("leads")} primary dimmed={stageDimmed("leads")} onOpen={() => setOpenStageId("leads")} {...hoverProps("leads")} />
            </div>
            <div className="jc-cell jc-connector-cell" style={{ gridColumn: 2, gridRow: 3 }}>
              <ConnectorH connection={edge("leads-to-contacts")} dimmed={connDimmed("leads-to-contacts")} />
            </div>
            <div className="jc-cell" style={{ gridColumn: 3, gridRow: 3 }}>
              <StageCard stage={stage("contacts")} primary dimmed={stageDimmed("contacts")} onOpen={() => setOpenStageId("contacts")} {...hoverProps("contacts")} />
            </div>
            <div className="jc-cell jc-connector-cell" style={{ gridColumn: 4, gridRow: 3 }}>
              <ConnectorH connection={edge("contacts-to-deals")} dimmed={connDimmed("contacts-to-deals")} />
            </div>
            <div className="jc-cell" style={{ gridColumn: 5, gridRow: 3 }}>
              <StageCard stage={stage("deals")} primary dimmed={stageDimmed("deals")} onOpen={() => setOpenStageId("deals")} {...hoverProps("deals")} />
            </div>
            <div className="jc-cell jc-connector-cell" style={{ gridColumn: 6, gridRow: 3 }}>
              <ConnectorH connection={edge("deals-to-accounts")} dimmed={connDimmed("deals-to-accounts")} />
            </div>
            <div className="jc-cell" style={{ gridColumn: 7, gridRow: 3 }}>
              <StageCard stage={stage("accounts")} primary dimmed={stageDimmed("accounts")} onOpen={() => setOpenStageId("accounts")} {...hoverProps("accounts")} />
            </div>

            <div className="jc-cell jc-connector-cell" style={{ gridColumn: 5, gridRow: 4 }}>
              <ConnectorV connection={edge("deals-to-invoices")} dimmed={connDimmed("deals-to-invoices")} />
            </div>
            <div className="jc-cell" style={{ gridColumn: 5, gridRow: 5 }}>
              <StageCard stage={stage("invoices")} primary={false} dimmed={stageDimmed("invoices")} onOpen={() => setOpenStageId("invoices")} {...hoverProps("invoices")} />
            </div>
          </div>
        </div>

        {!model.resolved && <p className="business-view-hint">Loading your business journey…</p>}
      </div>

      <Dialog open={openStage !== null} onOpenChange={(open) => { if (!open) setOpenStageId(null); }}>
        <DialogContent className="jc-dialog">
          {openStage && (
            <>
              <DialogHeader>
                <DialogTitle className="jc-dialog-title">
                  {openStage.label}
                  <span className={`jc-dialog-status status-${openStage.status}`}>
                    {openStage.connected ? "Connected" : openStage.status === "loading" ? "Loading" : "Not connected"}
                  </span>
                </DialogTitle>
                <DialogDescription>{openStage.detail}</DialogDescription>
              </DialogHeader>

              <div className="jc-dialog-body">
                <div className="jc-dialog-row">
                  <span>Confidence</span>
                  <ConfidenceBadge level={openStage.confidence} />
                </div>
                <div className="jc-dialog-row">
                  <span>Journey Health</span>
                  <strong>{openStage.healthPct}% · {ZONE_LABEL[openStage.healthZone]}</strong>
                </div>
                {openStage.recordCount !== null && (
                  <div className="jc-dialog-row">
                    <span>Sampled Records</span>
                    <strong>{openStage.recordCount.toLocaleString()}</strong>
                  </div>
                )}

                {openStage.automation.kind !== "not-applicable" && (
                  <div className="jc-dialog-section">
                    <h4>Automation</h4>
                    <AutomationChip automation={openStage.automation} />
                  </div>
                )}

                {openStage.blueprint && (
                  <div className="jc-dialog-section">
                    <h4>Blueprints</h4>
                    <p className="jc-dialog-text">
                      {openStage.blueprint.total === 0
                        ? "No blueprint process is configured for Deals."
                        : `${openStage.blueprint.active} of ${openStage.blueprint.total} blueprint process${openStage.blueprint.total !== 1 ? "es" : ""} active.`}
                    </p>
                  </div>
                )}

                {openStage.evidence.length > 0 && (
                  <div className="jc-dialog-section">
                    <h4>Evidence From Sampled Records</h4>
                    <ul className="jc-dialog-evidence">
                      {openStage.evidence.map((line, i) => <li key={i}>{line}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              {openStage.targetSection && (
                <button
                  className="btn-secondary"
                  onClick={() => { onSelectSection(openStage.targetSection as Section); setOpenStageId(null); }}
                >
                  View in Audit
                </button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
