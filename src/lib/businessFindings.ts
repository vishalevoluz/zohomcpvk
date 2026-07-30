import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved, getItemName } from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import type { RecordSampleStageId, RecordSampleState, PipelineStagesState } from "@/lib/flowMapModel";
import type { RuleCoverage } from "@/lib/crmPredicates";
import {
  hasEmailAction, isInactiveUser, isMandatoryField, isAdminProfile, isActiveWorkflow,
  workflowModuleLabel, moduleApiName, unreferencedModules,
  isDealStale, isDealUnforecastable, dealAmount,
  hasNoLeadSource, userLoginAgeDays, userLoginFieldPresent, userLastLoginDate,
} from "@/lib/crmPredicates";
import type { ModuleRecordCountsState } from "@/lib/useModuleRecordCounts";
import { formatMoney } from "@/lib/money";

// Single source of truth for every quantified condition the Business View can
// surface. "What Is Costing You" and "Top Priority Actions" are two different
// PRESENTATIONS of this same list (business-consequence framing vs.
// actionable-fix framing) rather than two independently maintained rule
// tables — this is what guarantees a cost card and its matching action can
// never drift apart or contradict each other.

export type FindingSeverity = "CRITICAL" | "WARNING" | "REVIEW";
export type FindingImpact = "High" | "Medium" | "Low";
export type FindingEffort = "Easy" | "Medium" | "Hard";

export interface Finding {
  id: string;
  /** Real, named offenders — module/workflow/user/deal names. Never "several". */
  offenders: string[];
  count: number;
  /** Pre-formatted quantified stake, e.g. "₹4,50,000 of pipeline value" or "12 seats". */
  stakeLabel?: string;
  /** Extra structured detail a presentation layer may branch on (e.g. which sub-case fired). */
  note?: string;
  /** Set when this finding is derived from a capped record sample, not full CRM data. */
  sampleSize?: number;
  /** Always shown — confirmed-from-config vs. sample-based vs. "couldn't check X". */
  honesty: string;
  severity: FindingSeverity;
  impact: FindingImpact;
  effort: FindingEffort;
  targetSection: Section;
}

interface FindingContext {
  entityData: Record<CrmEntityType, EntityState>;
  recordSamples: Partial<Record<RecordSampleStageId, RecordSampleState>>;
  pipelineStages: PipelineStagesState;
  ruleCoverage: RuleCoverage | null;
  moduleRecordCounts: ModuleRecordCountsState;
  currencySymbol: string | null;
}

type FindingDynamic = Omit<Finding, "id" | "severity" | "impact" | "effort" | "targetSection">;

interface FindingDef {
  id: string;
  severity: FindingSeverity;
  impact: FindingImpact;
  effort: FindingEffort;
  targetSection: Section;
  requires: CrmEntityType[];
  requiresPipelineStages?: boolean;
  requiresRecordSamples?: RecordSampleStageId[];
  requiresModuleRecordCounts?: boolean;
  // Returns null when the condition isn't triggered by this data.
  build: (ctx: FindingContext) => FindingDynamic | null;
}

function moduleLabelOf(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const r = m as Record<string, unknown>;
  return String(r.plural_label ?? r.singular_label ?? r.module_name ?? r.api_name ?? "");
}

function recordEmail(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const email = (r as Record<string, unknown>).Email ?? (r as Record<string, unknown>).email;
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

const STALE_LOGIN_THRESHOLD_DAYS = 90;

function formatShortDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function groupByEmail(records: unknown[]): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>();
  for (const r of records) {
    const email = recordEmail(r);
    if (!email) continue;
    const arr = map.get(email) ?? [];
    arr.push(r);
    map.set(email, arr);
  }
  return map;
}

