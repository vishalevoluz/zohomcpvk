"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam } from "@/lib/zohoMcp";
import { extractArray, findToolForEntity } from "@/lib/useCrmEntities";
import { moduleApiName, findBlueprintFieldApiName } from "@/lib/crmPredicates";
import {
  RECORD_SAMPLE_STAGE_IDS,
  RECORD_SAMPLE_STAGE_MATCHERS,
  type RecordSampleStageId,
  type RecordSampleState,
} from "@/lib/flowMapModel";

export const RECORDS_SAMPLE_TOOL = "ZohoCRM_getRecords";
export const RECORDS_SAMPLE_SIZE = 50;

const INIT_STATE: RecordSampleState = { items: [], loading: false, error: null, lastFetched: null };

function makeInitial(): Record<RecordSampleStageId, RecordSampleState> {
  return Object.fromEntries(RECORD_SAMPLE_STAGE_IDS.map(id => [id, { ...INIT_STATE }])) as Record<RecordSampleStageId, RecordSampleState>;
}

function findStageModule(modules: unknown[], stageId: RecordSampleStageId): string | null {
  const mod = modules.find(m => {
    const name = moduleApiName(m);
    return name && RECORD_SAMPLE_STAGE_MATCHERS[stageId].some(re => re.test(name));
  });
  return mod ? moduleApiName(mod) : null;
}

// Zoho's "get all records" call requires an explicit `fields` param — there's no
// wildcard, so every stage needs its own base list. These cover each stage's
// name/email field plus whatever we need for conversion detection (Leads) or
// lookup cross-referencing (Deals/Invoices/Contacts). Lookup fields discovered
// via getFields and the module's blueprint driving field (if any) are merged in
// on top of this at fetch time, so the sample carries whatever a given org
// actually has configured instead of just this fixed baseline.
const STAGE_EXTRA_FIELDS: Record<RecordSampleStageId, string[]> = {
  leads: ["Last_Name", "Email", "Record_Status__s", "Converted__s", "Converted_Date_Time", "Converted_Contact_Id", "Converted_Account_Id", "Converted_Deal_Id"],
  contacts: ["Last_Name", "Email", "Account_Name"],
  deals: ["Deal_Name", "Contact_Name", "Account_Name"],
  accounts: ["Account_Name"],
  invoices: ["Subject", "Deal_Name", "Account_Name"],
};

// Zoho's `fields` query param is capped (the tool schema puts maxLength at 1024
// chars) — keep dropping the lowest-priority (last) names until the joined list
// fits rather than letting the call fail outright.
const MAX_FIELDS_PARAM_LENGTH = 1024;

function capFieldsToLength(fieldNames: string[]): string {
  const names = [...fieldNames];
  let joined = names.join(",");
  while (joined.length > MAX_FIELDS_PARAM_LENGTH && names.length > 1) {
    names.pop();
    joined = names.join(",");
  }
  return joined;
}

// The tool's own inputSchema is the source of truth for parameter names and
// locations — servers vary (module / module_name, flat / path_variables /
// query_params grouping), so read it instead of hardcoding a guess.
function buildRecordsInput(tool: McpTool | undefined, apiName: string, fieldNames: string[]): Record<string, unknown> {
  const locations = findParamLocations(tool);
  const moduleLoc = findParam(locations, /module/i) ?? { group: null, key: "module" };
  const perPageLoc = findParam(locations, /per_?page|page_?size|^limit$|^count$/i) ?? { group: null, key: "per_page" };
  const fieldsLoc = findParam(locations, /^fields$/i) ?? { group: null, key: "fields" };

  const input: Record<string, unknown> = {};
  setParam(input, moduleLoc, apiName);
  setParam(input, perPageLoc, RECORDS_SAMPLE_SIZE);
  setParam(input, fieldsLoc, capFieldsToLength(fieldNames));
  return input;
}

// Zoho's Leads endpoint supports filtering directly by conversion status — when
// the tool exposes that, use it to pull confirmed-converted leads instead of
// hoping a generic sample happens to include one. Far more reliable evidence.
function applyConvertedFilter(tool: McpTool | undefined, input: Record<string, unknown>) {
  const locations = findParamLocations(tool);
  const convertedLoc = findParam(locations, /^converted$/i);
  if (!convertedLoc) return;
  const props = convertedLoc.group ? tool?.inputSchema?.properties?.[convertedLoc.group]?.properties : tool?.inputSchema?.properties;
  const convertedSchema = props?.[convertedLoc.key];
  setParam(input, convertedLoc, convertedSchema?.type === "string" ? "true" : true);
}

