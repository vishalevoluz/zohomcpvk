"use client";

import { useState } from "react";
import { ArrowRight, Lock, Rocket, ListChecks, KeyRound, Link2 } from "lucide-react";
import type { McpConfig, McpTool } from "@/types/mcp";
import { listTools } from "@/lib/zohoMcp";
import { CONNECT_WIZARD_STEP_LABELS, CONNECT_WIZARD_TOOL_GROUPS } from "@/lib/connectWizardContent";

interface Props {
  onConnected: (config: McpConfig, tools: McpTool[]) => void;
}

const STEP_ICONS = [Rocket, ListChecks, KeyRound, Link2];

export default function ConnectWizard({ onConnected }: Props) {
  const [active, setActive] = useState(0);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

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

  async function copyToolList() {
    const allTools = CONNECT_WIZARD_TOOL_GROUPS.flatMap(g => g.tools);
    await navigator.clipboard.writeText(allTools.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="wizard-preview">
      <div className="wizard-pills">
        {CONNECT_WIZARD_STEP_LABELS.map((label, i) => {
          const Icon = STEP_ICONS[i];
          return (
            <div key={label} className="wizard-pill-wrap">
              {i > 0 && <span className={`wizard-connector ${i <= active ? "is-done" : ""}`} />}
              <button
                type="button"
                onClick={() => setActive(i)}
                className={`wizard-pill ${i === active ? "is-active" : i < active ? "is-done" : ""}`}
              >
                <span className="wizard-pill-num">{i < active ? "✓" : i + 1}</span>
                <Icon size={13} strokeWidth={1.75} />
                {label}
              </button>
            </div>
          );
        })}
      </div>

      <div className="wizard-card">
        {active === 0 && (
          <>
            <div className="wizard-card-header">
              <Rocket size={16} strokeWidth={1.75} />
              <h4>Create your MCP server</h4>
            </div>
            <p className="wizard-card-body">
              Zoho MCP is Zoho&rsquo;s official, hosted way to give tools like EvoAudit controlled
              access to your CRM. You create the server, you choose what it can see, and you can
              delete it anytime.
            </p>
            <ol className="wizard-list">
              <li>
                Open the <strong>Zoho MCP Console</strong> at <code>mcp.zoho.com</code> (use your
                data center&rsquo;s domain — e.g. <code>mcp.zoho.in</code> for India,{" "}
                <code>mcp.zoho.eu</code> for Europe) and sign in with your Zoho admin account.
              </li>
              <li>Click <strong>Create MCP Server</strong>.</li>
              <li>
                Name it something recognizable — e.g. <code>EvoAudit</code> — and click{" "}
                <strong>Create</strong>.
              </li>
            </ol>
            <div className="wizard-nav">
              <span />
              <button type="button" className="wizard-btn wizard-btn-primary" onClick={() => setActive(1)}>
                Tools next <ArrowRight size={13} strokeWidth={1.75} />
              </button>
            </div>
          </>
        )}

        {active === 1 && (
          <>
            <div className="wizard-card-header">
              <ListChecks size={16} strokeWidth={1.75} />
              <h4>Enable the audit tools</h4>
            </div>
            <p className="wizard-card-body">
              In your new server, add tools from the <strong>Zoho CRM</strong> service: search each
              tool name below and tick its checkbox. More enabled tools = more of the 115 audit
              parameters we can check automatically — anything we can&rsquo;t see instead becomes a
              manual-review item instead of a guess.
            </p>
            <div className="wizard-callout">
              <Lock size={13} strokeWidth={1.75} />
              Read-only by design: none of these tools can create, change or delete anything in your
              CRM. Skip any tool named create/update/delete/convert — the audit never needs write access.
            </div>
            {CONNECT_WIZARD_TOOL_GROUPS.map(group => (
              <div key={group.label} className="wizard-tool-group">
                <p>{group.label}</p>
                <div className="wizard-tool-chips">
                  {group.tools.map(tool => (
                    <span key={tool} className="wizard-tool-chip">{tool}</span>
                  ))}
                </div>
              </div>
            ))}
            <div className="wizard-nav">
              <button type="button" className="wizard-btn" onClick={copyToolList}>
                {copied ? "✓ Copied" : "Copy full tool list"}
              </button>
              <span className="wizard-nav-end">
                <button type="button" className="wizard-btn" onClick={() => setActive(0)}>
                  Back
                </button>
                <button type="button" className="wizard-btn wizard-btn-primary" onClick={() => setActive(2)}>
                  Authorize next <ArrowRight size={13} strokeWidth={1.75} />
                </button>
              </span>
            </div>
          </>
        )}

        {active === 2 && (
          <>
            <div className="wizard-card-header">
              <KeyRound size={16} strokeWidth={1.75} />
              <h4>Authorize and copy your URL</h4>
            </div>
            <ol className="wizard-list">
              <li>
                When adding tools, Zoho asks you to <strong>authorize</strong> the connection with
                your Zoho login (OAuth). The default &ldquo;Authorization on Demand&rdquo; is fine —
                the audit can only ever see what your CRM user can see.
              </li>
              <li>Open the <strong>Connect</strong> section of the MCP Console.</li>
              <li>
                Copy the <strong>MCP URL</strong> — it looks like{" "}
                <code>https://…zohomcp.com/mcp/…/message</code>.
              </li>
            </ol>
            <div className="wizard-callout">
              <Lock size={13} strokeWidth={1.75} />
              Treat that URL like a password: it embeds the API key that grants the access you just
              configured. We use it only to run your audit, and you can delete the server in the
              Zoho MCP Console at any time to revoke access instantly.
            </div>
            <div className="wizard-nav">
              <button type="button" className="wizard-btn" onClick={() => setActive(1)}>
                Back
              </button>
              <button type="button" className="wizard-btn wizard-btn-primary" onClick={() => setActive(3)}>
                Start the audit <ArrowRight size={13} strokeWidth={1.75} />
              </button>
            </div>
          </>
        )}

        {active === 3 && (
          <>
            <div className="wizard-card-header">
              <Link2 size={16} strokeWidth={1.75} />
              <h4>Paste your MCP URL</h4>
            </div>
            <p className="wizard-card-body">
              Paste the server URL you copied in the previous step. We use it only to run your
              audit — nothing is ever written back to your CRM.
            </p>
            <div className="wizard-form">
              <label>
                Zoho MCP URL
                <input
                  type="text"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://your-zoho-mcp-url.com/mcp"
                  onKeyDown={e => e.key === "Enter" && handleConnect()}
                />
              </label>
            </div>
            {error && <p className="wizard-error">⚠ {error}</p>}
            <div className="wizard-nav">
              <button type="button" className="wizard-btn" onClick={() => setActive(2)}>
                Back
              </button>
              <button type="button" className="wizard-btn wizard-btn-primary" onClick={handleConnect} disabled={loading}>
                {loading ? <span className="spinner" /> : null}
                {loading ? "Connecting…" : "Run my free audit"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
