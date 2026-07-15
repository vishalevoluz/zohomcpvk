"use client";

import React, { useState, useEffect, useRef } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";
import ScopeHint from "@/components/ScopeHint";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface ZohoWorkflow {
  id?: string;
  name?: string;
  workflow_name?: string;
  status?: string | { active?: boolean };
  active?: boolean;
  module?: string | { api_name?: string; name?: string; plural_label?: string };
  execute_when?: { type?: string; details?: { trigger_module?: { api_name?: string; id?: string }; repeat?: boolean } };
  trigger_on?: string | string[];
  trigger?: string | string[];
  triggers?: string | string[];
  criteria?: unknown;
  conditions?: unknown;
  actions?: unknown[];
  action_list?: unknown[];
  workflow_actions?: unknown[];
  description?: string | null;
  source?: string;
  created_by?: { name?: string; id?: string };
  modified_by?: { name?: string; id?: string };
  created_time?: string;
  modified_time?: string;
  last_executed_time?: string;
  lock?: { status?: boolean; locked_by?: unknown; message?: string | null };
  editable?: boolean;
  deletable?: boolean;
  [key: string]: unknown;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function detectApiError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          const p = JSON.parse(item.text) as Record<string, unknown>;
          if (p.status === "error" && p.code) {
            if (String(p.code) === "OAUTH_SCOPE_MISMATCH") return `OAuth scope error: add ZohoCRM.automation.workflows.READ to your token.`;
            return `Zoho API error [${String(p.code)}]: ${String(p.message ?? "")}`;
          }
        } catch { /* skip */ }
      }
    }
  }
  if (r.isError && r.structuredContent) {
    const d = (r.structuredContent as Record<string, unknown>).data as Record<string, unknown> | undefined;
    if (d?.code) return `Zoho API error [${String(d.code)}]: ${String(d.message ?? "")}`;
  }
  return null;
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

function extractWorkflowsFromValue(result: unknown): ZohoWorkflow[] {
  if (Array.isArray(result)) {
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) return result as ZohoWorkflow[];
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.workflows)) return r.workflows as ZohoWorkflow[];
    if (Array.isArray(r.workflow_rules)) return r.workflow_rules as ZohoWorkflow[];
    if (Array.isArray(r.data)) return r.data as ZohoWorkflow[];
    for (const val of Object.values(r)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const f = val[0] as Record<string, unknown>;
        if ("workflow_name" in f || "execute_when" in f || ("name" in f && ("trigger_on" in f || "module" in f || "last_executed_time" in f))) return val as ZohoWorkflow[];
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
          try { const wfs = extractWorkflowsFromValue(JSON.parse(item.text)); if (wfs.length > 0) return wfs; } catch { /* skip */ }
        }
      }
    }
  }
  return extractWorkflowsFromValue(result);
}

function extractSingleWorkflow(result: unknown): ZohoWorkflow | null {
  const p = parseJsonFromMcp(result);
  if (!p) return null;
  if (Array.isArray(p.workflow_rules) && p.workflow_rules.length > 0) return (p.workflow_rules as ZohoWorkflow[])[0];
  if (Array.isArray(p.workflows) && p.workflows.length > 0) return (p.workflows as ZohoWorkflow[])[0];
  if (p.id || p.name || p.workflow_name) return p as unknown as ZohoWorkflow;
  return null;
}

function extractList(result: unknown): Record<string, unknown>[] {
  const p = parseJsonFromMcp(result);
  if (!p) return [];
  for (const v of Object.values(p)) {
    if (Array.isArray(v) && v.length > 0) return v as Record<string, unknown>[];
  }
  return [];
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function getName(w: ZohoWorkflow): string { return String(w.name ?? w.workflow_name ?? w.id ?? "Unknown"); }
function getModule(w: ZohoWorkflow): string {
  if (!w.module) return "—";
  if (typeof w.module === "string") return w.module;
  const m = w.module as Record<string, unknown>;
  return String(m.api_name ?? m.plural_label ?? m.name ?? "—");
}
function getTriggerEvents(w: ZohoWorkflow): string {
  if (w.execute_when?.type) return String(w.execute_when.type).replace(/_/g, " ");
  const t = w.trigger_on ?? w.trigger ?? w.triggers;
  if (!t) return "—";
  return Array.isArray(t) ? t.join(", ") : String(t);
}
function getRepeat(w: ZohoWorkflow): string {
  const r = w.execute_when?.details?.repeat;
  return r === undefined ? "—" : r ? "Yes" : "No";
}
function getActionsCount(w: ZohoWorkflow): number {
  const a = w.actions ?? w.action_list ?? w.workflow_actions;
  return Array.isArray(a) ? a.length : 0;
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
  }
  return "Has criteria";
}
function getCriteriaCount(w: ZohoWorkflow): number {
  const c = w.criteria ?? w.conditions;
  if (!c) return 0;
  if (Array.isArray(c)) return c.length;
  if (typeof c === "object") { const co = c as Record<string, unknown>; if (Array.isArray(co.conditions)) return co.conditions.length; }
  return 0;
}
function isActive(w: ZohoWorkflow): boolean {
  if (w.status && typeof w.status === "object") { const s = w.status as { active?: boolean }; if (s.active === false) return false; if (s.active === true) return true; }
  if (w.active === false) return false;
  const s = String(w.status ?? "").toLowerCase();
  return !(s === "inactive" || s === "disabled" || s === "false");
}
function isLocked(w: ZohoWorkflow): boolean { return w.lock?.status === true; }
function getCreatedBy(w: ZohoWorkflow): string { return String(w.created_by?.name ?? "—"); }
function getModifiedBy(w: ZohoWorkflow): string { return String(w.modified_by?.name ?? "—"); }
function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return String(iso); }
}
function findTool(allTools: McpTool[], name: string): McpTool | undefined { return allTools.find(t => t.name === name); }

