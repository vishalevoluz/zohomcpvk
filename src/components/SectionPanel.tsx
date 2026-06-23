"use client";

import { useState, useEffect } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, buildExampleInput } from "@/lib/zohoMcp";

interface SectionDef {
  id: string;
  label: string;
  icon: string;
}

interface Props {
  section: SectionDef;
  tools: McpTool[];
  config: McpConfig;
  selectedTool: McpTool | null;
  onSelectTool: (tool: McpTool | null) => void;
  onLog: (log: ExecutionLog) => void;
}

export default function SectionPanel({ section, tools, config, selectedTool, onSelectTool, onLog }: Props) {
  const [inputJson, setInputJson] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>(null);

  useEffect(() => {
    if (!selectedTool) { setResult(null); setError(""); return; }
    setInputJson(JSON.stringify(buildExampleInput(selectedTool), null, 2));
    setResult(null);
    setError("");
  }, [selectedTool]);

  async function handleRun() {
    if (!selectedTool) return;
    let input: Record<string, unknown>;
    try { input = JSON.parse(inputJson || "{}"); }
    catch { setError("Invalid JSON input"); return; }

    setLoading(true);
    setError("");
    setResult(null);
    const start = Date.now();
    try {
      const output = await executeTool(config, selectedTool.name, input);
      setResult(output);
      onLog({ id: crypto.randomUUID(), tool: selectedTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Execution failed";
      setError(msg);
      onLog({ id: crypto.randomUUID(), tool: selectedTool.name, input, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="section-layout">
      <div className="section-tools-pane">
        <div className="pane-header">
          <span className="pane-icon">{section.icon}</span>
          <h2 className="pane-title">{section.label}</h2>
          <span className="pane-count">{tools.length} tool{tools.length !== 1 ? "s" : ""}</span>
        </div>

        {tools.length === 0 ? (
          <div className="empty-state">No {section.label.toLowerCase()} tools available from this server.</div>
        ) : (
          <div className="tool-cards">
            {tools.map(tool => (
              <button
                key={tool.name}
                className={`tool-card ${selectedTool?.name === tool.name ? "selected" : ""}`}
                onClick={() => onSelectTool(selectedTool?.name === tool.name ? null : tool)}
              >
                <span className="tool-card-name">{tool.name}</span>
                {tool.description && <span className="tool-card-desc">{tool.description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedTool && (
        <div className="exec-pane">
          <div className="exec-pane-header">
            <span className="exec-pane-title">{selectedTool.name}</span>
            <button className="exec-pane-close" onClick={() => onSelectTool(null)} title="Close">×</button>
          </div>

          {selectedTool.description && (
            <p className="exec-pane-desc">{selectedTool.description}</p>
          )}

          {selectedTool.inputSchema?.properties && (
            <div className="schema-hints">
              <p className="field-label">Parameters</p>
              {Object.entries(selectedTool.inputSchema.properties).map(([k, v]) => (
                <div key={k} className="schema-row">
                  <code className="param-name">{k}</code>
                  <span className="param-type">{v.type}</span>
                  {selectedTool.inputSchema?.required?.includes(k) && (
                    <span className="required-badge">required</span>
                  )}
                  {v.description && <span className="param-desc">{v.description}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="field">
            <label className="field-label">Input (JSON)</label>
            <textarea
              value={inputJson}
              onChange={e => setInputJson(e.target.value)}
              className="json-input"
              rows={6}
              spellCheck={false}
            />
          </div>

          <button onClick={handleRun} disabled={loading} className="btn-run">
            {loading ? <><span className="spinner" /> Running…</> : "Run tool"}
          </button>

          {error && <p className="exec-error">⚠ {error}</p>}

          {result !== null && (
            <div className="result-section">
              <p className="field-label">Result</p>
              <pre className="result-box">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
