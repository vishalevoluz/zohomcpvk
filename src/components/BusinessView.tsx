"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import type { RuleCoverage } from "@/lib/businessScore";
import { buildFlowMap, FLOW_MAP_ENTITIES, type FlowNode, type FlowEdge, type FlowLane, type RecordSampleStageId, type RecordSampleState, type PipelineStagesState } from "@/lib/flowMapModel";
import { evaluateCostCards, type CostCardResult } from "@/lib/costCards";
import { computeTopActions } from "@/lib/priorityActions";
import type { ModuleRecordCountsState } from "@/lib/useModuleRecordCounts";
import HealthScoreDashboard from "@/components/HealthScoreDashboard";

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  recordSamples: Record<RecordSampleStageId, RecordSampleState>;
  pipelineStages: PipelineStagesState;
  ruleCoverage: RuleCoverage | null;
  moduleRecordCounts: ModuleRecordCountsState;
  currencySymbol: string | null;
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

// All four spec lanes render now — Automation used to be hidden here (per an
// earlier ad hoc product request) but the current brief asks for the diagram
// to match the spec exactly, which explicitly calls for this as its own lane.
const FLOW_LANES: { id: FlowLane; label: string }[] = [
  { id: "entry", label: "Entry" },
  { id: "qualification", label: "Qualification" },
  { id: "automation", label: "Automation" },
  { id: "outcome", label: "Outcome" },
];
const LANE_LABEL_H = 26;
const LANE_ROW_H = 76;
const LANE_GAP = 44;
const LANE_BLOCK_H = LANE_LABEL_H + LANE_ROW_H + LANE_GAP;
const COL_W = 168;
const MAX_COL_W = 260;
const NODE_W = 148;
const NODE_H = 56;
const MARGIN_L = 20;
const MARGIN_R = 40;

function nodeX(node: FlowNode, colW: number): number { return MARGIN_L + node.col * colW; }
function laneIndex(node: FlowNode): number { return FLOW_LANES.findIndex(l => l.id === node.lane); }
function nodeY(node: FlowNode): number {
  return laneIndex(node) * LANE_BLOCK_H + LANE_LABEL_H;
}

// Spreads N siblings sharing one node edge (e.g. 3 edges all leaving the
// same node's bottom) across a band of that node's width instead of every
// one departing/arriving dead-center — otherwise any two edges that share an
// endpoint would draw perfectly coincident, indistinguishable segments near
// that node.
function fanOffset(index: number, count: number): number {
  if (count <= 1) return 0;
  const usable = NODE_W * 0.6;
  return -usable / 2 + (usable / (count - 1)) * index;
}

