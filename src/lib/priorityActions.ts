import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { PipelineStagesState, RecordSampleStageId, RecordSampleState } from "@/lib/flowMapModel";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { ModuleRecordCountsState } from "@/lib/useModuleRecordCounts";
import { evaluateFindings, type Finding, type FindingImpact, type FindingEffort, type UncertainFinding } from "@/lib/businessFindings";
import { computeHealthScore, estimateScoreGain } from "@/lib/businessScore";
import type { Section } from "@/lib/sections";

export type ActionImpact = FindingImpact;
export type ActionEffort = FindingEffort;
export type ActionOwner = "You" | "Your Zoho consultant" | "Your sales manager";

export interface PriorityAction {
  id: string;
  title: string;
  why: string;
  owner: ActionOwner;
  timeToValue: string;
  impact: ActionImpact;
  effort: ActionEffort;
  quickWin: boolean;
  targetSection: Section;
  offenders: string[];
  stakeLabel?: string;
  honesty: string;
  /** Points the CRM Health Score is projected to gain if this is fixed — null when no clean simulation exists (see estimateScoreGain). */
  projectedGain: number | null;
  rank: number;
}

// Actionable-fix framing for each finding in businessFindings.ts — same
// shared `id` as costCards.ts's CARD_COPY, which is what lets a cost card's
// "Fix this ↓" link land on the exact matching action.
const ACTION_COPY: Record<string, { title: string; why: (f: Finding) => string; owner: ActionOwner; timeToValue: string }> = {
  "no-email-workflow": {
    title: "Activate Email Follow-Up Workflows",
    why: () => "Unanswered leads go cold. Automated follow-up keeps prospects engaged without relying on reps to remember.",
    owner: "Your Zoho consultant", timeToValue: "~1 hour",
  },
  "inactive-users": {
    title: "Remove Inactive User Licenses",
    why: () => "Every inactive user with a paid license is a direct monthly cost with zero return.",
    owner: "You", timeToValue: "~15 mins",
  },
  "excessive-mandatory-fields": {
    title: "Reduce Mandatory Field Count",
    why: () => "Too many required fields push reps to enter dummy data. Fewer, smarter fields improve data quality.",
    owner: "Your Zoho consultant", timeToValue: "half a day",
  },
  "no-pipeline": {
    title: "Build a Sales Pipeline",
    why: () => "Without defined stages you cannot track deals, forecast revenue, or spot where you are losing business.",
    owner: "Your Zoho consultant", timeToValue: "~30 mins",
  },
  "workflows-inactive": {
    title: "Consolidate Inactive Workflows",
    why: () => "Inactive workflows create confusion and may silently fail when re-enabled. Clean them up or delete them.",
    owner: "Your Zoho consultant", timeToValue: "~1 hour",
  },
  "no-blueprint": {
    title: "Deploy a Blueprint for Your Key Process",
    why: () => "Blueprints enforce your sales process. Without them, reps skip steps and managers have no visibility.",
    owner: "Your Zoho consultant", timeToValue: "1-2 days",
  },
  "access-risk": {
    title: "Create Role-Based Access Profiles",
    why: f => f.note === "too-many-admins"
      ? "More people than necessary can edit, export, or delete any record. Trim admin access to who genuinely needs it."
      : "A sales rep should not have the same access as an admin. Separate profiles protect your data.",
    owner: "Your Zoho consultant", timeToValue: "~30 mins",
  },
  "empty-modules": {
    title: "Hide Unused Empty Modules",
    why: () => "Unused modules clutter the interface and confuse new team members. Hide them from each profile's module settings (Setup → Users & Control → Profiles → Module Permissions) instead of deleting — reversible, and keeps any historical data intact.",
    owner: "You", timeToValue: "~20 mins",
  },
  "stale-deals": {
    title: "Follow Up on Stalled Deals",
    why: () => "Deals sitting untouched rarely close themselves. A quick check-in can revive them or properly close them out.",
    owner: "Your sales manager", timeToValue: "~30 mins",
  },
  "unforecastable-deals": {
    title: "Fill In Missing Deal Amounts & Close Dates",
    why: () => "You can't forecast revenue from deals with no amount or close date — this is quick per-deal cleanup.",
    owner: "Your sales manager", timeToValue: "~1 hour",
  },
  "stale-user-logins": {
    title: "Deactivate Unused Active Seats",
    why: () => "An active-status user who never logs in is still a paid seat with zero return.",
    owner: "You", timeToValue: "~15 mins",
  },
  "duplicate-emails": {
    title: "Merge Duplicate Records",
    why: () => "Duplicate leads and contacts split your customer history and inflate your record counts.",
    owner: "Your Zoho consultant", timeToValue: "~1 hour",
  },
  "no-lead-source": {
    title: "Require Lead Source on Capture",
    why: () => "Without a source on every lead, you can't tell which marketing channel is actually working.",
    owner: "Your Zoho consultant", timeToValue: "~30 mins",
  },
};

