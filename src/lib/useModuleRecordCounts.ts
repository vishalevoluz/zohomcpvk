"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam } from "@/lib/zohoMcp";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { moduleApiName, unreferencedModules, isDeletedModule, isInternalModule } from "@/lib/crmPredicates";

const RECORD_COUNT_TOOL_PATTERNS = [/getrecordcount$/i, /recordcount$/i];
// Bounds how many getRecordCount calls one refresh makes — the shortlist
// (modules already unreferenced by any workflow/blueprint) is normally small,
// but this caps it regardless so a large org can't trigger dozens of calls.
const MAX_MODULES_TO_CHECK = 12;

function extractCount(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const r = output as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const c of r.content as Record<string, unknown>[]) {
      if (c.type === "text" && typeof c.text === "string") {
        try {
          const parsed = JSON.parse(c.text);
          const n = extractCount(parsed);
          if (n !== null) return n;
        } catch { /* not JSON */ }
      }
    }
  }
  const raw = r.count ?? r.record_count ?? r.total ?? r.recordCount;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return null;
}

export interface ModuleRecordCountsState {
  /** apiName -> confirmed record count, only for modules actually checked this pass. */
  counts: Record<string, number>;
  toolAvailable: boolean;
  resolved: boolean;
}

const INIT_STATE: ModuleRecordCountsState = { counts: {}, toolAvailable: false, resolved: false };

// Best-effort confirmation of "this module really has 0 records" for the
// short heuristic shortlist of modules already unreferenced by any workflow
// or blueprint (see unreferencedModules in crmPredicates.ts) — the
// empty-modules finding uses this to say "confirmed 0 records" instead of
// just "not referenced by automation" wherever the server supports it.
// Gracefully no-ops (toolAvailable: false) if no getRecordCount-style tool
// exists on this MCP server — same pattern as useRuleCoverage.ts.
export function useModuleRecordCounts(
  config: McpConfig | null,
  tools: McpTool[],
  entityData: Record<CrmEntityType, EntityState>,
  onLog: (log: ExecutionLog) => void,
) {
  const [state, setState] = useState<ModuleRecordCountsState>(INIT_STATE);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedKey = useRef<string | null>(null);

  const modulesResolved = isEntityResolved(entityData.modules);
  const workflowsResolved = isEntityResolved(entityData.workflows);
  const blueprintsResolved = isEntityResolved(entityData.blueprints);

  useEffect(() => {
    if (!config || tools.length === 0) return;
    if (!modulesResolved || !workflowsResolved || !blueprintsResolved) return;

    const tool = tools.find(t => RECORD_COUNT_TOOL_PATTERNS.some(p => p.test(t.name)));
    if (!tool) {
      setState(prev => (prev.resolved ? prev : { counts: {}, toolAvailable: false, resolved: true }));
      return;
    }

    const realModules = entityData.modules.items.filter(m => !isDeletedModule(m) && !isInternalModule(m));
    const candidates = unreferencedModules(realModules, entityData.workflows.items, entityData.blueprints.items)
      .map(moduleApiName)
      .filter(Boolean)
      .slice(0, MAX_MODULES_TO_CHECK);

    const key = `${candidates.sort().join("|")}::${refreshTick}`;
    if (fetchedKey.current === key) return;
    fetchedKey.current = key;

    if (candidates.length === 0) {
      setState({ counts: {}, toolAvailable: true, resolved: true });
      return;
    }

    (async () => {
      const counts: Record<string, number> = {};
      for (const apiName of candidates) {
        const locations = findParamLocations(tool);
        const moduleLoc = findParam(locations, /^module$/i) ?? { group: null, key: "module" };
        const input: Record<string, unknown> = {};
        setParam(input, moduleLoc, apiName);

        const start = Date.now();
        try {
          const output = await executeTool(config, tool.name, input);
          const count = extractCount(output);
          onLog({
            id: Math.random().toString(36).slice(2),
            tool: tool.name, input, output, status: "success",
            durationMs: Date.now() - start, timestamp: new Date(),
          });
          if (count !== null) counts[apiName] = count;
        } catch (e) {
          onLog({
            id: Math.random().toString(36).slice(2),
            tool: tool.name, input, output: null, status: "error",
            errorMessage: e instanceof Error ? e.message : "Failed to fetch record count",
            durationMs: Date.now() - start, timestamp: new Date(),
          });
        }
      }
      setState({ counts, toolAvailable: true, resolved: true });
    })();
  }, [config, tools, entityData, modulesResolved, workflowsResolved, blueprintsResolved, onLog, refreshTick]);

  const refetch = useCallback(() => setRefreshTick(t => t + 1), []);
  return { data: state, refetch };
}
