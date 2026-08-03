export const CONNECT_WIZARD_STEP_LABELS = ["Create MCP server", "Enable tools", "Authorize & copy URL", "Start audit"];

// The MCP server prefixes every tool name with "ZohoCRM_", but the Zoho MCP
// Console's own tool search only matches the un-prefixed name (e.g.
// "getModules") — so strip it for anything the user reads or searches with,
// while CONNECT_WIZARD_TOOL_GROUPS itself keeps the real prefixed names for
// matching against the live tools/list response.
export function displayToolName(tool: string): string {
  return tool.replace(/^ZohoCRM_/, "");
}

export const CONNECT_WIZARD_TOOL_GROUPS = [
  {
    label: "Core structure & automation (required)",
    tools: [
      "ZohoCRM_getModules", "ZohoCRM_getFields", "ZohoCRM_getLayouts", "ZohoCRM_getWorkflowRules",
      "ZohoCRM_getWorkflowRuleUsage", "ZohoCRM_getFunctions", "ZohoCRM_getAutomationFunctionFailures",
      "ZohoCRM_getUsers", "ZohoCRM_getRoles", "ZohoCRM_getProfiles", "ZohoCRM_getPipelines",
    ],
  },
  {
    // executeCOQLQuery and getRecordCount were removed from this list —
    // neither exists in Zoho's real MCP tool catalogue (verified against a
    // live server's tools/list), so they showed red forever. getRecordCount
    // is still used opportunistically if a server ever exposes a
    // getRecordCount-style tool (see useModuleRecordCounts.ts), it's just
    // not something we can tell users to go enable.
    label: "Record-level data quality (strongly recommended)",
    tools: ["ZohoCRM_getRecords"],
  },
  {
    // getApprovalProcess, getScheduledJobs, getEmailTemplates,
    // getAssignmentRules, and getConnections were removed from this list —
    // none exist in Zoho's real MCP tool catalogue, so they showed red
    // forever and sent users hunting for a checkbox the console never had.
    // Approvals/schedules/assignment rules are treated as manual-review
    // items instead (assignment-rule coverage still lights up automatically
    // if a getAssignmentRules-style tool ever appears — see
    // useRuleCoverage.ts). getOrganization was also corrected to the real
    // plural name, getOrganizations.
    label: "Extended coverage (nice to have)",
    tools: [
      "ZohoCRM_getOrganizations", "ZohoCRM_getValidationRules", "ZohoCRM_getLayoutRules",
    ],
  },
];