// Builds the SVG path (and its midpoint, for the clickable hit-dot) for one
// edge, as straight right-angle ("L"/elbow) segments rather than a smooth
// curve — routed differently depending on how `from` and `to` relate
// spatially, since a single drop-turn-drop elbow only makes sense for two
// adjacent lane rows. Getting this wrong draws the line straight through
// whatever unrelated node happens to occupy the same column in a lane the
// edge is skipping over (or, for same-row neighbors like the pipeline-stage
// chain, produces a nonsensical loop instead of a straight hop).
//
// `departureIdx`/`departureCount` and `arrivalIdx`/`arrivalCount` describe
// this edge's position among its siblings sharing the same source/target
// node (see fanOffset) — kept separate from lane/column geometry so two
// edges leaving or arriving at the same box never overlap. `laneOrder`/
// `laneOrderCount` do the same for the horizontal leg of same-lane-pair
// edges that don't share an endpoint, staggering its height slightly so
// distinct edges crossing the same gap don't run along the same line.
function edgeGeometry(
  from: FlowNode,
  to: FlowNode,
  colW: number,
  departureIdx: number,
  departureCount: number,
  arrivalIdx: number,
  arrivalCount: number,
  laneOrder: number,
  laneOrderCount: number,
): { path: string; midX: number; midY: number } {
  const fromLane = laneIndex(from);
  const toLane = laneIndex(to);

  if (fromLane === toLane) {
    // Same lane, different column — a horizontal hop (e.g. the pipeline-stage
    // pill chain). Connect right edge of `from` to left edge of `to` instead
    // of the vertical elbow formula, which would draw a backwards loop.
    const y = nodeY(from) + NODE_H / 2;
    const x1 = nodeX(from, colW) + NODE_W;
    const x2 = nodeX(to, colW);
    return { path: `M ${x1} ${y} L ${x2} ${y}`, midX: (x1 + x2) / 2, midY: y };
  }

  const x1 = nodeX(from, colW) + NODE_W / 2 + fanOffset(departureIdx, departureCount);
  const y1 = nodeY(from) + NODE_H;
  const x2 = nodeX(to, colW) + NODE_W / 2 + fanOffset(arrivalIdx, arrivalCount);
  const y2 = nodeY(to);
  const baseMidY = (y1 + y2) / 2;
  // Stagger the elbow's bend height a little per edge sharing this exact
  // lane-to-lane gap, so edges that don't share an endpoint (and so get no
  // fan-out offset) still don't run along literally the same horizontal line.
  const stagger = laneOrderCount > 1 ? (laneOrder - (laneOrderCount - 1) / 2) * 12 : 0;
  const midY = baseMidY + stagger;

  if (toLane - fromLane > 1) {
    // Skips at least one lane row (e.g. an Entry-lane stage's automation
    // companion, two rows down in the Automation lane) — jog sideways
    // through an offset column that neither endpoint's own column uses, so
    // the straight run down through the skipped row can't pass through
    // whatever node sits there. Direction alternates by column so adjacent
    // skip-edges fan out instead of stacking on top of each other.
    const dir = from.col % 2 === 0 ? 1 : -1;
    const bowX = x1 + colW * 0.85 * dir;
    const step = 22;
    return {
      path: `M ${x1} ${y1} L ${x1} ${y1 + step} L ${bowX} ${y1 + step} L ${bowX} ${y2 - step} L ${x2} ${y2 - step} L ${x2} ${y2}`,
      midX: bowX,
      midY: baseMidY,
    };
  }

  // Adjacent lane rows — a right-angle elbow: drop, turn once, drop into the
  // target. Degenerates to a straight vertical line when the two nodes
  // already share a column and have no siblings to fan out from.
  return { path: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`, midX: (x1 + x2) / 2, midY };
}

// Short badge text next to the header in the side panel — the full sentence
// lives in node.explanation.statusSentence / edge.explanation.statusSentence,
// rendered separately in the panel body.
function statusBadge(status: FlowNode["status"]): string {
  switch (status) {
    case "live": return "Live and working";
    case "configured-untested": return "Set up, not yet confirmed";
    case "configured-issues": return "Needs attention";
    case "gap": return "Gap";
    case "empty": return "Empty";
    default: return "Loading…";
  }
}

function edgeBadge(kind: FlowEdge["kind"]): string {
  switch (kind) {
    case "automated": return "Automated";
    case "manual": return "Manual";
    case "broken": return "Broken";
    case "unknown": return "Unknown";
    default: return "Checking…";
  }
}

// Collapsed by default — the Zoho API names/IDs are for consultants, not the
// business owner this panel is written for. Keyed by the caller on the
// selected node/edge id so it resets to collapsed on every new selection
// instead of carrying a stale open/closed state across clicks.
function TechnicalDetail({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div className="flow-tech-detail">
      <button type="button" className="flow-tech-detail-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        Technical detail {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul className="flow-tech-detail-list">
          {lines.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

const FLOWMAP_INTRO_STORAGE_KEY = "evoaudit-flowmap-intro-seen";

// First-run guidance for someone who's never seen this map before — dismissed
// once, remembered via localStorage so it doesn't nag on every visit.
function FlowMapIntro({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flow-map-intro" role="note">
      <p className="flow-map-intro-title">How to read this map</p>
      <ul>
        <li>It shows how a lead moves through your CRM, from first contact to a closed sale.</li>
        <li>Box color shows how healthy each stage is; line style shows how records hand off between stages — see the legend above.</li>
        <li>Click any box or line to see exactly how we worked it out.</li>
      </ul>
      <button type="button" className="flow-map-intro-dismiss" onClick={onDismiss}>Got it</button>
    </div>
  );
}

function CostCard({ card, hasMatchingAction, onFixThis }: { card: CostCardResult; hasMatchingAction: boolean; onFixThis: (id: string) => void }) {
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
      {card.stakeLabel && <p className="cost-card-stake">{card.stakeLabel}</p>}
      <p className="cost-card-honesty">{card.honesty}{card.sampleSize !== undefined ? ` (sample of ${card.sampleSize})` : ""}</p>
      {hasMatchingAction && (
        <button type="button" className="cost-card-fix-link" onClick={() => onFixThis(card.id)}>
          Fix this ↓
        </button>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BusinessView({ entityData, recordSamples, pipelineStages, ruleCoverage, moduleRecordCounts, currencySymbol, fetchAll, onSelectSection }: Props) {
  const [costCardsExpanded, setCostCardsExpanded] = useState(false);
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState<string | null>(null);
  const [selectedFlowEdgeId, setSelectedFlowEdgeId] = useState<string | null>(null);
  const [flowExpanded, setFlowExpanded] = useState(false);
  const [flowMinimized, setFlowMinimized] = useState(false);
  const [flowContainerWidth, setFlowContainerWidth] = useState(0);
  const [flowIntroDismissed, setFlowIntroDismissed] = useState(true);
  const [highlightedActionId, setHighlightedActionId] = useState<string | null>(null);
  const flowScrollRef = useRef<HTMLDivElement | null>(null);
  const flowScrollInitialized = useRef(false);
  const actionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // "Fix this ↓" on a cost card scrolls to (and briefly highlights) the
  // matching priority action sharing the same finding id — both panels
  // derive from the same businessFindings.ts list, so the id always agrees.
  function scrollToAction(id: string) {
    const el = actionRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedActionId(id);
    setTimeout(() => setHighlightedActionId(prev => (prev === id ? null : prev)), 2000);
  }

  // Starts dismissed (avoids a flash of the overlay before we can check) and
  // only reveals itself once we confirm this browser hasn't seen it before.
  useEffect(() => {
    try {
      if (!localStorage.getItem(FLOWMAP_INTRO_STORAGE_KEY)) setFlowIntroDismissed(false);
    } catch { /* localStorage unavailable — just skip the intro */ }
  }, []);
  const dismissFlowIntro = () => {
    setFlowIntroDismissed(true);
    try { localStorage.setItem(FLOWMAP_INTRO_STORAGE_KEY, "1"); } catch { /* ignore */ }
  };

  const flowResolved = FLOW_MAP_ENTITIES.some(t => isEntityResolved(entityData[t]));
  const flowMap = useMemo(
    () => buildFlowMap(entityData, recordSamples, pipelineStages, ruleCoverage),
    [entityData, recordSamples, pipelineStages, ruleCoverage],
  );
  const costCards = useMemo(
    () => evaluateCostCards(entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, currencySymbol),
    [entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, currencySymbol],
  );
  const priorityResult = useMemo(
    () => computeTopActions(entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts),
    [entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts],
  );
  const visibleActionIds = new Set(priorityResult.actions.map(a => a.id));

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

  // Blueprint sub-node and the pipeline-stage pill chain are hidden from this
  // diagram per product request — flowMapModel.ts still computes them (their
  // data/logic is untouched), this is a render-time filter only.
  const HIDDEN_NODE_ID = /^(deals-blueprint|stage-(\d+|gap|loading))$/;
  const visibleNodes = flowMap.nodes.filter(n => !HIDDEN_NODE_ID.test(n.id));
  const visibleEdges = flowMap.edges.filter(e => !HIDDEN_NODE_ID.test(e.from) && !HIDDEN_NODE_ID.test(e.to));

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

  // Group edges by shared source, shared target, and shared lane-pair (for
  // edges with neither in common) so edgeGeometry can spread siblings apart
  // instead of drawing them coincident — see fanOffset/laneOrder above.
  const bySource = new Map<string, string[]>();
  const byTarget = new Map<string, string[]>();
  const byLanePair = new Map<string, string[]>();
  for (const edge of visibleEdges) {
    const from = visibleNodes.find(n => n.id === edge.from);
    const to = visibleNodes.find(n => n.id === edge.to);
    if (!from || !to || laneIndex(from) === laneIndex(to)) continue;
    (bySource.get(edge.from) ?? bySource.set(edge.from, []).get(edge.from)!).push(edge.id);
    (byTarget.get(edge.to) ?? byTarget.set(edge.to, []).get(edge.to)!).push(edge.id);
    const key = `${laneIndex(from)}-${laneIndex(to)}`;
    (byLanePair.get(key) ?? byLanePair.set(key, []).get(key)!).push(edge.id);
  }

  const edgeGeoms = visibleEdges.map(edge => {
    const from = visibleNodes.find(n => n.id === edge.from);
    const to = visibleNodes.find(n => n.id === edge.to);
    if (!from || !to) return null;
    const sourceSiblings = bySource.get(edge.from) ?? [edge.id];
    const targetSiblings = byTarget.get(edge.to) ?? [edge.id];
    const laneSiblings = byLanePair.get(`${laneIndex(from)}-${laneIndex(to)}`) ?? [edge.id];
    const { path, midX, midY } = edgeGeometry(
      from, to, colW,
      sourceSiblings.indexOf(edge.id), sourceSiblings.length,
      targetSiblings.indexOf(edge.id), targetSiblings.length,
      laneSiblings.indexOf(edge.id), laneSiblings.length,
    );
    return { edge, from, to, path, midX, midY };
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
          </div>
          <div className="flow-map-toolbar-actions">
            <button className="flow-map-expand-btn" title={flowMinimized ? "Restore" : "Minimize"} aria-label={flowMinimized ? "Restore flow map" : "Minimize flow map"} onClick={() => setFlowMinimized(v => !v)}>
              {flowMinimized ? "▸" : "▾"}
            </button>
            {!flowMinimized && (
              <button className="flow-map-expand-btn" title={flowExpanded ? "Collapse" : "Expand to full screen"} aria-label={flowExpanded ? "Collapse flow map" : "Expand flow map to full screen"} onClick={() => setFlowExpanded(v => !v)}>
                {flowExpanded ? "⤡" : "⤢"}
              </button>
            )}
          </div>
        </div>
        {!flowMinimized && (
        <>
        <p className="flow-map-caption">
          This map shows how a lead travels through your CRM — from first contact to a closed sale — and where the journey is automatic, manual, or broken.
        </p>
        <div className="flow-legend-row">
          <div className="flow-legend" aria-label="Connection line legend">
            <span className="flow-legend-heading">Connection:</span>
            <span className="flow-legend-item" data-tooltip-below="This step runs automatically — a workflow handles it.">
              <span className="flow-legend-swatch flow-legend-solid" />Automated
            </span>
            <span className="flow-legend-item" data-tooltip-below="This step isn't automated — someone has to do it by hand.">
              <span className="flow-legend-swatch flow-legend-dashed" />Manual
            </span>
            <span className="flow-legend-item" data-tooltip-below="No connection exists at all — records don't move between these steps.">
              <span className="flow-legend-cross">✕</span>Broken
            </span>
            <span className="flow-legend-item" data-tooltip-below="We couldn't check this connection — not confirmed working or broken.">
              <span className="flow-legend-swatch flow-legend-dotted" />Unknown
            </span>
          </div>
          <div className="flow-legend flow-legend-nodes" aria-label="Stage health legend">
            <span className="flow-legend-heading">Stage health:</span>
            <span className="flow-legend-item" data-tooltip-below="Records flow through and automation confirms it's working."><span className="flow-legend-dot status-live" />Live &amp; working</span>
            <span className="flow-legend-item" data-tooltip-below="Set up, but we can't yet confirm it's actually being used."><span className="flow-legend-dot status-configured-untested" />Set up, untested</span>
            <span className="flow-legend-item" data-tooltip-below="Working, but some automation is inactive or broken."><span className="flow-legend-dot status-configured-issues" />Issues</span>
            <span className="flow-legend-item" data-tooltip-below="The module exists but has zero automation."><span className="flow-legend-dot status-gap" />Gap</span>
            <span className="flow-legend-item" data-tooltip-below="No records and no automation — nothing is happening here."><span className="flow-legend-dot status-empty" />Empty</span>
          </div>
        </div>
        {!flowIntroDismissed && <FlowMapIntro onDismiss={dismissFlowIntro} />}
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
                <marker id="flow-arrow-unknown" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--color-text-tertiary)" }} />
                </marker>
                <marker id="flow-arrow-loading" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--color-border-strong)" }} />
                </marker>
              </defs>
              {edgeGeoms.map(({ edge, path, midX, midY }) => (
                <g key={edge.id} className={`flow-edge-${edge.kind} ${selectedFlowEdgeId === edge.id ? "selected" : ""}`}>
                  <title>{edge.explanation.statusSentence}</title>
                  <path d={path} markerEnd={`url(#flow-arrow-${edge.kind})`} />
                  {edge.kind === "broken" && (
                    <text x={midX} y={midY} textAnchor="middle" className="flow-edge-break-mark">✕</text>
                  )}
                  {edge.kind === "unknown" && (
                    <text x={midX} y={midY} textAnchor="middle" className="flow-edge-unknown-mark">?</text>
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
                data-tooltip={edge.explanation.statusSentence}
                aria-label={`${edgeBadge(edge.kind)} relationship — view details`}
              />
            ))}
            {visibleNodes.map(node => (
              <button
                key={node.id}
                className={`flow-node status-${node.status} ${selectedFlowNodeId === node.id ? "selected" : ""}`}
                style={{ left: nodeX(node, colW), top: nodeY(node), width: NODE_W, height: NODE_H }}
                onClick={() => { setSelectedFlowNodeId(node.id === selectedFlowNodeId ? null : node.id); setSelectedFlowEdgeId(null); }}
                data-tooltip={node.explanation.statusSentence}
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
                <span className={`flow-node-detail-status status-${selectedNode.status}`}>{statusBadge(selectedNode.status)}</span>
              </div>
              {selectedNode.explanation.whatIsThis && <p className="flow-node-detail-what">{selectedNode.explanation.whatIsThis}</p>}
              <p className="flow-node-detail-status-sentence">{selectedNode.explanation.statusSentence}</p>
              {selectedNode.explanation.howWeKnow.length > 0 && (
                <>
                  <span className="flow-node-detail-label">How we know</span>
                  <ul className="flow-node-evidence">
                    {selectedNode.explanation.howWeKnow.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                </>
              )}
              {selectedNode.explanation.honesty && <p className="flow-node-detail-honesty">{selectedNode.explanation.honesty}</p>}
              <TechnicalDetail key={selectedNode.id} lines={selectedNode.explanation.technical} />
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
                <span className={`flow-node-detail-status status-${selectedEdgeGeom.edge.kind === "broken" ? "gap" : selectedEdgeGeom.edge.kind === "automated" ? "live" : selectedEdgeGeom.edge.kind === "unknown" ? "configured-untested" : "empty"}`}>
                  {edgeBadge(selectedEdgeGeom.edge.kind)}
                </span>
              </div>
              <p className="flow-node-detail-what">{selectedEdgeGeom.edge.explanation.whatIsThis}</p>
              <p className="flow-node-detail-status-sentence">{selectedEdgeGeom.edge.explanation.statusSentence}</p>
              {selectedEdgeGeom.edge.explanation.howWeKnow.length > 0 && (
                <>
                  <span className="flow-node-detail-label">How we know</span>
                  <ul className="flow-node-evidence">
                    {selectedEdgeGeom.edge.explanation.howWeKnow.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                </>
              )}
              {selectedEdgeGeom.edge.explanation.consequence && (
                <p className="flow-node-detail-consequence">{selectedEdgeGeom.edge.explanation.consequence}</p>
              )}
              {selectedEdgeGeom.edge.explanation.honesty && <p className="flow-node-detail-honesty">{selectedEdgeGeom.edge.explanation.honesty}</p>}
              <TechnicalDetail key={selectedEdgeGeom.edge.id} lines={selectedEdgeGeom.edge.explanation.technical} />
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
          {costCards.shown.map(card => (
            <CostCard key={card.id} card={card} hasMatchingAction={visibleActionIds.has(card.id)} onFixThis={scrollToAction} />
          ))}
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
        {costCardsExpanded && costCards.allTriggered.slice(5).map(card => (
          <CostCard key={card.id} card={card} hasMatchingAction={visibleActionIds.has(card.id)} onFixThis={scrollToAction} />
        ))}
      </div>

      {/* ── 4. Top Priority Actions ── */}
      <div className="business-view-section">
        <SectionTitle text="Top Priority Actions" tooltip="What do I fix first, and why does it matter? Ranked by business impact first, then by how easy each fix is." />
        {!priorityResult.allResolved ? (
          <div className="priority-actions-skeleton">
            <span className="spinner" /> Working out what to fix first…
          </div>
        ) : priorityResult.actions.length === 0 ? (
          <p className="business-view-hint">Nothing urgent right now — your CRM setup looks solid.</p>
        ) : (
          <>
            {priorityResult.allLowImpact && (
              <p className="business-view-hint priority-actions-low-impact-note">
                No urgent issues found — here are some optimizations worth a look when you have time.
              </p>
            )}
            <div className="priority-actions-list">
              {priorityResult.actions.map(action => (
                <div
                  key={action.id}
                  ref={el => { if (el) actionRefs.current.set(action.id, el); else actionRefs.current.delete(action.id); }}
                  className={`priority-action-card ${highlightedActionId === action.id ? "highlighted" : ""}`}
                >
                  <span className="priority-action-rank">{action.rank}</span>
                  <div className="priority-action-body">
                    <div className="priority-action-title-row">
                      <h4 className="priority-action-title">{action.title}</h4>
                      {action.quickWin && <span className="quick-win-badge" data-tooltip="High impact, easy to do — the best return for the least effort.">Quick Win</span>}
                    </div>
                    <p className="priority-action-why">{action.why}</p>
                    {action.offenders.length > 0 && (
                      <p className="priority-action-offenders">{action.offenders.join(", ")}</p>
                    )}
                    <div className="priority-action-badges">
                      <span className={`impact-badge ${action.impact.toLowerCase()}`} data-tooltip={IMPACT_TOOLTIPS[action.impact]}>
                        Impact: {action.impact}
                      </span>
                      <span className={`effort-badge ${action.effort.toLowerCase()}`} data-tooltip={EFFORT_TOOLTIPS[action.effort]}>
                        Effort: {action.effort}
                      </span>
                      <span className="owner-badge">Owner: {action.owner}</span>
                      <span className="time-badge">{action.timeToValue}</span>
                    </div>
                    {action.projectedGain !== null && action.projectedGain > 0 && (
                      <p className="priority-action-projected">
                        Fixing this moves your CRM Health Score from {priorityResult.currentScore} to ~{Math.min(100, priorityResult.currentScore + action.projectedGain)}.
                      </p>
                    )}
                    <p className="priority-action-honesty">{action.honesty}</p>
                  </div>
                  <button className="btn-secondary priority-action-btn" onClick={() => onSelectSection(action.targetSection)}>
                    View Details
                  </button>
                </div>
              ))}
            </div>
            {priorityResult.overflowCount > 0 && !actionsExpanded && (
              <button className="cost-cards-more" onClick={() => setActionsExpanded(true)}>
                + {priorityResult.overflowCount} more action{priorityResult.overflowCount !== 1 ? "s" : ""}
              </button>
            )}
            {actionsExpanded && priorityResult.allActions.slice(5).map(action => (
              <div key={action.id} className="priority-action-card">
                <span className="priority-action-rank">{action.rank}</span>
                <div className="priority-action-body">
                  <div className="priority-action-title-row">
                    <h4 className="priority-action-title">{action.title}</h4>
                    {action.quickWin && <span className="quick-win-badge">Quick Win</span>}
                  </div>
                  <p className="priority-action-why">{action.why}</p>
                  {action.offenders.length > 0 && <p className="priority-action-offenders">{action.offenders.join(", ")}</p>}
                  <div className="priority-action-badges">
                    <span className={`impact-badge ${action.impact.toLowerCase()}`} data-tooltip={IMPACT_TOOLTIPS[action.impact]}>Impact: {action.impact}</span>
                    <span className={`effort-badge ${action.effort.toLowerCase()}`} data-tooltip={EFFORT_TOOLTIPS[action.effort]}>Effort: {action.effort}</span>
                    <span className="owner-badge">Owner: {action.owner}</span>
                    <span className="time-badge">{action.timeToValue}</span>
                  </div>
                  <p className="priority-action-honesty">{action.honesty}</p>
                </div>
                <button className="btn-secondary priority-action-btn" onClick={() => onSelectSection(action.targetSection)}>
                  View Details
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
