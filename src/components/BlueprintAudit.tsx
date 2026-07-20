"use client";

import React, { useState, useEffect, useRef } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";
import ScopeHint from "@/components/ScopeHint";

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ZohoBPTransition {
  id?: string;
  name?: string;
  next_field_value?: string;
  current_field_value?: string;
  from_state?: string;
  to_state?: string;
  data?: {
    before_form?: unknown[];
    after_transitions?: unknown[];
    mandatory_check_list?: unknown[];
    validation_rules?: unknown[];
    fields?: unknown[];
    actions?: unknown[];
  };
  mandatory_fields?: unknown[];
  validation_rules?: unknown[];
  actions?: unknown[];
  criteria?: unknown;
  execute_on?: string;
  [key: string]: unknown;
}

interface ZohoBlueprint {
  id?: string;
  name?: string;
  blueprint_name?: string;
  active?: boolean;
  status?: string;
  module?: string | { api_name?: string; name?: string; plural_label?: string };
  field?: { name?: string; id?: string } | null;
  layout?: { name?: string; display_label?: string; id?: string } | null;
  supported_clone?: boolean;
  created_by?: { name?: string; id?: string };
  modified_by?: { name?: string; id?: string };
  created_time?: string;
  modified_time?: string;
  transitions?: ZohoBPTransition[];
  process_info?: {
    field_label?: string;
    api_name?: string;
    name?: string;
    picklist_values?: Array<{ display_value?: string; value?: string; id?: string }>;
  };
  states?: Array<{ id?: string; name?: string; type?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ConfirmDialogState {
  type: "activate" | "deactivate" | "clone";
  bp: ZohoBlueprint;
  moveRecords: boolean;
  cloneType: "standalone" | "dependent";
}

// ─── Response parsing helpers ────────────────────────────────────────────────

function extractFromValue(result: unknown): ZohoBlueprint[] {
  if (Array.isArray(result)) {
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      return result as ZohoBlueprint[];
    }
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.blueprints)) return r.blueprints as ZohoBlueprint[];
    if (r.blueprint && typeof r.blueprint === "object") return [r.blueprint as ZohoBlueprint];
    if (Array.isArray(r.data)) return r.data as ZohoBlueprint[];
    if (Array.isArray(r.result)) return r.result as ZohoBlueprint[];
    for (const val of Object.values(r)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const first = val[0] as Record<string, unknown>;
        if ("blueprint_name" in first || "transitions" in first || "process_info" in first ||
            ("name" in first && ("field" in first || "layout" in first || "supported_clone" in first))) {
          return val as ZohoBlueprint[];
        }
      }
    }
  }
  return [];
}

function detectApiError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          const parsed = JSON.parse(item.text) as Record<string, unknown>;
          if (parsed.status === "error" && parsed.code) {
            const code = String(parsed.code);
            const msg = String(parsed.message ?? "Unknown API error");
            if (code === "OAUTH_SCOPE_MISMATCH") {
              return `OAuth scope error: your token lacks permission for this API. Add the Blueprint scope (ZohoCRM.blueprint.READ) to your OAuth client and regenerate the token.`;
            }
            return `Zoho API error [${code}]: ${msg}`;
          }
        } catch { /* not JSON */ }
      }
    }
  }
  if (r.isError && r.structuredContent) {
    const sc = r.structuredContent as Record<string, unknown>;
    const data = sc.data as Record<string, unknown> | undefined;
    if (data?.code) {
      const code = String(data.code);
      const msg = String(data.message ?? "Unknown API error");
      if (code === "OAUTH_SCOPE_MISMATCH") {
        return `OAuth scope error: your token lacks permission for this API. Add the Blueprint scope (ZohoCRM.blueprint.READ) to your OAuth client and regenerate the token.`;
      }
      return `Zoho API error [${code}]: ${msg}`;
    }
  }
  return null;
}

function extractBlueprints(result: unknown): ZohoBlueprint[] {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const bps = extractFromValue(parsed);
            if (bps.length > 0) return bps;
          } catch { /* not JSON */ }
        }
      }
    }
  }
  return extractFromValue(result);
}

function parseJsonFromMcp(result: unknown): Record<string, unknown> | null {
  if (!result) return null;
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try { return JSON.parse(item.text) as Record<string, unknown>; } catch { /* skip */ }
        }
      }
    }
    return r;
  }
  return null;
}

function extractSingleBlueprint(result: unknown): ZohoBlueprint | null {
  const parsed = parseJsonFromMcp(result);
  if (!parsed) return null;
  if (parsed.blueprint && typeof parsed.blueprint === "object") return parsed.blueprint as ZohoBlueprint;
  const bps = extractFromValue(parsed);
  if (bps.length === 1) return bps[0];
  if (parsed.id || parsed.name || parsed.blueprint_name) return parsed as unknown as ZohoBlueprint;
  return null;
}

function extractRecordCount(result: unknown): number | null {
  const parsed = parseJsonFromMcp(result);
  if (!parsed) return null;
  if (typeof parsed.count === "number") return parsed.count;
  if (typeof parsed.record_count === "number") return parsed.record_count;
  if (typeof parsed.total === "number") return parsed.total;
  const dig = (obj: Record<string, unknown>): number | null => {
    for (const v of Object.values(obj)) {
      if (typeof v === "number") return v;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const n = dig(v as Record<string, unknown>);
        if (n !== null) return n;
      }
    }
    return null;
  };
  return dig(parsed);
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function getBPName(bp: ZohoBlueprint): string {
  return String(bp.name ?? bp.blueprint_name ?? bp.id ?? "Unknown");
}

function getBPModule(bp: ZohoBlueprint): string {
  if (!bp.module) return "—";
  if (typeof bp.module === "string") return bp.module;
  const m = bp.module as Record<string, unknown>;
  return String(m.api_name ?? m.plural_label ?? m.name ?? "—");
}

function getBPField(bp: ZohoBlueprint): string {
  return String(bp.field?.name ?? "—");
}

function getBPLayout(bp: ZohoBlueprint): string {
  return String(bp.layout?.display_label ?? bp.layout?.name ?? "—");
}

function getBPCreatedBy(bp: ZohoBlueprint): string {
  return String(bp.created_by?.name ?? "—");
}

function getBPModifiedBy(bp: ZohoBlueprint): string {
  return String(bp.modified_by?.name ?? "—");
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return String(iso); }
}

function isBPActive(bp: ZohoBlueprint): boolean {
  if (bp.active === false) return false;
  if (bp.active === true) return true;
  const s = String(bp.status ?? "").toLowerCase();
  if (s === "inactive" || s === "disabled" || s === "false" || s === "draft") return false;
  return true;
}

function getTransitions(bp: ZohoBlueprint): ZohoBPTransition[] {
  if (Array.isArray(bp.transitions)) return bp.transitions;
  return [];
}

function getTransitionFrom(t: ZohoBPTransition): string {
  return String(t.current_field_value ?? t.from_state ?? "");
}

function getTransitionTo(t: ZohoBPTransition): string {
  return String(t.next_field_value ?? t.to_state ?? "");
}

function getMandatoryFields(t: ZohoBPTransition): unknown[] {
  const d = t.data;
  if (d) {
    if (Array.isArray(d.before_form)) return d.before_form;
    if (Array.isArray(d.mandatory_check_list)) return d.mandatory_check_list;
    if (Array.isArray(d.fields)) return d.fields;
  }
  if (Array.isArray(t.mandatory_fields)) return t.mandatory_fields;
  return [];
}

function getValidationRules(t: ZohoBPTransition): unknown[] {
  const d = t.data;
  if (d && Array.isArray(d.validation_rules)) return d.validation_rules;
  if (Array.isArray(t.validation_rules)) return t.validation_rules;
  return [];
}

