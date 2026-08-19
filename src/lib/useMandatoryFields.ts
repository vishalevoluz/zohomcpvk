"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam } from "@/lib/zohoMcp";
import { extractArray, findToolForEntity, resolveCoreModuleApiNames } from "@/lib/useCrmEntities";

export interface MandatoryFieldsState {
  count: number;
  /** Real field labels, one entry per mandatory field per core module — not deduped across modules, since the same label (e.g. "Description") being required on both Leads and Deals is two distinct configurations, not a duplicate. */
  fieldLabels: string[];
  /** Mandatory-field count per core module, only for modules the fetch actually resolved — lets a consumer name which module(s) are driving a high total. */
  perModule: { apiName: string; count: number }[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

const INIT_STATE: MandatoryFieldsState = { count: 0, fieldLabels: [], perModule: [], loading: false, error: null, lastFetched: null };

// Same active-layout-or-first pick usePipelineStages.ts uses for the Deals
// layout — reused here per core module rather than imported, since that
// module's version is tied to its own single-module fetch flow.
function pickLayout(layouts: unknown[]): Record<string, unknown> | null {
  if (layouts.length === 0) return null;
  const active = layouts.find(l => {
    const r = l as Record<string, unknown>;
    return r.visible !== false && (r.status === undefined || r.status === "active");
  });
  return (active ?? layouts[0]) as Record<string, unknown>;
}

// The flat Fields API has no reliable per-org "is this field required"
// signal: its "mandatory" key never appears as a boolean on a field (only
// inside editable_properties, a list of which properties an admin may edit),
// and "system_mandatory" only covers Zoho's own hardcoded required fields
// (Last_Name, Email, ...), never an admin-configured required custom/standard
// field. That flag only exists on each LAYOUT's own field config — this is
// the one real source for it.
function mandatoryFieldLabelsFromLayout(layout: Record<string, unknown> | null): string[] {
  if (!layout) return [];
  const sections = Array.isArray(layout.sections) ? (layout.sections as unknown[]) : [];
  const labels: string[] = [];
  for (const s of sections) {
    const fields = Array.isArray((s as Record<string, unknown>).fields) ? ((s as Record<string, unknown>).fields as unknown[]) : [];
    for (const f of fields) {
      const r = f as Record<string, unknown>;
      if (r.mandatory === true) {
        const label = String(r.field_label ?? r.api_name ?? "").trim();
        if (label) labels.push(label);
      }
    }
  }
  return labels;
}

// Fetches the real mandatory-field count for Leads/Contacts/Deals/Accounts
// via getLayouts (module -> layout -> sections -> fields[].mandatory), one
// call per core module — same per-module fan-out shape as fetchScopedFields
// in useCrmEntities.ts (the flat Fields endpoint), because Zoho's layouts
// endpoint is equally module-scoped with no "all modules" mode.
export function useMandatoryFields(
  config: McpConfig | null,
  tools: McpTool[],
  moduleItems: unknown[],
  modulesResolved: boolean,
  onLog: (log: ExecutionLog) => void,
) {
  const [data, setData] = useState<MandatoryFieldsState>(INIT_STATE);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!config || tools.length === 0 || !modulesResolved) return;

    const layoutsTool = findToolForEntity(tools, "layouts");
    if (!layoutsTool) {
      setData(prev =>
        prev.lastFetched === null && prev.error === null
          ? { ...prev, loading: false, error: "getLayouts tool not available on this MCP server" }
          : prev
      );
      return;
    }

    const coreApiNames = resolveCoreModuleApiNames(moduleItems);
    const key = `${coreApiNames.join(",")}::${refreshTick}`;
    if (fetchedKey.current === key) return;
    fetchedKey.current = key;

    if (coreApiNames.length === 0) {
      setData({ count: 0, fieldLabels: [], perModule: [], loading: false, error: "Could not find Leads/Contacts/Deals/Accounts modules to fetch layouts for", lastFetched: Date.now() });
      return;
    }

    (async () => {
      setData(prev => ({ ...prev, loading: true, error: null }));

      const moduleLoc = findParam(findParamLocations(layoutsTool), /^module$/i) ?? { group: null, key: "module" };
      const allLabels: string[] = [];
      const perModule: { apiName: string; count: number }[] = [];
      let lastError: string | null = null;
      let anySucceeded = false;

      for (const apiName of coreApiNames) {
        const input: Record<string, unknown> = {};
        setParam(input, moduleLoc, apiName);
        const start = Date.now();
        try {
          const output = await executeTool(config, layoutsTool.name, input);
          const layouts = extractArray(output);
          const layout = pickLayout(layouts);
          const labels = mandatoryFieldLabelsFromLayout(layout);
          allLabels.push(...labels);
          perModule.push({ apiName, count: labels.length });
          anySucceeded = true;
          onLog({
            id: Math.random().toString(36).slice(2),
            tool: layoutsTool.name, input, output, status: "success",
            durationMs: Date.now() - start, timestamp: new Date(),
          });
        } catch (e) {
          lastError = e instanceof Error ? e.message : "Failed to fetch layouts";
          onLog({
            id: Math.random().toString(36).slice(2),
            tool: layoutsTool.name, input, output: null, status: "error",
            errorMessage: lastError, durationMs: Date.now() - start, timestamp: new Date(),
          });
        }
      }

      // Partial success (some core modules resolved, one failed) still counts
      // as real data, matching fetchScopedFields's "keep what worked" stance.
      setData({
        count: allLabels.length,
        fieldLabels: allLabels,
        perModule,
        loading: false,
        error: anySucceeded ? null : lastError,
        lastFetched: Date.now(),
      });
    })();
  }, [config, tools, moduleItems, modulesResolved, onLog, refreshTick]);

  const refetch = useCallback(() => setRefreshTick(t => t + 1), []);

  return { data, refetch };
}
