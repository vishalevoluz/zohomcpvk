"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam } from "@/lib/zohoMcp";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CrmEntityType = "blueprints" | "modules" | "layouts" | "tasks" | "pipelines" | "stages" | "workflows" | "profiles" | "users" | "roles" | "fields";

export interface EntityState {
  items: unknown[];
  loading: boolean;
  error: string | null;
  toolUsed: string | null;
  expanded: boolean;
  lastFetched: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CRM_ENTITIES: { type: CrmEntityType; label: string; icon: string; plural: string }[] = [
  { type: "modules",    label: "Modules",    icon: "⊞", plural: "modules" },
  { type: "layouts",    label: "Layouts",    icon: "⊟", plural: "layouts" },
  { type: "pipelines",  label: "Pipelines",  icon: "⇥", plural: "pipelines" },
  { type: "stages",     label: "Stages",     icon: "◉", plural: "stages" },
  { type: "workflows",  label: "Workflows",  icon: "⟳", plural: "workflows" },
  { type: "blueprints", label: "Blueprints", icon: "◈", plural: "blueprints" },
  { type: "fields",     label: "Fields",     icon: "▤", plural: "fields" },
  { type: "profiles",   label: "Profiles",   icon: "◑", plural: "profiles" },
  { type: "users",      label: "Users",      icon: "◎", plural: "users" },
  { type: "roles",      label: "Roles",      icon: "◒", plural: "roles" },
  { type: "tasks",      label: "Tasks",      icon: "✓", plural: "tasks" },
];

export const ENTITY_PREFS: Record<CrmEntityType, { preferred: string[]; patterns: RegExp[] }> = {
  blueprints: {
    preferred: ["getBlueprints", "getAllBlueprints", "listBlueprints", "getBlueprintList", "getBlueprintProcesses"],
    patterns: [/getallblueprint/i, /getblueprint(?!byid|id|record|stage)/i, /listblueprint/i],
  },
  modules: {
    preferred: ["getModules", "getAllModules", "listModules", "getCRMModules", "getAvailableModules"],
    patterns: [/getmodule(?!field|layout|byid|byname)/i, /listmodule/i, /allmodule/i],
  },
  layouts: {
    preferred: ["getLayouts", "getAllLayouts", "getModuleLayouts", "listLayouts", "getLayoutList"],
    patterns: [/getlayout(?!byid)/i, /listlayout/i, /alllayout/i],
  },
  tasks: {
    preferred: ["getTasks", "getAllTasks", "listTasks", "getActivities", "getAllActivities", "getTaskList"],
    patterns: [/gettask(?!byid)/i, /listtask/i, /alltask/i, /getactivit/i],
  },
  pipelines: {
    preferred: ["getPipelines", "getAllPipelines", "listPipelines", "getSalesPipelines", "getDealPipelines"],
    patterns: [/getpipeline(?!byid)/i, /listpipeline/i, /allpipeline/i, /salespipeline/i],
  },
  stages: {
    preferred: ["getStages", "getAllStages", "getDealStages", "getPipelineStages", "listStages"],
    patterns: [/getstage(?!byid)/i, /liststage/i, /allstage/i, /dealstage/i, /pipelinestage/i],
  },
  workflows: {
    preferred: ["getWorkflowRules", "getWorkflows", "getAllWorkflows", "listWorkflows", "getAutomationWorkflows"],
    patterns: [/getworkflowrule(?!byid)/i, /listworkflow/i, /allworkflow/i, /getworkflows?$/i],
  },
  profiles: {
    preferred: ["getProfile", "getProfiles", "getAllProfiles", "listProfiles", "getCRMProfiles"],
    patterns: [/getprofile(?!byid|field)/i, /listprofile/i, /allprofile/i, /profile/i],
  },
  users: {
    preferred: ["getUser", "getUsers", "getAllUsers", "listUsers", "getCRMUsers", "getUserList"],
    patterns: [/getuser(?!byid|profile|pref)/i, /listuser/i, /alluser/i],
  },
  roles: {
    preferred: ["getRole", "getRoles", "getAllRoles", "listRoles", "getCRMRoles", "getRoleList"],
    patterns: [/getrole(?!byid)/i, /listrole/i, /allrole/i, /role/i],
  },
  fields: {
    preferred: ["getFields", "getAllFields", "listFields", "getModuleFields", "getCRMFields"],
    patterns: [/getfield(?!byid)/i, /listfield/i, /allfield/i, /getfields/i],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function findToolForEntity(tools: McpTool[], type: CrmEntityType): McpTool | null {
  const { preferred, patterns } = ENTITY_PREFS[type];
  for (const name of preferred) {
    const t = tools.find(t => t.name === name);
    if (t) return t;
  }
  return tools.find(t => patterns.some(p => p.test(t.name))) ?? null;
}

export function extractArray(output: unknown): unknown[] {
  if (!output) return [];
  if (Array.isArray(output)) return output;
  if (typeof output !== "object") return [];
  const r = output as Record<string, unknown>;

  // Unwrap MCP content wrapper: { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(r.content)) {
    for (const c of r.content as Record<string, unknown>[]) {
      if (c.type === "text" && typeof c.text === "string") {
        try {
          const parsed = JSON.parse(c.text);
          if (Array.isArray(parsed)) return parsed;
          if (typeof parsed === "object" && parsed !== null) return extractArray(parsed);
        } catch { /* not JSON */ }
      }
    }
  }

  // Try standard response keys (includes new entity keys)
  const keys = ["data", "blueprints", "modules", "layouts", "tasks", "pipelines", "stages",
                 "workflows", "profiles", "users", "fields", "result", "results", "records",
                 "items", "list", "response"];
  for (const key of keys) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  for (const val of Object.values(r)) {
    if (Array.isArray(val) && val.length > 0) return val;
  }
  // Single-object responses (e.g. getProfile / getUser returning one record) — wrap in array
  const hasId = "id" in r || "userId" in r || "profileId" in r || "name" in r;
  if (hasId) return [r];
  return [];
}

// Zoho list APIs page at up to 200 records and signal more via info.more_records —
// without checking this, fetchEntity would silently only ever see page 1, making
// anything past record #200 (e.g. a workflow rule for a specific module) invisible
// to the whole app even though it exists in the org.
function extractPageInfo(output: unknown): { moreRecords: boolean } | null {
  if (!output || typeof output !== "object") return null;
  let r = output as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed && typeof parsed === "object") { r = parsed as Record<string, unknown>; break; }
        } catch { /* not JSON */ }
      }
    }
  }
  const info = r.info as Record<string, unknown> | undefined;
  if (!info) return null;
  return { moreRecords: info.more_records === true };
}

