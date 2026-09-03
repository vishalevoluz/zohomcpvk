import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved, getItemName } from "@/lib/useCrmEntities";
import { isActiveWorkflow, moduleApiName, workflowReferencesModule, workflowLastTriggered, blueprintsForModule, findBlueprintFieldApiName, ruleCoverageCount, ruleCoverageBreakdown, isWorkflowExemptModule } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { Section } from "@/lib/sections";

export type FlowLane = "entry" | "qualification" | "automation" | "outcome";
export type NodeStatus = "live" | "configured-untested" | "configured-issues" | "gap" | "empty" | "loading";
export type EdgeKind = "automated" | "manual" | "broken" | "unknown" | "loading";

// Structured, non-technical explanation shown in the side panel - see
// BusinessView.tsx's node/edge detail panel. Every field here is meant to be
// read by a business owner with zero Zoho knowledge; `technical` is the one
// exception, rendered collapsed by default for consultants who want it.
export interface NodeExplanation {
  /** One plain sentence describing what this stage IS in business terms - never the API name. */
  whatIsThis: string;
  /** One plain sentence matching the node's color, e.g. "Live and working." */
  statusSentence: string;
  /** The receipt - translated signals with real numbers and named sources. */
  howWeKnow: string[];
  /** Sample size + confirmed-vs-inferred framing, or an honest "couldn't check" note. */
  honesty: string;
  /** API names, generated_type, workflow IDs - hidden by default. */
  technical: string[];
}

export interface EdgeExplanation {
  /** What hand-off this connection represents, in business terms. */
  whatIsThis: string;
  statusSentence: string;
  howWeKnow: string[];
  /** Only present for broken connections - the one-sentence business consequence. */
  consequence?: string;
  honesty: string;
  technical: string[];
}

export interface FlowNode {
  id: string;
  lane: FlowLane;
  col: number;
  label: string;
  status: NodeStatus;
  recordCount?: number;
  explanation: NodeExplanation;
  targetSection?: Section;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  explanation: EdgeExplanation;
}

