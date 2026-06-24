"use client";

import { useState, useEffect } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";

interface ZohoWorkflow {
  id?: string;
  name?: string;
  workflow_name?: string;
  status?: string;
  active?: boolean;
  module?: string | { api_name?: string; name?: string; plural_label?: string };
  criteria?: unknown;
  conditions?: unknown;
  trigger_on?: string | string[];
  trigger?: string | string[];
  triggers?: string | string[];
  actions?: unknown[];
  action_list?: unknown[];
  workflow_actions?: unknown[];
  [key: string]: unknown;
}

function extractWorkflowsFromValue(result: unknown): ZohoWorkflow[] {
  if (Array.isArray(result)) {
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      return result as ZohoWorkflow[];
    }
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.workflows)) return r.workflows as ZohoWorkflow[];
    if (Array.isArray(r.workflow_rules)) return r.workflow_rules as ZohoWorkflow[];
    if (Array.isArray(r.data)) return r.data as ZohoWorkflow[];
    for (const val of Object.values(r)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const first = val[0] as Record<string, unknown>;
        if ("workflow_name" in first || ("name" in first && ("trigger_on" in first || "module" in first || "active" in first))) {
          return val as ZohoWorkflow[];
        }
      }
    }
  }
  return [];
}

function extractWorkflows(result: unknown): ZohoWorkflow[] {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const wfs = extractWorkflowsFromValue(parsed);
            if (wfs.length > 0) return wfs;
          } catch { /* not JSON */ }
        }
      }
    }
  }
  return extractWorkflowsFromValue(result);
}

function getName(w: ZohoWorkflow): string {
  return String(w.name ?? w.workflow_name ?? w.id ?? "Unknown");
}

function getModule(w: ZohoWorkflow): string {
  if (!w.module) return "—";
  if (typeof w.module === "string") return w.module;
  const m = w.module as Record<string, unknown>;
  return String(m.api_name ?? m.plural_label ?? m.name ?? "—");
}

function getTriggerEvents(w: ZohoWorkflow): string {
  const t = w.trigger_on ?? w.trigger ?? w.triggers;
  if (!t) return "—";
  if (Array.isArray(t)) return t.join(", ");
  return String(t);
}

function getActionsCount(w: ZohoWorkflow): number {
  const a = w.actions ?? w.action_list ?? w.workflow_actions;
  if (Array.isArray(a)) return a.length;
  return 0;
}

function getCriteria(w: ZohoWorkflow): string {
  const c = w.criteria ?? w.conditions;
  if (!c) return "—";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return `${c.length} condition${c.length !== 1 ? "s" : ""}`;
  if (typeof c === "object") {
    const co = c as Record<string, unknown>;
    if (co.criteria_pattern) return String(co.criteria_pattern);
    if (Array.isArray(co.conditions)) return `${co.conditions.length} condition${co.conditions.length !== 1 ? "s" : ""}`;
    if (co.value) return String(co.value);
  }
  return "Has criteria";
}

function getCriteriaCount(w: ZohoWorkflow): number {
  const c = w.criteria ?? w.conditions;
  if (!c) return 0;
  if (Array.isArray(c)) return c.length;
  if (typeof c === "object") {
    const co = c as Record<string, unknown>;
    if (Array.isArray(co.conditions)) return co.conditions.length;
  }
  return 0;
}

function isActive(w: ZohoWorkflow): boolean {
  if (w.active === false) return false;
  const s = String(w.status ?? "").toLowerCase();
  if (s === "inactive" || s === "disabled" || s === "false") return false;
  return true;
}

type WFFilterKey = "all" | "disabled" | "duplicate" | "conflicting" | "complex";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