function getTransitionActions(t: ZohoBPTransition): unknown[] {
  const d = t.data;
  if (d) {
    if (Array.isArray(d.after_transitions)) return d.after_transitions;
    if (Array.isArray(d.actions)) return d.actions;
  }
  if (Array.isArray(t.actions)) return t.actions;
  return [];
}

function getPicklistStages(bp: ZohoBlueprint): string[] {
  const pvs = bp.process_info?.picklist_values;
  if (!Array.isArray(pvs)) return [];
  return pvs.map(v => String(v.display_value ?? v.value ?? "")).filter(Boolean);
}

function findTool(allTools: McpTool[], name: string): McpTool | undefined {
  return allTools.find(t => t.name === name);
}

// ─── Analysis ────────────────────────────────────────────────────────────────

interface BPAnalysis {
  stagesCount: number;
  transitionsCount: number;
  totalMandatoryFields: number;
  totalValidationRules: number;
  deadEndStages: string[];
  disconnectedStages: string[];
  incompleteTransitions: number;
  hasDeadEnds: boolean;
  hasMissingTransitions: boolean;
  hasIncomplete: boolean;
}

function analyzeBlueprint(bp: ZohoBlueprint): BPAnalysis {
  const transitions = getTransitions(bp);
  const outgoingStages = new Set<string>();
  const incomingStages = new Set<string>();
  let totalMandatoryFields = 0;
  let totalValidationRules = 0;
  let incompleteTransitions = 0;

  for (const t of transitions) {
    const from = getTransitionFrom(t);
    const to = getTransitionTo(t);
    if (from) outgoingStages.add(from);
    if (to) incomingStages.add(to);
    const mf = getMandatoryFields(t);
    const vr = getValidationRules(t);
    const ac = getTransitionActions(t);
    totalMandatoryFields += mf.length;
    totalValidationRules += vr.length;
    if (mf.length === 0 && vr.length === 0 && ac.length === 0) incompleteTransitions++;
  }

  const allTransitionStages = new Set([...outgoingStages, ...incomingStages]);
  const deadEndStages = [...incomingStages].filter(s => !outgoingStages.has(s));
  const picklistStages = getPicklistStages(bp);
  const disconnectedStages = picklistStages.filter(s => !allTransitionStages.has(s));

  return {
    stagesCount: allTransitionStages.size,
    transitionsCount: transitions.length,
    totalMandatoryFields,
    totalValidationRules,
    deadEndStages,
    disconnectedStages,
    incompleteTransitions,
    hasDeadEnds: deadEndStages.length > 0,
    hasMissingTransitions: disconnectedStages.length > 0,
    hasIncomplete: incompleteTransitions > 0,
  };
}

// ─── Blueprint Detail Modal ──────────────────────────────────────────────────

type DetailTab = "overview" | "states" | "transitions" | "create";
type ActionPanel = "activate" | "deactivate" | "clone" | null;

const BP_TOOL_LABELS: Record<string, string> = {
  getBlueprintId: "View Details",
  getBlueprintStateById: "State Details",
  getBlueprintRecordsCount: "Record Count",
  activateBlueprint: "Activate",
  deactivateBlueprint: "Deactivate",
  cloneBlueprint: "Clone",
  createBlueprintStates: "Add States",
  createBlueprintTransitions: "Add Transitions",
  postBlueprint: "Create Blueprint",
  getBlueprintProcessConfigurationMeta: "Config Meta",
  getBlueprint: "List Blueprints",
};

