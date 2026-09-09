"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam, type ParamLocation } from "@/lib/zohoMcp";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import { isEntityResolved } from "@/lib/useCrmEntities";
import { automationCoverageApiNames } from "@/lib/flowMapModel";
import { isActiveWorkflow, workflowModuleLabel } from "@/lib/crmPredicates";
import type { RuleCoverage, RuleTypeStat } from "@/lib/businessScore";

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

// A tool can report a business-logic failure (e.g. "Mandatory query param
// \"module\" is not present in tool body") while the MCP transport call
// itself still succeeds (isError: false) - Zoho's tool wrapper puts that
// verdict in structuredContent.status / structuredContent.data.status, NOT
// in the transport-level isError flag. Without checking this, the response
// still has a `content` array (holding the one error-message text block),
// so parseMcpJson's own fallback and extractRuleArray's "first array value"
// scan below would treat that single error-message block as if it were one
// real rule - the exact bug that made e.g. a param-shape mismatch on
// getLayoutRules read as "1 active layout rule" for every module instead of
// a failed call.
function isFailureResponse(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const sc = (result as Record<string, unknown>).structuredContent as Record<string, unknown> | undefined;
  if (!sc) return false;
  const dataStatus = (sc.data as Record<string, unknown> | undefined)?.status;
  return sc.status === "failure" || dataStatus === "failure";
}

function failureMessage(result: unknown): string {
  const sc = (result as Record<string, unknown>)?.structuredContent as Record<string, unknown> | undefined;
  const data = sc?.data as Record<string, unknown> | undefined;
  return typeof data?.message === "string" ? data.message : "Tool reported failure";
}

function extractRuleArray(result: unknown): unknown[] {
  if (isFailureResponse(result)) return [];
  const parsed = parseMcpJson(result);
  if (!parsed) return [];
  for (const v of Object.values(parsed)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

// Defends against a tool that accepts the module filter argument but doesn't
// actually apply it server-side (returns every module's rules regardless of
// what was asked for) - the exact failure mode that made e.g. Accounts show
// a layout rule that only really exists on another module. If a returned
// item names its own module (same generic module/module_name/se_module/
// entity shape workflows and blueprints use), it's kept only when that name
// matches the module just requested; an item with no discoverable module
// reference at all is trusted as-is, since there's nothing to cross-check.
function belongsToRequestedModule(item: unknown, apiName: string): boolean {
  const label = workflowModuleLabel(item);
  return label === "" || label.toLowerCase() === apiName.toLowerCase();
}

// total = every rule of this type the API returned for the module (after the
// belongsToRequestedModule cross-check above); active = the subset
// isActiveWorkflow's generic active/enabled/status check treats as turned
// on. A rule with no such field defaults to active (same "unknown means on"
// fallback isActiveWorkflow uses for workflows).
function statForItems(items: unknown[]): RuleTypeStat {
  return { total: items.length, active: items.filter(isActiveWorkflow).length };
}

// A stable identity for a set of rule items - sorted so item order in the
// response can't hide a real match, and falling back to the full JSON of an
// item with no id/name at all rather than dropping it silently.
function fingerprintItems(items: unknown[]): string {
  return items
    .map(it => {
      const r = (it ?? {}) as Record<string, unknown>;
      return String(r.id ?? r.rule_id ?? r.name ?? JSON.stringify(r));
    })
    .sort()
    .join("|");
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
  // "getapprovalprocess(es)?$" matches the real tool name, getApprovalProcess;
  // "getapprovalrules$" is kept as a fallback in case some other MCP server
  // variant exposes it under that name instead.
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

    // Resolve where the `module` argument actually lives per tool (flat
    // property vs. nested under query_params/path_variables/etc.) instead of
    // assuming every server groups it the same way - a wrong guess here
    // doesn't error, it just gets silently dropped, so the "filtered" call
    // quietly returns every module's rules and every module falsely looks
    // covered. A tool whose schema exposes no module-shaped param at all is
    // skipped rather than called unfiltered, since that would report the
    // exact same false coverage.
    const matchedTools = PER_MODULE_RULE_TOOLS
      .map(def => {
        const tool = tools.find(t => def.pattern.test(t.name));
        if (!tool) return null;
        const moduleLoc = findParam(findParamLocations(tool), /module/i);
        if (!moduleLoc) return null;
        return { key: def.key, tool, moduleLoc };
      })
      .filter((m): m is { key: PerModuleKey; tool: McpTool; moduleLoc: ParamLocation } => !!m);
    if (matchedTools.length === 0) return;

    const coreApiNames = automationCoverageApiNames(entityData.modules.items);
    if (coreApiNames.length === 0) return;

    fetchedTick.current = refreshTick;
    void (async () => {
      const buckets: Record<PerModuleKey, Record<string, RuleTypeStat>> = {
        validation: {}, layout: {}, assignment: {}, approval: {},
      };

      // Looped tool-outer, module-inner (rather than the reverse) so every
      // module's result for a given tool is in hand before deciding whether
      // to trust any of them - see the cross-module check below.
      for (const { key, tool, moduleLoc } of matchedTools) {
        const perModule: Record<string, { items: unknown[]; fingerprint: string }> = {};
        for (const apiName of coreApiNames) {
          const start = Date.now();
          const input: Record<string, unknown> = {};
          setParam(input, moduleLoc, apiName);
          try {
            const output = await executeTool(config, tool.name, input);
            const failed = isFailureResponse(output);
            const items = failed ? [] : extractRuleArray(output).filter(item => belongsToRequestedModule(item, apiName));
            perModule[apiName] = { items, fingerprint: fingerprintItems(items) };
            // A tool-reported failure (see isFailureResponse) surfaces here as
            // an error-status log entry - same visibility as a thrown/network
            // failure below - instead of silently logging "success" for a
            // call that told us it didn't actually run.
            onLog(failed
              ? { id: crypto.randomUUID(), tool: tool.name, input, output, status: "error", errorMessage: failureMessage(output), durationMs: Date.now() - start, timestamp: new Date() }
              : { id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          } catch (e: unknown) {
            onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          }
        }
        // Sanity check: if 2+ modules came back with a non-empty result that's
        // byte-for-byte IDENTICAL (same rule ids/names), the `module` filter
        // almost certainly isn't being applied server-side for this tool -
        // real per-module rule sets essentially never collide exactly. Rather
        // than report numbers we now have concrete reason to distrust for
        // EVERY module, this rule type is treated as unverified (0/off)
        // across the board - the same "couldn't confirm, so say nothing"
        // honesty as scheduleCount: null below, instead of the false
        // positive that made e.g. Accounts show a layout rule found on some
        // other module entirely.
        const nonEmpty = Object.values(perModule).filter(v => v.items.length > 0);
        const filterLooksBroken = nonEmpty.length >= 2 && nonEmpty.every(v => v.fingerprint === nonEmpty[0].fingerprint);
        for (const apiName of coreApiNames) {
          buckets[key][apiName] = filterLooksBroken ? { total: 0, active: 0 } : statForItems(perModule[apiName]?.items ?? []);
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
