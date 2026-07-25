// Presentational re-shaping of buildFlowMap's output for the redesigned
// "Business Journey" card (see BusinessJourneyCard.tsx). This file does NOT
// change any evidence/scoring logic in flowMapModel.ts — it only re-reads its
// already-computed nodes/edges into a shape that's easier to lay out as
// stage cards + a handful of named connections instead of a generic
// node/lane graph, and derives a couple of purely-UI concepts (confidence
// tier, a 0-100 completeness score per stage) on top of that same data.
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { blueprintStatus } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/crmPredicates";
import {
  buildFlowMap,
  type NodeStatus,
  type RecordSampleStageId,
  type RecordSampleState,
  type PipelineStagesState,
} from "@/lib/flowMapModel";
import type { Section } from "@/lib/sections";
// Reuses the exact healthy/needs-attention/at-risk/critical banding the CRM
// Health Score gauge already uses elsewhere on this dashboard, so a stage
// card's status label always means the same thing as it does there.
import { zoneForValue, type HealthZone } from "@/lib/businessScore";

export type ConfidenceLevel = "high" | "medium" | "low";

export type JourneyStageId = "leads" | "campaigns" | "contacts" | "deals" | "accounts" | "invoices";

const STAGE_ORDER: { id: JourneyStageId; label: string }[] = [
  { id: "leads", label: "Leads" },
  { id: "campaigns", label: "Campaigns" },
  { id: "contacts", label: "Contacts" },
  { id: "deals", label: "Deals" },
  { id: "accounts", label: "Accounts" },
  { id: "invoices", label: "Invoices" },
];

// Stages that get an Automation companion node in buildFlowMap (see
// STAGE_DEFINITIONS' wantsAutomation flag in flowMapModel.ts).
const AUTOMATION_STAGE_IDS: JourneyStageId[] = ["leads", "campaigns", "contacts", "deals"];
// Stages a real record sample can corroborate (see RECORD_SAMPLE_STAGE_IDS).
const RECORD_SAMPLED_STAGE_IDS: JourneyStageId[] = ["leads", "contacts", "deals", "accounts", "invoices"];

const JOURNEY_EDGE_IDS = [
  "leads-to-contacts",
  "campaigns-to-contacts",
  "contacts-to-deals",
  "deals-to-accounts",
  "deals-to-invoices",
] as const;

// Which of the five journey edges buildFlowMap actually corroborates against
// real sampled records (evaluateRecordLink/evaluateLeadConversion) vs. just
// falling back to the source stage's automation status — mirrors the exact
// same branching flowMapModel.ts's journey-edge loop uses.
const RECORD_VERIFIED_EDGE_IDS = new Set<string>([
  "leads-to-contacts", "contacts-to-deals", "deals-to-accounts", "deals-to-invoices",
]);

export interface AutomationBreakdown {
  workflowActive: number;
  workflowInactive: number;
  approval: number;
  validation: number;
  layout: number;
  assignment: number;
}

export type AutomationState =
  | { kind: "not-applicable" }
  | { kind: "loading" }
  | { kind: "gap"; breakdown: AutomationBreakdown | null }
  | { kind: "live"; breakdown: AutomationBreakdown | null };

export interface JourneyStageCard {
  id: JourneyStageId;
  label: string;
  status: NodeStatus;
  connected: boolean;
  detail: string;
  evidence: string[];
  recordCount: number | null;
  automation: AutomationState;
  confidence: ConfidenceLevel;
  healthPct: number;
  healthZone: HealthZone;
  targetSection?: Section;
  /** Only populated for "deals" — the one stage buildFlowMap attaches a blueprint sub-node to. */
  blueprint: { total: number; active: number } | null;
}

export interface JourneyConnection {
  id: string;
  fromId: JourneyStageId;
  toId: JourneyStageId;
  kind: "automated" | "manual" | "broken" | "loading";
  confidence: ConfidenceLevel;
  detail: string;
  /** Compact label for the connector itself (e.g. "43 converted", "Missing relationship"). */
  shortLabel: string;
}

