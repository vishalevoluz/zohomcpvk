"use client";

import React, { useState, useEffect, useMemo } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";

interface PickListValue {
  display_value?: string;
  actual_value?: string;
  id?: string;
}

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
  unique?: boolean | { casesensitive?: string } | null;
  formula?: { expression?: string; return_type?: string } | null;
  lookup?: { module?: { api_name?: string; display_label?: string } } | null;
  pick_list_values?: PickListValue[] | null;
  custom_field?: boolean;
  created_source?: string;
  visible?: boolean;
  view_type?: { view?: boolean; edit?: boolean; create?: boolean; quick_create?: boolean } | null;
  created_by?: { name?: string; id?: string };
  modified_by?: { name?: string; id?: string };
  created_time?: string;
  modified_time?: string;
  [key: string]: unknown;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

function extractFromValue(result: unknown): ZohoField[] {
  if (Array.isArray(result)) {
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      return result as ZohoField[];
    }
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.fields)) return r.fields as ZohoField[];
    if (Array.isArray(r.field_list)) return r.field_list as ZohoField[];
    if (Array.isArray(r.data)) return r.data as ZohoField[];
    if (Array.isArray(r.result)) return r.result as ZohoField[];
    for (const val of Object.values(r)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const first = val[0] as Record<string, unknown>;
        if (
          "api_name" in first ||
          "field_label" in first ||
          ("data_type" in first && ("mandatory" in first || "read_only" in first))
        ) {
          return val as ZohoField[];
        }
      }
    }
  }
  return [];
}

function extractFields(result: unknown): ZohoField[] {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const fields = extractFromValue(parsed);
            if (fields.length > 0) return fields;
          } catch { /* not JSON */ }
        }
      }
    }
  }
  return extractFromValue(result);
}

// ─── Field accessors ──────────────────────────────────────────────────────────

function getLabel(f: ZohoField): string {
  return String(f.field_label ?? f.display_label ?? f.api_name ?? "Unknown");
}

function getApiName(f: ZohoField): string {
  return String(f.api_name ?? "—");
}

function getDataType(f: ZohoField): string {
  return String(f.data_type ?? "—");
}

function isMandatory(f: ZohoField): boolean {
  return f.mandatory === true || f.system_mandatory === true;
}

function isUnique(f: ZohoField): boolean {
  if (typeof f.unique === "boolean") return f.unique;
  if (f.unique && typeof f.unique === "object") return true;
  return false;
}

function isReadOnly(f: ZohoField): boolean {
  return f.read_only === true || f.field_read_only === true;
}

function getFormula(f: ZohoField): string {
  if (!f.formula) return "—";
  if (typeof f.formula === "object" && f.formula.expression) return String(f.formula.expression);
  return "Yes";
}

function getLookup(f: ZohoField): string {
  if (!f.lookup) return "—";
  if (typeof f.lookup === "object") {
    const mod = f.lookup.module;
    if (mod) return String(mod.display_label ?? mod.api_name ?? "—");
    return "Yes";
  }
  return "—";
}

function getPicklistValues(f: ZohoField): PickListValue[] {
  return f.pick_list_values ?? [];
}

function getPicklistCount(f: ZohoField): number {
  return getPicklistValues(f).length;
}