export interface FlowMapModel {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface StageDef {
  id: string;
  lane: "entry" | "qualification" | "outcome";
  col: number;
  label: string;
  matchers: RegExp[];
  targetSection?: Section;
  /** whether this stage participates in the Automation lane companion node */
  wantsAutomation?: boolean;
}

// Stage ids that can be corroborated with a small sample of real records
// (see useCrmRecordSamples.ts). Exported so that hook can find the matching
// module for each without duplicating the regexes below.
export const RECORD_SAMPLE_STAGE_IDS = ["leads", "contacts", "deals", "accounts", "invoices"] as const;
export type RecordSampleStageId = (typeof RECORD_SAMPLE_STAGE_IDS)[number];

// The per_page cap useCrmRecordSamples.ts requests (a single, unpaginated
// call) - re-exported here so businessFindings.ts can tell "this sample IS
// the full population" (fewer records came back than were asked for) apart
// from "this is a genuine partial sample" (the cap was hit) without importing
// a "use client" hook module into a plain data/scoring lib.
export const RECORDS_SAMPLE_SIZE = 50;

export interface RecordSampleState {
  items: unknown[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
  /** The MCP tool name actually used for this sample, or null if no matching
   * tool was ever found on this server. Lets callers structurally tell "we
   * never had a way to check this" apart from "we tried and the call
   * failed" - both look like `error !== null` otherwise, and only one of
   * them should ever be described to a user as an honest "unknown". */
  toolUsed: string | null;
}

// A real Deals pipeline stage (see usePipelineStages.ts), sourced from
// getLayouts + getPipelines rather than a generic "stages" entity - this MCP
// server exposes no dedicated stages-listing tool.
export interface PipelineStage {
  name: string;
  apiName: string;
  sequence: number;
  forecastType?: string;
  // True when this stage sits after a Closed Won/Lost stage in sequence order
  // - deals shouldn't have anywhere to go once a pipeline reaches a closed
  // stage, so a stage past that point signals a misconfigured pipeline.
  outOfOrder?: boolean;
}

// A single pipeline with its own full, sequence-ordered stage list - for
// orgs running more than one Deals pipeline (e.g. separate "Standard" and
// "Enterprise" processes), each has its own stage set, distinct from
// PipelineStagesState.items which only ever holds the picked/default
// pipeline's stages (see that field's own comment).
export interface PipelineWithStages {
  id: string;
  name: string;
  isDefault: boolean;
  stages: PipelineStage[];
}

export interface PipelineStagesState {
  items: PipelineStage[];
  // The real count of pipeline configs found via the getLayouts -> getPipelines
  // chain for the Deals layout - distinct from `items.length` (the STAGE count
  // of just the one picked/default pipeline). A generic zero-param getPipelines
  // call elsewhere (entityData.pipelines) can undercount when an org has more
  // than one pipeline on the same layout, since it has no layout_id to scope
  // by and Zoho pipelines only ever exist on the Deals module anyway - this is
  // the authoritative number for "how many pipelines does this org have."
  pipelineCount: number;
  // Every pipeline found (not just the picked/default one), each with its own
  // stages - for display surfaces that need to show the whole org's pipeline
  // setup rather than the single "the sales process" used for scoring.
  pipelines: PipelineWithStages[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

const STAGE_DEFINITIONS: StageDef[] = [
  { id: "leads",     lane: "entry",         col: 0, label: "Leads",     matchers: [/lead/i],               targetSection: "modules", wantsAutomation: true },
  { id: "campaigns", lane: "entry",         col: 1, label: "Campaigns", matchers: [/campaign/i],            targetSection: "modules" },
  { id: "contacts",  lane: "qualification", col: 0, label: "Contacts",  matchers: [/contact/i],             targetSection: "modules", wantsAutomation: true },
  { id: "deals",     lane: "qualification", col: 1, label: "Deals",     matchers: [/deal|opportunit/i],      targetSection: "modules", wantsAutomation: true },
  { id: "accounts",  lane: "outcome",       col: 0, label: "Accounts",  matchers: [/account/i],             targetSection: "modules", wantsAutomation: true },
  { id: "invoices",  lane: "outcome",       col: 1, label: "Invoices",  matchers: [/invoice/i],             targetSection: "modules" },
];

// Plain-English "what is this" copy, written for a business owner who has
// never touched Zoho - never the API name. Shown as the first line of every
// node's explanation panel, regardless of status.
const STAGE_WHAT_IS_THIS: Record<string, string> = {
  leads: "Leads are people who've shown interest but aren't customers yet.",
  campaigns: "Campaigns are the marketing pushes - emails, ads, events - that bring leads in.",
  contacts: "Contacts are people you're actively engaging with, one step past a cold lead.",
  deals: "Deals are specific sales opportunities you're trying to close, tied to a contact or account.",
  accounts: "Accounts are the companies or organizations you do business with.",
  invoices: "Invoices are the bills you send once a deal is won.",
};

const AUTOMATION_NODE_WHAT_IS_THIS = "This shows whether any automation - a workflow, approval process, or rule - runs for this stage without a person doing it by hand.";
const PIPELINE_STAGE_WHAT_IS_THIS = "This is one step in your deal pipeline - deals sit here while your team works them at this stage.";
const BLUEPRINT_WHAT_IS_THIS = "A Blueprint is a structured, enforced process that controls how a deal is allowed to move forward - reps can't skip a step it requires.";

const JOURNEY_EDGE_WHAT_IS_THIS: Record<string, string> = {
  "leads-contacts": "When a lead is ready, it should convert into a Contact - someone you're now actively working with.",
  "campaigns-contacts": "A successful campaign should bring in new Contacts.",
  "contacts-deals": "An engaged Contact should turn into a Deal - a real sales opportunity you're chasing.",
  "deals-accounts": "A won Deal should be tied to an Account - the company you're now doing business with.",
  "deals-invoices": "A won Deal should generate an Invoice, so you actually get paid for it.",
};

// Matchers for the stages a record sample can be taken for, keyed by stage id -
// reused by useCrmRecordSamples.ts to resolve each stage to its real module.
export const RECORD_SAMPLE_STAGE_MATCHERS: Record<RecordSampleStageId, RegExp[]> =
  Object.fromEntries(
    STAGE_DEFINITIONS
      .filter(s => (RECORD_SAMPLE_STAGE_IDS as readonly string[]).includes(s.id))
      .map(s => [s.id, s.matchers])
  ) as Record<RecordSampleStageId, RegExp[]>;

// Journey edges describing how a lead moves through the business end-to-end.
// `kind` is derived from real sampled records where possible (see evaluateRecordLink /
// evaluateLeadConversion below), falling back to the source stage's automation status
// only when no record sample is available for that edge.
const JOURNEY_EDGES: { from: string; to: string }[] = [
  { from: "leads", to: "contacts" },
  { from: "campaigns", to: "contacts" },
  { from: "contacts", to: "deals" },
  { from: "deals", to: "accounts" },
  { from: "deals", to: "invoices" },
];

function findModuleForStage(modules: unknown[], stage: StageDef): Record<string, unknown> | undefined {
  return modules.find(m => {
    const name = moduleApiName(m);
    return name && stage.matchers.some(re => re.test(name));
  }) as Record<string, unknown> | undefined;
}

// Resolves the Deals module's real api_name so usePipelineStages.ts can fetch its
// layout/pipeline chain - reuses the same "deals" StageDef matcher the flow map
// itself uses, so this always agrees with whichever node the pills attach to.
export function findDealsApiName(entityData: Record<CrmEntityType, EntityState>): string | null {
  if (!isEntityResolved(entityData.modules)) return null;
  const dealsStage = STAGE_DEFINITIONS.find(s => s.id === "deals");
  if (!dealsStage) return null;
  const mod = findModuleForStage(entityData.modules.items, dealsStage);
  return mod ? moduleApiName(mod) : null;
}

// The modules the flow map's own "automation layer" checks (Leads, Contacts,
// Deals, Accounts - see STAGE_DEFINITIONS' wantsAutomation flag). Reused by
// businessScore.ts so the dashboard's Automation Coverage dimension measures
// coverage of the same lead-to-deal lifecycle modules the flow map already
// visualizes, instead of every module the org happens to have (which for orgs
// with hundreds of custom/junction modules makes a whole-catalog percentage
// meaningless - 2 real automations out of 300+ modules always rounds to 0).
// isWorkflowExemptModule is an extra safety net, not the primary guard here -
// none of these 4 stages should ever resolve to a reference/read-only module,
// but if one ever did (e.g. a misconfigured or renamed module), it shouldn't
// silently count against the score for lacking a workflow it structurally
// can't have (no create/edit event exists for a read-only module to fire on).
export function automationCoverageApiNames(modules: unknown[]): string[] {
  return STAGE_DEFINITIONS
    .filter(s => s.wantsAutomation)
    .map(stage => {
      const mod = findModuleForStage(modules, stage);
      if (!mod || isWorkflowExemptModule(mod)) return null;
      return moduleApiName(mod);
    })
    .filter((name): name is string => !!name);
}

function moduleLabel(m: Record<string, unknown>): string {
  return String(m.plural_label ?? m.singular_label ?? m.module_name ?? m.api_name ?? "");
}

interface AutomationInfo {
  status: NodeStatus;   // "live" | "configured-issues" | "gap"
  activeCount: number;
  inactiveCount: number;
  ruleCount: number;
  rules: { validation: number; layout: number; assignment: number; approval: number };
  /** At least one active workflow has really fired (last_executed_time set),
   * or a rule (which enforces on every save, with no separate "hasn't run
   * yet" state) is present - the real-world signal that distinguishes green
   * "live and working" from blue "configured but not tested" per spec 4.2.2. */
  confirmedExecuted: boolean;
  /** True when ruleCoverage itself was never resolved (null) - a genuinely
   * unknown rule count, not a confirmed zero. Lets callers avoid claiming
   * "no rules" when the truth is "we couldn't check". */
  ruleCoverageUnknown: boolean;
}

// "Automated" matches the CRM Health Score's Automation Coverage dimension
// (see scoreAutomationCoverage in businessScore.ts): a module counts as
// automated if it has an active workflow OR any assignment/approval/
// validation/layout rule, not just workflows - a module fully covered by a
// validation rule + assignment rule but no workflow shouldn't read as a gap
// on the flow map just because workflows used to be the only signal checked.
function computeAutomation(apiName: string, workflows: unknown[], ruleCoverage: RuleCoverage | null): AutomationInfo {
  const referencing = workflows.filter(w => workflowReferencesModule(w, apiName));
  const active = referencing.filter(isActiveWorkflow);
  const inactive = referencing.length - active.length;
  const rules = ruleCoverageBreakdown(ruleCoverage, apiName);
  const ruleCount = ruleCoverageCount(ruleCoverage, apiName);
  const ruleCoverageUnknown = ruleCoverage === null;
  // Rules enforce on every save the moment they exist - there's no "hasn't
  // fired yet" state for them the way a workflow can sit configured but
  // never trigger, so any real rule counts as confirmed automation on its own.
  const confirmedExecuted = active.some(w => workflowLastTriggered(w) !== null) || ruleCount > 0;
  if (active.length > 0 || ruleCount > 0) return { status: "live", activeCount: active.length, inactiveCount: inactive, ruleCount, rules, confirmedExecuted, ruleCoverageUnknown };
  if (inactive > 0) return { status: "configured-issues", activeCount: 0, inactiveCount: inactive, ruleCount: 0, rules, confirmedExecuted: false, ruleCoverageUnknown };
  return { status: "gap", activeCount: 0, inactiveCount: 0, ruleCount: 0, rules, confirmedExecuted: false, ruleCoverageUnknown };
}

// Combines module presence + automation health + (for automation-tracked
// stages) confirmed record evidence into ONE of the 5 spec-defined colors -
// replaces the old live/gap binary. See the plan doc for the full decision
// table; the short version: gray only fires on a *confirmed* zero (never on
// "we don't know"), since claiming "empty" without evidence would violate
// the "never state a conclusion the data doesn't support" rule.
function decideStageStatus(
  wantsAutomation: boolean,
  automation: AutomationInfo | undefined,
  recordCount: number | undefined,
): NodeStatus {
  if (!wantsAutomation) {
    // Accounts / Invoices: no automation tracked for these (see
    // automationCoverageApiNames' comment on lead-to-deal lifecycle scoping),
    // so color comes from module + record evidence only.
    if (recordCount === undefined) return "configured-untested"; // module confirmed, usage not yet checkable
    return recordCount > 0 ? "live" : "empty";
  }
  if (!automation) return "configured-untested"; // workflows haven't resolved yet - can't confirm health either way
  if (automation.status === "gap") return recordCount === 0 ? "empty" : "gap";
  if (automation.status === "configured-issues") return "configured-issues";
  return automation.confirmedExecuted ? "live" : "configured-untested";
}

function statusSentence(status: NodeStatus): string {
  switch (status) {
    case "live": return "Live and working.";
    case "configured-untested": return "Set up, but we can't yet confirm it's actually being used.";
    case "configured-issues": return "Working, but with some issues that need attention.";
    case "gap": return "This is a gap - nothing automated is happening here.";
    case "empty": return "Empty and unused - nothing is configured or flowing through it.";
    default: return "Still checking your CRM…";
  }
}

function edgeStatusSentence(kind: EdgeKind): string {
  switch (kind) {
    case "automated": return "Automated - this happens by itself.";
    case "manual": return "Manual - someone has to do this by hand.";
    case "broken": return "Broken - this connection doesn't exist.";
    case "unknown": return "Unknown - we couldn't check this.";
    default: return "Still checking…";
  }
}

function edgeKindForStatus(status: NodeStatus): EdgeKind {
  if (status === "loading") return "loading";
  if (status === "live" || status === "configured-untested") return "automated";
  if (status === "configured-issues") return "automated";
  if (status === "gap") return "broken";
  return "manual"; // "empty"
}

// ─── Real-record corroboration for journey edges ───────────────────────────────
// A small sample (see useCrmRecordSamples.ts) of actual Lead/Contact/Deal/Account/
// Invoice records lets us check whether records really move along an edge instead
// of just assuming the generic funnel shape.

function recordId(r: unknown): string | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  const id = o.id ?? o.Id;
  return id === undefined || id === null ? undefined : String(id);
}

function idSet(records: unknown[]): Set<string> {
  const s = new Set<string>();
  for (const r of records) {
    const id = recordId(r);
    if (id) s.add(id);
  }
  return s;
}

// Any object-valued field that itself carries an `id` is treated as a lookup -
// this matches Zoho's { id, name } lookup field shape without hardcoding field names.
function lookupIds(record: unknown): Set<string> {
  const ids = new Set<string>();
  if (!record || typeof record !== "object") return ids;
  for (const v of Object.values(record as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const id = recordId(v);
      if (id) ids.add(id);
    }
  }
  return ids;
}

interface LinkEvidence {
  kind: EdgeKind;
  howWeKnow: string[];
  honesty: string;
  consequence?: string;
}

const CANT_CHECK_TOOL_MISSING = "This CRM connection doesn't expose a way for us to sample real records here, so we genuinely can't confirm this either way - not a gap, just unknown.";
const CANT_CHECK_TOOL_FAILED = "We tried to pull a real record sample here but the attempt failed - this isn't a confirmed gap, just unknown.";

// Direction-agnostic: some relationships are held by the upstream record's lookup
// (Deal → Account_Name) and some by the downstream record's lookup (Deal → Contact_Name),
// so this checks both sides rather than assuming which module owns the field.
function evaluateRecordLink(
  fromRecords: unknown[] | null,
  toRecords: unknown[] | null,
  fromLabel: string,
  toLabel: string,
  resolved: boolean,
  checkable: boolean,
): LinkEvidence {
  if (!resolved) return { kind: "loading", howWeKnow: ["Checking a sample of real records…"], honesty: "" };
  if (!fromRecords || !toRecords) {
    const missing = !fromRecords ? fromLabel : toLabel;
    return {
      kind: "unknown",
      howWeKnow: [`We couldn't pull a sample of real ${missing.toLowerCase()} records to check this connection.`],
      honesty: checkable ? CANT_CHECK_TOOL_FAILED : CANT_CHECK_TOOL_MISSING,
    };
  }
  if (toRecords.length === 0) {
    return {
      kind: "broken",
      howWeKnow: [`We sampled ${toLabel.toLowerCase()} and found none.`],
      honesty: `Based on a sample of ${fromRecords.length} ${fromLabel.toLowerCase()} records - treat this as indicative, not exhaustive.`,
      consequence: `${fromLabel} exist but nothing is arriving in ${toLabel} - that step of your process isn't happening.`,
    };
  }
  const fromIds = idSet(fromRecords);
  const toIds = idSet(toRecords);
  const linkedTo = toRecords.filter(r => [...lookupIds(r)].some(id => fromIds.has(id))).length;
  const linkedFrom = fromRecords.filter(r => [...lookupIds(r)].some(id => toIds.has(id))).length;
  const linked = Math.max(linkedTo, linkedFrom);
  const base = linkedTo >= linkedFrom ? toRecords.length : fromRecords.length;
  if (linked === 0) {
    return {
      kind: "broken",
      howWeKnow: [`None of the ${base} sampled ${toLabel.toLowerCase()} link back to a sampled ${fromLabel.toLowerCase()} record.`],
      honesty: `Based on a sample of ${base} records - treat this as indicative, not exhaustive.`,
      consequence: `${fromLabel} and ${toLabel} both exist, but nothing connects them, so records don't flow from one to the other automatically.`,
    };
  }
  return {
    kind: "automated",
    howWeKnow: [`${linked} of ${base} sampled records show a real ${fromLabel.toLowerCase()} → ${toLabel.toLowerCase()} link.`],
    honesty: `Based on a sample of ${base} records - treat this as indicative, not exhaustive.`,
  };
}

// Field names for "this lead converted" vary a lot by org/API version - classic
// (Converted, Converted_Contact_Id) vs newer system fields (Converted__s,
// Record_Status__s, Converted_Date_Time) - so match on shape/prefix rather than
// one fixed name.
function isLeadConverted(o: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(o)) {
    if (!/^converted/i.test(key)) continue;
    if (value === true) return true;
    if (value && typeof value === "object") return true; // lookup-shaped, e.g. Converted_Contact_Id
    if (typeof value === "string" && value.trim() !== "" && value.toLowerCase() !== "false") return true;
  }
  const recordStatus = o.Record_Status__s ?? o.record_status__s;
  return typeof recordStatus === "string" && /convert/i.test(recordStatus);
}

function evaluateLeadConversion(leadRecords: unknown[] | null, resolved: boolean, checkable: boolean): LinkEvidence {
  if (!resolved) return { kind: "loading", howWeKnow: ["Checking a sample of real leads…"], honesty: "" };
  if (!leadRecords) {
    return {
      kind: "unknown",
      howWeKnow: ["We couldn't pull a sample of real lead records to check this connection."],
      honesty: checkable ? CANT_CHECK_TOOL_FAILED : CANT_CHECK_TOOL_MISSING,
    };
  }
  if (leadRecords.length === 0) {
    return {
      kind: "broken",
      howWeKnow: ["No lead records were found in the sample."],
      honesty: "Based on an empty sample of leads.",
      consequence: "There's nothing to convert - leads aren't reaching this stage at all.",
    };
  }
  const converted = leadRecords.filter(r => r && typeof r === "object" && isLeadConverted(r as Record<string, unknown>)).length;
  if (converted === 0) {
    return {
      kind: "broken",
      howWeKnow: [`None of the last ${leadRecords.length} leads sampled have converted to a contact.`],
      honesty: `Based on a sample of ${leadRecords.length} leads - treat this as indicative, not exhaustive.`,
      consequence: "Leads are coming in but aren't turning into Contacts - that hand-off isn't happening.",
    };
  }
  return {
    kind: "automated",
    howWeKnow: [`${converted} of ${leadRecords.length} sampled leads have converted to a contact.`],
    honesty: `Based on a sample of ${leadRecords.length} leads - treat this as indicative, not exhaustive.`,
  };
}

// Which of the record's own fields are lookup-shaped (Zoho's { id, name } shape)
// and how often each is actually populated across the sample - surfaces real
// relationships instead of just "some lookup exists somewhere".
function lookupFieldFillRates(records: unknown[]): { field: string; filled: number }[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    for (const [key, value] of Object.entries(r as Record<string, unknown>)) {
      if (/^id$/i.test(key)) continue;
      if (value && typeof value === "object" && !Array.isArray(value) && recordId(value)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([field, filled]) => ({ field, filled }))
    .sort((a, b) => b.filled - a.filled);
}

function activeWorkflowNames(apiName: string, workflows: unknown[]): string[] {
  return workflows
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => workflowReferencesModule(w, apiName) && isActiveWorkflow(w))
    .map(({ w, i }) => getItemName(w, i))
    .filter(Boolean);
}

// Module-level blueprint presence plus, when the sample includes the blueprint's
// driving field (see findBlueprintFieldApiName), an actual count of sampled
// records per blueprint state - real evidence instead of just "a blueprint exists".
function blueprintEvidence(apiName: string, blueprints: unknown[], records: unknown[] | null): string[] {
  const matches = blueprintsForModule(blueprints, apiName);
  if (matches.length === 0) return [];

  const names = matches.map((bp, i) => getItemName(bp, i)).filter(Boolean);
  const lines = [`${matches.length} blueprint${matches.length !== 1 ? "s" : ""} configured: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3} more` : ""}.`];

  const fieldApiName = findBlueprintFieldApiName(blueprints, apiName);
  if (fieldApiName && records && records.length > 0) {
    const counts = new Map<string, number>();
    for (const r of records) {
      const v = (r as Record<string, unknown> | null)?.[fieldApiName];
      if (v === undefined || v === null || v === "") continue;
      const label = v && typeof v === "object" ? String((v as Record<string, unknown>).name ?? "") : String(v);
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} (${n})`);
      lines.push(`Sampled records by blueprint stage: ${parts.join(", ")}.`);
    }
  }
  return lines;
}