export interface JourneySummary {
  overallHealthPct: number;
  overallHealthZone: HealthZone;
  modulesConnected: number;
  modulesTotal: number;
  automatedStages: number;
  automatedTotal: number;
  brokenConnections: number;
  activeBlueprints: number;
  totalBlueprints: number;
  recordsSampled: number;
}

export interface JourneyModel {
  stages: JourneyStageCard[];
  connections: JourneyConnection[];
  summary: JourneySummary;
  resolved: boolean;
}

// The Automation node's `detail` string is already fully computed by
// computeAutomation() in flowMapModel.ts (see its `breakdown`/`verdict`
// construction) — parsed back out here rather than recomputed, so this stays
// a single source of truth instead of two implementations that can drift.
function parseAutomationBreakdown(detail: string): AutomationBreakdown | null {
  const wf = detail.match(/Workflows:\s*(\d+)\s*active(?:,\s*(\d+)\s*inactive)?/);
  if (!wf) return null;
  const approval = detail.match(/Approval Process:\s*(\d+)/);
  const validation = detail.match(/Validation Rules:\s*(\d+)/);
  const layout = detail.match(/Layout Rules:\s*(\d+)/);
  const assignment = detail.match(/Assignment Rules:\s*(\d+)/);
  return {
    workflowActive: Number(wf[1]),
    workflowInactive: Number(wf[2] ?? 0),
    approval: Number(approval?.[1] ?? 0),
    validation: Number(validation?.[1] ?? 0),
    layout: Number(layout?.[1] ?? 0),
    assignment: Number(assignment?.[1] ?? 0),
  };
}

// Condenses an edge's already-computed prose detail (see evaluateRecordLink /
// evaluateLeadConversion in flowMapModel.ts) into a short connector label —
// parsed from that same output rather than re-deriving the numbers, same
// reasoning as parseAutomationBreakdown above.
function shortConnectorLabel(kind: JourneyConnection["kind"], detail: string): string {
  if (kind === "loading") return "Checking…";
  const converted = detail.match(/^(\d+) of \d+ sampled leads have converted/);
  if (converted) return `${converted[1]} converted`;
  const linked = detail.match(/^(\d+) of \d+ sampled records show a real/);
  if (linked) return `${linked[1]} linked`;
  if (/^None of the .*converted to a contact/.test(detail)) return "0 converted";
  if (/^None of the sampled/.test(detail)) return "0 linked";
  if (/^No .* records found in the sample/.test(detail)) return "No records found";
  if (kind === "broken") return "Missing relationship";
  if (kind === "automated") return "Automated";
  return "Manual step";
}

// A stage that isn't connected has nothing to be confident about — confidence
// otherwise reflects whether a real record sample actually came back
// (recordCount !== null means the stage's sample resolved, even to zero
// records) vs. only automation-config evidence vs. only module existence.
function stageConfidence(id: JourneyStageId, connected: boolean, recordCount: number | null): ConfidenceLevel {
  if (!connected) return "low";
  if (recordCount !== null) return "high";
  if (AUTOMATION_STAGE_IDS.includes(id)) return "medium";
  return "low";
}

function edgeConfidence(id: string): ConfidenceLevel {
  return RECORD_VERIFIED_EDGE_IDS.has(id) ? "high" : "medium";
}

// A purely presentational 0-100 "how complete does this stage look" score —
// distinct from the app's real CRM Health Score (computeHealthScore in
// businessScore.ts, shown on the gauge elsewhere on this dashboard). Connected
// is worth half; the other half splits between automation coverage (skipped,
// i.e. full credit, for stages with no automation lane) and having verifiable
// record evidence (also full credit when this stage has no record sampling
// defined at all, e.g. Campaigns) so a stage is never penalized for an axis
// that doesn't apply to it.
function stageHealthPct(connected: boolean, automation: AutomationState, recordCount: number | null): number {
  if (!connected) return 0;
  let score = 55;
  score += automation.kind === "live" || automation.kind === "not-applicable" ? 25 : 0;
  score += recordCount === null ? 20 : recordCount > 0 ? 20 : 5;
  return Math.min(100, score);
}

