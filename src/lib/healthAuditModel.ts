// Presentational re-shaping of computeHealthScore's output for the redesigned
// "CRM Health Score" dashboard (see HealthScoreDashboard.tsx). This file does
// NOT change any scoring logic in businessScore.ts — it only re-derives the
// same pass/fail conditions each scoreXxx function already checks, so a
// checklist item can never disagree with the real dimension score. The one
// authoritative number for "the score" is always computeHealthScore()'s own
// output; checklist item `weight`s are informational ("potential gain from
// this one fix"), never summed into a second competing total.
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import {
  isActiveWorkflow, isAdminProfile, isAdminProfileUser, isInactiveUser, isDeletedUser, isMandatoryField, hasEmailAction,
  workflowReferencesModule, ruleCoverageCount, blueprintStatus, unreferencedModules, isDeletedModule,
  isEmptyModule, isHiddenModule, moduleApiName, blueprintsForModule,
} from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/crmPredicates";
import { automationCoverageApiNames } from "@/lib/flowMapModel";
import {
  computeHealthScore, zoneForValue, HEALTH_SCORE_ENTITIES,
  type HealthScoreDimensions, type HealthZone,
} from "@/lib/businessScore";
import type { ActionImpact, ActionEffort } from "@/lib/priorityActions";
import type { Section } from "@/lib/sections";

export type DimensionKey = keyof HealthScoreDimensions;

export type DimensionIconKey = "automation" | "process" | "security" | "data" | "workflow-health";

export const DIMENSION_ORDER: DimensionKey[] = [
  "automationCoverage", "processCompleteness", "accessSecurity", "dataArchitecture", "automationHealth",
];

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  automationCoverage: "Automation Coverage",
  processCompleteness: "Sales Process Setup",
  accessSecurity: "Team Security",
  dataArchitecture: "Data Structure",
  automationHealth: "Workflow Health",
};

export const DIMENSION_ICONS: Record<DimensionKey, DimensionIconKey> = {
  automationCoverage: "automation",
  processCompleteness: "process",
  accessSecurity: "security",
  dataArchitecture: "data",
  automationHealth: "workflow-health",
};

export const DIMENSION_TOOLTIPS: Record<DimensionKey, string> = {
  automationCoverage: "Of your core lead-to-deal modules — Leads, Campaigns, Contacts, Deals — how many have at least one active workflow, assignment rule, approval process, validation rule, or layout rule watching them. The ones with none drag this score down.",
  processCompleteness: "Whether a sales pipeline, blueprint, and defined stages actually exist. Missing pieces mean reps have no set path to follow.",
  accessSecurity: "Whether access is split into real roles instead of everyone sharing one login level, and whether inactive users still hold licenses.",
  dataArchitecture: "Whether your fields and module count are kept reasonable, not bloated with excess required fields or clutter.",
  automationHealth: "What share of your existing workflows are actually turned on right now.",
};

// Same finding ids as businessFindings.ts (the "What Is Costing You" / "Top
// Priority Actions" source of truth) — kept as a small self-contained
// re-derivation here rather than importing that module directly, matching
// this file's existing design principle (see header comment): every
// checklist condition here is its own local pass/fail re-check against the
// same predicates, so it can never disagree with the real dimension score,
// and doesn't need the full record-sample/module-record-count context the
// main panels use for their fuller evidence.
const DIMENSION_TO_ACTION_IDS: Record<DimensionKey, string[]> = {
  automationCoverage: ["no-email-workflow", "workflows-inactive"],
  processCompleteness: ["no-pipeline", "no-blueprint"],
  accessSecurity: ["access-risk", "inactive-users"],
  dataArchitecture: ["excessive-mandatory-fields", "empty-modules"],
  automationHealth: ["workflows-inactive", "no-email-workflow"],
};

interface ActionInfo { title: string; why: string; impact: ActionImpact; effort: ActionEffort; targetSection: Section }