// ─── Tool label map ───────────────────────────────────────────────────────────

const WF_TOOL_LABELS: Record<string, string> = {
  getWorkflowRules: "List Rules",
  getWorkflowRuleById: "View Detail",
  getWorkflowRuleUsage: "Usage Stats",
  getWorkflowRulesCount: "Rules Count",
  getWorkflowRulesActionsCount: "Actions Count",
  getWorkflowConfigurations: "Configurations",
  postWorkflowRule: "Create Rule",
  updateWorkflowRuleById: "Update Rule",
  updateWorkflowRule: "Bulk Update",
  deleteWorkflowRuleById: "Delete Rule",
  deleteWorkflowRules: "Bulk Delete",
  getConnectedWorkflows: "Connected Workflows",
  getConnectedWorkflowById: "Connected Detail",
  getConnectedWorkflowRules: "Connected Rules",
  getConnectedWorkflowRuleById: "Connected Rule Detail",
  getConnectedWorkflowActionsCount: "Connected Actions",
  getConnectedWorkflowConfigurations: "Connected Config",
  activateConnectedWorkflow: "Activate Connected",
  postConnectedWorkflows: "Create Connected",
  deleteConnectedWorkflow: "Delete Connected",
  deleteConnectedWorkflowRule: "Delete Connected Rule",
  updateConnectedWorkflow: "Update Connected",
  updateConnectedWorkflowRule: "Update Connected Rule",
};

// ─── Workflow Detail Modal ────────────────────────────────────────────────────

type WFDetailTab = "overview" | "usage" | "update" | "create";

