"use client";

import React, { useMemo, useRef, useState } from "react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { RuleCoverage } from "@/lib/businessScore";
import type { RecordSampleStageId, RecordSampleState, PipelineStagesState } from "@/lib/flowMapModel";
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

export default function BusinessView({ entityData, recordSamples, pipelineStages, ruleCoverage, moduleRecordCounts, currencySymbol, fetchAll }: Props) {
  const [costCardsExpanded, setCostCardsExpanded] = useState(false);
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const [highlightedActionId, setHighlightedActionId] = useState<string | null>(null);
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

  const costCards = useMemo(
    () => evaluateCostCards(entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, currencySymbol),
    [entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, currencySymbol],
  );
  const priorityResult = useMemo(
    () => computeTopActions(entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts),
    [entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts],
  );
  const visibleActionIds = new Set(priorityResult.actions.map(a => a.id));

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
      />

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
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
