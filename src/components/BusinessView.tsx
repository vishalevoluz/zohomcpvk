"use client";

import React, { useMemo, useState } from "react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { RuleCoverage } from "@/lib/businessScore";
import type { RecordSampleStageId, RecordSampleState, PipelineStagesState } from "@/lib/flowMapModel";
import { evaluateCostCards, type CostCardResult } from "@/lib/costCards";
import { computeTopActions, type PriorityAction } from "@/lib/priorityActions";
import type { ModuleRecordCountsState } from "@/lib/useModuleRecordCounts";
import type { MandatoryFieldsState } from "@/lib/useMandatoryFields";
import HealthScoreDashboard from "@/components/HealthScoreDashboard";

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  recordSamples: Record<RecordSampleStageId, RecordSampleState>;
  pipelineStages: PipelineStagesState;
  ruleCoverage: RuleCoverage | null;
  moduleRecordCounts: ModuleRecordCountsState;
  mandatoryFields: MandatoryFieldsState;
  currencySymbol: string | null;
  fetchAll: () => void;
}

const SEVERITY_TOOLTIPS: Record<string, string> = {
  CRITICAL: "Urgent - this is actively costing you money or exposing you to risk right now.",
  WARNING: "A real gap in your setup that should be fixed soon, before it gets worse.",
  REVIEW: "Worth a look when you have time, but not urgent.",
};

const IMPACT_TOOLTIPS: Record<string, string> = {
  High: "Fixing this meaningfully improves revenue, risk, or how efficiently your team works.",
  Medium: "Fixing this helps, but the business impact is moderate.",
  Low: "Fixing this is minor cleanup - nice to have, not a priority.",
};

