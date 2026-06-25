"use client";

import { useState } from "react";
import type { McpConfig, McpTool } from "@/types/mcp";
import { listTools } from "@/lib/zohoMcp";

interface Props {
  onConnected: (config: McpConfig, tools: McpTool[]) => void;
}

// Extract https://crm.zoho.{tld}/crm/org{id} from any Zoho CRM URL the user pastes
function parseCrmBase(raw: string): string | undefined {
  const m = raw.trim().match(/^(https?:\/\/crm\.zoho\.[a-z]+\/crm\/org\d+)/i);
  return m ? m[1] : undefined;
}

export default function ConnectionForm({ onConnected }: Props) {
  const [url, setUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [crmUrl, setCrmUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleConnect() {
    if (!url.trim()) { setError("Please enter the MCP URL"); return; }
    setLoading(true);
    setError("");
    try {
      const config: McpConfig = {
        url: url.trim(),
        authToken: authToken.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        crmBaseUrl: parseCrmBase(crmUrl) || undefined,
      };
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
      <div className="form-row auth-row">
        <input
          type="text"
          value={authToken}
          onChange={e => setAuthToken(e.target.value)}
          placeholder="Bearer token (optional)"
          className="input-half"
        />
        <input
          type="text"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="API key (optional)"
          className="input-half"
        />
      </div>
      <div className="form-row">
        <input
          type="text"
          value={crmUrl}
          onChange={e => setCrmUrl(e.target.value)}
          placeholder="Zoho CRM URL for Open in CRM links — e.g. https://crm.zoho.com/crm/org123456/tab/Leads"
          className="input-url"
          title="Paste any URL from your Zoho CRM — the org base will be extracted automatically"
        />
      </div>
      {error && <p className="form-error">⚠ {error}</p>}
    </div>
  );
}
