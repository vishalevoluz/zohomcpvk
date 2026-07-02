"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import { categorizeTools } from "@/lib/sections";

// ─── Module list extraction ────────────────────────────────────────────────────

interface ZohoModule {
  id?: string;
  module_name?: string;
  api_name?: string;
  singular_label?: string;
  plural_label?: string;
  [key: string]: unknown;
}

const MODULES_LIST_TOOL = "ZohoCRM_getModules";
const MODULE_KEYS = new Set(["module_name", "api_name", "singular_label", "plural_label"]);
const PRIORITY_ARRAY_KEYS = ["modules", "data", "result", "records", "response", "items", "list"];

function isModuleLike(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Object.keys(obj as Record<string, unknown>).some(k => MODULE_KEYS.has(k));
}

function findModuleArray(val: unknown, depth = 0): ZohoModule[] {
  if (depth > 6) return [];
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (isModuleLike(first)) return val as ZohoModule[];
    if (depth === 0 && typeof first === "object" && first !== null) return val as ZohoModule[];
  }
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const r = val as Record<string, unknown>;
    for (const key of PRIORITY_ARRAY_KEYS) {
      if (Array.isArray(r[key])) {
        const found = findModuleArray(r[key], depth + 1);
        if (found.length > 0) return found;
      }
    }
    for (const v of Object.values(r)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const found = findModuleArray(v, depth + 1);
        if (found.length > 0) return found;
      }
    }
  }
  return [];
}

function extractModules(result: unknown): ZohoModule[] {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const mods = findModuleArray(parsed);
            if (mods.length > 0) return mods;
          } catch { /* not JSON */ }
        }
      }
    }
  }
  return findModuleArray(result);
}

function getModuleApiName(m: ZohoModule): string {
  return String(m.api_name ?? m.module_name ?? "");
}

function getModuleLabel(m: ZohoModule): string {
  return String(m.plural_label ?? m.singular_label ?? m.module_name ?? m.api_name ?? "Unknown");
}

function pickModulesTool(tools: McpTool[]): McpTool | undefined {
  return tools.find(t => t.name === MODULES_LIST_TOOL) ?? tools[0];
}

// getModuleById is looked up directly on allTools by name, not through the
// "fields" keyword category — this section is intentionally NOT wired to a
// dedicated fields-listing tool.
function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function findModuleByIdTool(tools: McpTool[]): McpTool | undefined {
  return tools.find(t => normalizeName(t.name).includes("modulebyid"))
      ?? tools.find(t => normalizeName(t.name).includes("getmodule") && normalizeName(t.name).includes("byid"));
}

function buildModuleByIdParams(tool: McpTool, m: ZohoModule): Record<string, string> {
  const required = tool.inputSchema?.required ?? [];
  const idValue = String(m.id ?? getModuleApiName(m));
  if (required.length === 0) return { id: idValue };
  const key = required.find(k => /id/i.test(k)) ?? required[0];
  return { [key]: idValue };
}

// ─── Field extraction from the module-detail (getModuleById) response ─────────

interface ZohoField {
  id?: string;
  field_label?: string;
  display_label?: string;
  api_name?: string;
  data_type?: string;
  mandatory?: boolean;
  system_mandatory?: boolean;
  read_only?: boolean;
  field_read_only?: boolean;
  custom_field?: boolean;
  [key: string]: unknown;
}

const FIELD_KEYS = new Set(["api_name", "field_label", "data_type"]);
const FIELD_ARRAY_KEYS = ["fields", "field_list", "data", "result"];

function isFieldLike(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Object.keys(obj as Record<string, unknown>).some(k => FIELD_KEYS.has(k));
}

function findFieldArray(val: unknown, depth = 0): ZohoField[] {
  if (depth > 6) return [];
  if (Array.isArray(val) && val.length > 0 && isFieldLike(val[0])) return val as ZohoField[];
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const r = val as Record<string, unknown>;
    for (const key of FIELD_ARRAY_KEYS) {
      if (Array.isArray(r[key])) {
        const found = findFieldArray(r[key], depth + 1);
        if (found.length > 0) return found;
      }
    }
    for (const v of Object.values(r)) {
      if (v && typeof v === "object") {
        const found = findFieldArray(v, depth + 1);
        if (found.length > 0) return found;
      }
    }
  }
  return [];
}

