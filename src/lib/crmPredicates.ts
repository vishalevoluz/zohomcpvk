// Shared boolean predicates over raw MCP item shapes, used by the Business View
// scoring/diagnosis/action-ranking modules (and safe to reuse anywhere else that
// needs the same heuristics instead of redefining them).

export function isActiveWorkflow(item: unknown): boolean {
  if (!item || typeof item !== "object") return true;
  const r = item as Record<string, unknown>;
  // Zoho's workflow rules API nests it as status: { active: boolean } rather than
  // a flat string/boolean — check that shape first, then fall back to the flatter
  // shapes other MCP servers/entities may use.
  if (r.status && typeof r.status === "object") {
    const active = (r.status as Record<string, unknown>).active;
    if (typeof active === "boolean") return active;
  }
  if (r.active === false || r.enabled === false) return false;
  // Case-insensitive: a flat status of "inactive"/"disabled"/"false" in any
  // casing (e.g. "Inactive", "INACTIVE") must be caught here — an exact-case
  // match previously let a lowercase "inactive" status fall through to the
  // default-active return below, showing a genuinely off workflow as live.
  const s = String(r.status ?? "").toLowerCase();
  return !(s === "inactive" || s === "disabled" || s === "false");
}

// Field name matches WorkflowAudit.tsx's ZohoWorkflow.last_executed_time, plus
// a couple of casing/naming variants other MCP server versions may use.
export function workflowLastTriggered(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const raw = r.last_executed_time ?? r.lastExecutedTime ?? r.last_trigger_time ?? r.lastTriggerTime;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

// Same module-reference shapes as workflowModuleRef below, exposed for display
// (rather than the boolean workflowReferencesModule check). Despite the name,
// this reads the same generic `module` shape used by blueprints and layouts
// too, so it's reused for those rather than duplicating the same field-name
// fallback chain per entity type.
export function workflowModuleLabel(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const r = item as Record<string, unknown>;
  const mod = r.module ?? r.module_name ?? r.se_module ?? r.entity;
  if (!mod) return "";
  if (typeof mod === "string") return mod;
  if (typeof mod === "object") {
    const m = mod as Record<string, unknown>;
    return String(m.api_name ?? m.plural_label ?? m.name ?? "");
  }
  return String(mod);
}

export type BlueprintStatus = "active" | "inactive" | "draft";

// Blueprint status is its own flat "Active" | "Inactive" | "Draft" string (or
// a boolean `active`), not the nested { active: boolean } shape workflows use
// — and unlike isActiveWorkflow, "Draft" must NOT collapse into "active" by
// default: an unpublished blueprint enforces nothing yet, so treating it as
// active would overstate real process coverage (see the flow map's Deals
// blueprint node in flowMapModel.ts, which has the same exact-status check).
export function blueprintStatus(item: unknown): BlueprintStatus {
  if (!item || typeof item !== "object") return "inactive";
  const r = item as Record<string, unknown>;
  if (r.active === true) return "active";
  if (r.active === false) return "inactive";
  const s = String(r.status ?? "").toLowerCase();
  if (s === "draft") return "draft";
  if (s === "inactive" || s === "disabled" || s === "false") return "inactive";
  return "active";
}

// Mirrors the generated_type-based standard/custom split ModulesAudit.tsx
// uses for modules — Zoho layouts carry the same generated_type metadata
// field when present. Falls back to name matching since not every MCP server
// version returns generated_type for layouts: the org's original layout is
// conventionally named "Standard" and every other layout was hand-created.
export function isCustomLayout(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  if (r.generated_type === "custom") return true;
  if (r.generated_type === "system" || r.generated_type === "default") return false;
  const name = String(r.name ?? r.layout_name ?? "").trim().toLowerCase();
  return name !== "" && name !== "standard";
}

export function isAdminProfile(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return /admin/i.test(String(r.name ?? r.label ?? ""));
}

export function isInactiveUser(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return r.status === "Inactive" || r.active === false || r.enabled === false;
}

export function isCustomModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return r.custom_module === true || r.generic_type === "custom" || r.customModule === true;
}

export function isMandatoryField(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return r.required === true || r.mandatory === true || r.system_mandatory === true;
}

