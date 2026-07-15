"use client";

import { useState } from "react";

const STEPS = [
  <>Open <a href="https://www.zoho.com/mcp/" target="_blank" rel="noopener noreferrer">zoho.com/mcp</a> and sign in with your Zoho account.</>,
  <>Select <strong>Create MCP Server</strong> to spin up a new server.</>,
  <>Give it a name — call it <code>EvoAudit</code>.</>,
  <>Hit <strong>Add tools</strong>, then pick the <strong>Zoho CRM</strong> tool from the list.</>,
  <>Search for and attach the scopes on the right to that tool.</>,
  <>In the <strong>Connection</strong> tab, choose <strong>Authorization via Connection</strong> to authorize.</>,
  <>Open <strong>Authorized Tools</strong> under that connection and approve each scope you attached.</>,
  <>Head to <strong>Connect</strong>, copy the <strong>Server URL</strong> it generates, and paste it into the field above.</>,
];

const SCOPES = [
  "getModules", "getWorkflowRules", "getBlueprint", "getAllAutomationFunctions",
  "getAutomationFunctionFailures", "getFields", "getProfiles", "getUsers", "getRoles",
  "getPipelines", "getLayouts", "getBlueprintStateById", "createZiaRecommendation",
  "getBlueprintProcessConfigurationMeta", "getBlueprintId", "getWorkflowConfigurations",
  "getConnectedWorkflowActionsCount", "getConnectedWorkflowConfigurations", "getWorkflowRuleUsage",
  "getWorkflowRulesCount", "getWorkflowRuleById", "getConnectedWorkflowRuleById",
  "getConnectedWorkflowById", "getConnectedWorkflowRules", "getAutomationFunctions",
  "getFunctionCode", "getFunctions", "getFunction", "createZiaSimilarity", "getRecords",
  "searchRecords",
];

export function ServerUrlSteps() {
  return (
    <div className="server-guide">
      <div className="server-guide-header">
        <span className="server-guide-header-icon">🛠</span>
        <div>
          <p className="server-guide-title">How to build your Server URL</p>
          <p className="server-guide-subtitle">Set up an MCP server on Zoho and connect it here in a few steps.</p>
        </div>
      </div>

      <ol className="server-guide-timeline">
        {STEPS.map((step, i) => (
          <li key={i} className="server-guide-step">
            <span className="server-guide-step-num">{i + 1}</span>
            <span className="server-guide-step-text">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ServerUrlScopes() {
  const [copied, setCopied] = useState(false);

  async function copyScopes() {
    await navigator.clipboard.writeText(SCOPES.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="server-guide-scopes-card">
      <div className="server-guide-scopes-header">
        <p className="server-guide-scopes-label">Scopes to attach to the tool</p>
        <button type="button" className="server-guide-copy-btn" onClick={copyScopes}>
          {copied ? "✓ Copied" : "Copy all"}
        </button>
      </div>
      <div className="server-guide-scopes">
        {SCOPES.map(scope => (
          <span key={scope} className="scope-chip">{scope}</span>
        ))}
      </div>
    </div>
  );
}
