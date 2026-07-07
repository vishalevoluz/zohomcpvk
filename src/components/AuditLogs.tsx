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

  function formatLogsAsText(): string {
    const lines: string[] = [];
    lines.push("ZOHO MCP AUDIT LOG");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Total executions: ${logs.length}`);
    lines.push("=".repeat(60));
    logs.forEach((log, i) => {
      lines.push("");
      lines.push(`[${i + 1}] ${log.timestamp.toLocaleString()}  |  ${log.tool}  |  ${log.status.toUpperCase()}  |  ${log.durationMs}ms`);
      lines.push("-".repeat(60));
      lines.push("Input:");
      lines.push(JSON.stringify(log.input, null, 2));
      if (log.output !== null) {
        lines.push("Output:");
        lines.push(JSON.stringify(log.output, null, 2));
      }
      if (log.errorMessage) {
        lines.push("Error:");
        lines.push(log.errorMessage);
      }
    });
    return lines.join("\n");
  }

  function downloadLogs() {
    const blob = new Blob([formatLogsAsText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zoho-mcp-audit-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <span className="logs-count">{logs.length} execution{logs.length !== 1 ? "s" : ""}</span>
        <div className="logs-actions">
          <button onClick={downloadLogs} className="btn-secondary">Download TXT</button>
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