const IMPACT_ORDER: Record<ActionImpact, number> = { High: 0, Medium: 1, Low: 2 };
const EFFORT_ORDER: Record<ActionEffort, number> = { Easy: 0, Medium: 1, Hard: 2 };

export function computeTopActions(
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStages: PipelineStagesState,
  recordSamples: Partial<Record<RecordSampleStageId, RecordSampleState>> = {},
  ruleCoverage: RuleCoverage | null = null,
  moduleRecordCounts: ModuleRecordCountsState = { counts: {}, toolAvailable: false, resolved: false },
  pipelineStageCount: number = pipelineStages.items.length,
  outOfOrderStageCount: number = pipelineStages.items.filter(s => s.outOfOrder).length,
): { actions: PriorityAction[]; allActions: PriorityAction[]; allResolved: boolean; overflowCount: number; allLowImpact: boolean; currentScore: number; uncertain: UncertainFinding[] } {
  const currentScore = computeHealthScore(entityData, pipelineStageCount, ruleCoverage, outOfOrderStageCount).total;
  const { findings, loadingIds, uncertain } = evaluateFindings({
    entityData, recordSamples, pipelineStages, ruleCoverage, moduleRecordCounts, currencySymbol: null,
  });
  const allResolved = loadingIds.length === 0;
  if (!allResolved) return { actions: [], allActions: [], allResolved: false, overflowCount: 0, allLowImpact: false, currentScore, uncertain: [] };

  const candidates = findings.filter(f => ACTION_COPY[f.id]);

  // Impact tier first (High -> Medium -> Low), then Effort (Easy -> Medium ->
  // Hard) within a tier — a Low-impact item can never outrank a High-impact
  // one, guaranteed by construction rather than by a same-weighted score.
  candidates.sort((a, b) => {
    if (IMPACT_ORDER[a.impact] !== IMPACT_ORDER[b.impact]) return IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact];
    return EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort];
  });

  const allLowImpact = candidates.length > 0 && candidates.every(f => f.impact === "Low");
  const overflowCount = Math.max(0, candidates.length - 5);

  const allActions: PriorityAction[] = candidates.map((f, i) => {
    const copy = ACTION_COPY[f.id];
    return {
      id: f.id, title: copy.title, why: copy.why(f), owner: copy.owner, timeToValue: copy.timeToValue,
      impact: f.impact, effort: f.effort, quickWin: f.impact === "High" && f.effort === "Easy",
      targetSection: f.targetSection, offenders: f.offenders, stakeLabel: f.stakeLabel, honesty: f.honesty,
      projectedGain: estimateScoreGain(f.id, entityData, pipelineStageCount, ruleCoverage, outOfOrderStageCount),
      rank: i + 1,
    };
  });

  return { actions: allActions.slice(0, 5), allActions, allResolved: true, overflowCount, allLowImpact, currentScore, uncertain };
}
