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
    label: "Record-level data quality (strongly recommended)",
    tools: ["ZohoCRM_executeCOQLQuery", "ZohoCRM_getRecords", "ZohoCRM_getRecordCount"],
  },
  {
    label: "Extended coverage (nice to have)",
    tools: [
      "ZohoCRM_getOrganization", "ZohoCRM_getEmailTemplates", "ZohoCRM_getValidationRules",
      "ZohoCRM_getAssignmentRules", "ZohoCRM_getApprovalProcess", "ZohoCRM_getLayoutRules",
      "ZohoCRM_getScheduledJobs", "ZohoCRM_getConnections",
    ],
  },
];