const ACTION_INFO: Record<string, ActionInfo> = {
  "no-email-workflow": {
    title: "Activate Email Follow-Up Workflows",
    why: "Unanswered leads go cold. Automated follow-up keeps prospects engaged without relying on reps to remember.",
    impact: "High", effort: "Medium", targetSection: "workflows",
  },
  "workflows-inactive": {
    title: "Consolidate Inactive Workflows",
    why: "Inactive workflows create confusion and may silently fail when re-enabled. Clean them up or delete them.",
    impact: "Medium", effort: "Easy", targetSection: "workflows",
  },
  "no-pipeline": {
    title: "Build a Sales Pipeline",
    why: "Without defined stages you cannot track deals, forecast revenue, or spot where you are losing business.",
    impact: "High", effort: "Easy", targetSection: "crm-dashboard",
  },
  "no-blueprint": {
    title: "Deploy a Blueprint for Your Key Process",
    why: "Blueprints enforce your sales process. Without them, reps skip steps and managers have no visibility.",
    impact: "High", effort: "Hard", targetSection: "blueprints",
  },
  "access-risk": {
    title: "Create Role-Based Access Profiles",
    why: "A sales rep should not have the same access as an admin. Separate profiles protect your data.",
    impact: "High", effort: "Easy", targetSection: "crm-dashboard",
  },
  "inactive-users": {
    title: "Remove Inactive User Licenses",
    why: "Every inactive user with a paid license is a direct monthly cost with zero return.",
    impact: "High", effort: "Easy", targetSection: "crm-dashboard",
  },
  "excessive-mandatory-fields": {
    title: "Reduce Mandatory Field Count",
    why: "Too many required fields push reps to enter dummy data. Fewer, smarter fields improve data quality.",
    impact: "Medium", effort: "Medium", targetSection: "fields",
  },
  "empty-modules": {
    title: "Hide Unused Empty Modules",
    why: "Unused modules clutter the interface and confuse new team members. Hide them from each profile's module settings instead of deleting.",
    impact: "Low", effort: "Easy", targetSection: "modules",
  },
};

function actionConditionTriggered(id: string, entityData: Record<CrmEntityType, EntityState>, pipelineStageCount: number): boolean {
  switch (id) {
    case "no-email-workflow": return !entityData.workflows.items.some(hasEmailAction);
    case "workflows-inactive": {
      const total = entityData.workflows.items.length;
      if (total === 0) return false;
      return entityData.workflows.items.filter(w => !isActiveWorkflow(w)).length / total > 0.3;
    }
    case "no-pipeline": return pipelineStageCount === 0;
    case "no-blueprint": return entityData.blueprints.items.length === 0;
    case "access-risk": {
      const profiles = entityData.profiles.items;
      if (profiles.length === 0) return false;
      return profiles.length === 1 || profiles.every(isAdminProfile) || profiles.filter(isAdminProfile).length > 2;
    }
    case "inactive-users": return entityData.users.items.some(isInactiveUser);
    case "excessive-mandatory-fields": return entityData.fields.items.filter(isMandatoryField).length > 20;
    case "empty-modules": return unreferencedModules(entityData.modules.items, entityData.workflows.items, entityData.blueprints.items).length > 3;
    default: return false;
  }
}

const ACTION_REQUIRES: Record<string, CrmEntityType[]> = {
  "no-email-workflow": ["workflows"],
  "workflows-inactive": ["workflows"],
  "no-pipeline": [],
  "no-blueprint": ["blueprints"],
  "access-risk": ["profiles"],
  "inactive-users": ["users"],
  "excessive-mandatory-fields": ["fields"],
  "empty-modules": ["modules", "workflows", "blueprints"],
};

const SEVERITY_LABEL: Record<HealthZone, "Critical" | "At Risk" | "Needs Attention" | "Healthy"> = {
  critical: "Critical",
  "at-risk": "At Risk",
  "needs-attention": "Needs Attention",
  healthy: "Healthy",
};