const FINDING_DEFS: FindingDef[] = [
  {
    id: "no-email-workflow",
    severity: "CRITICAL", impact: "High", effort: "Medium", targetSection: "workflows",
    requires: ["workflows"],
    build: ({ entityData }) => {
      const wfs = entityData.workflows.items;
      if (wfs.some(hasEmailAction)) return null;
      return {
        offenders: [], count: wfs.length,
        honesty: wfs.length > 0
          ? `Confirmed from all ${wfs.length} workflow${wfs.length !== 1 ? "s" : ""} in your CRM — none reference email.`
          : "Confirmed — no workflows exist in this CRM at all.",
      };
    },
  },
  {
    id: "inactive-users",
    severity: "WARNING", impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: ["users"],
    build: ({ entityData }) => {
      const users = entityData.users.items;
      const inactive = users.filter(isInactiveUser);
      if (inactive.length === 0) return null;
      return {
        offenders: inactive.map((u, i) => getItemName(u, i)).filter(Boolean).slice(0, 5),
        count: inactive.length,
        stakeLabel: `${inactive.length} seat${inactive.length !== 1 ? "s" : ""}`,
        honesty: `Confirmed from all ${users.length} licensed user${users.length !== 1 ? "s" : ""} in your CRM.`,
      };
    },
  },
  {
    id: "excessive-mandatory-fields",
    severity: "WARNING", impact: "Medium", effort: "Medium", targetSection: "fields",
    requires: ["fields"],
    build: ({ entityData }) => {
      const mandatory = entityData.fields.items.filter(isMandatoryField);
      if (mandatory.length <= 20) return null;
      const byModule = new Map<string, number>();
      for (const f of mandatory) {
        const label = workflowModuleLabel(f) || "Unknown module";
        byModule.set(label, (byModule.get(label) ?? 0) + 1);
      }
      const offenders = [...byModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, n]) => `${label} (${n})`);
      return {
        offenders, count: mandatory.length,
        honesty: `Confirmed from all ${entityData.fields.items.length} fields in your CRM's configuration.`,
      };
    },
  },
  {
    id: "no-pipeline",
    severity: "CRITICAL", impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: [], requiresPipelineStages: true,
    build: ({ pipelineStages }) => {
      if (pipelineStages.items.length > 0) return null;
      return { offenders: [], count: 0, honesty: "Confirmed directly from your Deals module's layout — not a sample." };
    },
  },
  {
    id: "workflows-inactive",
    severity: "WARNING", impact: "Medium", effort: "Easy", targetSection: "workflows",
    requires: ["workflows"],
    build: ({ entityData }) => {
      const wfs = entityData.workflows.items;
      if (wfs.length === 0) return null;
      const inactive = wfs.filter(w => !isActiveWorkflow(w));
      if (inactive.length / wfs.length <= 0.3) return null;
      return {
        offenders: inactive.map((w, i) => getItemName(w, i)).filter(Boolean).slice(0, 5),
        count: inactive.length,
        note: `${inactive.length} of ${wfs.length}`,
        honesty: `Confirmed from all ${wfs.length} workflows in your CRM.`,
      };
    },
  },
  {
    id: "no-blueprint",
    severity: "WARNING", impact: "High", effort: "Hard", targetSection: "blueprints",
    requires: ["blueprints"],
    build: ({ entityData }) => {
      if (entityData.blueprints.items.length > 0) return null;
      return { offenders: [], count: 0, honesty: "Confirmed — no blueprints exist in this CRM." };
    },
  },
  {
    id: "access-risk",
    severity: "CRITICAL", impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: ["profiles"],
    build: ({ entityData }) => {
      const profiles = entityData.profiles.items;
      if (profiles.length === 0) return null;
      const adminCount = profiles.filter(isAdminProfile).length;
      const singleProfile = profiles.length === 1;
      const allAdmin = profiles.every(isAdminProfile);
      const tooManyAdmins = adminCount > 2;
      if (!singleProfile && !allAdmin && !tooManyAdmins) return null;
      const isUniform = singleProfile || allAdmin;
      const offenders = (isUniform ? profiles : profiles.filter(isAdminProfile)).map((p, i) => getItemName(p, i)).filter(Boolean);
      const evidenceCount = isUniform ? profiles.length : adminCount;
      return {
        offenders: offenders.slice(0, 5),
        count: evidenceCount,
        note: isUniform ? "uniform-access" : "too-many-admins",
        honesty: singleProfile
          ? "Only 1 profile exists in your CRM, so every user shares the same access level — we can see profile names but not their exact permissions, so confirm the actual permission set in Setup."
          : `${evidenceCount} of ${profiles.length} profile${profiles.length !== 1 ? "s" : ""} ${evidenceCount !== 1 ? "are" : "is"} named like admin roles — we can see profile names but not their exact permissions, so confirm each one's real access in Setup.`,
      };
    },
  },
  {
    id: "empty-modules",
    severity: "REVIEW", impact: "Low", effort: "Easy", targetSection: "modules",
    requires: ["modules", "workflows", "blueprints"], requiresModuleRecordCounts: true,
    build: ({ entityData, moduleRecordCounts }) => {
      const candidates = unreferencedModules(entityData.modules.items, entityData.workflows.items, entityData.blueprints.items);
      if (candidates.length === 0) return null;
      if (moduleRecordCounts.toolAvailable) {
        const confirmedZero = candidates.filter(m => moduleRecordCounts.counts[moduleApiName(m)] === 0);
        if (confirmedZero.length === 0) return null;
        return {
          offenders: confirmedZero.map(moduleLabelOf).filter(Boolean).slice(0, 5),
          count: confirmedZero.length,
          honesty: "Confirmed 0 records via a direct record-count check, for modules also unused by any workflow or blueprint.",
        };
      }
      if (candidates.length <= 3) return null;
      return {
        offenders: candidates.map(moduleLabelOf).filter(Boolean).slice(0, 5),
        count: candidates.length,
        honesty: `${candidates.length} modules aren't referenced by any workflow or blueprint — record counts couldn't be confirmed on this CRM connection, so this is based on configuration only, not confirmed emptiness.`,
      };
    },
  },
  {
    id: "stale-deals",
    severity: "CRITICAL", impact: "High", effort: "Medium", targetSection: "crm-dashboard",
    requires: [], requiresRecordSamples: ["deals"],
    build: ({ recordSamples, currencySymbol }) => {
      const items = recordSamples.deals?.items ?? [];
      const stale = items.filter(d => isDealStale(d));
      if (stale.length === 0) return null;
      const totalValue: number = stale.reduce((sum: number, d) => sum + (dealAmount(d) ?? 0), 0);
      return {
        offenders: stale.map((d, i) => getItemName(d, i)).filter(Boolean).slice(0, 5),
        count: stale.length,
        stakeLabel: totalValue > 0 ? `${formatMoney(totalValue, currencySymbol)} of pipeline value` : undefined,
        sampleSize: items.length,
        honesty: `Based on a sample of ${items.length} deals — treat this as indicative, not exhaustive.`,
      };
    },
  },
  {
    id: "unforecastable-deals",
    severity: "CRITICAL", impact: "High", effort: "Easy", targetSection: "crm-dashboard",
    requires: [], requiresRecordSamples: ["deals"],
    build: ({ recordSamples }) => {
      const items = recordSamples.deals?.items ?? [];
      const bad = items.filter(isDealUnforecastable);
      if (bad.length === 0) return null;
      return {
        offenders: bad.map((d, i) => getItemName(d, i)).filter(Boolean).slice(0, 5),
        count: bad.length,
        sampleSize: items.length,
        honesty: `Based on a sample of ${items.length} deals — treat this as indicative, not exhaustive.`,
      };
    },
  },
  {
    id: "stale-user-logins",
    severity: "WARNING", impact: "Medium", effort: "Easy", targetSection: "crm-dashboard",
    requires: ["users"],
    build: ({ entityData }) => {
      const activeUsers = entityData.users.items.filter(u => !isInactiveUser(u));
      if (!userLoginFieldPresent(activeUsers)) return null; // this MCP server/org doesn't expose login activity — don't guess
      const stale = activeUsers.filter(u => { const age = userLoginAgeDays(u); return age !== null && age > STALE_LOGIN_THRESHOLD_DAYS; });
      if (stale.length === 0) return null;
      const offenders = stale.slice(0, 5).map((u, i) => {
        const name = getItemName(u, i) || "Unnamed user";
        const lastLogin = userLastLoginDate(u);
        return lastLogin ? `${name} (no login since ${formatShortDate(lastLogin)})` : name;
      });
      return {
        offenders,
        count: stale.length,
        stakeLabel: `${stale.length} paid seat${stale.length !== 1 ? "s" : ""}`,
        honesty: `Confirmed from login activity on all ${activeUsers.length} active users in your CRM — flagged when no login in over ${STALE_LOGIN_THRESHOLD_DAYS} days.`,
      };
    },
  },
  {
    id: "duplicate-emails",
    severity: "WARNING", impact: "Medium", effort: "Easy", targetSection: "crm-dashboard",
    requires: [], requiresRecordSamples: ["leads", "contacts"],
    build: ({ recordSamples }) => {
      const leadItems = recordSamples.leads?.items ?? [];
      const contactItems = recordSamples.contacts?.items ?? [];
      const all = [...leadItems, ...contactItems];
      const dupGroups = [...groupByEmail(all).entries()].filter(([, recs]) => recs.length > 1);
      if (dupGroups.length === 0) return null;
      const totalDupRecords = dupGroups.reduce((sum, [, recs]) => sum + recs.length, 0);
      return {
        offenders: dupGroups.slice(0, 5).map(([email, recs]) => `${email} (${recs.length}×)`),
        count: totalDupRecords,
        sampleSize: all.length,
        honesty: `Based on a sample of ${all.length} leads and contacts combined — the real duplicate count across your full database is likely higher.`,
      };
    },
  },
  {
    id: "no-lead-source",
    severity: "WARNING", impact: "Medium", effort: "Medium", targetSection: "crm-dashboard",
    requires: [], requiresRecordSamples: ["leads"],
    build: ({ recordSamples }) => {
      const items = recordSamples.leads?.items ?? [];
      const noSource = items.filter(hasNoLeadSource);
      if (noSource.length === 0) return null;
      return {
        offenders: [], count: noSource.length,
        sampleSize: items.length,
        honesty: `Based on a sample of ${items.length} leads — treat this as indicative, not exhaustive.`,
      };
    },
  },
];

