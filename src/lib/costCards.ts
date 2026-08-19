import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { PipelineStagesState, RecordSampleStageId, RecordSampleState } from "@/lib/flowMapModel";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { ModuleRecordCountsState } from "@/lib/useModuleRecordCounts";
import { evaluateFindings, type Finding, type UncertainFinding } from "@/lib/businessFindings";
import type { MandatoryFieldsState } from "@/lib/useMandatoryFields";

export type CostCardSeverity = "CRITICAL" | "WARNING" | "REVIEW";

export interface CostCardResult {
  id: string;
  icon: string;
  headline: string;
  body: string;
  severity: CostCardSeverity;
  offenders: string[];
  stakeLabel?: string;
  sampleSize?: number;
  honesty: string;
}

// Business-consequence framing for each finding in businessFindings.ts — the
// diagnosis/"what this is costing you" presentation. The same finding also
// feeds priorityActions.ts's actionable-fix framing, sharing the `id` so a
// card and its matching action can never drift apart (see "Fix this ↓" in
// BusinessView.tsx, which cross-links purely on this shared id).
const CARD_COPY: Record<string, { icon: string; headline: string; body: (f: Finding) => string }> = {
  "no-email-workflow": {
    icon: "✉", headline: "Leads Are Being Followed Up Manually",
    body: () => "Your team is chasing every prospect by hand. You are losing deals to faster competitors.",
  },
  "excessive-mandatory-fields": {
    icon: "▤", headline: "Your Sales Team Is Avoiding the CRM",
    body: f => `${f.count} mandatory fields${f.offenders.length ? ` — concentrated in ${f.offenders.join(", ")}` : ""} push reps to skip records or enter junk data just to save.`,
  },
  "no-pipeline": {
    icon: "⇥", headline: "You Cannot Forecast Your Revenue",
    body: () => "Without a structured pipeline, your sales forecast is a guess. Investors and management cannot rely on it.",
  },
  "workflows-inactive": {
    icon: "⟳", headline: "Your Automation Is Partly Broken",
    body: f => `${f.note ?? f.count} workflows have silently stopped running${f.offenders.length ? `, including ${f.offenders.slice(0, 3).join(", ")}` : ""} — leads and tasks may be falling through the gaps.`,
  },
  "no-blueprint": {
    icon: "◈", headline: "Your Sales Process Is Unenforceable",
    body: () => "There is nothing preventing reps from skipping stages or closing deals without required approvals.",
  },
  "access-risk": {
    icon: "◑",
    headline: "Everyone Has Admin-Level Access",
    body: f => f.note === "too-many-admins"
      ? `${f.count} profiles${f.offenders.length ? ` (${f.offenders.join(", ")})` : ""} carry full admin access — more people than necessary can edit, export, or delete any record.`
      : "All users share identical, admin-level access. This is a data security and compliance risk.",
  },
  "empty-modules": {
    icon: "⊞", headline: "You Are Running Unused Complexity",
    body: f => `${f.count} module${f.count !== 1 ? "s" : ""}${f.offenders.length ? ` (${f.offenders.join(", ")})` : ""} sit empty with zero automation — clutter that slows your team down without adding value.`,
  },
  "stale-deals": {
    icon: "⌛", headline: "Deals Are Going Cold in Your Pipeline",
    body: f => `${f.stakeLabel ?? `${f.count} open deal${f.count !== 1 ? "s" : ""}`} haven't been touched in over 30 days${f.offenders.length ? `: ${f.offenders.slice(0, 3).join(", ")}` : ""} — likely to rot unless followed up.`,
  },
  "unforecastable-deals": {
    icon: "❔", headline: "Deals Are Missing Key Forecast Data",
    body: f => `${f.count} open deal${f.count !== 1 ? "s" : ""} ${f.count !== 1 ? "are" : "is"} missing an amount or close date${f.offenders.length ? `: ${f.offenders.slice(0, 3).join(", ")}` : ""} — you can't forecast what you can't measure.`,
  },
  "stale-user-logins": {
    icon: "⏱", headline: "Active Seats Nobody Is Using",
    body: f => `${f.stakeLabel ?? `${f.count} user${f.count !== 1 ? "s" : ""}`} marked active haven't logged in for 90+ days${f.offenders.length ? `: ${f.offenders.slice(0, 3).join(", ")}` : ""} — a paid seat with zero use.`,
  },
  "duplicate-emails": {
    icon: "⧉", headline: "Duplicate Records Are Splitting Your Data",
    body: f => `${f.count} lead/contact records share an email with another record${f.offenders.length ? `, e.g. ${f.offenders.slice(0, 3).join(", ")}` : ""} — inflating counts and splitting customer history.`,
  },
  "no-lead-source": {
    icon: "◫", headline: "You Don't Know What's Working",
    body: f => `${f.count} lead${f.count !== 1 ? "s" : ""} ${f.count !== 1 ? "have" : "has"} no source tagged — you can't tell which marketing actually brings in business.`,
  },
};

export interface CostCardsResult {
  shown: CostCardResult[];
  loadingIds: string[];
  /** Findings that couldn't be confirmed clean because a required data source failed to fetch — never fold these into "no issues found". */
  uncertain: UncertainFinding[];
  overflowCount: number;
  allTriggered: CostCardResult[];
}

const SEVERITY_ORDER: Record<CostCardSeverity, number> = { CRITICAL: 0, WARNING: 1, REVIEW: 2 };
// Covers every finding CARD_COPY currently defines, so nothing needs the
// "+N more" click by default — it only kicks in once more findings are added
// than currently exist.
const INITIAL_SHOWN_COUNT = 12;

export function evaluateCostCards(
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStages: PipelineStagesState,
  recordSamples: Partial<Record<RecordSampleStageId, RecordSampleState>> = {},
  ruleCoverage: RuleCoverage | null = null,
  moduleRecordCounts: ModuleRecordCountsState = { counts: {}, toolAvailable: false, resolved: false },
  currencySymbol: string | null = null,
  mandatoryFields: MandatoryFieldsState = { count: 0, fieldLabels: [], perModule: [], loading: false, error: null, lastFetched: null },
): CostCardsResult {
  const { findings, loadingIds, uncertain } = evaluateFindings({
    entityData, recordSamples, pipelineStages, ruleCoverage, moduleRecordCounts, currencySymbol, mandatoryFields,
  });

  const triggered: CostCardResult[] = findings
    .filter(f => CARD_COPY[f.id])
    .map(f => {
      const copy = CARD_COPY[f.id];
      return {
        id: f.id, icon: copy.icon, headline: copy.headline, body: copy.body(f), severity: f.severity,
        offenders: f.offenders, stakeLabel: f.stakeLabel, sampleSize: f.sampleSize, honesty: f.honesty,
      };
    });

  triggered.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  // This list now stands in for both the old "What Is Costing You" (5 shown)
  // and "Top Priority Actions" (a separate 5 shown) panels merged into one —
  // capping at the old single-panel number would show fewer distinct issues
  // than before the merge, so the visible count is raised to cover roughly
  // what both used to show combined.
  const shown = triggered.slice(0, INITIAL_SHOWN_COUNT);
  const overflowCount = Math.max(0, triggered.length - INITIAL_SHOWN_COUNT);

  return { shown, loadingIds, uncertain, overflowCount, allTriggered: triggered };
}