export function hasEmailAction(workflow: unknown): boolean {
  return JSON.stringify(workflow ?? {}).toLowerCase().includes("email");
}

export function moduleApiName(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const r = m as Record<string, unknown>;
  return String(r.api_name ?? r.module_name ?? "");
}

function workflowModuleRef(workflow: unknown): string {
  if (!workflow || typeof workflow !== "object") return "";
  const r = workflow as Record<string, unknown>;
  const raw = r.module ?? r.module_name ?? r.se_module ?? r.entity;
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const m = raw as Record<string, unknown>;
    return String(m.api_name ?? m.name ?? m.plural_label ?? "");
  }
  return String(raw);
}

export function workflowReferencesModule(workflow: unknown, apiName: string): boolean {
  if (!apiName) return false;
  const ref = workflowModuleRef(workflow);
  if (ref && ref.toLowerCase() === apiName.toLowerCase()) return true;
  // Fallback for payload shapes where the module reference isn't under a known key
  return JSON.stringify(workflow ?? {}).toLowerCase().includes(apiName.toLowerCase());
}

// Blueprint list items carry the same shape of module reference as workflows
// (a "module" key, string or {api_name}) — reuse the same matching logic.
export function blueprintsForModule(blueprints: unknown[], apiName: string): unknown[] {
  return blueprints.filter(bp => workflowReferencesModule(bp, apiName));
}

// Per-module rule counts for the automation types that require a `module`
// query param per call (assignment/approval/validation/layout rules), plus a
// flat org-level count for schedules — fetched separately from entityData by
// useRuleCoverage.ts since they can't ride along with the flat entity fetches.
// Lives here (rather than in businessScore.ts) so both businessScore.ts and
// flowMapModel.ts can share the same "what counts as automation" definition
// without importing from each other.
export interface RuleCoverage {
  validation: Record<string, number>;
  layout: Record<string, number>;
  assignment: Record<string, number>;
  approval: Record<string, number>;
  scheduleCount: number | null;
}

// The per-module rule-coverage buckets that count as "this module has
// automation" — schedules are excluded since they're an org-level concept,
// not tied to a specific module.
export const PER_MODULE_COVERAGE_KEYS: (keyof Pick<RuleCoverage, "validation" | "layout" | "assignment" | "approval">)[] =
  ["validation", "layout", "assignment", "approval"];

// Total assignment/approval/validation/layout rules configured for a module —
// the same broadened "has automation" signal used by the CRM Health Score's
// Automation Coverage dimension, so the flow map's per-module Automation nodes
// agree with it instead of only counting workflows.
export function ruleCoverageCount(ruleCoverage: RuleCoverage | null, apiName: string): number {
  if (!ruleCoverage) return 0;
  return PER_MODULE_COVERAGE_KEYS.reduce((sum, key) => sum + (ruleCoverage[key][apiName] ?? 0), 0);
}

// Per-type breakdown (validation/layout/assignment/approval counts) for one
// module — lets callers show exactly which rule types were found instead of
// just a combined total, e.g. the flow map's Automation node tooltip.
export function ruleCoverageBreakdown(ruleCoverage: RuleCoverage | null, apiName: string): Record<typeof PER_MODULE_COVERAGE_KEYS[number], number> {
  return {
    validation: ruleCoverage?.validation[apiName] ?? 0,
    layout: ruleCoverage?.layout[apiName] ?? 0,
    assignment: ruleCoverage?.assignment[apiName] ?? 0,
    approval: ruleCoverage?.approval[apiName] ?? 0,
  };
}

// The field a blueprint transitions records through (e.g. "Stage" for Deals,
// "Status" for Tasks) — used to read each sampled record's current blueprint
// state without a per-record blueprint API call.
export function findBlueprintFieldApiName(blueprints: unknown[], apiName: string): string | null {
  for (const bp of blueprintsForModule(blueprints, apiName)) {
    const field = (bp as Record<string, unknown> | null)?.field as Record<string, unknown> | undefined;
    const fieldApiName = field?.api_name;
    if (typeof fieldApiName === "string" && fieldApiName) return fieldApiName;
  }
  return null;
}
