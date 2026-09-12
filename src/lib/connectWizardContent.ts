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
    // tools the audit actually reads from, never mutation tools. Same reason
    // createZiaRecommendation/createZiaSimilarity were removed from this list -
    // both are create-only (no matching read/list tool exists anywhere in
    // Zoho's real catalogue, see the Zia Recommendation audit gap noted
    // elsewhere), nothing in this app ever calls either one, and a user
    // reported enabling them didn't even make them show as available in the
    // MCP console's own tool picker - the same "showed red forever" problem
    // getScheduledJobs/getEmailTemplates/etc. had above.
    // Note: WorkflowAudit.tsx's "Connected" tab separately gates itself on a
    // flat "getConnectedWorkflows" list tool that isn't in this org's real
    // catalogue (only the module-scoped getConnectedWorkflowRules is), so
    // that tab may still read as unavailable even with these enabled until
    // that gate is fixed to use the real tool.
    // The four Zia Conversation Summary / Session tools below are a
    // deliberate exception to the "never mutation tools" rule above - added
    // by explicit request ahead of any feature actually calling them yet
    // (unlike createZiaRecommendation/createZiaSimilarity, which were removed
    // for being unused). If no dashboard feature ends up reading/writing
    // through them, revisit removing these the same way.
    // getUser (singular, per-user detail) sits alongside getUsers (plural,
    // the list) - the console lists them as two separate tools. The list
    // endpoint doesn't reliably carry last_activity_time/last_login_time on
    // every server; getUser's per-user detail does, and useCrmEntities.ts's
    // enrichUsersWithLoginDetail merges it into each user so the "unused
    // license" and stale-user-login checks have a real chance of seeing it.
    label: "Core structure & automation (required)",
    tools: [
      "ZohoCRM_getModules", "ZohoCRM_getFields", "ZohoCRM_getLayouts", "ZohoCRM_getWorkflowRules",
      "ZohoCRM_getWorkflowRuleById", "ZohoCRM_getWorkflowRuleUsage", "ZohoCRM_getWorkflowConfigurations",
      "ZohoCRM_getWorkflowRulesActionsCount", "ZohoCRM_getWorkflowRulesCount", "ZohoCRM_getFunctions",
      "ZohoCRM_getFunction", "ZohoCRM_getFunctionCode", "ZohoCRM_getAllAutomationFunctions",
      "ZohoCRM_getAutomationFunctions", "ZohoCRM_getAutomationFunctionFailures",
      "ZohoCRM_getUsers", "ZohoCRM_getUser", "ZohoCRM_getRoles", "ZohoCRM_getProfiles", "ZohoCRM_getPipelines",
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
      "ZohoCRM_generateZiaConversationSummary", "ZohoCRM_getZiaConversationSummary",
      "ZohoCRM_getZiaSessionMessages", "ZohoCRM_createZiaSessionMessage",
    ],
  },
  {
    label: "Record-level data quality (strongly recommended)",
    tools: ["ZohoCRM_getRecords", "ZohoCRM_searchRecords"],
  },
];
