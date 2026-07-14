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
  if (r.status === "Inactive" || r.active === false || r.enabled === false) return false;
  return true;
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