function BlueprintDetailModal({
  bp: initialBp,
  config,
  allTools,
  onLog,
  onClose,
}: {
  bp: ZohoBlueprint;
  config: McpConfig;
  allTools: McpTool[];
  onLog: (log: ExecutionLog) => void;
  onClose: () => void;
}) {
  // Blueprint data
  const [fullBp, setFullBp] = useState<ZohoBlueprint | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  // Optimistic status (updated after activate/deactivate)
  const [localActive, setLocalActive] = useState<boolean | null>(null);

  // Record count
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);

  // State details
  const [expandedStateId, setExpandedStateId] = useState<string | null>(null);
  const [stateDetails, setStateDetails] = useState<Record<string, Record<string, unknown>>>({});
  const [stateLoading, setStateLoading] = useState<string | null>(null);
  const [showAddState, setShowAddState] = useState(false);
  const [addStatesJson, setAddStatesJson] = useState("");
  const [addStatesLoading, setAddStatesLoading] = useState(false);
  const [statesOpMsg, setStatesOpMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Transitions
  const [showAddTrans, setShowAddTrans] = useState(false);
  const [addTransJson, setAddTransJson] = useState("");
  const [addTransLoading, setAddTransLoading] = useState(false);
  const [transOpMsg, setTransOpMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Create blueprint
  const [createBpJson, setCreateBpJson] = useState(
    '{\n  "name": "New Blueprint",\n  "module": "Leads",\n  "states": [],\n  "transitions": [],\n  "chart_data": {}\n}'
  );
  const [createBpLoading, setCreateBpLoading] = useState(false);
  const [createBpMsg, setCreateBpMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Inline action panel
  const [actionPanel, setActionPanel] = useState<ActionPanel>(null);
  const [moveRecords, setMoveRecords] = useState(false);
  const [cloneType, setCloneType] = useState<"standalone" | "dependent">("standalone");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Active tab
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  // Tool availability flags
  const canActivate = !!findTool(allTools, "activateBlueprint");
  const canDeactivate = !!findTool(allTools, "deactivateBlueprint");
  const canClone = !!findTool(allTools, "cloneBlueprint");
  const canCount = !!findTool(allTools, "getBlueprintRecordsCount");
  const canStateDetail = !!findTool(allTools, "getBlueprintStateById");
  const canAddStates = !!findTool(allTools, "createBlueprintStates");
  const canAddTrans = !!findTool(allTools, "createBlueprintTransitions");
  const canCreate = !!findTool(allTools, "postBlueprint");

  const displayBp = fullBp ?? initialBp;
  const isActive = localActive !== null ? localActive : isBPActive(displayBp);
  const states = displayBp.states ?? [];
  const transitions = getTransitions(displayBp);
  const analysis = analyzeBlueprint(displayBp);

  // Connected blueprint tools for display
  const connectedTools = Object.keys(BP_TOOL_LABELS).filter(name => !!findTool(allTools, name));

  useEffect(() => {
    void loadFullDetail();
    if (findTool(allTools, "getBlueprintRecordsCount") && initialBp.id) void loadRecordCount();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadFullDetail() {
    const tool = findTool(allTools, "getBlueprintId");
    if (!tool || !initialBp.id) { setFullBp(initialBp); return; }
    setLoadingDetail(true);
    setDetailError("");
    const start = Date.now();
    try {
      const result = await executeTool(config, "getBlueprintId", { blueprintId: initialBp.id });
      const apiErr = detectApiError(result);
      if (apiErr) { setDetailError(apiErr); setFullBp(initialBp); return; }
      const detail = extractSingleBlueprint(result);
      setFullBp(detail ?? initialBp);
      onLog({ id: crypto.randomUUID(), tool: "getBlueprintId", input: { blueprintId: initialBp.id }, output: result, status: detail ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Failed to load blueprint details");
      setFullBp(initialBp);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function loadRecordCount() {
    if (!initialBp.id) return;
    setCountLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "getBlueprintRecordsCount", { blueprintId: initialBp.id });
      const count = extractRecordCount(result);
      setRecordCount(count ?? -1);
      onLog({ id: crypto.randomUUID(), tool: "getBlueprintRecordsCount", input: { blueprintId: initialBp.id }, output: result, status: count !== null ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch { setRecordCount(-1); }
    finally { setCountLoading(false); }
  }

  async function loadStateDetail(stateId: string) {
    if (stateDetails[stateId]) { setExpandedStateId(expandedStateId === stateId ? null : stateId); return; }
    if (!initialBp.id) return;
    setStateLoading(stateId);
    const start = Date.now();
    try {
      const result = await executeTool(config, "getBlueprintStateById", { blueprintId: initialBp.id, stateId });
      const parsed = parseJsonFromMcp(result);
      if (parsed) setStateDetails(prev => ({ ...prev, [stateId]: parsed }));
      setExpandedStateId(stateId);
      onLog({ id: crypto.randomUUID(), tool: "getBlueprintStateById", input: { blueprintId: initialBp.id, stateId }, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch { /* ignore */ } finally { setStateLoading(null); }
  }

  async function handleAddStates() {
    if (!initialBp.id) return;
    setStatesOpMsg(null);
    let data: unknown;
    try { data = JSON.parse(addStatesJson); } catch { setStatesOpMsg({ ok: false, text: "Invalid JSON" }); return; }
    setAddStatesLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "createBlueprintStates", { blueprintId: initialBp.id, ...(data as Record<string, unknown>) });
      const apiErr = detectApiError(result);
      setStatesOpMsg(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "States created. Reload to see them." });
      onLog({ id: crypto.randomUUID(), tool: "createBlueprintStates", input: { blueprintId: initialBp.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
      if (!apiErr) { setAddStatesJson(""); setShowAddState(false); }
    } catch (e) {
      setStatesOpMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally { setAddStatesLoading(false); }
  }

  async function handleAddTransitions() {
    if (!initialBp.id) return;
    setTransOpMsg(null);
    let data: unknown;
    try { data = JSON.parse(addTransJson); } catch { setTransOpMsg({ ok: false, text: "Invalid JSON" }); return; }
    setAddTransLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "createBlueprintTransitions", { blueprintId: initialBp.id, ...(data as Record<string, unknown>) });
      const apiErr = detectApiError(result);
      setTransOpMsg(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "Transitions created. Reload to see them." });
      onLog({ id: crypto.randomUUID(), tool: "createBlueprintTransitions", input: { blueprintId: initialBp.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
      if (!apiErr) { setAddTransJson(""); setShowAddTrans(false); }
    } catch (e) {
      setTransOpMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally { setAddTransLoading(false); }
  }

  async function handleCreateBluprint() {
    setCreateBpMsg(null);
    let payload: unknown;
    try { payload = JSON.parse(createBpJson); } catch { setCreateBpMsg({ ok: false, text: "Invalid JSON" }); return; }
    setCreateBpLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "postBlueprint", payload as Record<string, unknown>);
      const apiErr = detectApiError(result);
      setCreateBpMsg(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "Blueprint created. Update every transition's modified_time before activating." });
      onLog({ id: crypto.randomUUID(), tool: "postBlueprint", input: payload as Record<string, unknown>, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) {
      setCreateBpMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally { setCreateBpLoading(false); }
  }

  async function runAction() {
    if (!initialBp.id || !actionPanel) return;
    setActionLoading(true);
    setActionMsg(null);
    const start = Date.now();
    try {
      if (actionPanel === "activate") {
        const result = await executeTool(config, "activateBlueprint", { blueprintId: initialBp.id, move_records: moveRecords, map_states: [] });
        const apiErr = detectApiError(result);
        setActionMsg({ ok: !apiErr, text: apiErr ?? "Blueprint activated successfully." });
        onLog({ id: crypto.randomUUID(), tool: "activateBlueprint", input: { blueprintId: initialBp.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
        if (!apiErr) { setLocalActive(true); setActionPanel(null); }
      } else if (actionPanel === "deactivate") {
        const result = await executeTool(config, "deactivateBlueprint", { blueprintId: initialBp.id });
        const apiErr = detectApiError(result);
        setActionMsg({ ok: !apiErr, text: apiErr ?? "Blueprint deactivated." });
        onLog({ id: crypto.randomUUID(), tool: "deactivateBlueprint", input: { blueprintId: initialBp.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
        if (!apiErr) { setLocalActive(false); setActionPanel(null); }
      } else if (actionPanel === "clone") {
        const params: Record<string, unknown> = { blueprintId: initialBp.id, type: cloneType };
        const result = await executeTool(config, "cloneBlueprint", params);
        const apiErr = detectApiError(result);
        setActionMsg({ ok: !apiErr, text: apiErr ?? `Blueprint cloned as ${cloneType}. The clone starts as Draft — reload the list to see it.` });
        onLog({ id: crypto.randomUUID(), tool: "cloneBlueprint", input: params, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
        if (!apiErr) setActionPanel(null);
      }
    } catch (e) {
      setActionMsg({ ok: false, text: e instanceof Error ? e.message : "Action failed" });
    } finally { setActionLoading(false); }
  }

  return (
    <div className="evoai-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bp-detail-panel">

        {/* ── Header ── */}
        <div className="bp-detail-header">
          <div className="bp-detail-header-left">
            <span className="pane-icon" style={{ fontSize: 20 }}>◈</span>
            <div>
              <div className="bp-detail-title">{getBPName(displayBp)}</div>
              <div className="bp-detail-sub">ID: {String(displayBp.id ?? "—")} · {getBPModule(displayBp)}</div>
            </div>
          </div>
          <div className="bp-detail-header-actions">
            {loadingDetail && <span className="spinner" />}
            {/* Status badge */}
            <span className={`bool-badge ${isActive ? "yes" : "no"}`}>{isActive ? "Active" : "Inactive"}</span>
            {/* Activate / Deactivate */}
            {!isActive && canActivate && (
              <button
                className="btn-connect"
                style={{ padding: "5px 14px", fontSize: 12 }}
                onClick={() => { setActionPanel(actionPanel === "activate" ? null : "activate"); setActionMsg(null); }}
              >▶ Activate</button>
            )}
            {isActive && canDeactivate && (
              <button
                className="btn-secondary btn-danger-outline"
                style={{ padding: "5px 14px", fontSize: 12 }}
                onClick={() => { setActionPanel(actionPanel === "deactivate" ? null : "deactivate"); setActionMsg(null); }}
              >⏸ Deactivate</button>
            )}
            {/* Clone */}
            {canClone && (
              <button
                className="btn-secondary"
                style={{ padding: "5px 14px", fontSize: 12 }}
                onClick={() => { setActionPanel(actionPanel === "clone" ? null : "clone"); setActionMsg(null); }}
              >⎘ Clone</button>
            )}
            <button className="evoai-close" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* ── Inline action panel ── */}
        {actionPanel && (
          <div className={`bp-action-panel bp-action-${actionPanel}`}>
            <div className="bp-action-panel-body">
              {actionPanel === "activate" && (
                <>
                  <p className="bp-action-desc">
                    All states and transitions must have <code>chart_data</code> before activation. For a fresh blueprint, leave <em>Move records</em> unchecked.
                  </p>
                  <label className="bp-confirm-check">
                    <input type="checkbox" checked={moveRecords} onChange={e => setMoveRecords(e.target.checked)} />
                    <span>
                      <strong>Move records</strong>
                      <span className="bp-confirm-hint">Enable only when replacing an existing active blueprint (dependent clone pattern).</span>
                    </span>
                  </label>
                </>
              )}
              {actionPanel === "deactivate" && (
                <p className="bp-action-desc">
                  Records will retain their current stage. Deactivating does <strong>not</strong> unlock structural editing — use the dependent clone pattern for changes.
                </p>
              )}
              {actionPanel === "clone" && (
                <div className="bp-clone-type-group">
                  <label className={`bp-clone-type-option${cloneType === "standalone" ? " selected" : ""}`}>
                    <input type="radio" name="dp-clone" value="standalone" checked={cloneType === "standalone"} onChange={() => setCloneType("standalone")} />
                    <div><strong>Standalone</strong><span className="bp-confirm-hint">Independent copy. Picklist values remapped to clone&apos;s own state IDs.</span></div>
                  </label>
                  <label className={`bp-clone-type-option${cloneType === "dependent" ? " selected" : ""}`}>
                    <input type="radio" name="dp-clone" value="dependent" checked={cloneType === "dependent"} onChange={() => setCloneType("dependent")} />
                    <div><strong>Dependent</strong><span className="bp-confirm-hint">Draft child that replaces source on activation. Provide map_states at activation time.</span></div>
                  </label>
                </div>
              )}
              {actionMsg && (
                <div className={actionMsg.ok ? "form-success" : "form-error"} style={{ marginTop: 10 }}>
                  {actionMsg.ok ? "✓" : "⚠"} {actionMsg.text}
                </div>
              )}
            </div>
            <div className="bp-action-panel-footer">
              <button className="btn-secondary" onClick={() => { setActionPanel(null); setActionMsg(null); }} disabled={actionLoading}>Cancel</button>
              <button
                className={`btn-connect${actionPanel === "deactivate" ? " btn-danger" : ""}`}
                onClick={() => void runAction()}
                disabled={actionLoading}
              >
                {actionLoading ? <><span className="spinner" /> Processing…</> :
                  actionPanel === "activate" ? "Confirm Activate" :
                  actionPanel === "deactivate" ? "Confirm Deactivate" : "Confirm Clone"}
              </button>
            </div>
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="bp-detail-tabs">
          {(["overview", "states", "transitions"] as DetailTab[]).concat(canCreate ? ["create"] : []).map(s => (
            <button
              key={s}
              className={`bp-detail-tab${activeTab === s ? " active" : ""}`}
              onClick={() => setActiveTab(s)}
            >
              {s === "overview" && "Overview"}
              {s === "states" && `States${states.length ? ` (${states.length})` : ""}`}
              {s === "transitions" && `Transitions${transitions.length ? ` (${transitions.length})` : ""}`}
              {s === "create" && "+ Create Blueprint"}
            </button>
          ))}
        </div>

        {detailError && <div className="form-error" style={{ margin: "12px 20px 0" }}>⚠ {detailError}</div>}

        {/* ── Tab body ── */}
        <div className="bp-detail-body">

          {/* Overview */}
          {activeTab === "overview" && (
            <div>
              <div className="bp-info-grid">
                <div className="bp-info-row"><span className="bp-info-label">Module</span><span className="bp-info-value">{getBPModule(displayBp)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Field</span><span className="bp-info-value">{getBPField(displayBp)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Layout</span><span className="bp-info-value">{getBPLayout(displayBp)}</span></div>
                <div className="bp-info-row">
                  <span className="bp-info-label">Clone Support</span>
                  <span className={`bool-badge ${displayBp.supported_clone ? "yes" : "no"}`}>{displayBp.supported_clone ? "Yes" : "No"}</span>
                </div>
                <div className="bp-info-row"><span className="bp-info-label">Created By</span><span className="bp-info-value">{getBPCreatedBy(displayBp)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Created At</span><span className="bp-info-value">{formatDateTime(displayBp.created_time)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Modified By</span><span className="bp-info-value">{getBPModifiedBy(displayBp)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Modified At</span><span className="bp-info-value">{formatDateTime(displayBp.modified_time)}</span></div>
                {canCount && (
                  <div className="bp-info-row">
                    <span className="bp-info-label">Records in Process</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="bp-info-value">{recordCount === null ? "—" : recordCount === -1 ? "Error" : String(recordCount)}</span>
                      <button className="btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }} onClick={loadRecordCount} disabled={countLoading}>
                        {countLoading ? <><span className="spinner" /> Loading…</> : "Load Count"}
                      </button>
                    </span>
                  </div>
                )}
              </div>
              {analysis.transitionsCount > 0 && (
                <div className="bp-analysis-bar">
                  <span className="bp-stat"><strong>{analysis.transitionsCount}</strong> transitions</span>
                  <span className="bp-stat"><strong>{analysis.stagesCount}</strong> stages</span>
                  <span className="bp-stat"><strong>{analysis.totalMandatoryFields}</strong> mandatory fields</span>
                  <span className="bp-stat"><strong>{analysis.totalValidationRules}</strong> validation rules</span>
                  {analysis.deadEndStages.length > 0 && <span className="bp-stat bp-stat-danger">⚠ {analysis.deadEndStages.length} dead-end{analysis.deadEndStages.length > 1 ? "s" : ""}</span>}
                </div>
              )}
              {/* Connected tools */}
              {connectedTools.length > 0 && (
                <div className="bp-connected-tools">
                  <span className="bp-connected-tools-label">Connected tools</span>
                  <div className="bp-tool-chips">
                    {connectedTools.map(name => (
                      <span key={name} className="bp-tool-chip">{BP_TOOL_LABELS[name]}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* States */}
          {activeTab === "states" && (
            <div>
              <div className="bp-tab-toolbar">
                <span className="bp-tab-toolbar-title">
                  {states.length ? `${states.length} state${states.length > 1 ? "s" : ""}` : "No states in response"}
                </span>
                {canAddStates && (
                  <button className="btn-secondary" style={{ fontSize: 12, padding: "4px 12px" }} onClick={() => { setShowAddState(v => !v); setStatesOpMsg(null); }}>
                    {showAddState ? "Cancel" : "+ Add States"}
                  </button>
                )}
              </div>

              {statesOpMsg && (
                <div className={statesOpMsg.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>
                  {statesOpMsg.ok ? "✓" : "⚠"} {statesOpMsg.text}
                </div>
              )}

              {showAddState && (
                <div className="bp-manage-card" style={{ marginBottom: 16 }}>
                  <h4 className="bp-manage-title">Add States to this Blueprint</h4>
                  <p className="bp-manage-desc">Required: process_id, module, pick_list_value, state_escalation.</p>
                  <textarea className="bp-json-editor" value={addStatesJson} onChange={e => setAddStatesJson(e.target.value)}
                    placeholder={'{\n  "states": [{\n    "name": "Stage Name",\n    "type": "open"\n  }]\n}'} rows={6} />
                  <button className="btn-connect" disabled={!addStatesJson.trim() || addStatesLoading} onClick={handleAddStates}>
                    {addStatesLoading ? <><span className="spinner" /> Creating…</> : "Create States"}
                  </button>
                </div>
              )}

              <div className="bp-states-list">
                {states.length === 0 ? (
                  <div className="audit-empty"><p className="audit-empty-sub">No states in the detail response.</p></div>
                ) : states.map((state, idx) => {
                  const stateId = String(state.id ?? idx);
                  const isExpanded = expandedStateId === stateId;
                  const detail = stateDetails[stateId];
                  const isLoading = stateLoading === stateId;
                  return (
                    <div key={stateId} className={`bp-state-item${isExpanded ? " expanded" : ""}`}>
                      <div className="bp-state-row">
                        <div className="bp-state-info">
                          <span className="bp-state-name">{String(state.name ?? `State ${idx + 1}`)}</span>
                          <span className="bp-state-id">{stateId}</span>
                          {state.type && <span className="audit-tag tag-ok">{String(state.type)}</span>}
                        </div>
                        {canStateDetail && (
                          <button className="btn-secondary" style={{ padding: "3px 12px", fontSize: 12, flexShrink: 0 }} disabled={isLoading} onClick={() => void loadStateDetail(stateId)}>
                            {isLoading ? <><span className="spinner" /> Loading…</> : isExpanded ? "Collapse" : "View Details"}
                          </button>
                        )}
                      </div>
                      {isExpanded && detail && (
                        <div className="bp-state-detail"><pre className="bp-json-preview">{JSON.stringify(detail, null, 2)}</pre></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Transitions */}
          {activeTab === "transitions" && (
            <div>
              <div className="bp-tab-toolbar">
                <span className="bp-tab-toolbar-title">
                  {transitions.length ? `${transitions.length} transition${transitions.length > 1 ? "s" : ""}` : "No transitions in response"}
                </span>
                {canAddTrans && (
                  <button className="btn-secondary" style={{ fontSize: 12, padding: "4px 12px" }} onClick={() => { setShowAddTrans(v => !v); setTransOpMsg(null); }}>
                    {showAddTrans ? "Cancel" : "+ Add Transitions"}
                  </button>
                )}
              </div>

              {transOpMsg && (
                <div className={transOpMsg.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>
                  {transOpMsg.ok ? "✓" : "⚠"} {transOpMsg.text}
                </div>
              )}

              {showAddTrans && (
                <div className="bp-manage-card" style={{ marginBottom: 16 }}>
                  <h4 className="bp-manage-title">Add Transitions to this Blueprint</h4>
                  <p className="bp-manage-desc">Provide field configurations and criteria.</p>
                  <textarea className="bp-json-editor" value={addTransJson} onChange={e => setAddTransJson(e.target.value)}
                    placeholder={'{\n  "transitions": [{\n    "name": "Qualify",\n    "next_field_value": "Qualified"\n  }]\n}'} rows={6} />
                  <button className="btn-connect" disabled={!addTransJson.trim() || addTransLoading} onClick={handleAddTransitions}>
                    {addTransLoading ? <><span className="spinner" /> Creating…</> : "Create Transitions"}
                  </button>
                </div>
              )}

              {transitions.length === 0 ? (
                <div className="audit-empty"><p className="audit-empty-sub">No transitions in the detail response.</p></div>
              ) : (
                <div className="table-scroll">
                  <table className="modules-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>From Stage</th>
                        <th>To Stage</th>
                        <th>Mandatory Fields</th>
                        <th>Validation Rules</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transitions.map((t, i) => (
                        <tr key={String(t.id ?? i)}>
                          <td className="cell-name">{String(t.name ?? "—")}</td>
                          <td className="cell-mono">{getTransitionFrom(t) || "—"}</td>
                          <td className="cell-mono">{getTransitionTo(t) || "—"}</td>
                          <td><span className={`bool-badge ${getMandatoryFields(t).length > 0 ? "yes" : "no"}`}>{getMandatoryFields(t).length}</span></td>
                          <td><span className={`bool-badge ${getValidationRules(t).length > 0 ? "yes" : "no"}`}>{getValidationRules(t).length}</span></td>
                          <td><span className={`bool-badge ${getTransitionActions(t).length > 0 ? "yes" : "no"}`}>{getTransitionActions(t).length}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Create Blueprint */}
          {activeTab === "create" && canCreate && (
            <div>
              <p className="bp-manage-desc" style={{ marginBottom: 14 }}>
                After creation, update every transition via <code>PUT /settings/blueprints/transitions/&#123;id&#125;</code> to set <code>modified_time</code>. <code>chart_data</code> is practically required before first activation.
              </p>
              {createBpMsg && (
                <div className={createBpMsg.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>
                  {createBpMsg.ok ? "✓" : "⚠"} {createBpMsg.text}
                </div>
              )}
              <textarea className="bp-json-editor" value={createBpJson} onChange={e => setCreateBpJson(e.target.value)} rows={14} />
              <div style={{ marginTop: 12 }}>
                <button className="btn-connect" disabled={!createBpJson.trim() || createBpLoading} onClick={handleCreateBluprint}>
                  {createBpLoading ? <><span className="spinner" /> Creating…</> : "Create Blueprint"}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Confirm Action Dialog ────────────────────────────────────────────────────

function ConfirmActionDialog({
  dialog,
  onConfirm,
  onChange,
  onClose,
  loading,
}: {
  dialog: ConfirmDialogState;
  onConfirm: () => void;
  onChange: (updates: Partial<ConfirmDialogState>) => void;
  onClose: () => void;
  loading: boolean;
}) {
  return (
    <div className="evoai-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bp-confirm-panel">
        <div className="bp-confirm-header">
          <span className="bp-confirm-icon">
            {dialog.type === "activate" && "▶"}
            {dialog.type === "deactivate" && "⏸"}
            {dialog.type === "clone" && "⎘"}
          </span>
          <div>
            <div className="bp-confirm-title">
              {dialog.type === "activate" && "Activate Blueprint"}
              {dialog.type === "deactivate" && "Deactivate Blueprint"}
              {dialog.type === "clone" && "Clone Blueprint"}
            </div>
            <div className="bp-confirm-sub">{getBPName(dialog.bp)}</div>
          </div>
        </div>

        <div className="bp-confirm-body">
          {dialog.type === "activate" && (
            <>
              <p className="bp-confirm-desc">
                This will activate <strong>{getBPName(dialog.bp)}</strong>. All states and transitions must have chart_data populated before activation.
              </p>
              <label className="bp-confirm-check">
                <input
                  type="checkbox"
                  checked={dialog.moveRecords}
                  onChange={e => onChange({ moveRecords: e.target.checked })}
                />
                <span>
                  <strong>Move records</strong> — remap existing records to new states
                  <span className="bp-confirm-hint">Enable only when replacing an existing active blueprint (dependent clone pattern). For fresh blueprints, leave unchecked.</span>
                </span>
              </label>
            </>
          )}
          {dialog.type === "deactivate" && (
            <p className="bp-confirm-desc">
              This will deactivate <strong>{getBPName(dialog.bp)}</strong>. Records will retain their current stage. Note: deactivating does not unlock the blueprint for editing — use the dependent clone pattern for structural changes.
            </p>
          )}
          {dialog.type === "clone" && (
            <>
              <p className="bp-confirm-desc">
                Clone <strong>{getBPName(dialog.bp)}</strong>. The clone starts as a Draft.
              </p>
              <div className="bp-clone-type-group">
                <label className={`bp-clone-type-option${dialog.cloneType === "standalone" ? " selected" : ""}`}>
                  <input type="radio" name="clone-type" value="standalone" checked={dialog.cloneType === "standalone"} onChange={() => onChange({ cloneType: "standalone" })} />
                  <div>
                    <strong>Standalone</strong>
                    <span className="bp-confirm-hint">Independent copy. Picklist values are remapped to the clone&apos;s own state IDs.</span>
                  </div>
                </label>
                <label className={`bp-clone-type-option${dialog.cloneType === "dependent" ? " selected" : ""}`}>
                  <input type="radio" name="clone-type" value="dependent" checked={dialog.cloneType === "dependent"} onChange={() => onChange({ cloneType: "dependent" })} />
                  <div>
                    <strong>Dependent</strong>
                    <span className="bp-confirm-hint">Draft child that replaces the source when activated. Source must be active with chart_data. Provide map_states at activation time.</span>
                  </div>
                </label>
              </div>
            </>
          )}
        </div>

        <div className="bp-confirm-footer">
          <button className="btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
          <button
            className={`btn-connect${dialog.type === "deactivate" ? " btn-danger" : ""}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <><span className="spinner" /> Processing…</> :
              dialog.type === "activate" ? "Activate Blueprint" :
              dialog.type === "deactivate" ? "Deactivate Blueprint" :
              "Clone Blueprint"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component types ─────────────────────────────────────────────────────

type BPFilterKey = "all" | "inactive" | "dead_end" | "missing_transitions" | "incomplete";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  allTools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

// ─── Main BlueprintAudit component ───────────────────────────────────────────

export default function BlueprintAudit({ config, tools, allTools, onLog }: Props) {
  const [selectedTools, setSelectedTools] = useState<string[]>(() => tools.map(t => t.name));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [blueprints, setBlueprints] = useState<ZohoBlueprint[]>([]);
  const [filter, setFilter] = useState<BPFilterKey>("all");
  const [search, setSearch] = useState("");
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Meta
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState("");
  const [metaExpanded, setMetaExpanded] = useState(false);

  // Record counts per blueprint
  const [recordCounts, setRecordCounts] = useState<Record<string, number | null>>({});
  const [recordCountLoading, setRecordCountLoading] = useState<string | null>(null);

  // Detail modal
  const [detailBp, setDetailBp] = useState<ZohoBlueprint | null>(null);

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Tabs
  const [activeTab, setActiveTab] = useState<"list" | "create">("list");
  const [createJson, setCreateJson] = useState(
    '{\n  "name": "New Blueprint",\n  "module": "Leads",\n  "states": [],\n  "transitions": [],\n  "chart_data": {}\n}'
  );
  const [createLoading, setCreateLoading] = useState(false);
  const [createResult, setCreateResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!activeMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setActiveMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [activeMenu]);

  useEffect(() => {
    const toolNames = tools.map(t => t.name);
    setSelectedTools(toolNames);
    setBlueprints([]);
    setError("");
    setMeta(null);
    setMetaError("");
    setRecordCounts({});
    setActionMessage(null);
    // Auto-load as soon as tools are available (MCP just connected)
    if (toolNames.length > 0) {
      void loadBlueprints(toolNames);
      if (findTool(allTools, "getBlueprintProcessConfigurationMeta")) {
        void loadMeta();
      }
    }
  }, [tools]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadBlueprints(overrideTools?: string[]) {
    const toolsToUse = overrideTools ?? selectedTools;
    if (toolsToUse.length === 0) return;
    setLoading(true);
    setError("");
    setActionMessage(null);
    try {
      const all: ZohoBlueprint[] = [];
      for (const toolName of toolsToUse) {
        const start = Date.now();
        try {
          const output = await executeTool(config, toolName, {});
          const apiErr = detectApiError(output);
          if (apiErr) {
            setError(apiErr);
            onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output, status: "error", errorMessage: apiErr, durationMs: Date.now() - start, timestamp: new Date() });
            return;
          }
          const bps = extractBlueprints(output);
          if (bps.length > 0) all.push(...bps);
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output, status: bps.length > 0 ? "success" : "error", errorMessage: bps.length === 0 ? "No blueprints found" : undefined, durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Failed";
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
      if (all.length === 0) {
        setError(`No blueprint data found in selected tool${toolsToUse.length > 1 ? "s" : ""}.`);
      } else {
        setBlueprints(all);
        setFilter("all");
        setRecordCounts({});
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadMeta() {
    const tool = findTool(allTools, "getBlueprintProcessConfigurationMeta");
    if (!tool) return;
    setMetaLoading(true);
    setMetaError("");
    const start = Date.now();
    try {
      const result = await executeTool(config, "getBlueprintProcessConfigurationMeta", {});
      const apiErr = detectApiError(result);
      if (apiErr) { setMetaError(apiErr); return; }
      const parsed = parseJsonFromMcp(result);
      setMeta(parsed);
      setMetaExpanded(true);
      onLog({ id: crypto.randomUUID(), tool: "getBlueprintProcessConfigurationMeta", input: {}, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) {
      setMetaError(e instanceof Error ? e.message : "Failed to load meta");
    } finally {
      setMetaLoading(false);
    }
  }

  async function loadRecordCount(bp: ZohoBlueprint) {
    if (!bp.id) return;
    setRecordCountLoading(String(bp.id));
    const start = Date.now();
    try {
      const result = await executeTool(config, "getBlueprintRecordsCount", { blueprintId: bp.id });
      const count = extractRecordCount(result);
      setRecordCounts(prev => ({ ...prev, [String(bp.id)]: count }));
      onLog({ id: crypto.randomUUID(), tool: "getBlueprintRecordsCount", input: { blueprintId: bp.id }, output: result, status: count !== null ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch {
      setRecordCounts(prev => ({ ...prev, [String(bp.id)]: -1 }));
    } finally {
      setRecordCountLoading(null);
    }
  }

  async function executeAction(dialog: ConfirmDialogState) {
    setActionLoading(true);
    setActionMessage(null);
    const start = Date.now();
    try {
      if (dialog.type === "activate") {
        const result = await executeTool(config, "activateBlueprint", {
          blueprintId: dialog.bp.id,
          move_records: dialog.moveRecords,
          map_states: [],
        });
        const apiErr = detectApiError(result);
        const msg = apiErr ?? "Blueprint activated successfully";
        setActionMessage({ ok: !apiErr, text: msg });
        onLog({ id: crypto.randomUUID(), tool: "activateBlueprint", input: { blueprintId: dialog.bp.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
        if (!apiErr) setBlueprints(prev => prev.map(b => b.id === dialog.bp.id ? { ...b, active: true } : b));
      } else if (dialog.type === "deactivate") {
        const result = await executeTool(config, "deactivateBlueprint", { blueprintId: dialog.bp.id });
        const apiErr = detectApiError(result);
        const msg = apiErr ?? "Blueprint deactivated successfully";
        setActionMessage({ ok: !apiErr, text: msg });
        onLog({ id: crypto.randomUUID(), tool: "deactivateBlueprint", input: { blueprintId: dialog.bp.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
        if (!apiErr) setBlueprints(prev => prev.map(b => b.id === dialog.bp.id ? { ...b, active: false } : b));
      } else if (dialog.type === "clone") {
        const params: Record<string, unknown> = { blueprintId: dialog.bp.id, type: dialog.cloneType };
        const result = await executeTool(config, "cloneBlueprint", params);
        const apiErr = detectApiError(result);
        const msg = apiErr ?? `Blueprint cloned as ${dialog.cloneType}. The clone starts as Draft — reload to see it.`;
        setActionMessage({ ok: !apiErr, text: msg });
        onLog({ id: crypto.randomUUID(), tool: "cloneBlueprint", input: params, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
      }
    } catch (e) {
      setActionMessage({ ok: false, text: e instanceof Error ? e.message : "Action failed" });
    } finally {
      setActionLoading(false);
      setConfirmDialog(null);
    }
  }

  async function handleCreateBlueprint() {
    const tool = findTool(allTools, "postBlueprint");
    if (!tool) return;
    setCreateResult(null);
    let payload: unknown;
    try { payload = JSON.parse(createJson); } catch { setCreateResult({ ok: false, text: "Invalid JSON" }); return; }
    setCreateLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "postBlueprint", payload as Record<string, unknown>);
      const apiErr = detectApiError(result);
      setCreateResult(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "Blueprint created successfully. Remember to update every transition via PUT /settings/blueprints/transitions/{transitionId} before activating." });
      onLog({ id: crypto.randomUUID(), tool: "postBlueprint", input: payload as Record<string, unknown>, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) {
      setCreateResult({ ok: false, text: e instanceof Error ? e.message : "Failed to create blueprint" });
    } finally {
      setCreateLoading(false);
    }
  }

  // ─── Derived data ────────────────────────────────────────────────────────────

  const inactive = blueprints.filter(bp => !isBPActive(bp));
  const deadEnd = blueprints.filter(bp => analyzeBlueprint(bp).hasDeadEnds);
  const missingTransitions = blueprints.filter(bp => analyzeBlueprint(bp).hasMissingTransitions);
  const incomplete = blueprints.filter(bp => analyzeBlueprint(bp).hasIncomplete);

  const filterMap: Record<BPFilterKey, ZohoBlueprint[]> = {
    all: blueprints,
    inactive,
    dead_end: deadEnd,
    missing_transitions: missingTransitions,
    incomplete,
  };
  const bySeverity = filterMap[filter];
  const displayed = search.trim()
    ? bySeverity.filter(bp => {
        const q = search.trim().toLowerCase();
        return getBPName(bp).toLowerCase().includes(q) || getBPModule(bp).toLowerCase().includes(q);
      })
    : bySeverity;

  function getTags(bp: ZohoBlueprint): BPFilterKey[] {
    const tags: BPFilterKey[] = [];
    if (!isBPActive(bp)) tags.push("inactive");
    const a = analyzeBlueprint(bp);
    if (a.hasDeadEnds) tags.push("dead_end");
    if (a.hasMissingTransitions) tags.push("missing_transitions");
    if (a.hasIncomplete) tags.push("incomplete");
    return tags;
  }

  const findings: { key: BPFilterKey; label: string; count: number; severity: string; tip: string }[] = [
    { key: "inactive",            label: "Inactive Blueprints",  count: inactive.length,           severity: inactive.length > 0 ? "warn" : "ok",           tip: "Blueprint processes not currently active — stage transitions are not being enforced on records." },
    { key: "dead_end",           label: "Dead-end Stages",       count: deadEnd.length,            severity: deadEnd.length > 0 ? "danger" : "ok",          tip: "Stages that can be reached via transitions but have no outgoing transitions defined. Records can get permanently stuck here." },
    { key: "missing_transitions", label: "Missing Transitions",  count: missingTransitions.length, severity: missingTransitions.length > 0 ? "danger" : "ok", tip: "Picklist values in the blueprint field that aren't connected to any transition — those stages are completely unreachable." },
    { key: "incomplete",          label: "Incomplete Processes", count: incomplete.length,          severity: incomplete.length > 0 ? "warn" : "ok",          tip: "Transitions with no mandatory fields, validation rules, or actions configured — they do nothing when executed." },
  ];

  const hasMetaTool = !!findTool(allTools, "getBlueprintProcessConfigurationMeta");
  const hasCountTool = !!findTool(allTools, "getBlueprintRecordsCount");
  const hasCreateTool = !!findTool(allTools, "postBlueprint");

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="modules-audit">
      {/* Header */}
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">◈</span>
          <h2 className="pane-title">Blueprint Audit</h2>
          {blueprints.length > 0 && (
            <span className="pane-count">{blueprints.length} blueprint{blueprints.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="audit-toolbar">
          {tools.length > 0 ? (
            <MultiToolSelect tools={tools} selected={selectedTools} onChange={setSelectedTools} />
          ) : (
            <span className="no-tools-hint">No blueprint tools found — check connection</span>
          )}
          <button onClick={() => void loadBlueprints()} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : "↺ Reload"}
          </button>
          {hasMetaTool && (
            <button onClick={loadMeta} disabled={metaLoading} className="btn-secondary" title="Load blueprint configuration meta">
              {metaLoading ? <><span className="spinner" /> Meta…</> : "Load Meta"}
            </button>
          )}
        </div>
      </div>

      {/* Meta banner */}
      {(meta || metaError) && (
        <div className="bp-meta-banner">
          <div className="bp-meta-banner-header" onClick={() => setMetaExpanded(v => !v)}>
            <span className="bp-meta-banner-title">Blueprint Configuration Meta</span>
            <span className="bp-meta-banner-toggle">{metaExpanded ? "▲" : "▼"}</span>
          </div>
          {metaError && <div className="form-error" style={{ margin: "8px 16px" }}>⚠ {metaError}</div>}
          {meta && metaExpanded && (
            <div className="bp-meta-body">
              {Object.entries(meta).map(([k, v]) => (
                <div key={k} className="bp-meta-row">
                  <span className="bp-meta-key">{k}</span>
                  <span className="bp-meta-val">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
            </div>
          )}
          {meta && !metaExpanded && (
            <div className="bp-meta-summary">
              {Object.entries(meta).slice(0, 4).map(([k, v]) => (
                <span key={k} className="bp-meta-chip"><strong>{k}:</strong> {typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action result */}
      {actionMessage && (
        <div className={actionMessage.ok ? "form-success" : "form-error"} style={{ marginTop: 12 }}>
          {actionMessage.ok ? "✓" : "⚠"} {actionMessage.text}
          <button className="bp-dismiss" onClick={() => setActionMessage(null)}>✕</button>
        </div>
      )}

      {error && <ScopeHint scopes={["getBlueprint"]} />}

      {/* Tabs */}
      {(blueprints.length > 0 || hasCreateTool) && (
        <div className="bp-tabs">
          <button className={`bp-tab${activeTab === "list" ? " active" : ""}`} onClick={() => setActiveTab("list")}>
            Blueprints{blueprints.length > 0 ? ` (${blueprints.length})` : ""}
          </button>
          {hasCreateTool && (
            <button className={`bp-tab${activeTab === "create" ? " active" : ""}`} onClick={() => setActiveTab("create")}>
              + Create Blueprint
            </button>
          )}
        </div>
      )}

      {/* Create tab */}
      {activeTab === "create" && hasCreateTool && (
        <div className="bp-create-section">
          <h3 className="bp-create-title">Create Blueprint</h3>
          <p className="bp-create-desc">
            Provide the full blueprint configuration as JSON. After creation, update every transition via the Zoho CRM API (PUT /settings/blueprints/transitions/&#123;transitionId&#125;) to set modified_time — required by the UI. chart_data is practically required before first activation.
          </p>
          {createResult && (
            <div className={createResult.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>
              {createResult.ok ? "✓" : "⚠"} {createResult.text}
            </div>
          )}
          <textarea
            className="bp-json-editor"
            value={createJson}
            onChange={e => setCreateJson(e.target.value)}
            rows={14}
          />
          <div style={{ marginTop: 12 }}>
            <button className="btn-connect" disabled={!createJson.trim() || createLoading} onClick={handleCreateBlueprint}>
              {createLoading ? <><span className="spinner" /> Creating…</> : "Create Blueprint"}
            </button>
          </div>
        </div>
      )}

      {/* List tab */}
      {activeTab === "list" && (
        <>
          {blueprints.length === 0 && !error && !loading && (
            <div className="audit-empty">
              <div className="audit-empty-icon">◈</div>
              <p className="audit-empty-title">No data loaded</p>
              <p className="audit-empty-sub">Select a tool and click "Load Blueprints" to run the audit.</p>
            </div>
          )}

          {blueprints.length > 0 && (
            <>
              <div className="findings-grid">
                {findings.map(f => (
                  <button
                    key={f.key}
                    data-tooltip={f.tip}
                    className={`finding-card severity-${f.severity}${filter === f.key ? " active" : ""}`}
                    onClick={() => setFilter(filter === f.key ? "all" : f.key)}
                  >
                    <span className="finding-count">{f.count}</span>
                    <span className="finding-label">{f.label}</span>
                    {f.count > 0 && (
                      <span className="finding-hint">{filter === f.key ? "Click to clear" : "Click to filter"}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="modules-table-wrap">
                <div className="table-toolbar">
                  <span className="table-info">
                    {filter === "all"
                      ? `Showing all ${displayed.length} of ${blueprints.length} blueprint${blueprints.length !== 1 ? "s" : ""}`
                      : `Showing ${displayed.length} ${filter.replace(/_/g, " ")} blueprint${displayed.length !== 1 ? "s" : ""} of ${blueprints.length}`}
                  </span>
                  <div className="table-toolbar-actions">
                    <input
                      type="text"
                      className="table-search"
                      placeholder="Search blueprints…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />
                    {filter !== "all" && (
                      <button className="btn-secondary" onClick={() => setFilter("all")}>Clear filter</button>
                    )}
                  </div>
                </div>

                {displayed.length === 0 ? (
                  <div className="empty-state">
                    {search.trim() ? `No blueprints match "${search.trim()}".` : `No ${filter.replace(/_/g, " ")} blueprints found — this is a good sign!`}
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table className="modules-table">
                      <thead>
                        <tr>
                          <th><span className="th-tip" data-tooltip-below="The name of this blueprint process">Blueprint Name<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Unique ID of this blueprint">Blueprint ID<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Whether this blueprint is currently active and enforcing stage transitions">Status<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="The CRM module this blueprint process is applied to">Module<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="The picklist field that drives the blueprint stages">Field<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="The record layout this blueprint is associated with">Layout<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Whether this blueprint can be cloned">Clone<span className="th-info">i</span></span></th>
                          {hasCountTool && <th><span className="th-tip" data-tooltip-below="Number of records currently in this blueprint process">Records<span className="th-info">i</span></span></th>}
                          <th><span className="th-tip" data-tooltip-below="The user who created this blueprint">Created By<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="When this blueprint was created">Created Time<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="The user who last modified this blueprint">Modified By<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="When this blueprint was last modified">Modified Time<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Audit issues detected for this blueprint">Findings<span className="th-info">i</span></span></th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayed.map((bp, i) => {
                          const tags = getTags(bp);
                          const active = isBPActive(bp);
                          const rowKey = String(bp.id ?? i);
                          const bpCount = recordCounts[rowKey];
                          const isCountLoading = recordCountLoading === rowKey;
                          return (
                            <React.Fragment key={rowKey}>
                              <tr className={tags.length ? "row-flagged" : ""}>
                                <td className="cell-name">{getBPName(bp)}</td>
                                <td className="cell-mono fn-id">{String(bp.id ?? "—")}</td>
                                <td>
                                  <span className={`bool-badge ${active ? "yes" : "no"}`}>
                                    {active ? "Active" : "Inactive"}
                                  </span>
                                </td>
                                <td className="cell-mono">{getBPModule(bp)}</td>
                                <td className="cell-mono">{getBPField(bp)}</td>
                                <td className="cell-mono">{getBPLayout(bp)}</td>
                                <td>
                                  <span className={`bool-badge ${bp.supported_clone ? "yes" : "no"}`}>
                                    {bp.supported_clone ? "Yes" : "No"}
                                  </span>
                                </td>
                                {hasCountTool && (
                                  <td>
                                    <div className="bp-count-cell">
                                      {bpCount !== undefined
                                        ? <span className="bp-count-val">{bpCount === -1 ? "—" : bpCount}</span>
                                        : <button
                                            className="btn-secondary"
                                            style={{ padding: "2px 8px", fontSize: 11 }}
                                            disabled={isCountLoading}
                                            onClick={() => void loadRecordCount(bp)}
                                          >
                                            {isCountLoading ? <span className="spinner" /> : "Load"}
                                          </button>
                                      }
                                    </div>
                                  </td>
                                )}
                                <td className="cell-mono" style={{ fontSize: 12 }}>{getBPCreatedBy(bp)}</td>
                                <td className="cell-datetime">{formatDateTime(bp.created_time)}</td>
                                <td className="cell-mono" style={{ fontSize: 12 }}>{getBPModifiedBy(bp)}</td>
                                <td className="cell-datetime">{formatDateTime(bp.modified_time)}</td>
                                <td>
                                  <div className="tag-list">
                                    {tags.length === 0
                                      ? <span className="audit-tag tag-ok" title="No issues detected for this blueprint">clean</span>
                                      : tags.map(tag => (
                                          <span key={tag} className={`audit-tag tag-bp-${tag}`} title={
                                            tag === "inactive"            ? "This blueprint is inactive and not enforcing any stage transitions on records." :
                                            tag === "dead_end"            ? "This blueprint has stages with no outgoing transitions — records can get permanently stuck." :
                                            tag === "missing_transitions" ? "Some picklist stages in this blueprint have no connected transitions — those stages are unreachable." :
                                            tag === "incomplete"          ? "This blueprint has transitions with no mandatory fields, validation rules, or actions configured." : tag
                                          }>{tag.replace(/_/g, " ")}</span>
                                        ))}
                                  </div>
                                </td>
                                <td className="cell-actions">
                                  <div className="action-menu-wrap" ref={activeMenu === rowKey ? menuRef : null}>
                                    <button
                                      className={`btn-action${activeMenu === rowKey ? " open" : ""}`}
                                      onClick={e => { e.stopPropagation(); setActiveMenu(activeMenu === rowKey ? null : rowKey); }}
                                      title="Actions"
                                    >⋯</button>
                                    {activeMenu === rowKey && (
                                      <div className="action-dropdown">
                                        <button className="action-dropdown-item" onClick={() => { setDetailBp(bp); setActiveMenu(null); }}>
                                          <span className="action-icon">◈</span>View Details
                                        </button>
                                        {!active && findTool(allTools, "activateBlueprint") && (
                                          <button className="action-dropdown-item" onClick={() => { setConfirmDialog({ type: "activate", bp, moveRecords: false, cloneType: "standalone" }); setActiveMenu(null); }}>
                                            <span className="action-icon">▶</span>Activate
                                          </button>
                                        )}
                                        {active && findTool(allTools, "deactivateBlueprint") && (
                                          <button className="action-dropdown-item" onClick={() => { setConfirmDialog({ type: "deactivate", bp, moveRecords: false, cloneType: "standalone" }); setActiveMenu(null); }}>
                                            <span className="action-icon">⏸</span>Deactivate
                                          </button>
                                        )}
                                        {bp.supported_clone && findTool(allTools, "cloneBlueprint") && (
                                          <button className="action-dropdown-item" onClick={() => { setConfirmDialog({ type: "clone", bp, moveRecords: false, cloneType: "standalone" }); setActiveMenu(null); }}>
                                            <span className="action-icon">⎘</span>Clone
                                          </button>
                                        )}
                                        {config.crmBaseUrl ? (
                                          <button className="action-dropdown-item" onClick={() => { window.open(`${config.crmBaseUrl}/Automation/Blueprints/detail/${bp.id}`, "_blank"); setActiveMenu(null); }}>
                                            <span className="action-icon">↗</span>Open in CRM
                                          </button>
                                        ) : (
                                          <button className="action-dropdown-item" disabled title="Enter your Zoho CRM URL in the connection form to enable this" style={{ opacity: 0.45, cursor: "not-allowed" }}>
                                            <span className="action-icon">↗</span>Open in CRM
                                          </button>
                                        )}
                                        <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(getBPName(bp)); setActiveMenu(null); }}>
                                          <span className="action-icon">⎘</span>Copy Name
                                        </button>
                                        <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(String(bp.id ?? "")); setActiveMenu(null); }}>
                                          <span className="action-icon">⎘</span>Copy Blueprint ID
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* Detail modal */}
      {detailBp && (
        <BlueprintDetailModal
          bp={detailBp}
          config={config}
          allTools={allTools}
          onLog={onLog}
          onClose={() => setDetailBp(null)}
        />
      )}

      {/* Confirm action dialog */}
      {confirmDialog && (
        <ConfirmActionDialog
          dialog={confirmDialog}
          onConfirm={() => void executeAction(confirmDialog)}
          onChange={updates => setConfirmDialog(prev => prev ? { ...prev, ...updates } : null)}
          onClose={() => setConfirmDialog(null)}
          loading={actionLoading}
        />
      )}
    </div>
  );
}
