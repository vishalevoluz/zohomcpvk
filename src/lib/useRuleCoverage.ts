"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { automationCoverageApiNames } from "@/lib/flowMapModel";
import type { RuleCoverage } from "@/lib/businessScore";

function parseMcpJson(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string") {
        try { return JSON.parse(item.text) as Record<string, unknown>; } catch { /* not JSON */ }
      }
    }
  }
  return r;
}

function countRulesInResponse(result: unknown): number {
  const parsed = parseMcpJson(result);
  if (!parsed) return 0;
  for (const v of Object.values(parsed)) {
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

type PerModuleKey = "validation" | "layout" | "assignment" | "approval";

// Tool-name patterns for the automation types that require a `module` query
// param per call - same reasoning as the pre-existing validation/layout regex:
// anchored to end-of-name so a server that prefixes tool names (e.g. "ZohoCRM_")
// still matches, without also matching count/usage sibling tools.
const PER_MODULE_RULE_TOOLS: { key: PerModuleKey; pattern: RegExp }[] = [
  { key: "validation", pattern: /getvalidationrules$/i },
  { key: "layout", pattern: /getlayoutrules$/i },
  { key: "assignment", pattern: /getassignmentrules$/i },
  { key: "approval", pattern: /getapprovalrules$|getapprovalprocess(es)?$/i },
];

// Schedules (recurring scheduled functions/actions) have no dedicated
// listing tool anywhere in Zoho's real MCP catalogue - unlike
// validation/layout/assignment rules, there's no "getSchedules"-shaped tool
// to even loosely pattern-match for. A previous broad regex match here
// (getschedule/listschedule/allschedule/etc.) risked colliding with some
// unrelated tool on a given server and reporting a fake, non-zero schedule
// count - scheduleCount is always null ("couldn't check") below instead,
// same honesty as the Activity card's "no matching tool found".
export function isScheduleTool(_name: string): boolean {
  return false;
}

// Assignment/approval/validation/layout rules and schedules each need a
// `module` query param (or nothing, for schedules) and so can't ride along
// with the flat entity fetches in useCrmEntities.ts - pulled in separately
// for the same core lifecycle modules the flow map and Automation Coverage
// dimension already check (Leads, Contacts, Deals, Accounts). Shared by
// BusinessView and CRMOverviewDashboard so both reflect the same broadened
// definition of "automation" without fetching twice.
//
// Exposes `refetch` (same refreshTick pattern as usePipelineStages.ts) so a
// manual dashboard refresh actually re-pulls rule counts - without it, a rule
// added in Zoho after the first load would never show up until a full page
// reload, since the old implementation fetched only once per session.
export function useRuleCoverage(
  config: McpConfig | null,
  tools: McpTool[],
  entityData: Record<CrmEntityType, EntityState>,
  onLog: (log: ExecutionLog) => void
): { data: RuleCoverage | null; refetch: () => void } {
  const [ruleCoverage, setRuleCoverage] = useState<RuleCoverage | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedTick = useRef<number | null>(null);

  useEffect(() => {
    if (!config || tools.length === 0) return;
    if (!isEntityResolved(entityData.modules)) return;
    if (fetchedTick.current === refreshTick) return;

    const matchedTools = PER_MODULE_RULE_TOOLS
      .map(def => ({ key: def.key, tool: tools.find(t => def.pattern.test(t.name)) }))
      .filter((m): m is { key: PerModuleKey; tool: McpTool } => !!m.tool);
    if (matchedTools.length === 0) return;

    const coreApiNames = automationCoverageApiNames(entityData.modules.items);
    if (coreApiNames.length === 0) return;

    fetchedTick.current = refreshTick;
    void (async () => {
      const buckets: Record<PerModuleKey, Record<string, number>> = {
        validation: {}, layout: {}, assignment: {}, approval: {},
      };

      for (const apiName of coreApiNames) {
        for (const { key, tool } of matchedTools) {
          const start = Date.now();
          const input = { query_params: { module: apiName } };
          try {
            const output = await executeTool(config, tool.name, input);
            buckets[key][apiName] = countRulesInResponse(output);
            onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          } catch (e: unknown) {
            onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          }
        }
      }

      // No dedicated schedule-listing tool exists in Zoho's real MCP
      // catalogue to even attempt - see isScheduleTool above.
      setRuleCoverage({ ...buckets, scheduleCount: null });
    })();
  }, [config, tools, entityData.modules, onLog, refreshTick]);

  const refetch = useCallback(() => setRefreshTick(t => t + 1), []);

  return { data: ruleCoverage, refetch };
}
