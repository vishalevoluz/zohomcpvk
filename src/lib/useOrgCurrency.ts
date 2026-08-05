"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import { extractArray } from "@/lib/useCrmEntities";

const ORG_TOOL_PATTERNS = [/getorganization/i, /^getorg$/i, /orgdetails/i];

function extractCurrencySymbol(orgRecords: unknown[]): string | null {
  for (const orgRecord of orgRecords) {
    if (!orgRecord || typeof orgRecord !== "object") continue;
    const r = orgRecord as Record<string, unknown>;
    const symbol = r.currency_symbol ?? r.currencySymbol ?? r.iso_code ?? r.currency;
    if (typeof symbol === "string" && symbol.trim()) return symbol.trim();
  }
  return null;
}

// Best-effort org currency lookup so quantified cost figures ("₹4,50,000 of
// stale pipeline") use the connected org's real currency instead of assuming
// one — this tool audits Zoho orgs in any country. Falls back to null
// (callers show a plain number, see money.ts) when no matching tool exists
// or the response carries no recognizable currency field — same graceful-
// degradation pattern as useRuleCoverage.ts / usePipelineStages.ts.
export function useOrgCurrency(config: McpConfig | null, tools: McpTool[], onLog: (log: ExecutionLog) => void) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!config || tools.length === 0) return;
    const tool = tools.find(t => ORG_TOOL_PATTERNS.some(p => p.test(t.name)));
    if (!tool) return;

    const key = `${tool.name}::${refreshTick}`;
    if (fetchedKey.current === key) return;
    fetchedKey.current = key;

    (async () => {
      const start = Date.now();
      try {
        const output = await executeTool(config, tool.name, {});
        const items = extractArray(output);
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: tool.name, input: {}, output, status: "success",
          durationMs: Date.now() - start, timestamp: new Date(),
        });
        setSymbol(extractCurrencySymbol(items));
      } catch (e) {
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: tool.name, input: {}, output: null, status: "error",
          errorMessage: e instanceof Error ? e.message : "Failed to fetch organization",
          durationMs: Date.now() - start, timestamp: new Date(),
        });
      }
    })();
  }, [config, tools, onLog, refreshTick]);

  const refetch = useCallback(() => setRefreshTick(t => t + 1), []);
  return { symbol, refetch };
}