const EFFORT_TOOLTIPS: Record<string, string> = {
  Easy: "A quick change your Zoho admin or consultant can make in one sitting.",
  Medium: "Takes some planning and setup time, but isn't a major project.",
  Hard: "A bigger project - expect it to take real time and testing to get right.",
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

// One card per finding - "what this is costing you" (from costCards.ts) and,
// wherever the same finding id has an actionable-fix framing (priorityActions.ts),
// "how to fix it" inline in the same card, instead of two separate lists a
// reader has to cross-reference by hand. Both framings already come from the
// exact same Finding (see businessFindings.ts's header comment), so nothing
// here can disagree between the diagnosis and the fix.
function IssueCard({
  card, action, isExpanded, onToggleExpand, currentScore,
}: {
  card: CostCardResult;
  action: PriorityAction | null;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  currentScore: number;
}) {
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
      {action && (
        <div className="issue-fix-row">
          <div className="issue-fix-title-row">
            <span className="issue-fix-label">Fix</span>
            <span className="issue-fix-title">{action.title}</span>
            {action.quickWin && <span className="quick-win-badge" data-tooltip="High impact, easy to do - the best return for the least effort.">Quick Win</span>}
          </div>
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
        </div>
      )}
      <button type="button" className="cost-card-fix-link" onClick={() => onToggleExpand(card.id)}>
        {isExpanded ? "Hide Details" : "View Details"}
      </button>
      {isExpanded && (
        <div className="priority-action-detail issue-detail">
          {card.offenders.length > 0 && (
            <div className="priority-action-detail-block">
              <span className="priority-action-detail-label">Where this shows up</span>
              <ul className="priority-action-detail-list">
                {card.offenders.map((offender, i) => <li key={i}>{offender}</li>)}
              </ul>
            </div>
          )}
          {action?.projectedGain !== null && action?.projectedGain !== undefined && action.projectedGain > 0 && (
            <p className="priority-action-projected">
              Fixing this moves your CRM Health Score from {currentScore} to ~{Math.min(100, currentScore + action.projectedGain)} points - a {action.projectedGain}-point gain.
            </p>
          )}
          <div className="priority-action-detail-block">
            <span className="priority-action-detail-label">How we know this</span>
            <p className="priority-action-honesty">{card.honesty}{card.sampleSize !== undefined ? ` (sample of ${card.sampleSize})` : ""}</p>
          </div>
          {action && (
            <p className="priority-action-detail-owner">
              Best handled by <strong>{action.owner}</strong> - usually takes about {action.timeToValue}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BusinessView({ entityData, recordSamples, pipelineStages, ruleCoverage, moduleRecordCounts, mandatoryFields, currencySymbol, fetchAll }: Props) {
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);

  // Only one card's detail is ever open at a time - clicking "View Details"
  // on another card closes whichever was previously expanded.
  function toggleIssueDetail(id: string) {
    setExpandedIssueId(prev => (prev === id ? null : id));
  }

  // Same "fetch settled, not necessarily successful" gate businessFindings.ts
  // already uses (pipelineResolved there) - the Health Score gauge must not
  // treat itself as final while this separate getLayouts -> getPipelines
  // fetch is still mid-flight, or it renders a premature score built on a
  // still-empty pipelineStageCount (see buildHealthAuditModel's
  // pipelineStagesResolved param).
  const pipelineStagesResolved = !pipelineStages.loading && (pipelineStages.lastFetched !== null || pipelineStages.error !== null);

  const costCards = useMemo(
    () => evaluateCostCards(entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, currencySymbol, mandatoryFields),
    [entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, currencySymbol, mandatoryFields],
  );
  const priorityResult = useMemo(
    () => computeTopActions(entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, undefined, undefined, mandatoryFields),
    [entityData, pipelineStages, recordSamples, ruleCoverage, moduleRecordCounts, mandatoryFields],
  );
  // Both panels evaluate the exact same Finding[] (see businessFindings.ts's
  // header comment), so every actionable id here is guaranteed to also be a
  // cost card - this map only ever enriches a card, never orphans an action.
  const actionById = new Map(priorityResult.allActions.map(a => [a.id, a]));
  const allLowSeverity = costCards.allTriggered.length > 0 && costCards.allTriggered.every(c => c.severity === "REVIEW");

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
        outOfOrderStageCount={pipelineStages.items.filter(s => s.outOfOrder).length}
        pipelineCount={pipelineStages.lastFetched !== null ? pipelineStages.pipelineCount : null}
        pipelineStagesResolved={pipelineStagesResolved}
        mandatoryFields={mandatoryFields}
      />

      {/* ── 3. What's Costing You ── */}
      <div className="business-view-section">
        <SectionTitle
          text="What's Costing You"
          tooltip="What's actually costing you money or risk right now, ranked by severity - with the fix, who owns it, and how long it takes, wherever a clear fix exists."
        />
        <div className="cost-cards-grid">
          {costCards.shown.map(card => (
            <IssueCard
              key={card.id}
              card={card}
              action={actionById.get(card.id) ?? null}
              isExpanded={expandedIssueId === card.id}
              onToggleExpand={toggleIssueDetail}
              currentScore={priorityResult.currentScore}
            />
          ))}
          {costCards.loadingIds.map(id => (
            <div key={id} className="cost-card-skeleton" />
          ))}
        </div>
        {costCards.loadingIds.length === 0 && costCards.shown.length === 0 && (
          costCards.uncertain.length > 0 ? (
            <p className="business-view-hint business-view-hint-warn">
              Couldn&apos;t verify {costCards.uncertain.length} check{costCards.uncertain.length !== 1 ? "s" : ""} - {costCards.uncertain.map(u => u.reason).join("; ")}. No issues were found in what we <em>could</em> check, but this isn&apos;t a confirmed all-clear.
            </p>
          ) : (
            <p className="business-view-hint">No urgent issues detected right now - nice work.</p>
          )
        )}
        {allLowSeverity && costCards.shown.length > 0 && (
          <p className="business-view-hint priority-actions-low-impact-note">
            No urgent issues found - here are some optimizations worth a look when you have time.
          </p>
        )}
        {costCards.overflowCount > 0 && !issuesExpanded && (
          <button className="cost-cards-more" onClick={() => setIssuesExpanded(true)}>
            + {costCards.overflowCount} more issue{costCards.overflowCount !== 1 ? "s" : ""} found
          </button>
        )}
        {issuesExpanded && costCards.allTriggered.slice(5).map(card => (
          <IssueCard
            key={card.id}
            card={card}
            action={actionById.get(card.id) ?? null}
            isExpanded={expandedIssueId === card.id}
            onToggleExpand={toggleIssueDetail}
            currentScore={priorityResult.currentScore}
          />
        ))}
      </div>
    </div>
  );
}
