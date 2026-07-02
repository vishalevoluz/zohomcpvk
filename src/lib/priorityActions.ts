import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { hasEmailAction, isInactiveUser, isMandatoryField } from "@/lib/crmPredicates";
import type { Section } from "@/lib/sections";

export type ActionImpact = "High" | "Medium" | "Low";
export type ActionEffort = "Easy" | "Medium" | "Hard";

export interface PriorityActionRule {
  id: string;
  title: string;
  why: string;
  impact: ActionImpact;
  effort: ActionEffort;
  targetSection: Section;
  requires: CrmEntityType[];
  test: (entityData: Record<CrmEntityType, EntityState>) => boolean;
}

const IMPACT_VALUE: Record<ActionImpact, number> = { High: 3, Medium: 2, Low: 1 };
const EFFORT_VALUE: Record<ActionEffort, number> = { Easy: 1, Medium: 2, Hard: 3 };

export const PRIORITY_ACTION_LIBRARY: PriorityActionRule[] = [
  {
    id: "build-pipeline",
    title: "Build a Sales Pipeline",
    why: "Without defined stages you cannot track deals, forecast revenue, or spot where you are losing business.",
    impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: ["pipelines"],
    test: e => e.pipelines.items.length === 0,
  },
  {
    id: "activate-email-workflows",
    title: "Activate Email Follow-Up Workflows",
    why: "Unanswered leads go cold. Automated follow-up keeps prospects engaged without relying on reps to remember.",
    impact: "High", effort: "Medium", targetSection: "workflows",
    requires: ["workflows"],
    test: e => !e.workflows.items.some(hasEmailAction),
  },
  {
    id: "role-based-profiles",
    title: "Create Role-Based Access Profiles",
    why: "A sales rep should not have the same access as an admin. Separate profiles protect your data.",
    impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: ["profiles"],
    test: e => e.profiles.items.length === 1,
  },
  {
    id: "remove-inactive-licenses",
    title: "Remove Inactive User Licenses",
    why: "Every inactive user with a paid license is a direct monthly cost with zero return.",
    impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: ["users"],
    test: e => e.users.items.some(isInactiveUser),
  },
  {
    id: "consolidate-inactive-workflows",
    title: "Consolidate Inactive Workflows",
    why: "Inactive workflows create confusion and may silently fail when re-enabled. Clean them up or delete them.",
    impact: "Medium", effort: "Easy", targetSection: "workflows",
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
    id: "deploy-blueprint",
    title: "Deploy Blueprint for Key Process",
    why: "Blueprints enforce your sales process. Without them, reps skip steps and managers have no visibility.",
    impact: "High", effort: "Hard", targetSection: "blueprints",
    requires: ["blueprints"],
    test: e => e.blueprints.items.length === 0,
  },
  {
    id: "reduce-mandatory-fields",
    title: "Reduce Mandatory Field Count",
    why: "Too many required fields push reps to enter dummy data. Fewer, smarter fields improve data quality.",
    impact: "Medium", effort: "Medium", targetSection: "fields",
    requires: ["fields"],
    test: e => e.fields.items.filter(isMandatoryField).length > 20,
  },
  {
    id: "decommission-empty-modules",
    title: "Decommission Empty Modules",
    why: "Unused modules clutter the interface and confuse new team members. Remove what you do not use.",
    impact: "Low", effort: "Easy", targetSection: "modules",
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

export interface PriorityAction extends PriorityActionRule {
  rank: number;
  score: number;
}

export function computeTopActions(
  entityData: Record<CrmEntityType, EntityState>
): { actions: PriorityAction[]; allResolved: boolean } {
  const allResolved = PRIORITY_ACTION_LIBRARY.every(rule =>
    rule.requires.every(t => isEntityResolved(entityData[t]))
  );

  if (!allResolved) return { actions: [], allResolved: false };

  const candidates = PRIORITY_ACTION_LIBRARY
    .filter(rule => rule.test(entityData))
    .map(rule => ({ ...rule, score: IMPACT_VALUE[rule.impact] - EFFORT_VALUE[rule.effort] }));

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return IMPACT_VALUE[b.impact] - IMPACT_VALUE[a.impact];
  });

  const actions: PriorityAction[] = candidates.slice(0, 5).map((c, i) => ({ ...c, rank: i + 1 }));
  return { actions, allResolved: true };
}
