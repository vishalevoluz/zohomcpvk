import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { hasEmailAction, isAdminProfile, isInactiveUser, isMandatoryField } from "@/lib/crmPredicates";
import type { PipelineStagesState } from "@/lib/flowMapModel";

export type CostCardSeverity = "CRITICAL" | "WARNING" | "REVIEW";

export interface CostCardRule {
  id: string;
  icon: string;
  headline: string;
  // A function lets a card surface the real numbers behind the finding (e.g.
  // "12 of 20 licensed users are active") instead of only a generic statement.
  body: string | ((entityData: Record<CrmEntityType, EntityState>, pipelineStages: PipelineStagesState) => string);
  severity: CostCardSeverity;
  requires: CrmEntityType[];
  // Zoho has no generic "list all pipelines/stages" API — a real pipeline's
  // stages live on a module's active layout (see usePipelineStages.ts, which
  // walks getLayouts -> getPipelines for Deals specifically). A rule that
  // needs that real data sets this instead of/alongside `requires`, so it
  // waits on that hook's own resolved state rather than the generic
  // `pipelines`/`stages` entities, which never resolve on this MCP server.
  requiresPipelineStages?: boolean;
  test: (entityData: Record<CrmEntityType, EntityState>, pipelineStages: PipelineStagesState) => boolean;
}

// Severity isn't specified per-condition in the source spec (only the three badge
// values and "prioritize CRITICAL first" are defined) — assigned here by business
// urgency: direct revenue/compliance risk = CRITICAL, structural gaps = WARNING,
// low-urgency cleanup = REVIEW.
export const COST_CARD_RULES: CostCardRule[] = [
  {
    id: "no-email-automation",
    icon: "✉",
    headline: "Leads Are Being Followed Up Manually",
    body: "Your team is chasing every prospect by hand. You are losing deals to faster competitors.",
    severity: "CRITICAL",
    requires: ["workflows"],
    test: e => !e.workflows.items.some(hasEmailAction),
  },
  {
    id: "unused-seats",
    icon: "◎",
    headline: "You Are Paying for Unused Seats",
    // Surfaces the actual purchased-vs-used numbers instead of a generic
    // statement, so this reads as a concrete cost finding, not a vague warning.
    body: e => {
      const total = e.users.items.length;
      const inactive = e.users.items.filter(isInactiveUser).length;
      const active = total - inactive;
      return `You have ${total} licensed user${total !== 1 ? "s" : ""}, but only ${active} ${active === 1 ? "is" : "are"} active. ${inactive} inactive license${inactive !== 1 ? "s" : ""} may still be billed monthly — free them up or reassign to someone actually using the CRM.`;
    },
    severity: "WARNING",
    requires: ["users"],
    test: e => e.users.items.some(isInactiveUser),
  },
  {
    id: "sales-team-avoiding-crm",
    icon: "▤",
    headline: "Your Sales Team Is Avoiding the CRM",
    body: "You're asking reps to fill in too much before they can save anything. So they skip it, or type in junk just to move on — and that's what's quietly wrecking your reports.",
    severity: "WARNING",
    requires: ["fields"],
    test: e => e.fields.items.filter(isMandatoryField).length > 20,
  },
  {
    id: "cannot-forecast-revenue",
    icon: "⇥",
    headline: "You Cannot Forecast Your Revenue",
    body: "Without a structured pipeline, your sales forecast is a guess. Investors and management cannot rely on it.",
    severity: "CRITICAL",
    requires: [],
    requiresPipelineStages: true,
    // Checks the Deals module's real pipeline stages (see PipelineStagesState
    // above) instead of the generic `pipelines`/`stages` entities — those
    // never resolve to anything real on Zoho, which used to fire this
    // CRITICAL even for orgs with a normal default pipeline configured.
    test: (_e, pipelineStages) => pipelineStages.items.length === 0,
  },
  {
    id: "automation-partly-broken",
    icon: "⟳",
    headline: "Your Automation Is Partly Broken",
    body: "Some of your automation has stopped running silently. Leads and tasks may be falling through the gaps.",
    severity: "WARNING",
    requires: ["workflows"],
    test: e => {
      const total = e.workflows.items.length;
      if (total === 0) return false;
      const inactive = e.workflows.items.filter(w => {
        const r = w as Record<string, unknown>;
        return r.status === "Inactive" || r.active === false || r.enabled === false;
      }).length;
      return inactive / total > 0.3;
    },
  },
  {
    id: "process-unenforceable",
    icon: "◈",
    headline: "Your Sales Process Is Unenforceable",
    body: "There is nothing preventing reps from skipping stages or closing deals without required approvals.",
    severity: "WARNING",
    requires: ["blueprints"],
    test: e => e.blueprints.items.length === 0,
  },
  {
    id: "everyone-has-admin-access",
    icon: "◑",
    headline: "Everyone Has Admin-Level Access",
    body: "All users can edit, delete, and export any record. This is a data security and compliance risk.",
    severity: "CRITICAL",
    requires: ["profiles"],
    test: e => e.profiles.items.length > 0 && (e.profiles.items.length === 1 || e.profiles.items.every(isAdminProfile)),
  },
  {
    id: "unused-complexity",
    icon: "⊞",
    headline: "You Are Running Unused Complexity",
    body: "Several parts of your CRM are set up but nobody's actually using them. That just adds clutter and slows your team down — turn them off for now rather than deleting them, so you can switch them back on later if you ever need to.",
    severity: "REVIEW",
    requires: ["modules", "workflows", "blueprints"],
    test: e => {
      const wfs = e.workflows.items;
      const bps = e.blueprints.items;
      const unused = e.modules.items.filter(m => {
        const r = m as Record<string, unknown>;
        const apiName = String(r.api_name ?? r.module_name ?? "");
        if (!apiName) return false;
        const referenced = wfs.some(w => JSON.stringify(w).toLowerCase().includes(apiName.toLowerCase()));
        const hasBlueprint = bps.some(b => JSON.stringify(b).toLowerCase().includes(apiName.toLowerCase()));
        return !referenced && !hasBlueprint;
      });
      return unused.length > 3;
    },
  },
];

export interface CostCardResult {
  id: string;
  icon: string;
  headline: string;
  body: string;
  severity: CostCardSeverity;
}

const SEVERITY_ORDER: Record<CostCardSeverity, number> = { CRITICAL: 0, WARNING: 1, REVIEW: 2 };

export function evaluateCostCards(
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStages: PipelineStagesState,
): { shown: CostCardResult[]; loadingIds: string[]; overflowCount: number; allTriggered: CostCardResult[] } {
  const loadingIds: string[] = [];
  const triggered: CostCardResult[] = [];
  const pipelineStagesResolved = !pipelineStages.loading && (pipelineStages.lastFetched !== null || pipelineStages.error !== null);

  for (const rule of COST_CARD_RULES) {
    const entitiesResolved = rule.requires.every(t => isEntityResolved(entityData[t]));
    const resolved = entitiesResolved && (!rule.requiresPipelineStages || pipelineStagesResolved);
    if (!resolved) {
      loadingIds.push(rule.id);
      continue;
    }
    if (rule.test(entityData, pipelineStages)) {
      const body = typeof rule.body === "function" ? rule.body(entityData, pipelineStages) : rule.body;
      triggered.push({ id: rule.id, icon: rule.icon, headline: rule.headline, body, severity: rule.severity });
    }
  }

  triggered.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const shown = triggered.slice(0, 5);
  const overflowCount = Math.max(0, triggered.length - 5);

  return { shown, loadingIds, overflowCount, allTriggered: triggered };
}
