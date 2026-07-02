"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CrmEntityType = "blueprints" | "modules" | "layouts" | "tasks" | "pipelines" | "stages" | "workflows" | "profiles" | "users" | "fields";

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

export function getItemName(item: unknown, idx: number): string {
  if (!item || typeof item !== "object") return `Item ${idx + 1}`;
  const r = item as Record<string, unknown>;
  return String(
    r.name ?? r.display_name ?? r.label ?? r.api_name ??
    r.workflow_name ?? r.blueprint_name ?? r.pipeline_name ??
    r.stage_name ?? r.title ?? `Item ${idx + 1}`
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

    const start = Date.now();
    try {
      const output = await executeTool(config, tool.name, {});
      const items = extractArray(output);
      const durationMs = Date.now() - start;

      onLog({
        id: Math.random().toString(36).slice(2),
        tool: tool.name,
        input: {},
        output,
        status: "success",
        durationMs,
        timestamp: new Date(),
      });

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
        durationMs: Date.now() - start,
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