// Discovers this module's lookup-type fields via getFields so the record sample
// can request them by name (Zoho's fields param has no wildcard) — this is what
// lets the flow map surface "lookups if present" instead of only the hand-picked
// STAGE_EXTRA_FIELDS. Best-effort: any failure here just means fewer fields get
// requested, not a broken sample.
async function fetchModuleLookupFieldNames(
  config: McpConfig,
  tools: McpTool[],
  apiName: string,
  onLog: (log: ExecutionLog) => void,
): Promise<string[]> {
  const tool = findToolForEntity(tools, "fields");
  if (!tool) return [];

  const locations = findParamLocations(tool);
  const moduleLoc = findParam(locations, /^module$/i) ?? { group: null, key: "module" };
  const includeLoc = findParam(locations, /^include$/i);
  const input: Record<string, unknown> = {};
  setParam(input, moduleLoc, apiName);
  if (includeLoc) {
    const props = includeLoc.group ? tool.inputSchema?.properties?.[includeLoc.group]?.properties : tool.inputSchema?.properties;
    const enumValues = props?.[includeLoc.key]?.enum;
    setParam(input, includeLoc, Array.isArray(enumValues) && enumValues.length > 0 ? enumValues[0] : "all");
  }

  const start = Date.now();
  try {
    const output = await executeTool(config, tool.name, input);
    const items = extractArray(output);
    onLog({
      id: Math.random().toString(36).slice(2),
      tool: tool.name, input, output, status: "success",
      durationMs: Date.now() - start, timestamp: new Date(),
    });
    return items
      .filter(f => f && typeof f === "object" && (f as Record<string, unknown>).data_type === "lookup")
      .map(f => String((f as Record<string, unknown>).api_name))
      .filter(Boolean)
      .slice(0, 15);
  } catch (e) {
    onLog({
      id: Math.random().toString(36).slice(2),
      tool: tool.name, input, output: null, status: "error",
      errorMessage: e instanceof Error ? e.message : "Failed to fetch fields",
      durationMs: Date.now() - start, timestamp: new Date(),
    });
    return [];
  }
}

// Some MCP servers return HTTP 200 / isError:false for the JSON-RPC call itself
// but wrap an underlying failure (e.g. the Zoho API call failed) in the payload —
// surface that as a real error instead of silently reading it as zero records.
function extractToolFailureMessage(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const structured = o.structuredContent as Record<string, unknown> | undefined;
  if (structured?.status === "failure") {
    const data = structured.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === "string") return data.message;
    return "Tool reported a failure";
  }
  if (o.isError === true) {
    if (Array.isArray(o.content)) {
      const textPart = (o.content as Record<string, unknown>[]).find(c => c.type === "text" && typeof c.text === "string");
      if (textPart) return String(textPart.text);
    }
    return "Tool reported an error";
  }
  return null;
}

// Pulls a small (per_page-capped) sample of real records for the stages the
// business-process flow map can corroborate (Leads/Contacts/Deals/Accounts/
// Invoices), so it can show actual evidence of movement instead of assuming a
// generic funnel. Gracefully no-ops if the connected MCP server doesn't expose
// a getRecords-style tool.
export function useCrmRecordSamples(
  config: McpConfig | null,
  tools: McpTool[],
  modules: unknown[],
  modulesResolved: boolean,
  blueprints: unknown[],
  onLog: (log: ExecutionLog) => void,
) {
  const [data, setData] = useState<Record<RecordSampleStageId, RecordSampleState>>(makeInitial);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!config) return;
    if (tools.length === 0) return;

    const tool = tools.find(t => t.name === RECORDS_SAMPLE_TOOL);
    if (!tool) {
      setData(prev => {
        let changed = false;
        const next = { ...prev };
        for (const id of RECORD_SAMPLE_STAGE_IDS) {
          if (next[id].lastFetched === null && next[id].error === null) {
            next[id] = { ...next[id], loading: false, error: "getRecords tool not available on this MCP server" };
            changed = true;
          }
        }
        return changed ? next : prev; // bail out with the same reference once already marked, or the effect loops forever
      });
      return;
    }

    if (!modulesResolved) return;

    // Folding blueprints.length into the key means once blueprint metadata
    // resolves (it's fetched in parallel with modules, so may arrive later)
    // this re-fetches once more so the blueprint driving field gets included.
    const key = `${modules.map(m => moduleApiName(m)).sort().join("|")}::${blueprints.length}::${refreshTick}`;
    if (fetchedKey.current === key) return;
    fetchedKey.current = key;

    RECORD_SAMPLE_STAGE_IDS.forEach(async stageId => {
      const apiName = findStageModule(modules, stageId);
      if (!apiName) return; // this business module doesn't exist in this CRM — nothing to sample

      setData(prev => ({ ...prev, [stageId]: { ...prev[stageId], loading: true, error: null } }));

      const lookupFields = await fetchModuleLookupFieldNames(config, tools, apiName, onLog);
      const blueprintField = findBlueprintFieldApiName(blueprints, apiName);
      const fieldNames = Array.from(new Set([
        "id",
        ...STAGE_EXTRA_FIELDS[stageId],
        ...lookupFields,
        ...(blueprintField ? [blueprintField] : []),
      ]));

      const input = buildRecordsInput(tool, apiName, fieldNames);
      if (stageId === "leads") applyConvertedFilter(tool, input);
      const start = Date.now();
      try {
        const output = await executeTool(config, RECORDS_SAMPLE_TOOL, input);
        const failureMsg = extractToolFailureMessage(output);
        if (failureMsg) throw new Error(failureMsg);
        const items = extractArray(output);
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: RECORDS_SAMPLE_TOOL, input, output, status: "success",
          durationMs: Date.now() - start, timestamp: new Date(),
        });
        setData(prev => ({ ...prev, [stageId]: { items, loading: false, error: null, lastFetched: Date.now() } }));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to fetch records";
        onLog({
          id: Math.random().toString(36).slice(2),
          tool: RECORDS_SAMPLE_TOOL, input, output: null, status: "error",
          errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date(),
        });
        setData(prev => ({ ...prev, [stageId]: { ...prev[stageId], loading: false, error: msg } }));
      }
    });
  }, [config, tools, modules, modulesResolved, blueprints, onLog, refreshTick]);

  const refetch = useCallback(() => setRefreshTick(t => t + 1), []);

  return { data, refetch };
}