export interface ModuleBreakdownRow {
  label: string;
  count: number;
}

export interface ModuleBreakdownGroup {
  label: string;
  rows: ModuleBreakdownRow[];
}

// Raw attribute names straight off Zoho's getModules() response — verified
// against a live org's payload (see the conversation this was built from).
// Boolean fields are bucketed into "Yes"/"No"; everything else groups by its
// raw string value (e.g. generated_type's "default"/"custom"/"subform"/...).
const MODULE_BREAKDOWN_FIELDS: { key: string; label: string; boolean?: boolean }[] = [
  { key: "generated_type", label: "Generated Type" },
  { key: "status", label: "Status" },
  { key: "viewable", label: "Viewable", boolean: true },
  { key: "show_as_tab", label: "Show as Tab", boolean: true },
  { key: "creatable", label: "Creatable", boolean: true },
  { key: "editable", label: "Editable", boolean: true },
  { key: "deletable", label: "Deletable", boolean: true },
  { key: "api_supported", label: "API Supported", boolean: true },
  { key: "isBlueprintSupported", label: "Blueprint Support", boolean: true },
  { key: "quick_create", label: "Quick Create", boolean: true },
];

function buildModuleBreakdown(modules: unknown[]): ModuleBreakdownGroup[] {
  if (modules.length === 0) return [];
  return MODULE_BREAKDOWN_FIELDS.map(({ key, label, boolean }) => {
    const counts = new Map<string, number>();
    for (const m of modules) {
      const r = (m ?? {}) as Record<string, unknown>;
      const bucket = boolean ? (r[key] === true ? "Yes" : "No") : String(r[key] ?? "unknown");
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const rows = Array.from(counts.entries())
      .map(([rowLabel, count]) => ({ label: rowLabel, count }))
      .sort((a, b) => b.count - a.count);
    return { label, rows };
  });
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail: string;
  /** Real point value this item is worth in the scoring formula — shown only on failing items ("+N pts available"). */
  weight: number;
}

export interface DimensionRecommendation {
  id: string;
  title: string;
  why: string;
  impact: ActionImpact;
  effort: ActionEffort;
  targetSection: Section;
}

export interface DimensionCard {
  key: DimensionKey;
  label: string;
  tooltip: string;
  iconKey: DimensionIconKey;
  score: number;
  potential: 20;
  gain: number;
  zone: HealthZone;
  checklist: ChecklistItem[];
  recommendations: DimensionRecommendation[];
  allSet: boolean;
  /** One plain-English line tracing this score to the real finding(s) that produced it — e.g. "3 active modules have no follow-up workflow: Leads, Deals, Cases". Shown under the gauge so a client's "why did I lose those points?" always has a defensible, specific answer. */
  reason: string;
  /** Only ever non-null for automationHealth, and only when its score is below 10. */
  criticalAlert: string | null;
  /** Only ever non-null for dataArchitecture — a full module-attribute breakdown from the raw getModules() data. */
  moduleBreakdown: ModuleBreakdownGroup[] | null;
}

export interface RoadmapEntry {
  key: DimensionKey;
  label: string;
  score: number;
  potential: 20;
  gain: number;
  zone: HealthZone;
  severityLabel: "Critical" | "At Risk" | "Needs Attention" | "Healthy";
}

export interface HealthAuditModel {
  resolved: boolean;
  total: number;
  potentialTotal: 100;
  gainTotal: number;
  zone: HealthZone;
  verdict: string;
  dimensions: DimensionCard[];
  roadmap: RoadmapEntry[];
}

function recommendationsFor(key: DimensionKey, entityData: Record<CrmEntityType, EntityState>, pipelineStageCount: number): DimensionRecommendation[] {
  return DIMENSION_TO_ACTION_IDS[key]
    .filter(id => ACTION_REQUIRES[id].every(t => isEntityResolved(entityData[t])) && actionConditionTriggered(id, entityData, pipelineStageCount))
    .map(id => ({ id, ...ACTION_INFO[id] }));
}

function automationCoverageChecklist(entityData: Record<CrmEntityType, EntityState>, ruleCoverage: RuleCoverage | null): ChecklistItem[] {
  const coreApiNames = automationCoverageApiNames(entityData.modules.items);
  if (coreApiNames.length === 0) {
    return [{
      id: "automation-coverage-none",
      label: "No core lead-to-deal modules found",
      status: "pass",
      detail: "Leads, Campaigns, Contacts, and Deals were not found in this org, so this dimension defaults to full marks.",
      weight: 20,
    }];
  }
  const activeWorkflows = entityData.workflows.items.filter(isActiveWorkflow);
  const weight = Math.round(20 / coreApiNames.length);
  return coreApiNames.map(apiName => {
    const hasWorkflow = activeWorkflows.some(w => workflowReferencesModule(w, apiName));
    const ruleCount = ruleCoverageCount(ruleCoverage, apiName);
    const pass = hasWorkflow || ruleCount > 0;
    return {
      id: `automation-coverage-${apiName}`,
      label: `${apiName} has automation coverage`,
      status: pass ? "pass" : "fail",
      detail: pass
        ? `Covered by ${hasWorkflow ? "an active workflow" : `${ruleCount} rule${ruleCount !== 1 ? "s" : ""} (assignment/approval/validation/layout)`}.`
        : `No active workflow or assignment/approval/validation/layout rule found for ${apiName}.`,
      weight,
    };
  });
}

// One plain-English line naming exactly which core modules are missing
// automation — the same fail/pass split automationCoverageChecklist computes,
// re-derived independently (per this file's header comment) so it can never
// drift from the real score or the checklist rows shown alongside it.
function automationCoverageReason(entityData: Record<CrmEntityType, EntityState>, ruleCoverage: RuleCoverage | null): string {
  const coreApiNames = automationCoverageApiNames(entityData.modules.items);
  if (coreApiNames.length === 0) {
    return "Leads, Campaigns, Contacts, and Deals weren't found in this org, so this dimension defaults to full marks.";
  }
  const activeWorkflows = entityData.workflows.items.filter(isActiveWorkflow);
  const failing = coreApiNames.filter(apiName => {
    const hasWorkflow = activeWorkflows.some(w => workflowReferencesModule(w, apiName));
    return !hasWorkflow && ruleCoverageCount(ruleCoverage, apiName) === 0;
  });
  if (failing.length === 0) {
    return `All ${coreApiNames.length} core module${coreApiNames.length !== 1 ? "s" : ""} (${coreApiNames.join(", ")}) have an active workflow or rule watching them.`;
  }
  return `${failing.length} active module${failing.length !== 1 ? "s" : ""} ${failing.length !== 1 ? "have" : "has"} no follow-up workflow or rule: ${failing.join(", ")}.`;
}

function processCompletenessChecklist(
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStageCount: number,
  outOfOrderStageCount: number,
  pipelineCountOverride: number | null,
): ChecklistItem[] {
  // The generic zero-param getPipelines() entityData.pipelines comes from has
  // no layout_id to scope by, so it can undercount an org with more than one
  // pipeline on the Deals layout — the override (from the real getLayouts ->
  // getPipelines chain) is the authoritative number once it's resolved.
  const pipelineCount = pipelineCountOverride ?? entityData.pipelines.items.length;
  const blueprintCount = entityData.blueprints.items.length;
  const stagesOk = pipelineStageCount > 0 && outOfOrderStageCount === 0;
  return [
    {
      id: "process-pipeline", label: "A sales pipeline exists", status: pipelineCount > 0 ? "pass" : "fail",
      detail: pipelineCount > 0 ? `${pipelineCount} pipeline${pipelineCount !== 1 ? "s" : ""} configured.` : "No sales pipeline is configured.",
      weight: 7,
    },
    {
      id: "process-blueprint", label: "A blueprint process exists", status: blueprintCount > 0 ? "pass" : "fail",
      detail: blueprintCount > 0 ? `${blueprintCount} blueprint${blueprintCount !== 1 ? "s" : ""} configured.` : "No blueprint process is configured.",
      weight: 7,
    },
    {
      id: "process-stages", label: "Pipeline stages are in a valid order", status: stagesOk ? "pass" : "fail",
      detail: pipelineStageCount === 0
        ? "No pipeline stages were found."
        : outOfOrderStageCount > 0
          ? `${pipelineStageCount} stage${pipelineStageCount !== 1 ? "s" : ""} defined, but ${outOfOrderStageCount} ${outOfOrderStageCount !== 1 ? "are" : "is"} sequenced after a Closed Won/Lost stage.`
          : `${pipelineStageCount} stage${pipelineStageCount !== 1 ? "s" : ""} defined on your Deals layout, in order.`,
      weight: 7,
    },
  ];
}

function processCompletenessReason(entityData: Record<CrmEntityType, EntityState>, pipelineStageCount: number, outOfOrderStageCount: number): string {
  const missing: string[] = [];
  if (entityData.pipelines.items.length === 0) missing.push("no sales pipeline");
  if (entityData.blueprints.items.length === 0) missing.push("no blueprint process");
  if (pipelineStageCount === 0) missing.push("no defined pipeline stages");
  else if (outOfOrderStageCount > 0) missing.push(`${outOfOrderStageCount} pipeline stage${outOfOrderStageCount !== 1 ? "s" : ""} sequenced after Closed Won/Lost`);
  if (missing.length === 0) return "A sales pipeline, blueprint process, and defined pipeline stages are all in place.";
  return `Missing: ${missing.join(", ")}.`;
}

function accessSecurityChecklist(entityData: Record<CrmEntityType, EntityState>): ChecklistItem[] {
  // Admin-profile USERS, not admin-named profile catalog entries — an org can
  // define a single "Administrator" profile and still assign it to most of
  // the team, which counting profile definitions alone would completely miss.
  const adminCount = entityData.users.items.filter(isAdminProfileUser).length;
  // "Licensed but not active" (disabled) is what actually costs money and is
  // what the score penalty below is based on — deleted accounts hold no
  // license. nonActiveCount (disabled + deleted) is shown in the detail text
  // too so a deleted account still visible in the user list doesn't read as
  // a clean bill of health, without inflating the score-affecting number.
  const inactiveUsers = entityData.users.items.filter(isInactiveUser).length;
  const deletedUsers = entityData.users.items.filter(isDeletedUser).length;
  const nonActiveCount = inactiveUsers + deletedUsers;
  const profileCount = entityData.profiles.items.length;
  const userCount = entityData.users.items.length;
  return [
    {
      id: "access-admin-count", label: "Admin access is limited", status: adminCount <= 2 ? "pass" : "fail",
      detail: userCount > 0
        ? `${adminCount} of ${userCount} user${userCount !== 1 ? "s" : ""} hold an admin-named profile${adminCount > 2 ? " (more than 2 increases risk)" : ""}.`
        : "No users found.",
      weight: 5,
    },
    {
      id: "access-inactive-users", label: "No inactive or deleted users still visible", status: nonActiveCount === 0 ? "pass" : "fail",
      detail: nonActiveCount === 0
        ? "No inactive or deleted users found."
        : `${nonActiveCount} of ${userCount} user${userCount !== 1 ? "s" : ""} aren't active — ${inactiveUsers} disabled user${inactiveUsers !== 1 ? "s" : ""} still hold a license, and ${deletedUsers} deleted user${deletedUsers !== 1 ? "s are" : " is"} still showing up in the user list (no license cost, but worth confirming they're fully removed elsewhere).`,
      weight: inactiveUsers > 0 ? Math.min(10, inactiveUsers * 3) : 10,
    },
    {
      id: "access-role-segmentation", label: "Access is split into multiple profiles", status: profileCount > 1 ? "pass" : "fail",
      detail: profileCount > 1 ? `${profileCount} profiles configured.` : "Only one profile exists — everyone shares the same access level.",
      weight: 10,
    },
  ];
}

function accessSecurityReason(entityData: Record<CrmEntityType, EntityState>): string {
  const adminCount = entityData.users.items.filter(isAdminProfileUser).length;
  const inactiveUsers = entityData.users.items.filter(isInactiveUser).length;
  const deletedUsers = entityData.users.items.filter(isDeletedUser).length;
  const nonActiveCount = inactiveUsers + deletedUsers;
  const profileCount = entityData.profiles.items.length;
  const userCount = entityData.users.items.length;
  const issues: string[] = [];
  if (adminCount > 2) issues.push(`${adminCount} of ${userCount} users hold an admin-named profile (more than 2)`);
  if (nonActiveCount > 0) issues.push(`${nonActiveCount} user${nonActiveCount !== 1 ? "s" : ""} aren't active (${inactiveUsers} disabled still licensed, ${deletedUsers} deleted)`);
  if (profileCount === 1) issues.push("only one profile exists, so there's no role separation");
  if (issues.length === 0) return "Access is split across multiple profiles, admin access is limited, and no inactive or deleted users are still visible.";
  return `${issues.join("; ")}.`;
}

// Before a module gets named as a cleanup candidate, check whether a
// workflow or blueprint we've already fetched still points at it — "empty"
// (read-only/no create-edit access) and "unused" are not the same claim, and
// a referenced module shouldn't read as safe to delete just because it's
// empty right now.
function emptyModuleLabel(m: unknown, workflows: unknown[], blueprints: unknown[]): string {
  const apiName = moduleApiName(m) || "unnamed";
  const wfCount = workflows.filter(w => workflowReferencesModule(w, apiName)).length;
  const bpCount = blueprintsForModule(blueprints, apiName).length;
  if (wfCount === 0 && bpCount === 0) return apiName;
  const refs: string[] = [];
  if (wfCount > 0) refs.push(`${wfCount} workflow${wfCount !== 1 ? "s" : ""}`);
  if (bpCount > 0) refs.push(`${bpCount} blueprint${bpCount !== 1 ? "s" : ""}`);
  return `${apiName} (empty, but referenced by ${refs.join(" and ")} — don't delete blindly)`;
}

function dataArchitectureChecklist(entityData: Record<CrmEntityType, EntityState>): ChecklistItem[] {
  const mandatoryCount = entityData.fields.items.filter(isMandatoryField).length;
  const activeModules = entityData.modules.items.filter(m => !isDeletedModule(m));
  const moduleCount = activeModules.length;
  // Hidden takes precedence over empty — same rule the Modules panel's own
  // Active/Hidden/Empty breakdown uses (see CRMOverviewDashboard.tsx), so this
  // dimension's "N empty" figure can't disagree with that panel's count.
  const emptyModules = activeModules.filter(m => isEmptyModule(m) && !isHiddenModule(m));
  // A high module count only fails this check when it's actually inflated by
  // empty/unused modules — see scoreDataArchitecture's matching condition.
  const tooManyDueToClutter = moduleCount > 15 && emptyModules.length > 0;
  return [
    {
      id: "data-mandatory-fields", label: "Mandatory field count is reasonable", status: mandatoryCount <= 20 ? "pass" : "fail",
      detail: `${mandatoryCount} mandatory field${mandatoryCount !== 1 ? "s" : ""} found${mandatoryCount > 20 ? " (over the 20 recommended)." : "."}`,
      weight: mandatoryCount > 20 ? Math.min(15, mandatoryCount - 20) : 15,
    },
    {
      id: "data-module-count", label: "Module count is reasonable", status: tooManyDueToClutter ? "fail" : "pass",
      detail: tooManyDueToClutter
        ? `${moduleCount} modules found, including ${emptyModules.length} empty/unused one${emptyModules.length !== 1 ? "s" : ""} (${emptyModules.slice(0, 3).map(m => emptyModuleLabel(m, entityData.workflows.items, entityData.blueprints.items)).join(", ")}${emptyModules.length > 3 ? `, +${emptyModules.length - 3} more` : ""}) driving the count up.`
        : moduleCount > 15
          ? `${moduleCount} modules found — over 15, but all are actively used, so this isn't penalized.`
          : `${moduleCount} module${moduleCount !== 1 ? "s" : ""} found.`,
      weight: 5,
    },
  ];
}

function dataArchitectureReason(entityData: Record<CrmEntityType, EntityState>): string {
  const mandatoryCount = entityData.fields.items.filter(isMandatoryField).length;
  const activeModules = entityData.modules.items.filter(m => !isDeletedModule(m));
  const emptyModules = activeModules.filter(m => isEmptyModule(m) && !isHiddenModule(m));
  const issues: string[] = [];
  if (mandatoryCount > 20) issues.push(`${mandatoryCount} mandatory fields (over the 20 recommended)`);
  if (activeModules.length > 15 && emptyModules.length > 0) {
    const names = emptyModules.slice(0, 3).map(m => emptyModuleLabel(m, entityData.workflows.items, entityData.blueprints.items)).join(", ");
    issues.push(`${activeModules.length} modules, including ${emptyModules.length} empty one${emptyModules.length !== 1 ? "s" : ""} (${names}${emptyModules.length > 3 ? ", +more" : ""})`);
  }
  if (issues.length === 0) return "Mandatory field count and module count are both reasonable.";
  return `${issues.join("; ")}.`;
}

// Pass/fail is derived from the same healthy-zone threshold the dimension's
// own status pill uses (not a raw 100%-active check) — otherwise an org at,
// say, 90% active could show a green "Healthy" pill right next to a red
// checklist row for the same number, which would read as a contradiction.
function automationHealthChecklist(entityData: Record<CrmEntityType, EntityState>, score: number): ChecklistItem[] {
  const total = entityData.workflows.items.length;
  const active = entityData.workflows.items.filter(isActiveWorkflow).length;
  const pass = zoneForValue(score, 20) === "healthy";
  return [{
    id: "automation-health-ratio",
    label: "Active workflow ratio",
    status: pass ? "pass" : "fail",
    detail: total === 0 ? "No workflows configured yet — nothing to break." : `${active} of ${total} workflow${total !== 1 ? "s" : ""} are active.`,
    weight: 20,
  }];
}

function automationHealthReason(entityData: Record<CrmEntityType, EntityState>, score: number): string {
  const total = entityData.workflows.items.length;
  const active = entityData.workflows.items.filter(isActiveWorkflow).length;
  if (total === 0) return "No workflows configured yet — nothing to break.";
  if (zoneForValue(score, 20) === "healthy") return `${active} of ${total} workflow${total !== 1 ? "s" : ""} are active — a healthy ratio.`;
  return `${total - active} of ${total} workflow${total !== 1 ? "s" : ""} ${total - active !== 1 ? "are" : "is"} inactive.`;
}

function automationHealthCriticalAlert(entityData: Record<CrmEntityType, EntityState>, score: number): string | null {
  if (score >= 10) return null;
  const total = entityData.workflows.items.length;
  const active = entityData.workflows.items.filter(isActiveWorkflow).length;
  const inactiveWorkflowCount = total - active;
  const inactiveBlueprintCount = entityData.blueprints.items.filter(bp => blueprintStatus(bp) !== "active").length;
  return `${inactiveWorkflowCount} of ${total} workflow${total !== 1 ? "s" : ""} ${inactiveWorkflowCount !== 1 ? "are" : "is"} inactive`
    + (inactiveBlueprintCount > 0 ? `, and ${inactiveBlueprintCount} blueprint${inactiveBlueprintCount !== 1 ? "s are" : " is"} not active` : "")
    + " — your automation is largely turned off.";
}

export function buildHealthAuditModel(
  entityData: Record<CrmEntityType, EntityState>,
  pipelineStageCount: number,
  ruleCoverage: RuleCoverage | null,
  outOfOrderStageCount = 0,
  pipelineCountOverride: number | null = null,
  // Sales Process Setup's score depends on pipelineStageCount/
  // outOfOrderStageCount, which come from a separate fetch chain
  // (usePipelineStages.ts: getLayouts -> getPipelines) that isn't part of
  // HEALTH_SCORE_ENTITIES and can still be mid-flight after every other
  // entity has resolved. Without this, the score/verdict render as final the
  // instant core CRM data loads, using a still-empty pipelineStageCount (0
  // stages, "no defined pipeline stages") — then flips to the real number a
  // moment later when the pipeline fetch actually completes. That's the
  // exact "score flickers between two numbers" and "Sales Process flips
  // between 13/20 and 20/20" bug this flag exists to prevent.
  pipelineStagesResolved = true,
): HealthAuditModel {
  const { total, dimensions: scores, zone, verdict } = computeHealthScore(entityData, pipelineStageCount, ruleCoverage, outOfOrderStageCount);
  const resolved = HEALTH_SCORE_ENTITIES.every(t => isEntityResolved(entityData[t])) && pipelineStagesResolved;

  const dimensions: DimensionCard[] = DIMENSION_ORDER.map(key => {
    const score = scores[key];
    const dimZone = zoneForValue(score, 20);
    let checklist: ChecklistItem[];
    let reason: string;
    let criticalAlert: string | null = null;
    let moduleBreakdown: ModuleBreakdownGroup[] | null = null;
    switch (key) {
      case "automationCoverage":
        checklist = automationCoverageChecklist(entityData, ruleCoverage);
        reason = automationCoverageReason(entityData, ruleCoverage);
        break;
      case "processCompleteness":
        checklist = processCompletenessChecklist(entityData, pipelineStageCount, outOfOrderStageCount, pipelineCountOverride);
        reason = processCompletenessReason(entityData, pipelineStageCount, outOfOrderStageCount);
        break;
      case "accessSecurity":
        checklist = accessSecurityChecklist(entityData);
        reason = accessSecurityReason(entityData);
        break;
      case "dataArchitecture":
        checklist = dataArchitectureChecklist(entityData);
        reason = dataArchitectureReason(entityData);
        moduleBreakdown = buildModuleBreakdown(entityData.modules.items);
        break;
      case "automationHealth":
        checklist = automationHealthChecklist(entityData, score);
        reason = automationHealthReason(entityData, score);
        criticalAlert = automationHealthCriticalAlert(entityData, score);
        break;
    }
    const recommendations = recommendationsFor(key, entityData, pipelineStageCount);
    return {
      key,
      label: DIMENSION_LABELS[key],
      tooltip: DIMENSION_TOOLTIPS[key],
      iconKey: DIMENSION_ICONS[key],
      score,
      potential: 20,
      gain: 20 - score,
      zone: dimZone,
      checklist,
      reason,
      recommendations,
      allSet: recommendations.length === 0 && checklist.every(item => item.status === "pass"),
      criticalAlert,
      moduleBreakdown,
    };
  });

  const roadmap: RoadmapEntry[] = dimensions
    .map(d => ({ key: d.key, label: d.label, score: d.score, potential: 20 as const, gain: d.gain, zone: d.zone, severityLabel: SEVERITY_LABEL[d.zone] }))
    .sort((a, b) => a.score - b.score);

  return {
    resolved,
    total,
    potentialTotal: 100,
    gainTotal: 100 - total,
    zone,
    verdict,
    dimensions,
    roadmap,
  };
}
