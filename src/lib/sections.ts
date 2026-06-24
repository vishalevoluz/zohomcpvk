import type { McpTool } from "@/types/mcp";

export type Section = "modules" | "workflows" | "blueprints" | "functions" | "logs";

export const SECTIONS = [
  { id: "modules" as const,    label: "Modules",    icon: "⊞", keywords: ["module", "record", "contact", "lead", "deal", "account", "crm"] },
  { id: "workflows" as const,  label: "Workflows",  icon: "⟳", keywords: ["workflow", "automation", "trigger", "rule"] },
  { id: "blueprints" as const, label: "Blueprints", icon: "◈", keywords: ["blueprint", "transition", "stage"] },
  { id: "functions" as const,  label: "Functions",  icon: "ƒ", keywords: ["function", "script", "custom_function", "deluge", "automation_script", "serverless"] },
] as const;

// Check specific sections before modules so broad names like "crm" don't swallow everything
const CATEGORIZE_ORDER: Section[] = ["workflows", "blueprints", "functions", "modules"];

export function categorizeTools(tools: McpTool[]): Record<Section, McpTool[]> {
  const result: Record<Section, McpTool[]> = {
    modules: [], workflows: [], blueprints: [], functions: [], logs: [],
  };
  for (const tool of tools) {
    const hay = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    let matched = false;
    for (const secId of CATEGORIZE_ORDER) {
      const sec = SECTIONS.find(s => s.id === secId)!;
      if (sec.keywords.some(kw => hay.includes(kw))) {
        result[secId].push(tool);
        matched = true;
        break;
      }
    }
    if (!matched) result.modules.push(tool);
  }
  return result;
}
