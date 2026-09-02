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
    return String(m.plural_label ?? m.name ?? m.api_name ?? "");
  }
  return String(mod);
}

// module::trigger-event signature a workflow fires on — same shape
// WorkflowAudit.tsx's "Conflicting Workflows" finding already groups by, kept
// here so the Health Score's Workflow Health checklist can report the same
// count instead of drifting from the audit table. "—" is the not-found
// fallback for both halves, matching workflowModuleLabel's own default.
function workflowTriggerKey(item: unknown): string {
  if (!item || typeof item !== "object") return "—::—";
  const r = item as Record<string, unknown>;
  const executeWhen = r.execute_when as Record<string, unknown> | undefined;
  let trigger: string;
  if (executeWhen?.type) {
    trigger = String(executeWhen.type).replace(/_/g, " ");
  } else {
    const t = r.trigger_on ?? r.trigger ?? r.triggers;
    trigger = !t ? "—" : Array.isArray(t) ? t.join(", ") : String(t);
  }
  return `${workflowModuleLabel(r) || "—"}::${trigger}`;
}

// Active workflows that share the exact same module + trigger event as at
// least one other active workflow — multiple rules racing to fire on the same
// event, in an undefined order, every time a matching record is touched.
// Inactive workflows can't race with anything, so they're excluded up front.
export function overlappingWorkflows(workflows: unknown[]): unknown[] {
  const active = workflows.filter(isActiveWorkflow);
  const triggerCounts = new Map<string, number>();
  active.forEach(w => { const k = workflowTriggerKey(w); if (k !== "—::—") triggerCounts.set(k, (triggerCounts.get(k) ?? 0) + 1); });
  return active.filter(w => { const k = workflowTriggerKey(w); return k !== "—::—" && (triggerCounts.get(k) ?? 0) > 1; });
}

function normalizeConditionList(list: unknown[]): string[] {
  return list.map(c => {
    if (c && typeof c === "object") {
      const co = c as Record<string, unknown>;
      const fieldRaw = co.field;
      const field = fieldRaw && typeof fieldRaw === "object"
        ? String((fieldRaw as Record<string, unknown>).api_name ?? (fieldRaw as Record<string, unknown>).name ?? "")
        : String(co.field_name ?? fieldRaw ?? "");
      const comparator = String(co.comparator ?? co.comparison ?? co.operator ?? "");
      const value = co.value ?? co.values ?? "";
      return `${field}|${comparator}|${JSON.stringify(value)}`;
    }
    return JSON.stringify(c);
  }).sort();
}

// Order-independent "field|comparator|value" list — same normalization
// WorkflowAudit.tsx's getCriteriaConditions uses, kept in sync so both places
// agree on what counts as identical criteria.
function workflowCriteriaSignature(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const r = item as Record<string, unknown>;
  const c = r.criteria ?? r.conditions;
  if (!c) return [];
  if (Array.isArray(c)) return normalizeConditionList(c);
  if (typeof c === "object") {
    const co = c as Record<string, unknown>;
    if (Array.isArray(co.conditions)) return normalizeConditionList(co.conditions);
    if (Array.isArray(co.criteria)) return normalizeConditionList(co.criteria as unknown[]);
  }
  return [];
}

function workflowActionsSignature(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const r = item as Record<string, unknown>;
  const a = r.actions ?? r.action_list ?? r.workflow_actions;
  if (!Array.isArray(a)) return [];
  return a.map(act => {
    if (act && typeof act === "object") {
      const ao = act as Record<string, unknown>;
      const type = String(ao.type ?? ao.action_type ?? ao.name ?? "");
      const detail = ao.details ?? ao.data ?? ao.field_updates ?? ao.parameters ?? "";
      return `${type}|${JSON.stringify(detail)}`;
    }
    return JSON.stringify(act);
  }).sort();
}

// Full functional identity: module + trigger + criteria + actions. Two rules
// with this key equal behave identically regardless of name — name is
// deliberately excluded since a cloned-and-relabeled rule is exactly the case
// this needs to catch, not exempt.
function workflowContentKey(item: unknown): string {
  return JSON.stringify({
    trigger: workflowTriggerKey(item),
    criteria: workflowCriteriaSignature(item),
    actions: workflowActionsSignature(item),
  });
}

