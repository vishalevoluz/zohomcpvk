import type { McpTool } from "@/types/mcp";

export type Section = "crm-overview" | "modules" | "workflows" | "blueprints" | "functions" | "fields" | "logs" | "integrations";

export const SECTIONS = [
  { id: "modules" as const,    label: "Modules",    icon: "⊞", keywords: ["module", "record", "contact", "lead", "deal", "account", "crm"] },
  { id: "workflows" as const,  label: "Workflows",  icon: "⟳", keywords: ["workflow", "automation", "trigger", "rule"] },
  { id: "blueprints" as const, label: "Blueprints", icon: "◈", keywords: ["blueprint", "transition", "stage"] },
  { id: "functions" as const,  label: "Functions",  icon: "ƒ", keywords: ["function", "script", "custom_function", "deluge", "automation_script", "serverless"] },
] as const;

// Keyword map for tool categorization — includes "fields" even though it's not a sidebar section
const CATEGORIZE_KEYWORDS: Record<Section, string[]> = {
  "crm-overview": [],
  workflows:    ["workflow", "automation", "trigger", "rule"],
  blueprints:   ["blueprint", "transition", "stage"],
  functions:    ["function", "script", "custom_function", "deluge", "automation_script", "serverless"],
  fields:       ["field", "fields", "column", "attribute", "picklist", "lookup"],
  modules:      ["module", "record", "contact", "lead", "deal", "account", "crm"],
  logs:         [],
  integrations: [],
};

// Check specific sections before modules so broad names like "crm" don't swallow everything
const CATEGORIZE_ORDER: Section[] = ["workflows", "blueprints", "functions", "fields", "modules"];

export function categorizeTools(tools: McpTool[]): Record<Section, McpTool[]> {
  const result: Record<Section, McpTool[]> = {
    "crm-overview": [], modules: [], workflows: [], blueprints: [], functions: [], fields: [], logs: [], integrations: [],
  };
  for (const tool of tools) {
    const hay = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    let matched = false;
    for (const secId of CATEGORIZE_ORDER) {
      if (CATEGORIZE_KEYWORDS[secId].some(kw => hay.includes(kw))) {
        result[secId].push(tool);
        matched = true;
        break;
      }
    }
    if (!matched) result.modules.push(tool);
  }
  return result;
}
