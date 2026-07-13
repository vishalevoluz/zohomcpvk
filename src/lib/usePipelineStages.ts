"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam } from "@/lib/zohoMcp";
import { extractArray, findToolForEntity } from "@/lib/useCrmEntities";
import type { PipelineStage, PipelineStagesState } from "@/lib/flowMapModel";

const INIT_STATE: PipelineStagesState = { items: [], loading: false, error: null, lastFetched: null };

// This MCP server has no dedicated "list stages" tool — real stage names live in
// a module's active layout's pipeline config, reached via getLayouts (module ->
// layouts) then getPipelines (layout_id -> pipeline.maps). Neither response
// marks a single "the" layout/pipeline as canonical, so prefer an active/visible
// layout and a default pipeline, falling back to the first entry either way.
function pickLayout(layouts: unknown[]): Record<string, unknown> | null {
  if (layouts.length === 0) return null;
  const active = layouts.find(l => {
    const r = l as Record<string, unknown>;
    return r.visible !== false && (r.status === undefined || r.status === "active");
  });
  return (active ?? layouts[0]) as Record<string, unknown>;
}

function pickPipeline(pipelines: unknown[]): Record<string, unknown> | null {
  if (pipelines.length === 0) return null;
  const def = pipelines.find(p => (p as Record<string, unknown>).default === true);
  return (def ?? pipelines[0]) as Record<string, unknown>;
}

function toPipelineStages(pipeline: Record<string, unknown> | null): PipelineStage[] {
  const maps = Array.isArray(pipeline?.maps) ? (pipeline!.maps as unknown[]) : [];
  return maps
    .map(m => {
      const r = (m ?? {}) as Record<string, unknown>;
      const name = String(r.display_value ?? r.actual_value ?? "");
      return {
        name,
        apiName: String(r.actual_value ?? name),
        sequence: Number(r.sequence_number ?? 0),
        forecastType: typeof r.forecast_type === "string" ? r.forecast_type : undefined,
      };
    })
    .filter(s => s.name)
    .sort((a, b) => a.sequence - b.sequence);
}

// Fetches the real Deals pipeline stage names for the "How a Lead Moves Through
// Your Business" flow map, via the getLayouts -> getPipelines chain rather than
// the generic "stages" entity (see useCrmEntities.ts), which never resolves to
// anything on this server since no tool name matches its patterns.
export function usePipelineStages(
  config: McpConfig | null,
  tools: McpTool[],
  dealsApiName: string | null,
  onLog: (log: ExecutionLog) => void,
) {
  const [data, setData] = useState<PipelineStagesState>(INIT_STATE);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!config || tools.length === 0 || !dealsApiName) return;

    const layoutsTool = findToolForEntity(tools, "layouts");
    const pipelinesTool = findToolForEntity(tools, "pipelines");
    if (!layoutsTool || !pipelinesTool) {
      setData(prev =>
        prev.lastFetched === null && prev.error === null
          ? { ...prev, loading: false, error: "getLayouts/getPipelines tools not available on this MCP server" }
          : prev
      );
      return;
    }

    const key = `${dealsApiName}::${refreshTick}`;
    if (fetchedKey.current === key) return;
    fetchedKey.current = key;

    (async () => {
      setData(prev => ({ ...prev, loading: true, error: null }));

      const layoutLocs = findParamLocations(layoutsTool);
      const moduleLoc = findParam(layoutLocs, /^module$/i) ?? { group: null, key: "module" };
      const layoutsInput: Record<string, unknown> = {};
      setParam(layoutsInput, moduleLoc, dealsApiName);

      let layout: Record<string, unknown> | null;
      const layoutsStart = Date.now();
      try {
        const output = await executeTool(config, layoutsTool.name, layoutsInput);
        const layouts = extractArray(output);
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: layoutsTool.name, input: layoutsInput, output, status: "success",
          durationMs: Date.now() - layoutsStart, timestamp: new Date(),
        });
        layout = pickLayout(layouts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to fetch layouts";
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: layoutsTool.name, input: layoutsInput, output: null, status: "error",
          errorMessage: msg, durationMs: Date.now() - layoutsStart, timestamp: new Date(),
        });
        setData(prev => ({ ...prev, loading: false, error: msg }));
        return;
      }

      if (!layout) {
        setData({ items: [], loading: false, error: null, lastFetched: Date.now() });
        return;
      }

      const pipelineLocs = findParamLocations(pipelinesTool);
      const layoutIdLoc = findParam(pipelineLocs, /layout_?id/i) ?? { group: null, key: "layout_id" };
      const pipelinesInput: Record<string, unknown> = {};
      setParam(pipelinesInput, layoutIdLoc, String(layout.id ?? ""));

      const pipelinesStart = Date.now();
      try {
        const output = await executeTool(config, pipelinesTool.name, pipelinesInput);
        const pipelines = extractArray(output);
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: pipelinesTool.name, input: pipelinesInput, output, status: "success",
          durationMs: Date.now() - pipelinesStart, timestamp: new Date(),
        });
        const items = toPipelineStages(pickPipeline(pipelines));
        setData({ items, loading: false, error: null, lastFetched: Date.now() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to fetch pipelines";
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: pipelinesTool.name, input: pipelinesInput, output: null, status: "error",
          errorMessage: msg, durationMs: Date.now() - pipelinesStart, timestamp: new Date(),
        });
        setData(prev => ({ ...prev, loading: false, error: msg }));
      }
    })();
  }, [config, tools, dealsApiName, onLog, refreshTick]);

  const refetch = useCallback(() => setRefreshTick(t => t + 1), []);

  return { data, refetch };
}
