export const CONNECT_WIZARD_STEP_LABELS = ["Create MCP server", "Enable tools", "Authorize & copy URL", "Start audit"];

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
      "ZohoCRM_getAssignmentRules", "ZohoCRM_getApprovalRules", "ZohoCRM_getLayoutRules",
      "ZohoCRM_getSchedules", "ZohoCRM_getConnections",
    ],
  },
];
