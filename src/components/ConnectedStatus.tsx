"use client";

import type { McpConfig } from "@/types/mcp";

interface Props {
  config: McpConfig;
  onDisconnect: () => void;
}

function trimUrl(url: string, max = 48): string {
  const clean = url.replace(/^https?:\/\//, "");
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

export default function ConnectedStatus({ config, onDisconnect }: Props) {
  return (
    <div className="connected-status">
      <div className="connected-status-info">
        <span className="status-dot connected" />
        <div className="connected-status-block">
          <p className="connected-status-label">MCP Server</p>
          <p className="connected-status-url" title={config.url}>{trimUrl(config.url)}</p>
        </div>
        {config.crmBaseUrl && (
          <>
            <div className="connected-status-sep" />
            <div className="connected-status-block">
              <p className="connected-status-label">Zoho CRM</p>
              <p className="connected-status-url" title={config.crmBaseUrl}>{trimUrl(config.crmBaseUrl)}</p>
            </div>
          </>
        )}
        {config.authToken && (
          <>
            <div className="connected-status-sep" />
            <div className="connected-status-block">
              <p className="connected-status-label">Auth</p>
              <p className="connected-status-url">Bearer ••••••</p>
            </div>
          </>
        )}
        {config.apiKey && (
          <>
            <div className="connected-status-sep" />
            <div className="connected-status-block">
              <p className="connected-status-label">API Key</p>
              <p className="connected-status-url">••••••</p>
            </div>
          </>
        )}
      </div>
      <button className="btn-secondary connected-status-disconnect" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}
