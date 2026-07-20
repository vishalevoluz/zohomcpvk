"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";
import FieldsAudit from "@/components/FieldsAudit";
import ScopeHint from "@/components/ScopeHint";
import { categorizeTools } from "@/lib/sections";
import ColumnFilterChips, { applyColumnFilters, type ColumnFilterDef } from "@/components/ColumnFilterChips";

interface ZohoModule {
  id?: string;
  module_name?: string;
  api_name?: string;
  singular_label?: string;
  plural_label?: string;
  actual_singular_label?: string;
  actual_plural_label?: string;
  // Real Zoho API uses "viewable", not "visible"
  viewable?: boolean;
  visible?: boolean;          // legacy fallback
  visibility?: number;        // 1 = visible, 0 = hidden
  creatable?: boolean;
  editable?: boolean;
  deletable?: boolean;
  convertable?: boolean;
  lookupable?: boolean;
  api_supported?: boolean;
  show_as_tab?: boolean;
  quick_create?: boolean;
  isBlueprintSupported?: boolean;
  global_search_supported?: boolean;
  feeds_required?: boolean;
  recycle_bin_on_delete?: boolean;
  sub_menu_available?: boolean;
  has_more_profiles?: boolean;
  access_type?: string;
  generated_type?: string;
  status?: string;
  sequence_number?: number;
  profile_count?: number;
  business_card_field_limit?: number;
  profiles?: Array<{ name?: string; id?: string }> | unknown;
  modified_by?: { name?: string; id?: string } | null;
  modified_time?: string | null;
  description?: string | null;
  web_link?: string | null;
  parent_module?: Record<string, unknown>;
  [key: string]: unknown;
}

const STANDARD_MODULES = new Set([
  "Leads","Contacts","Accounts","Deals","Tasks","Events","Calls","Activities",
  "Notes","Attachments","Cases","Solutions","Products","Price_Books","Quotes",
  "Sales_Orders","Purchase_Orders","Invoices","Vendors","Campaigns","Reports",
  "Dashboards","Documents","Feeds","Goals","Territory","Users","Roles","Profiles",
  "Meetings","Home","Analytics","Forecasts","Portals","Social","Webforms",
]);

const MODULE_KEYS = new Set(["module_name", "api_name", "singular_label", "plural_label"]);
const PRIORITY_ARRAY_KEYS = ["modules", "data", "result", "records", "response", "items", "list"];

function isModuleLike(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return MODULE_KEYS.size > 0 && Object.keys(obj as Record<string, unknown>).some(k => MODULE_KEYS.has(k));
}