function extractFieldsFromModuleDetail(result: unknown): ZohoField[] {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const flds = findFieldArray(parsed);
            if (flds.length > 0) return flds;
          } catch { /* not JSON */ }
        }
      }
    }
  }
  return findFieldArray(result);
}

function getFieldLabel(f: ZohoField): string { return String(f.field_label ?? f.display_label ?? f.api_name ?? "Unknown"); }
function getFieldApiName(f: ZohoField): string { return String(f.api_name ?? "—"); }
function getFieldDataType(f: ZohoField): string { return String(f.data_type ?? "—"); }
function isFieldMandatory(f: ZohoField): boolean { return f.mandatory === true || f.system_mandatory === true; }
function isFieldReadOnly(f: ZohoField): boolean { return f.read_only === true || f.field_read_only === true; }

// ─── Component ────────────────────────────────────────────────────────────────

interface ModuleFieldsState {
  status: "loading" | "loaded" | "error";
  fields: ZohoField[];
  error?: string;
}

interface Props {
  config: McpConfig;
  allTools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

export default function FieldsExplorer({ config, allTools, onLog }: Props) {
  const moduleTools = useMemo(() => categorizeTools(allTools).modules, [allTools]);
  const moduleByIdTool = useMemo(() => findModuleByIdTool(allTools), [allTools]);

  const [modules, setModules] = useState<ZohoModule[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  const [modulesError, setModulesError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [moduleFields, setModuleFields] = useState<Record<string, ModuleFieldsState>>({});
  const [loadedThrough, setLoadedThrough] = useState(0); // sequential preload cursor — one module at a time
  const hasFetchedModules = useRef(false);
  const inFlightIndex = useRef(-1);

  useEffect(() => {
    if (hasFetchedModules.current || moduleTools.length === 0) return;
    hasFetchedModules.current = true;
    void loadModules();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleTools]);

  async function loadModules() {
    const tool = pickModulesTool(moduleTools);
    if (!tool) return;
    setModulesLoading(true);
    setModulesError("");
    const start = Date.now();
    try {
      const output = await executeTool(config, tool.name, {});
      const mods = extractModules(output).filter(m => getModuleApiName(m));
      setModules(mods);
      onLog({
        id: crypto.randomUUID(), tool: tool.name, input: {}, output,
        status: mods.length > 0 ? "success" : "error",
        errorMessage: mods.length === 0 ? "No modules found" : undefined,
        durationMs: Date.now() - start, timestamp: new Date(),
      });
      if (mods.length === 0) setModulesError("No modules found — check the connected modules tool.");
    } catch (e) {
      setModulesError(e instanceof Error ? e.message : "Failed to load modules");
    } finally {
      setModulesLoading(false);
    }
  }

  // Sequential preload: fetch fields for one module at a time via getModuleById.
  useEffect(() => {
    if (!moduleByIdTool || modules.length === 0) return;
    if (loadedThrough >= modules.length) return;
    if (inFlightIndex.current === loadedThrough) return;
    inFlightIndex.current = loadedThrough;
    void loadModuleFields(loadedThrough);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules, loadedThrough, moduleByIdTool]);

  async function loadModuleFields(index: number) {
    const m = modules[index];
    if (!m || !moduleByIdTool) return;
    const apiName = getModuleApiName(m);
    setModuleFields(prev => ({ ...prev, [apiName]: { status: "loading", fields: [] } }));
    const params = buildModuleByIdParams(moduleByIdTool, m);
    const start = Date.now();
    try {
      const output = await executeTool(config, moduleByIdTool.name, params);
      const flds = extractFieldsFromModuleDetail(output);
      setModuleFields(prev => ({ ...prev, [apiName]: { status: "loaded", fields: flds } }));
      onLog({
        id: crypto.randomUUID(), tool: moduleByIdTool.name, input: params, output,
        status: flds.length > 0 ? "success" : "error",
        errorMessage: flds.length === 0 ? "No fields found" : undefined,
        durationMs: Date.now() - start, timestamp: new Date(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      setModuleFields(prev => ({ ...prev, [apiName]: { status: "error", fields: [], error: msg } }));
      onLog({ id: crypto.randomUUID(), tool: moduleByIdTool.name, input: params, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
    } finally {
      setLoadedThrough(i => i + 1);
    }
  }

  function handleReloadAll() {
    setModules([]);
    setModuleFields({});
    setLoadedThrough(0);
    inFlightIndex.current = -1;
    void loadModules();
  }

  function toggleExpanded(apiName: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(apiName)) next.delete(apiName); else next.add(apiName);
      return next;
    });
  }

  const loadedEntries = Object.values(moduleFields).filter(s => s.status === "loaded");
  const totalFields = loadedEntries.reduce((sum, s) => sum + s.fields.length, 0);
  const loadedModuleCount = Object.keys(moduleFields).filter(k => moduleFields[k].status !== "loading").length;

  return (
    <div className="modules-audit">
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">⊟</span>
          <h2 className="pane-title">Fields Explorer</h2>
          {modules.length > 0 && (
            <span className="pane-count">
              {loadedModuleCount}/{modules.length} modules · {totalFields} field{totalFields !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="audit-toolbar">
          {moduleTools.length === 0 && <span className="no-tools-hint">No modules tool found — check connection</span>}
          {moduleTools.length > 0 && !moduleByIdTool && (
            <span className="no-tools-hint">No getModuleById-style tool found — check connection</span>
          )}
          <button onClick={handleReloadAll} disabled={modulesLoading || moduleTools.length === 0} className="btn-connect">
            {modulesLoading ? <><span className="spinner" /> Loading…</> : "↺ Reload All"}
          </button>
        </div>
      </div>

      {modulesError && <p className="form-error">⚠ {modulesError}</p>}

      {modules.length === 0 && !modulesError && !modulesLoading && (
        <div className="audit-empty">
          <div className="audit-empty-icon">⊟</div>
          <p className="audit-empty-title">No data loaded</p>
          <p className="audit-empty-sub">Connect to MCP to auto-load fields for every module via getModules + getModuleById.</p>
        </div>
      )}

      {modules.length > 0 && (
        <div className="bp-states-list" style={{ marginTop: 12 }}>
          {modules.map((m, i) => {
            const apiName = getModuleApiName(m);
            const isExpanded = expanded.has(apiName);
            const state = moduleFields[apiName];
            const started = i <= loadedThrough;
            return (
              <div key={apiName} className={`bp-state-item${isExpanded ? " expanded" : ""}`}>
                <div className="bp-state-row">
                  <div className="bp-state-info">
                    <span className="bp-state-name">{getModuleLabel(m)}</span>
                    <span className="bp-state-id">{apiName}</span>
                    {state?.status === "loading" && <span className="spinner" />}
                    {state?.status === "loaded" && (
                      <span className="audit-tag tag-ok">{state.fields.length} field{state.fields.length !== 1 ? "s" : ""}</span>
                    )}
                    {state?.status === "error" && (
                      <span className="audit-tag tag-bp-incomplete" title={state.error}>load failed</span>
                    )}
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ padding: "3px 12px", fontSize: 12, flexShrink: 0 }}
                    onClick={() => toggleExpanded(apiName)}
                  >
                    {isExpanded ? "Collapse" : "View Fields"}
                  </button>
                </div>
                {started && isExpanded && (
                  <div className="bp-state-detail">
                    {!moduleByIdTool && <p className="audit-empty-sub">No getModuleById-style tool available.</p>}
                    {state?.status === "error" && <p className="form-error">⚠ {state.error}</p>}
                    {state?.status === "loaded" && state.fields.length === 0 && (
                      <p className="audit-empty-sub">No fields found in the module detail response.</p>
                    )}
                    {state?.status === "loaded" && state.fields.length > 0 && (
                      <div className="table-scroll">
                        <table className="modules-table">
                          <thead>
                            <tr>
                              <th>Field Label</th>
                              <th>API Name</th>
                              <th>Data Type</th>
                              <th>Mandatory</th>
                              <th>Read Only</th>
                            </tr>
                          </thead>
                          <tbody>
                            {state.fields.map((f, fi) => (
                              <tr key={String(f.id ?? f.api_name ?? fi)}>
                                <td className="cell-name">{getFieldLabel(f)}</td>
                                <td className="cell-mono">{getFieldApiName(f)}</td>
                                <td><span className="arg-badge">{getFieldDataType(f)}</span></td>
                                <td><span className={`bool-badge ${isFieldMandatory(f) ? "yes" : "no"}`}>{isFieldMandatory(f) ? "Yes" : "No"}</span></td>
                                <td><span className={`bool-badge ${isFieldReadOnly(f) ? "yes" : "no"}`}>{isFieldReadOnly(f) ? "Yes" : "No"}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