// Every finding id, for presentation layers (costCards.ts/priorityActions.ts)
// that need to iterate/look up defs without re-deriving them.
export const FINDING_IDS: string[] = FINDING_DEFS.map(d => d.id);

// A finding that returned "no issue" while one of its required entities
// actually failed to fetch (rather than confirming a real zero) is not
// verified clean — it just couldn't be checked. Callers must show "couldn't
// verify" for these instead of folding them into a silent, false "all clear".
export interface UncertainFinding {
  id: string;
  /** Which required data source(s) failed, and why — e.g. "profiles: Failed to fetch". */
  reason: string;
}

export function evaluateFindings(ctx: FindingContext): { findings: Finding[]; loadingIds: string[]; uncertain: UncertainFinding[] } {
  const loadingIds: string[] = [];
  const findings: Finding[] = [];
  const uncertain: UncertainFinding[] = [];
  const pipelineResolved = !ctx.pipelineStages.loading && (ctx.pipelineStages.lastFetched !== null || ctx.pipelineStages.error !== null);

  for (const def of FINDING_DEFS) {
    const entitiesResolved = def.requires.every(t => isEntityResolved(ctx.entityData[t]));
    const pipelineOk = !def.requiresPipelineStages || pipelineResolved;
    const samplesOk = !def.requiresRecordSamples || def.requiresRecordSamples.every(id => {
      const rs = ctx.recordSamples[id];
      return !!rs && !rs.loading && (rs.lastFetched !== null || rs.error !== null);
    });
    const moduleCountsOk = !def.requiresModuleRecordCounts || ctx.moduleRecordCounts.resolved;

    if (!entitiesResolved || !pipelineOk || !samplesOk || !moduleCountsOk) {
      loadingIds.push(def.id);
      continue;
    }

    // Entities that resolved via a fetch error (not real data) can't confirm
    // a clean result — items defaults to [] on both a real empty org and a
    // failed fetch, so a build() that returns null here means "couldn't
    // check", not "checked, and it's fine".
    const erroredEntities = def.requires.filter(t => ctx.entityData[t].error !== null);

    const dynamic = def.build(ctx);
    if (!dynamic) {
      if (erroredEntities.length > 0) {
        uncertain.push({
          id: def.id,
          reason: erroredEntities.map(t => `${t}: ${ctx.entityData[t].error}`).join("; "),
        });
      }
      continue;
    }
    findings.push({
      id: def.id,
      severity: def.severity,
      impact: def.impact,
      effort: def.effort,
      targetSection: def.targetSection,
      ...dynamic,
    });
  }

  return { findings, loadingIds, uncertain };
}

export type { FindingContext };
