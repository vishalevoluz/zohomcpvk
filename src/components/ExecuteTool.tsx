"use client";

import { useState, useEffect } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, buildExampleInput } from "@/lib/zohoMcp";

interface Props {
  config: McpConfig;
  tools: McpTool[];
  selectedTool: McpTool | null;
  onLog: (log: ExecutionLog) => void;
}

export default function ExecuteTool({ config, tools, selectedTool, onLog }: Props) {
  const [toolName, setToolName] = useState(selectedTool?.name ?? "");
  const [inputJson, setInputJson] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>(null);

  useEffect(() => {
    if (!selectedTool) return;
    setToolName(selectedTool.name);
    setInputJson(JSON.stringify(buildExampleInput(selectedTool), null, 2));
    setResult(null);
    setError("");
  }, [selectedTool]);

  function onToolChange(name: string) {
    setToolName(name);
    const t = tools.find(x => x.name === name);
    if (t) setInputJson(JSON.stringify(buildExampleInput(t), null, 2));
    setResult(null);
    setError("");
  }

  async function handleRun() {
    if (!toolName) { setError("Select a tool first"); return; }
    let input: Record<string, unknown>;
    try { input = JSON.parse(inputJson || "{}"); }
    catch { setError("Invalid JSON in input"); return; }

    setLoading(true);
    setError("");
    setResult(null);
    const start = Date.now();

    try {
      const output = await executeTool(config, toolName, input);
      setResult(output);
      onLog({ id: crypto.randomUUID(), tool: toolName, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Execution failed";
      setError(msg);
      onLog({ id: crypto.randomUUID(), tool: toolName, input, output: null, status: "error", errorMessage: msg, durationMs: Date.now() - start, timestamp: new Date() });
    } finally {
      setLoading(false);
    }
  }

  const currentTool = tools.find(t => t.name === toolName);

  return (
    <div className="execute-panel">
      <div className="field">
        <label className="field-label">Tool</label>
        <select value={toolName} onChange={e => onToolChange(e.target.value)} className="select-tool">
          <option value="">— select a tool —</option>
          {tools.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        {currentTool?.description && (
          <p className="tool-desc-hint">{currentTool.description}</p>
        )}
      </div>

      {currentTool?.inputSchema?.properties && (
        <div className="schema-hints">
          <p className="field-label">Parameters</p>
          {Object.entries(currentTool.inputSchema.properties).map(([k, v]) => (
            <div key={k} className="schema-row">
              <code className="param-name">{k}</code>
              <span className="param-type">{v.type}</span>
              {currentTool.inputSchema?.required?.includes(k) && <span className="required-badge">required</span>}
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

      <button onClick={handleRun} disabled={loading || !toolName} className="btn-run">
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
  );
}
