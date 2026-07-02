"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import { computeHealthScore, HEALTH_SCORE_ENTITIES, type HealthScoreDimensions } from "@/lib/businessScore";
import { buildFlowMap, FLOW_MAP_ENTITIES, type FlowNode, type FlowLane } from "@/lib/flowMapModel";
import { evaluateCostCards } from "@/lib/costCards";
import { computeTopActions } from "@/lib/priorityActions";
import HealthGauge from "@/components/HealthGauge";

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  fetchAll: () => void;
  onSelectSection: (s: Section) => void;
}

const DIMENSION_LABELS: Record<keyof HealthScoreDimensions, string> = {
  automationCoverage: "Automation Coverage",
  processCompleteness: "Sales Process Setup",
  accessSecurity: "Team Security",
  dataArchitecture: "Data Structure",
  automationHealth: "Workflow Health",
};

const DIMENSION_TO_ACTION_IDS: Record<keyof HealthScoreDimensions, string[]> = {
  automationCoverage: ["activate-email-workflows", "consolidate-inactive-workflows"],
  processCompleteness: ["build-pipeline", "deploy-blueprint"],
  accessSecurity: ["role-based-profiles", "remove-inactive-licenses"],
  dataArchitecture: ["reduce-mandatory-fields", "decommission-empty-modules"],
  automationHealth: ["consolidate-inactive-workflows", "activate-email-workflows"],
};

const DIMENSION_TOOLTIPS: Record<keyof HealthScoreDimensions, string> = {
  automationCoverage: "How many of your modules have at least one active automation watching them. Modules with none drag this score down.",
  processCompleteness: "Whether a sales pipeline, blueprint, and defined stages actually exist. Missing pieces mean reps have no set path to follow.",
  accessSecurity: "Whether access is split into real roles instead of everyone sharing one login level, and whether inactive users still hold licenses.",
  dataArchitecture: "Whether your fields and module count are kept reasonable, not bloated with excess required fields or clutter.",
  automationHealth: "What share of your existing workflows are actually turned on right now.",
};

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

const FLOW_LANES: { id: FlowLane; label: string }[] = [
  { id: "entry", label: "Entry" },
  { id: "qualification", label: "Qualification" },
  { id: "automation", label: "Automation Layer" },
  { id: "outcome", label: "Outcome" },
];
const LANE_LABEL_H = 22;
const LANE_ROW_H = 64;
const LANE_GAP = 22;
const LANE_BLOCK_H = LANE_LABEL_H + LANE_ROW_H + LANE_GAP;
const COL_W = 168;
const NODE_W = 148;
const NODE_H = 52;
const MARGIN_L = 20;
const MARGIN_R = 40;

function nodeX(node: FlowNode): number { return MARGIN_L + node.col * COL_W; }
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

