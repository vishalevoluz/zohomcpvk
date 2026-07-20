"use client";

import React, { useState, useEffect, useRef } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";
import ScopeHint from "@/components/ScopeHint";

// Actual Zoho CRM workflow-function shape returned by the MCP tool
interface ZohoFunction {
  id?: string;
  name?: string;
  description?: string | null;
  language?: string;            // e.g. "deluge"
  source?: string;              // e.g. "crm"  (NOT Deluge code)
  feature_type?: string;        // e.g. "workflow"
  associated?: boolean;
  editable?: boolean;
  deletable?: boolean;
  lock_status?: { locked?: boolean };
  module?: {
    singular_label?: string;
    plural_label?: string;
    api_name?: string;
    moduleName?: string;
    id?: string;
  } | null;
  related_module?: unknown;
  // Nested object holding the actual Deluge function ID
  function?: { id?: string } | null;
  created_by?: { name?: string; id?: string };
  modified_by?: { name?: string; id?: string };
  created_time?: string;
  modified_time?: string;
  [key: string]: unknown;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

function extractFromValue(result: unknown): ZohoFunction[] {
  if (Array.isArray(result)) {
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      return result as ZohoFunction[];
    }
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    // Zoho returns { "functions": [...] }
    if (Array.isArray(r.functions)) return r.functions as ZohoFunction[];
    if (Array.isArray(r.custom_functions)) return r.custom_functions as ZohoFunction[];
    if (Array.isArray(r.function_list)) return r.function_list as ZohoFunction[];
    if (Array.isArray(r.data)) return r.data as ZohoFunction[];
    if (Array.isArray(r.result)) return r.result as ZohoFunction[];
    for (const val of Object.values(r)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const first = val[0] as Record<string, unknown>;
        if (
          "feature_type" in first ||
          "language" in first ||
          ("name" in first && "function" in first) ||
          ("name" in first && ("associated" in first || "lock_status" in first))
        ) {
          return val as ZohoFunction[];
        }
      }
    }
  }
  return [];
}

function extractFunctions(result: unknown): ZohoFunction[] {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const fns = extractFromValue(parsed);
            if (fns.length > 0) return fns;
          } catch { /* not JSON */ }
        }
      }
    }
  }
  return extractFromValue(result);
}

// ─── Field accessors ──────────────────────────────────────────────────────────

function getFnName(f: ZohoFunction): string {
  return String(f.name ?? f.id ?? "Unknown");
}

// The actual Deluge function ID lives in f.function.id; f.id is the association ID
function getFnId(f: ZohoFunction): string {
  const nested = f.function;
  if (nested && typeof nested === "object" && nested.id) return String(nested.id);
  return String(f.id ?? "—");
}

function getAssociationId(f: ZohoFunction): string {
  return String(f.id ?? "—");
}

function getModule(f: ZohoFunction): string {
  if (!f.module) return "—";
  return String(f.module.plural_label ?? f.module.api_name ?? f.module.singular_label ?? "—");
}

function getLanguage(f: ZohoFunction): string {
  return String(f.language ?? "—");
}

function getFeatureType(f: ZohoFunction): string {
  return String(f.feature_type ?? "—");
}

function getModuleName(f: ZohoFunction): string {
  if (!f.module) return "—";
  return String(f.module.moduleName ?? f.module.api_name ?? "—");
}

function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function isAssociated(f: ZohoFunction): boolean {
  if (typeof f.associated === "boolean") return f.associated;
  return true;
}

function isLocked(f: ZohoFunction): boolean {
  return f.lock_status?.locked === true;
}

function hasFunctionId(f: ZohoFunction): boolean {
  const nested = f.function;
  return !!(nested && typeof nested === "object" && nested.id);
}

function getCreatedBy(f: ZohoFunction): string {
  return String(f.created_by?.name ?? "—");
}

// ─── Audit logic ──────────────────────────────────────────────────────────────

// Unused: function is not associated with any workflow
function isUnused(f: ZohoFunction): boolean {
  return !isAssociated(f);
}

// Missing function reference: the nested function object is absent or has no ID
function hasMissingFunctionRef(f: ZohoFunction): boolean {
  return !hasFunctionId(f);
}

