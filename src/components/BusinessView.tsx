"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import type { RuleCoverage } from "@/lib/businessScore";
import { buildFlowMap, FLOW_MAP_ENTITIES, type FlowNode, type FlowEdge, type FlowLane, type RecordSampleStageId, type RecordSampleState, type PipelineStagesState } from "@/lib/flowMapModel";
import { evaluateCostCards } from "@/lib/costCards";
import { computeTopActions } from "@/lib/priorityActions";
import HealthScoreDashboard from "@/components/HealthScoreDashboard";

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  recordSamples: Record<RecordSampleStageId, RecordSampleState>;
  pipelineStages: PipelineStagesState;
  ruleCoverage: RuleCoverage | null;
  fetchAll: () => void;
  onSelectSection: (s: Section) => void;
}

const SEVERITY_TOOLTIPS: Record<string, string> = {
  CRITICAL: "Urgent — this is actively costing you money or exposing you to risk right now.",
  WARNING: "A real gap in your setup that should be fixed soon, before it gets worse.",
  REVIEW: "Worth a look when you have time, but not urgent.",
};

const IMPACT_TOOLTIPS: Record<string, string> = {
  High: "Fixing this meaningfully improves revenue, risk, or how efficiently your team works.",
  Medium: "Fixing this helps, but the business impact is moderate.",
  Low: "Fixing this is minor cleanup — nice to have, not a priority.",
};

const EFFORT_TOOLTIPS: Record<string, string> = {
  Easy: "A quick change your Zoho admin or consultant can make in one sitting.",
  Medium: "Takes some planning and setup time, but isn't a major project.",
  Hard: "A bigger project — expect it to take real time and testing to get right.",
};

function SectionTitle({ text, tooltip }: { text: string; tooltip: string }) {
  return (
    <h3 className="business-view-section-title">
      <span className="th-tip" data-tooltip-below={tooltip}>
        {text}
        <span className="th-info">i</span>
      </span>
    </h3>
  );
}

// ─── Flow map layout geometry ───────────────────────────────────────────────────

// "automation" lane is intentionally excluded — its nodes (Leads/Campaigns/
// Contacts/Deals Automation) are hidden from this diagram per product
// request; see AUTOMATION_NODE_ID below. flowMapModel.ts still computes them
// (its FlowLane type is untouched), this is a render-time filter only.
const FLOW_LANES: { id: FlowLane; label: string }[] = [
  { id: "entry", label: "Entry" },
  { id: "qualification", label: "Qualification" },
  { id: "outcome", label: "Outcome" },
];
const LANE_LABEL_H = 22;
const LANE_ROW_H = 64;
const LANE_GAP = 22;
const LANE_BLOCK_H = LANE_LABEL_H + LANE_ROW_H + LANE_GAP;
const COL_W = 168;
const MAX_COL_W = 260;
const NODE_W = 148;
const NODE_H = 52;
const MARGIN_L = 20;
const MARGIN_R = 40;

// Matches the pipeline-stage pill nodes buildFlowMap adds (stage-0, stage-1,
// …, stage-gap, stage-loading) — hidden from the diagram per product request,
// without touching the flowMapModel.ts logic that computes them.
const PIPELINE_STAGE_NODE_ID = /^stage-(\d+|gap|loading)$/;

// Matches the per-stage automation companion nodes (leads-automation,
// campaigns-automation, contacts-automation, deals-automation) — hidden from
// this diagram per product request, same non-invasive approach as
// PIPELINE_STAGE_NODE_ID above (flowMapModel.ts still computes them).
const AUTOMATION_NODE_ID = /-automation$/;

function nodeX(node: FlowNode, colW: number): number { return MARGIN_L + node.col * colW; }
function nodeY(node: FlowNode): number {
  const laneIdx = FLOW_LANES.findIndex(l => l.id === node.lane);
  return laneIdx * LANE_BLOCK_H + LANE_LABEL_H;
}
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function statusLabel(status: FlowNode["status"]): string {
  switch (status) {
    case "live": return "Live and working";
    case "configured-untested": return "Configured, not yet tested";
    case "configured-issues": return "Configured with issues";
    case "gap": return "Gap — no automation";
    case "empty": return "Not configured";
    default: return "Loading…";
  }
}

function edgeKindLabel(kind: FlowEdge["kind"]): string {
  switch (kind) {
    case "automated": return "Automated";
    case "manual": return "Manual";
    case "broken": return "Broken";
    default: return "Checking…";
  }
}

