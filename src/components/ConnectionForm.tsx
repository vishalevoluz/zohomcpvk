"use client";

import { useState } from "react";
import type { McpConfig, McpTool } from "@/types/mcp";
import { listTools } from "@/lib/zohoMcp";

interface Props {
  onConnected: (config: McpConfig, tools: McpTool[]) => void;
}

export default function ConnectionForm({ onConnected }: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleConnect() {
    if (!url.trim()) { setError("Please enter the MCP URL"); return; }
    setLoading(true);
    setError("");
    try {
      const config: McpConfig = { url: url.trim() };
      const tools = await listTools(config);
      onConnected(config, tools);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="connection-form">
      <div className="form-row">
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://your-zoho-mcp-url.com/mcp"
          className="input-url"
          onKeyDown={e => e.key === "Enter" && handleConnect()}
        />
        <button onClick={handleConnect} disabled={loading} className="btn-connect">
          {loading ? <span className="spinner" /> : null}
          {loading ? "Connecting…" : "Connect"}
        </button>
      </div>
      {error && <p className="form-error">⚠ {error}</p>}
    </div>
  );
}
