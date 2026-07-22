"use client";

import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import type { Section } from "@/lib/sections";
import type { McpTool } from "@/types/mcp";

function tool(name: string): McpTool {
  return { name, description: `Mock tool ${name}` };
}

const categorized: Record<Section, McpTool[]> = {
  "crm-dashboard": [],
  modules: [
    tool("modules_get_records"), tool("modules_list_fields"), tool("modules_create_record"),
    tool("modules_update_record"), tool("modules_delete_record"), tool("contacts_get_all"),
  ],
  workflows: [tool("workflows_get_rules"), tool("workflows_list_triggers"), tool("workflows_get_actions")],
  blueprints: [tool("blueprints_get_transitions"), tool("blueprints_list_stages")],
  functions: [tool("functions_list_scripts")],
  fields: [tool("fields_get_picklist"), tool("fields_list_columns"), tool("fields_get_lookup")],
  logs: [],
  integrations: [],
};

const allTools = Object.values(categorized).flat();

export default function TestSidebarPage() {
  const [activeSection, setActiveSection] = useState<Section>("modules");
  return (
    <div className="app-shell">
      <Sidebar
        connected={true}
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        categorized={categorized}
        logCount={2}
        onDisconnect={() => {}}
        allTools={allTools}
      />
    </div>
  );
}