export function buildJourneyModel(
  entityData: Record<CrmEntityType, EntityState>,
  recordSamples: Record<RecordSampleStageId, RecordSampleState>,
  pipelineStages: PipelineStagesState,
  ruleCoverage: RuleCoverage | null,
): JourneyModel {
  const flowMap = buildFlowMap(entityData, recordSamples, pipelineStages, ruleCoverage);
  const byId = new Map(flowMap.nodes.map(n => [n.id, n]));

  const modulesResolved = isEntityResolved(entityData.modules);
  const blueprintsResolved = isEntityResolved(entityData.blueprints);

  const stages: JourneyStageCard[] = STAGE_ORDER.map(({ id, label }) => {
    const node = byId.get(id);
    const status: NodeStatus = node?.status ?? "loading";
    const connected = status === "live";

    let automation: AutomationState;
    if (!AUTOMATION_STAGE_IDS.includes(id)) {
      automation = { kind: "not-applicable" };
    } else {
      const autoNode = byId.get(`${id}-automation`);
      if (!autoNode || autoNode.status === "loading") automation = { kind: "loading" };
      else if (autoNode.status === "live") automation = { kind: "live", breakdown: parseAutomationBreakdown(autoNode.detail) };
      else automation = { kind: "gap", breakdown: parseAutomationBreakdown(autoNode.detail) };
    }

    let blueprint: { total: number; active: number } | null = null;
    if (id === "deals") {
      const bpNode = byId.get("deals-blueprint");
      if (bpNode) {
        const m = bpNode.detail.match(/(\d+)\s+of\s+(\d+)\s+blueprint/i);
        blueprint = m ? { active: Number(m[1]), total: Number(m[2]) } : { active: 0, total: 0 };
      } else if (blueprintsResolved) {
        blueprint = { active: 0, total: 0 };
      }
    }

    const recordCount = node?.recordCount ?? null;
    const healthPct = stageHealthPct(connected, automation, recordCount);

    return {
      id, label, status, connected,
      detail: node?.detail ?? "Loading module data…",
      evidence: node?.evidence ?? [],
      recordCount,
      automation,
      confidence: stageConfidence(id, connected, recordCount),
      healthPct,
      healthZone: zoneForValue(healthPct, 100),
      targetSection: node?.targetSection,
      blueprint,
    };
  });

  const connections: JourneyConnection[] = JOURNEY_EDGE_IDS.map(id => {
    const edge = flowMap.edges.find(e => e.id === id);
    const [fromId, toId] = id.split("-to-") as [JourneyStageId, JourneyStageId];
    const kind = edge?.kind ?? "loading";
    const detail = edge?.detail ?? (kind === "loading"
      ? "Loading…"
      : "No real-record sample available for this connection — based on automation/module status instead.");
    return {
      id, fromId, toId, kind,
      confidence: edgeConfidence(id),
      detail,
      shortLabel: shortConnectorLabel(kind, detail),
    };
  });

  const modulesConnected = stages.filter(s => s.connected).length;
  const automatedStages = stages.filter(s => s.automation.kind === "live").length;
  const brokenConnections = connections.filter(c => c.kind === "broken").length;
  const totalBlueprints = entityData.blueprints.items.length;
  const activeBlueprints = entityData.blueprints.items.filter(bp => blueprintStatus(bp) === "active").length;
  const recordsSampled = RECORD_SAMPLED_STAGE_IDS.reduce(
    (sum, id) => sum + (recordSamples[id as RecordSampleStageId]?.items.length ?? 0),
    0,
  );
  const overallHealthPct = stages.length > 0
    ? Math.round(stages.reduce((sum, s) => sum + s.healthPct, 0) / stages.length)
    : 0;

  return {
    stages,
    connections,
    summary: {
      overallHealthPct,
      overallHealthZone: zoneForValue(overallHealthPct, 100),
      modulesConnected,
      modulesTotal: stages.length,
      automatedStages,
      automatedTotal: AUTOMATION_STAGE_IDS.length,
      brokenConnections,
      activeBlueprints,
      totalBlueprints,
      recordsSampled,
    },
    resolved: modulesResolved,
  };
}