function CostCard({ card }: { card: { id: string; icon: string; headline: string; body: string; severity: string } }) {
  return (
    <div className={`cost-card sev-${card.severity.toLowerCase()}`}>
      <span className="cost-card-icon">{card.icon}</span>
      <span
        className={`cost-card-severity sev-${card.severity.toLowerCase()}`}
        data-tooltip={SEVERITY_TOOLTIPS[card.severity]}
      >
        {card.severity}
      </span>
      <h4 className="cost-card-headline">{card.headline}</h4>
      <p className="cost-card-body">{card.body}</p>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BusinessView({ entityData, recordSamples, pipelineStages, ruleCoverage, fetchAll, onSelectSection }: Props) {
  const [costCardsExpanded, setCostCardsExpanded] = useState(false);
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState<string | null>(null);
  const [selectedFlowEdgeId, setSelectedFlowEdgeId] = useState<string | null>(null);
  const [flowExpanded, setFlowExpanded] = useState(false);
  const [flowMinimized, setFlowMinimized] = useState(false);
  const [flowContainerWidth, setFlowContainerWidth] = useState(0);
  const flowScrollRef = useRef<HTMLDivElement | null>(null);
  const flowScrollInitialized = useRef(false);

  const flowResolved = FLOW_MAP_ENTITIES.some(t => isEntityResolved(entityData[t]));
  const flowMap = useMemo(
    () => buildFlowMap(entityData, recordSamples, pipelineStages, ruleCoverage),
    [entityData, recordSamples, pipelineStages, ruleCoverage],
  );
  const costCards = useMemo(() => evaluateCostCards(entityData, pipelineStages), [entityData, pipelineStages]);
  const priorityResult = useMemo(() => computeTopActions(entityData), [entityData]);

  useEffect(() => {
    const el = flowScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setFlowContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [flowExpanded]);

  // Force the diagram to open fully left-aligned on first paint (and while
  // still loading) rather than trusting the browser's default scroll
  // position, which can start mid-scroll when the canvas is wider than the
  // viewport. Stop re-forcing it once real nodes have rendered so a later
  // data refresh doesn't yank the view back if the user scrolled manually.
  useEffect(() => {
    if (flowScrollInitialized.current) return;
    const el = flowScrollRef.current;
    if (!el) return;
    el.scrollLeft = 0;
    if (flowMap.nodes.length > 0) flowScrollInitialized.current = true;
  }, [flowMap]);

  // Pipeline stage pills and the per-stage Automation companion nodes are
  // still computed by buildFlowMap (backend intact — see flowMapModel.ts)
  // but hidden from this card's diagram per product request; filter them out
  // of the rendered node/edge set only.
  const visibleNodes = flowMap.nodes.filter(n => !PIPELINE_STAGE_NODE_ID.test(n.id) && !AUTOMATION_NODE_ID.test(n.id));
  const visibleEdges = flowMap.edges.filter(e =>
    !PIPELINE_STAGE_NODE_ID.test(e.from) && !PIPELINE_STAGE_NODE_ID.test(e.to)
    && !AUTOMATION_NODE_ID.test(e.from) && !AUTOMATION_NODE_ID.test(e.to)
  );

  const selectedNode = visibleNodes.find(n => n.id === selectedFlowNodeId) ?? null;

  const numCols = Math.max(0, ...visibleNodes.map(n => n.col)) + 1;
  // Stretch column spacing to fill the available card width (capped so nodes
  // don't end up absurdly far apart on very wide screens), so the diagram
  // fills the card edge-to-edge instead of sitting cramped on the left.
  const colW = flowContainerWidth > 0
    ? Math.min(MAX_COL_W, Math.max(COL_W, (flowContainerWidth - MARGIN_L - MARGIN_R) / numCols))
    : COL_W;
  const flowWidth = MARGIN_L + MARGIN_R + numCols * colW;
  const flowHeight = FLOW_LANES.length * LANE_BLOCK_H;
  // Only center the canvas when it actually fits inside the viewport. Centering
  // an overflowing flex child via `justify-content: center` clips its start
  // edge outside the reachable scroll range in most browsers — the diagram's
  // leftmost column (Leads, Contacts) would render partly off-screen with no
  // way to scroll to it. Left-align instead whenever the canvas is wider than
  // its container so scrollLeft: 0 always shows the true left edge.
  const flowFits = flowContainerWidth > 0 && flowWidth <= flowContainerWidth;

  const edgeGeoms = visibleEdges.map(edge => {
    const from = visibleNodes.find(n => n.id === edge.from);
    const to = visibleNodes.find(n => n.id === edge.to);
    if (!from || !to) return null;
    const x1 = nodeX(from, colW) + NODE_W / 2, y1 = nodeY(from) + NODE_H;
    const x2 = nodeX(to, colW) + NODE_W / 2, y2 = nodeY(to);
    return { edge, from, to, x1, y1, x2, y2, midX: (x1 + x2) / 2, midY: (y1 + y2) / 2 };
  }).filter((g): g is NonNullable<typeof g> => g !== null);

  const selectedEdgeGeom = edgeGeoms.find(g => g.edge.id === selectedFlowEdgeId) ?? null;

  return (
    <div className="business-view">

      {/* ── Header ── */}
      <div className="business-view-header">
        <div>
          <h2 className="business-view-title">CRM Dashboard</h2>
          <p className="business-view-sub">A plain-English look at how your CRM is running today.</p>
        </div>
        <button className="btn-secondary bv-refresh-btn" onClick={fetchAll}>↺ Refresh</button>
      </div>

      {/* ── 1. CRM Health Score ── */}
      <HealthScoreDashboard
        entityData={entityData}
        pipelineStageCount={pipelineStages.items.length}
        ruleCoverage={ruleCoverage}
        onSelectSection={onSelectSection}
      />

      {/* ── 2. Business Process Flow Map ── */}
      <div className={`business-view-section flow-map-card ${flowExpanded ? "expanded" : ""} ${flowMinimized ? "minimized" : ""}`}>
        <div className="flow-map-toolbar">
          <div className="flow-map-toolbar-left">
            <SectionTitle text="Lead Relationship with Contacts, Deals & Accounts" tooltip="How does a lead move through my business end to end — where does it break down, and what's automated vs. manual?" />
            <div className="flow-legend">
              <span className="flow-legend-item" data-tooltip-below="This step runs automatically — no manual work needed.">
                <span className="flow-legend-swatch flow-legend-solid" />Automated
              </span>
              <span className="flow-legend-item" data-tooltip-below="This step isn't automated — someone has to do it by hand.">
                <span className="flow-legend-swatch flow-legend-dashed" />Manual
              </span>
              <span className="flow-legend-item" data-tooltip-below="This connection is broken — the expected setup is missing or misconfigured.">
                <span className="flow-legend-cross">✕</span>Broken
              </span>
            </div>
          </div>
          <div className="flow-map-toolbar-actions">
            <button className="flow-map-expand-btn" title={flowMinimized ? "Restore" : "Minimize"} onClick={() => setFlowMinimized(v => !v)}>
              {flowMinimized ? "▸" : "▾"}
            </button>
            {!flowMinimized && (
              <button className="flow-map-expand-btn" title={flowExpanded ? "Collapse" : "Expand"} onClick={() => setFlowExpanded(v => !v)}>
                {flowExpanded ? "⤡" : "⤢"}
              </button>
            )}
          </div>
        </div>
        {!flowMinimized && (
        <>
        <div className="flow-map-body">
        <div className="flow-map-scroll" ref={flowScrollRef} style={{ justifyContent: flowFits ? "center" : "flex-start" }}>
          <div className="flow-map-canvas" style={{ width: flowWidth, height: flowHeight }}>
            {FLOW_LANES.map((lane, i) => (
              <div key={lane.id} className="flow-lane-label" style={{ top: i * LANE_BLOCK_H }}>{lane.label}</div>
            ))}
            <svg className="flow-map-edges" width={flowWidth} height={flowHeight}>
              <defs>
                <marker id="flow-arrow-automated" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--bv-healthy)" }} />
                </marker>
                <marker id="flow-arrow-manual" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--color-text-tertiary)" }} />
                </marker>
                <marker id="flow-arrow-broken" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--bv-critical)" }} />
                </marker>
                <marker id="flow-arrow-loading" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--color-border-strong)" }} />
                </marker>
              </defs>
              {edgeGeoms.map(({ edge, x1, y1, x2, y2, midX, midY }) => (
                <g key={edge.id} className={`flow-edge-${edge.kind} ${selectedFlowEdgeId === edge.id ? "selected" : ""}`}>
                  {edge.detail && <title>{edge.detail}</title>}
                  <path d={edgePath(x1, y1, x2, y2)} markerEnd={`url(#flow-arrow-${edge.kind})`} />
                  {edge.kind === "broken" && (
                    <text x={midX} y={midY} textAnchor="middle" className="flow-edge-break-mark">✕</text>
                  )}
                </g>
              ))}
            </svg>
            {edgeGeoms.map(({ edge, midX, midY }) => (
              <button
                key={`${edge.id}-hit`}
                type="button"
                className={`flow-edge-hit ${selectedFlowEdgeId === edge.id ? "selected" : ""}`}
                style={{ left: midX, top: midY }}
                onClick={() => { setSelectedFlowEdgeId(edge.id === selectedFlowEdgeId ? null : edge.id); setSelectedFlowNodeId(null); }}
                data-tooltip={edge.detail}
                aria-label={`${edge.kind} relationship — view details`}
              />
            ))}
            {visibleNodes.map(node => (
              <button
                key={node.id}
                className={`flow-node status-${node.status} ${selectedFlowNodeId === node.id ? "selected" : ""}`}
                style={{ left: nodeX(node, colW), top: nodeY(node), width: NODE_W, height: NODE_H }}
                onClick={() => { setSelectedFlowNodeId(node.id === selectedFlowNodeId ? null : node.id); setSelectedFlowEdgeId(null); }}
                data-tooltip={node.detail}
              >
                {node.status === "loading" ? <span className="flow-node-skeleton" /> : node.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flow-map-side-panel">
          {selectedNode && (
            <div className="flow-node-detail">
              <div className="flow-node-detail-header">
                <strong>{selectedNode.label}</strong>
                <span className={`flow-node-detail-status status-${selectedNode.status}`}>{statusLabel(selectedNode.status)}</span>
              </div>
              <p>{selectedNode.detail}</p>
              {selectedNode.evidence && selectedNode.evidence.length > 0 && (
                <ul className="flow-node-evidence">
                  {selectedNode.evidence.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
              {selectedNode.targetSection && (
                <button className="btn-secondary" onClick={() => onSelectSection(selectedNode.targetSection as Section)}>
                  View in Audit
                </button>
              )}
            </div>
          )}
          {selectedEdgeGeom && (
            <div className="flow-node-detail">
              <div className="flow-node-detail-header">
                <strong>{selectedEdgeGeom.from.label} → {selectedEdgeGeom.to.label}</strong>
                <span className={`flow-node-detail-status status-${selectedEdgeGeom.edge.kind === "broken" ? "gap" : selectedEdgeGeom.edge.kind === "automated" ? "live" : "empty"}`}>
                  {edgeKindLabel(selectedEdgeGeom.edge.kind)}
                </span>
              </div>
              <p>{selectedEdgeGeom.edge.detail ?? "No further detail available for this relationship yet."}</p>
            </div>
          )}
          {!selectedNode && !selectedEdgeGeom && (
            <div className="flow-map-side-placeholder">
              <p className="business-view-hint">Click a step or a connection line to see its details here.</p>
            </div>
          )}
        </div>
        </div>
        {!flowResolved && <p className="business-view-hint">Loading your business process data…</p>}

        </>
        )}
      </div>

      {/* ── 3. What Is Costing You ── */}
      <div className="business-view-section">
        <SectionTitle text="What Is Costing You" tooltip="What am I losing money on right now? A diagnosis of the gaps in your setup, in plain business terms." />
        <div className="cost-cards-grid">
          {costCards.shown.map(card => <CostCard key={card.id} card={card} />)}
          {costCards.loadingIds.map(id => (
            <div key={id} className="cost-card-skeleton" />
          ))}
        </div>
        {costCards.loadingIds.length === 0 && costCards.shown.length === 0 && (
          <p className="business-view-hint">No urgent cost issues detected right now — nice work.</p>
        )}
        {costCards.overflowCount > 0 && !costCardsExpanded && (
          <button className="cost-cards-more" onClick={() => setCostCardsExpanded(true)}>
            + {costCards.overflowCount} more issue{costCards.overflowCount !== 1 ? "s" : ""} found
          </button>
        )}
        {costCardsExpanded && costCards.allTriggered.slice(5).map(card => <CostCard key={card.id} card={card} />)}
      </div>

      {/* ── 4. Top 5 Priority Actions ── */}
      <div className="business-view-section">
        <SectionTitle text="Top Priority Actions" tooltip="What do I fix first, and why does it matter? Ranked by business impact against how much effort each fix takes." />
        {!priorityResult.allResolved ? (
          <div className="priority-actions-skeleton">
            <span className="spinner" /> Working out what to fix first…
          </div>
        ) : priorityResult.actions.length === 0 ? (
          <p className="business-view-hint">Nothing urgent right now — your CRM setup looks solid.</p>
        ) : (
          <div className="priority-actions-list">
            {priorityResult.actions.map(action => (
              <div
                key={action.id}
                className="priority-action-card"
              >
                <span className="priority-action-rank">{action.rank}</span>
                <div className="priority-action-body">
                  <h4 className="priority-action-title">{action.title}</h4>
                  <p className="priority-action-why">{action.why}</p>
                  <div className="priority-action-badges">
                    <span className={`impact-badge ${action.impact.toLowerCase()}`} data-tooltip={IMPACT_TOOLTIPS[action.impact]}>
                      Impact: {action.impact}
                    </span>
                    <span className={`effort-badge ${action.effort.toLowerCase()}`} data-tooltip={EFFORT_TOOLTIPS[action.effort]}>
                      Effort: {action.effort}
                    </span>
                  </div>
                </div>
                <button className="btn-secondary priority-action-btn" onClick={() => onSelectSection(action.targetSection)}>
                  View Details
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
