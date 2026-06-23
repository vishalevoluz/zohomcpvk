"use client";

import { useState, useRef, useEffect } from "react";
import type { McpTool } from "@/types/mcp";

interface Props {
  tools: McpTool[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export default function MultiToolSelect({ tools, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name]);
  }

  const label =
    selected.length === 0 ? "Select tools…"
    : selected.length === 1 ? selected[0]
    : `${selected.length} tools selected`;

  return (
    <div className="multi-select" ref={ref}>
      <button
        type="button"
        className="multi-select-trigger"
        onClick={() => setOpen(o => !o)}
      >
        <span className="multi-select-label">{label}</span>
        <span className="multi-select-arrow">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="multi-select-dropdown">
          <div className="multi-select-actions">
            <button type="button" className="btn-secondary" onClick={() => onChange(tools.map(t => t.name))}>
              All
            </button>
            <button type="button" className="btn-secondary" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <div className="multi-select-list">
            {tools.map(tool => (
              <label key={tool.name} className="multi-select-item">
                <input
                  type="checkbox"
                  checked={selected.includes(tool.name)}
                  onChange={() => toggle(tool.name)}
                />
                <span className="multi-select-item-name">{tool.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
