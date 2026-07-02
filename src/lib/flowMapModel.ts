import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { isActiveWorkflow, moduleApiName, workflowReferencesModule } from "@/lib/crmPredicates";
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
  targetSection?: Section;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
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

const STAGE_DEFINITIONS: StageDef[] = [
  { id: "leads",     lane: "entry",         col: 0, label: "Leads",     matchers: [/lead/i],               targetSection: "modules", wantsAutomation: true },
  { id: "campaigns", lane: "entry",         col: 1, label: "Campaigns", matchers: [/campaign/i],            targetSection: "modules", wantsAutomation: true },
  { id: "contacts",  lane: "qualification", col: 0, label: "Contacts",  matchers: [/contact/i],             targetSection: "modules", wantsAutomation: true },
  { id: "deals",     lane: "qualification", col: 1, label: "Deals",     matchers: [/deal|opportunit/i],      targetSection: "modules", wantsAutomation: true },
  { id: "accounts",  lane: "outcome",       col: 0, label: "Accounts",  matchers: [/account/i],             targetSection: "modules" },
  { id: "invoices",  lane: "outcome",       col: 1, label: "Invoices",  matchers: [/invoice/i],             targetSection: "modules" },
];

// Journey edges describing how a lead moves through the business end-to-end.
// `kind` is derived at build time from the SOURCE stage's automation status, so
// following the arrows left-to-right shows exactly where the flow breaks down.
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

function moduleLabel(m: Record<string, unknown>): string {
  return String(m.plural_label ?? m.singular_label ?? m.module_name ?? m.api_name ?? "");
}

interface AutomationInfo {
  status: NodeStatus;   // "live" | "configured-issues" | "gap"
  activeCount: number;
  inactiveCount: number;
}

function computeAutomation(apiName: string, workflows: unknown[]): AutomationInfo {
  const referencing = workflows.filter(w => workflowReferencesModule(w, apiName));
  const active = referencing.filter(isActiveWorkflow);
  const inactive = referencing.length - active.length;
  if (referencing.length === 0) return { status: "gap", activeCount: 0, inactiveCount: 0 };
  if (inactive > 0) return { status: "configured-issues", activeCount: active.length, inactiveCount: inactive };
  return { status: "live", activeCount: active.length, inactiveCount: inactive };
}

function edgeKindForStatus(status: NodeStatus): EdgeKind {
  if (status === "loading") return "loading";
  if (status === "live" || status === "configured-untested") return "automated";
  if (status === "configured-issues") return "automated";
  if (status === "gap") return "broken";
  return "manual"; // "empty"
}

