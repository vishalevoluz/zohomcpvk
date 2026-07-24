import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved, getItemName } from "@/lib/useCrmEntities";
import { isActiveWorkflow, moduleApiName, workflowReferencesModule, blueprintsForModule, findBlueprintFieldApiName, ruleCoverageCount, ruleCoverageBreakdown } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { Section } from "@/lib/sections";

export type FlowLane = "entry" | "qualification" | "automation" | "outcome";
export type NodeStatus = "live" | "configured-untested" | "configured-issues" | "gap" | "empty" | "loading";
export type EdgeKind = "automated" | "manual" | "broken" | "loading";

export interface FlowNode {
  id: string;
  lane: FlowLane;
  col: number;
  label: string;
  status: NodeStatus;
  recordCount?: number;
  detail: string;
  /** Extra bullet lines shown in the detail panel — lookups, conversion, workflow, blueprint evidence from the real record sample. */
  evidence?: string[];
  targetSection?: Section;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  detail?: string;
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

export interface RecordSampleState {
  items: unknown[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

// A real Deals pipeline stage (see usePipelineStages.ts), sourced from
// getLayouts + getPipelines rather than a generic "stages" entity — this MCP
// server exposes no dedicated stages-listing tool.
export interface PipelineStage {
  name: string;
  apiName: string;
  sequence: number;
  forecastType?: string;
}

export interface PipelineStagesState {
  items: PipelineStage[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

const STAGE_DEFINITIONS: StageDef[] = [
  { id: "leads",     lane: "entry",         col: 0, label: "Leads",     matchers: [/lead/i],               targetSection: "modules", wantsAutomation: true },
  { id: "campaigns", lane: "entry",         col: 1, label: "Campaigns", matchers: [/campaign/i],            targetSection: "modules", wantsAutomation: true },
  { id: "contacts",  lane: "qualification", col: 0, label: "Contacts",  matchers: [/contact/i],             targetSection: "modules", wantsAutomation: true },
  { id: "deals",     lane: "qualification", col: 1, label: "Deals",     matchers: [/deal|opportunit/i],      targetSection: "modules", wantsAutomation: true },
  { id: "accounts",  lane: "outcome",       col: 0, label: "Accounts",  matchers: [/account/i],             targetSection: "modules" },
  { id: "invoices",  lane: "outcome",       col: 1, label: "Invoices",  matchers: [/invoice/i],             targetSection: "modules" },
];

// Matchers for the stages a record sample can be taken for, keyed by stage id —
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
// layout/pipeline chain — reuses the same "deals" StageDef matcher the flow map
// itself uses, so this always agrees with whichever node the pills attach to.
export function findDealsApiName(entityData: Record<CrmEntityType, EntityState>): string | null {
  if (!isEntityResolved(entityData.modules)) return null;
  const dealsStage = STAGE_DEFINITIONS.find(s => s.id === "deals");
  if (!dealsStage) return null;
  const mod = findModuleForStage(entityData.modules.items, dealsStage);
  return mod ? moduleApiName(mod) : null;
}

// The modules the flow map's own "automation layer" checks (Leads, Campaigns,
// Contacts, Deals — see STAGE_DEFINITIONS' wantsAutomation flag). Reused by
// businessScore.ts so the dashboard's Automation Coverage dimension measures
// coverage of the same lead-to-deal lifecycle modules the flow map already
// visualizes, instead of every module the org happens to have (which for orgs
// with hundreds of custom/junction modules makes a whole-catalog percentage
// meaningless — 2 real automations out of 300+ modules always rounds to 0).
export function automationCoverageApiNames(modules: unknown[]): string[] {
  return STAGE_DEFINITIONS
    .filter(s => s.wantsAutomation)
    .map(stage => {
      const mod = findModuleForStage(modules, stage);
      return mod ? moduleApiName(mod) : null;
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
}

// "Automated" matches the CRM Health Score's Automation Coverage dimension
// (see scoreAutomationCoverage in businessScore.ts): a module counts as
// automated if it has an active workflow OR any assignment/approval/
// validation/layout rule, not just workflows — a module fully covered by a
// validation rule + assignment rule but no workflow shouldn't read as a gap
// on the flow map just because workflows used to be the only signal checked.
function computeAutomation(apiName: string, workflows: unknown[], ruleCoverage: RuleCoverage | null): AutomationInfo {
  const referencing = workflows.filter(w => workflowReferencesModule(w, apiName));
  const active = referencing.filter(isActiveWorkflow);
  const inactive = referencing.length - active.length;
  const rules = ruleCoverageBreakdown(ruleCoverage, apiName);
  const ruleCount = ruleCoverageCount(ruleCoverage, apiName);
  if (active.length > 0 || ruleCount > 0) return { status: "live", activeCount: active.length, inactiveCount: inactive, ruleCount, rules };
  if (inactive > 0) return { status: "configured-issues", activeCount: 0, inactiveCount: inactive, ruleCount: 0, rules };
  return { status: "gap", activeCount: 0, inactiveCount: 0, ruleCount: 0, rules };
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

// Any object-valued field that itself carries an `id` is treated as a lookup —
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
  detail?: string;
}

// Direction-agnostic: some relationships are held by the upstream record's lookup
// (Deal → Account_Name) and some by the downstream record's lookup (Deal → Contact_Name),
// so this checks both sides rather than assuming which module owns the field.
function evaluateRecordLink(
  fromRecords: unknown[] | null,
  toRecords: unknown[] | null,
  fromLabel: string,
  toLabel: string,
  resolved: boolean,
): LinkEvidence {
  if (!resolved) return { kind: "loading", detail: "Loading a sample of real records…" };
  if (!fromRecords || !toRecords) {
    return { kind: "manual", detail: `Can't confirm from real records — ${!fromRecords ? fromLabel : toLabel} sample isn't available.` };
  }
  if (toRecords.length === 0) {
    return { kind: "broken", detail: `No ${toLabel.toLowerCase()} records found in the sample.` };
  }
  const fromIds = idSet(fromRecords);
  const toIds = idSet(toRecords);
  const linkedTo = toRecords.filter(r => [...lookupIds(r)].some(id => fromIds.has(id))).length;
  const linkedFrom = fromRecords.filter(r => [...lookupIds(r)].some(id => toIds.has(id))).length;
  const linked = Math.max(linkedTo, linkedFrom);
  if (linked === 0) {
    return { kind: "broken", detail: `None of the sampled ${toLabel.toLowerCase()} link back to a sampled ${fromLabel.toLowerCase()} record.` };
  }
  const base = linkedTo >= linkedFrom ? toRecords.length : fromRecords.length;
  return { kind: "automated", detail: `${linked} of ${base} sampled records show a real ${fromLabel.toLowerCase()} → ${toLabel.toLowerCase()} link.` };
}

// Field names for "this lead converted" vary a lot by org/API version — classic
// (Converted, Converted_Contact_Id) vs newer system fields (Converted__s,
// Record_Status__s, Converted_Date_Time) — so match on shape/prefix rather than
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

function evaluateLeadConversion(leadRecords: unknown[] | null, resolved: boolean): LinkEvidence {
  if (!resolved) return { kind: "loading", detail: "Loading a sample of real leads…" };
  if (!leadRecords) return { kind: "manual", detail: "Can't confirm from real records — Leads sample isn't available." };
  if (leadRecords.length === 0) return { kind: "broken", detail: "No lead records found in the sample." };
  const converted = leadRecords.filter(r => r && typeof r === "object" && isLeadConverted(r as Record<string, unknown>)).length;
  if (converted === 0) {
    return { kind: "broken", detail: `None of the last ${leadRecords.length} leads sampled have converted to a contact.` };
  }
  return { kind: "automated", detail: `${converted} of ${leadRecords.length} sampled leads have converted to a contact.` };
}

// Which of the record's own fields are lookup-shaped (Zoho's { id, name } shape)
// and how often each is actually populated across the sample — surfaces real
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
// records per blueprint state — real evidence instead of just "a blueprint exists".
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
  // (feature not wired, or the getRecords tool isn't on this MCP server) — callers
  // should fall back to the old module/automation heuristic rather than wait forever.
  function recordsOf(stageId: RecordSampleStageId): { items: unknown[] | null; resolved: boolean; unavailable: boolean } {
    const st = recordSamples?.[stageId];
    if (!st) return { items: null, resolved: false, unavailable: true };
    if (st.error) return { items: null, resolved: true, unavailable: true };
    const resolved = !st.loading && st.lastFetched !== null;
    return { items: resolved ? st.items : null, resolved, unavailable: false };
  }

  const stageStatus = new Map<string, NodeStatus>();
  const stageModule = new Map<string, Record<string, unknown>>();
  const stageAutomation = new Map<string, ReturnType<typeof computeAutomation>>();

  // ── Entry / Qualification / Outcome stage nodes ──────────────────────────
  // Coloring rule: green ("live") if the module is connected/configured in
  // this CRM, red ("gap") if it isn't. Automation health is a separate signal
  // shown on the dedicated Automation lane node below, not on this node.
  for (const stage of STAGE_DEFINITIONS) {
    if (!modulesResolved) {
      nodes.push({ id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status: "loading", detail: "Loading module data…" });
      stageStatus.set(stage.id, "loading");
      continue;
    }
    const mod = findModuleForStage(entityData.modules.items, stage);
    if (!mod) {
      nodes.push({
        id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status: "gap",
        detail: `No ${stage.label.toLowerCase()} module is configured in this CRM — not connected.`,
      });
      stageStatus.set(stage.id, "gap");
      continue;
    }
    stageModule.set(stage.id, mod);
    const apiName = moduleApiName(mod);
    const status: NodeStatus = "live";
    const generatedType = String(mod.generated_type ?? "");
    const detail = `${moduleLabel(mod) || stage.label} module is connected — API name: ${apiName || "unknown"}`
      + (generatedType ? `, type: ${generatedType}.` : ".");
    if (stage.wantsAutomation && workflowsResolved) {
      stageAutomation.set(stage.id, computeAutomation(apiName, entityData.workflows.items, ruleCoverage ?? null));
    }
    stageStatus.set(stage.id, status);

    const evidence: string[] = [];
    let recordCount: number | undefined;
    if ((RECORD_SAMPLE_STAGE_IDS as readonly string[]).includes(stage.id)) {
      const rs = recordsOf(stage.id as RecordSampleStageId);
      recordCount = rs.items?.length;
      if (rs.items) {
        const fillRates = lookupFieldFillRates(rs.items);
        if (fillRates.length > 0) {
          const top = fillRates.slice(0, 4).map(f => `${f.field} (${f.filled}/${rs.items!.length})`);
          evidence.push(`Lookups found in sample: ${top.join(", ")}.`);
        }
        if (stage.id === "leads") {
          const converted = rs.items.filter(r => r && typeof r === "object" && isLeadConverted(r as Record<string, unknown>)).length;
          evidence.push(`${converted} of ${rs.items.length} sampled leads have converted.`);
        }
      }
      if (workflowsResolved) {
        const names = activeWorkflowNames(apiName, entityData.workflows.items);
        if (names.length > 0) {
          evidence.push(`Active workflows: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3} more` : ""}.`);
        }
      }
      if (blueprintsResolved) {
        evidence.push(...blueprintEvidence(apiName, entityData.blueprints.items, rs.items));
      }
    }

    nodes.push({
      id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status, detail,
      recordCount, evidence: evidence.length > 0 ? evidence : undefined, targetSection: stage.targetSection,
    });
  }

  // ── Automation lane companion nodes ──────────────────────────────────────
  // Coloring rule: green ("live") if this module has at least one active
  // workflow OR any assignment/approval/validation/layout rule connected to
  // it, red ("gap") otherwise — independent of the module node's own
  // connected/not-connected color above. The tooltip always itemizes all
  // five signal types (with a live count each) so it's clear exactly which
  // ones are covering the module and which aren't, not just a combined total.
  const automationStages = STAGE_DEFINITIONS.filter(s => s.wantsAutomation);
  automationStages.forEach((stage, i) => {
    const moduleStatus = stageStatus.get(stage.id) ?? "loading";
    const mod = stageModule.get(stage.id);
    let status: NodeStatus = "loading";
    let detail = "Waiting on module data…";
    if (moduleStatus === "gap") {
      status = "gap";
      detail = "No module to automate — module isn't connected.";
    } else if (mod && workflowsResolved) {
      const auto = stageAutomation.get(stage.id) ?? computeAutomation(moduleApiName(mod), entityData.workflows.items, ruleCoverage ?? null);
      // Only an active workflow or an actual rule counts as "live" — a module
      // whose only workflows are inactive, and has no rule coverage either,
      // still reads as a gap (matches the original workflow-only behavior;
      // "configured-issues" is folded into the same red state here since this
      // node's color is a strict has-automation/doesn't binary).
      status = auto.status === "live" ? "live" : "gap";
      const label = moduleLabel(mod) || stage.label;
      const workflowLine = `Workflows: ${auto.activeCount} active${auto.inactiveCount > 0 ? `, ${auto.inactiveCount} inactive` : ""}`;
      const breakdown = [
        workflowLine,
        `Approval Process: ${auto.rules.approval}`,
        `Validation Rules: ${auto.rules.validation}`,
        `Layout Rules: ${auto.rules.layout}`,
        `Assignment Rules: ${auto.rules.assignment}`,
      ].join(" · ");
      const verdict = status === "live"
        ? `${label} is automated — at least one of these is active.`
        : `${label} has no active workflow and no rule of any kind — automation isn't connected. Add any one (workflow, approval process, validation rule, layout rule, or assignment rule) to turn this green.`;
      detail = `${breakdown}. ${verdict}`;
    }
    nodes.push({
      id: `${stage.id}-automation`, lane: "automation", col: i, label: `${stage.label} Automation`,
      status, detail, targetSection: "workflows",
    });
    edges.push({ id: `${stage.id}-to-automation`, from: stage.id, to: `${stage.id}-automation`, kind: edgeKindForStatus(status) });
  });

  // ── Blueprint sub-node on the Deals stage ────────────────────────────────
  // Scoped to blueprints that actually reference the Deals module (a blueprint
  // configured for Leads/Tickets/etc. doesn't say anything about deals), and
  // split by Active vs Inactive/Draft — only Active blueprints are enforced by
  // Zoho, so a pile of inactive/draft blueprints must not read as "live".
  if (!blueprintsResolved) {
    // no placeholder node — spec treats this as an enhancement, not a required lane member
  } else {
    const dealsModule = stageModule.get("deals");
    const dealsApiName = dealsModule ? moduleApiName(dealsModule) : "";
    const dealsBlueprints = dealsApiName ? blueprintsForModule(entityData.blueprints.items, dealsApiName) : [];
    // Blueprint status is its own flat "Active" | "Inactive" | "Draft" string —
    // isActiveWorkflow's default-true fallback would wrongly count Draft as active,
    // so check the exact value here rather than reusing that predicate.
    const activeBlueprints = dealsBlueprints.filter(bp => {
      const status = (bp as Record<string, unknown> | null)?.status;
      return typeof status === "string" && status.toLowerCase() === "active";
    });
    if (dealsBlueprints.length > 0) {
      const status: NodeStatus = activeBlueprints.length > 0 ? "live" : "gap";
      const detail = activeBlueprints.length > 0
        ? `${activeBlueprints.length} of ${dealsBlueprints.length} blueprint process${dealsBlueprints.length !== 1 ? "es" : ""} for Deals ${activeBlueprints.length !== 1 ? "are" : "is"} active and enforcing how deals move forward.`
        : `${dealsBlueprints.length} blueprint process${dealsBlueprints.length !== 1 ? "es" : ""} configured for Deals, but none are active — nothing is currently enforced.`;
      nodes.push({
        id: "deals-blueprint", lane: "qualification", col: 2,
        label: `Blueprint${dealsBlueprints.length > 1 ? "s" : ""}`,
        status,
        detail,
        targetSection: "blueprints",
      });
      edges.push({ id: "deals-to-blueprint", from: "deals", to: "deals-blueprint", kind: status === "live" ? "automated" : "broken" });
    }
  }

  // ── Pipeline stages, rendered as a pill chain inside Qualification ───────
  // Sourced from the real getLayouts → getPipelines chain (see usePipelineStages.ts)
  // instead of the generic "stages" entity — this MCP server has no dedicated
  // stages-listing tool, so that entity never resolves to real data.
  // Coloring rule: green ("live") pills once real pipeline data is connected,
  // a single red ("gap") node if the connection failed or returned nothing.
  if (pipelineStages && pipelineStages.lastFetched !== null && pipelineStages.items.length > 0) {
    const baseCol = 3;
    pipelineStages.items.forEach((stage, i) => {
      const id = `stage-${i}`;
      const detail = stage.forecastType
        ? `Pipeline stage: ${stage.name} (${stage.forecastType}).`
        : `Pipeline stage: ${stage.name}.`;
      nodes.push({
        id, lane: "qualification", col: baseCol + i, label: stage.name, status: "live",
        detail, targetSection: "modules",
      });
      const prevId = i === 0 ? "deals" : `stage-${i - 1}`;
      edges.push({ id: `${prevId}-to-${id}`, from: prevId, to: id, kind: "automated" });
    });
  } else if (pipelineStages && pipelineStages.loading) {
    nodes.push({
      id: "stage-loading", lane: "qualification", col: 3, label: "Pipeline stages", status: "loading",
      detail: "Loading pipeline stages from getLayouts / getPipelines…",
    });
  } else if (pipelineStages && (pipelineStages.error || pipelineStages.lastFetched !== null)) {
    nodes.push({
      id: "stage-gap", lane: "qualification", col: 3, label: "Pipeline stages", status: "gap",
      detail: pipelineStages.error
        ? `Pipeline stages aren't connected: ${pipelineStages.error}`
        : "No pipeline stages were found for this layout — not connected.",
      targetSection: "modules",
    });
    edges.push({ id: "deals-to-stage-gap", from: "deals", to: "stage-gap", kind: "broken" });
  }

  // ── Journey edges (entry → qualification → outcome) ──────────────────────
  // Where we have a real sample of records, show actual evidence of movement
  // instead of just inferring from whether the source module has automation.
  for (const j of JOURNEY_EDGES) {
    const sourceStatus = stageStatus.get(j.from) ?? "loading";
    let evidence: LinkEvidence | null = null;

    if (j.from === "leads" && j.to === "contacts") {
      const leads = recordsOf("leads");
      if (!leads.unavailable) evidence = evaluateLeadConversion(leads.items, leads.resolved);
    } else if (
      (j.from === "contacts" && j.to === "deals") ||
      (j.from === "deals" && j.to === "accounts") ||
      (j.from === "deals" && j.to === "invoices")
    ) {
      const from = recordsOf(j.from as RecordSampleStageId);
      const to = recordsOf(j.to as RecordSampleStageId);
      if (!from.unavailable && !to.unavailable) {
        evidence = evaluateRecordLink(from.items, to.items, j.from, j.to, from.resolved && to.resolved);
      }
    }

    if (!evidence) evidence = { kind: edgeKindForStatus(sourceStatus) };
    edges.push({ id: `${j.from}-to-${j.to}`, from: j.from, to: j.to, kind: evidence.kind, detail: evidence.detail });
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
      detail: node?.detail ?? "Loading…",
      automation: automationNode ? { status: automationNode.status, detail: automationNode.detail } : undefined,
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
      detail: fallback?.detail ?? "Pipeline stages not yet available.",
      stageNames: [],
    };
  }

  return { rows, pipeline };
}

export const FLOW_MAP_ENTITIES: CrmEntityType[] = ["modules", "workflows", "blueprints", "stages"];
