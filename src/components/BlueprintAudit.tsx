"use client";

import { useState, useEffect } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";

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
  // Real Zoho list API: active is a top-level boolean, status is a string
  active?: boolean;
  status?: string;
  // Real Zoho list API fields
  module?: string | { api_name?: string; name?: string; plural_label?: string };
  field?: { name?: string; id?: string } | null;          // the picklist field (e.g. "Stage")
  layout?: { name?: string; display_label?: string; id?: string } | null;
  supported_clone?: boolean;
  created_by?: { name?: string; id?: string };
  modified_by?: { name?: string; id?: string };
  created_time?: string;
  modified_time?: string;
  // Detail-only fields (not present in list response)
  transitions?: ZohoBPTransition[];
  process_info?: {
    field_label?: string;
    api_name?: string;
    name?: string;
    picklist_values?: Array<{ display_value?: string; value?: string; id?: string }>;
  };
  [key: string]: unknown;
}

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
  // MCP wraps errors in content[].text
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
  // structuredContent error
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
  // Real Zoho API: active is a top-level boolean
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

  // Dead-end: reachable stages (appear as "to") that have no outgoing transitions
  const deadEndStages = [...incomingStages].filter(s => !outgoingStages.has(s));

  // Missing transitions: picklist stages not connected to any transition
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

type BPFilterKey = "all" | "inactive" | "dead_end" | "missing_transitions" | "incomplete";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

export default function BlueprintAudit({ config, tools, onLog }: Props) {
  const [selectedTools, setSelectedTools] = useState<string[]>(tools.length > 0 ? [tools[0].name] : []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [blueprints, setBlueprints] = useState<ZohoBlueprint[]>([]);
  const [filter, setFilter] = useState<BPFilterKey>("all");

  useEffect(() => {
    setSelectedTools(tools.length > 0 ? [tools[0].name] : []);
    setBlueprints([]);
    setError("");
  }, [tools]);

  async function loadBlueprints() {
    if (selectedTools.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const all: ZohoBlueprint[] = [];
      for (const toolName of selectedTools) {
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
      if (all.length === 0 && !error) {
        setError(`No blueprint data found in selected tool${selectedTools.length > 1 ? "s" : ""}.`);
      } else {
        setBlueprints(all);
        setFilter("all");
      }
    } finally {
      setLoading(false);
    }
  }

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

  const displayed = filterMap[filter];

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

  return (
    <div className="modules-audit">
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
          <button onClick={loadBlueprints} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : blueprints.length ? "Reload" : "Load Blueprints"}
          </button>
        </div>
      </div>

      {error && <p className="form-error">⚠ {error}</p>}

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
                className={`finding-card severity-${f.severity} ${filter === f.key ? "active" : ""}`}
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
                  ? `Showing all ${blueprints.length} blueprint${blueprints.length !== 1 ? "s" : ""}`
                  : `Showing ${displayed.length} ${filter.replace(/_/g, " ")} blueprint${displayed.length !== 1 ? "s" : ""} of ${blueprints.length}`}
              </span>
              {filter !== "all" && (
                <button className="btn-secondary" onClick={() => setFilter("all")}>Clear filter</button>
              )}
            </div>

            {displayed.length === 0 ? (
              <div className="empty-state">No {filter.replace(/_/g, " ")} blueprints found — this is a good sign!</div>
            ) : (
              <div className="table-scroll">
                <table className="modules-table">
                  <thead>
                    <tr>
                      <th><span className="th-tip" data-tooltip-below="The name of this blueprint process">Blueprint Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Unique ID of this blueprint">Blueprint ID<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this blueprint is currently active and enforcing stage transitions">Status<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The CRM module this blueprint process is applied to">Module<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The picklist field that drives the blueprint stages (e.g. Stage, Status)">Field<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The record layout this blueprint is associated with">Layout<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this blueprint can be cloned">Supported Clone<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The user who created this blueprint">Created By<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="When this blueprint was created">Created Time<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The user who last modified this blueprint">Modified By<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="When this blueprint was last modified">Modified Time<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Audit issues detected for this blueprint">Findings<span className="th-info">i</span></span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((bp, i) => {
                      const tags = getTags(bp);
                      const active = isBPActive(bp);
                      return (
                        <tr key={i} className={tags.length ? "row-flagged" : ""}>
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