export function buildFlowMap(entityData: Record<CrmEntityType, EntityState>): FlowMapModel {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const modulesResolved = isEntityResolved(entityData.modules);
  const workflowsResolved = isEntityResolved(entityData.workflows);
  const blueprintsResolved = isEntityResolved(entityData.blueprints);

  const stageStatus = new Map<string, NodeStatus>();
  const stageModule = new Map<string, Record<string, unknown>>();

  // ── Entry / Qualification / Outcome stage nodes ──────────────────────────
  for (const stage of STAGE_DEFINITIONS) {
    if (!modulesResolved) {
      nodes.push({ id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status: "loading", detail: "Loading module data…" });
      stageStatus.set(stage.id, "loading");
      continue;
    }
    const mod = findModuleForStage(entityData.modules.items, stage);
    if (!mod) {
      nodes.push({
        id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status: "empty",
        detail: `No ${stage.label.toLowerCase()} module is configured in this CRM.`,
      });
      stageStatus.set(stage.id, "empty");
      continue;
    }
    stageModule.set(stage.id, mod);
    const apiName = moduleApiName(mod);
    let status: NodeStatus = "configured-untested";
    let detail = `${moduleLabel(mod) || stage.label} module is configured.`;
    if (stage.wantsAutomation) {
      if (!workflowsResolved) {
        status = "loading";
      } else {
        const auto = computeAutomation(apiName, entityData.workflows.items);
        status = auto.status;
        detail = auto.status === "live"
          ? `${auto.activeCount} active automation${auto.activeCount !== 1 ? "s" : ""} keep this stage moving.`
          : auto.status === "configured-issues"
            ? `${auto.inactiveCount} automation${auto.inactiveCount !== 1 ? "s have" : " has"} stopped running here.`
            : "No automation is connected to this stage — everything here is manual.";
      }
    } else {
      status = "live";
    }
    stageStatus.set(stage.id, status);
    nodes.push({
      id: stage.id, lane: stage.lane, col: stage.col, label: stage.label, status, detail,
      recordCount: undefined, targetSection: stage.targetSection,
    });
  }

  // ── Automation lane companion nodes ──────────────────────────────────────
  const automationStages = STAGE_DEFINITIONS.filter(s => s.wantsAutomation);
  automationStages.forEach((stage, i) => {
    const status = stageStatus.get(stage.id) ?? "loading";
    const mod = stageModule.get(stage.id);
    let detail = "Waiting on module data…";
    if (status !== "loading") {
      detail = !mod
        ? "No module to automate."
        : status === "live"
          ? `Automation is active and connected to ${moduleLabel(mod) || stage.label}.`
          : status === "configured-issues"
            ? "Some automation on this module has stopped running."
            : "No workflow automation is connected to this module.";
    }
    nodes.push({
      id: `${stage.id}-automation`, lane: "automation", col: i, label: `${stage.label} Automation`,
      status, detail, targetSection: "workflows",
    });
    edges.push({ id: `${stage.id}-to-automation`, from: stage.id, to: `${stage.id}-automation`, kind: edgeKindForStatus(status) });
  });

  // ── Blueprint sub-node on the Deals stage ────────────────────────────────
  if (!blueprintsResolved) {
    // no placeholder node — spec treats this as an enhancement, not a required lane member
  } else if (entityData.blueprints.items.length > 0) {
    nodes.push({
      id: "deals-blueprint", lane: "qualification", col: 2,
      label: `Blueprint${entityData.blueprints.items.length > 1 ? "s" : ""}`,
      status: "live",
      detail: `${entityData.blueprints.items.length} blueprint process${entityData.blueprints.items.length !== 1 ? "es" : ""} enforce how deals move forward.`,
      targetSection: "blueprints",
    });
    edges.push({ id: "deals-to-blueprint", from: "deals", to: "deals-blueprint", kind: "automated" });
  }

  // ── Pipeline stages, rendered as a pill chain inside Qualification ───────
  if (isEntityResolved(entityData.stages) && entityData.stages.items.length > 0) {
    const baseCol = 3;
    entityData.stages.items.forEach((s, i) => {
      const r = (s ?? {}) as Record<string, unknown>;
      const label = String(r.name ?? r.stage_name ?? r.label ?? `Stage ${i + 1}`);
      const id = `stage-${i}`;
      nodes.push({
        id, lane: "qualification", col: baseCol + i, label, status: "live",
        detail: `Pipeline stage: ${label}.`, targetSection: "modules",
      });
      const prevId = i === 0 ? "deals" : `stage-${i - 1}`;
      edges.push({ id: `${prevId}-to-${id}`, from: prevId, to: id, kind: "automated" });
    });
  }

  // ── Journey edges (entry → qualification → outcome) ──────────────────────
  for (const j of JOURNEY_EDGES) {
    const sourceStatus = stageStatus.get(j.from) ?? "loading";
    edges.push({ id: `${j.from}-to-${j.to}`, from: j.from, to: j.to, kind: edgeKindForStatus(sourceStatus) });
  }

  return { nodes, edges };
}

export const FLOW_MAP_ENTITIES: CrmEntityType[] = ["modules", "workflows", "blueprints", "stages"];