function loadingNodeExplanation(): NodeExplanation {
  return {
    whatIsThis: "",
    statusSentence: "Still checking your CRM…",
    howWeKnow: [],
    honesty: "",
    technical: [],
  };
}

export function buildFlowMap(
  entityData: Record<CrmEntityType, EntityState>,
  recordSamples?: Partial<Record<RecordSampleStageId, RecordSampleState>>,
  pipelineStages?: PipelineStagesState,
  ruleCoverage?: RuleCoverage | null,
): FlowMapModel {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const modulesResolved = isEntityResolved(entityData.modules);
  const workflowsResolved = isEntityResolved(entityData.workflows);
  const blueprintsResolved = isEntityResolved(entityData.blueprints);

  // unavailable = true means no real-record evidence will ever arrive for this stage
  // (feature not wired, or the getRecords tool isn't on this MCP server) - callers
  // should fall back to the old module/automation heuristic rather than wait forever.
  // checkable = true means a real tool call was actually attempted (toolUsed set) -
  // false means we never had a way to check at all (no matching tool on this server).
  function recordsOf(stageId: RecordSampleStageId): { items: unknown[] | null; resolved: boolean; unavailable: boolean; checkable: boolean } {
    const st = recordSamples?.[stageId];
    if (!st) return { items: null, resolved: false, unavailable: true, checkable: false };
    if (st.error) return { items: null, resolved: true, unavailable: true, checkable: st.toolUsed !== null };
    const resolved = !st.loading && st.lastFetched !== null;
    return { items: resolved ? st.items : null, resolved, unavailable: false, checkable: true };
  }

  const stageStatus = new Map<string, NodeStatus>();
  const stageModule = new Map<string, Record<string, unknown>>();
  const stageAutomation = new Map<string, AutomationInfo>();

  // ── Entry / Qualification / Outcome stage nodes ──────────────────────────
  // Color combines module presence + automation health + confirmed record
  // evidence into one of the 5 spec colors - see decideStageStatus above.
  for (const stage of STAGE_DEFINITIONS) {
    if (!modulesResolved) {
      nodes.push({ id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status: "loading", explanation: loadingNodeExplanation() });
      stageStatus.set(stage.id, "loading");
      continue;
    }
    const mod = findModuleForStage(entityData.modules.items, stage);
    if (!mod) {
      nodes.push({
        id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status: "gap",
        explanation: {
          whatIsThis: STAGE_WHAT_IS_THIS[stage.id] ?? stage.label,
          statusSentence: statusSentence("gap"),
          howWeKnow: [`We checked your CRM's module list and found no ${stage.label.toLowerCase()} module.`],
          honesty: "Confirmed directly from your CRM's module list - not a sample or estimate.",
          technical: [],
        },
      });
      stageStatus.set(stage.id, "gap");
      continue;
    }
    stageModule.set(stage.id, mod);
    const apiName = moduleApiName(mod);
    const generatedType = String(mod.generated_type ?? "");
    const label = moduleLabel(mod) || stage.label;

    let automation: AutomationInfo | undefined;
    if (stage.wantsAutomation && workflowsResolved) {
      automation = computeAutomation(apiName, entityData.workflows.items, ruleCoverage ?? null);
      stageAutomation.set(stage.id, automation);
    }

    const howWeKnow: string[] = [];
    let honesty = "Confirmed directly from your CRM's module list - not a sample or estimate.";
    let recordCount: number | undefined;

    if ((RECORD_SAMPLE_STAGE_IDS as readonly string[]).includes(stage.id)) {
      const rs = recordsOf(stage.id as RecordSampleStageId);
      if (rs.items) {
        recordCount = rs.items.length;
        howWeKnow.push(`We found the ${label} module active in your CRM with ${rs.items.length} record${rs.items.length !== 1 ? "s" : ""} in the sample we checked.`);
        honesty = `Based on a sample of ${rs.items.length} records - treat this as indicative, not exhaustive.`;
        const fillRates = lookupFieldFillRates(rs.items);
        if (fillRates.length > 0) {
          const top = fillRates.slice(0, 4).map(f => `${f.field} (${f.filled}/${rs.items!.length})`);
          howWeKnow.push(`In the sample, these lookups were filled in: ${top.join(", ")}.`);
        }
        if (stage.id === "leads") {
          const converted = rs.items.filter(r => r && typeof r === "object" && isLeadConverted(r as Record<string, unknown>)).length;
          howWeKnow.push(`${converted} of ${rs.items.length} sampled leads have converted.`);
        }
      } else {
        howWeKnow.push(`We found the ${label} module active in your CRM.`);
        honesty = rs.unavailable
          ? (rs.checkable ? CANT_CHECK_TOOL_FAILED : CANT_CHECK_TOOL_MISSING)
          : "Still pulling a real record sample…";
      }
    } else {
      howWeKnow.push(`We found the ${label} module active in your CRM.`);
    }

    if (stage.wantsAutomation) {
      if (!workflowsResolved) {
        howWeKnow.push("Still checking your workflows…");
      } else if (automation) {
        const workflowLine = `${automation.activeCount} active workflow${automation.activeCount !== 1 ? "s" : ""}${automation.inactiveCount > 0 ? `, ${automation.inactiveCount} inactive` : ""}`;
        const ruleLine = automation.ruleCoverageUnknown
          ? "we couldn't check automation rules (validation/approval/assignment/layout) for this module"
          : `${automation.ruleCount} automation rule${automation.ruleCount !== 1 ? "s" : ""} (validation/approval/assignment/layout)`;
        howWeKnow.push(`${workflowLine}, and ${ruleLine}.`);
        if (automation.activeCount > 0) {
          const names = activeWorkflowNames(apiName, entityData.workflows.items);
          if (names.length > 0) howWeKnow.push(`Active: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3} more` : ""}.`);
        }
      }
    }

    if (blueprintsResolved) {
      const rs = (RECORD_SAMPLE_STAGE_IDS as readonly string[]).includes(stage.id) ? recordsOf(stage.id as RecordSampleStageId) : null;
      howWeKnow.push(...blueprintEvidence(apiName, entityData.blueprints.items, rs?.items ?? null));
    }

    const status = decideStageStatus(!!stage.wantsAutomation, automation, recordCount);
    stageStatus.set(stage.id, status);

    nodes.push({
      id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status, recordCount,
      explanation: {
        whatIsThis: STAGE_WHAT_IS_THIS[stage.id] ?? stage.label,
        statusSentence: statusSentence(status),
        howWeKnow,
        honesty,
        technical: [`API name: ${apiName || "unknown"}`, generatedType ? `Module type: ${generatedType}` : ""].filter(Boolean),
      },
      targetSection: stage.targetSection,
    });
  }

  // ── Automation lane companion nodes ──────────────────────────────────────
  // One per lead-to-deal lifecycle stage (Leads/Contacts/Deals/Accounts),
  // showing automation health specifically - independent of the stage node's
  // own color above, which also factors in record evidence.
  const automationStages = STAGE_DEFINITIONS.filter(s => s.wantsAutomation);
  automationStages.forEach((stage, i) => {
    const moduleStatus = stageStatus.get(stage.id) ?? "loading";
    const mod = stageModule.get(stage.id);
    let status: NodeStatus = "loading";
    let howWeKnow: string[] = [];
    let honesty = "";
    let technical: string[] = [];

    if (moduleStatus === "gap") {
      status = "gap";
      howWeKnow = ["There's no module here to automate - it isn't connected in your CRM."];
      honesty = "Confirmed directly from your CRM's module list.";
    } else if (mod && workflowsResolved) {
      const apiName = moduleApiName(mod);
      const auto = stageAutomation.get(stage.id) ?? computeAutomation(apiName, entityData.workflows.items, ruleCoverage ?? null);
      status = auto.status === "gap" ? "gap" : auto.status === "configured-issues" ? "configured-issues" : (auto.confirmedExecuted ? "live" : "configured-untested");
      const label = moduleLabel(mod) || stage.label;
      howWeKnow = [
        `Workflows: ${auto.activeCount} active${auto.inactiveCount > 0 ? `, ${auto.inactiveCount} inactive` : ""}.`,
        auto.ruleCoverageUnknown
          ? "We couldn't check validation, approval, assignment, or layout rules for this module."
          : `Rules: ${auto.rules.approval} approval, ${auto.rules.validation} validation, ${auto.rules.layout} layout, ${auto.rules.assignment} assignment.`,
      ];
      if (status === "gap") howWeKnow.push(`${label} has no active workflow and no rule of any kind - add any one to turn this green.`);
      honesty = auto.ruleCoverageUnknown
        ? "Workflow counts are confirmed; rule counts couldn't be checked on this CRM connection."
        : "Confirmed directly from your CRM's workflow and rule configuration - not a sample.";
      technical = [`API name: ${apiName || "unknown"}`];
    } else if (!workflowsResolved) {
      howWeKnow = ["Still checking your workflows…"];
    }

    nodes.push({
      id: `${stage.id}-automation`, lane: "automation", col: i, label: `${stage.label} Automation`, status,
      explanation: {
        whatIsThis: AUTOMATION_NODE_WHAT_IS_THIS,
        statusSentence: statusSentence(status),
        howWeKnow, honesty, technical,
      },
      targetSection: "workflows",
    });
    edges.push({
      id: `${stage.id}-to-automation`, from: stage.id, to: `${stage.id}-automation`, kind: edgeKindForStatus(status),
      explanation: {
        whatIsThis: `Whether ${stage.label} actually feeds its own automation layer.`,
        statusSentence: edgeStatusSentence(edgeKindForStatus(status)),
        howWeKnow, honesty, technical: [],
      },
    });
  });

  // ── Blueprint sub-node on the Deals stage ────────────────────────────────
  // Scoped to blueprints that actually reference the Deals module (a blueprint
  // configured for Leads/Tickets/etc. doesn't say anything about deals), and
  // split by Active vs Inactive/Draft - only Active blueprints are enforced by
  // Zoho, so a pile of inactive/draft blueprints must not read as "live".
  if (blueprintsResolved) {
    const dealsModule = stageModule.get("deals");
    const dealsApiName = dealsModule ? moduleApiName(dealsModule) : "";
    const dealsBlueprints = dealsApiName ? blueprintsForModule(entityData.blueprints.items, dealsApiName) : [];
    // Blueprint status is its own flat "Active" | "Inactive" | "Draft" string -
    // isActiveWorkflow's default-true fallback would wrongly count Draft as active,
    // so check the exact value here rather than reusing that predicate.
    const activeBlueprints = dealsBlueprints.filter(bp => {
      const status = (bp as Record<string, unknown> | null)?.status;
      return typeof status === "string" && status.toLowerCase() === "active";
    });
    if (dealsBlueprints.length > 0) {
      const status: NodeStatus = activeBlueprints.length > 0 ? "live" : "gap";
      const howWeKnow = activeBlueprints.length > 0
        ? [`${activeBlueprints.length} of ${dealsBlueprints.length} blueprint process${dealsBlueprints.length !== 1 ? "es" : ""} for Deals ${activeBlueprints.length !== 1 ? "are" : "is"} active and enforcing how deals move forward.`]
        : [`${dealsBlueprints.length} blueprint process${dealsBlueprints.length !== 1 ? "es" : ""} configured for Deals, but none are active - nothing is currently enforced.`];
      nodes.push({
        id: "deals-blueprint", lane: "qualification", col: 2,
        label: `Blueprint${dealsBlueprints.length > 1 ? "s" : ""}`,
        status,
        explanation: {
          whatIsThis: BLUEPRINT_WHAT_IS_THIS,
          statusSentence: statusSentence(status),
          howWeKnow,
          honesty: "Confirmed directly from your CRM's blueprint configuration - not a sample.",
          technical: [],
        },
        targetSection: "blueprints",
      });
      edges.push({
        id: "deals-to-blueprint", from: "deals", to: "deals-blueprint", kind: status === "live" ? "automated" : "broken",
        explanation: {
          whatIsThis: "Whether a Blueprint actually governs deals as they move forward.",
          statusSentence: edgeStatusSentence(status === "live" ? "automated" : "broken"),
          howWeKnow,
          consequence: status === "live" ? undefined : "Deals can move forward without following your intended process - reps can skip required steps.",
          honesty: "Confirmed directly from your CRM's blueprint configuration.",
          technical: [],
        },
      });
    }
  }

  // ── Pipeline stages, rendered as a pill chain inside Qualification ───────
  // Sourced from the real getLayouts → getPipelines chain (see usePipelineStages.ts)
  // instead of the generic "stages" entity - this MCP server has no dedicated
  // stages-listing tool.
  if (pipelineStages && pipelineStages.lastFetched !== null && pipelineStages.items.length > 0) {
    const baseCol = 3;
    pipelineStages.items.forEach((stage, i) => {
      const id = `stage-${i}`;
      const howWeKnow = stage.forecastType
        ? [`This is a real pipeline stage from your Deals layout, forecast type "${stage.forecastType}".`]
        : ["This is a real pipeline stage from your Deals layout."];
      if (stage.outOfOrder) {
        howWeKnow.push("This stage's sequence number places it after a Closed Won/Lost stage - deals shouldn't have anywhere to go once a pipeline is closed.");
      }
      const status: NodeStatus = stage.outOfOrder ? "gap" : "live";
      nodes.push({
        id, lane: "qualification", col: baseCol + i, label: stage.name, status,
        explanation: {
          whatIsThis: PIPELINE_STAGE_WHAT_IS_THIS,
          statusSentence: stage.outOfOrder ? "Out of order - sequenced after a Closed Won/Lost stage." : statusSentence("live"),
          howWeKnow,
          honesty: "Confirmed directly from your CRM's deal layout - not a sample.",
          technical: [`API name: ${stage.apiName}`],
        },
        targetSection: "modules",
      });
      const prevId = i === 0 ? "deals" : `stage-${i - 1}`;
      edges.push({
        id: `${prevId}-to-${id}`, from: prevId, to: id, kind: "automated",
        explanation: {
          whatIsThis: "Deals should progress through your pipeline stages in order.",
          statusSentence: edgeStatusSentence("automated"),
          howWeKnow,
          honesty: "Confirmed directly from your CRM's deal layout.",
          technical: [],
        },
      });
    });
  } else if (pipelineStages && pipelineStages.loading) {
    nodes.push({
      id: "stage-loading", lane: "qualification", col: 3, label: "Pipeline stages", status: "loading",
      explanation: loadingNodeExplanation(),
    });
  } else if (pipelineStages && (pipelineStages.error || pipelineStages.lastFetched !== null)) {
    const howWeKnow = pipelineStages.error
      ? [`We tried to read your pipeline stages and it failed: ${pipelineStages.error}`]
      : ["We checked your Deals layout and found no pipeline stages defined."];
    nodes.push({
      id: "stage-gap", lane: "qualification", col: 3, label: "Pipeline stages", status: "gap",
      explanation: {
        whatIsThis: "Pipeline stages are the steps a deal moves through on its way to being won or lost.",
        statusSentence: statusSentence("gap"),
        howWeKnow,
        honesty: "Confirmed directly from your CRM's deal layout - not a sample.",
        technical: [],
      },
      targetSection: "modules",
    });
    edges.push({
      id: "deals-to-stage-gap", from: "deals", to: "stage-gap", kind: "broken",
      explanation: {
        whatIsThis: "Deals should move through defined pipeline stages.",
        statusSentence: edgeStatusSentence("broken"),
        howWeKnow,
        consequence: "Without pipeline stages, there's no structured way to track where a deal actually is - forecasting is guesswork.",
        honesty: "Confirmed directly from your CRM's deal layout.",
        technical: [],
      },
    });
  }

  // ── Journey edges (entry → qualification → outcome) ──────────────────────
  // Where we have a real sample of records, show actual evidence of movement
  // instead of just inferring from whether the source module has automation.
  for (const j of JOURNEY_EDGES) {
    const sourceStatus = stageStatus.get(j.from) ?? "loading";
    let evidence: LinkEvidence | null = null;

    if (j.from === "leads" && j.to === "contacts") {
      const leads = recordsOf("leads");
      evidence = evaluateLeadConversion(leads.items, leads.resolved, leads.checkable);
    } else if (
      (j.from === "contacts" && j.to === "deals") ||
      (j.from === "deals" && j.to === "accounts") ||
      (j.from === "deals" && j.to === "invoices")
    ) {
      const from = recordsOf(j.from as RecordSampleStageId);
      const to = recordsOf(j.to as RecordSampleStageId);
      evidence = evaluateRecordLink(from.items, to.items, j.from, j.to, from.resolved && to.resolved, from.checkable && to.checkable);
    }

    if (!evidence) {
      const kind = edgeKindForStatus(sourceStatus);
      evidence = { kind, howWeKnow: [], honesty: "" };
    }
    const key = `${j.from}-${j.to}`;
    edges.push({
      id: key, from: j.from, to: j.to, kind: evidence.kind,
      explanation: {
        whatIsThis: JOURNEY_EDGE_WHAT_IS_THIS[key] ?? `${j.from} should lead to ${j.to}.`,
        statusSentence: edgeStatusSentence(evidence.kind),
        howWeKnow: evidence.howWeKnow,
        consequence: evidence.consequence,
        honesty: evidence.honesty,
        technical: [],
      },
    });
  }

  return { nodes, edges };
}

// ─── Plain-text report, derived from an already-built FlowMapModel ─────────────
// Summarizes the same green/red connection facts shown on the diagram as a
// readable list, for the "Report" block under the flow map.

export interface FlowReportRow {
  id: string;
  label: string;
  status: NodeStatus;
  detail: string;
  automation?: { status: NodeStatus; detail: string };
}

export interface FlowReportPipeline {
  status: NodeStatus;
  detail: string;
  stageNames: string[];
}

export interface FlowReport {
  rows: FlowReportRow[];
  pipeline: FlowReportPipeline;
}

export function buildFlowReport(flowMap: FlowMapModel): FlowReport {
  const byId = new Map(flowMap.nodes.map(n => [n.id, n]));

  const rows: FlowReportRow[] = STAGE_DEFINITIONS.map(stage => {
    const node = byId.get(stage.id);
    const automationNode = stage.wantsAutomation ? byId.get(`${stage.id}-automation`) : undefined;
    return {
      id: stage.id,
      label: stage.label,
      status: node?.status ?? "loading",
      detail: node?.explanation.statusSentence ?? "Loading…",
      automation: automationNode ? { status: automationNode.status, detail: automationNode.explanation.statusSentence } : undefined,
    };
  });

  const pipelineStageNodes = flowMap.nodes.filter(n => /^stage-\d+$/.test(n.id)).sort((a, b) => a.col - b.col);
  let pipeline: FlowReportPipeline;
  if (pipelineStageNodes.length > 0) {
    pipeline = {
      status: "live",
      detail: `${pipelineStageNodes.length} pipeline stage${pipelineStageNodes.length !== 1 ? "s" : ""} connected from your Deals layout.`,
      stageNames: pipelineStageNodes.map(n => n.label),
    };
  } else {
    const gapNode = byId.get("stage-gap");
    const loadingNode = byId.get("stage-loading");
    const fallback = gapNode ?? loadingNode;
    pipeline = {
      status: fallback?.status ?? "loading",
      detail: fallback?.explanation.statusSentence ?? "Pipeline stages not yet available.",
      stageNames: [],
    };
  }

  return { rows, pipeline };
}

export const FLOW_MAP_ENTITIES: CrmEntityType[] = ["modules", "workflows", "blueprints", "stages"];