// Invalid binding: function is locked (can't be edited/executed)
function hasInvalidBinding(f: ZohoFunction): boolean {
  return isLocked(f);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type FnFilterKey = "all" | "unused" | "missing_ref" | "locked";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  allTools?: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FunctionAudit({ config, tools, allTools = [], onLog }: Props) {
  const availableTools = tools.length > 0 ? tools : allTools;
  const usingFallback = tools.length === 0 && allTools.length > 0;

  const [selectedTools, setSelectedTools] = useState<string[]>(() => availableTools.map(t => t.name));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [functions, setFunctions] = useState<ZohoFunction[]>([]);
  const [filter, setFilter] = useState<FnFilterKey>("all");
  const [search, setSearch] = useState("");
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
    const next = tools.length > 0 ? tools : allTools;
    const toolNames = next.map(t => t.name);
    setSelectedTools(toolNames);
    setFunctions([]);
    setError("");
    // Auto-load as soon as tools are available (MCP just connected)
    if (toolNames.length > 0) void loadFunctions(toolNames);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools, allTools]);

  async function loadFunctions(overrideTools?: string[]) {
    const toolsToUse = overrideTools ?? selectedTools;
    if (toolsToUse.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const all: ZohoFunction[] = [];
      for (const toolName of toolsToUse) {
        const start = Date.now();
        try {
          const output = await executeTool(config, toolName, {});
          const fns = extractFunctions(output);
          if (fns.length > 0) all.push(...fns);
          onLog({
            id: crypto.randomUUID(), tool: toolName, input: {}, output,
            status: fns.length > 0 ? "success" : "error",
            errorMessage: fns.length === 0 ? "No functions found" : undefined,
            durationMs: Date.now() - start, timestamp: new Date(),
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Failed";
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
      if (all.length === 0) {
        setError(`No function data found in selected tool${toolsToUse.length > 1 ? "s" : ""}.`);
      } else {
        setFunctions(all);
        setFilter("all");
      }
    } finally {
      setLoading(false);
    }
  }

  const unused = functions.filter(isUnused);
  const missingRef = functions.filter(hasMissingFunctionRef);
  const locked = functions.filter(hasInvalidBinding);

  const filterMap: Record<FnFilterKey, ZohoFunction[]> = {
    all: functions,
    unused,
    missing_ref: missingRef,
    locked,
  };
  const bySeverity = filterMap[filter];
  const displayed = search.trim()
    ? bySeverity.filter(f => getFnName(f).toLowerCase().includes(search.trim().toLowerCase()))
    : bySeverity;

  function getTags(f: ZohoFunction): FnFilterKey[] {
    const tags: FnFilterKey[] = [];
    if (isUnused(f)) tags.push("unused");
    if (hasMissingFunctionRef(f)) tags.push("missing_ref");
    if (hasInvalidBinding(f)) tags.push("locked");
    return tags;
  }

  const findings: { key: FnFilterKey; label: string; count: number; severity: string; tip: string }[] = [
    { key: "unused",      label: "Unassociated Functions", count: unused.length,     severity: unused.length > 0 ? "warn" : "ok",    tip: "Custom functions not linked to any workflow rule — they exist in Zoho but are never triggered automatically." },
    { key: "missing_ref", label: "Missing Function Refs",  count: missingRef.length, severity: missingRef.length > 0 ? "danger" : "ok", tip: "The underlying Deluge function ID (function.id) is missing from this association — the link to the script may be broken." },
    { key: "locked",      label: "Locked Functions",       count: locked.length,     severity: locked.length > 0 ? "warn" : "ok",    tip: "Functions that are locked and cannot be edited or executed by the current user." },
  ];

  return (
    <div className="modules-audit">
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">ƒ</span>
          <h2 className="pane-title">Functions Audit</h2>
          {functions.length > 0 && (
            <span className="pane-count">{functions.length} function{functions.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="audit-toolbar">
          {availableTools.length > 0 ? (
            <>
              {usingFallback && (
                <span className="no-tools-hint" title="No tools matched function keywords — showing all tools.">
                  ⚠ Select function tool manually
                </span>
              )}
              <MultiToolSelect tools={availableTools} selected={selectedTools} onChange={setSelectedTools} />
            </>
          ) : (
            <span className="no-tools-hint">No tools found — check connection</span>
          )}
          <button onClick={() => void loadFunctions()} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : functions.length ? "Reload" : "Load Functions"}
          </button>
        </div>
      </div>

      {error && <ScopeHint scopes={["getFunctions"]} />}

      {functions.length === 0 && !error && !loading && (
        <div className="audit-empty">
          <div className="audit-empty-icon">ƒ</div>
          <p className="audit-empty-title">No data loaded</p>
          <p className="audit-empty-sub">
            {usingFallback
              ? "Pick the tool that returns custom function data, then click Load Functions."
              : "Select a tool and click \"Load Functions\" to run the audit."}
          </p>
        </div>
      )}

      {functions.length > 0 && (
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
                  ? `Showing all ${displayed.length} of ${functions.length} function${functions.length !== 1 ? "s" : ""}`
                  : `Showing ${displayed.length} ${filter.replace(/_/g, " ")} of ${functions.length}`}
              </span>
              <div className="table-toolbar-actions">
                <input
                  type="text"
                  className="table-search"
                  placeholder="Search functions…"
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
                {search.trim() ? `No functions match "${search.trim()}".` : `No ${filter.replace(/_/g, " ")} found — this is a good sign!`}
              </div>
            ) : (
              <div className="table-scroll">
                <table className="modules-table">
                  <thead>
                    <tr>
                      <th><span className="th-tip" data-tooltip-below="The display name of this custom Deluge function">Function Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The unique ID of the underlying Deluge function script (function.id)">Function ID<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The CRM module this function is associated with">Module<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The internal system name of the module (e.g. CustomModule89)">Module Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The type of automation this function is tied to (e.g. workflow)">Feature Type<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The scripting language used to write this function — Zoho uses Deluge">Language<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this function is linked to and triggered by a workflow rule">Associated<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The user who created this function">Created By<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="When this function was first created">Created Time<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="When this function was last modified">Modified Time<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Audit issues detected for this function">Findings<span className="th-info">i</span></span></th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((fn, i) => {
                      const tags = getTags(fn);
                      const associated = isAssociated(fn);
                      const locked = isLocked(fn);

                      return (
                        <React.Fragment key={getAssociationId(fn) + i}>
                          <tr className={tags.length ? "row-flagged" : ""}>
                            <td className="cell-name">{getFnName(fn)}</td>
                            <td className="cell-mono fn-id">{getFnId(fn)}</td>
                            <td className="cell-mono">{getModule(fn)}</td>
                            <td className="cell-mono">{getModuleName(fn)}</td>
                            <td>
                              <span className="arg-badge">{getFeatureType(fn)}</span>
                            </td>
                            <td>
                              <span className="arg-badge">{getLanguage(fn)}</span>
                            </td>
                            <td>
                              <span className={`bool-badge ${associated ? "yes" : "no"}`}>
                                {associated ? "Yes" : "No"}
                              </span>
                            </td>
                            <td className="cell-mono" style={{ fontSize: 12 }}>{getCreatedBy(fn)}</td>
                            <td className="cell-datetime">{formatDateTime(fn.created_time as string)}</td>
                            <td className="cell-datetime">{formatDateTime(fn.modified_time as string)}</td>
                            <td>
                              <div className="tag-list">
                                {tags.length === 0 && !locked
                                  ? <span className="audit-tag tag-ok" title="No issues detected for this function">clean</span>
                                  : tags.map(tag => (
                                      <span key={tag} className={`audit-tag tag-fn-${tag}`} title={
                                        tag === "unused"      ? "This function is not associated with any workflow rule — it will never be triggered automatically." :
                                        tag === "missing_ref" ? "The Deluge function ID is missing — this association may be broken or the underlying script deleted." :
                                        tag === "locked"      ? "This function is locked and cannot be edited or executed by the current user." : tag
                                      }>{tag.replace(/_/g, " ")}</span>
                                    ))}
                              </div>
                            </td>
                            <td className="cell-actions">
                              <div className="action-menu-wrap" ref={activeMenu === getAssociationId(fn) + i ? menuRef : null}>
                                <button
                                  className={`btn-action ${activeMenu === getAssociationId(fn) + i ? "open" : ""}`}
                                  onClick={e => { e.stopPropagation(); const k = getAssociationId(fn) + i; setActiveMenu(activeMenu === k ? null : k); }}
                                  title="Actions"
                                >⋯</button>
                                {activeMenu === getAssociationId(fn) + i && (
                                  <div className="action-dropdown">
                                    <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(getFnName(fn)); setActiveMenu(null); }}>
                                      <span className="action-icon">⎘</span>Copy Name
                                    </button>
                                    <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(getFnId(fn)); setActiveMenu(null); }}>
                                      <span className="action-icon">⎘</span>Copy Function ID
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
    </div>
  );
}