export default function WorkflowAudit({ config, tools, onLog }: Props) {
  const [selectedTools, setSelectedTools] = useState<string[]>(tools.length > 0 ? [tools[0].name] : []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [workflows, setWorkflows] = useState<ZohoWorkflow[]>([]);
  const [filter, setFilter] = useState<WFFilterKey>("all");

  useEffect(() => {
    setSelectedTools(tools.length > 0 ? [tools[0].name] : []);
    setWorkflows([]);
    setError("");
  }, [tools]);

  async function loadWorkflows() {
    if (selectedTools.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const all: ZohoWorkflow[] = [];
      for (const toolName of selectedTools) {
        const start = Date.now();
        try {
          const output = await executeTool(config, toolName, {});
          const wfs = extractWorkflows(output);
          if (wfs.length > 0) all.push(...wfs);
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output, status: wfs.length > 0 ? "success" : "error", errorMessage: wfs.length === 0 ? "No workflows found" : undefined, durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Failed";
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
      if (all.length === 0) {
        setError(`No workflow data found in selected tool${selectedTools.length > 1 ? "s" : ""}.`);
      } else {
        setWorkflows(all);
        setFilter("all");
      }
    } finally {
      setLoading(false);
    }
  }

  // Audit categorization
  const disabled = workflows.filter(w => !isActive(w));

  const nameCounts = new Map<string, number>();
  workflows.forEach(w => {
    const n = getName(w).toLowerCase();
    nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  });
  const duplicate = workflows.filter(w => (nameCounts.get(getName(w).toLowerCase()) ?? 0) > 1);

  // Conflicting: same module + same trigger events, different names
  const triggerKey = (w: ZohoWorkflow) => `${getModule(w)}::${getTriggerEvents(w)}`;
  const triggerCounts = new Map<string, number>();
  workflows.forEach(w => {
    const k = triggerKey(w);
    if (k !== "—::—") triggerCounts.set(k, (triggerCounts.get(k) ?? 0) + 1);
  });
  const conflicting = workflows.filter(w => {
    const k = triggerKey(w);
    return k !== "—::—" && (triggerCounts.get(k) ?? 0) > 1 && !duplicate.includes(w);
  });

  const complex = workflows.filter(w => getActionsCount(w) > 5 || getCriteriaCount(w) > 5);

  const filterMap: Record<WFFilterKey, ZohoWorkflow[]> = {
    all: workflows, disabled, duplicate, conflicting, complex,
  };

  const displayed = filterMap[filter];

  function getTags(w: ZohoWorkflow): WFFilterKey[] {
    const tags: WFFilterKey[] = [];
    if (disabled.includes(w)) tags.push("disabled");
    if (duplicate.includes(w)) tags.push("duplicate");
    if (conflicting.includes(w)) tags.push("conflicting");
    if (complex.includes(w)) tags.push("complex");
    return tags;
  }

  const findings: { key: WFFilterKey; label: string; count: number; severity: string; tip: string }[] = [
    { key: "disabled",    label: "Disabled Workflows",    count: disabled.length,    severity: disabled.length > 0 ? "warn" : "ok",                                       tip: "Workflow rules that are currently turned off and not triggering on any record events." },
    { key: "duplicate",   label: "Duplicate Workflows",   count: duplicate.length,   severity: duplicate.length > 0 ? "warn" : "ok",                                      tip: "Multiple workflow rules sharing the same name — may indicate redundancy or copy-paste errors." },
    { key: "conflicting", label: "Conflicting Workflows", count: conflicting.length, severity: conflicting.length > 0 ? "danger" : "ok",                                  tip: "Multiple active workflows on the same module and trigger event. They fire simultaneously and may cause unexpected or duplicate actions." },
    { key: "complex",     label: "Excessive Complexity",  count: complex.length,     severity: complex.length > 3 ? "danger" : complex.length > 0 ? "warn" : "ok",       tip: "Workflows with more than 5 actions or 5 criteria conditions. Complex rules are harder to debug and maintain." },
  ];

  return (
    <div className="modules-audit">
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">⟳</span>
          <h2 className="pane-title">Workflow Rules Audit</h2>
          {workflows.length > 0 && (
            <span className="pane-count">{workflows.length} workflow{workflows.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="audit-toolbar">
          {tools.length > 0 ? (
            <MultiToolSelect tools={tools} selected={selectedTools} onChange={setSelectedTools} />
          ) : (
            <span className="no-tools-hint">No workflow tools found — check connection</span>
          )}
          <button onClick={loadWorkflows} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : workflows.length ? "Reload" : "Load Workflows"}
          </button>
        </div>
      </div>

      {error && <p className="form-error">⚠ {error}</p>}

      {workflows.length === 0 && !error && !loading && (
        <div className="audit-empty">
          <div className="audit-empty-icon">⟳</div>
          <p className="audit-empty-title">No data loaded</p>
          <p className="audit-empty-sub">Select a tool and click "Load Workflows" to run the audit.</p>
        </div>
      )}

      {workflows.length > 0 && (
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
                  ? `Showing all ${workflows.length} workflows`
                  : `Showing ${displayed.length} ${filter} workflow${displayed.length !== 1 ? "s" : ""} of ${workflows.length}`}
              </span>
              {filter !== "all" && (
                <button className="btn-secondary" onClick={() => setFilter("all")}>Clear filter</button>
              )}
            </div>

            {displayed.length === 0 ? (
              <div className="empty-state">No {filter} workflows found — this is a good sign!</div>
            ) : (
              <div className="table-scroll">
                <table className="modules-table">
                  <thead>
                    <tr>
                      <th><span className="th-tip" data-tooltip-below="The name of this workflow rule">Workflow Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this workflow rule is currently active or inactive">Status<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The CRM module this workflow rule applies to">Module<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The conditions that must be met for this workflow to trigger">Criteria<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The record events that cause this workflow to fire (e.g., Created, Modified, Deleted)">Trigger Events<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The number of actions this workflow performs when triggered">Actions<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Audit issues detected for this workflow">Findings<span className="th-info">i</span></span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((w, i) => {
                      const tags = getTags(w);
                      const active = isActive(w);
                      return (
                        <tr key={i} className={tags.length ? "row-flagged" : ""}>
                          <td className="cell-name">{getName(w)}</td>
                          <td>
                            <span className={`bool-badge ${active ? "yes" : "no"}`}>
                              {active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="cell-mono">{getModule(w)}</td>
                          <td className="cell-criteria">{getCriteria(w)}</td>
                          <td className="cell-trigger">{getTriggerEvents(w)}</td>
                          <td>
                            {getActionsCount(w) > 0
                              ? <span className={getActionsCount(w) > 5 ? "count-badge danger" : "count-badge"}>{getActionsCount(w)}</span>
                              : <span className="cell-mono">—</span>}
                          </td>
                          <td>
                            <div className="tag-list">
                              {tags.length === 0
                                ? <span className="audit-tag tag-ok" title="No issues detected for this workflow">clean</span>
                                : tags.map(tag => (
                                    <span key={tag} className={`audit-tag tag-wf-${tag}`} title={
                                      tag === "disabled"    ? "This workflow is currently inactive and not triggering on record events." :
                                      tag === "duplicate"   ? "Another workflow rule shares this exact name — check for redundancy." :
                                      tag === "conflicting" ? "Another active workflow targets the same module and trigger event — they may fire together and cause duplicate actions." :
                                      tag === "complex"     ? "This workflow has more than 5 actions or conditions — consider simplifying." : tag
                                    }>{tag}</span>
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
