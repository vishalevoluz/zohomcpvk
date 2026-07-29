import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isActiveWorkflow, isAdminProfile, isInactiveUser, isMandatoryField, workflowReferencesModule, ruleCoverageCount } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/crmPredicates";
import { automationCoverageApiNames } from "@/lib/flowMapModel";

export interface HealthScoreDimensions {
  automationCoverage: number;
  processCompleteness: number;
  accessSecurity: number;
  dataArchitecture: number;
  automationHealth: number;
}

// RuleCoverage now lives in crmPredicates.ts so flowMapModel.ts can share the
// same "what counts as automation" definition without importing this file
// (which itself imports from flowMapModel.ts). Re-exported here so existing
// consumers (useRuleCoverage.ts, BusinessView.tsx, etc.) don't need to change.
export type { RuleCoverage } from "@/lib/crmPredicates";

export type HealthZone = "healthy" | "needs-attention" | "at-risk" | "critical";

export interface HealthScoreResult {
  total: number;
  dimensions: HealthScoreDimensions;
  zone: HealthZone;
  verdict: string;
  color: string;
}

function scoreAutomationCoverage(modules: unknown[], workflows: unknown[], ruleCoverage: RuleCoverage | null): number {
  // Measured against the lead-to-deal lifecycle modules the flow map's own
  // "automation layer" checks (Leads, Campaigns, Contacts, Deals) rather than
  // every module in the org. Orgs can have hundreds of custom/junction modules
  // that were never candidates for a workflow rule in the first place — dividing
  // by all of them makes real coverage round down to 0 no matter how many of the
  // modules that actually matter are automated.
  const coreApiNames = automationCoverageApiNames(modules);
  if (coreApiNames.length === 0) return 20;
  const activeWorkflows = workflows.filter(isActiveWorkflow);
  // "Automated" now means workflows OR any of assignment/approval/validation/
  // layout rules — a module fully covered by a validation rule + assignment
  // rule but no workflow shouldn't read as unautomated just because workflows
  // happen to be the only rule type entityData fetches as a flat list.
  const covered = coreApiNames.filter(apiName => {
    if (activeWorkflows.some(w => workflowReferencesModule(w, apiName))) return true;
    return ruleCoverageCount(ruleCoverage, apiName) > 0;
  }).length;
  return Math.round(20 * (covered / coreApiNames.length));
}

function scoreProcessCompleteness(pipelines: unknown[], blueprints: unknown[], pipelineStageCount: number): number {
  let score = 20;
  if (pipelines.length === 0) score -= 7;
  if (blueprints.length === 0) score -= 7;
  if (pipelineStageCount === 0) score -= 7;
  return Math.max(0, score);
}

function scoreAccessSecurity(profiles: unknown[], users: unknown[]): number {
  let score = 20;
  const adminCount = profiles.filter(isAdminProfile).length;
  if (adminCount > 2) score -= 5;
  const inactiveUsers = users.filter(isInactiveUser).length;
  score -= Math.min(10, inactiveUsers * 3);
  if (profiles.length === 1) score -= 10;
  return Math.max(0, score);
}

function scoreDataArchitecture(fields: unknown[], modules: unknown[]): number {
  let score = 20;
  const mandatoryCount = fields.filter(isMandatoryField).length;
  if (mandatoryCount > 20) score -= Math.min(15, mandatoryCount - 20);
  if (modules.length > 15) score -= 5;
  return Math.max(0, score);
}

function scoreAutomationHealth(workflows: unknown[]): number {
  // A percentage of total, matching what the dimension's own tooltip promises
  // ("what share of your existing workflows are actually turned on"). The old
  // formula subtracted a flat inactive count capped at 20 — any org with 20+
  // inactive rules (common once workflows accumulate over years) permanently
  // bottomed out at 0 regardless of how many were active, so activating more
  // workflows never moved this dimension at all.
  if (workflows.length === 0) return 20;
  const active = workflows.filter(isActiveWorkflow).length;
  // Floored at 1 whenever at least one workflow is active — otherwise a tiny
  // active ratio (e.g. 1 of 64) rounds down to the same 0/20 as having zero
  // active workflows at all, hiding that some automation genuinely exists.
  if (active === 0) return 0;
  return Math.max(1, Math.round(20 * (active / workflows.length)));
}

// Same healthy/needs-attention/at-risk/critical banding used for the overall
// score (80/60/40 out of 100), scaled to whatever max a given score is out of —
// so per-dimension bars (out of 20) land in the same zones as the total would.
export function zoneForValue(score: number, max: number): HealthZone {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 80) return "healthy";
  if (pct >= 60) return "needs-attention";
  if (pct >= 40) return "at-risk";
  return "critical";
}

function zoneForTotal(total: number): { zone: HealthZone; verdict: string; color: string } {
  const zone = zoneForValue(total, 100);
  switch (zone) {
    case "healthy": return { zone, verdict: "Your CRM is well-configured and running efficiently.", color: "#16A34A" };
    case "needs-attention": return { zone, verdict: "Your CRM has gaps that are likely costing you leads or time.", color: "#D97706" };
    case "at-risk": return { zone, verdict: "Significant issues detected. These are impacting your sales process.", color: "#EA580C" };
    case "critical": return { zone, verdict: "Your CRM has serious problems. Immediate action recommended.", color: "#DC2626" };
  }
}