function nestedName(val: unknown): string | undefined {
  if (!val || typeof val !== "object") return undefined;
  const r = val as Record<string, unknown>;
  const n = r.name ?? r.display_label ?? r.field_label ?? r.plural_label;
  return typeof n === "string" && n ? n : undefined;
}

export function getItemName(item: unknown, idx: number): string {
  // Some list endpoints (e.g. pipelines/stages on certain MCP servers) return
  // plain string/number entries rather than objects — without this, every
  // such entry silently fell through to the "Item N" placeholder regardless
  // of its actual value.
  if (typeof item === "string") return item || `Item ${idx + 1}`;
  if (typeof item === "number") return String(item);
  if (!item || typeof item !== "object") return `Item ${idx + 1}`;
  const r = item as Record<string, unknown>;
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return String(
    r.name ?? r.display_name ?? r.display_label ?? r.label ?? r.api_name ??
    r.workflow_name ?? r.blueprint_name ?? r.pipeline_name ?? r.layout_name ??
    r.rule_name ?? r.process_name ??
    r.stage_name ?? r.title ?? r.full_name ?? (fullName || undefined) ??
    r.email ??
    // Zoho Blueprint list responses don't always carry a top-level name —
    // fall back to the driving field/layout/process label before giving up.
    nestedName(r.process_info) ?? nestedName(r.field) ?? nestedName(r.layout) ??
    `Item ${idx + 1}`
  );
}

export function getItemId(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const r = item as Record<string, unknown>;
  return String(r.id ?? r.workflow_id ?? r.blueprint_id ?? r.pipeline_id ?? "");
}