function WorkflowDetailModal({
  wf: initialWf,
  config,
  allTools,
  onLog,
  onClose,
  onDeleted,
}: {
  wf: ZohoWorkflow;
  config: McpConfig;
  allTools: McpTool[];
  onLog: (log: ExecutionLog) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [fullWf, setFullWf] = useState<ZohoWorkflow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [usage, setUsage] = useState<Record<string, unknown> | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState("");

  const [actionsCount, setActionsCount] = useState<Record<string, unknown> | null>(null);

  const [configs, setConfigs] = useState<Record<string, unknown> | null>(null);
  const [configsLoading, setConfigsLoading] = useState(false);

  const [updateJson, setUpdateJson] = useState("");
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [createJson, setCreateJson] = useState(
    '{\n  "workflow_rules": [{\n    "name": "New Rule",\n    "module": "Leads",\n    "execute_when": { "type": "CREATE" },\n    "actions": []\n  }]\n}'
  );
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [activeTab, setActiveTab] = useState<WFDetailTab>("overview");

  const canDelete = !!findTool(allTools, "deleteWorkflowRuleById");
  const canUpdate = !!findTool(allTools, "updateWorkflowRuleById");
  const canCreate = !!findTool(allTools, "postWorkflowRule");
  const canConfigs = !!findTool(allTools, "getWorkflowConfigurations");

  const displayWf = fullWf ?? initialWf;
  const wfLocked = isLocked(displayWf);
  const wfActive = isActive(displayWf);
  const connectedTools = Object.keys(WF_TOOL_LABELS).filter(n => !!findTool(allTools, n));

  useEffect(() => {
    if (findTool(allTools, "getWorkflowRuleById") && initialWf.id) void loadFullDetail();
    else setFullWf(initialWf);
    if (findTool(allTools, "getWorkflowRuleUsage") && initialWf.id) void loadUsage();
    if (findTool(allTools, "getWorkflowRulesActionsCount") && initialWf.id) void loadActionsCount();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadFullDetail() {
    setLoadingDetail(true); setDetailError("");
    const start = Date.now();
    try {
      const result = await executeTool(config, "getWorkflowRuleById", { id: initialWf.id });
      const apiErr = detectApiError(result);
      if (apiErr) { setDetailError(apiErr); setFullWf(initialWf); return; }
      const detail = extractSingleWorkflow(result);
      setFullWf(detail ?? initialWf);
      if (detail) setUpdateJson(JSON.stringify(detail, null, 2));
      onLog({ id: crypto.randomUUID(), tool: "getWorkflowRuleById", input: { id: initialWf.id }, output: result, status: detail ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setDetailError(e instanceof Error ? e.message : "Failed"); setFullWf(initialWf); }
    finally { setLoadingDetail(false); }
  }

  async function loadUsage() {
    setUsageLoading(true); setUsageError("");
    const start = Date.now();
    try {
      const result = await executeTool(config, "getWorkflowRuleUsage", { workflowRuleId: initialWf.id });
      const apiErr = detectApiError(result);
      if (apiErr) { setUsageError(apiErr); return; }
      const parsed = parseJsonFromMcp(result);
      setUsage(parsed);
      onLog({ id: crypto.randomUUID(), tool: "getWorkflowRuleUsage", input: { workflowRuleId: initialWf.id }, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setUsageError(e instanceof Error ? e.message : "Failed"); }
    finally { setUsageLoading(false); }
  }

  async function loadActionsCount() {
    const start = Date.now();
    try {
      const result = await executeTool(config, "getWorkflowRulesActionsCount", { rule_ids: String(initialWf.id) });
      const parsed = parseJsonFromMcp(result);
      if (parsed) setActionsCount(parsed);
      onLog({ id: crypto.randomUUID(), tool: "getWorkflowRulesActionsCount", input: { rule_ids: String(initialWf.id) }, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch { /* ignore */ }
  }

  async function loadConfigs() {
    setConfigsLoading(true);
    const start = Date.now();
    try {
      const mod = getModule(displayWf);
      const input = mod !== "—" ? { module: mod } : {};
      const result = await executeTool(config, "getWorkflowConfigurations", input);
      const parsed = parseJsonFromMcp(result);
      if (parsed) setConfigs(parsed);
      onLog({ id: crypto.randomUUID(), tool: "getWorkflowConfigurations", input, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch { /* ignore */ }
    finally { setConfigsLoading(false); }
  }

  async function handleUpdate() {
    if (!initialWf.id || !updateJson.trim()) return;
    setUpdateMsg(null);
    let payload: unknown;
    try { payload = JSON.parse(updateJson); } catch { setUpdateMsg({ ok: false, text: "Invalid JSON" }); return; }
    setUpdateLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "updateWorkflowRuleById", { id: initialWf.id, ...(payload as Record<string, unknown>) });
      const apiErr = detectApiError(result);
      setUpdateMsg(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "Workflow rule updated successfully." });
      onLog({ id: crypto.randomUUID(), tool: "updateWorkflowRuleById", input: { id: initialWf.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setUpdateMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" }); }
    finally { setUpdateLoading(false); }
  }

  async function handleCreate() {
    setCreateMsg(null);
    let payload: unknown;
    try { payload = JSON.parse(createJson); } catch { setCreateMsg({ ok: false, text: "Invalid JSON" }); return; }
    setCreateLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "postWorkflowRule", payload as Record<string, unknown>);
      const apiErr = detectApiError(result);
      setCreateMsg(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "Workflow rule created. Reload the list to see it." });
      onLog({ id: crypto.randomUUID(), tool: "postWorkflowRule", input: payload as Record<string, unknown>, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setCreateMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" }); }
    finally { setCreateLoading(false); }
  }

  async function handleDelete() {
    if (!initialWf.id) return;
    setActionLoading(true); setActionMsg(null);
    const start = Date.now();
    try {
      const result = await executeTool(config, "deleteWorkflowRuleById", { id: initialWf.id });
      const apiErr = detectApiError(result);
      if (apiErr) { setActionMsg({ ok: false, text: apiErr }); }
      else {
        setActionMsg({ ok: true, text: "Deleted." });
        onDeleted(String(initialWf.id));
        setTimeout(onClose, 900);
      }
      onLog({ id: crypto.randomUUID(), tool: "deleteWorkflowRuleById", input: { id: initialWf.id }, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setActionMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" }); }
    finally { setActionLoading(false); }
  }

  const tabs: WFDetailTab[] = ["overview", "usage", "update", ...(canCreate ? ["create" as WFDetailTab] : [])];

  return (
    <div className="evoai-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bp-detail-panel">

        {/* Header */}
        <div className="bp-detail-header">
          <div className="bp-detail-header-left">
            <span className="pane-icon" style={{ fontSize: 20 }}>⟳</span>
            <div>
              <div className="bp-detail-title">{getName(displayWf)}</div>
              <div className="bp-detail-sub">ID: {String(displayWf.id ?? "—")} · {getModule(displayWf)}</div>
            </div>
          </div>
          <div className="bp-detail-header-actions">
            {loadingDetail && <span className="spinner" />}
            <span className={`bool-badge ${wfActive ? "yes" : "no"}`}>{wfActive ? "Active" : "Inactive"}</span>
            {wfLocked && <span className="audit-tag tag-bp-incomplete">Locked</span>}
            {canUpdate && (
              <button className="btn-secondary" style={{ padding: "5px 14px", fontSize: 12 }} onClick={() => { setActiveTab("update"); setShowDeleteConfirm(false); }}>
                ✎ Update
              </button>
            )}
            {canDelete && !wfLocked && (
              <button className="btn-secondary btn-danger-outline" style={{ padding: "5px 14px", fontSize: 12 }} onClick={() => { setShowDeleteConfirm(v => !v); setActionMsg(null); }}>
                🗑 Delete
              </button>
            )}
            <button className="evoai-close" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Delete confirm panel */}
        {showDeleteConfirm && (
          <div className="bp-action-panel bp-action-deactivate">
            <div className="bp-action-panel-body">
              <p className="bp-action-desc">Permanently delete <strong>{getName(displayWf)}</strong>? This cannot be undone.</p>
              {actionMsg && <div className={actionMsg.ok ? "form-success" : "form-error"} style={{ marginTop: 8 }}>{actionMsg.ok ? "✓" : "⚠"} {actionMsg.text}</div>}
            </div>
            <div className="bp-action-panel-footer">
              <button className="btn-secondary" onClick={() => { setShowDeleteConfirm(false); setActionMsg(null); }} disabled={actionLoading}>Cancel</button>
              <button className="btn-connect btn-danger" onClick={() => void handleDelete()} disabled={actionLoading}>
                {actionLoading ? <><span className="spinner" /> Deleting…</> : "Confirm Delete"}
              </button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="bp-detail-tabs">
          {tabs.map(s => (
            <button key={s} className={`bp-detail-tab${activeTab === s ? " active" : ""}`} onClick={() => setActiveTab(s)}>
              {s === "overview" && "Overview"}
              {s === "usage" && "Usage Stats"}
              {s === "update" && "Update"}
              {s === "create" && "+ Create Rule"}
            </button>
          ))}
        </div>

        {detailError && <div className="form-error" style={{ margin: "12px 20px 0" }}>⚠ {detailError}</div>}

        <div className="bp-detail-body">

          {/* Overview */}
          {activeTab === "overview" && (
            <div>
              <div className="bp-info-grid">
                <div className="bp-info-row"><span className="bp-info-label">Module</span><span className="bp-info-value">{getModule(displayWf)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Execute When</span><span className="bp-info-value">{getTriggerEvents(displayWf)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Repeat</span><span className="bp-info-value">{getRepeat(displayWf)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Criteria</span><span className="bp-info-value">{getCriteria(displayWf)}</span></div>
                <div className="bp-info-row">
                  <span className="bp-info-label">Actions</span>
                  <span className="bp-info-value" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {getActionsCount(displayWf) > 0 ? String(getActionsCount(displayWf)) : "—"}
                    {actionsCount && <span className="bp-meta-chip">{JSON.stringify(actionsCount)}</span>}
                  </span>
                </div>
                <div className="bp-info-row"><span className="bp-info-label">Description</span><span className="bp-info-value">{String(displayWf.description ?? "—")}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Locked</span><span className={`bool-badge ${wfLocked ? "no" : "yes"}`}>{wfLocked ? "Locked" : "No"}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Editable</span><span className={`bool-badge ${displayWf.editable === false ? "no" : "yes"}`}>{displayWf.editable === false ? "No" : "Yes"}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Created By</span><span className="bp-info-value">{getCreatedBy(displayWf)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Created At</span><span className="bp-info-value">{formatDateTime(displayWf.created_time)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Modified By</span><span className="bp-info-value">{getModifiedBy(displayWf)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Modified At</span><span className="bp-info-value">{formatDateTime(displayWf.modified_time)}</span></div>
                <div className="bp-info-row"><span className="bp-info-label">Last Executed</span><span className="bp-info-value">{formatDateTime(displayWf.last_executed_time as string)}</span></div>
              </div>
              {connectedTools.length > 0 && (
                <div className="bp-connected-tools" style={{ marginTop: 16 }}>
                  <span className="bp-connected-tools-label">Connected tools</span>
                  <div className="bp-tool-chips">
                    {connectedTools.map(n => <span key={n} className="bp-tool-chip">{WF_TOOL_LABELS[n]}</span>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Usage Stats */}
          {activeTab === "usage" && (
            <div>
              {usageLoading && <div style={{ padding: "24px 0", textAlign: "center" }}><span className="spinner" /> Loading usage stats…</div>}
              {usageError && <div className="form-error">⚠ {usageError}</div>}
              {!usageLoading && !usage && !usageError && (
                <div className="audit-empty"><p className="audit-empty-sub">{findTool(allTools, "getWorkflowRuleUsage") ? "No usage data returned." : "getWorkflowRuleUsage is not in your connected tools."}</p></div>
              )}
              {usage && (
                <div className="bp-info-grid">
                  {Object.entries(usage).map(([k, v]) => (
                    <div key={k} className="bp-info-row">
                      <span className="bp-info-label">{k.replace(/_/g, " ")}</span>
                      <span className="bp-info-value">
                        {typeof v === "object" && v !== null ? (
                          <div className="bp-analysis-bar" style={{ marginTop: 0 }}>
                            {Object.entries(v as Record<string, unknown>).map(([ek, ev]) => (
                              <span key={ek} className="bp-stat"><strong>{String(ev)}</strong> {ek.replace(/_/g, " ")}</span>
                            ))}
                          </div>
                        ) : String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Update */}
          {activeTab === "update" && (
            <div>
              {!canUpdate ? (
                <div className="audit-empty"><p className="audit-empty-sub">updateWorkflowRuleById is not in your connected tools.</p></div>
              ) : (
                <>
                  <p className="bp-manage-desc" style={{ marginBottom: 12 }}>
                    Edit the JSON. Only include fields to change — existing actions are preserved unless explicitly listed. Add <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>_delete: null</code> to remove an action. Locked rules cannot be updated.
                  </p>
                  {updateMsg && <div className={updateMsg.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>{updateMsg.ok ? "✓" : "⚠"} {updateMsg.text}</div>}
                  <textarea className="bp-json-editor" value={updateJson} onChange={e => setUpdateJson(e.target.value)} rows={16} />
                  <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                    <button className="btn-connect" disabled={!updateJson.trim() || updateLoading || wfLocked} onClick={() => void handleUpdate()}>
                      {updateLoading ? <><span className="spinner" /> Updating…</> : "Save Changes"}
                    </button>
                    {wfLocked && <span className="form-error" style={{ display: "inline-flex", padding: "5px 12px" }}>Rule is locked — cannot update</span>}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Create Rule */}
          {activeTab === "create" && canCreate && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12 }}>
                <p className="bp-manage-desc" style={{ flex: 1 }}>
                  PREREQUISITES: Call <strong>getWorkflowConfigurations</strong> first to check supported triggers for your module. Body must contain a <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>workflow_rules</code> array with exactly 1 rule.
                </p>
                {canConfigs && (
                  <button className="btn-secondary" style={{ fontSize: 12, flexShrink: 0 }} onClick={() => void loadConfigs()} disabled={configsLoading}>
                    {configsLoading ? <><span className="spinner" /> Loading…</> : "Load Configs"}
                  </button>
                )}
              </div>
              {configs && (
                <div className="bp-manage-card" style={{ marginBottom: 14 }}>
                  <div className="bp-tab-toolbar"><h4 className="bp-manage-title">Available Configurations</h4><button className="btn-secondary" style={{ fontSize: 12 }} onClick={() => setConfigs(null)}>Close</button></div>
                  <pre className="bp-json-preview" style={{ maxHeight: 160 }}>{JSON.stringify(configs, null, 2)}</pre>
                </div>
              )}
              {createMsg && <div className={createMsg.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>{createMsg.ok ? "✓" : "⚠"} {createMsg.text}</div>}
              <textarea className="bp-json-editor" value={createJson} onChange={e => setCreateJson(e.target.value)} rows={12} />
              <div style={{ marginTop: 12 }}>
                <button className="btn-connect" disabled={!createJson.trim() || createLoading} onClick={() => void handleCreate()}>
                  {createLoading ? <><span className="spinner" /> Creating…</> : "Create Workflow Rule"}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type WFFilterKey = "all" | "disabled" | "duplicate" | "conflicting" | "complex";
type WFMainTab = "workflows" | "connected" | "create";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  allTools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

export default function WorkflowAudit({ config, tools, allTools, onLog }: Props) {
  const [selectedTools, setSelectedTools] = useState<string[]>(() => tools.map(t => t.name));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [workflows, setWorkflows] = useState<ZohoWorkflow[]>([]);
  const [filter, setFilter] = useState<WFFilterKey>("all");
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [detailWf, setDetailWf] = useState<ZohoWorkflow | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [rulesCount, setRulesCount] = useState<Record<string, unknown> | null>(null);
  const [rulesCountLoading, setRulesCountLoading] = useState(false);
  const [rulesCountExpanded, setRulesCountExpanded] = useState(false);

  const [activeTab, setActiveTab] = useState<WFMainTab>("workflows");

  const [connectedWfs, setConnectedWfs] = useState<Record<string, unknown>[]>([]);
  const [connectedLoading, setConnectedLoading] = useState(false);
  const [connectedError, setConnectedError] = useState("");
  const [connectedDetail, setConnectedDetail] = useState<Record<string, unknown> | null>(null);
  const [connectedDetailLoading, setConnectedDetailLoading] = useState<string | null>(null);

  const [createJson, setCreateJson] = useState(
    '{\n  "workflow_rules": [{\n    "name": "New Rule",\n    "module": "Leads",\n    "execute_when": { "type": "CREATE" },\n    "actions": []\n  }]\n}'
  );
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);

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
    setWorkflows([]);
    setError("");
    setRulesCount(null);
    setActionMessage(null);
    setConnectedWfs([]);
    if (toolNames.length > 0) {
      void loadWorkflows(toolNames);
      if (findTool(allTools, "getWorkflowRulesCount")) void loadRulesCount();
    }
  }, [tools]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTab === "connected" && connectedWfs.length === 0 && !connectedLoading && findTool(allTools, "getConnectedWorkflows")) {
      void loadConnectedWorkflows();
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadWorkflows(overrideTools?: string[]) {
    const toolsToUse = overrideTools ?? selectedTools;
    if (toolsToUse.length === 0) return;
    setLoading(true); setError(""); setActionMessage(null);
    try {
      const all: ZohoWorkflow[] = [];
      for (const toolName of toolsToUse) {
        const start = Date.now();
        try {
          const output = await executeTool(config, toolName, {});
          const wfs = extractWorkflows(output);
          if (wfs.length > 0) all.push(...wfs);
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output, status: wfs.length > 0 ? "success" : "error", errorMessage: wfs.length === 0 ? "No workflows found" : undefined, durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
      if (all.length === 0) setError(`No workflow data found in selected tool${toolsToUse.length > 1 ? "s" : ""}.`);
      else { setWorkflows(all); setFilter("all"); }
    } finally { setLoading(false); }
  }

  async function loadRulesCount() {
    setRulesCountLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "getWorkflowRulesCount", {});
      const apiErr = detectApiError(result);
      if (apiErr) return;
      const parsed = parseJsonFromMcp(result);
      if (parsed) { setRulesCount(parsed); setRulesCountExpanded(true); }
      onLog({ id: crypto.randomUUID(), tool: "getWorkflowRulesCount", input: {}, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch { /* ignore */ }
    finally { setRulesCountLoading(false); }
  }

  async function loadConnectedWorkflows() {
    setConnectedLoading(true); setConnectedError("");
    const start = Date.now();
    try {
      const result = await executeTool(config, "getConnectedWorkflows", {});
      const apiErr = detectApiError(result);
      if (apiErr) { setConnectedError(apiErr); return; }
      const list = extractList(result);
      setConnectedWfs(list);
      onLog({ id: crypto.randomUUID(), tool: "getConnectedWorkflows", input: {}, output: result, status: list.length > 0 ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setConnectedError(e instanceof Error ? e.message : "Failed"); }
    finally { setConnectedLoading(false); }
  }

  async function loadConnectedDetail(id: string) {
    setConnectedDetailLoading(id);
    const start = Date.now();
    try {
      const result = await executeTool(config, "getConnectedWorkflowById", { id });
      const parsed = parseJsonFromMcp(result);
      if (parsed) setConnectedDetail(prev => (prev && (prev as Record<string,unknown>).id === id ? null : parsed));
      onLog({ id: crypto.randomUUID(), tool: "getConnectedWorkflowById", input: { id }, output: result, status: parsed ? "success" : "error", durationMs: Date.now() - start, timestamp: new Date() });
    } catch { /* ignore */ }
    finally { setConnectedDetailLoading(null); }
  }

  async function handleCreateWorkflow() {
    setCreateMsg(null);
    let payload: unknown;
    try { payload = JSON.parse(createJson); } catch { setCreateMsg({ ok: false, text: "Invalid JSON" }); return; }
    setCreateLoading(true);
    const start = Date.now();
    try {
      const result = await executeTool(config, "postWorkflowRule", payload as Record<string, unknown>);
      const apiErr = detectApiError(result);
      setCreateMsg(apiErr ? { ok: false, text: apiErr } : { ok: true, text: "Workflow rule created. Reload to see it." });
      onLog({ id: crypto.randomUUID(), tool: "postWorkflowRule", input: payload as Record<string, unknown>, output: result, status: apiErr ? "error" : "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e) { setCreateMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" }); }
    finally { setCreateLoading(false); }
  }

  // Derived
  const disabled = workflows.filter(w => !isActive(w));
  const nameCounts = new Map<string, number>();
  workflows.forEach(w => { const n = getName(w).toLowerCase(); nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1); });
  const duplicate = workflows.filter(w => (nameCounts.get(getName(w).toLowerCase()) ?? 0) > 1);
  const triggerKey = (w: ZohoWorkflow) => `${getModule(w)}::${getTriggerEvents(w)}`;
  const triggerCounts = new Map<string, number>();
  workflows.forEach(w => { const k = triggerKey(w); if (k !== "—::—") triggerCounts.set(k, (triggerCounts.get(k) ?? 0) + 1); });
  const conflicting = workflows.filter(w => { const k = triggerKey(w); return k !== "—::—" && (triggerCounts.get(k) ?? 0) > 1 && !duplicate.includes(w); });
  const complex = workflows.filter(w => getActionsCount(w) > 5 || getCriteriaCount(w) > 5);
  const filterMap: Record<WFFilterKey, ZohoWorkflow[]> = { all: workflows, disabled, duplicate, conflicting, complex };
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
    { key: "disabled",    label: "Disabled Workflows",    count: disabled.length,    severity: disabled.length > 0 ? "warn" : "ok",                                 tip: "Workflow rules that are currently turned off." },
    { key: "duplicate",   label: "Duplicate Workflows",   count: duplicate.length,   severity: duplicate.length > 0 ? "warn" : "ok",                                tip: "Multiple workflow rules sharing the same name." },
    { key: "conflicting", label: "Conflicting Workflows", count: conflicting.length, severity: conflicting.length > 0 ? "danger" : "ok",                            tip: "Multiple active workflows on the same module and trigger event." },
    { key: "complex",     label: "Excessive Complexity",  count: complex.length,     severity: complex.length > 3 ? "danger" : complex.length > 0 ? "warn" : "ok", tip: "Workflows with more than 5 actions or criteria conditions." },
  ];

  const hasConnectedTool = !!findTool(allTools, "getConnectedWorkflows");
  const hasCreateTool = !!findTool(allTools, "postWorkflowRule");
  const hasCountTool = !!findTool(allTools, "getWorkflowRulesCount");

  return (
    <div className="modules-audit">
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">⟳</span>
          <h2 className="pane-title">Workflow Rules Audit</h2>
          {workflows.length > 0 && <span className="pane-count">{workflows.length} workflow{workflows.length !== 1 ? "s" : ""}</span>}
        </div>
        <div className="audit-toolbar">
          {tools.length > 0 ? (
            <MultiToolSelect tools={tools} selected={selectedTools} onChange={setSelectedTools} />
          ) : (
            <span className="no-tools-hint">No workflow tools found — check connection</span>
          )}
          <button onClick={() => void loadWorkflows()} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : "↺ Reload"}
          </button>
          {hasCountTool && (
            <button onClick={() => void loadRulesCount()} disabled={rulesCountLoading} className="btn-secondary" title="Load rules count and org limits">
              {rulesCountLoading ? <><span className="spinner" /> …</> : "Load Limits"}
            </button>
          )}
        </div>
      </div>

      {/* Rules count banner */}
      {rulesCount && (
        <div className="bp-meta-banner">
          <div className="bp-meta-banner-header" onClick={() => setRulesCountExpanded(v => !v)}>
            <span className="bp-meta-banner-title">Workflow Rules — Limits &amp; Usage</span>
            <span className="bp-meta-banner-toggle">{rulesCountExpanded ? "▲" : "▼"}</span>
          </div>
          {rulesCountExpanded ? (
            <div className="bp-meta-body">
              {Object.entries(rulesCount).map(([k, v]) => (
                <div key={k} className="bp-meta-row">
                  <span className="bp-meta-key">{k}</span>
                  <span className="bp-meta-val">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="bp-meta-summary">
              {Object.entries(rulesCount).slice(0, 4).map(([k, v]) => (
                <span key={k} className="bp-meta-chip"><strong>{k}:</strong> {typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {actionMessage && (
        <div className={actionMessage.ok ? "form-success" : "form-error"} style={{ marginTop: 12 }}>
          {actionMessage.ok ? "✓" : "⚠"} {actionMessage.text}
          <button className="bp-dismiss" onClick={() => setActionMessage(null)}>✕</button>
        </div>
      )}

      {error && <ScopeHint scopes={["getWorkflowRules"]} />}

      {(workflows.length > 0 || hasConnectedTool || hasCreateTool) && (
        <div className="bp-tabs">
          <button className={`bp-tab${activeTab === "workflows" ? " active" : ""}`} onClick={() => setActiveTab("workflows")}>
            Workflows{workflows.length > 0 ? ` (${workflows.length})` : ""}
          </button>
          {hasConnectedTool && (
            <button className={`bp-tab${activeTab === "connected" ? " active" : ""}`} onClick={() => setActiveTab("connected")}>
              Connected{connectedWfs.length > 0 ? ` (${connectedWfs.length})` : ""}
            </button>
          )}
          {hasCreateTool && (
            <button className={`bp-tab${activeTab === "create" ? " active" : ""}`} onClick={() => setActiveTab("create")}>
              + Create Rule
            </button>
          )}
        </div>
      )}

      {/* Workflows tab */}
      {activeTab === "workflows" && (
        <>
          {workflows.length === 0 && !error && !loading && (
            <div className="audit-empty">
              <div className="audit-empty-icon">⟳</div>
              <p className="audit-empty-title">No data loaded</p>
              <p className="audit-empty-sub">Connect to MCP to auto-load workflow rules.</p>
            </div>
          )}
          {workflows.length > 0 && (
            <>
              <div className="findings-grid">
                {findings.map(f => (
                  <button key={f.key} data-tooltip={f.tip} className={`finding-card severity-${f.severity}${filter === f.key ? " active" : ""}`} onClick={() => setFilter(filter === f.key ? "all" : f.key)}>
                    <span className="finding-count">{f.count}</span>
                    <span className="finding-label">{f.label}</span>
                    {f.count > 0 && <span className="finding-hint">{filter === f.key ? "Click to clear" : "Click to filter"}</span>}
                  </button>
                ))}
              </div>
              <div className="modules-table-wrap">
                <div className="table-toolbar">
                  <span className="table-info">
                    {filter === "all" ? `Showing all ${workflows.length} workflows` : `Showing ${displayed.length} ${filter} workflow${displayed.length !== 1 ? "s" : ""} of ${workflows.length}`}
                  </span>
                  {filter !== "all" && <button className="btn-secondary" onClick={() => setFilter("all")}>Clear filter</button>}
                </div>
                {displayed.length === 0 ? (
                  <div className="empty-state">No {filter} workflows found — good!</div>
                ) : (
                  <div className="table-scroll">
                    <table className="modules-table">
                      <thead>
                        <tr>
                          <th><span className="th-tip" data-tooltip-below="Workflow rule name">Workflow Name<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Unique workflow rule ID">Workflow ID<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Active or inactive">Status<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="CRM module">Module<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="When this workflow fires">Execute When<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Repeats on every edit">Repeat<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Trigger conditions">Criteria<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Number of actions">Actions<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Locked for editing">Locked<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Created by">Created By<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Created time">Created Time<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Modified by">Modified By<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Modified time">Modified Time<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Last triggered time">Last Executed<span className="th-info">i</span></span></th>
                          <th><span className="th-tip" data-tooltip-below="Audit issues">Findings<span className="th-info">i</span></span></th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayed.map((w, i) => {
                          const tags = getTags(w);
                          const active = isActive(w);
                          const rowKey = String(w.id ?? i);
                          return (
                            <React.Fragment key={rowKey}>
                              <tr className={tags.length ? "row-flagged" : ""}>
                                <td className="cell-name">{getName(w)}</td>
                                <td className="cell-mono fn-id">{String(w.id ?? "—")}</td>
                                <td><span className={`bool-badge ${active ? "yes" : "no"}`}>{active ? "Active" : "Inactive"}</span></td>
                                <td className="cell-mono">{getModule(w)}</td>
                                <td className="cell-trigger">{getTriggerEvents(w)}</td>
                                <td><span className={`bool-badge ${getRepeat(w) === "Yes" ? "no" : getRepeat(w) === "No" ? "yes" : ""}`}>{getRepeat(w)}</span></td>
                                <td className="cell-criteria">{getCriteria(w)}</td>
                                <td>{getActionsCount(w) > 0 ? <span className={getActionsCount(w) > 5 ? "count-badge danger" : "count-badge"}>{getActionsCount(w)}</span> : <span className="cell-mono">—</span>}</td>
                                <td><span className={`bool-badge ${isLocked(w) ? "no" : "yes"}`}>{isLocked(w) ? "Locked" : "No"}</span></td>
                                <td className="cell-mono" style={{ fontSize: 12 }}>{getCreatedBy(w)}</td>
                                <td className="cell-datetime">{formatDateTime(w.created_time as string)}</td>
                                <td className="cell-mono" style={{ fontSize: 12 }}>{getModifiedBy(w)}</td>
                                <td className="cell-datetime">{formatDateTime(w.modified_time as string)}</td>
                                <td className="cell-datetime">{formatDateTime(w.last_executed_time as string)}</td>
                                <td>
                                  <div className="tag-list">
                                    {tags.length === 0
                                      ? <span className="audit-tag tag-ok">clean</span>
                                      : tags.map(tag => (
                                          <span key={tag} className={`audit-tag tag-wf-${tag}`} title={
                                            tag === "disabled"    ? "This workflow is currently inactive." :
                                            tag === "duplicate"   ? "Another workflow shares this exact name." :
                                            tag === "conflicting" ? "Another active workflow targets the same module and trigger." :
                                            tag === "complex"     ? "More than 5 actions or conditions." : tag
                                          }>{tag}</span>
                                        ))}
                                  </div>
                                </td>
                                <td className="cell-actions">
                                  <div className="action-menu-wrap" ref={activeMenu === rowKey ? menuRef : null}>
                                    <button className={`btn-action${activeMenu === rowKey ? " open" : ""}`} onClick={e => { e.stopPropagation(); setActiveMenu(activeMenu === rowKey ? null : rowKey); }} title="Actions">⋯</button>
                                    {activeMenu === rowKey && (
                                      <div className="action-dropdown">
                                        <button className="action-dropdown-item" onClick={() => { setDetailWf(w); setActiveMenu(null); }}>
                                          <span className="action-icon">⟳</span>View Details
                                        </button>
                                        {config.crmBaseUrl ? (
                                          <button className="action-dropdown-item" onClick={() => { window.open(`${config.crmBaseUrl}/Automation/ActiveWorkflowRules/detail/${w.id}`, "_blank"); setActiveMenu(null); }}>
                                            <span className="action-icon">↗</span>Open in CRM
                                          </button>
                                        ) : (
                                          <button className="action-dropdown-item" disabled style={{ opacity: 0.45, cursor: "not-allowed" }}>
                                            <span className="action-icon">↗</span>Open in CRM
                                          </button>
                                        )}
                                        <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(getName(w)); setActiveMenu(null); }}>
                                          <span className="action-icon">⎘</span>Copy Name
                                        </button>
                                        <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(String(w.id ?? "")); setActiveMenu(null); }}>
                                          <span className="action-icon">⎘</span>Copy Workflow ID
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

      {/* Connected tab */}
      {activeTab === "connected" && (
        <div style={{ marginTop: 16 }}>
          <div className="bp-tab-toolbar">
            <span className="bp-tab-toolbar-title">{connectedWfs.length > 0 ? `${connectedWfs.length} connected workflow${connectedWfs.length > 1 ? "s" : ""}` : "Connected Workflows"}</span>
            <button className="btn-secondary" style={{ fontSize: 12, padding: "4px 12px" }} onClick={() => void loadConnectedWorkflows()} disabled={connectedLoading}>
              {connectedLoading ? <><span className="spinner" /> Loading…</> : "↺ Reload"}
            </button>
          </div>
          {connectedError && <div className="form-error" style={{ marginTop: 8 }}>⚠ {connectedError}</div>}
          {connectedWfs.length === 0 && !connectedLoading && !connectedError && (
            <div className="audit-empty"><p className="audit-empty-sub">No connected workflows found.</p></div>
          )}
          {connectedWfs.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table className="modules-table">
                <thead><tr><th>Name / ID</th><th>Details</th><th>Action</th></tr></thead>
                <tbody>
                  {connectedWfs.map((cw, i) => {
                    const cwId = String(cw.id ?? cw.process_id ?? i);
                    const cwName = String(cw.name ?? cw.process_name ?? cwId);
                    const isExpanded = connectedDetail && (connectedDetail as Record<string,unknown>).id === cwId;
                    return (
                      <React.Fragment key={cwId}>
                        <tr>
                          <td className="cell-name">
                            {cwName}
                            <div className="cell-mono" style={{ fontSize: 11, opacity: 0.7 }}>{cwId}</div>
                          </td>
                          <td>
                            <div className="bp-analysis-bar" style={{ padding: "4px 8px" }}>
                              {Object.entries(cw).filter(([k]) => !["id","name","process_id","process_name"].includes(k)).slice(0, 4).map(([k, v]) => (
                                <span key={k} className="bp-stat"><strong>{k}:</strong> {typeof v === "object" ? "…" : String(v)}</span>
                              ))}
                            </div>
                          </td>
                          <td className="cell-actions">
                            {findTool(allTools, "getConnectedWorkflowById") && (
                              <button className="btn-secondary" style={{ fontSize: 12, padding: "3px 12px" }} disabled={connectedDetailLoading === cwId} onClick={() => void loadConnectedDetail(cwId)}>
                                {connectedDetailLoading === cwId ? <><span className="spinner" /> …</> : isExpanded ? "Collapse" : "View"}
                              </button>
                            )}
                          </td>
                        </tr>
                        {isExpanded && connectedDetail && (
                          <tr>
                            <td colSpan={3} style={{ padding: 0 }}>
                              <div className="bp-state-detail">
                                <pre className="bp-json-preview">{JSON.stringify(connectedDetail, null, 2)}</pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Create tab */}
      {activeTab === "create" && hasCreateTool && (
        <div className="bp-create-section">
          <h3 className="bp-create-title">Create Workflow Rule</h3>
          <p className="bp-create-desc">
            PREREQUISITES: (1) Use <strong>getWorkflowConfigurations</strong> to check supported triggers for your module. (2) Use <strong>getWorkflowRulesCount</strong> to verify you haven&apos;t hit org limits. (3) Use <strong>getFields</strong> if your criteria reference specific fields. Body must contain a <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>workflow_rules</code> array with exactly 1 rule.
          </p>
          {createMsg && <div className={createMsg.ok ? "form-success" : "form-error"} style={{ marginBottom: 12 }}>{createMsg.ok ? "✓" : "⚠"} {createMsg.text}</div>}
          <textarea className="bp-json-editor" value={createJson} onChange={e => setCreateJson(e.target.value)} rows={14} />
          <div style={{ marginTop: 12 }}>
            <button className="btn-connect" disabled={!createJson.trim() || createLoading} onClick={() => void handleCreateWorkflow()}>
              {createLoading ? <><span className="spinner" /> Creating…</> : "Create Workflow Rule"}
            </button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {detailWf && (
        <WorkflowDetailModal
          wf={detailWf}
          config={config}
          allTools={allTools}
          onLog={onLog}
          onClose={() => setDetailWf(null)}
          onDeleted={id => {
            setWorkflows(prev => prev.filter(w => String(w.id) !== id));
            setActionMessage({ ok: true, text: "Workflow rule deleted." });
            setDetailWf(null);
          }}
        />
      )}
    </div>
  );
}