function isPicklistType(f: ZohoField): boolean {
  const dt = (f.data_type ?? "").toLowerCase();
  return dt === "picklist" || dt === "multiselectpicklist" || dt === "pick_list";
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

// ─── Audit logic ──────────────────────────────────────────────────────────────

function buildDuplicateSet(fields: ZohoField[]): Set<string> {
  const seen = new Map<string, number>();
  for (const f of fields) {
    const key = getApiName(f).toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = new Set<string>();
  for (const [k, v] of seen) if (v > 1) dupes.add(k);
  return dupes;
}

function isDuplicate(f: ZohoField, dupeSet: Set<string>): boolean {
  return dupeSet.has(getApiName(f).toLowerCase());
}

// Mandatory picklist/multiselect fields with no values configured
function isMissingRequired(f: ZohoField): boolean {
  return isMandatory(f) && isPicklistType(f) && getPicklistCount(f) === 0;
}

// Custom fields that are hidden from all views
function isUnusedCustom(f: ZohoField): boolean {
  if (!f.custom_field) return false;
  if (f.visible === false) return true;
  if (f.view_type && typeof f.view_type === "object") {
    const vt = f.view_type;
    if (vt.view === false && vt.edit === false && vt.create === false) return true;
  }
  return false;
}

// Custom field API names should start with a capital letter and use only word chars
const NAMING_RE = /^[A-Z][A-Za-z0-9_]*$/;
function isNamingViolation(f: ZohoField): boolean {
  if (!f.custom_field) return false;
  const name = f.api_name ?? "";
  if (!name) return false;
  return !NAMING_RE.test(name);
}

const PICKLIST_EXCESS_THRESHOLD = 20;
function isExcessivePicklist(f: ZohoField): boolean {
  return getPicklistCount(f) > PICKLIST_EXCESS_THRESHOLD;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldFilterKey = "all" | "duplicate" | "missing_required" | "unused_custom" | "naming_violation" | "excessive_picklist";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  allTools?: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FieldsAudit({ config, tools, allTools = [], onLog }: Props) {
  const availableTools = tools.length > 0 ? tools : allTools;
  const usingFallback = tools.length === 0 && allTools.length > 0;

  const [selectedTools, setSelectedTools] = useState<string[]>(
    availableTools.length > 0 ? [availableTools[0].name] : []
  );
  const [toolParams, setToolParams] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<ZohoField[]>([]);
  const [filter, setFilter] = useState<FieldFilterKey>("all");

  // Derive the selected tool's schema
  const selectedToolObj = useMemo(
    () => availableTools.find(t => t.name === selectedTools[0]),
    [availableTools, selectedTools]
  );
  const schemaProps = selectedToolObj?.inputSchema?.properties ?? {};
  const requiredParams: string[] = selectedToolObj?.inputSchema?.required ?? [];

  // Reset param inputs whenever the selected tool changes
  useEffect(() => {
    const props = selectedToolObj?.inputSchema?.properties ?? {};
    const required = selectedToolObj?.inputSchema?.required ?? [];
    const defaults: Record<string, string> = {};
    for (const key of required) {
      if (!props[key] || props[key].type === "string") {
        defaults[key] = key.toLowerCase().includes("module") ? "Leads" : "";
      }
    }
    setToolParams(defaults);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTools.join(",")]);

  useEffect(() => {
    const next = tools.length > 0 ? tools : allTools;
    setSelectedTools(next.length > 0 ? [next[0].name] : []);
    setFields([]);
    setError("");
  }, [tools, allTools]);

  function detectToolError(output: unknown): string | null {
    if (output && typeof output === "object") {
      const o = output as Record<string, unknown>;
      // structuredContent.status === "failure"
      if (o.structuredContent && typeof o.structuredContent === "object") {
        const sc = o.structuredContent as Record<string, unknown>;
        if (sc.status === "failure" && sc.data && typeof sc.data === "object") {
          const d = sc.data as Record<string, unknown>;
          if (typeof d.message === "string") return d.message;
        }
      }
      // content[].text plain message
      if (Array.isArray(o.content)) {
        for (const item of o.content as Record<string, unknown>[]) {
          if (item.type === "text" && typeof item.text === "string") {
            const text = item.text;
            if (text.toLowerCase().includes("mandatory") || text.toLowerCase().includes("required") || text.toLowerCase().includes("failure")) {
              return text;
            }
          }
        }
      }
    }
    return null;
  }

  async function loadFields() {
    if (selectedTools.length === 0) return;

    // Validate and build params from tool schema
    const params: Record<string, string> = {};
    for (const key of requiredParams) {
      const val = (toolParams[key] ?? "").trim();
      if (!val) {
        setError(`Required parameter "${key}" is empty — enter a value before loading.`);
        return;
      }
      params[key] = val;
    }

    setLoading(true);
    setError("");
    try {
      const all: ZohoField[] = [];
      for (const toolName of selectedTools) {
        const start = Date.now();
        try {
          const output = await executeTool(config, toolName, params);
          const toolErr = detectToolError(output);
          if (toolErr) {
            setError(toolErr);
            onLog({ id: crypto.randomUUID(), tool: toolName, input: params, output, status: "error", errorMessage: toolErr, durationMs: Date.now() - start, timestamp: new Date() });
            continue;
          }
          const flds = extractFields(output);
          if (flds.length > 0) all.push(...flds);
          onLog({
            id: crypto.randomUUID(), tool: toolName, input: params, output,
            status: flds.length > 0 ? "success" : "error",
            errorMessage: flds.length === 0 ? "No fields found" : undefined,
            durationMs: Date.now() - start, timestamp: new Date(),
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Failed";
          onLog({ id: crypto.randomUUID(), tool: toolName, input: params, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
      if (all.length === 0) {
        const modVal = Object.values(params)[0] ?? "";
        setError(`No field data found${modVal ? ` for "${modVal}"` : ""}. Check the parameter value (e.g. Leads, Contacts, Deals).`);
      } else {
        setFields(all);
        setFilter("all");
      }
    } finally {
      setLoading(false);
    }
  }

  const dupeSet = buildDuplicateSet(fields);
  const duplicates = fields.filter(f => isDuplicate(f, dupeSet));
  const missingRequired = fields.filter(isMissingRequired);
  const unusedCustom = fields.filter(isUnusedCustom);
  const namingViolations = fields.filter(isNamingViolation);
  const excessivePicklist = fields.filter(isExcessivePicklist);

  const filterMap: Record<FieldFilterKey, ZohoField[]> = {
    all: fields,
    duplicate: duplicates,
    missing_required: missingRequired,
    unused_custom: unusedCustom,
    naming_violation: namingViolations,
    excessive_picklist: excessivePicklist,
  };
  const displayed = filterMap[filter];

  function getTags(f: ZohoField): FieldFilterKey[] {
    const tags: FieldFilterKey[] = [];
    if (isDuplicate(f, dupeSet)) tags.push("duplicate");
    if (isMissingRequired(f)) tags.push("missing_required");
    if (isUnusedCustom(f)) tags.push("unused_custom");
    if (isNamingViolation(f)) tags.push("naming_violation");
    if (isExcessivePicklist(f)) tags.push("excessive_picklist");
    return tags;
  }

  const findings: { key: FieldFilterKey; label: string; count: number; severity: string; tip: string }[] = [
    {
      key: "duplicate",
      label: "Duplicate Fields",
      count: duplicates.length,
      severity: duplicates.length > 0 ? "danger" : "ok",
      tip: "Fields sharing the same API name — duplicate fields cause unpredictable data overwrites and API conflicts.",
    },
    {
      key: "missing_required",
      label: "Missing Required Config",
      count: missingRequired.length,
      severity: missingRequired.length > 0 ? "danger" : "ok",
      tip: "Mandatory picklist/multi-select fields with no values configured — users cannot fill them in, breaking record creation.",
    },
    {
      key: "unused_custom",
      label: "Unused Custom Fields",
      count: unusedCustom.length,
      severity: unusedCustom.length > 0 ? "warn" : "ok",
      tip: "Custom fields hidden from all views — they store no visible data and clutter the schema. Consider removing or re-enabling them.",
    },
    {
      key: "naming_violation",
      label: "Naming Violations",
      count: namingViolations.length,
      severity: namingViolations.length > 0 ? "warn" : "ok",
      tip: "Custom field API names that don't follow the Zoho convention (PascalCase starting with a capital letter, only letters/numbers/underscores).",
    },
    {
      key: "excessive_picklist",
      label: "Excessive Picklist Values",
      count: excessivePicklist.length,
      severity: excessivePicklist.length > 0 ? "warn" : "ok",
      tip: `Picklist fields with more than ${PICKLIST_EXCESS_THRESHOLD} options — large lists are hard to use and maintain. Consider grouping values or using a lookup instead.`,
    },
  ];

  return (
    <div className="modules-audit">
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">⊟</span>
          <h2 className="pane-title">Fields Audit</h2>
          {fields.length > 0 && (
            <span className="pane-count">{fields.length} field{fields.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="audit-toolbar">
          {availableTools.length > 0 ? (
            <>
              {usingFallback && (
                <span className="no-tools-hint" title="No tools matched field keywords — showing all tools.">
                  ⚠ Select fields tool manually
                </span>
              )}
              <MultiToolSelect tools={availableTools} selected={selectedTools} onChange={setSelectedTools} />
            </>
          ) : (
            <span className="no-tools-hint">No tools found — check connection</span>
          )}
          {requiredParams.map(key => {
            const prop = schemaProps[key];
            const isModuleLike = key.toLowerCase().includes("module");
            return (
              <React.Fragment key={key}>
                <input
                  className="module-input"
                  type="text"
                  value={toolParams[key] ?? ""}
                  onChange={e => setToolParams(p => ({ ...p, [key]: e.target.value }))}
                  onKeyDown={e => e.key === "Enter" && loadFields()}
                  placeholder={prop?.description ? prop.description.slice(0, 28) : key}
                  title={prop?.description ?? key}
                  list={isModuleLike ? "zoho-modules" : undefined}
                  style={{ width: 160 }}
                />
              </React.Fragment>
            );
          })}
          {requiredParams.length === 0 && (
            <input
              className="module-input"
              type="text"
              value={toolParams["module"] ?? "Leads"}
              onChange={e => setToolParams(p => ({ ...p, module: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && loadFields()}
              placeholder="Module (e.g. Leads)"
              title="Zoho CRM module API name — e.g. Leads, Contacts, Deals"
              list="zoho-modules"
              style={{ width: 160 }}
            />
          )}
          <datalist id="zoho-modules">
            <option value="Leads" />
            <option value="Contacts" />
            <option value="Accounts" />
            <option value="Deals" />
            <option value="Activities" />
            <option value="Tasks" />
            <option value="Calls" />
            <option value="Meetings" />
            <option value="Products" />
            <option value="Quotes" />
            <option value="Invoices" />
            <option value="Purchase_Orders" />
            <option value="Sales_Orders" />
            <option value="Campaigns" />
            <option value="Cases" />
            <option value="Solutions" />
          </datalist>
          <button
            onClick={loadFields}
            disabled={loading || selectedTools.length === 0 || requiredParams.some(k => !(toolParams[k] ?? "").trim())}
            className="btn-connect"
          >
            {loading ? <><span className="spinner" /> Loading…</> : fields.length ? "Reload" : "Load Fields"}
          </button>
        </div>
      </div>

      {error && <p className="form-error">⚠ {error}</p>}

      {requiredParams.length > 0 && fields.length === 0 && !loading && (
        <div className="schema-hint-bar">
          {requiredParams.map(key => {
            const prop = schemaProps[key];
            return (
              <span key={key} className="schema-hint-item">
                <code className="param-name">{key}</code>
                <span className="required-badge">required</span>
                {prop?.description && <span className="param-desc">{prop.description}</span>}
              </span>
            );
          })}
        </div>
      )}

      {fields.length === 0 && !error && !loading && (
        <div className="audit-empty">
          <div className="audit-empty-icon">⊟</div>
          <p className="audit-empty-title">No data loaded</p>
          <p className="audit-empty-sub">
            {requiredParams.length > 0
              ? `Fill in the required parameter${requiredParams.length > 1 ? "s" : ""} above (${requiredParams.join(", ")}) and click "Load Fields".`
              : usingFallback
                ? "Pick the tool that returns CRM field metadata, enter a module name (e.g. Leads), then click Load Fields."
                : "Enter a module name (e.g. Leads, Contacts, Deals) and click \"Load Fields\" to run the audit."}
          </p>
        </div>
      )}

      {fields.length > 0 && (
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
                  ? `Showing all ${fields.length} field${fields.length !== 1 ? "s" : ""}`
                  : `Showing ${displayed.length} ${filter.replace(/_/g, " ")} of ${fields.length}`}
              </span>
              {filter !== "all" && (
                <button className="btn-secondary" onClick={() => setFilter("all")}>Clear filter</button>
              )}
            </div>

            {displayed.length === 0 ? (
              <div className="empty-state">No {filter.replace(/_/g, " ")} found — this is a good sign!</div>
            ) : (
              <div className="table-scroll">
                <table className="modules-table">
                  <thead>
                    <tr>
                      <th><span className="th-tip" data-tooltip-below="The human-readable display name of this field as shown in the Zoho CRM UI">Field Label<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The API name used in Zoho API calls and Deluge scripts (e.g. First_Name)">API Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The field data type (e.g. text, picklist, lookup, formula, datetime)">Data Type<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this field must be filled in before a record can be saved">Mandatory<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this field enforces uniqueness — no two records can share the same value">Unique<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this field can only be read, not edited by users">Read Only<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The Deluge expression used to auto-calculate this field's value (formula fields only)">Formula<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The related module this lookup field points to (lookup/relation fields only)">Lookup<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Number of available picklist options — hover over the count to see values (picklist/multi-select fields only)">Picklist Values<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Audit issues detected for this field">Findings<span className="th-info">i</span></span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((field, i) => {
                      const tags = getTags(field);
                      const mandatory = isMandatory(field);
                      const unique = isUnique(field);
                      const readOnly = isReadOnly(field);
                      const picklistValues = getPicklistValues(field);
                      const picklistCount = picklistValues.length;
                      const picklistPreview = picklistValues
                        .slice(0, 10)
                        .map(v => v.display_value ?? v.actual_value ?? "")
                        .filter(Boolean)
                        .join(", ");
                      const picklistTitle = picklistCount > 0
                        ? `${picklistCount} value${picklistCount !== 1 ? "s" : ""}: ${picklistPreview}${picklistCount > 10 ? ` … +${picklistCount - 10} more` : ""}`
                        : undefined;

                      return (
                        <React.Fragment key={(field.id ?? field.api_name ?? "") + i}>
                          <tr className={tags.length ? "row-flagged" : ""}>
                            <td className="cell-name">{getLabel(field)}</td>
                            <td className="cell-mono">{getApiName(field)}</td>
                            <td>
                              <span className="arg-badge">{getDataType(field)}</span>
                            </td>
                            <td>
                              <span className={`bool-badge ${mandatory ? "yes" : "no"}`}>
                                {mandatory ? "Yes" : "No"}
                              </span>
                            </td>
                            <td>
                              <span className={`bool-badge ${unique ? "yes" : "no"}`}>
                                {unique ? "Yes" : "No"}
                              </span>
                            </td>
                            <td>
                              <span className={`bool-badge ${readOnly ? "yes" : "no"}`}>
                                {readOnly ? "Yes" : "No"}
                              </span>
                            </td>
                            <td className="cell-mono" style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {getFormula(field)}
                            </td>
                            <td className="cell-mono">{getLookup(field)}</td>
                            <td>
                              {picklistCount > 0 ? (
                                <span
                                  className={`arg-badge ${picklistCount > PICKLIST_EXCESS_THRESHOLD ? "tag-fn-unused" : ""}`}
                                  title={picklistTitle}
                                  style={{ cursor: "help" }}
                                >
                                  {picklistCount}
                                </span>
                              ) : (
                                <span className="cell-mono" style={{ color: "var(--muted)" }}>—</span>
                              )}
                            </td>
                            <td>
                              <div className="tag-list">
                                {tags.length === 0
                                  ? <span className="audit-tag tag-ok" title="No issues detected for this field">clean</span>
                                  : tags.map(tag => (
                                      <span key={tag} className={`audit-tag tag-fn-${tag === "duplicate" || tag === "missing_required" ? "missing_ref" : tag === "naming_violation" ? "invalid_binding" : "unused"}`} title={
                                        tag === "duplicate"           ? "Another field shares this API name — duplicates cause data conflicts in API calls and reports." :
                                        tag === "missing_required"    ? "This mandatory picklist field has no values defined — users cannot fill it in, blocking record saves." :
                                        tag === "unused_custom"       ? "This custom field is hidden from all views — it holds no visible data and may be safe to remove." :
                                        tag === "naming_violation"    ? "API name doesn't follow Zoho convention (PascalCase: starts with capital, only letters/numbers/underscores)." :
                                        tag === "excessive_picklist"  ? `Picklist has more than ${PICKLIST_EXCESS_THRESHOLD} values — large lists are hard to use. Consider a lookup field instead.` :
                                        tag
                                      }>{tag.replace(/_/g, " ")}</span>
                                    ))}
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