export function getItemStatus(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const raw = r.status ?? r.active ?? r.enabled ?? r.is_active;
  if (raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "Active" : "Inactive";
  const s = String(raw);
  return s || null;
}

export function isEntityResolved(state: EntityState): boolean {
  return !state.loading && (state.lastFetched !== null || state.error !== null);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const INIT_STATE: EntityState = {
  items: [], loading: false, error: null, toolUsed: null, expanded: true, lastFetched: null,
};

function makeInitial(): Record<CrmEntityType, EntityState> {
  return {
    blueprints: { ...INIT_STATE },
    modules:    { ...INIT_STATE },
    layouts:    { ...INIT_STATE },
    tasks:      { ...INIT_STATE },
    pipelines:  { ...INIT_STATE },
    stages:     { ...INIT_STATE },
    workflows:  { ...INIT_STATE },
    profiles:   { ...INIT_STATE },
    users:      { ...INIT_STATE },
    roles:      { ...INIT_STATE },
    fields:     { ...INIT_STATE },
  };
}

export function useCrmEntities(
  config: McpConfig | null,
  tools: McpTool[],
  onLog: (log: ExecutionLog) => void
) {
  const [entityData, setEntityData] = useState<Record<CrmEntityType, EntityState>>(makeInitial);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const hasFetched = useRef(false);
  const configKey = config ? `${config.url}::${config.crmBaseUrl ?? ""}::${config.authToken ?? ""}::${config.apiKey ?? ""}` : null;
  const lastConfigKey = useRef<string | null>(null);

  const fetchEntity = useCallback(async (type: CrmEntityType) => {
    if (!config) return;
    const tool = findToolForEntity(tools, type);

    setEntityData(prev => ({
      ...prev,
      [type]: { ...prev[type], loading: true, error: null, toolUsed: tool?.name ?? null },
    }));

    if (!tool) {
      setEntityData(prev => ({
        ...prev,
        [type]: { ...prev[type], loading: false, error: "No matching tool found", toolUsed: null },
      }));
      return;
    }

    const MAX_PAGES = 10; // safety cap — 10 * 200 = up to 2000 records
    const outerStart = Date.now();
    try {
      // Tool schemas vary by server (flat "page" vs. grouped under query_params,
      // or no pagination support at all) — resolve the real location instead of
      // guessing a flat "page" key, same as useCrmRecordSamples.ts does.
      const pageLoc = findParam(findParamLocations(tool), /^page$/i);

      let items: unknown[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        if (page > 1 && pageLoc) setParam(input, pageLoc, page);
        const output = await executeTool(config, tool.name, input);
        const pageItems = extractArray(output);
        items = items.concat(pageItems);

        onLog({
          id: Math.random().toString(36).slice(2),
          tool: tool.name,
          input,
          output,
          status: "success",
          durationMs: Date.now() - start,
          timestamp: new Date(),
        });

        if (!pageLoc || pageItems.length === 0 || !extractPageInfo(output)?.moreRecords) break;
      }

      setEntityData(prev => ({
        ...prev,
        [type]: { ...prev[type], loading: false, items, error: null, toolUsed: tool.name, lastFetched: Date.now() },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to fetch";
      onLog({
        id: Math.random().toString(36).slice(2),
        tool: tool.name,
        input: {},
        output: null,
        status: "error",
        errorMessage: msg,
        durationMs: Date.now() - outerStart,
        timestamp: new Date(),
      });
      setEntityData(prev => ({
        ...prev,
        [type]: { ...prev[type], loading: false, error: msg, toolUsed: tool.name },
      }));
    }
  }, [config, tools, onLog]);

  const fetchAll = useCallback(() => {
    if (!config) return;
    hasFetched.current = true;
    setLastRefresh(new Date());
    CRM_ENTITIES.forEach(e => fetchEntity(e.type));
  }, [config, fetchEntity]);

  // A new/different MCP connection (org switch, reconnect) must not keep
  // showing the previous org's cached items and score — reset so the
  // auto-fetch effect below re-runs against the new connection.
  useEffect(() => {
    if (configKey !== lastConfigKey.current) {
      lastConfigKey.current = configKey;
      hasFetched.current = false;
      setEntityData(makeInitial());
    }
  }, [configKey]);

  // Auto-fetch when tools are available
  useEffect(() => {
    if (!hasFetched.current && tools.length > 0) {
      fetchAll();
    }
  }, [tools, fetchAll]);

  const toggleExpand = useCallback((type: CrmEntityType) => {
    setEntityData(prev => ({
      ...prev,
      [type]: { ...prev[type], expanded: !prev[type].expanded },
    }));
  }, []);

  return { entityData, fetchEntity, fetchAll, toggleExpand, lastRefresh };
}
