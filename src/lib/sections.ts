import type { McpTool } from "@/types/mcp";

export type Section = "modules" | "workflows" | "fields" | "blueprints" | "functions" | "logs";

export const SECTIONS = [
  { id: "modules" as const,    label: "Modules",    icon: "⊞", keywords: ["module", "record", "contact", "lead", "deal", "account", "crm"] },
  { id: "workflows" as const,  label: "Workflows",  icon: "⟳", keywords: ["workflow", "automation", "trigger", "rule"] },
  { id: "fields" as const,     label: "Fields",     icon: "☰", keywords: ["field", "layout", "picklist", "metadata"] },
  { id: "blueprints" as const, label: "Blueprints", icon: "◈", keywords: ["blueprint", "transition", "stage"] },
  { id: "functions" as const,  label: "Functions",  icon: "ƒ", keywords: ["function", "script", "custom_function", "deluge"] },
] as const;

export function categorizeTools(tools: McpTool[]): Record<Section, McpTool[]> {
  const result: Record<Section, McpTool[]> = {
    modules: [], workflows: [], fields: [], blueprints: [], functions: [], logs: [],
  };
  for (const tool of tools) {
    const hay = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    let matched = false;
    for (const sec of SECTIONS) {
      if (sec.keywords.some(kw => hay.includes(kw))) {
        result[sec.id].push(tool);
        matched = true;
        break;
      }
    }
    if (!matched) result.modules.push(tool);
  }
  return result;
}
