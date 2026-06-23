"use client";

import type { McpTool } from "@/types/mcp";

interface Props {
  tools: McpTool[];
  onSelect: (tool: McpTool) => void;
}

export default function ToolsList({ tools, onSelect }: Props) {
  if (!tools.length) {
    return <div className="empty-state">No tools returned by the server.</div>;
  }

  return (
    <ul className="tool-list">
      {tools.map(tool => (
        <li key={tool.name} className="tool-item" onClick={() => onSelect(tool)}>
          <div className="tool-info">
            <span className="tool-name">{tool.name}</span>
            <span className="tool-desc">{tool.description || "No description"}</span>
          </div>
          <span className="tool-badge">Run →</span>
        </li>
      ))}
    </ul>
  );
}
