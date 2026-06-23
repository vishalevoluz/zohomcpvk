"use client";

import { useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import MultiToolSelect from "@/components/MultiToolSelect";

interface ZohoModule {
  module_name?: string;
  api_name?: string;
  singular_label?: string;
  plural_label?: string;
  visible?: boolean;
  creatable?: boolean;
  editable?: boolean;
  api_supported?: boolean;
  status?: string;
  generated_type?: string;
  profiles?: unknown;
  [key: string]: unknown;
}

const STANDARD_MODULES = new Set([
  "Leads","Contacts","Accounts","Deals","Tasks","Events","Calls","Activities",
  "Notes","Attachments","Cases","Solutions","Products","Price_Books","Quotes",
  "Sales_Orders","Purchase_Orders","Invoices","Vendors","Campaigns","Reports",
  "Dashboards","Documents","Feeds","Goals","Territory","Users","Roles","Profiles",
  "Meetings","Home","Analytics","Forecasts","Portals","Social","Webforms",
]);

function extractModulesFromValue(result: unknown): ZohoModule[] {
  if (Array.isArray(result)) {
    // If it's an array of module-like objects
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      return result as ZohoModule[];
    }
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.modules)) return r.modules as ZohoModule[];
    if (Array.isArray(r.data)) return r.data as ZohoModule[];
    // Scan all array-valued keys for module-like objects
    for (const val of Object.values(r)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const first = val[0] as Record<string, unknown>;
        if ("module_name" in first || "api_name" in first || "singular_label" in first) {
          return val as ZohoModule[];
        }
      }
    }
  }
  return [];
}

function extractModules(result: unknown): ZohoModule[] {
  if (!result) return [];

  // MCP tools/call wraps output in: { content: [{ type: "text", text: "..." }], isError: false }
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      for (const item of r.content as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const mods = extractModulesFromValue(parsed);
            if (mods.length > 0) return mods;
          } catch {
            // text is not JSON, skip
          }
        }
      }
    }
  }

  return extractModulesFromValue(result);
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

interface Props {
  config: McpConfig;
  tools: McpTool[];
  onLog: (log: ExecutionLog) => void;
}

export default function ModulesAudit({ config, tools, onLog }: Props) {
  const [selectedTools, setSelectedTools] = useState<string[]>(tools.length > 0 ? [tools[0].name] : []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modules, setModules] = useState<ZohoModule[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");

  async function loadModules() {
    if (selectedTools.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const allMods: ZohoModule[] = [];
      for (const toolName of selectedTools) {
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
        setError(`No module data found in selected tool${selectedTools.length > 1 ? "s" : ""}.`);
      } else {
        setModules(allMods);
        setFilter("all");
      }
    } finally {
      setLoading(false);
    }
  }

  // Audit categorization
  const hidden = modules.filter(m =>
    m.visible === false ||
    ["user_hidden", "system_hidden", "hidden"].includes(String(m.status ?? "").toLowerCase())
  );

  const unused = modules.filter(m =>
    m.api_supported === false ||
    (m.creatable === false && m.editable === false && m.visible !== false)
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

  const displayed = filterMap[filter];

  function getTags(m: ZohoModule): FilterKey[] {
    const tags: FilterKey[] = [];
    if (hidden.includes(m)) tags.push("hidden");
    if (unused.includes(m)) tags.push("unused");
    if (custom.includes(m)) tags.push("custom");
    if (deprecated.includes(m)) tags.push("deprecated");
    return tags;
  }

  const findings: { key: FilterKey; label: string; count: number; severity: string }[] = [
    { key: "hidden",     label: "Hidden Modules",     count: hidden.length,     severity: hidden.length > 0 ? "warn" : "ok" },
    { key: "unused",     label: "Unused Modules",     count: unused.length,     severity: unused.length > 0 ? "warn" : "ok" },
    { key: "custom",     label: "Excessive Custom",   count: custom.length,     severity: custom.length > 5 ? "danger" : custom.length > 0 ? "warn" : "ok" },
    { key: "deprecated", label: "Deprecated Modules", count: deprecated.length, severity: deprecated.length > 0 ? "danger" : "ok" },
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
          <button onClick={loadModules} disabled={loading || selectedTools.length === 0} className="btn-connect">
            {loading ? <><span className="spinner" /> Loading…</> : modules.length ? "Reload" : "Load Modules"}
          </button>
        </div>
      </div>

      {error && <p className="form-error">⚠ {error}</p>}

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
                  ? `Showing all ${modules.length} modules`
                  : `Showing ${displayed.length} ${filter} module${displayed.length !== 1 ? "s" : ""} of ${modules.length}`}
              </span>
              {filter !== "all" && (
                <button className="btn-secondary" onClick={() => setFilter("all")}>
                  Clear filter
                </button>
              )}
            </div>

            {displayed.length === 0 ? (
              <div className="empty-state">No {filter} modules found — this is a good sign!</div>
            ) : (
              <div className="table-scroll">
                <table className="modules-table">
                  <thead>
                    <tr>
                      <th>Module Name</th>
                      <th>API Name</th>
                      <th>Visibility</th>
                      <th>Creatable</th>
                      <th>Editable</th>
                      <th>API Supported</th>
                      <th>Profiles Access</th>
                      <th>Findings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((m, i) => {
                      const tags = getTags(m);
                      return (
                        <tr key={i} className={tags.length ? "row-flagged" : ""}>
                          <td className="cell-name">{getName(m)}</td>
                          <td className="cell-mono">{String(m.api_name ?? "—")}</td>
                          <td><span className={`bool-badge ${m.visible !== false ? "yes" : "no"}`}>{m.visible !== false ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.creatable !== false ? "yes" : "no"}`}>{m.creatable !== false ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.editable !== false ? "yes" : "no"}`}>{m.editable !== false ? "Yes" : "No"}</span></td>
                          <td><span className={`bool-badge ${m.api_supported !== false ? "yes" : "no"}`}>{m.api_supported !== false ? "Yes" : "No"}</span></td>
                          <td className="cell-profiles">{getProfiles(m)}</td>
                          <td>
                            <div className="tag-list">
                              {tags.length === 0
                                ? <span className="audit-tag tag-ok">clean</span>
                                : tags.map(tag => (
                                    <span key={tag} className={`audit-tag tag-${tag}`}>{tag}</span>
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
