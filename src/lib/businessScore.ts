import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isActiveWorkflow, isAdminProfile, isInactiveUser, isMandatoryField, moduleApiName, workflowReferencesModule } from "@/lib/crmPredicates";

export interface HealthScoreDimensions {
  automationCoverage: number;
  processCompleteness: number;
  accessSecurity: number;
  dataArchitecture: number;
  automationHealth: number;
}

export type HealthZone = "healthy" | "needs-attention" | "at-risk" | "critical";

export interface HealthScoreResult {
  total: number;
  dimensions: HealthScoreDimensions;
  zone: HealthZone;
  verdict: string;
  color: string;
}

function scoreAutomationCoverage(modules: unknown[], workflows: unknown[]): number {
  if (modules.length === 0) return 20;
  const activeWorkflows = workflows.filter(isActiveWorkflow);
  let missing = 0;
  for (const m of modules) {
    const apiName = moduleApiName(m);
    const covered = apiName && activeWorkflows.some(w => workflowReferencesModule(w, apiName));
    if (!covered) missing++;
  }
  return Math.max(0, 20 - missing * 2);
}

function scoreProcessCompleteness(pipelines: unknown[], blueprints: unknown[], stages: unknown[]): number {
  let score = 20;
  if (pipelines.length === 0) score -= 7;
  if (blueprints.length === 0) score -= 7;
  if (stages.length === 0) score -= 7;
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
  if (workflows.length === 0) return 20;
  const inactive = workflows.filter(w => !isActiveWorkflow(w)).length;
  return Math.max(0, 20 - Math.min(20, inactive));
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

export function computeHealthScore(entityData: Record<CrmEntityType, EntityState>): HealthScoreResult {
  const dimensions: HealthScoreDimensions = {
    automationCoverage: scoreAutomationCoverage(entityData.modules.items, entityData.workflows.items),
    processCompleteness: scoreProcessCompleteness(entityData.pipelines.items, entityData.blueprints.items, entityData.stages.items),
    accessSecurity: scoreAccessSecurity(entityData.profiles.items, entityData.users.items),
    dataArchitecture: scoreDataArchitecture(entityData.fields.items, entityData.modules.items),
    automationHealth: scoreAutomationHealth(entityData.workflows.items),
  };
  const total = Object.values(dimensions).reduce((a, b) => a + b, 0);
  const { zone, verdict, color } = zoneForTotal(total);
  return { total, dimensions, zone, verdict, color };
}

// Entities that must be resolved before the score reflects real data.
export const HEALTH_SCORE_ENTITIES: CrmEntityType[] = ["workflows", "blueprints", "pipelines", "stages", "profiles", "users", "fields", "modules"];
