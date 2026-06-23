"use client";

import type { ExecutionLog } from "@/types/mcp";

interface Props {
  logs: ExecutionLog[];
  onClear: () => void;
}

export default function AuditLogs({ logs, onClear }: Props) {
  if (!logs.length) {
    return <div className="empty-state">No executions yet. Run a tool to see logs here.</div>;
  }

  function downloadLogs() {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zoho-mcp-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <span className="logs-count">{logs.length} execution{logs.length !== 1 ? "s" : ""}</span>
        <div className="logs-actions">
          <button onClick={downloadLogs} className="btn-secondary">Download JSON</button>
          <button onClick={onClear} className="btn-secondary danger">Clear</button>
        </div>
      </div>

      <div className="log-list">
        {logs.map(log => (
          <details key={log.id} className="log-entry">
            <summary className="log-summary">
              <span className="log-time">{log.timestamp.toLocaleTimeString()}</span>
              <span className="log-tool">{log.tool}</span>
              <span className={`log-status ${log.status}`}>{log.status}</span>
              <span className="log-duration">{log.durationMs}ms</span>
            </summary>
            <div className="log-detail">
              <div className="log-section">
                <p className="log-section-label">Input</p>
                <pre className="log-code">{JSON.stringify(log.input, null, 2)}</pre>
              </div>
              {log.output !== null && (
                <div className="log-section">
                  <p className="log-section-label">Output</p>
                  <pre className="log-code">{JSON.stringify(log.output, null, 2)}</pre>
                </div>
              )}
              {log.errorMessage && (
                <div className="log-section">
                  <p className="log-section-label">Error</p>
                  <pre className="log-code error">{log.errorMessage}</pre>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