// pipelineStageCount comes from the real getLayouts → getPipelines chain (see
// usePipelineStages.ts / the flow map's pill chain) rather than the generic
// "stages" entity — no MCP server exposes a dedicated stages-listing tool, so
// entityData.stages.items is always empty and used to permanently dock 7
// points from Process Completeness even for orgs with a fully configured
// pipeline. Defaults to entityData.stages.items.length for callers that
// haven't wired the real count through yet.
export function computeHealthScore(
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStageCount: number = entityData.stages.items.length,
  ruleCoverage: RuleCoverage | null = null
): HealthScoreResult {
  const dimensions: HealthScoreDimensions = {
    automationCoverage: scoreAutomationCoverage(entityData.modules.items, entityData.workflows.items, ruleCoverage),
    processCompleteness: scoreProcessCompleteness(entityData.pipelines.items, entityData.blueprints.items, pipelineStageCount),
    accessSecurity: scoreAccessSecurity(entityData.profiles.items, entityData.users.items),
    dataArchitecture: scoreDataArchitecture(entityData.fields.items, entityData.modules.items),
    automationHealth: scoreAutomationHealth(entityData.workflows.items),
  };
  const total = Object.values(dimensions).reduce((a, b) => a + b, 0);
  const { zone, verdict, color } = zoneForTotal(total);
  return { total, dimensions, zone, verdict, color };
}

function withEntity(
  entityData: Record<CrmEntityType, EntityState>,
  type: CrmEntityType,
  items: unknown[],
): Record<CrmEntityType, EntityState> {
  return { ...entityData, [type]: { ...entityData[type], items } };
}

// "Top Priority Actions"' projected score-effect line ("fixing this moves
// your score from 62 to ~69") — built by re-running the REAL scoring formulas
// above against a hypothetical "this finding fixed" copy of entityData,
// rather than a hand-guessed number, so it stays traceable to the same logic
// that produced the current score. Only implemented for findings whose
// underlying dimension formula is a clean, invertible flat penalty; returns
// null for findings with no clean simulation (e.g. record-quality findings
// like stale deals or duplicate emails — businessScore.ts doesn't score
// record-level data quality at all, so there's nothing honest to project).
export function estimateScoreGain(
  findingId: string,
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStageCount: number,
  ruleCoverage: RuleCoverage | null,
): number | null {
  const before = computeHealthScore(entityData, pipelineStageCount, ruleCoverage).total;
  let mutated: Record<CrmEntityType, EntityState>;
  let mutatedPipelineStageCount = pipelineStageCount;

  switch (findingId) {
    case "no-email-workflow": {
      const coreNames = automationCoverageApiNames(entityData.modules.items);
      if (coreNames.length === 0) return null;
      const projectedWorkflow = { status: { active: true }, module: coreNames[0], description: "email follow-up (projected)" };
      mutated = withEntity(entityData, "workflows", [...entityData.workflows.items, projectedWorkflow]);
      break;
    }
    case "inactive-users": {
      mutated = withEntity(entityData, "users", entityData.users.items.filter(u => !isInactiveUser(u)));
      break;
    }
    case "excessive-mandatory-fields": {
      let mandatorySeen = 0;
      const projectedFields = entityData.fields.items.map(f => {
        if (!isMandatoryField(f)) return f;
        mandatorySeen++;
        if (mandatorySeen <= 20) return f;
        return { ...(f as Record<string, unknown>), required: false, mandatory: false, system_mandatory: false };
      });
      mutated = withEntity(entityData, "fields", projectedFields);
      break;
    }
    case "no-pipeline": {
      mutated = withEntity(entityData, "pipelines", [{ id: "projected", default: true }]);
      mutatedPipelineStageCount = Math.max(pipelineStageCount, 1);
      break;
    }
    case "workflows-inactive": {
      const wfs = entityData.workflows.items;
      if (wfs.length === 0) return null;
      const inactiveIdx = wfs.map((w, i) => ({ w, i })).filter(x => !isActiveWorkflow(x.w));
      const targetInactive = Math.floor(wfs.length * 0.3);
      const numToFlip = Math.max(0, inactiveIdx.length - targetInactive);
      const flipSet = new Set(inactiveIdx.slice(0, numToFlip).map(x => x.i));
      const projectedWorkflows = wfs.map((w, i) =>
        flipSet.has(i) ? { ...(w as Record<string, unknown>), status: { active: true }, active: true, enabled: true } : w
      );
      mutated = withEntity(entityData, "workflows", projectedWorkflows);
      break;
    }
    case "no-blueprint": {
      mutated = withEntity(entityData, "blueprints", [{ id: "projected", status: "Active" }]);
      break;
    }
    case "access-risk": {
      const profiles = entityData.profiles.items;
      const isUniform = profiles.length === 1 || profiles.every(isAdminProfile);
      const projectedProfiles = isUniform
        ? [...profiles, { name: "Standard", id: "projected-1" }, { name: "Sales Rep", id: "projected-2" }]
        : [...profiles.filter(p => !isAdminProfile(p)), ...profiles.filter(isAdminProfile).slice(0, 2)];
      mutated = withEntity(entityData, "profiles", projectedProfiles);
      break;
    }
    default:
      return null;
  }

  const after = computeHealthScore(mutated, mutatedPipelineStageCount, ruleCoverage).total;
  return Math.max(0, Math.round(after) - Math.round(before));
}

// Entities that must be resolved before the score reflects real data.
export const HEALTH_SCORE_ENTITIES: CrmEntityType[] = ["workflows", "blueprints", "pipelines", "stages", "profiles", "users", "fields", "modules"];