// Workflows that are functional duplicates: identical module + trigger +
// criteria + actions. Name is intentionally not part of the signature — two
// rules cloned from one another and left with different labels are still the
// same automation running twice, which is exactly what this should surface.
export function identicalWorkflows(workflows: unknown[]): unknown[] {
  const counts = new Map<string, number>();
  workflows.forEach(w => { const k = workflowContentKey(w); counts.set(k, (counts.get(k) ?? 0) + 1); });
  return workflows.filter(w => (counts.get(workflowContentKey(w)) ?? 0) > 1);
}

// "Consolidate the overlapping/duplicate group into one rule" projected —
// used by businessScore.ts's estimateScoreGain to simulate the real fix
// (merge, don't just disable) rather than guessing a flat point value.
export function withoutOverlappingWorkflows(workflows: unknown[]): unknown[] {
  const seen = new Set<string>();
  return workflows.filter(w => {
    if (!isActiveWorkflow(w)) return true;
    const k = workflowTriggerKey(w);
    if (k === "—::—") return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function withoutIdenticalWorkflows(workflows: unknown[]): unknown[] {
  const seen = new Set<string>();
  return workflows.filter(w => {
    const k = workflowContentKey(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

// The name of the profile a *user* is assigned, as opposed to isAdminProfile
// above (which tests a profile catalog entry itself). Zoho's Users API nests
// this as profile: { id, name } rather than a flat string.
export function userProfileName(user: unknown): string {
  if (!user || typeof user !== "object") return "";
  const r = user as Record<string, unknown>;
  const p = r.profile ?? r.Profile;
  if (!p) return "";
  if (typeof p === "string") return p;
  if (typeof p === "object") return String((p as Record<string, unknown>).name ?? (p as Record<string, unknown>).label ?? "");
  return "";
}

// Counting admin-profile PROFILES (isAdminProfile over the profile catalog)
// answers a different question than counting admin-profile USERS — an org
// can have just one "Administrator" profile definition while assigning it to
// every single user. Team Security cares about the latter: how many people
// actually hold elevated access, regardless of how many profile definitions
// exist.
export function isAdminProfileUser(user: unknown): boolean {
  return /admin/i.test(userProfileName(user));
}

export type UserStatusBucket = "active" | "inactive" | "deleted";

// Three-way classification matching what the Full User List's status badge
// already reads correctly — "deleted" is its own bucket (a removed account
// that doesn't consume a license) and must never collapse into "inactive"
// (a disabled-but-still-licensed seat), since Team Security and the Active
// Users KPI need to treat those two very differently. Anything that isn't
// literally "active" or "deleted" (e.g. "inactive", "disabled",
// "deactivated" — Zoho MCP servers aren't consistent on the exact word)
// defaults to "inactive" rather than silently counting as active.
export function userStatusBucket(item: unknown): UserStatusBucket {
  if (!item || typeof item !== "object") return "active";
  const r = item as Record<string, unknown>;
  const s = String(r.status ?? "").toLowerCase();
  if (s === "deleted") return "deleted";
  if (s === "active") return r.active === false || r.enabled === false ? "inactive" : "active";
  if (s) return "inactive";
  return r.active === false || r.enabled === false ? "inactive" : "active";
}

export function isDeletedUser(item: unknown): boolean {
  return userStatusBucket(item) === "deleted";
}

export function isActiveUser(item: unknown): boolean {
  return userStatusBucket(item) === "active";
}

// Case-insensitive and deleted-aware: Zoho's Users API returns a lowercase
// "active"/"inactive" status string on some servers and "Disabled"/"Deleted"
// on others — an exact-case match against "Inactive" (or one that didn't
// separate "deleted" out) let every real inactive/deleted user fall through
// as active, which fed both the Active Users count and the Team Security
// "no inactive licenses" claim being wrong in exactly opposite directions
// from the truth. Deleted accounts are deliberately excluded here — they
// don't hold a license — see isDeletedUser for that bucket.
export function isInactiveUser(item: unknown): boolean {
  return userStatusBucket(item) === "inactive";
}

export function isCustomModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return r.custom_module === true || r.generic_type === "custom" || r.customModule === true;
}

export function hasEmailAction(workflow: unknown): boolean {
  return JSON.stringify(workflow ?? {}).toLowerCase().includes("email");
}

export function moduleApiName(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const r = m as Record<string, unknown>;
  return String(r.api_name ?? r.module_name ?? "");
}

// A module can still show up in the metadata list for a short window after
// deletion. recycle_bin_on_delete only appears on real, fully-populated
// module records, so its presence is what confirms `status` is trustworthy
// here — only then do we treat "deleted" as a reason to exclude the module.
export function isDeletedModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  if (r.recycle_bin_on_delete === undefined) return false;
  return String(r.status ?? "").toLowerCase() === "deleted";
}

// `status` ("visible" / "user_hidden" / "system_hidden") is Zoho's own
// authoritative visibility concept and takes priority whenever present —
// verified against a live org where 68 modules had status "visible" but
// viewable:false (mostly subform-linked fields) and would have been
// wrongly excluded by treating viewable/show_as_tab as hidden signals.
// Those booleans (plus visibility === 0) are only a fallback for servers
// whose module records don't carry a status string at all.
export function isHiddenModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  const status = String(r.status ?? "").toLowerCase();
  if (status) return ["user_hidden", "system_hidden", "hidden"].includes(status);
  return r.visible === false || r.show_as_tab === false || r.viewable === false || r.visibility === 0;
}

// Narrower than isHiddenModule: only Zoho's own "system_hidden" status, not an
// admin's deliberate "user_hidden" customization. A system-hidden module is
// hidden by Zoho itself (not a real module a business owner ever chose to
// use), so — unlike a merely user-hidden one — it shouldn't count toward "how
// many modules does this org have" any more than an internal pseudo-module
// does. See isInternalModule for the same reasoning applied to a different
// class of not-really-a-module entries.
export function isSystemHiddenModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return String(r.status ?? "").toLowerCase() === "system_hidden";
}

// Zoho auto-generates a standalone "module" entry for every file/image-upload
// field, plus internal bookkeeping entities (Locking_Information__s,
// Functions__s, Scoring_Rules__s, Entity_Scores__s, …) — all sharing an
// api_name ending in "__s". Verified against a live org: these accounted for
// 81 of that org's 323 raw module records, none of which appear anywhere a
// user would recognize as a real module (Zoho's own Setup > Modules list
// doesn't show them either). Subforms and field-tracker entries are the same
// kind of non-independent, embedded structure. None of these should count
// toward "how many modules does this org have."
export function isInternalModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  if (r.generated_type === "subform" || r.generated_type === "field_tracker") return true;
  return /__s$/.test(String(r.api_name ?? ""));
}

function isReadOnlyModule(r: Record<string, unknown>): boolean {
  return r.api_supported === false || (r.creatable === false && r.editable === false);
}

// "Unused" here means api access disabled, or nobody can create/edit records
// in it while it's still technically viewable — same definition ModulesAudit.tsx
// and CRMOverviewDashboard.tsx use, so "Empty" means the same thing everywhere.
export function isEmptyModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return isReadOnlyModule(r) && r.viewable !== false && r.visible !== false;
}

const WORKFLOW_EXEMPT_MODULE_NAMES = new Set(["Products", "Price_Books"]);

// Some modules are reference/catalog data by design — a product catalog or
// price book is maintained by hand or synced from an external system, never
// something a workflow rule (which only fires on record create/edit) would
// touch. Counting these against automation-coverage scoring would penalize
// the mere existence of the module, not a real process gap. Read-only modules
// (api access disabled, or nobody can create/edit records in them) are exempt
// for the same reason regardless of name — there's no create/edit event for a
// workflow to ever fire on.
export function isWorkflowExemptModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  const apiName = String(r.api_name ?? r.module_name ?? "");
  if (WORKFLOW_EXEMPT_MODULE_NAMES.has(apiName)) return true;
  return isReadOnlyModule(r);
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

// Modules with zero references from any workflow or blueprint — the
// heuristic "probably unused" shortlist shared by the empty-modules finding
// and by useModuleRecordCounts.ts (which uses it to bound how many
// getRecordCount calls it makes to a handful, not one per module in the org).
export function unreferencedModules(modules: unknown[], workflows: unknown[], blueprints: unknown[]): Record<string, unknown>[] {
  return modules.filter(m => {
    const apiName = moduleApiName(m);
    if (!apiName) return false;
    const referenced = workflows.some(w => workflowReferencesModule(w, apiName));
    const hasBlueprint = blueprintsForModule(blueprints, apiName).length > 0;
    return !referenced && !hasBlueprint;
  }) as Record<string, unknown>[];
}

// ─── Deal-quality predicates ────────────────────────────────────────────────
// Zoho's "Stage" field names vary by org (custom pipelines rename stages
// freely), so "closed" is matched by keyword rather than an exact stage
// list — every org's closed-won/closed-lost stage name contains "closed".
function dealStage(deal: unknown): string {
  if (!deal || typeof deal !== "object") return "";
  const r = deal as Record<string, unknown>;
  const stage = r.Stage ?? r.stage;
  if (typeof stage === "string") return stage;
  if (stage && typeof stage === "object") return String((stage as Record<string, unknown>).name ?? "");
  return "";
}

export function isOpenDeal(deal: unknown): boolean {
  return !/closed/i.test(dealStage(deal));
}

function dealModifiedTime(deal: unknown): Date | null {
  if (!deal || typeof deal !== "object") return null;
  const r = deal as Record<string, unknown>;
  const raw = r.Modified_Time ?? r.modified_time ?? r.Modified_Time__s;
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dealAgeDays(deal: unknown): number | null {
  const modified = dealModifiedTime(deal);
  if (!modified) return null;
  return Math.floor((Date.now() - modified.getTime()) / (1000 * 60 * 60 * 24));
}

export function isDealStale(deal: unknown, days = 30): boolean {
  if (!isOpenDeal(deal)) return false;
  const age = dealAgeDays(deal);
  return age !== null && age > days;
}

export function dealAmount(deal: unknown): number | null {
  if (!deal || typeof deal !== "object") return null;
  const r = deal as Record<string, unknown>;
  const raw = r.Amount ?? r.amount;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return null;
}

// Every Deal record Zoho returns carries its own "$currency_symbol" system
// field (e.g. "$", "₹") — reading it straight off the record is more
// reliable than a separate org-details call, which depends on a tool
// (getOrganizations) this MCP connection may not have authorized at all.
export function dealCurrencySymbol(deal: unknown): string | null {
  if (!deal || typeof deal !== "object") return null;
  const r = deal as Record<string, unknown>;
  const raw = r.$currency_symbol ?? r.currency_symbol;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function isDealUnforecastable(deal: unknown): boolean {
  if (!isOpenDeal(deal)) return false;
  if (!deal || typeof deal !== "object") return false;
  const r = deal as Record<string, unknown>;
  const closingDate = r.Closing_Date ?? r.closing_date;
  const noAmount = dealAmount(deal) === null;
  const noCloseDate = !(typeof closingDate === "string" && closingDate.trim() !== "");
  return noAmount || noCloseDate;
}

// ─── Lead-quality predicates ────────────────────────────────────────────────
export function hasNoLeadSource(lead: unknown): boolean {
  if (!lead || typeof lead !== "object") return false;
  const r = lead as Record<string, unknown>;
  const source = r.Lead_Source ?? r.lead_source;
  if (source === undefined || source === null) return true;
  if (typeof source === "string") return source.trim() === "";
  return false;
}

// ─── User activity ──────────────────────────────────────────────────────────
// Zoho's Users API field for this varies by version/server — checked
// defensively across the plausible names, same style as workflowLastTriggered
// above. Returns null (not "0 days") when no such field is present at all, so
// callers can tell "confirmed recent" apart from "we can't tell" and skip the
// finding entirely rather than guess (see userLoginFieldPresent below).
// Raw last-activity Date, shared by userLoginAgeDays (the day-count used for
// the >90-day threshold check) and any caller that needs to show the actual
// date to the user (e.g. "no login since 12 Mar 2026") rather than just an
// age in days.
export function userLastLoginDate(user: unknown): Date | null {
  if (!user || typeof user !== "object") return null;
  const r = user as Record<string, unknown>;
  const raw = r.last_activity_time ?? r.lastActivityTime ?? r.last_login_time ?? r.lastLoginTime ?? r.Last_Activity_Time;
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function userLoginAgeDays(user: unknown): number | null {
  const d = userLastLoginDate(user);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

// True only when at least one sampled user actually carries a readable
// last-activity field — distinguishes "checked, and everyone's recent" from
// "this MCP server/org doesn't expose login activity at all", so the
// stale-logins finding can honestly not fire in the latter case instead of
// silently reporting zero stale users.
export function userLoginFieldPresent(users: unknown[]): boolean {
  return users.some(u => userLoginAgeDays(u) !== null);
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