function findModuleArray(val: unknown, depth = 0): ZohoModule[] {
  if (depth > 6) return [];

  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (isModuleLike(first)) return val as ZohoModule[];
    // At depth 0 accept any array of objects (direct tool response)
    if (depth === 0 && typeof first === "object" && first !== null) return val as ZohoModule[];
  }

  if (val && typeof val === "object" && !Array.isArray(val)) {
    const r = val as Record<string, unknown>;
    // Check priority keys first
    for (const key of PRIORITY_ARRAY_KEYS) {
      if (Array.isArray(r[key])) {
        const found = findModuleArray(r[key], depth + 1);
        if (found.length > 0) return found;
      }
    }
    // Recurse into nested objects
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

  // Unwrap MCP content wrapper: { content: [{ type: "text", text: "..." }] }
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

function getName(m: ZohoModule): string {
  return (m.plural_label ?? m.singular_label ?? m.module_name ?? m.api_name ?? "Unknown") as string;
}

function getProfiles(m: ZohoModule): string {
  if (!m.profiles) return "—";
  if (Array.isArray(m.profiles)) {
    const names = (m.profiles as Record<string, unknown>[])
      .map(p => (p.name ?? p) as string)
      .filter(Boolean);
    return names.length ? names.join(", ") : "None";
  }
  return String(m.profiles);
}

type FilterKey = "all" | "hidden" | "unused" | "custom" | "deprecated";

const MODULE_COLUMNS: ColumnFilterDef<ZohoModule>[] = [
  { key: "generated_type", label: "Generated Type", getValue: m => String(m.generated_type ?? "—") },
  { key: "status",         label: "Status",         getValue: m => String(m.status ?? "—") },
  { key: "viewable",       label: "Viewable",        getValue: m => (m.viewable ?? m.visible) !== false ? "Yes" : "No" },
  { key: "show_as_tab",    label: "Show as Tab",     getValue: m => m.show_as_tab ? "Yes" : "No" },
  { key: "creatable",      label: "Creatable",       getValue: m => m.creatable ? "Yes" : "No" },
  { key: "editable",       label: "Editable",        getValue: m => m.editable ? "Yes" : "No" },
  { key: "deletable",      label: "Deletable",       getValue: m => m.deletable ? "Yes" : "No" },
  { key: "api_supported",  label: "API Supported",   getValue: m => m.api_supported ? "Yes" : "No" },
  { key: "blueprint_support", label: "Blueprint Support", getValue: m => m.isBlueprintSupported ? "Yes" : "No" },
  { key: "quick_create",   label: "Quick Create",    getValue: m => m.quick_create ? "Yes" : "No" },
];

interface Props {
  config: McpConfig;
  tools: McpTool[];
  allTools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

export default function ModulesAudit({ config, tools, allTools, onLog }: Props) {
  const [selectedTools, setSelectedTools] = useState<string[]>(() => tools.map(t => t.name));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modules, setModules] = useState<ZohoModule[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const fieldsTools = useMemo(() => categorizeTools(allTools).fields, [allTools]);

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
    setModules([]);
    setError("");
    setColumnFilters({});
    // Auto-load as soon as tools are available (MCP just connected)
    if (toolNames.length > 0) {
      void loadModules(toolNames);
    }
  }, [tools]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadModules(overrideTools?: string[]) {
    const toolsToUse = overrideTools ?? selectedTools;
    if (toolsToUse.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const allMods: ZohoModule[] = [];
      for (const toolName of toolsToUse) {
        const start = Date.now();
        try {
          const output = await executeTool(config, toolName, {});
          const mods = extractModules(output);
          if (mods.length > 0) allMods.push(...mods);
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output, status: mods.length > 0 ? "success" : "error", errorMessage: mods.length === 0 ? "No modules found" : undefined, durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Failed to load";
          onLog({ id: crypto.randomUUID(), tool: toolName, input: {}, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
      if (allMods.length === 0) {
        setError(`No module data found in selected tool${toolsToUse.length > 1 ? "s" : ""}.`);
      } else {
        setModules(allMods);
        setFilter("all");
        setColumnFilters({});
      }
    } finally {
      setLoading(false);
    }
  }

  // Audit categorization — real Zoho API uses "viewable", visibility number, and status string
  const hidden = modules.filter(m =>
    m.viewable === false ||
    m.visible === false ||
    m.visibility === 0 ||
    ["user_hidden", "system_hidden", "hidden"].includes(String(m.status ?? "").toLowerCase())
  );

  const unused = modules.filter(m =>
    m.api_supported === false ||
    (m.creatable === false && m.editable === false && m.viewable !== false && m.visible !== false)
  );

  const custom = modules.filter(m =>
    m.generated_type === "custom" ||
    (!!m.api_name && !STANDARD_MODULES.has(String(m.api_name)) && !String(m.api_name).startsWith("__"))
  );

  const deprecated = modules.filter(m =>
    String(m.status ?? "").toLowerCase().includes("deprecat") ||
    String(m.status ?? "").toLowerCase() === "deleted"
  );

  const filterMap: Record<FilterKey, ZohoModule[]> = {
    all: modules, hidden, unused, custom, deprecated,
  };

  const bySeverity = filterMap[filter];
  const bySearch = search.trim()
    ? bySeverity.filter(m => {
        const q = search.trim().toLowerCase();
        return getName(m).toLowerCase().includes(q) || String(m.api_name ?? "").toLowerCase().includes(q);
      })
    : bySeverity;
  const displayed = applyColumnFilters(bySearch, MODULE_COLUMNS, columnFilters);

  function getTags(m: ZohoModule): FilterKey[] {
    const tags: FilterKey[] = [];
    if (hidden.includes(m)) tags.push("hidden");
    if (unused.includes(m)) tags.push("unused");
    if (custom.includes(m)) tags.push("custom");
    if (deprecated.includes(m)) tags.push("deprecated");
    return tags;
  }

  const findings: { key: FilterKey; label: string; count: number; severity: string; tip: string }[] = [
    { key: "hidden",     label: "Hidden Modules",     count: hidden.length,     severity: hidden.length > 0 ? "warn" : "ok",                                            tip: "Modules not visible to users in the CRM navigation. May be system-hidden or manually hidden by admins." },
    { key: "unused",     label: "Unused Modules",     count: unused.length,     severity: unused.length > 0 ? "warn" : "ok",                                            tip: "Modules where records can't be created or edited, or API access is disabled." },
    { key: "custom",     label: "Excessive Custom",   count: custom.length,     severity: custom.length > 5 ? "danger" : custom.length > 0 ? "warn" : "ok",            tip: "Non-standard modules your org created. Too many custom modules can complicate data architecture and maintenance." },
    { key: "deprecated", label: "Deprecated Modules", count: deprecated.length, severity: deprecated.length > 0 ? "danger" : "ok",                                     tip: "Modules flagged as deprecated or deleted by Zoho. Should be reviewed and removed." },
  ];

  return (
    <div className="modules-audit">
      {/* Header */}
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">⊞</span>
          <h2 className="pane-title">Modules Audit</h2>
          {modules.length > 0 && (
            <span className="pane-count">{modules.length} modules</span>
          )}
        </div>
        <div className="audit-toolbar">
          {tools.length > 0 ? (
            <MultiToolSelect tools={tools} selected={selectedTools} onChange={setSelectedTools} />
          ) : (
            <span className="no-tools-hint">No module tools found — check connection</span>
          )}
          <button onClick={() => void loadModules()} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : modules.length ? "Reload" : "Load Modules"}
          </button>
        </div>
      </div>

      {error && <ScopeHint scopes={["getModules"]} />}

      {modules.length === 0 && !error && !loading && (
        <div className="audit-empty">
          <div className="audit-empty-icon">⊞</div>
          <p className="audit-empty-title">No data loaded</p>
          <p className="audit-empty-sub">Select a tool and click "Load Modules" to run the audit.</p>
        </div>
      )}

      {modules.length > 0 && (
        <>
          {/* Findings summary */}
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

          {/* Table */}
          <div className="modules-table-wrap">
            <div className="table-toolbar">
              <span className="table-info">
                {filter === "all"
                  ? `Showing all ${displayed.length} of ${modules.length} modules`
                  : `Showing ${displayed.length} ${filter} module${displayed.length !== 1 ? "s" : ""} of ${modules.length}`}
              </span>
              <div className="table-toolbar-actions">
                <input
                  type="text"
                  className="table-search"
                  placeholder="Search modules…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {filter !== "all" && (
                  <button className="btn-secondary" onClick={() => setFilter("all")}>
                    Clear filter
                  </button>
                )}
              </div>
            </div>

            <ColumnFilterChips items={bySearch} columns={MODULE_COLUMNS} active={columnFilters} onChange={(key, val) => setColumnFilters(prev => {
              const next = { ...prev };
              if (val) next[key] = val; else delete next[key];
              return next;
            })} />

            {displayed.length === 0 ? (
              <div className="empty-state">
                {search.trim() ? `No modules match "${search.trim()}".` : `No ${filter} modules found — this is a good sign!`}
              </div>
            ) : (
              <div className="table-scroll">
                <table className="modules-table">
                  <thead>
                    <tr>
                      <th><span className="th-tip" data-tooltip-below="The display name of the CRM module">Module Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Unique ID of this module">Module ID<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The technical API identifier used in integrations and API calls">API Name<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The internal system name of this module">Module Name (System)<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this is a default Zoho module or a custom module your org created">Generated Type<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The current visibility status of this module (visible, hidden, etc.)">Status<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether users can view this module in the CRM">Viewable<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this module appears as a tab in the CRM navigation bar">Show as Tab<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether new records can be created in this module">Creatable<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether existing records can be modified in this module">Editable<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether records in this module can be deleted">Deletable<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether this module can be accessed via the Zoho CRM API">API Supported<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether Blueprint processes can be applied to this module">Blueprint Support<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Whether records can be quick-created from other modules">Quick Create<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Number of user profiles that have access to this module">Profile Count<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="User profiles that have access to this module">Profiles<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="The display order of this module in the CRM navigation">Seq No<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Audit issues detected for this module">Findings<span className="th-info">i</span></span></th>
                      <th><span className="th-tip" data-tooltip-below="Expand to audit all fields in this module">Fields<span className="th-info">i</span></span></th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((m, i) => {
                      const tags = getTags(m);
                      const modApiName = String(m.api_name ?? m.module_name ?? "");
                      const isExpanded = expandedModule === modApiName;
                      return (
                        <React.Fragment key={i}>
                          <tr className={`${tags.length ? "row-flagged" : ""} ${isExpanded ? "row-selected" : ""}`}>
                          <td className="cell-name">{getName(m)}</td>
                          <td className="cell-mono fn-id">{String(m.id ?? "—")}</td>
                          <td className="cell-mono">{String(m.api_name ?? "—")}</td>
                          <td className="cell-mono">{String(m.module_name ?? "—")}</td>
                          <td><span className="arg-badge">{String(m.generated_type ?? "—")}</span></td>
                          <td><span className="arg-badge">{String(m.status ?? "—")}</span></td>
                          <td><span className={`bool-badge ${(m.viewable ?? m.visible) !== false ? "yes" : "no"}`}>{(m.viewable ?? m.visible) !== false ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.show_as_tab ? "yes" : "no"}`}>{m.show_as_tab ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.creatable ? "yes" : "no"}`}>{m.creatable ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.editable ? "yes" : "no"}`}>{m.editable ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.deletable ? "yes" : "no"}`}>{m.deletable ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.api_supported ? "yes" : "no"}`}>{m.api_supported ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.isBlueprintSupported ? "yes" : "no"}`}>{m.isBlueprintSupported ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.quick_create ? "yes" : "no"}`}>{m.quick_create ? "Yes" : "No"}</span></td>
                          <td><span className="count-badge">{String(m.profile_count ?? "—")}</span></td>
                          <td className="cell-profiles">{getProfiles(m)}</td>
                          <td className="cell-mono">{String(m.sequence_number ?? "—")}</td>
                          <td>
                            <div className="tag-list">
                              {tags.length === 0
                                ? <span className="audit-tag tag-ok" title="No issues detected for this module">clean</span>
                                : tags.map(tag => (
                                    <span key={tag} className={`audit-tag tag-${tag}`} title={
                                      tag === "hidden"     ? "This module is hidden from CRM users and may not appear in navigation." :
                                      tag === "unused"     ? "This module has no create/edit access or is not accessible via API." :
                                      tag === "custom"     ? "This is a custom module created by your organization, not a standard Zoho CRM module." :
                                      tag === "deprecated" ? "This module is marked as deprecated or deleted and should be reviewed." : tag
                                    }>{tag}</span>
                                  ))}
                            </div>
                          </td>
                          <td>
                            <button
                              className={`btn-fields ${isExpanded ? "active" : ""}`}
                              onClick={() => setExpandedModule(isExpanded ? null : modApiName || null)}
                              title={isExpanded ? "Close fields panel" : `View fields for ${getName(m)}`}
                            >
                              {isExpanded ? "▲ Close" : "⊟ Fields"}
                            </button>
                          </td>
                          <td className="cell-actions">
                            <div className="action-menu-wrap" ref={activeMenu === modApiName ? menuRef : null}>
                              <button
                                className={`btn-action ${activeMenu === modApiName ? "open" : ""}`}
                                onClick={e => { e.stopPropagation(); setActiveMenu(activeMenu === modApiName ? null : modApiName); }}
                                title="Actions"
                              >⋯</button>
                              {activeMenu === modApiName && (
                                <div className="action-dropdown">
                                  {config.crmBaseUrl ? (
                                    <button className="action-dropdown-item" onClick={() => { window.open(`${config.crmBaseUrl}/tab/${modApiName}`, "_blank"); setActiveMenu(null); }}>
                                      <span className="action-icon">↗</span>Open in CRM
                                    </button>
                                  ) : (
                                    <button className="action-dropdown-item" disabled title="Enter your Zoho CRM URL in the connection form to enable this" style={{ opacity: 0.45, cursor: "not-allowed" }}>
                                      <span className="action-icon">↗</span>Open in CRM
                                    </button>
                                  )}
                                  <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(String(m.api_name ?? "")); setActiveMenu(null); }}>
                                    <span className="action-icon">⎘</span>Copy API Name
                                  </button>
                                  <button className="action-dropdown-item" onClick={() => { navigator.clipboard.writeText(String(m.id ?? "")); setActiveMenu(null); }}>
                                    <span className="action-icon">⎘</span>Copy Module ID
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

            {/* Inline fields panel */}
            {expandedModule && (
              <div className="module-fields-inline">
                <FieldsAudit
                  embedded
                  defaultModule={expandedModule}
                  autoLoad
                  config={config}
                  tools={fieldsTools}
                  allTools={allTools}
                  onLog={onLog}
                />
              </div>
            )}
          </div>
        </>
      )}

    </div>
  );
}