export default function BusinessView({ entityData, fetchAll, onSelectSection }: Props) {
  const [displayScore, setDisplayScore] = useState(0);
  const [costCardsExpanded, setCostCardsExpanded] = useState(false);
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState<string | null>(null);
  const [flowExpanded, setFlowExpanded] = useState(false);
  const priorityRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const healthResolved = HEALTH_SCORE_ENTITIES.every(t => isEntityResolved(entityData[t]));
  const healthScore = useMemo(() => computeHealthScore(entityData), [entityData]);
  const flowResolved = FLOW_MAP_ENTITIES.some(t => isEntityResolved(entityData[t]));
  const flowMap = useMemo(() => buildFlowMap(entityData), [entityData]);
  const costCards = useMemo(() => evaluateCostCards(entityData), [entityData]);
  const priorityResult = useMemo(() => computeTopActions(entityData), [entityData]);

  useEffect(() => {
    if (!healthResolved) { setDisplayScore(0); return; }
    const id = requestAnimationFrame(() => setDisplayScore(healthScore.total));
    return () => cancelAnimationFrame(id);
  }, [healthResolved, healthScore.total]);

  function scrollToAction(dimensionKey: keyof HealthScoreDimensions) {
    const candidateIds = DIMENSION_TO_ACTION_IDS[dimensionKey];
    const match = candidateIds.find(id => priorityRefs.current[id]);
    priorityRefs.current[match ?? ""]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const selectedNode = flowMap.nodes.find(n => n.id === selectedFlowNodeId) ?? null;

  const flowWidth = MARGIN_L + MARGIN_R + (Math.max(0, ...flowMap.nodes.map(n => n.col)) + 1) * COL_W;
  const flowHeight = FLOW_LANES.length * LANE_BLOCK_H;

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
      <div className="business-view-section health-gauge-card">
        <SectionTitle text="CRM Health Score" tooltip="Is my CRM working well or broken? A single score built from automation, process setup, security, data structure, and workflow health." />
        <HealthGauge score={displayScore} zone={healthScore.zone} resolved={healthResolved} />
        <p className={`health-gauge-verdict ${healthResolved ? `zone-${healthScore.zone}` : ""}`}>
          {healthResolved ? healthScore.verdict : "Reading your CRM setup…"}
        </p>

        <div className="health-subscores">
          {(Object.keys(DIMENSION_LABELS) as (keyof HealthScoreDimensions)[]).map(key => {
            const value = healthScore.dimensions[key];
            return (
              <button
                key={key}
                className="health-subscore-row"
                onClick={() => scrollToAction(key)}
                disabled={!healthResolved}
                data-tooltip={DIMENSION_TOOLTIPS[key]}
              >
                <span className="health-subscore-label">{DIMENSION_LABELS[key]}</span>
                <span className="health-subscore-track">
                  <span className="health-subscore-fill" style={{ width: healthResolved ? `${(value / 20) * 100}%` : "0%" }} />
                </span>
                <span className="health-subscore-value">{healthResolved ? `${value}/20` : "—"}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 2. Business Process Flow Map ── */}
      <div className={`business-view-section flow-map-card ${flowExpanded ? "expanded" : ""}`}>
        <div className="flow-map-toolbar">
          <SectionTitle text="How a Lead Moves Through Your Business" tooltip="How does a lead move through my business end to end — where does it break down, and what's automated vs. manual?" />
          <button className="flow-map-expand-btn" title={flowExpanded ? "Collapse" : "Expand"} onClick={() => setFlowExpanded(v => !v)}>
            {flowExpanded ? "⤡" : "⤢"}
          </button>
        </div>
        <div className="flow-map-scroll">
          <div className="flow-map-canvas" style={{ width: flowWidth, height: flowHeight }}>
            {FLOW_LANES.map((lane, i) => (
              <div key={lane.id} className="flow-lane-label" style={{ top: i * LANE_BLOCK_H }}>{lane.label}</div>
            ))}
            <svg className="flow-map-edges" width={flowWidth} height={flowHeight}>
              {flowMap.edges.map(edge => {
                const from = flowMap.nodes.find(n => n.id === edge.from);
                const to = flowMap.nodes.find(n => n.id === edge.to);
                if (!from || !to) return null;
                const x1 = nodeX(from) + NODE_W / 2, y1 = nodeY(from) + NODE_H;
                const x2 = nodeX(to) + NODE_W / 2, y2 = nodeY(to);
                const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
                return (
                  <g key={edge.id} className={`flow-edge-${edge.kind}`}>
                    <path d={edgePath(x1, y1, x2, y2)} />
                    {edge.kind === "broken" && (
                      <text x={midX} y={midY} textAnchor="middle" className="flow-edge-break-mark">✕</text>
                    )}
                  </g>
                );
              })}
            </svg>
            {flowMap.nodes.map(node => (
              <button
                key={node.id}
                className={`flow-node status-${node.status} ${selectedFlowNodeId === node.id ? "selected" : ""}`}
                style={{ left: nodeX(node), top: nodeY(node), width: NODE_W, height: NODE_H }}
                onClick={() => setSelectedFlowNodeId(node.id === selectedFlowNodeId ? null : node.id)}
                data-tooltip={node.detail}
              >
                {node.status === "loading" ? <span className="flow-node-skeleton" /> : node.label}
              </button>
            ))}
          </div>
        </div>
        {!flowResolved && <p className="business-view-hint">Loading your business process data…</p>}
        {selectedNode && (
          <div className="flow-node-detail">
            <div className="flow-node-detail-header">
              <strong>{selectedNode.label}</strong>
              <span className={`flow-node-detail-status status-${selectedNode.status}`}>{statusLabel(selectedNode.status)}</span>
            </div>
            <p>{selectedNode.detail}</p>
            {selectedNode.targetSection && (
              <button className="btn-secondary" onClick={() => onSelectSection(selectedNode.targetSection as Section)}>
                View in Audit
              </button>
            )}
          </div>
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
                ref={el => { priorityRefs.current[action.id] = el; }}
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
