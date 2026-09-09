export const CONNECT_WIZARD_STEP_LABELS = ["Create MCP server", "Enable tools", "Authorize & copy URL", "Start audit"];

// The MCP server prefixes every tool name with "ZohoCRM_", but the Zoho MCP
// Console's own tool search only matches the un-prefixed name (e.g.
// "getModules") - so strip it for anything the user reads or searches with,
// while CONNECT_WIZARD_TOOL_GROUPS itself keeps the real prefixed names for
// matching against the live tools/list response.
export function displayToolName(tool: string): string {
  return tool.replace(/^ZohoCRM_/, "");
}

export const CONNECT_WIZARD_TOOL_GROUPS = [
  {
    // getScheduledJobs, getEmailTemplates, getConnections, executeCOQLQuery,
    // and getRecordCount were removed from earlier versions of this list -
    // none exist in Zoho's real MCP tool catalogue, so they showed red
    // forever and sent users hunting for a checkbox the console never had.
    // getRecordCount is still used opportunistically if a server ever
    // exposes a getRecordCount-style tool (see useModuleRecordCounts.ts),
    // it's just not something we can tell users to go enable. Schedules are
    // treated as a manual-review item instead. getOrganization was also
    // corrected to the real plural name, getOrganizations.
    // The approval-process, assignment-rule, and Connected Workflow tools
    // below DO exist on this org's MCP server - required alongside the rest
    // instead of being tucked away as merely "nice to have."
    // deleteApprovalProcess is deliberately left out - this wizard only lists
    // tools the audit actually reads from, never mutation tools.
    // Note: WorkflowAudit.tsx's "Connected" tab separately gates itself on a
    // flat "getConnectedWorkflows" list tool that isn't in this org's real
    // catalogue (only the module-scoped getConnectedWorkflowRules is), so
    // that tab may still read as unavailable even with these enabled until
    // that gate is fixed to use the real tool.
    label: "Core structure & automation (required)",
    tools: [
      "ZohoCRM_getModules", "ZohoCRM_getFields", "ZohoCRM_getLayouts", "ZohoCRM_getWorkflowRules",
      "ZohoCRM_getWorkflowRuleById", "ZohoCRM_getWorkflowRuleUsage", "ZohoCRM_getWorkflowConfigurations",
      "ZohoCRM_getWorkflowRulesActionsCount", "ZohoCRM_getWorkflowRulesCount", "ZohoCRM_getFunctions",
      "ZohoCRM_getFunction", "ZohoCRM_getFunctionCode", "ZohoCRM_getAllAutomationFunctions",
      "ZohoCRM_getAutomationFunctions", "ZohoCRM_getAutomationFunctionFailures",
      "ZohoCRM_getUsers", "ZohoCRM_getRoles", "ZohoCRM_getProfiles", "ZohoCRM_getPipelines",
      "ZohoCRM_getBlueprint", "ZohoCRM_getBlueprintId", "ZohoCRM_getBlueprintStateById",
      "ZohoCRM_getBlueprintProcessConfigurationMeta",
      "ZohoCRM_getOrganizations", "ZohoCRM_getValidationRules", "ZohoCRM_getLayoutRules",
      "ZohoCRM_getApprovalProcess", "ZohoCRM_getSingleApprovalProcess", "ZohoCRM_getApprovalProcessRules",
      "ZohoCRM_getApprovalProcessRule",
      "ZohoCRM_getAssignmentRules", "ZohoCRM_getAssignmentRuleById", "ZohoCRM_getAssignmentRulesCount",
      "ZohoCRM_getAssignmentRuleAssociations",
      "ZohoCRM_getConnectedWorkflowRules", "ZohoCRM_getConnectedWorkflowRuleById",
      "ZohoCRM_getConnectedWorkflowById", "ZohoCRM_getConnectedWorkflowConfigurations",
      "ZohoCRM_getConnectedWorkflowActionsCount",
      "ZohoCRM_createZiaRecommendation", "ZohoCRM_createZiaSimilarity",
    ],
  },
  {
    label: "Record-level data quality (strongly recommended)",
    tools: ["ZohoCRM_getRecords", "ZohoCRM_searchRecords"],
  },
];
