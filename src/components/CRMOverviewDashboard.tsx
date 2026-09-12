"use client";

import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool, findParamLocations, findParam, setParam } from "@/lib/zohoMcp";
import {
  type CrmEntityType,
  type EntityState,
  CRM_ENTITIES,
  extractArray,
  getItemName,
  getItemStatus,
  isEntityResolved,
  findToolForEntity,
  extractPageInfo,
} from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import { isActiveWorkflow, isAdminProfile, isCustomModule, isInactiveUser, isDeletedUser, isActiveUser, userStatusBucket, type UserStatusBucket, userRoleName, userLastLoginDate, userLoginFieldPresent, blueprintStatus, type BlueprintStatus, workflowModuleLabel, workflowLastTriggered, moduleApiName, isDeletedModule, isHiddenModule, isEmptyModule, isInternalModule, isSystemHiddenModule, overlappingWorkflows, overlappingWorkflowGroups, workflowCriteriaFieldConditions, workflowTriggerLabel, workflowActionTypeNames, isSystemGeneratedRule, resolveUsableModuleApiNames } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/businessScore";
import type { PipelineStagesState } from "@/lib/flowMapModel";
import { analyzeFunctionScript, sortIssuesBySeverity, reviewCodeQuality, checkFunctionMetadata, ISSUE_CATEGORY_LABELS, type FunctionIssue, type FunctionIssueCategory } from "@/lib/functionAnalysis";

function parseMcpJson(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string") {
        try { return JSON.parse(item.text) as Record<string, unknown>; } catch { /* not JSON */ }
      }
    }
  }
  return r;
}

// Functions naming/duplicate/failure health - like RuleCoverage (see
// useRuleCoverage.ts), this is fetched separately from entityData since
// getFunctions/getAutomationFunctionFailures aren't part of the shared
// flat-entity list.
interface FunctionHealth {
  totalScanned: number;
  hasMore: boolean;
  duplicateGroups: { name: string; count: number }[];
  suspiciousNames: string[];
  failuresChecked: boolean;
  failureCount: number;
  // Scheduled Functions are just functions with category=="Schedule" - there
  // is no separate schedule-listing tool anywhere in Zoho's real MCP
  // catalogue (confirmed live), so this rides the same functions fetch
  // instead of a dedicated one. See computeScheduleBreakdown.
  scheduleTotal: number;
  scheduleInactive: number;
}

// Placeholder/test names left over from building or copy-pasting a function -
// "Function1", "Untitled", "Copy of X", or a plain "test"/"temp" prefix.
const SUSPICIOUS_FUNCTION_NAME = /^(function\d*$|untitled|new[ _]?function|copy[ _]?of|test|temp)/i;
const MAX_FUNCTION_PAGES = 5; // 5 * 200 = up to 1000 functions scanned

function hasMoreRecords(result: unknown): boolean {
  const parsed = parseMcpJson(result);
  const info = parsed?.info as Record<string, unknown> | undefined;
  return info?.more_records === true;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportTab = "changes" | "integrations" | "architecture";

interface Recommendation {
  id: string;
  title: string;
  description: string;
  severity: "high" | "medium" | "low";
  category: ReportTab;
  icon: string;
}

interface ZiaMessage {
  role: "zia" | "user";
  content: string;
  isLoading?: boolean;
}

interface Props {
  config: McpConfig;
  tools: McpTool[];
  onLog: (log: ExecutionLog) => void;
  entityData: Record<CrmEntityType, EntityState>;
  fetchEntity: (type: CrmEntityType) => Promise<unknown[]>;
  fetchAll: () => void;
  lastRefresh: Date | null;
  onSelectSection: (s: Section) => void;
  pipelineStageCount: number;
  pipelineStages: PipelineStagesState;
  ruleCoverage: RuleCoverage | null;
}

type Severity = "critical" | "warning" | "good" | "unknown";

interface KpiItem {
  key: string;
  label: string;
  value: number;
  severity: Severity;
  note: string;
  clickable?: boolean;
  /** True when the underlying fetch failed and this count could not be confirmed - render "-", not a fake 0. */
  unknown?: boolean;
  /** Hover/click attribution: which tool this came from and how many records it saw - shown as a tooltip on the tile. */
  source: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// No \b around these - tool names are camelCase/PascalCase (e.g. "getZiaInsights"),
// so a word-boundary regex never matches inside the concatenated identifier.
const ZIA_PATTERNS = [/zia/i, /recommend/i, /analy[sz]/i, /insight/i, /suggest/i];

const QUERY_KEYS = ["query", "question", "prompt", "text", "message", "input", "search", "context"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasQueryField(tool: McpTool): boolean {
  const props = tool.inputSchema?.properties ?? {};
  return Object.keys(props).some(k => QUERY_KEYS.includes(k.toLowerCase()));
}

// Zoho API errors often come back as a JSON string inside the tool's text
// output (e.g. {"code":"MANDATORY_NOT_FOUND",...}) - show it as a readable
// message instead of dumping the raw JSON into the chat.
function formatZiaResponseText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const r = parsed as Record<string, unknown>;
      if (r.status === "error" || (r.code && r.message)) {
        const details = r.details && typeof r.details === "object"
          ? Object.entries(r.details as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join(", ")
          : "";
        return `⚠ ${String(r.message ?? "Request failed")}${r.code ? ` (${r.code})` : ""}${details ? `\n${details}` : ""}`;
      }
    }
  } catch { /* not JSON, show as-is */ }
  return text;
}

function findZiaTool(tools: McpTool[]): McpTool | null {
  // Prefer a Zia-ish tool that actually accepts free text - avoids matching a
  // structured CRUD tool (e.g. one requiring a "recommendations" record array)
  // whose name/description merely contains a matching keyword.
  for (const p of ZIA_PATTERNS) {
    const t = tools.find(t => (p.test(t.name) || p.test(t.description ?? "")) && hasQueryField(t));
    if (t) return t;
  }
  for (const p of ZIA_PATTERNS) {
    const t = tools.find(t => p.test(t.name) || p.test(t.description ?? ""));
    if (t) return t;
  }
  return null;
}

function generateRecommendations(
  entityData: Record<CrmEntityType, EntityState>,
  tools: McpTool[],
  ruleCoverage: RuleCoverage | null,
  functionHealth: FunctionHealth | null,
  // The generic zero-param getPipelines() entityData.pipelines comes from can
  // fail outright on servers that require a layout_id (verified live - see
  // computeHealthScore's matching param) - pipelineCount is the real count
  // from the getLayouts -> getPipelines chain (usePipelineStages.ts).
  // Without this override, a server like that always reads as "0 pipelines"
  // here regardless of the real org, firing a false "no pipeline" critical
  // recommendation even when one exists.
  pipelineCountOverride: number | null,
): Recommendation[] {
  const recs: Recommendation[] = [];

  const wfs      = entityData.workflows.items;
  const bps      = entityData.blueprints.items;
  const mods     = entityData.modules.items.filter(m => !isDeletedModule(m) && !isInternalModule(m) && !isSystemHiddenModule(m));
  const pipeCount = pipelineCountOverride ?? entityData.pipelines.items.length;
  const stages   = entityData.stages.items;
  const layouts  = entityData.layouts.items;
  const tasks    = entityData.tasks.items;
  const profiles = entityData.profiles.items;
  const users    = entityData.users.items;
  const fields   = entityData.fields.items;

  // ── RECOMMENDED CHANGES ────────────────────────────────────────────────────

  const disabledWfs = wfs.filter(w => {
    const r = w as Record<string, unknown>;
    return r.status === "Inactive" || r.active === false || r.enabled === false;
  });
  if (disabledWfs.length > 0) {
    recs.push({
      id: "disabled-workflows",
      title: `${disabledWfs.length} Inactive Workflow${disabledWfs.length > 1 ? "s" : ""} Found`,
      description: `${disabledWfs.length} workflow${disabledWfs.length > 1 ? "s are" : " is"} currently inactive. Review and re-enable relevant ones or delete unused automations to keep your CRM clean.`,
      severity: "medium", category: "changes", icon: "⟳",
    });
  }

  const inactiveBps = bps.filter(b => {
    const r = b as Record<string, unknown>;
    return r.status === "Inactive" || r.active === false;
  });
  if (inactiveBps.length > 0) {
    recs.push({
      id: "inactive-blueprints",
      title: `${inactiveBps.length} Inactive Blueprint Process${inactiveBps.length > 1 ? "es" : ""}`,
      description: `${inactiveBps.length} blueprint${inactiveBps.length > 1 ? "s are" : " is"} inactive. Reactivate needed processes or delete the ones you no longer need.`,
      severity: "medium", category: "changes", icon: "◈",
    });
  }

  if (wfs.length > 20) {
    recs.push({
      id: "workflow-sprawl",
      title: "High Workflow Count - Consider Consolidation",
      description: `You have ${wfs.length} workflows. Consolidating overlapping triggers and combining related actions reduces maintenance overhead and potential conflicts.`,
      severity: "low", category: "changes", icon: "⟳",
    });
  }

  if (bps.length > 0 && stages.length === 0 && entityData.stages.toolUsed !== null) {
    recs.push({
      id: "missing-stages",
      title: "Blueprint Stages Data Unavailable",
      description: "Blueprints are configured but stage data isn't accessible. Ensure pipeline stages are aligned with blueprint transitions for complete process visibility.",
      severity: "medium", category: "changes", icon: "◉",
    });
  }

  const hiddenMods = mods.filter(m => {
    const r = m as Record<string, unknown>;
    return r.visible === false || r.show_as_tab === false || r.viewable === false;
  });
  if (hiddenMods.length > 3) {
    recs.push({
      id: "hidden-modules",
      title: `${hiddenMods.length} Hidden Modules Detected`,
      description: `${hiddenMods.length} modules are not visible to users. Review whether these should be re-enabled or permanently decommissioned to reduce clutter.`,
      severity: "low", category: "changes", icon: "⊞",
    });
  }

  if (tasks.length === 0 && entityData.tasks.toolUsed !== null && !entityData.tasks.loading) {
    recs.push({
      id: "no-tasks",
      title: "No Tasks or Activities Found",
      description: "No tasks or activities are currently recorded. Set up task automation via workflows to automatically track follow-ups and action items for your sales team.",
      severity: "high", category: "changes", icon: "✓",
    });
  }

  if (layouts.length > 0 && mods.length > 0 && layouts.length < mods.length) {
    recs.push({
      id: "layout-gap",
      title: "Some Modules Lack Custom Layouts",
      description: `Only ${layouts.length} layouts for ${mods.length} modules. Consider adding role-specific layouts for key modules to improve data entry efficiency and field relevance per team.`,
      severity: "low", category: "changes", icon: "⊟",
    });
  }

  // Functions - the shared entityData doesn't track custom functions (see
  // FunctionAudit.tsx, which fetches them separately), so naming/duplicate/
  // failure health is fetched independently (see functionHealth effect) and
  // falls back to a tool-presence check when that data isn't in yet.
  if (functionHealth) {
    const scannedNote = functionHealth.hasMore
      ? ` (based on the first ${functionHealth.totalScanned} scanned - your org has more)`
      : ` (${functionHealth.totalScanned} scanned)`;

    if (functionHealth.duplicateGroups.length > 0) {
      const top = functionHealth.duplicateGroups
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map(g => `"${g.name}" (${g.count}×)`)
        .join(", ");
      recs.push({
        id: "duplicate-functions",
        title: `${functionHealth.duplicateGroups.length} Duplicate Function Names Found`,
        description: `Multiple functions share the exact same name${scannedNote}: ${top}. Duplicate names make it impossible to tell which one a workflow or button actually calls - rename or delete the unused copies.`,
        severity: "medium", category: "changes", icon: "ƒ",
      });
    }

    if (functionHealth.suspiciousNames.length > 0) {
      recs.push({
        id: "function-naming",
        title: `${functionHealth.suspiciousNames.length} Functions With Placeholder Names`,
        description: `Functions named like "${functionHealth.suspiciousNames.slice(0, 3).join('", "')}"${functionHealth.suspiciousNames.length > 3 ? ", …" : ""}${scannedNote} still carry their default/test name. Rename them to describe what they actually do, or delete them if they were never finished.`,
        severity: "low", category: "changes", icon: "ƒ",
      });
    }

    if (functionHealth.failuresChecked) {
      if (functionHealth.failureCount > 0) {
        recs.push({
          id: "function-failures",
          title: `${functionHealth.failureCount} Recent Function Execution Failures`,
          description: `${functionHealth.failureCount} function run${functionHealth.failureCount !== 1 ? "s have" : " has"} failed recently. A failing function silently breaks whatever workflow, button, or blueprint action depends on it - check getAutomationFunctionFailures for the specific errors.`,
          severity: "high", category: "changes", icon: "⚠",
        });
      } else {
        recs.push({
          id: "function-failures",
          title: "No Recent Function Execution Failures",
          description: "No failed function executions were found in the recent window. Keep an eye on this as you add more automation-triggered functions.",
          severity: "low", category: "changes", icon: "⚠",
        });
      }
    }

    if (functionHealth.duplicateGroups.length === 0 && functionHealth.suspiciousNames.length === 0 && !functionHealth.failuresChecked) {
      recs.push({
        id: "audit-functions",
        title: "No Naming Issues Found in Scanned Functions",
        description: `Scanned ${functionHealth.totalScanned} functions - no duplicate or placeholder names detected. Connect getAutomationFunctionFailures too so failed executions can be surfaced here as well.`,
        severity: "low", category: "changes", icon: "ƒ",
      });
    }
  } else {
    const hasFunctionTools = tools.some(t => /function/i.test(t.name));
    recs.push(hasFunctionTools ? {
      id: "audit-functions",
      title: "Audit Custom Functions for Orphaned Scripts",
      description: "Function tools are connected. Review your Deluge functions for ones no longer linked to any workflow, button, or blueprint action - orphaned functions still count against your org's script limits and are easy to lose track of. Check the Functions tab for the full breakdown.",
      severity: "medium", category: "changes", icon: "ƒ",
    } : {
      id: "audit-functions",
      title: "Connect Function Tools to Audit Custom Scripts",
      description: "No function tooling is connected yet. If your org uses Deluge functions for workflow actions or buttons, attach getFunctions / getAllAutomationFunctions to your MCP connection so unused, duplicate, or failing scripts can be surfaced here.",
      severity: "low", category: "changes", icon: "ƒ",
    });
  }

  // Profile-based recommendations
  if (profiles.length > 0) {
    const adminCount = profiles.filter(p => {
      const r = p as Record<string, unknown>;
      return /admin/i.test(String(r.name ?? r.label ?? ""));
    }).length;
    if (adminCount > 2) {
      recs.push({
        id: "too-many-admins",
        title: `${adminCount} Admin Profiles Detected`,
        description: `${adminCount} profiles have admin-level naming. Audit whether all of these actually require full administrator access - excess admin profiles are a security risk.`,
        severity: "high", category: "changes", icon: "◑",
      });
    }
    if (profiles.length === 1) {
      recs.push({
        id: "single-profile",
        title: "Only One Profile Configured",
        description: "A single profile gives all users the same permissions. Create role-specific profiles (Sales Rep, Sales Manager, Support, Admin) to enforce proper data access controls.",
        severity: "high", category: "changes", icon: "◑",
      });
    }
  }

  // User-based recommendations
  if (users.length > 0) {
    const inactiveUsers = users.filter(isInactiveUser);
    if (inactiveUsers.length > 0) {
      recs.push({
        id: "inactive-users",
        title: `${inactiveUsers.length} Inactive User${inactiveUsers.length > 1 ? "s" : ""} in CRM`,
        description: `${inactiveUsers.length} user${inactiveUsers.length > 1 ? "s are" : " is"} inactive. Remove or deactivate their licenses to reduce costs and prevent unauthorized access to historical data.`,
        severity: "medium", category: "changes", icon: "◎",
      });
    }
  }

  // Fields-based recommendations
  if (fields.length > 0) {
    if (fields.length > 200) {
      recs.push({
        id: "field-overload",
        title: `${fields.length} Fields - Review for Redundancy`,
        description: `${fields.length} fields are configured. Audit for duplicate, rarely-used, or deprecated fields. Excess fields clutter layouts and slow data entry.`,
        severity: "low", category: "changes", icon: "▤",
      });
    }
    const mandatoryFields = fields.filter(f => {
      const r = f as Record<string, unknown>;
      return r.required === true || r.mandatory === true || r.system_mandatory === true;
    });
    if (mandatoryFields.length > 20) {
      recs.push({
        id: "too-many-mandatory",
        title: `${mandatoryFields.length} Mandatory Fields May Hurt Adoption`,
        description: `${mandatoryFields.length} fields are marked mandatory. Too many required fields increase friction and lead to inaccurate data entry. Review which are truly business-critical.`,
        severity: "medium", category: "changes", icon: "▤",
      });
    }
  }

  // ── RECOMMENDED INTEGRATIONS ───────────────────────────────────────────────

  const hasEmailWf = wfs.some(w => JSON.stringify(w).toLowerCase().includes("email"));
  if (!hasEmailWf) {
    recs.push({
      id: "email-integration",
      title: "Set Up Email Automation",
      description: "No email-based workflow actions detected. Integrate Zoho Mail or Gmail to automate lead nurturing, deal follow-ups, and customer communications directly from CRM.",
      severity: "high", category: "integrations", icon: "✉",
    });
  }

  recs.push({
    id: "zoho-analytics",
    title: "Connect Zoho Analytics for Advanced Reporting",
    description: "Unlock advanced CRM dashboards with Zoho Analytics. Get deeper insights into pipeline performance, conversion rates, rep activity, and revenue forecasting.",
    severity: "medium", category: "integrations", icon: "◧",
  });

  if (pipeCount === 0) {
    recs.push({
      id: "zoho-campaigns",
      title: "Bridge Marketing with Zoho Campaigns",
      description: "No pipeline data found. Connect Zoho Campaigns to bridge marketing efforts with CRM - track lead conversion from campaigns and attribute revenue to marketing activities.",
      severity: "medium", category: "integrations", icon: "◫",
    });
  }

  recs.push({
    id: "zoho-sign",
    title: "Automate Deal Closure with Zoho Sign",
    description: "Integrate Zoho Sign to send contracts and collect e-signatures directly from deal records. Eliminate manual document handling and reduce time-to-close.",
    severity: "low", category: "integrations", icon: "✎",
  });

  recs.push({
    id: "zoho-desk",
    title: "Bridge Sales and Support with Zoho Desk",
    description: "Connect Zoho Desk to give your sales team full visibility into customer support tickets. Proactively manage at-risk accounts and improve post-sale relationships.",
    severity: "low", category: "integrations", icon: "⊙",
  });

  const hasSlack = tools.some(t => /slack/i.test(t.name + (t.description ?? "")));
  if (!hasSlack) {
    recs.push({
      id: "slack-integration",
      title: "Add Real-Time Notifications via Slack or Teams",
      description: "Push CRM notifications - new leads, deal stage changes, task assignments - directly to Slack or Microsoft Teams channels for instant team awareness.",
      severity: "low", category: "integrations", icon: "◈",
    });
  }

  recs.push({
    id: "zoho-salesiq",
    title: "Capture Website Leads with Zoho SalesIQ",
    description: "Integrate Zoho SalesIQ for live chat and visitor tracking on your website. Automatically create CRM leads from chat conversations and track visitor behavior.",
    severity: "medium", category: "integrations", icon: "◉",
  });

  // ── RECOMMENDED ARCHITECTURE ───────────────────────────────────────────────

  if (pipeCount > 5) {
    recs.push({
      id: "pipeline-consolidation",
      title: "Consolidate Sales Pipelines",
      description: `You have ${pipeCount} pipelines. Consider consolidating to 2-3 focused pipelines (e.g. New Business, Expansion, Renewal) to reduce complexity and improve forecast accuracy.`,
      severity: "medium", category: "architecture", icon: "⇥",
    });
  } else if (pipeCount === 0) {
    recs.push({
      id: "pipeline-setup",
      title: "Define a Structured Sales Pipeline",
      description: "No sales pipelines detected. Set up a clear pipeline with defined stages - Lead, Qualification, Proposal, Negotiation, Closed Won/Lost - to improve deal visibility and forecasting.",
      severity: "high", category: "architecture", icon: "⇥",
    });
  }

  if (bps.length > 0 && wfs.length > bps.length * 3) {
    recs.push({
      id: "blueprint-over-workflow",
      title: "Migrate Complex Workflows to Blueprints",
      description: `You have ${wfs.length} workflows but only ${bps.length} blueprints. Complex sequential processes should be modeled as Blueprints - they provide better visibility, audit trails, and enforce process adherence.`,
      severity: "medium", category: "architecture", icon: "◈",
    });
  }

  recs.push({
    id: "data-governance",
    title: "Implement a Field Standardization Policy",
    description: "Establish naming conventions, mandatory field requirements, and picklist standardization across modules. Consistent data structure enables reliable reporting and automation.",
    severity: "medium", category: "architecture", icon: "⊟",
  });

  // Profile architecture recommendations (uses getProfile data)
  if (profiles.length > 0) {
    recs.push({
      id: "profile-access",
      title: `Review ${profiles.length} Profile${profiles.length > 1 ? "s" : ""} - Enforce Least Privilege`,
      description: `${profiles.length} profile${profiles.length > 1 ? "s are" : " is"} configured. Map each profile to specific modules and fields. Restrict module creation/deletion rights to managers only and read-only for standard roles.`,
      severity: "high", category: "architecture", icon: "◑",
    });
  } else {
    recs.push({
      id: "profile-access",
      title: "Audit Profile-Based Module Access",
      description: "Review which profiles have access to each module and sensitive fields. Apply the principle of least privilege - restrict data access to roles that genuinely need it.",
      severity: "high", category: "architecture", icon: "⊞",
    });
  }

  // User architecture recommendations (uses getUser data)
  if (users.length > 0) {
    recs.push({
      id: "user-territory",
      title: `Assign Territories Across ${users.length} User${users.length > 1 ? "s" : ""}`,
      description: `With ${users.length} users in CRM, implement territory management to control which records each rep sees. This improves pipeline accuracy and prevents data overlap between sales reps.`,
      severity: "medium", category: "architecture", icon: "◎",
    });
  }

  // Fields architecture recommendations (uses getFields data)
  if (fields.length > 0) {
    recs.push({
      id: "field-architecture",
      title: `Standardize ${fields.length} Field Definitions`,
      description: `${fields.length} fields are in use. Establish a field registry - document each field's purpose, owner, and allowed values. Prevent duplicate fields by enforcing a naming convention before any new fields are added.`,
      severity: "medium", category: "architecture", icon: "▤",
    });
  }

  // Layouts + Profiles: role-based layouts
  if (layouts.length > 0 && profiles.length > 1) {
    recs.push({
      id: "layout-profile-mapping",
      title: "Map Layouts to Profiles for Role-Based Views",
      description: `You have ${layouts.length} layout${layouts.length > 1 ? "s" : ""} and ${profiles.length} profiles. Assign specific layouts to each profile so Sales, Support, and Admin users see only the fields relevant to their role.`,
      severity: "medium", category: "architecture", icon: "⊟",
    });
  }

  if (mods.length > 15) {
    recs.push({
      id: "module-rationalization",
      title: "Rationalize Custom Module Usage",
      description: `You have ${mods.length} modules. Audit custom modules for utilization - underused custom modules should be merged, repurposed, or decommissioned to reduce system complexity.`,
      severity: "low", category: "architecture", icon: "⊞",
    });
  }

  recs.push({
    id: "automation-hierarchy",
    title: "Define Automation Hierarchy: Field Updates → Workflows → Blueprints",
    description: "Establish clear rules: use field-level defaults for simple values, workflows for event-triggered notifications/updates, and blueprints for multi-step approval and process adherence.",
    severity: "medium", category: "architecture", icon: "⟳",
  });

  // Approval Process - real per-module counts when getApprovalProcess is connected;
  // falls back to the general best-practice suggestion otherwise.
  const approvalEntries = ruleCoverage ? Object.entries(ruleCoverage.approval) : [];
  if (approvalEntries.length > 0) {
    const zeroApproval = approvalEntries.filter(([, stat]) => stat.total === 0).map(([name]) => name);
    if (zeroApproval.length > 0) {
      recs.push({
        id: "approval-process",
        title: `${zeroApproval.length} of ${approvalEntries.length} Core Modules Have No Approval Process`,
        description: `${zeroApproval.join(", ")} ${zeroApproval.length > 1 ? "have" : "has"} no approval process configured. Approval Processes require manager sign-off before a record change goes through - e.g. blocking a high-value deal or large discount from closing without review - instead of letting any rep close or edit sensitive records with no checkpoint.`,
        severity: "medium", category: "architecture", icon: "☑",
      });
    } else {
      recs.push({
        id: "approval-process",
        title: "Approval Processes Are Configured Across Core Modules",
        description: `All ${approvalEntries.length} core modules have at least one approval process (${approvalEntries.map(([n, c]) => `${n}: ${c.total}`).join(", ")}). Keep reviewing thresholds as deal sizes and discount policy change.`,
        severity: "low", category: "architecture", icon: "☑",
      });
    }
  } else {
    recs.push({
      id: "approval-process",
      title: "Set Up Approval Processes for High-Value Records",
      description: "Use Approval Processes to require manager sign-off before high-value deals, large discounts, or refunds go through. Without one configured, any rep can close or edit sensitive records with no checkpoint in between.",
      severity: "medium", category: "architecture", icon: "☑",
    });
  }

  // Assignment Rules - real per-module counts when getAssignmentRules is connected.
  const assignmentEntries = ruleCoverage ? Object.entries(ruleCoverage.assignment) : [];
  if (assignmentEntries.length > 0) {
    const zeroAssignment = assignmentEntries.filter(([, stat]) => stat.total === 0).map(([name]) => name);
    if (zeroAssignment.length > 0) {
      recs.push({
        id: "assignment-rules",
        title: `${zeroAssignment.length} of ${assignmentEntries.length} Core Modules Have No Assignment Rules`,
        description: `${zeroAssignment.join(", ")} ${zeroAssignment.length > 1 ? "have" : "has"} zero assignment rules configured. Assignment rules automatically route new records to the right rep or queue - e.g. sending Leads from a specific source straight to the SDR on rotation - instead of leaving them sitting unassigned until someone notices.`,
        severity: "medium", category: "architecture", icon: "➜",
      });
    } else {
      recs.push({
        id: "assignment-rules",
        title: "Assignment Rules Are Configured Across Core Modules",
        description: `All ${assignmentEntries.length} core modules have at least one assignment rule (${assignmentEntries.map(([n, c]) => `${n}: ${c.total}`).join(", ")}). Keep reviewing them as territories or reps change.`,
        severity: "low", category: "architecture", icon: "➜",
      });
    }
  } else {
    recs.push({
      id: "assignment-rules",
      title: "Add Assignment Rules to Route Records Automatically",
      description: "Assignment rules automatically route new records to the right rep or queue based on criteria like source, region, or product - e.g. sending Leads from a specific source straight to the SDR on rotation. Without one, new records sit unassigned until someone manually claims them.",
      severity: "medium", category: "architecture", icon: "➜",
    });
  }

  // Validation Rules - real per-module counts when getValidationRules is connected.
  const valEntries = ruleCoverage ? Object.entries(ruleCoverage.validation) : [];
  if (valEntries.length > 0) {
    const zeroVal = valEntries.filter(([, stat]) => stat.total === 0).map(([name]) => name);
    if (zeroVal.length > 0) {
      recs.push({
        id: "validation-rules",
        title: `${zeroVal.length} of ${valEntries.length} Core Modules Have No Validation Rules`,
        description: `${zeroVal.join(", ")} ${zeroVal.length > 1 ? "have" : "has"} zero validation rules configured. Validation rules stop bad data before it's ever saved - e.g. blocking a Closed Won deal with no amount, or an invalid email format - instead of relying on a workflow to clean it up afterward.`,
        severity: "medium", category: "architecture", icon: "⚑",
      });
    } else {
      recs.push({
        id: "validation-rules",
        title: "Validation Rules Are Configured Across Core Modules",
        description: `All ${valEntries.length} core modules have at least one validation rule (${valEntries.map(([n, c]) => `${n}: ${c.total}`).join(", ")}). Keep reviewing them as new fields and picklists get added.`,
        severity: "low", category: "architecture", icon: "⚑",
      });
    }
  } else {
    recs.push({
      id: "validation-rules",
      title: "Add Validation Rules to Enforce Data Quality at Entry",
      description: "Validation rules stop bad data before it's ever saved - e.g. blocking a Closed Won deal with no amount, or an email field with an invalid format. They catch mistakes at the source instead of relying on a workflow to clean them up afterward.",
      severity: "medium", category: "architecture", icon: "⚑",
    });
  }

  // Layout Rules - real per-module counts when getLayoutRules is connected.
  const layoutEntries = ruleCoverage ? Object.entries(ruleCoverage.layout) : [];
  if (layoutEntries.length > 0) {
    const zeroLayout = layoutEntries.filter(([, stat]) => stat.total === 0).map(([name]) => name);
    if (zeroLayout.length > 0) {
      recs.push({
        id: "layout-rules",
        title: `${zeroLayout.length} of ${layoutEntries.length} Core Modules Have No Layout Rules`,
        description: `${zeroLayout.join(", ")} ${zeroLayout.length > 1 ? "have" : "has"} no layout rules. They dynamically show, hide, or require fields based on other field values - e.g. only showing "Reason for Loss" once Stage is set to Closed Lost - so forms stay focused instead of showing every field to every rep.`,
        severity: "low", category: "architecture", icon: "⊡",
      });
    } else {
      recs.push({
        id: "layout-rules",
        title: "Layout Rules Are Configured Across Core Modules",
        description: `All ${layoutEntries.length} core modules have at least one layout rule (${layoutEntries.map(([n, c]) => `${n}: ${c.total}`).join(", ")}). Nice - reps only see fields relevant to the record they're on.`,
        severity: "low", category: "architecture", icon: "⊡",
      });
    }
  } else {
    recs.push({
      id: "layout-rules",
      title: "Use Layout Rules to Show Only Relevant Fields",
      description: "Layout rules dynamically show, hide, or require fields based on other field values - e.g. only showing \"Reason for Loss\" once Stage is set to Closed Lost. This keeps forms focused instead of showing every field to every rep regardless of context.",
      severity: "low", category: "architecture", icon: "⊡",
    });
  }

  // Schedules have no dedicated listing tool anywhere in Zoho's real MCP
  // catalogue, but a Scheduled Function is just a Deluge function with
  // category=="Schedule" - confirmed live against a real org - so this reads
  // functionHealth's schedule counts (sourced from the same function list
  // the Functions recs above use) instead of always falling back to a
  // generic, unconfirmed suggestion.
  if (functionHealth && functionHealth.scheduleTotal > 0) {
    if (functionHealth.scheduleInactive > 0) {
      recs.push({
        id: "schedules",
        title: `${functionHealth.scheduleInactive} of ${functionHealth.scheduleTotal} Schedules Are Inactive`,
        description: `${functionHealth.scheduleInactive} Schedule-category function${functionHealth.scheduleInactive !== 1 ? "s are" : " is"} disabled. Last run/next run/frequency aren't exposed by the Functions API, so this can only confirm active state - reactivate what's still needed, or delete the rest.`,
        severity: "medium", category: "architecture", icon: "◷",
      });
    } else {
      recs.push({
        id: "schedules",
        title: `${functionHealth.scheduleTotal} Schedule${functionHealth.scheduleTotal !== 1 ? "s" : ""} Found, All Active`,
        description: `All ${functionHealth.scheduleTotal} Schedule-category function${functionHealth.scheduleTotal !== 1 ? "s are" : " is"} active. Last run/next run/frequency aren't exposed by the Functions API, so staleness can't be checked - only that they're currently enabled.`,
        severity: "low", category: "architecture", icon: "◷",
      });
    }
  } else {
    recs.push({
      id: "schedules",
      title: "Use Schedules to Automate Recurring Tasks",
      description: "Schedules run workflows, functions, or blueprint actions automatically on a recurring cadence - e.g. nightly data cleanup or a weekly digest email - without needing a person to trigger them by hand.",
      severity: "low", category: "architecture", icon: "◷",
    });
  }

  return recs;
}

function formatRelative(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

type ModuleCategory = "active" | "hidden" | "empty";

// Display label only - the underlying category key stays "hidden" (matches
// isHiddenModule/status-hidden CSS etc.) so this is purely a user-facing
// rename, not a behavior change.
const MODULE_FILTER_LABELS: Record<ModuleCategory, string> = { active: "Active", hidden: "Inactive", empty: "Empty" };

interface ModuleBreakdownRow {
  apiName: string;
  name: string;
  category: ModuleCategory;
  custom: boolean;
}

// A module can technically be both hidden and empty at once - hidden takes
// priority since visibility is the more prominent state, so each module
// gets exactly one category for filtering rather than overlapping tags.
const MODULE_CATEGORY_ORDER: Record<ModuleCategory, number> = { hidden: 0, empty: 1, active: 2 };

// Sorted actionable-first (hidden, then empty, then active) - same
// convention as the blueprint/workflow breakdowns elsewhere in this file.
function computeModuleBreakdown(entityData: Record<CrmEntityType, EntityState>): ModuleBreakdownRow[] {
  return entityData.modules.items
    .filter(m => !isDeletedModule(m) && !isInternalModule(m) && !isSystemHiddenModule(m))
    .map((m, i) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const apiName = moduleApiName(m);
      const category: ModuleCategory = isHiddenModule(m) ? "hidden" : isEmptyModule(m) ? "empty" : "active";
      return {
        apiName: apiName || String(i),
        name: String(r.plural_label ?? r.singular_label ?? r.module_name ?? apiName ?? `Module ${i + 1}`),
        category,
        custom: isCustomModule(m),
      };
    })
    .sort((a, b) => MODULE_CATEGORY_ORDER[a.category] - MODULE_CATEGORY_ORDER[b.category]);
}

// Same "flag the actionable groups, name a few real ones, praise a healthy
// org" synthesis as buildZiaWorkflowInsight/buildZiaScheduleInsight above -
// "hidden" is still the underlying category key (matches isHiddenModule),
// but described as "inactive" here to match the drilldown's renamed label.
function buildZiaModuleInsight(rows: ModuleBreakdownRow[]): ZiaInsight {
  if (rows.length === 0) return { summary: "No modules found - nothing to evaluate yet.", points: [] };
  const inactive = rows.filter(r => r.category === "hidden");
  const empty = rows.filter(r => r.category === "empty");
  const points: string[] = [];
  if (inactive.length > 0) {
    points.push(cap(`${inactive.length} of ${rows.length} module${rows.length !== 1 ? "s are" : " is"} inactive (hidden from users) - ${inactive.slice(0, 3).map(m => m.name).join(", ")}${inactive.length > 3 ? ", etc." : "."}`));
  }
  if (empty.length > 0) {
    points.push(cap(`${empty.length} module${empty.length !== 1 ? "s are" : " is"} empty/unused - nobody can create or edit records in ${empty.length !== 1 ? "them" : "it"}: ${empty.slice(0, 3).map(m => m.name).join(", ")}${empty.length > 3 ? ", etc." : "."}`));
  }
  if (points.length === 0) {
    return { summary: `All ${rows.length} module${rows.length !== 1 ? "s are" : " is"} active and in use - looks healthy.`, points: [] };
  }
  return {
    summary: "", points,
    action: "Re-enable the inactive ones if they're still needed, or clean up the unused/empty ones so the module list stays easy to navigate.",
  };
}

interface WorkflowBreakdownRow {
  id: string;
  name: string;
  module: string;
  active: boolean;
  lastTriggered: string | null;
  // True only when the workflow HAS fired before but not within
  // LONG_TRIGGER_DAYS - distinct from "Never Triggered" (lastTriggered ===
  // null), which flags a rule that's never matched its criteria at all.
  longTrigger: boolean;
  duplicate: boolean;
  overlapping: boolean;
  // Human-readable explanation of *why* duplicate/overlapping fired: the
  // matched condition (module/trigger/criteria/actions), which other
  // workflow(s) it matched, and how many times that exact condition repeats
  // - a bare "duplicate" badge can't answer any of those on its own.
  duplicateDetail: string | null;
  overlappingDetail: string | null;
}

// Describes the exact signature two-or-more workflows share: module +
// trigger event, plus (for a true content duplicate) the criteria field
// names and action count - spelled out instead of just asserting "identical"
// or "overlapping", since two rules with empty criteria and no actions look
// suspicious grouped together unless it's clear *that emptiness itself* is
// the shared condition.
function workflowMatchCondition(w: unknown, includeCriteriaActions: boolean): string {
  const parts = [`Module: ${workflowModuleLabel(w) || "-"}`, `Trigger: ${workflowTriggerLabel(w) || "-"}`];
  if (includeCriteriaActions) {
    const conditions = workflowCriteriaFieldConditions(w);
    parts.push(conditions.length > 0 ? `Criteria: ${conditions.join(", ")}` : "Criteria: same");
    const actionTypes = workflowActionTypeNames(w);
    parts.push(actionTypes.length > 0 ? `Actions: ${actionTypes.join(", ")}` : "Actions: none set");
  }
  return parts.join(" · ");
}

function workflowMatchDetail(w: unknown, group: unknown[], includeCriteriaActions: boolean): string {
  const others = group.filter(o => o !== w);
  const names = others.map((o, i) => getItemName(o, i)).join(", ") || "-";
  return `Matched on - ${workflowMatchCondition(w, includeCriteriaActions)}. Same as ${others.length} other workflow${others.length !== 1 ? "s" : ""}: ${names}. Detected ${group.length} times total.`;
}

// Every badge in the Workflows drilldown - duplicate/overlapping included -
// explains itself the same way: what the badge means, and (where relevant)
// the specific evidence behind it for *this* row, not just the label.
const WORKFLOW_ACTIVE_TOOLTIP = "This workflow rule is enabled - it will fire automatically the next time its trigger event occurs.";
const WORKFLOW_INACTIVE_TOOLTIP = "This workflow rule is disabled - it will not fire until it's re-enabled.";
const LONG_TRIGGER_DAYS = 90;
const WORKFLOW_LONG_TRIGGER_TOOLTIP = `This workflow has fired before, but not in over ${LONG_TRIGGER_DAYS} days - it may no longer match any real record or criteria, or the process it automates may have moved elsewhere. Worth confirming it's still needed.`;
function workflowLastTriggeredTooltip(row: WorkflowBreakdownRow): string {
  if (!row.lastTriggered) {
    return "No execution recorded for this workflow yet - it has never matched its trigger criteria, or this MCP connection doesn't expose execution history.";
  }
  return row.longTrigger
    ? `Last executed ${formatLastTriggered(row.lastTriggered)} - over ${LONG_TRIGGER_DAYS} days ago.`
    : `Last executed ${formatLastTriggered(row.lastTriggered)}.`;
}

// Case-insensitive display-name grouping for the Workflows card's "Duplicate"
// badge - unlike identicalWorkflowGroups (module+trigger+criteria+actions,
// name deliberately excluded, used by the real Health Score and Automation
// Health checklist), this card's Duplicate concept is scoped to name only,
// same simple match the Functions card's "Duplicate Function Names" already
// uses - no module/trigger/criteria/actions comparison involved.
function workflowNameDuplicateGroups(rows: { id: string; name: string }[]): Map<string, { id: string; name: string }[]> {
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (!key) continue;
    const arr = byName.get(key) ?? [];
    arr.push(row);
    byName.set(key, arr);
  }
  for (const [key, arr] of byName) if (arr.length < 2) byName.delete(key);
  return byName;
}

function workflowNameMatchDetail(id: string, group: { id: string; name: string }[]): string {
  const others = group.filter(m => m.id !== id);
  const names = others.map(m => m.name).join(", ") || "-";
  return `Matched on - Name: "${group[0].name}" (case-insensitive). Same as ${others.length} other workflow${others.length !== 1 ? "s" : ""}: ${names}. Detected ${group.length} times total.`;
}

// Sorted inactive-first, then never-triggered-first within active - same
// "surface the actionable ones" convention as the other breakdowns here.
function computeWorkflowBreakdown(items: unknown[]): WorkflowBreakdownRow[] {
  const idNames = items.map((w, i) => ({ id: String((w as Record<string, unknown> | null)?.id ?? i), name: getItemName(w, i) }));
  const nameGroups = workflowNameDuplicateGroups(idNames);
  const duplicateGroupById = new Map<string, { id: string; name: string }[]>();
  for (const group of nameGroups.values()) for (const m of group) duplicateGroupById.set(m.id, group);

  const overlappingSet = new Set(overlappingWorkflows(items));
  const overlappingGroupByItem = new Map<unknown, unknown[]>();
  overlappingWorkflowGroups(items).forEach(group => group.forEach(w => overlappingGroupByItem.set(w, group)));
  return items
    .map((w, i) => {
      const id = idNames[i].id;
      const duplicateGroup = duplicateGroupById.get(id);
      const duplicate = !!duplicateGroup;
      const overlapping = overlappingSet.has(w);
      const overlappingGroup = overlappingGroupByItem.get(w);
      const lastTriggered = workflowLastTriggered(w);
      const daysSinceTrigger = daysSince(lastTriggered);
      return {
        id,
        name: idNames[i].name,
        module: workflowModuleLabel(w) || "-",
        active: isActiveWorkflow(w),
        lastTriggered,
        longTrigger: daysSinceTrigger !== null && daysSinceTrigger > LONG_TRIGGER_DAYS,
        duplicate,
        overlapping,
        duplicateDetail: duplicateGroup ? workflowNameMatchDetail(id, duplicateGroup) : null,
        overlappingDetail: overlapping && overlappingGroup ? workflowMatchDetail(w, overlappingGroup, false) : null,
      };
    })
    .sort((a, b) => Number(a.active) - Number(b.active) || Number(!!a.lastTriggered) - Number(!!b.lastTriggered));
}

interface WorkflowDuplicateGroupView {
  key: string;
  condition: string;
  items: { id: string; name: string }[];
}

// Grouped view of workflowNameDuplicateGroups, for the Duplicate filter to
// render as expandable match-condition cards - same "one row per group,
// count badge, expandable member chips" shape as the Functions card's
// Duplicate Function Names tab, instead of scattering each duplicate as its
// own flat row.
function computeWorkflowDuplicateGroups(items: unknown[]): WorkflowDuplicateGroupView[] {
  const idNames = items.map((w, i) => ({ id: String((w as Record<string, unknown> | null)?.id ?? i), name: getItemName(w, i) }));
  return [...workflowNameDuplicateGroups(idNames).values()]
    .map(members => ({ key: members.map(m => m.id).join(","), condition: `Name: "${members[0].name}"`, items: members }))
    .sort((a, b) => b.items.length - a.items.length);
}

// Grouped view of overlappingWorkflowGroups (active workflows sharing a
// module + trigger event), same "one row per group, count badge, expandable
// member chips" shape as the Duplicate tab - shows exactly which workflows
// race on the same event and what that shared event is, instead of a flat
// "overlapping" badge with no way to see who it's overlapping *with*.
function computeWorkflowOverlapGroups(items: unknown[]): WorkflowDuplicateGroupView[] {
  return overlappingWorkflowGroups(items)
    .map(group => {
      const members = group.map((w, i) => ({ id: String((w as Record<string, unknown> | null)?.id ?? i), name: getItemName(w, i) }));
      return { key: members.map(m => m.id).join(","), condition: workflowMatchCondition(group[0], false), items: members };
    })
    .sort((a, b) => b.items.length - a.items.length);
}

// "never" isn't mutually exclusive with active/inactive (an active workflow
// can genuinely have never fired yet), and duplicate/overlapping are their own
// independent flags too - so each toggle applies its own predicate rather than
// assigning one category per row.
function matchesWorkflowFilter(row: WorkflowBreakdownRow, filter: "all" | "active" | "inactive" | "never" | "long-trigger" | "duplicate" | "overlapping"): boolean {
  if (filter === "all") return true;
  if (filter === "active") return row.active;
  if (filter === "inactive") return !row.active;
  if (filter === "duplicate") return row.duplicate;
  if (filter === "overlapping") return row.overlapping;
  if (filter === "long-trigger") return row.longTrigger;
  return !row.lastTriggered;
}

function formatLastTriggered(iso: string | null): string {
  if (!iso) return "Never triggered";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// Shared shape for every "Zia flags: ..." style insight below - `points` is
// one flagged issue per bullet (empty when everything's healthy, in which
// case `summary` carries the single all-clear sentence instead), and
// `action` is the optional closing "here's what to do about it" line shown
// under the bullet list. Splitting flags into an array instead of joining
// them into one semicolon-separated sentence is what lets ZiaRecBody render
// them as a real bullet list rather than a wall of text.
interface ZiaInsight {
  summary: string;
  points: string[];
  action?: string;
}

// Always a bulleted list, even the single-line "all clear" case - one
// consistent look across every Zia Recommendation box in the app instead of
// a plain paragraph for the healthy case and bullets only once something's
// actually flagged.
function ZiaRecBody({ summary, points, action }: ZiaInsight) {
  const lines = points.length > 0 ? points : [summary];
  return (
    <>
      <ul className="zia-rec-list">
        {lines.map((point, i) => <li key={i}>{point}</li>)}
      </ul>
      {action && <p className="zia-rec-action">{action}</p>}
    </>
  );
}

// Same "flag the stale ones, praise the healthy ones" synthesis as
// buildZiaActivityInsight below, applied to the workflow breakdown instead.
// Up to `limit` real workflow names for a flagged group, e.g. "e.g. Follow
// Up Email, Assign New Lead, etc." - named examples instead of a bare count,
// same "never just 'several'" convention the rest of this app's findings use.
function namedExamples(rows: WorkflowBreakdownRow[], limit = 3): string {
  const shown = rows.slice(0, limit).map(r => r.name).join(", ");
  return rows.length > limit ? `e.g. ${shown}, etc.` : `e.g. ${shown}.`;
}

function buildZiaWorkflowInsight(rows: WorkflowBreakdownRow[]): ZiaInsight {
  if (rows.length === 0) return { summary: "No workflows found - nothing to evaluate yet.", points: [] };
  const inactiveRows = rows.filter(r => !r.active);
  const neverTriggeredRows = rows.filter(r => r.active && !r.lastTriggered);
  const longTriggerRows = rows.filter(r => r.active && r.longTrigger);
  const duplicateRows = rows.filter(r => r.duplicate);
  const overlappingRows = rows.filter(r => r.overlapping);
  const points: string[] = [];
  if (duplicateRows.length > 0) points.push(cap(`${duplicateRows.length} workflow${duplicateRows.length !== 1 ? "s share" : " shares"} the exact same name as another workflow - ${namedExamples(duplicateRows)}`));
  if (overlappingRows.length > 0) points.push(cap(`${overlappingRows.length} workflow${overlappingRows.length !== 1 ? "s share" : " shares"} a trigger event with another active rule - ${namedExamples(overlappingRows)}`));
  if (inactiveRows.length > 0) points.push(cap(`${inactiveRows.length} workflow${inactiveRows.length !== 1 ? "s are" : " is"} inactive - ${namedExamples(inactiveRows)}`));
  if (neverTriggeredRows.length > 0) points.push(cap(`${neverTriggeredRows.length} active workflow${neverTriggeredRows.length !== 1 ? "s have" : " has"} never fired - ${namedExamples(neverTriggeredRows)}`));
  if (longTriggerRows.length > 0) points.push(cap(`${longTriggerRows.length} active workflow${longTriggerRows.length !== 1 ? "s haven't" : " hasn't"} fired in over ${LONG_TRIGGER_DAYS} days - ${namedExamples(longTriggerRows)}`));
  if (points.length === 0) return { summary: "All workflows are active, unique, and have fired at least once - automation looks healthy.", points: [] };

  // Tailored to whichever issues are actually present, instead of one
  // generic catch-all sentence that mentions fixes for problems this org
  // might not even have.
  const actions: string[] = [];
  if (duplicateRows.length > 0) actions.push("merge or delete the duplicates");
  if (overlappingRows.length > 0) actions.push("consolidate rules racing on the same trigger");
  if (inactiveRows.length > 0) actions.push("reactivate or delete the inactive ones");
  if (neverTriggeredRows.length > 0 || longTriggerRows.length > 0) actions.push("confirm the stale ones still match real records, or retire them");
  return { summary: "", points, action: cap(`${actions.join("; ")}.`) };
}

// ─── Activity (Email / Task / Call) drill-down ─────────────────────────────────
// Tasks already ride along in entityData (the "tasks" entity, fetched via the
// generic getRecords tool - see fetchTasksViaRecords in useCrmEntities.ts).
// Calls is a standard Zoho CRM module too (confirmed live: getRecords lists
// "Calls" as a supported module name), so it's fetched here the exact same
// way - there is no dedicated per-entity "getCalls" tool anywhere in Zoho's
// real MCP catalogue, so looking for one by name (the old behavior) always
// found nothing and permanently misreported real call activity as
// "no call-logging tool is connected". Emails has no equivalent: Zoho CRM's
// API only exposes emails per-record (a related list under each Lead/
// Contact/etc.), never as one flat org-wide module - so it genuinely stays
// unavailable here, not a bug to "fix" by guessing a tool name.
interface ActivityFetchState {
  items: unknown[];
  loading: boolean;
  fetched: boolean;
  unavailable: boolean;
}

const ACTIVITY_FETCH_INIT: ActivityFetchState = { items: [], loading: false, fetched: false, unavailable: false };
const ACTIVITY_MAX_PAGES = 5;
const CALLS_RECORD_FIELDS = ["id", "Subject", "Call_Type", "Call_Status", "Call_Start_Time", "Call_Duration", "Description", "Created_Time", "Modified_Time"];

function useActivityRecords(config: McpConfig | null, tools: McpTool[], active: boolean, onLog: (log: ExecutionLog) => void) {
  const [calls, setCalls] = useState<ActivityFetchState>(ACTIVITY_FETCH_INIT);
  const [emails, setEmails] = useState<ActivityFetchState>(ACTIVITY_FETCH_INIT);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!active || fetchedRef.current) return;
    if (!config || tools.length === 0) return;
    fetchedRef.current = true;

    const recordsTool = tools.find(t => /getrecords$/i.test(t.name));
    const emailsTool = tools.find(t => /getemails$/i.test(t.name)) ?? tools.find(t => /listemails|allemails|sentemails/i.test(t.name));

    async function fetchCalls() {
      if (!recordsTool) { setCalls(prev => ({ ...prev, unavailable: true })); return; }
      setCalls(prev => ({ ...prev, loading: true }));
      const locations = findParamLocations(recordsTool);
      const moduleLoc = findParam(locations, /^module$/i) ?? { group: null, key: "module" };
      const fieldsLoc = findParam(locations, /^fields$/i) ?? { group: null, key: "fields" };
      const perPageLoc = findParam(locations, /per_?page|page_?size|^limit$|^count$/i);
      const pageTokenLoc = findParam(locations, /^page_?token$/i);
      let items: unknown[] = [];
      let pageToken: string | null = null;
      for (let page = 1; page <= ACTIVITY_MAX_PAGES; page++) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        setParam(input, moduleLoc, "Calls");
        setParam(input, fieldsLoc, CALLS_RECORD_FIELDS.join(","));
        if (perPageLoc) setParam(input, perPageLoc, 200);
        if (page > 1 && pageToken && pageTokenLoc) setParam(input, pageTokenLoc, pageToken);
        try {
          const output = await executeTool(config as McpConfig, recordsTool.name, input);
          const pageItems = extractArray(output);
          items = items.concat(pageItems);
          onLog({ id: crypto.randomUUID(), tool: recordsTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          const info = extractPageInfo(output);
          if (!info?.moreRecords || !pageTokenLoc || !info.nextPageToken) break;
          pageToken = info.nextPageToken;
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: recordsTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          break;
        }
      }
      setCalls({ items, loading: false, fetched: true, unavailable: false });
    }

    async function fetchEmails() {
      if (!emailsTool) { setEmails(prev => ({ ...prev, unavailable: true })); return; }
      setEmails(prev => ({ ...prev, loading: true }));
      const pageLoc = findParam(findParamLocations(emailsTool), /^page$/i);
      let items: unknown[] = [];
      for (let page = 1; page <= ACTIVITY_MAX_PAGES; page++) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        if (page > 1 && pageLoc) setParam(input, pageLoc, page);
        try {
          const output = await executeTool(config as McpConfig, emailsTool.name, input);
          const pageItems = extractArray(output);
          items = items.concat(pageItems);
          onLog({ id: crypto.randomUUID(), tool: emailsTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          if (!pageLoc || pageItems.length === 0) break;
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: emailsTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          break;
        }
      }
      setEmails({ items, loading: false, fetched: true, unavailable: false });
    }

    void fetchCalls();
    void fetchEmails();
  }, [active, config, tools, onLog]);

  return { calls, emails };
}

function activityStatusText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const r = item as Record<string, unknown>;
  return String(r.status ?? r.Status ?? r.call_status ?? r.Call_Status ?? r.task_status ?? "").toLowerCase();
}

function isCompletedActivity(item: unknown): boolean {
  const s = activityStatusText(item);
  return s.includes("complet") || s.includes("held") || s === "closed" || s === "sent";
}

function isOverdueTask(item: unknown): boolean {
  if (isCompletedActivity(item)) return false;
  const r = item as Record<string, unknown>;
  const due = r.due_date ?? r.Due_Date ?? r.closingdate;
  if (typeof due !== "string" || !due) return false;
  const d = new Date(due);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

function isMissedCall(item: unknown): boolean {
  const s = activityStatusText(item);
  return s.includes("missed") || s.includes("no answer") || s.includes("no-answer") || s.includes("cancel");
}

interface ActivityStat {
  key: "email" | "task" | "call";
  label: string;
  total: number;
  loading: boolean;
  suggestion: string;
}

function buildActivityStats(
  tasksResolved: boolean,
  taskItems: unknown[],
  calls: ActivityFetchState,
  emails: ActivityFetchState,
): ActivityStat[] {
  const taskTotal = taskItems.length;
  const taskOverdue = taskItems.filter(isOverdueTask).length;
  const taskSuggestion = !tasksResolved ? "Fetching…"
    : taskTotal === 0 ? "No tasks logged in this CRM - reps may not be tracking follow-ups here at all."
    : taskOverdue > 0 ? `${taskOverdue} of ${taskTotal} tasks (${Math.round((taskOverdue / taskTotal) * 100)}%) are overdue - assign owners or set due-date reminders so leads don't go cold.`
    : "Tasks are being kept current - no overdue items right now.";

  const callTotal = calls.items.length;
  const callMissed = calls.items.filter(isMissedCall).length;
  const callSuggestion = calls.unavailable ? "The connected MCP server doesn't expose a records tool - call activity can't be measured from here."
    : calls.loading ? "Fetching…"
    : callTotal === 0 ? "No calls logged against records - outreach may be happening outside the CRM, so you can't measure it."
    : callMissed > 0 ? `${callMissed} of ${callTotal} calls are logged as missed, no-answer, or cancelled - follow up before these leads go cold.`
    : "Calls are being logged consistently - no missed calls outstanding.";

  const emailTotal = emails.items.length;
  // Distinct from the calls/tasks "unavailable" case above - this isn't a
  // missing tool, Zoho CRM's API simply has no org-wide Emails module (unlike
  // Tasks/Calls). Emails only exist as a per-record related list (e.g. GET
  // .../Leads/{id}/Emails), so there is no flat "all sent emails" endpoint to
  // ever call here - stated as a platform limitation, not something a
  // reconnect or different tool selection could fix.
  const emailSuggestion = emails.unavailable ? "Zoho CRM has no org-wide Emails endpoint - email activity can only be measured per record, not across the whole org."
    : emails.loading ? "Fetching…"
    : emailTotal === 0 ? "No emails logged against records - you can't verify follow-up actually happened."
    : "Email activity is being tracked against records.";

  return [
    { key: "email", label: "Email", total: emailTotal, loading: emails.loading, suggestion: emailSuggestion },
    { key: "task", label: "Task", total: taskTotal, loading: !tasksResolved, suggestion: taskSuggestion },
    { key: "call", label: "Call", total: callTotal, loading: calls.loading, suggestion: callSuggestion },
  ];
}

interface LatestActivity {
  date: string | null;
}

// Scans for whichever date field the item actually carries (varies by MCP
// server/API version - same defensive fallback-chain pattern as the rest of
// this file) and keeps the most recent one found. Deliberately never reads a
// subject/title field - real record names/subjects aren't shown anywhere in
// this section, same redaction policy as the rest of the app's Zia
// Recommendation and checklist copy.
function latestActivity(items: unknown[], dateFields: string[]): LatestActivity {
  let bestDate: string | null = null;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    let dateVal: string | null = null;
    for (const f of dateFields) {
      const v = r[f];
      if (typeof v === "string" && v) { dateVal = v; break; }
    }
    if (!dateVal) continue;
    const d = new Date(dateVal);
    if (Number.isNaN(d.getTime())) continue;
    if (!bestDate || d.getTime() > new Date(bestDate).getTime()) bestDate = dateVal;
  }
  return { date: bestDate };
}

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

interface ZiaActivityInsight extends ZiaInsight {
  lastEmail: LatestActivity;
  lastCall: LatestActivity;
  lastTaskDue: LatestActivity;
}

// Synthesizes the three freshest-activity signals into one Zia-style verdict -
// same "flag the stale ones, praise the healthy ones" tone as the rest of the
// dashboard's recommendation copy.
function buildZiaActivityInsight(taskItems: unknown[], calls: ActivityFetchState, emails: ActivityFetchState): ZiaActivityInsight {
  const lastEmail = latestActivity(emails.items, ["sent_time", "Sent_Time", "created_time", "Created_Time", "Modified_Time"]);
  const lastCall = latestActivity(calls.items, ["call_start_time", "Call_Start_Time", "created_time", "Created_Time"]);
  const lastTaskDue = latestActivity(taskItems, ["due_date", "Due_Date", "closingdate"]);

  const STALE_DAYS = 14;
  const points: string[] = [];

  if (!emails.unavailable) {
    const days = daysSince(lastEmail.date);
    if (days === null) points.push("No emails have been logged yet.");
    else if (days > STALE_DAYS) points.push(`The last email was ${days} days ago.`);
  }
  if (!calls.unavailable) {
    const days = daysSince(lastCall.date);
    if (days === null) points.push("No calls have been logged yet.");
    else if (days > STALE_DAYS) points.push(`The last call was ${days} days ago.`);
  }
  const taskDays = daysSince(lastTaskDue.date);
  if (taskDays !== null && taskDays > 0) points.push(`The most recently due task is now ${taskDays} day${taskDays !== 1 ? "s" : ""} overdue.`);

  if (points.length === 0) {
    return { lastEmail, lastCall, lastTaskDue, summary: "Recent activity looks healthy across email, calls, and tasks - no gaps flagged.", points: [] };
  }
  return { lastEmail, lastCall, lastTaskDue, summary: "", points, action: "Re-engage before this account goes cold." };
}

// ─── Activity table (Email / Task / Call combined, filterable by type) ─────
const ACTIVITY_TABLE_PAGE_SIZE = 10;

type ActivityRowType = "email" | "task" | "call";

interface ActivityTableRow {
  id: string;
  type: ActivityRowType;
  status: string;
  severity: "good" | "bad" | "neutral";
  date: string | null;
}

function activityRowDate(item: unknown, fields: string[]): string | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  for (const f of fields) {
    const v = r[f];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// No subject/name is ever read here - real record names aren't shown in this
// table, same redaction policy as the rest of the app's Zia Recommendation
// and checklist copy. Only a derived status (Overdue/Missed/Completed/etc.)
// and a date, both from the same predicates the sub-KPI tiles above already
// use (isOverdueTask/isMissedCall/isCompletedActivity).
function computeActivityTableRows(taskItems: unknown[], calls: ActivityFetchState, emails: ActivityFetchState): ActivityTableRow[] {
  const taskRows: ActivityTableRow[] = taskItems.map((t, i) => {
    const overdue = isOverdueTask(t);
    const completed = isCompletedActivity(t);
    return {
      id: `task-${(t as Record<string, unknown> | null)?.id ?? i}`,
      type: "task",
      status: overdue ? "Overdue" : completed ? "Completed" : "Pending",
      severity: overdue ? "bad" : completed ? "good" : "neutral",
      date: activityRowDate(t, ["due_date", "Due_Date", "closingdate"]),
    };
  });
  const callRows: ActivityTableRow[] = calls.items.map((c, i) => {
    const missed = isMissedCall(c);
    const completed = isCompletedActivity(c);
    return {
      id: `call-${(c as Record<string, unknown> | null)?.id ?? i}`,
      type: "call",
      status: missed ? "Missed" : completed ? "Completed" : "Scheduled",
      severity: missed ? "bad" : completed ? "good" : "neutral",
      date: activityRowDate(c, ["call_start_time", "Call_Start_Time", "created_time", "Created_Time"]),
    };
  });
  const emailRows: ActivityTableRow[] = emails.items.map((e, i) => {
    const sent = isCompletedActivity(e);
    return {
      id: `email-${(e as Record<string, unknown> | null)?.id ?? i}`,
      type: "email",
      status: sent ? "Sent" : "Pending",
      severity: sent ? "good" : "neutral",
      date: activityRowDate(e, ["sent_time", "Sent_Time", "created_time", "Created_Time", "Modified_Time"]),
    };
  });
  return [...taskRows, ...callRows, ...emailRows].sort((a, b) => {
    const ad = a.date ? new Date(a.date).getTime() : -Infinity;
    const bd = b.date ? new Date(b.date).getTime() : -Infinity;
    return bd - ad; // most recent first
  });
}

// ─── Schedules drill-down ───────────────────────────────────────────────────────
// Zoho's MCP catalogue has no dedicated schedule-listing tool at all (see the
// old isScheduleTool, permanently false) - but Scheduled Functions in Zoho
// CRM are just regular Deluge functions with category=="Schedule", and
// useFunctionRecords below already fetches every function (all categories)
// eagerly on load. So "Schedules" isn't its own fetch - it's simply that
// list filtered by category, confirmed live against a real org via
// getFunctions (787 functions, 12 of them category=="Schedule"). getFunctions
// never returns last-run/next-run/frequency for any function - "frequency"
// below is a best-effort guess from the schedule's own name text, always
// labeled as such, never presented as confirmed API data.
interface ScheduleBreakdownRow { id: string; name: string; active: boolean; frequency: string; duplicate: boolean; }

// Word-token matched, not a raw substring test - a substring check for "min"
// would also match "min" inside "Admin" (verified: "Admin Test user Create"
// and "Admin_Get_Pipeline_and_Put_in_zohoanalytics" both contain "admin" and
// would false-positive as "Interval" under a naive .includes("min") check,
// even though neither has anything to do with interval scheduling).
function deriveScheduleFrequency(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("daily") || lower.includes("every_day")) return "Daily";
  if (lower.includes("weekly")) return "Weekly";
  if (lower.includes("monthly")) return "Monthly";
  const tokens = lower.split(/[^a-z0-9]+/);
  const hasIntervalToken = ["min", "mins", "minute", "minutes", "hour", "hours", "hourly"].some(t => tokens.includes(t));
  if (hasIntervalToken || lower.includes("every_")) return "Interval";
  return "N/A (not exposed by API)";
}

function computeScheduleBreakdown(functionItems: FunctionItem[]): ScheduleBreakdownRow[] {
  const scheduleFns = functionItems.filter(f => f.category === "Schedule");
  const nameCounts = new Map<string, number>();
  for (const f of scheduleFns) {
    const key = f.name.trim().toLowerCase();
    if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  return scheduleFns
    .map(f => ({
      id: f.id, name: f.name, active: f.active,
      frequency: deriveScheduleFrequency(f.name),
      duplicate: (nameCounts.get(f.name.trim().toLowerCase()) ?? 0) > 1,
    }))
    .sort((a, b) => Number(a.active) - Number(b.active));
}

// Same "same display name reused elsewhere" signal as duplicateRuleGroups
// above, but written directly against ScheduleBreakdownRow instead of being
// forced through RuleRow's module-grouping shape - a schedule has no module
// to group by, so reporting "(Unknown, Unknown)" the way the rule cards do
// would be noise rather than signal here.
function scheduleDuplicateGroups(rows: ScheduleBreakdownRow[]): { name: string; count: number }[] {
  const byKey = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key) continue;
    const g = byKey.get(key);
    if (g) g.count += 1;
    else byKey.set(key, { name: r.name, count: 1 });
  }
  return [...byKey.values()].filter(g => g.count > 1);
}

function scheduleNameExamples(rows: ScheduleBreakdownRow[], limit = 3): string {
  const shown = rows.slice(0, limit).map(r => r.name).join(", ");
  return rows.length > limit ? `e.g. ${shown}, etc.` : `e.g. ${shown}.`;
}

// Always returns real points (never a bare "all clear" summary) - the
// never-triggered/trigger-history line is a fixed, always-true explanation
// (getFunctions exposes no last-run/next-run/frequency field for any
// function, so trigger history can never be confirmed here, healthy org or
// not), not something conditional on this org's data the way inactive/
// duplicate counts are.
function buildZiaScheduleInsight(rows: ScheduleBreakdownRow[]): ZiaInsight {
  if (rows.length === 0) return { summary: "No Schedule-category functions found - nothing to evaluate yet.", points: [] };
  const inactive = rows.filter(r => !r.active);
  const dupGroups = scheduleDuplicateGroups(rows);
  const points: string[] = [
    cap(`Never Triggered can't be confirmed for any schedule here - the Functions API exposes no last-run, next-run, or frequency field, so trigger/execution history is simply not available, not "never fired."`),
    cap(`Frequency shown per schedule is a best-effort guess from the name text (e.g. "monthly", "every_30_min") - not real API data, since Zoho doesn't expose it. Anything without a naming hint reads as N/A rather than a guessed cadence.`),
  ];
  if (inactive.length > 0) {
    points.push(cap(`${inactive.length} of ${rows.length} schedule${rows.length !== 1 ? "s are" : " is"} inactive - remove or clean these up if they're no longer needed: ${scheduleNameExamples(inactive)}`));
  }
  if (dupGroups.length > 0) {
    points.push(cap(`${dupGroups.length} schedule name${dupGroups.length !== 1 ? "s are" : " is"} reused by more than one function - a duplicate/generic name doesn't fit a schedule, since nobody can tell which job actually ran from the name alone: ${dupGroups.slice(0, 3).map(g => `"${g.name}" (${g.count}x)`).join(", ")}${dupGroups.length > 3 ? ", etc." : "."}`));
  }
  if (inactive.length === 0 && dupGroups.length === 0) {
    points.push(cap(`All ${rows.length} schedule${rows.length !== 1 ? "s are" : " is"} active with unique names.`));
  }
  return {
    summary: "", points,
    action: (inactive.length > 0 || dupGroups.length > 0)
      ? "Delete or reactivate the inactive ones, and rename the duplicates so each schedule is unambiguous."
      : undefined,
  };
}

// ─── Functions: list, duplicates, active/inactive, code fetch + analysis ──────
// Verified against a live org via ZohoCRM_getFunctions/getFunctionCode: the
// modern Functions API has no module scoping (only "category": Standalone /
// Button / Automation / etc.) and exposes a flat "state" field for active/
// inactive - a different, more reliable shape than the older workflow-linked
// "associated" concept FunctionAudit.tsx uses. Code is fetched fresh per
// function from the MCP server and held only in React state for the session -
// never persisted to localStorage.

interface FunctionItem {
  id: string;
  apiName: string;
  name: string;
  category: string;
  active: boolean;
  description: string;
}

interface FunctionDuplicateGroup {
  name: string;
  items: { id: string; apiName: string; category: string }[];
}

function getFunctionActive(item: unknown): boolean {
  const r = (item ?? {}) as Record<string, unknown>;
  if (typeof r.active === "boolean") return r.active;
  if (typeof r.enabled === "boolean") return r.enabled;
  const state = String(r.state ?? "").toLowerCase();
  if (!state) return true; // no signal at all - default active, same fallback isActiveWorkflow uses
  return !(state === "inactive" || state === "disabled" || state === "draft" || state === "false");
}

function computeFunctionDuplicates(items: FunctionItem[]): FunctionDuplicateGroup[] {
  const byKey = new Map<string, FunctionDuplicateGroup>();
  for (const it of items) {
    const key = it.name.trim().toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) existing.items.push({ id: it.id, apiName: it.apiName, category: it.category });
    else byKey.set(key, { name: it.name, items: [{ id: it.id, apiName: it.apiName, category: it.category }] });
  }
  return [...byKey.values()].filter(g => g.items.length > 1).sort((a, b) => b.items.length - a.items.length);
}

// Same transparency treatment as the workflow duplicate/overlap badges: the
// matching condition (a case-insensitive display-name match - the only thing
// computeFunctionDuplicates groups on, since Zoho lets two functions share a
// display name even though their underlying api_name is always unique),
// which functions matched, and how many times.
function functionDuplicateTooltip(group: FunctionDuplicateGroup): string {
  const names = group.items.map(it => it.apiName || it.id).join(", ") || "-";
  return `Matched on - Function display name: "${group.name}" (case-insensitive), regardless of API name. ${group.items.length} functions share this name: ${names}. Detected ${group.items.length} times total.`;
}

// A few known code-bearing field names across the tool variants
// resolveDetailTool can match (getFunctionCode/getFunctionScript return raw
// text; getFunctionById/getFunctionDetail on other MCP servers return the
// full function object instead, with the Deluge source nested under one of
// these keys - the same "_code" key Zoho's own create/update function API
// uses) - checked in order, first non-empty match wins.
const CODE_FIELD_NAMES = ["_code", "code", "script", "source_code", "sourceCode", "deluge_code", "function_code", "content"];

// Best-effort recursive search for a Deluge source string inside a parsed
// JSON value - depth-capped since function-object responses only nest a
// couple of levels (e.g. { functions: [{ _code: "..." }] }), not to protect
// against a pathological payload.
function findCodeField(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCodeField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  for (const key of CODE_FIELD_NAMES) {
    const v = r[key];
    // A real Deluge script is a decent chunk of text containing at least one
    // of the syntax characters every function has - guards against a field
    // that just happens to share a name (e.g. an API error "code" string
    // like "INVALID_MODULE") being mistaken for the function's source.
    if (typeof v === "string" && v.trim().length > 20 && /[;{(]/.test(v)) return v;
  }
  for (const v of Object.values(r)) {
    if (v && typeof v === "object") {
      const found = findCodeField(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// getFunctionCode's response is the raw Deluge/runtime source text itself
// (confirmed via a live call), not a JSON envelope like the other entity
// fetches - so this reads structuredContent.data.text / content[0].text
// first. Other tool names resolveDetailTool can match (getFunctionById,
// getFunctionDetail) return a structured function object instead, so this
// falls back to searching that object for a "_code"/"code"/"script" field
// when the plain-text shape isn't there.
function extractFunctionCode(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const r = output as Record<string, unknown>;
  const structured = r.structuredContent as Record<string, unknown> | undefined;
  const data = structured?.data as Record<string, unknown> | undefined;
  if (typeof data?.text === "string" && data.text.trim()) return data.text;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        // Some servers wrap the structured function object - or an unrelated
        // error payload - as a JSON string inside content[].text rather than
        // returning real code as plain text. Only fall back to treating the
        // raw text itself as the code when it *isn't* JSON at all - a JSON
        // blob with no code field inside (e.g. an API error response) must
        // never be handed to the analyzer as if it were the function's
        // source.
        let isJson = true;
        try {
          const parsed = JSON.parse(item.text);
          const found = findCodeField(parsed);
          if (found) return found;
        } catch { isJson = false; }
        if (!isJson) return item.text;
      }
    }
  }
  if (data) {
    const found = findCodeField(data);
    if (found) return found;
  }
  return findCodeField(r);
}

const FUNCTION_CODE_TOOL_PATTERNS = [/getfunctioncode$/i, /getfunctionscript$/i, /getfunctionbyid$/i, /getfunctiondetail/i];
const FUNCTION_CODE_SCAN_CAP = 100;

const RAW_RESPONSE_PREVIEW_LEN = 500;

// A function whose Deluge source couldn't be pulled back (a failed/errored
// call, or a response shape extractFunctionCode couldn't parse) must still
// show up in the Issues tab - not silently disappear, which looks identical
// to "this function has no issues" and hides the fact it was never actually
// checked at all. rawOutput (when the call succeeded but extraction still
// failed) is echoed straight into the issue message, truncated, so the raw
// shape is visible right in the Issues tab instead of requiring a trip to
// Audit Logs to diagnose.
function codeUnavailableIssue(reason?: string, rawOutput?: unknown): FunctionIssue[] {
  let preview = "";
  if (rawOutput !== undefined) {
    try {
      const json = JSON.stringify(rawOutput);
      preview = json.length > RAW_RESPONSE_PREVIEW_LEN ? `${json.slice(0, RAW_RESPONSE_PREVIEW_LEN)}…` : json;
    } catch { /* unstringifiable - skip the preview */ }
  }
  const base = reason
    ? `This function's code couldn't be checked for issues - the fetch failed (${reason}).`
    : `This function's code couldn't be checked for issues - the connected MCP server didn't return a usable source.`;
  return [{
    category: "scan-error", severity: "low",
    message: preview ? `${base} Raw response: ${preview}` : `${base} Open it and click "Preview Code" to retry, or verify the code-fetch tool has access to this function.`,
  }];
}

interface FunctionCodeState { code: string | null; loading: boolean; unavailable: boolean; }

function useFunctionRecords(config: McpConfig | null, tools: McpTool[], scanActive: boolean, onLog: (log: ExecutionLog) => void) {
  const [items, setItems] = useState<FunctionItem[]>([]);
  const [listState, setListState] = useState<{ loading: boolean; fetched: boolean; unavailable: boolean; hasMore: boolean }>({ loading: false, fetched: false, unavailable: false, hasMore: false });
  const [failureCount, setFailureCount] = useState<number | null>(null);
  const [codeByFnId, setCodeByFnId] = useState<Record<string, FunctionCodeState>>({});
  const [issuesByFnId, setIssuesByFnId] = useState<Record<string, FunctionIssue[]>>({});
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; loading: boolean }>({ done: 0, total: 0, loading: false });
  const listFetchedRef = useRef(false);
  const scanFetchedRef = useRef(false);
  const wasScanActiveRef = useRef(false);
  const detailToolRef = useRef<McpTool | null | undefined>(undefined);

  // scanFetchedRef used to latch permanently true after the first scan, so a
  // scan that failed (bad tool match, every fetch erroring) stayed broken for
  // the rest of the session - reopening the Functions card did nothing.
  // Resetting it every time the card is closed means the *next* open runs a
  // fresh scan instead of replaying whatever happened the first time.
  useEffect(() => {
    if (!scanActive && wasScanActiveRef.current) scanFetchedRef.current = false;
    wasScanActiveRef.current = scanActive;
  }, [scanActive]);

  // List + failures - eager (bounded to ~1000 functions), same eagerness as
  // the metadata-only fetch this replaces, so duplicate/naming recommendations
  // stay populated without requiring a click.
  useEffect(() => {
    if (listFetchedRef.current) return;
    if (tools.length === 0) return;
    const listTool = tools.find(t => /getfunctions$/i.test(t.name));
    const failuresTool = tools.find(t => /getautomationfunctionfailures$/i.test(t.name));
    if (!listTool && !failuresTool) return;
    listFetchedRef.current = true;

    void (async () => {
      let all: unknown[] = [];
      let hasMore = false;
      if (listTool) {
        setListState(prev => ({ ...prev, loading: true }));
        for (let page = 1; page <= MAX_FUNCTION_PAGES; page++) {
          const start = Date.now();
          const input = { query_params: { page, per_page: 200 } };
          try {
            const output = await executeTool(config as McpConfig, listTool.name, input);
            const pageItems = extractArray(output);
            all = all.concat(pageItems);
            onLog({ id: crypto.randomUUID(), tool: listTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
            hasMore = hasMoreRecords(output);
            if (pageItems.length === 0 || !hasMore) break;
          } catch (e: unknown) {
            onLog({ id: crypto.randomUUID(), tool: listTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
            break;
          }
        }
      }
      const parsed: FunctionItem[] = all.map((f, i) => {
        const r = (f ?? {}) as Record<string, unknown>;
        return {
          id: String(r.id ?? i),
          apiName: String(r.api_name ?? ""),
          name: String(r.name ?? r.api_name ?? `Function ${i + 1}`),
          category: String(r.category ?? "-"),
          active: getFunctionActive(f),
          description: typeof r.description === "string" ? r.description : "",
        };
      });
      setItems(parsed);
      setListState({ loading: false, fetched: true, unavailable: !listTool, hasMore });

      if (failuresTool) {
        const start = Date.now();
        const input = { query_params: { page: 1, per_page: 200 } };
        try {
          const output = await executeTool(config as McpConfig, failuresTool.name, input);
          setFailureCount(extractArray(output).length);
          onLog({ id: crypto.randomUUID(), tool: failuresTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: failuresTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
      }
    })();
  }, [tools, config, onLog]);

  function resolveDetailTool(): McpTool | null {
    if (detailToolRef.current !== undefined) return detailToolRef.current;
    let found: McpTool | null = null;
    for (const pattern of FUNCTION_CODE_TOOL_PATTERNS) {
      found = tools.find(t => pattern.test(t.name)) ?? null;
      if (found) break;
    }
    detailToolRef.current = found;
    if (!found) {
      const candidates = tools.filter(t => /function/i.test(t.name) && !/getfunctions$/i.test(t.name) && !/getautomationfunctionfailures$/i.test(t.name)).map(t => t.name);
      onLog({
        id: crypto.randomUUID(), tool: "function-code-tool-lookup", input: {},
        output: { totalToolsConnected: tools.length, possibleFunctionCodeTools: candidates },
        status: candidates.length > 0 ? "success" : "error",
        errorMessage: candidates.length > 0 ? undefined : "No connected tool looks like a function-code fetch (checked getFunctionCode/getFunctionScript/getFunctionById/getFunctionDetail).",
        durationMs: 0, timestamp: new Date(),
      });
    }
    return found;
  }

  function detailParamLoc(tool: McpTool) {
    return findParam(findParamLocations(tool), /^fxIdentifier$|^functionId$|^id$/i) ?? { group: "path_variables", key: "fxIdentifier" };
  }

  // On-demand single-function code fetch (preview) - downloaded fresh from the
  // MCP server every time it's requested, kept only in this hook's React state.
  async function fetchCode(fnId: string) {
    if (!config || !fnId) return;
    if (codeByFnId[fnId]?.code || codeByFnId[fnId]?.loading) return;
    const tool = resolveDetailTool();
    if (!tool) { setCodeByFnId(prev => ({ ...prev, [fnId]: { code: null, loading: false, unavailable: true } })); return; }

    setCodeByFnId(prev => ({ ...prev, [fnId]: { code: null, loading: true, unavailable: false } }));
    const start = Date.now();
    const input: Record<string, unknown> = {};
    setParam(input, detailParamLoc(tool), fnId);
    try {
      const output = await executeTool(config, tool.name, input);
      const code = extractFunctionCode(output);
      setCodeByFnId(prev => ({ ...prev, [fnId]: { code, loading: false, unavailable: code === null } }));
      // A function with a real error in it must still show up in the Issues
      // tab even when its code couldn't be pulled back - silently dropping it
      // from the list looks identical to "this function is clean," which is
      // the opposite of true.
      setIssuesByFnId(prev => ({ ...prev, [fnId]: code ? analyzeFunctionScript(code) : codeUnavailableIssue(undefined, output) }));
      onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e: unknown) {
      setCodeByFnId(prev => ({ ...prev, [fnId]: { code: null, loading: false, unavailable: true } }));
      setIssuesByFnId(prev => ({ ...prev, [fnId]: codeUnavailableIssue(e instanceof Error ? e.message : undefined) }));
      onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
    }
  }

  // Manual retry: resets the "already scanned" latch and clears prior
  // results, then bumps scanGeneration to re-run the scan effect below
  // immediately, without needing to close and reopen the card.
  const [scanGeneration, setScanGeneration] = useState(0);
  function rescan() {
    scanFetchedRef.current = false;
    setCodeByFnId({});
    setIssuesByFnId({});
    setScanGeneration(g => g + 1);
  }

  // Capped batch scan for the aggregate "% of functions with issues" stat -
  // gated behind scanActive (the Functions KPI being opened) since this is
  // one API call per function and shouldn't fire on every dashboard load.
  useEffect(() => {
    if (!scanActive || scanFetchedRef.current) return;
    if (!listState.fetched || items.length === 0) return;
    const tool = resolveDetailTool();
    if (!tool) return;
    scanFetchedRef.current = true;

    const targets = items.slice(0, FUNCTION_CODE_SCAN_CAP);
    setScanProgress({ done: 0, total: targets.length, loading: true });

    void (async () => {
      for (const fn of targets) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        setParam(input, detailParamLoc(tool), fn.id);
        try {
          const output = await executeTool(config as McpConfig, tool.name, input);
          const code = extractFunctionCode(output);
          if (code) {
            setCodeByFnId(prev => ({ ...prev, [fn.id]: { code, loading: false, unavailable: false } }));
            setIssuesByFnId(prev => ({ ...prev, [fn.id]: analyzeFunctionScript(code) }));
          } else {
            // Same reasoning as fetchCode above - a function that couldn't be
            // pulled back must still surface in Issues, not vanish as if it
            // were clean.
            setCodeByFnId(prev => ({ ...prev, [fn.id]: { code: null, loading: false, unavailable: true } }));
            setIssuesByFnId(prev => ({ ...prev, [fn.id]: codeUnavailableIssue(undefined, output) }));
          }
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: code ? "success" : "error", errorMessage: code ? undefined : "Code fetch returned no usable source for this function", durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          setCodeByFnId(prev => ({ ...prev, [fn.id]: { code: null, loading: false, unavailable: true } }));
          setIssuesByFnId(prev => ({ ...prev, [fn.id]: codeUnavailableIssue(e instanceof Error ? e.message : undefined) }));
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
        setScanProgress(prev => ({ ...prev, done: prev.done + 1 }));
      }
      setScanProgress(prev => ({ ...prev, loading: false }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanActive, listState.fetched, items, config, tools, onLog, scanGeneration]);

  return { items, listState, failureCount, codeByFnId, issuesByFnId, scanProgress, fetchCode, rescan };
}

interface ModuleRuleGroup { apiName: string; items: unknown[]; }

// Same tool-reported-failure detection useRuleCoverage.ts relies on for these
// same tools: Zoho's tool wrapper can report a business-logic failure (e.g. a
// missing/mismatched "module" param) in structuredContent.status/data.status
// while the MCP transport call itself still looks like a success - without
// this, that single error-message text block gets misread as one real rule.
function isRuleFailureResponse(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const sc = (result as Record<string, unknown>).structuredContent as Record<string, unknown> | undefined;
  if (!sc) return false;
  const dataStatus = (sc.data as Record<string, unknown> | undefined)?.status;
  return sc.status === "failure" || dataStatus === "failure";
}

// Defends against a tool that accepts the module filter argument but doesn't
// actually apply it server-side (returns every module's rules regardless of
// what was asked for) - same cross-check useRuleCoverage.ts uses. An item
// with no discoverable module reference at all is trusted as-is.
function extractRuleItems(result: unknown, apiName: string): unknown[] {
  if (isRuleFailureResponse(result)) return [];
  const parsed = parseMcpJson(result);
  if (!parsed) return [];
  let items: unknown[] = [];
  for (const v of Object.values(parsed)) {
    if (Array.isArray(v)) { items = v; break; }
  }
  return items.filter(item => {
    const label = workflowModuleLabel(item);
    return label === "" || label.toLowerCase() === apiName.toLowerCase();
  });
}

// A stable identity for a set of rule items - sorted so item order in the
// response can't hide a real match, falling back to the full JSON of an item
// with no id/name at all rather than dropping it silently.
function fingerprintRuleItems(items: unknown[]): string {
  return items
    .map(it => {
      const r = (it ?? {}) as Record<string, unknown>;
      return String(r.id ?? r.rule_id ?? r.name ?? JSON.stringify(r));
    })
    .sort()
    .join("|");
}

// Per-module config-rule scan (Layout Rules / Validation Rules) - both are
// genuinely per-module Zoho endpoints with no "all modules" mode, so this
// runs one call per usable module (resolveUsableModuleApiNames - every real,
// non-deleted/internal/system-hidden module in the org, not just the core
// lifecycle 4), gated behind scanActive (the card being open) exactly like
// useFunctionRecords' per-function code scan above - this can be 100+ calls
// and must not fire on every connect.
//
// useRuleCoverage.ts already fetches these same tools per-module, but only
// for the 4 core lifecycle modules and keeping only aggregate stats (for the
// Health Score's Automation Coverage dimension) - deliberately not reused
// here to avoid any risk to that score; isRuleFailureResponse/
// extractRuleItems/fingerprintRuleItems above are a small, intentional
// duplication of its same proven logic (see the implementation plan).
function useModuleRuleScan(
  config: McpConfig | null,
  tools: McpTool[],
  moduleItems: unknown[],
  toolNamePattern: RegExp,
  scanActive: boolean,
  onLog: (log: ExecutionLog) => void,
) {
  const [perModule, setPerModule] = useState<ModuleRuleGroup[]>([]);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; loading: boolean }>({ done: 0, total: 0, loading: false });
  const [scanned, setScanned] = useState(false);
  const scanFetchedRef = useRef(false);
  const wasScanActiveRef = useRef(false);
  const [scanGeneration, setScanGeneration] = useState(0);

  // Same reset-on-close-then-reopen behavior as useFunctionRecords' scan - a
  // scan that failed (bad tool match, every call erroring) shouldn't stay
  // broken for the rest of the session; reopening the card retries fresh.
  useEffect(() => {
    if (!scanActive && wasScanActiveRef.current) scanFetchedRef.current = false;
    wasScanActiveRef.current = scanActive;
  }, [scanActive]);

  useEffect(() => {
    if (!scanActive || scanFetchedRef.current) return;
    if (moduleItems.length === 0) return;
    const foundTool = tools.find(t => toolNamePattern.test(t.name));
    if (!foundTool) return;
    const foundModuleLoc = findParam(findParamLocations(foundTool), /module/i);
    if (!foundModuleLoc) return;
    // Re-bound to non-optional consts - TS doesn't carry the narrowing from
    // the guards above into the nested `worker` function declaration below.
    const tool = foundTool;
    const moduleLoc = foundModuleLoc;
    scanFetchedRef.current = true;

    const targets = resolveUsableModuleApiNames(moduleItems);
    setScanProgress({ done: 0, total: targets.length, loading: true });
    setPerModule([]);
    setScanned(false);

    // Fetched with bounded concurrency (a small worker pool) instead of one
    // module at a time - a sequential await-in-a-loop over 100+ modules made
    // Layout/Validation Rules visibly lag many seconds behind Assignment/
    // Approval Rules (a single org-wide call each) even though all four now
    // auto-start together, since Zoho's API has no "all modules" mode for
    // these two. Order-independent (results are written by index, not
    // push order), so this doesn't change what's fetched, only how fast.
    const RULE_SCAN_CONCURRENCY = 8;
    void (async () => {
      const results: ModuleRuleGroup[] = new Array(targets.length);
      let nextIndex = 0;
      async function worker() {
        for (;;) {
          const i = nextIndex++;
          if (i >= targets.length) return;
          const apiName = targets[i];
          const start = Date.now();
          const input: Record<string, unknown> = {};
          setParam(input, moduleLoc, apiName);
          try {
            const output = await executeTool(config as McpConfig, tool.name, input);
            const failed = isRuleFailureResponse(output);
            const items = failed ? [] : extractRuleItems(output, apiName).filter(item => !isSystemGeneratedRule(item));
            results[i] = { apiName, items };
            onLog(failed
              ? { id: crypto.randomUUID(), tool: tool.name, input, output, status: "error", errorMessage: "Tool reported failure", durationMs: Date.now() - start, timestamp: new Date() }
              : { id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          } catch (e: unknown) {
            results[i] = { apiName, items: [] };
            onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          }
          setScanProgress(prev => ({ ...prev, done: prev.done + 1 }));
        }
      }
      await Promise.all(Array.from({ length: Math.min(RULE_SCAN_CONCURRENCY, targets.length) }, worker));

      // Same "module filter isn't really being applied server-side" guard as
      // useRuleCoverage.ts: if 2+ modules came back with a non-empty result
      // that's byte-for-byte identical, trust none of them rather than report
      // numbers we now have concrete reason to distrust across the board.
      const nonEmpty = results.filter(r => r.items.length > 0);
      const fingerprints = nonEmpty.map(r => fingerprintRuleItems(r.items));
      const filterLooksBroken = nonEmpty.length >= 2 && fingerprints.every(f => f === fingerprints[0]);

      setPerModule(filterLooksBroken ? results.map(r => ({ apiName: r.apiName, items: [] })) : results);
      setScanProgress(prev => ({ ...prev, loading: false }));
      setScanned(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanActive, moduleItems, config, tools, onLog, scanGeneration]);

  function rescan() {
    scanFetchedRef.current = false;
    setScanGeneration(g => g + 1);
  }

  return { perModule, scanProgress, scanned, rescan };
}

// Generic counterpart to namedExamples above (which is typed to
// WorkflowBreakdownRow specifically) - same "name a few real ones instead of
// just a bare count" convention, for the raw rule/process items these four
// builders work with instead.
function namedItemExamples(items: unknown[], limit = 3): string {
  const shown = items.slice(0, limit).map((it, i) => getItemName(it, i)).join(", ");
  return items.length > limit ? `e.g. ${shown}, etc.` : `e.g. ${shown}.`;
}

// A flattened, uniform shape for one rule/process, shared by all four rule
// types' drilldown tables and duplicate-name detection below - Layout/
// Validation Rules arrive grouped one API call per module (see
// useModuleRuleScan) with no module field on the item itself, while
// Assignment/Approval Rules arrive as one flat list with the module nested
// on each item, so each type needs its own conversion into this common shape.
interface RuleRow { item: unknown; name: string; module: string; active: boolean; }

function itemsToRuleRows(items: unknown[]): RuleRow[] {
  return items.map((item, idx) => ({ item, name: getItemName(item, idx), module: workflowModuleLabel(item), active: isActiveWorkflow(item) }));
}

function moduleGroupsToRuleRows(perModule: ModuleRuleGroup[]): RuleRow[] {
  return perModule.flatMap(m => m.items.map((item, idx) => ({ item, name: getItemName(item, idx), module: m.apiName, active: isActiveWorkflow(item) })));
}

// Same "same display name reused elsewhere" signal Workflows already flags
// (see computeWorkflowDuplicateGroups above) - shared here across the four
// rule types instead of four near-identical copies. Case-insensitive and
// org-wide rather than scoped to one module: the earlier full-org rules
// audit found layout rules literally named "HIDE"/"Hide"/"hide" reused
// across three unrelated modules, which is exactly this kind of duplicate -
// scoping to "within the same module only" would have missed it entirely.
function duplicateRuleGroups(rows: RuleRow[]): { name: string; modules: string[] }[] {
  const byKey = new Map<string, { name: string; modules: string[] }>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key) continue;
    const g = byKey.get(key);
    if (g) g.modules.push(r.module || "Unknown");
    else byKey.set(key, { name: r.name, modules: [r.module || "Unknown"] });
  }
  return [...byKey.values()].filter(g => g.modules.length > 1);
}

function duplicateRuleNameSet(groups: { name: string }[]): Set<string> {
  return new Set(groups.map(g => g.name.trim().toLowerCase()));
}

function duplicateGroupExamples(groups: { name: string; modules: string[] }[], limit = 3): string {
  const shown = groups.slice(0, limit).map(g => `"${g.name}" (${g.modules.join(", ")})`).join("; ");
  return groups.length > limit ? `e.g. ${shown}, etc.` : `${shown}.`;
}

function buildZiaLayoutRuleInsight(perModule: ModuleRuleGroup[], scanned: boolean): ZiaInsight {
  if (!scanned) return { summary: "Layout rules haven't finished scanning yet.", points: [] };
  const all = perModule.flatMap(m => m.items);
  if (all.length === 0) return { summary: "No custom layout rules found across the modules scanned.", points: [] };
  const inactive = all.filter(i => !isActiveWorkflow(i));
  const allInactiveModules = perModule.filter(m => m.items.length > 0 && m.items.every(i => !isActiveWorkflow(i)));
  const dupGroups = duplicateRuleGroups(moduleGroupsToRuleRows(perModule));
  const points: string[] = [];
  if (inactive.length > 0) points.push(cap(`${inactive.length} of ${all.length} layout rule${all.length !== 1 ? "s are" : " is"} inactive.`));
  if (allInactiveModules.length > 0) points.push(cap(`${allInactiveModules.length} module${allInactiveModules.length !== 1 ? "s have" : " has"} layout rules configured but none currently active - ${allInactiveModules.slice(0, 3).map(m => m.apiName).join(", ")}${allInactiveModules.length > 3 ? ", etc." : "."}`));
  if (dupGroups.length > 0) points.push(cap(`${dupGroups.length} rule name${dupGroups.length !== 1 ? "s are" : " is"} reused across more than one module - ${duplicateGroupExamples(dupGroups)}`));
  if (points.length === 0) return { summary: `All ${all.length} layout rule${all.length !== 1 ? "s are" : " is"} active across ${perModule.filter(m => m.items.length > 0).length} module${perModule.filter(m => m.items.length > 0).length !== 1 ? "s" : ""} with no duplicate names - looks healthy.`, points: [] };
  return { summary: "", points, action: "Reactivate the ones still needed, rename or delete the duplicates, and clear out the rest so layout behavior stays easy to audit." };
}

function buildZiaValidationRuleInsight(perModule: ModuleRuleGroup[], scanned: boolean): ZiaInsight {
  if (!scanned) return { summary: "Validation rules haven't finished scanning yet.", points: [] };
  const all = perModule.flatMap(m => m.items);
  if (all.length === 0) return { summary: "No custom validation rules found across the modules scanned - nothing is enforcing data quality at the field level.", points: [] };
  const inactive = all.filter(i => !isActiveWorkflow(i));
  const allInactiveModules = perModule.filter(m => m.items.length > 0 && m.items.every(i => !isActiveWorkflow(i)));
  const dupGroups = duplicateRuleGroups(moduleGroupsToRuleRows(perModule));
  const points: string[] = [];
  if (inactive.length > 0) points.push(cap(`${inactive.length} of ${all.length} validation rule${all.length !== 1 ? "s are" : " is"} inactive - data can save without whatever check that rule was meant to enforce.`));
  if (allInactiveModules.length > 0) points.push(cap(`${allInactiveModules.length} module${allInactiveModules.length !== 1 ? "s have" : " has"} validation rules configured but none currently active - ${allInactiveModules.slice(0, 3).map(m => m.apiName).join(", ")}${allInactiveModules.length > 3 ? ", etc." : "."}`));
  if (dupGroups.length > 0) points.push(cap(`${dupGroups.length} rule name${dupGroups.length !== 1 ? "s are" : " is"} reused across more than one module - ${duplicateGroupExamples(dupGroups)}`));
  if (points.length === 0) return { summary: `All ${all.length} validation rule${all.length !== 1 ? "s are" : " is"} active across ${perModule.filter(m => m.items.length > 0).length} module${perModule.filter(m => m.items.length > 0).length !== 1 ? "s" : ""} with no duplicate names - data quality enforcement looks healthy.`, points: [] };
  return { summary: "", points, action: "Reactivate the ones still needed, rename or delete the duplicates, and clear out the rest so a passing record actually means what the rule implies." };
}

// Assignment rules carry no active/enabled flag at all on any known Zoho MCP
// server response - unlike every other rule type here, so this deliberately
// never frames them as "active/inactive" (that would just be reporting
// isActiveWorkflow's default-true fallback as if it were real data). Instead
// this flags coverage, same-module concentration, and duplicate names, which
// the raw list can actually support.
function buildZiaAssignmentRuleInsight(items: unknown[]): ZiaInsight {
  if (items.length === 0) return { summary: "No custom assignment rules found - new records rely on default/manual owner assignment everywhere.", points: [] };
  const rows = itemsToRuleRows(items);
  const byModule = new Map<string, unknown[]>();
  items.forEach((item, i) => {
    const mod = workflowModuleLabel(item) || "Unknown";
    byModule.set(mod, [...(byModule.get(mod) ?? []), item]);
    void i;
  });
  const crowded = [...byModule.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
  const dupGroups = duplicateRuleGroups(rows);
  const points: string[] = [];
  points.push(cap(`${items.length} assignment rule${items.length !== 1 ? "s span" : " spans"} ${byModule.size} module${byModule.size !== 1 ? "s" : ""} - ${[...byModule.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3).map(([m, v]) => `${m} (${v.length})`).join(", ")}${byModule.size > 3 ? ", etc." : "."}`));
  if (dupGroups.length > 0) points.push(cap(`${dupGroups.length} rule name${dupGroups.length !== 1 ? "s are" : " is"} reused across more than one module - ${duplicateGroupExamples(dupGroups)}`));
  if (crowded.length > 0) points.push(cap(`${crowded.map(([m]) => m).join(", ")} ${crowded.length !== 1 ? "each carry" : "carries"} 3+ assignment rules - worth confirming their criteria don't overlap, since only the first matching rule assigns the record.`));
  return { summary: "", points, action: (crowded.length > 0 || dupGroups.length > 0) ? "Rename or delete the duplicates, and review the crowded modules' rule order and criteria for real conflicts." : undefined };
}

function buildZiaApprovalRuleInsight(items: unknown[]): ZiaInsight {
  if (items.length === 0) return { summary: "No custom approval processes found - records save without an approval step anywhere in the org.", points: [] };
  const inactive = items.filter(i => !isActiveWorkflow(i));
  const emptyRules = items.filter(i => Number((i as Record<string, unknown> | null)?.rules_count ?? 0) === 0);
  const dupGroups = duplicateRuleGroups(itemsToRuleRows(items));
  const points: string[] = [];
  if (inactive.length > 0) points.push(cap(`${inactive.length} of ${items.length} approval process${items.length !== 1 ? "es are" : " is"} inactive - configured but not currently enforcing anything: ${namedItemExamples(inactive)}`));
  if (emptyRules.length > 0) points.push(cap(`${emptyRules.length} approval process${emptyRules.length !== 1 ? "es have" : " has"} zero rules configured, so it can never actually trigger: ${namedItemExamples(emptyRules)}`));
  if (dupGroups.length > 0) points.push(cap(`${dupGroups.length} process name${dupGroups.length !== 1 ? "s are" : " is"} reused across more than one module - ${duplicateGroupExamples(dupGroups)}`));
  if (points.length === 0) return { summary: `All ${items.length} approval process${items.length !== 1 ? "es are" : " is"} active with at least one rule and no duplicate names - approval enforcement looks healthy.`, points: [] };
  return { summary: "", points, action: "Reactivate the ones still needed, rename or delete the duplicates, and clear out the rest so the approval trail stays trustworthy." };
}

interface WorkflowDetailState { criteria: unknown; actions: unknown; unavailable: boolean; }
const WORKFLOW_DETAIL_SCAN_CAP = 100;

// getWorkflowRuleById's response wraps the single workflow the same way the
// list endpoint wraps many - a workflow_rules/workflows array, or (some MCP
// server versions) the bare object itself.
function extractSingleWorkflowDetail(parsed: Record<string, unknown> | null): { criteria: unknown; actions: unknown } | null {
  if (!parsed) return null;
  const rules = parsed.workflow_rules ?? parsed.workflows;
  const single = Array.isArray(rules) && rules.length > 0
    ? (rules[0] as Record<string, unknown>)
    : (parsed.id || parsed.name ? parsed : null);
  if (!single) return null;
  return {
    criteria: single.criteria ?? single.conditions ?? null,
    actions: single.actions ?? single.action_list ?? single.workflow_actions ?? null,
  };
}

// getWorkflowRules (the list call feeding entityData.workflows) never
// returns criteria or actions at all - verified against a live response.
// Two workflows sharing nothing but module+trigger (e.g. five different
// Deals automations all on "create or edit") looked identical purely
// because there was no criteria/actions data to tell them apart, not
// because they actually were duplicates. This fetches each workflow's real
// criteria/actions via getWorkflowRuleById before any duplicate/overlap
// match is trusted - same capped-batch-scan-behind-the-card-opening pattern
// as useFunctionRecords' code scan above, including a manual rescan.
function useWorkflowDetails(config: McpConfig | null, tools: McpTool[], items: unknown[], active: boolean, onLog: (log: ExecutionLog) => void) {
  const [detailByWfId, setDetailByWfId] = useState<Record<string, WorkflowDetailState>>({});
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; loading: boolean }>({ done: 0, total: 0, loading: false });
  const scanFetchedRef = useRef(false);
  const wasActiveRef = useRef(false);
  const [scanGeneration, setScanGeneration] = useState(0);

  useEffect(() => {
    if (!active && wasActiveRef.current) scanFetchedRef.current = false;
    wasActiveRef.current = active;
  }, [active]);

  function rescan() {
    scanFetchedRef.current = false;
    setDetailByWfId({});
    setScanGeneration(g => g + 1);
  }

  useEffect(() => {
    if (!active || scanFetchedRef.current) return;
    if (!config || items.length === 0) return;
    const tool = tools.find(t => /getworkflowrulebyid$/i.test(t.name));
    if (!tool) return;
    scanFetchedRef.current = true;

    // "id" is documented as a path parameter, not necessarily a flat body
    // key - resolved dynamically from the tool's own schema (same approach
    // the Functions card uses for its fxIdentifier/functionId/id lookup)
    // rather than hardcoding a flat { id } that silently fails if the real
    // server expects it nested under path_variables.
    const idLoc = findParam(findParamLocations(tool), /^id$|^workflowRuleId$|^ruleId$/i) ?? { group: "path_variables", key: "id" };

    const targets = items.slice(0, WORKFLOW_DETAIL_SCAN_CAP);
    setScanProgress({ done: 0, total: targets.length, loading: true });

    void (async () => {
      for (const item of targets) {
        const id = String((item as Record<string, unknown> | null)?.id ?? "");
        if (!id) { setScanProgress(prev => ({ ...prev, done: prev.done + 1 })); continue; }
        const start = Date.now();
        const input: Record<string, unknown> = {};
        setParam(input, idLoc, id);
        try {
          const output = await executeTool(config, tool.name, input);
          const parsed = parseMcpJson(output);
          const detail = extractSingleWorkflowDetail(parsed);
          setDetailByWfId(prev => ({ ...prev, [id]: { criteria: detail?.criteria ?? null, actions: detail?.actions ?? null, unavailable: !detail } }));
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: detail ? "success" : "error", errorMessage: detail ? undefined : "No workflow detail returned", durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          setDetailByWfId(prev => ({ ...prev, [id]: { criteria: null, actions: null, unavailable: true } }));
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
        setScanProgress(prev => ({ ...prev, done: prev.done + 1 }));
      }
      setScanProgress(prev => ({ ...prev, loading: false }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items, config, tools, onLog, scanGeneration]);

  return { detailByWfId, scanProgress, rescan };
}

// Overlays each workflow's real fetched criteria/actions (once available)
// onto the raw list item, so downstream duplicate/overlap matching sees the
// actual configuration instead of the list endpoint's incomplete shape.
function enrichWorkflowsWithDetail(items: unknown[], detailByWfId: Record<string, WorkflowDetailState>): unknown[] {
  return items.map(item => {
    const r = (item ?? {}) as Record<string, unknown>;
    const detail = detailByWfId[String(r.id ?? "")];
    if (!detail || detail.unavailable) return item;
    return { ...r, criteria: detail.criteria ?? r.criteria, actions: detail.actions ?? r.actions };
  });
}

interface FunctionIssueRow { key: string; id: string; functionName: string; category: string; issue: FunctionIssue; }
const FUNCTION_SEVERITY_ORDER: Record<FunctionIssue["severity"], number> = { high: 0, medium: 1, low: 2 };

// One row per FUNCTION instead of one row per issue - a function with 4
// flagged issues used to repeat its name across 4 separate rows in the
// list, burying how many distinct functions actually need attention behind
// how many issues they happen to have. Sorted by worst issue severity first,
// same convention sortedFunctionIssueRows already used per-issue.
interface FunctionIssueGroup { id: string; functionName: string; moduleCategory: string; issues: FunctionIssue[]; worstSeverity: FunctionIssue["severity"]; }

function groupFunctionIssuesByFunction(rows: FunctionIssueRow[]): FunctionIssueGroup[] {
  const byId = new Map<string, FunctionIssueGroup>();
  for (const row of rows) {
    const g = byId.get(row.id);
    if (g) {
      g.issues.push(row.issue);
      if (FUNCTION_SEVERITY_ORDER[row.issue.severity] < FUNCTION_SEVERITY_ORDER[g.worstSeverity]) g.worstSeverity = row.issue.severity;
    } else {
      byId.set(row.id, { id: row.id, functionName: row.functionName, moduleCategory: row.category, issues: [row.issue], worstSeverity: row.issue.severity });
    }
  }
  return [...byId.values()].sort((a, b) => FUNCTION_SEVERITY_ORDER[a.worstSeverity] - FUNCTION_SEVERITY_ORDER[b.worstSeverity]);
}

const FUNCTION_ISSUES_PAGE_SIZE = 8;

function buildFunctionZiaSummary(
  functionsWithIssuesPct: number, scannedCount: number, duplicates: FunctionDuplicateGroup[],
  suspiciousCount: number, failureCount: number | null,
): ZiaInsight {
  if (scannedCount === 0) return { summary: "Open this card to scan function code for issues - nothing analyzed yet.", points: [] };
  const points: string[] = [];
  if (functionsWithIssuesPct > 0) {
    points.push(cap(`${functionsWithIssuesPct}% of the ${scannedCount} functions scanned have at least one flagged issue - mostly missing error handling and API calls made inside loops.`));
  }
  if (duplicates.length > 0) {
    const dupItemCount = duplicates.reduce((s, g) => s + g.items.length, 0);
    points.push(cap(`${duplicates.length} function name${duplicates.length !== 1 ? "s are" : " is"} duplicated across ${dupItemCount} functions total - rename or delete the unused copies so workflows/buttons unambiguously call the right one.`));
  }
  if (suspiciousCount > 0) {
    points.push(cap(`${suspiciousCount} function${suspiciousCount !== 1 ? "s" : ""} still carr${suspiciousCount !== 1 ? "y" : "ies"} a placeholder/test name.`));
  }
  if (failureCount) {
    points.push(cap(`${failureCount} recent execution failure${failureCount !== 1 ? "s" : ""} logged.`));
  }
  if (points.length === 0) return { summary: "No issues, duplicates, or placeholder names found in the functions scanned - code quality looks solid.", points: [] };
  return { summary: "", points };
}

interface FunctionKpiSummary { total: number; active: number; inactive: number; fetched: boolean; }
interface ScheduleKpiSummary { total: number; active: number; fetched: boolean; }

// "Total CRM Items"/"total items across N sources" sums every entity's raw
// item count - except modules, where the raw count includes Zoho's internal
// pseudo-modules (a "module" record auto-generated per file-upload field,
// subforms, etc. - see isInternalModule) and deleted ones. Applying the same
// exclusion the Modules KPI card uses keeps this total from disagreeing with
// that card over what "how many modules" even means.
function entityItemCount(type: CrmEntityType, items: unknown[]): number {
  if (type !== "modules") return items.length;
  return items.filter(m => !isDeletedModule(m) && !isInternalModule(m) && !isSystemHiddenModule(m)).length;
}

// Source attribution shown on hover - names the tool the count came from and
// how many records it actually saw, so every number on the tile traces back
// to a real fetch instead of being taken on faith.
function kpiSource(state: EntityState, count: number): string {
  return state.toolUsed ? `Source: ${state.toolUsed} - ${count} record${count !== 1 ? "s" : ""}` : "Source: no matching tool found for this data";
}

function computeKpis(entityData: Record<CrmEntityType, EntityState>, functionSummary: FunctionKpiSummary, scheduleSummary: ScheduleKpiSummary): KpiItem[] {
  const modules = entityData.modules.items.filter(m => !isDeletedModule(m) && !isInternalModule(m) && !isSystemHiddenModule(m));
  const blueprints = entityData.blueprints.items;
  const users = entityData.users.items;

  // A fetch that failed before returning any pages leaves items at [] - the
  // same shape as a genuinely empty org. Treating both alike would render a
  // false "0 found, all good" tile instead of an honest "couldn't verify"
  // one, so each entity's real error must gate its tile's severity/note.
  const modulesFailed = entityData.modules.error !== null && modules.length === 0;
  const blueprintsFailed = entityData.blueprints.error !== null && blueprints.length === 0;
  const usersFailed = entityData.users.error !== null && users.length === 0;

  const hiddenCount = modules.filter(isHiddenModule).length;
  const hiddenPct = modules.length ? Math.round((hiddenCount / modules.length) * 100) : 0;
  const activePct = modules.length ? 100 - hiddenPct : 0;
  // Blueprint status is a flat Active/Inactive/Draft string, not the nested
  // workflow shape - blueprintStatus keeps Draft from silently counting as
  // active the way isActiveWorkflow's default-true fallback used to (see
  // crmPredicates.ts).
  const bpStatuses = blueprints.map(blueprintStatus);
  const draftBps = bpStatuses.filter(s => s === "draft").length;
  const inactiveBps = bpStatuses.filter(s => s === "inactive").length;
  const activeUsers = users.filter(isActiveUser).length;
  // Deleted accounts don't consume a Zoho license - excluded from the
  // "total licensed" figure, unlike disabled-but-not-deleted users.
  const licensedUsers = users.filter(u => !isDeletedUser(u)).length;
  // "Used" scoped to users who are NOT inactive (Zoho's inactive flag is its
  // own already-obvious waste category, covered by licensedUsers-activeUsers
  // above) - an active-status account that has never actually logged in is a
  // wasted seat a status check alone would miss. Only claimed once
  // userLoginFieldPresent confirms at least one real user's login field
  // actually resolved (see getUser enrichment in useCrmEntities.ts) - an
  // all-false result with the field absent everywhere would otherwise read
  // as "everyone unused" when really it's "can't tell".
  const activeUsersOnly = users.filter(isActiveUser);
  const loginDataAvailable = userLoginFieldPresent(users);
  const usedActiveUsers = loginDataAvailable ? activeUsersOnly.filter(u => userLastLoginDate(u) !== null).length : null;
  const unusedActiveUsers = usedActiveUsers !== null ? activeUsers - usedActiveUsers : null;

  return [
    {
      key: "modules", label: "Modules", value: modules.length,
      severity: modulesFailed ? "unknown" : hiddenPct >= 40 ? "critical" : hiddenPct >= 15 ? "warning" : "good",
      note: modulesFailed ? `Couldn't verify - ${entityData.modules.error}` : modules.length ? `${activePct}% active · ${hiddenPct}% inactive - click to see which` : "No modules found",
      clickable: modules.length > 0 || modulesFailed,
      unknown: modulesFailed,
      source: modulesFailed ? `Source: ${entityData.modules.toolUsed ?? "no matching tool found"} - fetch failed, count not confirmed` : kpiSource(entityData.modules, modules.length),
    },
    {
      key: "blueprints", label: "Blueprints", value: blueprints.length,
      severity: blueprintsFailed ? "unknown" : blueprints.length > 0 && inactiveBps + draftBps === blueprints.length ? "critical" : inactiveBps > 0 ? "warning" : "good",
      note: blueprintsFailed ? `Couldn't verify: ${entityData.blueprints.error}` : blueprints.length ? `${inactiveBps} inactive${draftBps > 0 ? `, ${draftBps} draft` : ""}, click to see which` : "No blueprints found",
      clickable: blueprints.length > 0 || blueprintsFailed,
      unknown: blueprintsFailed,
      source: blueprintsFailed ? `Source: ${entityData.blueprints.toolUsed ?? "no matching tool found"} (fetch failed, count not confirmed)` : kpiSource(entityData.blueprints, blueprints.length),
    },
    {
      key: "users", label: "Active Users", value: activeUsers,
      severity: usersFailed ? "unknown" : activeUsers <= 1 ? "critical" : activeUsers < 5 ? "warning" : "good",
      // Same figures the Zia Recommendation box below computes (buildZiaUserInsight),
      // so this tile can never disagree with its own drilldown: total
      // licensed, then used/unused among the users who are NOT inactive -
      // Zoho's inactive flag is its own separate, already-obvious waste
      // (licensedUsers - activeUsers), not folded into "unused" here.
      note: usersFailed ? `Couldn't verify - ${entityData.users.error}`
        : unusedActiveUsers !== null
          ? `${licensedUsers} total licensed - ${usedActiveUsers} used, ${unusedActiveUsers} unused (active, never logged in) - click for details`
          : `${licensedUsers} total licensed${licensedUsers > activeUsers ? ` (${licensedUsers - activeUsers} inactive)` : ""} - click to see who's active/inactive`,
      clickable: users.length > 0 || usersFailed,
      unknown: usersFailed,
      source: usersFailed ? `Source: ${entityData.users.toolUsed ?? "no matching tool found"} - fetch failed, count not confirmed` : kpiSource(entityData.users, users.length),
    },
    {
      // No dedicated schedule-listing tool exists anywhere in Zoho's real MCP
      // catalogue, but Scheduled Functions are just Deluge functions with
      // category=="Schedule" - confirmed live against a real org (787
      // functions, 12 category=="Schedule") - so this rides the same
      // eagerly-fetched function list the Functions tile below already uses,
      // instead of the old permanent "couldn't verify" placeholder.
      key: "schedules", label: "Schedules", value: scheduleSummary.active,
      severity: !scheduleSummary.fetched ? "warning" : scheduleSummary.total === 0 ? "critical" : (scheduleSummary.total - scheduleSummary.active) > 0 ? "warning" : "good",
      note: !scheduleSummary.fetched ? "Loading…"
        : scheduleSummary.total === 0 ? "No Schedule-category functions found"
        : `${scheduleSummary.total - scheduleSummary.active} inactive of ${scheduleSummary.total} - click to see which`,
      clickable: scheduleSummary.total > 0,
      source: `Source: function list, filtered to category=="Schedule" - ${scheduleSummary.total} record${scheduleSummary.total !== 1 ? "s" : ""}`,
    },
    {
      key: "functions", label: "Functions", value: functionSummary.active,
      severity: !functionSummary.fetched ? "warning" : functionSummary.total === 0 ? "critical" : functionSummary.inactive > 0 ? "warning" : "good",
      note: !functionSummary.fetched ? "Loading…"
        : functionSummary.total === 0 ? "No functions found"
        : `${functionSummary.inactive} inactive of ${functionSummary.total} - click for issues, duplicates & code`,
      clickable: functionSummary.total > 0,
      source: `Source: function list - ${functionSummary.total} record${functionSummary.total !== 1 ? "s" : ""}`,
    },
  ];
}

interface BlueprintBreakdownRow {
  id: string;
  name: string;
  module: string;
  status: BlueprintStatus;
}

// Sorted so the actionable rows (not enforcing anything right now) surface
// first, matching the same "flag the useless ones first" pattern as the
// Workflow Trigger Activity card in BusinessView.tsx.
const BP_STATUS_ORDER: Record<BlueprintStatus, number> = { inactive: 0, draft: 1, active: 2 };

// Real Zoho blueprint list responses very often carry NO top-level "name" at
// all (blueprints are usually anonymous processes identified only by their
// module + driving field) - so getItemName's generic fallback chain lands on
// "Item N" far more often here than for named entities like workflows. Build
// a real label from the module + the field the blueprint actually drives
// (process_info.field_label / field.name, the same shape BlueprintAudit.tsx
// already parses from live Zoho responses) before ever falling back to a
// placeholder.
function blueprintDisplayName(bp: unknown, i: number, moduleLabel: string): string {
  const r = (bp ?? {}) as Record<string, unknown>;
  if (typeof r.name === "string" && r.name) return r.name;
  if (typeof r.blueprint_name === "string" && r.blueprint_name) return r.blueprint_name;
  const processInfo = r.process_info as Record<string, unknown> | undefined;
  const field = r.field as Record<string, unknown> | undefined;
  const fieldLabel = (processInfo?.field_label ?? processInfo?.name ?? field?.name ?? field?.api_name) as string | undefined;
  if (moduleLabel && fieldLabel) return `${moduleLabel}: ${fieldLabel} Process`;
  if (moduleLabel) return `${moduleLabel} Blueprint`;
  return r.id ? `Blueprint ${r.id}` : `Unnamed Blueprint ${i + 1}`;
}

function computeBlueprintBreakdown(entityData: Record<CrmEntityType, EntityState>): BlueprintBreakdownRow[] {
  return entityData.blueprints.items
    .map((bp, i) => {
      const module = workflowModuleLabel(bp) || "Unknown";
      return {
        id: String((bp as Record<string, unknown> | null)?.id ?? i),
        name: blueprintDisplayName(bp, i, module === "Unknown" ? "" : module),
        module,
        status: blueprintStatus(bp),
      };
    })
    .sort((a, b) => BP_STATUS_ORDER[a.status] - BP_STATUS_ORDER[b.status]);
}

// Same "flag the actionable groups, name a few real ones, praise a healthy
// org" synthesis as buildZiaModuleInsight/buildZiaWorkflowInsight above.
function buildZiaBlueprintInsight(rows: BlueprintBreakdownRow[]): ZiaInsight {
  if (rows.length === 0) return { summary: "No blueprints found - nothing to evaluate yet.", points: [] };
  const inactive = rows.filter(r => r.status === "inactive");
  const draft = rows.filter(r => r.status === "draft");
  const points: string[] = [];
  if (inactive.length > 0) {
    points.push(cap(`${inactive.length} of ${rows.length} blueprint${rows.length !== 1 ? "s are" : " is"} inactive - not enforcing anything right now: ${inactive.slice(0, 3).map(b => `${b.name} (${b.module})`).join(", ")}${inactive.length > 3 ? ", etc." : "."}`));
  }
  if (draft.length > 0) {
    points.push(cap(`${draft.length} blueprint${draft.length !== 1 ? "s are" : " is"} still in draft - never activated: ${draft.slice(0, 3).map(b => `${b.name} (${b.module})`).join(", ")}${draft.length > 3 ? ", etc." : "."}`));
  }
  if (points.length === 0) {
    return { summary: `All ${rows.length} blueprint${rows.length !== 1 ? "s are" : " is"} active and enforcing their process - looks healthy.`, points: [] };
  }
  return {
    summary: "", points,
    action: "Activate the ones still needed, or delete the rest so every configured process is actually being enforced.",
  };
}

interface UserBreakdownRow {
  id: string;
  name: string;
  profile: string;
  role: string;
  status: UserStatusBucket;
  // False here means "no login-activity date found for this user" - which
  // covers both "confirmed never logged in" AND "this server doesn't expose
  // the field at all". Only trustworthy once userLoginFieldPresent(...) on
  // the full user list confirms at least one user's field actually resolved
  // - see loginDataAvailable in buildZiaUserInsight, which gates on that
  // before ever calling a false here "unused".
  everLoggedIn: boolean;
}

const USER_BREAKDOWN_SORT_RANK: Record<UserStatusBucket, number> = { inactive: 0, deleted: 1, active: 2 };

// Disabled-but-licensed users surface first - they're the actionable ones (a
// licensed seat with nobody using it), active last, same "flag the useless
// ones first" convention as the blueprint/module breakdowns above. Deleted
// accounts are excluded entirely - they're gone from the org and hold no
// license, so there's nothing actionable to show here.
function computeUserBreakdown(entityData: Record<CrmEntityType, EntityState>): UserBreakdownRow[] {
  return entityData.users.items
    .filter(u => !isDeletedUser(u))
    .map((u, i) => {
      const r = (u ?? {}) as Record<string, unknown>;
      const profile = typeof r.profile === "object" && r.profile
        ? String((r.profile as Record<string, unknown>).name ?? "-")
        : "-";
      return {
        id: String(r.id ?? i),
        name: getItemName(u, i),
        profile,
        role: userRoleName(u) || "-",
        status: userStatusBucket(u),
        everLoggedIn: userLastLoginDate(u) !== null,
      };
    })
    .sort((a, b) => USER_BREAKDOWN_SORT_RANK[a.status] - USER_BREAKDOWN_SORT_RANK[b.status]);
}

// License-cost math: total licensed seats (every non-deleted user - see
// computeUserBreakdown, which already excludes deleted accounts, since those
// free up their license), then Used vs. Unused scoped to users who are NOT
// inactive (Zoho's own inactive flag is a separate, already-obvious waste
// category, called out on its own line below) - "unused" here means an
// active-status account that has never actually logged in, a wasted seat a
// simple status check alone would miss entirely. Only claimed when
// loginDataAvailable confirms at least one real user's login field actually
// resolved (see userLoginFieldPresent in crmPredicates.ts, driven by the
// getUser per-user detail enrichment in useCrmEntities.ts) - never inferred
// from an all-false result alone, which could just as easily mean the
// connected server doesn't expose the field at all.
function buildZiaUserInsight(rows: UserBreakdownRow[], loginDataAvailable: boolean): ZiaInsight {
  if (rows.length === 0) return { summary: "No users found - nothing to evaluate yet.", points: [] };
  const total = rows.length;
  const inactiveRows = rows.filter(r => r.status === "inactive");
  const activeRows = rows.filter(r => r.status === "active");
  const active = activeRows.length;
  const inactive = inactiveRows.length;
  const unusedActiveRows = loginDataAvailable ? activeRows.filter(r => !r.everLoggedIn) : [];
  const unusedActive = unusedActiveRows.length;
  const usedActive = active - unusedActive;

  if (inactive === 0 && (!loginDataAvailable || unusedActive === 0)) {
    return {
      summary: loginDataAvailable
        ? `All ${total} licensed user${total !== 1 ? "s are" : " is"} active and have logged in - no unused licenses.`
        : `All ${total} licensed user${total !== 1 ? "s are" : " is"} active - no inactive licenses. Active-user login activity isn't available to confirm real usage.`,
      points: [],
    };
  }

  const points: string[] = [
    cap(`${total} licensed user${total !== 1 ? "s" : ""} total - ${active} active, ${inactive} inactive.`),
  ];
  if (inactive > 0) {
    points.push(cap(`${inactive} inactive license${inactive !== 1 ? "s" : ""} - ${inactive !== 1 ? "these accounts hold" : `${inactiveRows[0].name} holds`} a paid seat with nobody using it${inactive > 1 ? `: ${inactiveRows.slice(0, 3).map(r => r.name).join(", ")}${inactive > 3 ? ", etc." : ""}` : ""}.`));
  }
  if (loginDataAvailable) {
    if (unusedActive > 0) {
      points.push(cap(`Of ${active} active user${active !== 1 ? "s" : ""}, ${usedActive} ${usedActive !== 1 ? "have" : "has"} logged in and ${unusedActive} ${unusedActive !== 1 ? "have" : "has"} never logged in despite holding a license${unusedActive > 1 ? `: ${unusedActiveRows.slice(0, 3).map(r => r.name).join(", ")}${unusedActive > 3 ? ", etc." : ""}` : `: ${unusedActiveRows[0].name}`}.`));
    } else {
      points.push(cap(`All ${active} active user${active !== 1 ? "s" : ""} have logged in at least once - no unused active licenses.`));
    }
  } else {
    points.push("Active-user login activity isn't available from this connection - can't confirm which active licenses are actually being used.");
  }

  return {
    summary: "",
    points,
    action: "Deactivate or free up licenses nobody's using - both inactive accounts and active accounts with no login activity are paid seats with zero return.",
  };
}

interface ConfigRow {
  // Layout Rules / Validation Rules aren't CrmEntityType-backed (see
  // moduleRuleScanConfigRow below) - widened just enough to admit those two
  // synthetic rows alongside the real entityData-backed ones.
  key: CrmEntityType | "layoutRules" | "validationRules";
  label: string;
  value: string;
  status: string;
  severity: Severity | "neutral";
  targetSection: Section | null;
  source: string;
}

// Assignment Rules and Approval Rules are prepended (rendered first, right
// below the Functions KPI tile) rather than appended - both are genuinely
// org-wide, paginated list endpoints (no per-module scan needed, unlike
// Layout Rules/Validation Rules below), so they ride this same generic
// entityData-backed mechanism as Pipelines/Workflows/Profiles/Activity with
// zero new fetch logic.
const CONFIG_ROW_DEFS: { type: CrmEntityType; label: string; targetSection: Section | null }[] = [
  { type: "assignmentRules", label: "Assignment Rules", targetSection: "modules" },
  { type: "approvalRules",   label: "Approval Rules",   targetSection: "modules" },
  { type: "pipelines", label: "Pipelines", targetSection: "modules" },
  { type: "workflows", label: "Workflows", targetSection: "workflows" },
  { type: "profiles",  label: "Profiles",  targetSection: null },
  { type: "tasks",     label: "Activity",  targetSection: "modules" },
];

function computeConfigRows(entityData: Record<CrmEntityType, EntityState>, outOfOrderStageCount: number, pipelineCount: number | null, pipelineStagesResolved: boolean, pipelineStagesError: string | null): ConfigRow[] {
  return CONFIG_ROW_DEFS.map(def => {
    const st = entityData[def.type];
    // Pipelines is handled entirely on its own real getLayouts -> getPipelines
    // chain (usePipelineStages.ts), never on this generic zero-param
    // getPipelines() entity fetch below - that generic call has no layout_id
    // to scope by, and on some servers layout_id is a hard requirement, so it
    // fails outright with a "Mandatory query param 'layout_id'" error. That
    // error used to leak into this row (showing "Couldn't verify" even once
    // the real chain had a perfectly good count) because the row's error
    // check only ever looked at this generic fetch's own st.error, never the
    // real chain's - falling through here instead of into the shared
    // count-from-st.items path below.
    if (def.type === "pipelines") {
      if (!pipelineStagesResolved) {
        return { key: def.type, label: def.label, value: "…", status: "Loading", severity: "neutral" as const, targetSection: def.targetSection, source: "Loading…" };
      }
      if (pipelineCount === null || pipelineCount === 0) {
        if (pipelineStagesError) {
          return { key: def.type, label: def.label, value: "-", status: `Couldn't verify - ${pipelineStagesError}`, severity: "unknown" as const, targetSection: def.targetSection, source: "Source: getLayouts -> getPipelines - fetch failed" };
        }
        return { key: def.type, label: def.label, value: "0", status: "Not found", severity: "critical" as const, targetSection: def.targetSection, source: "Source: getLayouts -> getPipelines - 0 records" };
      }
      const status = outOfOrderStageCount > 0
        ? `${outOfOrderStageCount} stage${outOfOrderStageCount !== 1 ? "s" : ""} out of order`
        : "Configured";
      return {
        key: def.type, label: def.label, value: String(pipelineCount),
        status, severity: outOfOrderStageCount > 0 ? "critical" as const : "good" as const,
        targetSection: def.targetSection, source: `Source: getLayouts -> getPipelines - ${pipelineCount} record${pipelineCount !== 1 ? "s" : ""}`,
      };
    }
    if (!isEntityResolved(st)) {
      return { key: def.type, label: def.label, value: "…", status: "Loading", severity: "neutral" as const, targetSection: def.targetSection, source: "Loading…" };
    }
    const count = st.items.length;
    const source = st.toolUsed ? `Source: ${st.toolUsed} - ${count} record${count !== 1 ? "s" : ""}` : "Source: no matching tool found";
    if (count === 0) {
      // A fetch error and a genuinely empty CRM both leave items at [] - only
      // the former means "couldn't verify". Conflating them into the same
      // critical "Not found" reads as a confirmed gap when it might just be
      // a broken connection.
      if (st.error) {
        return { key: def.type, label: def.label, value: "-", status: `Couldn't verify - ${st.error}`, severity: "unknown" as const, targetSection: def.targetSection, source: `Source: ${st.toolUsed ?? "no matching tool found"} - fetch failed` };
      }
      // "0" here, not "N/A" - this branch is reached only when the fetch
      // succeeded with no error, so a confirmed empty result is a real,
      // known value (zero), not something unavailable/not applicable.
      return { key: def.type, label: def.label, value: "0", status: "Not found", severity: "critical" as const, targetSection: def.targetSection, source };
    }

    let status: string;
    let severity: Severity | "neutral";
    switch (def.type) {
      case "workflows":
      case "assignmentRules":
      case "approvalRules": {
        const inactive = st.items.filter(i => !isActiveWorkflow(i)).length;
        if (inactive === 0) { status = "Active"; severity = "good"; }
        else if (inactive === count) { status = `${inactive} inactive`; severity = "critical"; }
        else { status = `${inactive} inactive`; severity = "warning"; }
        break;
      }
      case "profiles":
        status = count === 1 ? "Single profile" : "Configured";
        severity = count === 1 ? "warning" : "good";
        break;
      default:
        status = "Configured";
        severity = "good";
    }

    return { key: def.type, label: def.label, value: String(count), status, severity, targetSection: def.targetSection, source };
  });
}

// Layout Rules / Validation Rules aren't entityData-backed (see
// useModuleRuleScan above) - their config-list row is built directly from
// the on-demand scan hook's state instead of going through computeConfigRows.
function moduleRuleScanConfigRow(
  key: "layoutRules" | "validationRules",
  label: string,
  scan: { perModule: ModuleRuleGroup[]; scanProgress: { done: number; total: number; loading: boolean }; scanned: boolean },
): ConfigRow {
  if (scan.scanProgress.loading) {
    return { key, label, value: "…", status: `Scanning… ${scan.scanProgress.done}/${scan.scanProgress.total}`, severity: "neutral", targetSection: "modules", source: "Scanning every module - one call per module" };
  }
  if (!scan.scanned) {
    return { key, label, value: "-", status: "Waiting for modules to load…", severity: "unknown", targetSection: "modules", source: "Not scanned yet" };
  }
  const totalRules = scan.perModule.reduce((sum, m) => sum + m.items.length, 0);
  const modulesWithRules = scan.perModule.filter(m => m.items.length > 0).length;
  if (totalRules === 0) {
    return { key, label, value: "0", status: `No rules found across ${scan.perModule.length} modules`, severity: "warning", targetSection: "modules", source: `Scanned ${scan.perModule.length} modules` };
  }
  const inactive = scan.perModule.reduce((sum, m) => sum + m.items.filter(i => !isActiveWorkflow(i)).length, 0);
  return {
    key, label, value: String(totalRules),
    status: `${inactive} inactive across ${modulesWithRules} module${modulesWithRules !== 1 ? "s" : ""}`,
    severity: inactive === 0 ? "good" : inactive === totalRules ? "critical" : "warning",
    targetSection: "modules",
    source: `Scanned ${scan.perModule.length} modules`,
  };
}

function PanelEmptyState({ state, label, onRetry }: { state: EntityState; label: string; onRetry: () => void }) {
  if (state.loading) {
    return <p className="business-view-hint"><span className="spinner" /> Loading {label.toLowerCase()}…</p>;
  }
  if (state.error) {
    return (
      <div className="panel-empty-error">
        <p className="business-view-hint">⚠ {state.error}{state.toolUsed ? ` (via ${state.toolUsed})` : " - no matching tool found"}</p>
        <button className="btn-secondary" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return <p className="business-view-hint">No {label.toLowerCase()} found.</p>;
}

// Shared detail-panel body for Layout Rules and Validation Rules - both are
// on-demand per-module scans (see useModuleRuleScan) with an identical
// before/during/after-scan shape, so this is written once and used for both
// cards instead of duplicating the same ~50 lines twice.
function ModuleRuleScanPanel({ title, ziaTitle, ziaInsight, scan, search, onSearchChange, matchesSearch, onClose }: {
  title: string;
  ziaTitle: string;
  ziaInsight: ZiaInsight;
  scan: { perModule: ModuleRuleGroup[]; scanProgress: { done: number; total: number; loading: boolean }; scanned: boolean; rescan: () => void };
  search: string;
  onSearchChange: (v: string) => void;
  matchesSearch: (...values: (string | null | undefined)[]) => boolean;
  onClose: () => void;
}) {
  // Local, not lifted to the parent like drilldownSearch - each of the two
  // panels using this component (Layout/Validation Rules) unmounts when its
  // card closes, so a fresh "all" filter on reopen is the right default
  // rather than something that needs to persist across cards.
  const [filter, setFilter] = useState<"all" | "active" | "inactive" | "duplicate">("all");
  const rows = moduleGroupsToRuleRows(scan.perModule);
  const dupNames = duplicateRuleNameSet(duplicateRuleGroups(rows));
  const activeCount = rows.filter(r => r.active).length;
  const duplicateCount = rows.filter(r => dupNames.has(r.name.trim().toLowerCase())).length;
  return (
    <div className="kpi-drilldown">
      <div className="kpi-drilldown-header">
        <h4>{title}</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn-secondary" onClick={scan.rescan} disabled={scan.scanProgress.loading}>
            {scan.scanProgress.loading ? <><span className="spinner" /> Scanning…</> : scan.scanned ? "↺ Rescan all modules" : "▶ Scan all modules"}
          </button>
          <button className="kpi-drilldown-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="zia-rec zia-rec-medium activity-zia-rec">
        <div className="zia-rec-header">
          <span className="zia-rec-icon">✦</span>
          <span className="zia-rec-title">{ziaTitle}</span>
        </div>
        <ZiaRecBody {...ziaInsight} />
      </div>
      {!scan.scanned && !scan.scanProgress.loading && (
        <p className="business-view-hint">
          This is a per-module Zoho endpoint with no "list all modules" mode - every real module in the org is scanned automatically, one API call per module. This can take a little while for a large org.
        </p>
      )}
      {scan.scanProgress.loading && (
        <p className="kpi-drilldown-progress">
          <span className="spinner" /> Scanning module {scan.scanProgress.done} of {scan.scanProgress.total}…
        </p>
      )}
      {scan.scanned && !scan.scanProgress.loading && (
        <>
          <input
            type="text"
            className="kpi-drilldown-search"
            placeholder="Search rules…"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
          />
          <div className="kpi-drilldown-summary">
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable good ${filter === "active" ? "selected" : ""}`}
              onClick={() => setFilter(prev => (prev === "active" ? "all" : "active"))}
            >
              {activeCount} Active
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${filter === "inactive" ? "selected" : ""}`}
              onClick={() => setFilter(prev => (prev === "inactive" ? "all" : "inactive"))}
            >
              {rows.length - activeCount} Inactive
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${filter === "duplicate" ? "selected" : ""}`}
              onClick={() => setFilter(prev => (prev === "duplicate" ? "all" : "duplicate"))}
            >
              {duplicateCount} Duplicate
            </button>
            {filter !== "all" && (
              <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setFilter("all")}>Show All</button>
            )}
          </div>
          <div className="kpi-drilldown-table kpi-drilldown-table-single">
            {rows
              .map(row => ({ ...row, duplicate: dupNames.has(row.name.trim().toLowerCase()) }))
              .filter(row => filter === "all" || (filter === "duplicate" ? row.duplicate : (filter === "active") === row.active))
              .filter(row => matchesSearch(row.name, row.module))
              .map((row, idx) => (
                <div key={row.module + row.name + idx} className="kpi-drilldown-row">
                  <span className="kpi-drilldown-name">{row.name}</span>
                  <span className="kpi-drilldown-module">{row.module || "-"}</span>
                  {row.duplicate && <span className="kpi-drilldown-badge status-inactive" data-tooltip="Same rule name used elsewhere in the org">duplicate</span>}
                  <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CRMOverviewDashboard({ config, tools, onLog, entityData, fetchEntity, fetchAll, lastRefresh, onSelectSection, pipelineStageCount, pipelineStages, ruleCoverage }: Props) {
  const [activeTab, setActiveTab] = useState<ReportTab>("changes");
  const [ziaRecsExpanded, setZiaRecsExpanded] = useState(false);
  const [ziaMessages, setZiaMessages] = useState<ZiaMessage[]>([]);
  const [ziaInput, setZiaInput] = useState("");
  const [ziaLoading, setZiaLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const [remediation, setRemediation] = useState<Record<string, {
    loading: boolean;
    text: string;
    usage?: { inputTokens: number; outputTokens: number; model: string };
  }>>({});
  // Single source of truth for the master-detail layout below: the one card
  // (out of the 6 KPI tiles + 4 CRM Configuration tiles) currently selected
  // in the left-hand list, whose detail renders in the right-hand panel.
  // Replaces the old expandedKpi + pipelinesOpen pair - those two used to
  // gate two visually-separate "expand below" sections; now there's only one
  // selection driving one detail slot.
  type CardKey = "modules" | "blueprints" | "users" | "schedules" | "functions"
               | "layoutRules" | "assignmentRules" | "validationRules" | "approvalRules"
               | "pipelines" | "workflows" | "profiles" | "activity";
  const [selectedCard, setSelectedCard] = useState<CardKey | null>("modules");
  const detailPanelRef = useRef<HTMLDivElement>(null);
  // Lets a Downloadable Reports card's preview item/"+N more" jump straight
  // to that item's full entry in the Zia Recommendations panel below,
  // instead of just sitting there inert - opens the matching tab, expands
  // the list (so a rec past the collapsed height isn't hidden right after
  // scrolling to it), and scrolls only that panel into view.
  const ziaRecsSectionRef = useRef<HTMLDivElement>(null);
  function jumpToRecommendations(cat: ReportTab) {
    setActiveTab(cat);
    setZiaRecsExpanded(true);
    ziaRecsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const isFirstCardRender = useRef(true);
  useEffect(() => {
    // Cards further down the left-hand list can sit well below the fold;
    // without this, selecting one pops the detail panel in at the top of
    // the grid row, off-screen from where the user just clicked. Skip the
    // very first render though - "modules" is preselected by default, and
    // scrolling then would auto-scroll the page the instant it connects,
    // before the user has clicked anything.
    if (isFirstCardRender.current) { isFirstCardRender.current = false; return; }
    if (selectedCard) detailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedCard]);
  const [moduleFilter, setModuleFilter] = useState<ModuleCategory | "all">("all");
  const [workflowFilter, setWorkflowFilter] = useState<"all" | "active" | "inactive" | "never" | "long-trigger" | "duplicate" | "overlapping">("all");
  const [blueprintFilter, setBlueprintFilter] = useState<BlueprintStatus | "all">("all");
  const functionRecords = useFunctionRecords(config, tools, selectedCard === "functions", onLog);
  const workflowDetails = useWorkflowDetails(config, tools, entityData.workflows.items, selectedCard === "workflows", onLog);
  // Unlike Schedules/Functions/Workflows above (deliberately deferred until
  // their own drilldown card is opened - each fires one call per module/
  // function/workflow and can be expensive on a large org), Layout Rules and
  // Validation Rules are cheap enough and requested to auto-scan as soon as
  // modules resolve, same as the entityData-backed Assignment/Approval Rules
  // rows - so their real counts are already sitting in the config list
  // before the user ever opens either card, instead of showing "Click to
  // scan every module" until they do.
  const layoutRuleScan = useModuleRuleScan(config, tools, entityData.modules.items, /getlayoutrules$/i, true, onLog);
  const validationRuleScan = useModuleRuleScan(config, tools, entityData.modules.items, /getvalidationrules$/i, true, onLog);
  const [assignmentRuleFilter, setAssignmentRuleFilter] = useState<"all" | "active" | "inactive" | "duplicate">("all");
  const [approvalRuleFilter, setApprovalRuleFilter] = useState<"all" | "active" | "inactive" | "duplicate">("all");
  // Duplicate-name groups show their matched functions immediately, same as
  // the Workflow card's "Duplicate Match Details" panel (expanded by default)
  // - this tracks which groups a user has manually collapsed, rather than
  // which one (singular) is expanded.
  const [collapsedFunctionDuplicates, setCollapsedFunctionDuplicates] = useState<Set<string>>(new Set());
  // Same collapse-tracking, mirrored for the Workflow drilldown's duplicate
  // groups - expanded by default, same as the Functions card.
  const [collapsedWorkflowDuplicates, setCollapsedWorkflowDuplicates] = useState<Set<string>>(new Set());
  const [collapsedWorkflowOverlaps, setCollapsedWorkflowOverlaps] = useState<Set<string>>(new Set());
  const [previewFunctionId, setPreviewFunctionId] = useState<string | null>(null);
  const [functionsListExpanded, setFunctionsListExpanded] = useState(false);
  type FunctionsSubTab = "issues" | "duplicates" | "all";
  const [functionsSubTab, setFunctionsSubTab] = useState<FunctionsSubTab>("issues");
  // Issues tab: filter by criteria/type (clickable, at the top), paginated
  // by function instead of a hard slice(0, 15) + "N more" line, and each
  // function collapsed by default - click its name to see its own issues as
  // a bullet list instead of one flat row per issue repeating the name.
  const [issueTypeFilter, setIssueTypeFilter] = useState<FunctionIssueCategory | "all">("all");
  const [issuePage, setIssuePage] = useState(1);
  const [expandedIssueFunctions, setExpandedIssueFunctions] = useState<Set<string>>(new Set());
  // Same "criteria filter buttons on top, clickable, paginated table" shape
  // as the Functions Issues tab above, applied to the combined Email/Task/
  // Call activity table - filter by record type first.
  const [activityTypeFilter, setActivityTypeFilter] = useState<"all" | "email" | "task" | "call">("all");
  const [activityPage, setActivityPage] = useState(1);
  useEffect(() => { setActivityPage(1); }, [activityTypeFilter]);
  // One search box per drill-down panel - cleared whenever a different card
  // (or function sub-tab) is opened so a stale query from "Modules" doesn't
  // silently hide everything the next time "Blueprints" is opened.
  const [drilldownSearch, setDrilldownSearch] = useState("");
  useEffect(() => { setDrilldownSearch(""); }, [selectedCard, functionsSubTab]);
  // Otherwise a filter/search change while sitting on page 3 can leave the
  // view stuck on a now-out-of-range page showing nothing.
  useEffect(() => { setIssuePage(1); }, [issueTypeFilter, drilldownSearch, functionsSubTab]);
  const drilldownQuery = drilldownSearch.trim().toLowerCase();
  function matchesSearch(...values: (string | null | undefined)[]): boolean {
    if (!drilldownQuery) return true;
    return values.some(v => (v ?? "").toLowerCase().includes(drilldownQuery));
  }
  function toggleFunctionPreview(fnId: string) {
    setPreviewFunctionId(prev => {
      const next = prev === fnId ? null : fnId;
      if (next) functionRecords.fetchCode(next);
      return next;
    });
  }
  // Deliberately kept eager (fetches as soon as tools are ready) rather than
  // gated on selectedCard === "activity" like the on-demand hooks above -
  // this is existing behavior preserved as-is; only where its result renders
  // changed (now behind the Activity card's selection instead of always-on).
  const activityRecords = useActivityRecords(config, tools, true, onLog);

  // Tick for relative-time display
  useEffect(() => {
    const id = setInterval(() => setRefreshTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  function buildCrmContext(): string {
    const ctxLines: string[] = ["=== CRM OVERVIEW ==="];
    for (const e of CRM_ENTITIES) {
      const st = entityData[e.type];
      if (st.items.length === 0) continue;
      const names = st.items
        .slice(0, 5)
        .map((item, idx) => getItemName(item, idx))
        .join(", ");
      ctxLines.push(`${e.label} (${st.items.length}): ${names}${st.items.length > 5 ? ", …" : ""}`);
    }
    const profItems = entityData.profiles.items;
    if (profItems.length > 0) {
      ctxLines.push(`Profile Names: ${profItems.map((p, i) => getItemName(p, i)).join(", ")}`);
    }
    const userItems = entityData.users.items;
    if (userItems.length > 0) {
      ctxLines.push(`Users (${userItems.length}): ${userItems.slice(0, 3).map((u, i) => getItemName(u, i)).join(", ")}${userItems.length > 3 ? ", …" : ""}`);
    }
    // Real getLayouts -> getPipelines names (see computeHealthScore's matching
    // pipelineCountOverride param) - entityData.pipelines.items is the
    // generic zero-param fetch that fails outright on servers requiring a
    // layout_id, which would silently drop this line from Zia's context.
    if (pipelineStages.pipelines.length > 0) {
      ctxLines.push(`Pipeline Names: ${pipelineStages.pipelines.map(p => p.name).join(", ")}`);
    }
    return ctxLines.join("\n");
  }

  // Fills every property the tool's schema exposes (not just a free-text query
  // field) so structural tools like a "ZiaRecommendation" create/action tool
  // can still be called - e.g. a "recommendations" array field gets [{id}].
  function buildZiaParams(tool: McpTool, question: string, recId?: string, recName?: string): Record<string, unknown> {
    const props = tool.inputSchema?.properties ?? {};
    const required: string[] = tool.inputSchema?.required ?? [];
    const allKeys = [...new Set([...required, ...Object.keys(props)])];
    const fullText = `${question}\n\n${buildCrmContext()}`;
    const params: Record<string, unknown> = {};

    for (const key of allKeys) {
      const lk = key.toLowerCase();
      const propType = props[key]?.type ?? "string";
      if (QUERY_KEYS.includes(lk)) {
        params[key] = fullText;
      } else if (lk === "recommendations" || (propType === "array" && lk.includes("recommend"))) {
        params[key] = recId ? [{ id: recId }] : [];
      } else if (lk === "id" || lk.endsWith("_id")) {
        params[key] = recId ?? "";
      } else if (lk.includes("name") && !lk.includes("api")) {
        params[key] = recName ?? "";
      } else if (propType === "array") {
        params[key] = [];
      } else if (propType === "object") {
        params[key] = {};
      } else {
        params[key] = "";
      }
    }
    return params;
  }

  // Runs a question against the best available Zia-ish tool. Prefers a tool
  // with genuine free-text input, but falls back to whatever Zia/recommend
  // tool is connected - filling its full schema generically - rather than
  // refusing to use it. Returns the formatted answer, or throws on failure.
  async function runZiaQuery(question: string, recId?: string, recName?: string): Promise<string> {
    const tool = findZiaTool(tools) ?? tools[0];
    if (!tool) throw new Error("No MCP tools available. Please ensure your MCP server is connected.");

    const params = buildZiaParams(tool, question, recId, recName);
    const output = await executeTool(config, tool.name, params);
    let text = "";
    if (typeof output === "string") {
      text = output;
    } else if (output && typeof output === "object") {
      const r = output as Record<string, unknown>;
      if (Array.isArray(r.content)) {
        text = (r.content as Record<string, unknown>[])
          .filter(c => c.type === "text")
          .map(c => String(c.text))
          .join("\n");
      } else {
        text = String(r.message ?? r.result ?? r.text ?? JSON.stringify(output, null, 2));
      }
    }
    return formatZiaResponseText(text) || "No response received from tool.";
  }

  async function sendToZia(overrideText?: string) {
    const q = (overrideText ?? ziaInput).trim();
    if (!q || ziaLoading) return;
    setZiaInput("");
    setZiaMessages(prev => [...prev, { role: "user", content: q }]);
    setZiaLoading(true);
    setZiaMessages(prev => [...prev, { role: "zia", content: "", isLoading: true }]);

    try {
      const text = await runZiaQuery(q);
      setZiaMessages(prev => [...prev.slice(0, -1), { role: "zia", content: text }]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Tool call failed";
      setZiaMessages(prev => [...prev.slice(0, -1), { role: "zia", content: `⚠ ${msg}` }]);
    } finally {
      setZiaLoading(false);
    }
  }

  useEffect(() => {
    // Scroll only within the chat's own message list - never the page -
    // and only once there's actually something to show (skip the empty initial mount).
    if (ziaMessages.length === 0) return;
    const el = chatMessagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ziaMessages]);

  // Remediation answers render inline on the recommendation card itself -
  // routing them into the shared Ask Zia chat (further down the page) meant
  // clicking the button either forced an unwanted scroll or landed the user
  // among unrelated Reports content instead of the actual answer.
  //
  // This is the only place in the dashboard that calls Claude directly rather
  // than a connected Zia/MCP tool: "how do I fix this" is a pure explain task
  // with no need to touch live CRM data, so it doesn't depend on the guesswork
  // in findZiaTool/runZiaQuery (which can fall back to an unrelated, possibly
  // mutating tool if no genuine Zia tool is connected).
  async function askZiaAbout(rec: Recommendation) {
    setRemediation(prev => ({ ...prev, [rec.id]: { loading: true, text: "" } }));
    try {
      const res = await fetch("/api/remediation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: rec.title, description: rec.description, context: buildCrmContext() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRemediation(prev => ({ ...prev, [rec.id]: { loading: false, text: data.text, usage: data.usage } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Remediation request failed";
      setRemediation(prev => ({ ...prev, [rec.id]: { loading: false, text: `⚠ ${msg}` } }));
    }
  }

  void refreshTick; // used for relative time updates

  const functionDuplicates = computeFunctionDuplicates(functionRecords.items);
  const functionActiveCount = functionRecords.items.filter(f => f.active).length;
  const functionInactiveCount = functionRecords.items.length - functionActiveCount;
  const functionSuspiciousNames = functionRecords.items.filter(f => SUSPICIOUS_FUNCTION_NAME.test(f.name.trim())).map(f => f.name);
  // Cheap - just a filter over the already-eagerly-fetched function list, not
  // a separate fetch - so unlike moduleBreakdown/blueprintBreakdown/
  // userBreakdown below, this doesn't need to be gated behind selectedCard.
  const scheduleBreakdown = computeScheduleBreakdown(functionRecords.items);
  // Adapter so generateRecommendations (unchanged below) keeps reading the
  // same FunctionHealth shape it always has - now sourced from the new hook's
  // full items instead of the old names-only fetch, so duplicate/suspicious
  // counts here always match what the Functions KPI drilldown shows.
  const functionHealth: FunctionHealth | null = functionRecords.listState.fetched ? {
    totalScanned: functionRecords.items.length,
    hasMore: functionRecords.listState.hasMore,
    duplicateGroups: functionDuplicates.map(g => ({ name: g.name, count: g.items.length })),
    suspiciousNames: functionSuspiciousNames,
    failuresChecked: functionRecords.failureCount !== null,
    failureCount: functionRecords.failureCount ?? 0,
    scheduleTotal: scheduleBreakdown.length,
    scheduleInactive: scheduleBreakdown.filter(r => !r.active).length,
  } : null;

  // Real getLayouts -> getPipelines count (see computeHealthScore's matching
  // param) - reused below for computeConfigRows too, instead of each caller
  // re-deriving its own copy.
  const pipelineCountOverride = pipelineStages.lastFetched !== null ? pipelineStages.pipelineCount : null;
  const recommendations = generateRecommendations(entityData, tools, ruleCoverage, functionHealth, pipelineCountOverride);
  const filteredRecs = recommendations.filter(r => r.category === activeTab);
  // Modules get the same deleted/internal-pseudo-module exclusion as the
  // Modules KPI card (see computeKpis) so this total agrees with it instead
  // of quietly including the raw, junk-inflated module count.
  const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityItemCount(e.type, entityData[e.type].items), 0);
  const loadingCount = CRM_ENTITIES.filter(e => entityData[e.type].loading).length;
  const loadedCount = CRM_ENTITIES.filter(e => entityData[e.type].lastFetched !== null).length;
  const ziaTool = findZiaTool(tools);

  const kpis = computeKpis(entityData, {
    total: functionRecords.items.length, active: functionActiveCount, inactive: functionInactiveCount,
    fetched: functionRecords.listState.fetched,
  }, {
    total: scheduleBreakdown.length, active: scheduleBreakdown.filter(r => r.active).length,
    fetched: functionRecords.listState.fetched,
  });
  const moduleBreakdown = selectedCard === "modules" ? computeModuleBreakdown(entityData) : [];
  const ziaModuleInsight = buildZiaModuleInsight(moduleBreakdown);
  const blueprintBreakdown = selectedCard === "blueprints" ? computeBlueprintBreakdown(entityData) : [];
  const ziaBlueprintInsight = buildZiaBlueprintInsight(blueprintBreakdown);
  const ziaScheduleInsight = buildZiaScheduleInsight(scheduleBreakdown);
  const userBreakdown = selectedCard === "users" ? computeUserBreakdown(entityData) : [];
  const userLoginDataAvailable = userLoginFieldPresent(entityData.users.items);
  const ziaUserInsight = buildZiaUserInsight(userBreakdown, userLoginDataAvailable);

  // Metadata issues (e.g. missing description) come straight from the
  // function list, so they show for every function immediately - unlike the
  // code-scan issues below, which only exist once that function's Deluge
  // source has actually been downloaded and analyzed.
  const functionIssueRows: FunctionIssueRow[] = selectedCard === "functions"
    ? functionRecords.items.flatMap(fn => [
        ...checkFunctionMetadata(fn).map((issue, i) => ({ key: `${fn.id}-meta-${i}`, id: fn.id, functionName: fn.name, category: fn.category, issue })),
        ...(functionRecords.issuesByFnId[fn.id] ?? []).map((issue, i) => ({ key: `${fn.id}-${i}`, id: fn.id, functionName: fn.name, category: fn.category, issue })),
      ])
    : [];
  const sortedFunctionIssueRows = [...functionIssueRows].sort((a, b) => FUNCTION_SEVERITY_ORDER[a.issue.severity] - FUNCTION_SEVERITY_ORDER[b.issue.severity]);
  // Only the categories actually present get a filter button - a fixed list
  // of all 13 would show a dozen dead buttons for an org with 2 real issue
  // types. Order follows ISSUE_CATEGORY_LABELS' own declared order, not
  // count, so the button row doesn't reshuffle itself as issues get fixed.
  const presentIssueCategories = (Object.keys(ISSUE_CATEGORY_LABELS) as FunctionIssueCategory[])
    .filter(cat => functionIssueRows.some(r => r.issue.category === cat));
  const functionIssueGroups = groupFunctionIssuesByFunction(sortedFunctionIssueRows);
  const filteredIssueGroups = functionIssueGroups
    .filter(g => issueTypeFilter === "all" || g.issues.some(i => i.category === issueTypeFilter))
    .filter(g => matchesSearch(g.functionName, g.moduleCategory));
  const issueTotalPages = Math.max(1, Math.ceil(filteredIssueGroups.length / FUNCTION_ISSUES_PAGE_SIZE));
  const issueCurrentPage = Math.min(issuePage, issueTotalPages);
  const pagedIssueGroups = filteredIssueGroups.slice(
    (issueCurrentPage - 1) * FUNCTION_ISSUES_PAGE_SIZE,
    issueCurrentPage * FUNCTION_ISSUES_PAGE_SIZE,
  );
  const scannedFnIds = Object.keys(functionRecords.issuesByFnId);
  const scannedFnCount = scannedFnIds.length;
  const functionsWithIssuesCount = scannedFnIds.filter(id => (functionRecords.issuesByFnId[id]?.length ?? 0) > 0).length;
  const functionsWithIssuesPct = scannedFnCount > 0 ? Math.round((functionsWithIssuesCount / scannedFnCount) * 100) : 0;
  const functionZiaSummary = buildFunctionZiaSummary(functionsWithIssuesPct, scannedFnCount, functionDuplicates, functionSuspiciousNames.length, functionRecords.failureCount);
  const configRows = computeConfigRows(
    entityData,
    pipelineStages.items.filter(s => s.outOfOrder).length,
    pipelineCountOverride,
    !pipelineStages.loading && (pipelineStages.lastFetched !== null || pipelineStages.error !== null),
    pipelineStages.error,
  );
  // User-requested order: Layout Rules, Assignment Rules, Validation Rules,
  // Approval Rules, then the pre-existing Pipelines/Workflows/Profiles/
  // Activity rows - Layout/Validation Rules are synthetic (scan-hook-backed,
  // not entityData-backed - see moduleRuleScanConfigRow) so they're spliced
  // in here rather than living in CONFIG_ROW_DEFS/computeConfigRows.
  const assignmentRulesRow = configRows.find(r => r.key === "assignmentRules")!;
  const approvalRulesRow = configRows.find(r => r.key === "approvalRules")!;
  // Workflows is pulled out of this list entirely (not just reordered within
  // it) - it's rendered right after the Modules tile up in the main KPI row
  // instead, per user request, so it doesn't also appear down here.
  const workflowsRow = configRows.find(r => r.key === "workflows")!;
  const displayConfigRows: ConfigRow[] = [
    moduleRuleScanConfigRow("layoutRules", "Layout Rules", layoutRuleScan),
    assignmentRulesRow,
    moduleRuleScanConfigRow("validationRules", "Validation Rules", validationRuleScan),
    approvalRulesRow,
    ...configRows.filter(r => r.key !== "assignmentRules" && r.key !== "approvalRules" && r.key !== "workflows"),
  ];
  const enrichedWorkflowItems = enrichWorkflowsWithDetail(entityData.workflows.items, workflowDetails.detailByWfId);
  const workflowBreakdown = computeWorkflowBreakdown(enrichedWorkflowItems);
  const workflowDuplicateGroups = computeWorkflowDuplicateGroups(enrichedWorkflowItems);
  const workflowOverlapGroups = computeWorkflowOverlapGroups(enrichedWorkflowItems);
  const ziaWorkflowInsight = buildZiaWorkflowInsight(workflowBreakdown);
  const ziaLayoutRuleInsight = buildZiaLayoutRuleInsight(layoutRuleScan.perModule, layoutRuleScan.scanned);
  const ziaValidationRuleInsight = buildZiaValidationRuleInsight(validationRuleScan.perModule, validationRuleScan.scanned);
  const ziaAssignmentRuleInsight = buildZiaAssignmentRuleInsight(entityData.assignmentRules.items);
  const ziaApprovalRuleInsight = buildZiaApprovalRuleInsight(entityData.approvalRules.items);
  const activityStats = buildActivityStats(isEntityResolved(entityData.tasks), entityData.tasks.items, activityRecords.calls, activityRecords.emails);
  const ziaActivityInsight = buildZiaActivityInsight(entityData.tasks.items, activityRecords.calls, activityRecords.emails);
  const activityTableRows = selectedCard === "activity"
    ? computeActivityTableRows(entityData.tasks.items, activityRecords.calls, activityRecords.emails)
    : [];
  const filteredActivityRows = activityTypeFilter === "all" ? activityTableRows : activityTableRows.filter(r => r.type === activityTypeFilter);
  const activityTotalPages = Math.max(1, Math.ceil(filteredActivityRows.length / ACTIVITY_TABLE_PAGE_SIZE));
  const activityCurrentPage = Math.min(activityPage, activityTotalPages);
  const pagedActivityRows = filteredActivityRows.slice(
    (activityCurrentPage - 1) * ACTIVITY_TABLE_PAGE_SIZE,
    activityCurrentPage * ACTIVITY_TABLE_PAGE_SIZE,
  );
  const profileItems = entityData.profiles.items;
  // Deleted accounts are gone from the org and hold no license - excluded
  // from this list entirely, same as computeUserBreakdown above it.
  const userItemsForPanel = entityData.users.items.filter(u => !isDeletedUser(u));

  function categoryLabelOf(category: ReportTab): string {
    return category === "changes" ? "Changes" : category === "integrations" ? "Integrations" : "Architecture";
  }

  function downloadReport(category: ReportTab) {
    const catRecs = recommendations.filter(r => r.category === category);
    const doc = buildReportPdf(`Recommended ${categoryLabelOf(category)}`, [
      { label: categoryLabelOf(category), recs: catRecs, headingOverride: "Recommendations" },
    ]);
    doc.save(`zoho-crm-${category}-report-${Date.now()}.pdf`);
  }

  function downloadFullReport() {
    const sections = (["changes", "integrations", "architecture"] as ReportTab[]).map(cat => ({
      label: categoryLabelOf(cat),
      recs: recommendations.filter(r => r.category === cat),
    }));
    const doc = buildReportPdf("Full CRM Audit Report", sections);
    doc.save(`zoho-crm-full-report-${Date.now()}.pdf`);
  }

  function buildReportPdf(
    headerTitle: string,
    sections: { label: string; recs: Recommendation[]; headingOverride?: string }[]
  ) {
    const ACCENT = "#185FA5";
    const TEXT = "#1A1A1A";
    const TEXT_MUTED = "#6B7280";
    const DANGER = "#A32D2D";
    const DANGER_BG = "#FCEBEB";
    const WARNING = "#854F0B";
    const WARNING_BG = "#FAEEDA";
    const SUCCESS = "#3B6D11";
    const SUCCESS_BG = "#EAF3DE";
    const BORDER = "#E2E8F0";
    const BG_ALT = "#F7F9FC";

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 42;
    const contentWidth = pageWidth - margin * 2;
    let y = 0;

    function drawHeader() {
      doc.setFillColor(ACCENT);
      doc.rect(0, 0, pageWidth, 96, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor("#DCEBFA");
      doc.text("ZOHO CRM AUDIT", margin, 34);
      doc.setFontSize(20);
      doc.setTextColor("#FFFFFF");
      doc.text(headerTitle, margin, 60);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor("#DCEBFA");
      doc.text(`Generated ${new Date().toLocaleString()}`, margin, 80);
      y = 130;
    }

    // autoTable adds its own pages independently of ensureSpace below, so the
    // page number must always be read live rather than tracked in a variable -
    // a manual counter would drift out of sync the moment a table spans pages.
    function drawFooter() {
      doc.setDrawColor(BORDER);
      doc.setLineWidth(0.5);
      doc.line(margin, pageHeight - 40, pageWidth - margin, pageHeight - 40);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(TEXT_MUTED);
      doc.text("Zoho CRM Audit Tool", margin, pageHeight - 24);
      doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, pageHeight - 24, { align: "right" });
    }

    function ensureSpace(h: number) {
      if (y + h > pageHeight - 56) {
        drawFooter();
        doc.addPage();
        drawHeader();
      }
    }

    function prettyStatus(s: string | null): string {
      if (!s) return "-";
      return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }

    function statusColor(label: string): string {
      const s = label.toLowerCase();
      if (s === "inactive" || s === "system hidden") return DANGER;
      if (s === "user hidden") return WARNING;
      if (s === "active" || s === "visible") return SUCCESS;
      return TEXT_MUTED;
    }

    drawHeader();

    // ── KPI strip ──
    const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityItemCount(e.type, entityData[e.type].items), 0);
    const errorCount = CRM_ENTITIES.filter(e => !!entityData[e.type].error).length;
    const allRecs = sections.flatMap(s => s.recs);
    const highCount = allRecs.filter(r => r.severity === "high").length;
    const kpis: { label: string; value: string; color: string }[] = [
      { label: "Total CRM Items", value: totalItems.toLocaleString(), color: ACCENT },
      { label: "Data Source Errors", value: String(errorCount), color: errorCount > 0 ? DANGER : SUCCESS },
      { label: "Recommendations", value: String(allRecs.length), color: ACCENT },
      { label: "High Severity", value: String(highCount), color: highCount > 0 ? DANGER : SUCCESS },
    ];
    const kpiGap = 10;
    const kpiWidth = (contentWidth - kpiGap * (kpis.length - 1)) / kpis.length;
    const kpiHeight = 46;
    kpis.forEach((k, i) => {
      const x = margin + i * (kpiWidth + kpiGap);
      doc.setDrawColor(BORDER);
      doc.setLineWidth(0.75);
      doc.roundedRect(x, y - 14, kpiWidth, kpiHeight, 4, 4, "S");
      doc.setFillColor(k.color);
      doc.rect(x, y - 14, 3, kpiHeight, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(k.color);
      doc.text(k.value, x + 12, y + 8);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(TEXT_MUTED);
      doc.text(k.label, x + 12, y + 22);
    });
    y += kpiHeight + 24;

    // ── CRM Summary ──
    ensureSpace(30);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(TEXT);
    doc.text("CRM Summary", margin, y);
    y += 10;
    doc.setDrawColor(ACCENT);
    doc.setLineWidth(1.4);
    doc.line(margin, y, margin + 36, y);
    y += 22;

    const MAX_TABLE_ROWS = 300;
    const statusColX = margin + 160;

    CRM_ENTITIES.forEach(e => {
      const state = entityData[e.type];
      const isError = !!state.error;

      // Tool name is measured first (fixed at the right edge) so the status/error
      // column below can be wrapped to whatever width is actually left over -
      // drawing both at a fixed x with unbounded text is what let a long error
      // message run straight into the "via <tool>" label.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      const toolText = state.toolUsed ? `via ${state.toolUsed}` : "";
      const toolWidth = toolText ? doc.getTextWidth(toolText) : 0;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      const statusRaw = isError
        ? `Error - ${state.error}`
        : `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
      const availStatusWidth = pageWidth - margin - 8 - statusColX - (toolWidth ? toolWidth + 14 : 0);
      const statusLines = doc.splitTextToSize(statusRaw, Math.max(availStatusWidth, 90)) as string[];
      const headerHeight = Math.max(statusLines.length, 1) * 13 + 6;

      ensureSpace(headerHeight + 10);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(TEXT);
      doc.text(e.label, margin + 8, y);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(isError ? DANGER : TEXT);
      let sy = y;
      statusLines.forEach(line => {
        doc.text(line, statusColX, sy);
        sy += 13;
      });

      if (toolText) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(TEXT_MUTED);
        doc.text(toolText, pageWidth - margin - 8, y, { align: "right" });
      }

      y += headerHeight;

      // Actual item list (not just the count) rendered as a real table - large
      // entities (300+ modules/fields on a real org) read as an unscannable
      // wall of comma-separated text otherwise, and a table paginates itself.
      if (!isError && state.items.length > 0) {
        const shown = state.items.slice(0, MAX_TABLE_ROWS);
        const rows: RowInput[] = shown.map((it, idx) => [
          String(idx + 1),
          getItemName(it, idx),
          prettyStatus(getItemStatus(it)),
        ]);
        const truncated = state.items.length - shown.length;
        if (truncated > 0) {
          rows.push([
            { content: `+${truncated} more not shown`, colSpan: 3, styles: { fontStyle: "italic", textColor: TEXT_MUTED, halign: "left" } },
          ]);
        }

        autoTable(doc, {
          startY: y,
          head: [["#", "Name", "Status"]],
          body: rows,
          margin: { left: margin, right: margin, top: 108, bottom: 56 },
          styles: {
            font: "helvetica",
            fontSize: 8.5,
            cellPadding: 4,
            textColor: TEXT,
            lineColor: BORDER,
            lineWidth: 0.5,
            overflow: "linebreak",
          },
          headStyles: { fillColor: ACCENT, textColor: "#FFFFFF", fontStyle: "bold", fontSize: 8.5 },
          alternateRowStyles: { fillColor: BG_ALT },
          columnStyles: {
            0: { cellWidth: 24, halign: "center", textColor: TEXT_MUTED },
            2: { cellWidth: 96 },
          },
          didParseCell: data => {
            if (data.section === "body" && data.column.index === 2 && typeof data.cell.raw === "string") {
              data.cell.styles.textColor = statusColor(data.cell.raw);
            }
          },
          // autoTable paginates a big table on its own, invisibly to our manual
          // ensureSpace()/drawFooter() calls - without these hooks, every page
          // it adds mid-table would be missing the banner and/or footer.
          willDrawPage: () => drawHeader(),
          didDrawPage: () => drawFooter(),
        });

        y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
      } else {
        y += 12;
      }
    });

    // ── Recommendations (one section per category) ──
    sections.forEach((section, sIdx) => {
      const catRecs = section.recs;
      const headingText = section.headingOverride ?? `${section.label} Recommendations`;

      y += 22;
      ensureSpace(46);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(TEXT);
      doc.text(headingText, margin, y);
      const headingWidth = doc.getTextWidth(`${headingText} `);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(TEXT_MUTED);
      doc.text(`(${catRecs.length})`, margin + headingWidth + 4, y);
      y += 10;
      doc.setDrawColor(ACCENT);
      doc.setLineWidth(1.4);
      doc.line(margin, y, margin + 36, y);
      y += 26;

      if (catRecs.length === 0) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10);
        doc.setTextColor(TEXT_MUTED);
        doc.text("No recommendations in this category.", margin, y);
        y += 20;
      } else {
        catRecs.forEach((r, i) => {
          const sevColor = r.severity === "high" ? DANGER : r.severity === "medium" ? WARNING : SUCCESS;
          const sevBg = r.severity === "high" ? DANGER_BG : r.severity === "medium" ? WARNING_BG : SUCCESS_BG;

          doc.setFont("helvetica", "bold");
          doc.setFontSize(10.5);
          const titleLines = doc.splitTextToSize(`${i + 1}. ${r.title}`, contentWidth - 100) as string[];
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          const descLines = doc.splitTextToSize(r.description, contentWidth - 28) as string[];
          const blockHeight = 22 + titleLines.length * 14 + 6 + descLines.length * 13 + 12;

          ensureSpace(blockHeight + 14);

          const blockTop = y - 14;
          doc.setDrawColor(BORDER);
          doc.setLineWidth(0.75);
          doc.roundedRect(margin, blockTop, contentWidth, blockHeight, 4, 4, "S");
          doc.setFillColor(sevColor);
          doc.rect(margin, blockTop, 3, blockHeight, "F");

          // severity badge
          const badgeLabel = r.severity.toUpperCase();
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          const badgeWidth = doc.getTextWidth(badgeLabel) + 14;
          const badgeX = margin + contentWidth - badgeWidth - 12;
          doc.setFillColor(sevBg);
          doc.roundedRect(badgeX, blockTop + 10, badgeWidth, 15, 3, 3, "F");
          doc.setTextColor(sevColor);
          doc.text(badgeLabel, badgeX + badgeWidth / 2, blockTop + 20, { align: "center" });

          // title (wraps above the badge column)
          doc.setTextColor(TEXT);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(10.5);
          let ty = y;
          titleLines.forEach((line: string) => {
            doc.text(line, margin + 14, ty);
            ty += 14;
          });

          // description
          ty += 6;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          doc.setTextColor(TEXT_MUTED);
          descLines.forEach((line: string) => {
            doc.text(line, margin + 14, ty);
            ty += 13;
          });

          y = blockTop + blockHeight + 16;
        });
      }

      if (sIdx < sections.length - 1) {
        ensureSpace(20);
      }
    });

    drawFooter();
    return doc;
  }

  return (
    <div className="crm-overview">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="crm-header">
        <div className="crm-header-left">
          <span className="crm-header-icon">◉</span>
          <div>
            <h2 className="crm-header-title">Data & Recommendations</h2>
            {loadingCount === 0 && (
              <p className="crm-header-sub">
                {`${totalItems.toLocaleString()} total items across ${loadedCount} sources`}
                {lastRefresh && ` · Updated ${formatRelative(lastRefresh)}`}
              </p>
            )}
          </div>
        </div>
        <div className="crm-header-actions">
          {loadingCount > 0 && <span className="spinner" />}
          <Button variant="outline" size="sm" onClick={fetchAll} disabled={loadingCount > 0}>
            ↺ Refresh All
          </Button>
          <Button size="sm" onClick={downloadFullReport}>
            ↓ Download Full Report (PDF)
          </Button>
        </div>
      </div>

      {/* ── Data & Recommendations: card list (left) + detail panel (right) ──── */}
      <div className="crmov-master-detail">
      <div className="crmov-card-list">
        {kpis.flatMap(k => {
          const tile = (
            <button
              key={k.key}
              type="button"
              className={`crmov-card kpi-${k.severity} ${k.clickable ? "clickable" : ""} ${selectedCard === k.key ? "selected" : ""}`}
              onClick={k.clickable ? () => setSelectedCard(prev => (prev === k.key ? null : (k.key as CardKey))) : undefined}
              disabled={!k.clickable}
              data-tooltip={k.source}
            >
              <span className="kpi-tile-label">{k.label}</span>
              <span className="kpi-tile-value">{k.unknown ? "-" : k.value.toLocaleString()}</span>
              <span className="kpi-tile-note">{k.note}</span>
            </button>
          );
          // Workflows moved up here, right after Modules, instead of sitting
          // down in the CRM Configuration list with the other config rows -
          // per user request. Still the same workflowsRow data/severity, just
          // rendered in the kpi-card visual style since it's now sitting
          // among the kpi tiles.
          if (k.key !== "modules") return [tile];
          return [tile, (
            <button
              key="workflows"
              type="button"
              className={`crmov-card config-${workflowsRow.severity} ${selectedCard === "workflows" ? "selected" : ""}`}
              onClick={() => setSelectedCard(prev => (prev === "workflows" ? null : "workflows"))}
              data-tooltip={workflowsRow.source}
            >
              <span className="kpi-tile-label">{workflowsRow.label}</span>
              <span className="kpi-tile-value">{workflowsRow.value}</span>
              <span className="kpi-tile-note">{workflowsRow.status}</span>
            </button>
          )];
        })}
        <div className="crmov-card-list-divider">CRM Configuration</div>
        {displayConfigRows.map(row => {
          const cardKey: CardKey = row.key === "tasks" ? "activity" : (row.key as CardKey);
          return (
            <button
              key={row.key}
              type="button"
              className={`crmov-card config-${row.severity} ${selectedCard === cardKey ? "selected" : ""}`}
              onClick={() => setSelectedCard(prev => (prev === cardKey ? null : cardKey))}
              data-tooltip={row.source}
            >
              <span className="kpi-tile-label">{row.label}</span>
              <span className="kpi-tile-value">{row.value}</span>
              <span className="kpi-tile-note">{row.status}</span>
            </button>
          );
        })}
      </div>

      <div className="crmov-detail-panel" ref={detailPanelRef}>
      {selectedCard === null && (
        <div className="crmov-detail-placeholder">
          <p className="business-view-hint">Click a card on the left to see its details here.</p>
        </div>
      )}
      {selectedCard === "modules" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Modules - Active / Inactive / Empty</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.modules.error && entityData.modules.items.length === 0 ? (
            <PanelEmptyState state={entityData.modules} label="modules" onRetry={() => fetchEntity("modules")} />
          ) : (
          <>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation - Modules</span>
            </div>
            <ZiaRecBody {...ziaModuleInsight} />
          </div>
          <input
            type="text"
            className="kpi-drilldown-search"
            placeholder="Search modules…"
            value={drilldownSearch}
            onChange={e => setDrilldownSearch(e.target.value)}
          />
          <div className="kpi-drilldown-summary">
            {(["active", "hidden", "empty"] as ModuleCategory[]).map(cat => {
              const count = moduleBreakdown.filter(r => r.category === cat).length;
              const statClass = cat === "active" ? "good" : cat === "hidden" ? "neutral" : "bad";
              return (
                <button
                  key={cat}
                  className={`kpi-drilldown-stat kpi-drilldown-stat-clickable ${statClass} ${moduleFilter === cat ? "selected" : ""}`}
                  onClick={() => setModuleFilter(prev => (prev === cat ? "all" : cat))}
                >
                  {count} {MODULE_FILTER_LABELS[cat]}
                </button>
              );
            })}
            {moduleFilter !== "all" && (
              <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setModuleFilter("all")}>
                Show All
              </button>
            )}
          </div>
          <div className="kpi-drilldown-table kpi-drilldown-table-single">
            {moduleBreakdown
              .filter(row => moduleFilter === "all" || row.category === moduleFilter)
              .filter(row => matchesSearch(row.name, row.apiName))
              .map(row => (
              <div key={row.apiName} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module">{row.apiName}</span>
                {row.custom && <span className="kpi-drilldown-badge neutral">custom</span>}
                <span className={`kpi-drilldown-badge status-${row.category}`}>{MODULE_FILTER_LABELS[row.category]}</span>
              </div>
            ))}
          </div>
          </>
          )}
        </div>
      )}

      {selectedCard === "blueprints" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Blueprints: Active / Inactive / Draft</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.blueprints.error && entityData.blueprints.items.length === 0 ? (
            <PanelEmptyState state={entityData.blueprints} label="blueprints" onRetry={() => fetchEntity("blueprints")} />
          ) : (
          <>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation - Blueprints</span>
            </div>
            <ZiaRecBody {...ziaBlueprintInsight} />
          </div>
          <input
            type="text"
            className="kpi-drilldown-search"
            placeholder="Search blueprints…"
            value={drilldownSearch}
            onChange={e => setDrilldownSearch(e.target.value)}
          />
          <div className="kpi-drilldown-summary">
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable good ${blueprintFilter === "active" ? "selected" : ""}`}
              onClick={() => setBlueprintFilter(prev => (prev === "active" ? "all" : "active"))}
            >
              {blueprintBreakdown.filter(r => r.status === "active").length} Active
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${blueprintFilter === "inactive" ? "selected" : ""}`}
              onClick={() => setBlueprintFilter(prev => (prev === "inactive" ? "all" : "inactive"))}
            >
              {blueprintBreakdown.filter(r => r.status === "inactive").length} Inactive
            </button>
            {blueprintBreakdown.some(r => r.status === "draft") && (
              <button
                className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${blueprintFilter === "draft" ? "selected" : ""}`}
                onClick={() => setBlueprintFilter(prev => (prev === "draft" ? "all" : "draft"))}
              >
                {blueprintBreakdown.filter(r => r.status === "draft").length} Draft
              </button>
            )}
            {blueprintFilter !== "all" && (
              <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setBlueprintFilter("all")}>
                Show All
              </button>
            )}
          </div>
          <div className="kpi-drilldown-table kpi-drilldown-table-single">
            {blueprintBreakdown
              .filter(row => blueprintFilter === "all" || row.status === blueprintFilter)
              .filter(row => matchesSearch(row.name, row.module))
              .map(row => (
              <div key={row.id} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module">{row.module}</span>
                <span className={`kpi-drilldown-badge status-${row.status}`}>{row.status}</span>
              </div>
            ))}
          </div>
          </>
          )}
        </div>
      )}

      {selectedCard === "users" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Active Users - Active vs Inactive</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.users.error && entityData.users.items.length === 0 ? (
            <PanelEmptyState state={entityData.users} label="users" onRetry={() => fetchEntity("users")} />
          ) : (
          <>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation - Licenses</span>
            </div>
            <ZiaRecBody {...ziaUserInsight} />
          </div>
          <input
            type="text"
            className="kpi-drilldown-search"
            placeholder="Search users…"
            value={drilldownSearch}
            onChange={e => setDrilldownSearch(e.target.value)}
          />
          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good">{userBreakdown.filter(r => r.status === "active").length} Active</span>
            <span className="kpi-drilldown-stat bad">{userBreakdown.filter(r => r.status === "inactive").length} Inactive</span>
            {userLoginDataAvailable && (
              <>
                <span className="kpi-drilldown-stat good">{userBreakdown.filter(r => r.status === "active" && r.everLoggedIn).length} Used</span>
                <span className="kpi-drilldown-stat bad">{userBreakdown.filter(r => r.status === "active" && !r.everLoggedIn).length} Unused (active, never logged in)</span>
              </>
            )}
          </div>
          <div className="kpi-drilldown-table">
            {userBreakdown.filter(row => matchesSearch(row.name, row.profile, row.role)).map(row => (
              <div key={row.id} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module" data-tooltip={`Profile: ${row.profile}`}>{row.profile}</span>
                <span className="kpi-drilldown-module" data-tooltip={`Role: ${row.role}`}>{row.role}</span>
                {userLoginDataAvailable && row.status === "active" && (
                  <span
                    className={`kpi-drilldown-badge status-${row.everLoggedIn ? "active" : "inactive"}`}
                    data-tooltip={row.everLoggedIn ? "This user has logged in at least once." : "This user has never logged in, despite holding an active license."}
                  >
                    {row.everLoggedIn ? "used" : "unused"}
                  </span>
                )}
                <span className={`kpi-drilldown-badge status-${row.status}`}>{row.status}</span>
              </div>
            ))}
          </div>
          </>
          )}
        </div>
      )}

      {selectedCard === "schedules" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Schedules (Schedule-category Functions)</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {!functionRecords.listState.fetched ? (
            <p className="kpi-drilldown-progress"><span className="spinner" /> Fetching functions…</p>
          ) : scheduleBreakdown.length === 0 ? (
            <p className="business-view-hint">No Schedule-category functions found.</p>
          ) : (
            <>
              <div className="zia-rec zia-rec-medium activity-zia-rec">
                <div className="zia-rec-header">
                  <span className="zia-rec-icon">✦</span>
                  <span className="zia-rec-title">Zia Recommendation - Schedules</span>
                </div>
                <ZiaRecBody {...ziaScheduleInsight} />
              </div>
              <input
                type="text"
                className="kpi-drilldown-search"
                placeholder="Search schedules…"
                value={drilldownSearch}
                onChange={e => setDrilldownSearch(e.target.value)}
              />
              <div className="kpi-drilldown-summary">
                <span className="kpi-drilldown-stat good">{scheduleBreakdown.filter(r => r.active).length} Active</span>
                <span className="kpi-drilldown-stat bad">{scheduleBreakdown.filter(r => !r.active).length} Inactive</span>
              </div>
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {scheduleBreakdown.filter(row => matchesSearch(row.name)).map(row => (
                  <div key={row.id} className="kpi-drilldown-row">
                    <span className="kpi-drilldown-name">{row.name}</span>
                    <span className="kpi-drilldown-badge status-hidden" data-tooltip="Not exposed by the Functions API - guessed from the schedule's own name text (e.g. 'monthly', 'every_30_min'). Never a confirmed value.">Frequency: {row.frequency}</span>
                    <span className="kpi-drilldown-badge status-hidden" data-tooltip="Not exposed by the Functions API - there's no last-run/execution-history field, so this can't be confirmed true or false.">Never Triggered: Unknown</span>
                    {row.duplicate && <span className="kpi-drilldown-badge status-inactive" data-tooltip="Same schedule name used by another function - can't tell which job actually ran from the name alone.">Duplicate</span>}
                    <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {selectedCard === "functions" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Functions - Issues, Duplicates &amp; Code</h4>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                className="btn-secondary"
                onClick={() => functionRecords.rescan()}
                disabled={functionRecords.scanProgress.loading}
                data-tooltip="Re-fetch and re-check every function's code from scratch - use this if a scan failed or you just fixed something in Zoho."
              >
                {functionRecords.scanProgress.loading ? <><span className="spinner" /> Rescanning…</> : "↺ Rescan"}
              </button>
              <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
            </div>
          </div>

          {/* Recommendations stay visible regardless of which tab below is open */}
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation - Functions</span>
            </div>
            <ZiaRecBody {...functionZiaSummary} />
          </div>

          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good" data-tooltip="This function is enabled and can be triggered by its associated automation, button, or schedule.">{functionActiveCount} Active</span>
            <span className="kpi-drilldown-stat bad" data-tooltip="This function is disabled - it exists in Zoho but will not execute until re-enabled.">{functionInactiveCount} Inactive</span>
            <span className="kpi-drilldown-stat neutral" data-tooltip="Two or more functions share the exact same display name (case-insensitive), even though each has a unique API name underneath - easy to pick the wrong one from a list in Zoho's UI.">{functionDuplicates.length} Duplicate Names</span>
          </div>

          <div className="function-tabs">
            <button
              type="button"
              className={`function-tab ${functionsSubTab === "issues" ? "active" : ""}`}
              onClick={() => setFunctionsSubTab("issues")}
            >
              <span>Issues</span>
              <span className="function-tab-count">{sortedFunctionIssueRows.length}</span>
            </button>
            <button
              type="button"
              className={`function-tab ${functionsSubTab === "duplicates" ? "active" : ""}`}
              onClick={() => setFunctionsSubTab("duplicates")}
              data-tooltip="Functions matched on display name only (case-insensitive) - the underlying API name always stays unique."
            >
              <span>Duplicate Function Names</span>
              <span className="function-tab-count">{functionDuplicates.length}</span>
            </button>
          </div>

          <input
            type="text"
            className="kpi-drilldown-search"
            placeholder="Search functions…"
            value={drilldownSearch}
            onChange={e => setDrilldownSearch(e.target.value)}
          />

          {functionsSubTab === "issues" && (
            <>
              {functionRecords.scanProgress.loading && (
                <p className="kpi-drilldown-progress">
                  <span className="spinner" /> Scanning function code for issues… {functionRecords.scanProgress.done} of {functionRecords.scanProgress.total}
                </p>
              )}
              {!functionRecords.scanProgress.loading && functionRecords.scanProgress.total > 0 && (
                <p className="kpi-drilldown-note">
                  Scanned {scannedFnCount} of {functionRecords.items.length} functions
                  {scannedFnCount >= FUNCTION_CODE_SCAN_CAP && scannedFnCount < functionRecords.items.length ? ` (capped at ${FUNCTION_CODE_SCAN_CAP})` : ""}
                  {scannedFnCount > 0 ? ` - ${functionsWithIssuesPct}% have at least one flagged issue.` : "."}
                </p>
              )}
              {!functionRecords.scanProgress.loading && sortedFunctionIssueRows.length === 0 && scannedFnCount > 0 && (
                <p className="business-view-hint">No issues flagged in the functions scanned.</p>
              )}
              {sortedFunctionIssueRows.length > 0 && (
                <>
                  {/* Criteria/type filter, clickable, at the top - only categories
                      actually present get a button, so this never shows a dozen
                      dead filters for an org with just a couple real issue types. */}
                  <div className="kpi-drilldown-summary">
                    <button
                      className={`kpi-drilldown-stat kpi-drilldown-stat-clickable ${issueTypeFilter === "all" ? "selected" : ""}`}
                      onClick={() => setIssueTypeFilter("all")}
                    >
                      {functionIssueGroups.length} All
                    </button>
                    {presentIssueCategories.map(cat => {
                      const count = functionIssueGroups.filter(g => g.issues.some(i => i.category === cat)).length;
                      return (
                        <button
                          key={cat}
                          className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${issueTypeFilter === cat ? "selected" : ""}`}
                          onClick={() => setIssueTypeFilter(prev => (prev === cat ? "all" : cat))}
                        >
                          {count} {ISSUE_CATEGORY_LABELS[cat]}
                        </button>
                      );
                    })}
                  </div>
                  <div className="kpi-drilldown-table kpi-drilldown-table-single">
                    {pagedIssueGroups.map(group => {
                      const isExpanded = expandedIssueFunctions.has(group.id);
                      // When a type filter is active, only that function's
                      // matching issues show once expanded - not every issue it
                      // has, which would contradict the filter someone just clicked.
                      const visibleIssues = issueTypeFilter === "all" ? group.issues : group.issues.filter(i => i.category === issueTypeFilter);
                      return (
                        <div key={group.id} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                          <button
                            className="function-dup-toggle"
                            onClick={() => setExpandedIssueFunctions(prev => {
                              const next = new Set(prev);
                              if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                              return next;
                            })}
                          >
                            <span className="kpi-drilldown-name">{group.functionName}</span>
                            <span className="kpi-drilldown-module">{group.moduleCategory}</span>
                            <span className={`kpi-drilldown-badge status-${group.worstSeverity === "high" ? "inactive" : group.worstSeverity === "medium" ? "draft" : "active"}`}>
                              {visibleIssues.length} issue{visibleIssues.length !== 1 ? "s" : ""}
                            </span>
                            <span className="function-dup-caret">{isExpanded ? "▾" : "▸"}</span>
                          </button>
                          {isExpanded && (
                            <>
                              <ul className="function-code-issues">
                                {visibleIssues.map((iss, i) => (
                                  <li key={i}>
                                    <span className={`kpi-drilldown-badge status-${iss.severity === "high" ? "inactive" : iss.severity === "medium" ? "draft" : "active"}`}>
                                      {ISSUE_CATEGORY_LABELS[iss.category]}
                                    </span> {iss.message}
                                  </li>
                                ))}
                              </ul>
                              <button className="btn-secondary function-preview-btn" onClick={() => toggleFunctionPreview(group.id)}>
                                {previewFunctionId === group.id ? "Hide Code" : "Preview Code"}
                              </button>
                              {previewFunctionId === group.id && (
                                <div className="function-code-preview">
                                  {functionRecords.codeByFnId[group.id]?.loading && (
                                    <p className="kpi-drilldown-progress"><span className="spinner" /> Downloading code from Zoho…</p>
                                  )}
                                  {functionRecords.codeByFnId[group.id]?.unavailable && (
                                    <p className="business-view-hint">Code not available for this function.</p>
                                  )}
                                  {functionRecords.codeByFnId[group.id]?.code && (
                                    <>
                                      <pre className="function-code-block"><code>{functionRecords.codeByFnId[group.id]!.code}</code></pre>
                                      <div className="zia-rec zia-rec-low activity-zia-rec">
                                        <div className="zia-rec-header">
                                          <span className="zia-rec-icon">✦</span>
                                          <span className="zia-rec-title">Zia Recommendation - Formatting &amp; Comments</span>
                                        </div>
                                        <ZiaRecBody {...reviewCodeQuality(functionRecords.codeByFnId[group.id]!.code!)} />
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {issueTotalPages > 1 && (
                    <div className="kpi-drilldown-pagination">
                      <button className="btn-secondary" disabled={issueCurrentPage <= 1} onClick={() => setIssuePage(p => Math.max(1, p - 1))}>← Prev</button>
                      <span>Page {issueCurrentPage} of {issueTotalPages} ({filteredIssueGroups.length} function{filteredIssueGroups.length !== 1 ? "s" : ""})</span>
                      <button className="btn-secondary" disabled={issueCurrentPage >= issueTotalPages} onClick={() => setIssuePage(p => Math.min(issueTotalPages, p + 1))}>Next →</button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {functionsSubTab === "duplicates" && (
            functionDuplicates.length === 0 ? (
              <p className="business-view-hint">No duplicate function names found.</p>
            ) : (
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {functionDuplicates.filter(group => matchesSearch(group.name)).map(group => {
                  const isExpanded = !collapsedFunctionDuplicates.has(group.name);
                  return (
                  <div key={group.name} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                    <button
                      className="function-dup-toggle"
                      onClick={() => setCollapsedFunctionDuplicates(prev => {
                        const next = new Set(prev);
                        if (next.has(group.name)) next.delete(group.name); else next.add(group.name);
                        return next;
                      })}
                      data-tooltip={functionDuplicateTooltip(group)}
                    >
                      <span className="kpi-drilldown-name">{group.name}</span>
                      <span className="kpi-drilldown-badge neutral">{group.items.length}×</span>
                      <span className="function-dup-caret">{isExpanded ? "▾" : "▸"}</span>
                    </button>
                    {isExpanded && (
                      <div className="kpi-drilldown-layout-names">
                        {group.items.map(it => (
                          <span key={it.id} className="kpi-drilldown-layout-chip custom" data-tooltip={`API name: ${it.apiName || "-"} · Category: ${it.category} · Association ID: ${it.id}`}>{it.apiName || it.id} · {it.category}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )
          )}

          {functionsSubTab === "all" && (() => {
            const filteredFunctions = functionRecords.items.filter(fn => matchesSearch(fn.name, fn.category));
            return (
            <>
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {(functionsListExpanded ? filteredFunctions : filteredFunctions.slice(0, 8)).map(fn => (
                  <div key={fn.id} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                    <div className="kpi-drilldown-row-top">
                      <span className="kpi-drilldown-name">{fn.name}</span>
                      <span className="kpi-drilldown-module">{fn.category}</span>
                      <span className={`kpi-drilldown-badge status-${fn.active ? "active" : "inactive"}`}>{fn.active ? "active" : "inactive"}</span>
                      <button className="btn-secondary function-preview-btn" onClick={() => toggleFunctionPreview(fn.id)}>
                        {previewFunctionId === fn.id ? "Hide Code" : "Preview Code"}
                      </button>
                    </div>
                    {previewFunctionId === fn.id && (
                      <div className="function-code-preview">
                        {functionRecords.codeByFnId[fn.id]?.loading && (
                          <p className="kpi-drilldown-progress"><span className="spinner" /> Downloading code from Zoho…</p>
                        )}
                        {functionRecords.codeByFnId[fn.id]?.unavailable && (
                          <p className="business-view-hint">Code not available for this function.</p>
                        )}
                        {functionRecords.codeByFnId[fn.id]?.code && (
                          <>
                            <pre className="function-code-block"><code>{functionRecords.codeByFnId[fn.id]!.code}</code></pre>

                            <div className="zia-rec zia-rec-low activity-zia-rec">
                              <div className="zia-rec-header">
                                <span className="zia-rec-icon">✦</span>
                                <span className="zia-rec-title">Zia Recommendation - Formatting &amp; Comments</span>
                              </div>
                              <ZiaRecBody {...reviewCodeQuality(functionRecords.codeByFnId[fn.id]!.code!)} />
                            </div>

                            <strong className="function-code-issues-label">Recommendations for this function</strong>
                            {(functionRecords.issuesByFnId[fn.id]?.length ?? 0) > 0 ? (
                              <ul className="function-code-issues">
                                {sortIssuesBySeverity(functionRecords.issuesByFnId[fn.id]!).map((iss, i) => (
                                  <li key={i}>
                                    <span className={`kpi-drilldown-badge status-${iss.severity === "high" ? "inactive" : iss.severity === "medium" ? "draft" : "active"}`}>
                                      {ISSUE_CATEGORY_LABELS[iss.category]}
                                    </span> {iss.message}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="business-view-hint">No issues flagged in this function.</p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {filteredFunctions.length > 8 && !functionsListExpanded && (
                <button className="cost-cards-more" onClick={() => setFunctionsListExpanded(true)}>
                  + {filteredFunctions.length - 8} more functions
                </button>
              )}
            </>
            );
          })()}
        </div>
      )}

      {selectedCard === "pipelines" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Pipeline Stages</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {pipelineStages.loading && (
            <p className="kpi-drilldown-progress"><span className="spinner" /> Fetching pipeline stages…</p>
          )}
          {!pipelineStages.loading && pipelineStages.error && (
            <p className="business-view-hint">⚠ {pipelineStages.error}</p>
          )}
          {!pipelineStages.loading && !pipelineStages.error && pipelineStages.pipelines.length === 0 && (
            <p className="business-view-hint">No pipeline stages were found on your Deals layout.</p>
          )}
          {!pipelineStages.loading && pipelineStages.pipelines.length > 0 && (
            <>
            <input
              type="text"
              className="kpi-drilldown-search"
              placeholder="Search stages…"
              value={drilldownSearch}
              onChange={e => setDrilldownSearch(e.target.value)}
            />
            {pipelineStages.pipelines.map(pipeline => {
              const stages = pipeline.stages.filter(stage => matchesSearch(stage.name));
              if (stages.length === 0) return null;
              return (
                <div key={pipeline.id} className="kpi-drilldown-pipeline-group">
                  <div className="kpi-drilldown-pipeline-name">
                    {pipeline.name}
                    {pipeline.isDefault && <span className="kpi-drilldown-badge neutral">Default</span>}
                  </div>
                  <div className="kpi-drilldown-table kpi-drilldown-table-single">
                    {stages.map((stage, i) => (
                      <div key={stage.apiName} className="kpi-drilldown-row">
                        <span className="kpi-drilldown-stage-seq">{i + 1}</span>
                        <span className="kpi-drilldown-name">{stage.name}</span>
                        {stage.outOfOrder && (
                          <span className="kpi-drilldown-badge status-inactive" title="This stage is sequenced after a Closed Won/Lost stage">Out of order</span>
                        )}
                        {stage.forecastType && <span className="kpi-drilldown-badge neutral">{stage.forecastType}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            </>
          )}
        </div>
      )}

      {selectedCard === "workflows" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Workflows - Active / Inactive / Duplicate / Overlapping</h4>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                className="btn-secondary"
                onClick={() => workflowDetails.rescan()}
                disabled={workflowDetails.scanProgress.loading}
                data-tooltip="Re-fetch each workflow's real criteria and actions from scratch - the list view alone can't tell two workflows apart beyond module/trigger, so this verifies duplicate/overlap matches against the actual configuration."
              >
                {workflowDetails.scanProgress.loading ? <><span className="spinner" /> Verifying…</> : "↺ Rescan"}
              </button>
              <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
            </div>
          </div>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation - Workflows</span>
            </div>
            <ZiaRecBody {...ziaWorkflowInsight} />
          </div>
          {workflowDetails.scanProgress.loading && (
            <p className="kpi-drilldown-progress">
              <span className="spinner" /> Verifying real criteria &amp; actions per workflow… {workflowDetails.scanProgress.done} of {workflowDetails.scanProgress.total}
            </p>
          )}
          {!workflowDetails.scanProgress.loading && workflowDetails.scanProgress.total > 0 && (
            <p className="kpi-drilldown-note">
              Verified {Object.values(workflowDetails.detailByWfId).filter(d => !d.unavailable).length} of {workflowDetails.scanProgress.total} workflows
              {workflowDetails.scanProgress.total < entityData.workflows.items.length ? ` (capped at ${WORKFLOW_DETAIL_SCAN_CAP})` : ""} against their real configuration - duplicate/overlap matches below reflect actual criteria and actions, not just module/trigger.
            </p>
          )}
          <input
            type="text"
            className="kpi-drilldown-search"
            placeholder="Search workflows…"
            value={drilldownSearch}
            onChange={e => setDrilldownSearch(e.target.value)}
          />
          <div className="kpi-drilldown-summary">
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable good ${workflowFilter === "active" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "active" ? "all" : "active"))}
              data-tooltip={WORKFLOW_ACTIVE_TOOLTIP}
            >
              {workflowBreakdown.filter(r => r.active).length} Active
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${workflowFilter === "inactive" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "inactive" ? "all" : "inactive"))}
              data-tooltip={WORKFLOW_INACTIVE_TOOLTIP}
            >
              {workflowBreakdown.filter(r => !r.active).length} Inactive
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${workflowFilter === "never" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "never" ? "all" : "never"))}
              data-tooltip="Active or inactive workflows with no recorded execution yet - never matched their trigger criteria, or this MCP connection doesn't expose execution history."
            >
              {workflowBreakdown.filter(r => !r.lastTriggered).length} Never Triggered
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${workflowFilter === "long-trigger" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "long-trigger" ? "all" : "long-trigger"))}
              data-tooltip={WORKFLOW_LONG_TRIGGER_TOOLTIP}
            >
              {workflowBreakdown.filter(r => r.longTrigger).length} Idle 90+ Days
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${workflowFilter === "duplicate" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "duplicate" ? "all" : "duplicate"))}
              data-tooltip="Shares the exact same display name (case-insensitive) as another workflow, regardless of module, trigger, criteria, or actions"
            >
              {workflowBreakdown.filter(r => r.duplicate).length} Duplicate
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${workflowFilter === "overlapping" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "overlapping" ? "all" : "overlapping"))}
              data-tooltip="Shares a module + trigger event with another active rule"
            >
              {workflowBreakdown.filter(r => r.overlapping).length} Overlapping
            </button>
            {workflowFilter !== "all" && (
              <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setWorkflowFilter("all")}>
                Show All
              </button>
            )}
          </div>
          {workflowFilter === "duplicate" ? (
            workflowDuplicateGroups.length === 0 ? (
              <p className="business-view-hint">No duplicate workflows found.</p>
            ) : (
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {workflowDuplicateGroups
                  .filter(group => matchesSearch(group.condition, ...group.items.map(it => it.name)))
                  .map(group => {
                    const isExpanded = !collapsedWorkflowDuplicates.has(group.key);
                    return (
                    <div key={group.key} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                      <button
                        className="function-dup-toggle"
                        onClick={() => setCollapsedWorkflowDuplicates(prev => {
                          const next = new Set(prev);
                          if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                          return next;
                        })}
                        data-tooltip={`Matched on - ${group.condition}. Detected ${group.items.length} times total.`}
                      >
                        <span className="kpi-drilldown-name">{group.condition}</span>
                        <span className="kpi-drilldown-badge neutral">{group.items.length}×</span>
                        <span className="function-dup-caret">{isExpanded ? "▾" : "▸"}</span>
                      </button>
                      {isExpanded && (
                        <div className="kpi-drilldown-layout-names">
                          {group.items.map(it => (
                            <span key={it.id} className="kpi-drilldown-layout-chip custom" data-tooltip={`Workflow ID: ${it.id}`}>{it.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    );
                  })}
              </div>
            )
          ) : workflowFilter === "overlapping" ? (
            workflowOverlapGroups.length === 0 ? (
              <p className="business-view-hint">No overlapping workflows found.</p>
            ) : (
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {workflowOverlapGroups
                  .filter(group => matchesSearch(group.condition, ...group.items.map(it => it.name)))
                  .map(group => {
                    const isExpanded = !collapsedWorkflowOverlaps.has(group.key);
                    return (
                    <div key={group.key} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                      <button
                        className="function-dup-toggle"
                        onClick={() => setCollapsedWorkflowOverlaps(prev => {
                          const next = new Set(prev);
                          if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                          return next;
                        })}
                        data-tooltip={`Matched on - ${group.condition}. ${group.items.length} active workflows race on this event.`}
                      >
                        <span className="kpi-drilldown-name">{group.condition}</span>
                        <span className="kpi-drilldown-badge neutral">{group.items.length}×</span>
                        <span className="function-dup-caret">{isExpanded ? "▾" : "▸"}</span>
                      </button>
                      {isExpanded && (
                        <div className="kpi-drilldown-layout-names">
                          {group.items.map(it => (
                            <span key={it.id} className="kpi-drilldown-layout-chip custom" data-tooltip={`Workflow ID: ${it.id}`}>{it.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    );
                  })}
              </div>
            )
          ) : (
            <div className="kpi-drilldown-table kpi-drilldown-table-single">
              {workflowBreakdown
                .filter(row => matchesWorkflowFilter(row, workflowFilter))
                .filter(row => matchesSearch(row.name, row.module))
                .map(row => (
                <div key={row.id} className="kpi-drilldown-row">
                  <span className="kpi-drilldown-name">{row.name}</span>
                  <span className="kpi-drilldown-module">{row.module}</span>
                  <span className={`kpi-drilldown-date ${!row.lastTriggered ? "never" : row.longTrigger ? "long-trigger" : ""}`} data-tooltip={workflowLastTriggeredTooltip(row)}>{formatLastTriggered(row.lastTriggered)}</span>
                  {row.longTrigger && <span className="kpi-drilldown-badge status-draft" data-tooltip={WORKFLOW_LONG_TRIGGER_TOOLTIP}>idle 90+ days</span>}
                  {row.duplicate && <span className="kpi-drilldown-badge status-inactive" data-tooltip={row.duplicateDetail ?? "Same display name as another workflow"}>duplicate</span>}
                  {row.overlapping && <span className="kpi-drilldown-badge status-inactive" data-tooltip={row.overlappingDetail ?? "Shares a module + trigger event with another active rule"}>overlapping</span>}
                  <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`} data-tooltip={row.active ? WORKFLOW_ACTIVE_TOOLTIP : WORKFLOW_INACTIVE_TOOLTIP}>{row.active ? "active" : "inactive"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedCard === "layoutRules" && (
        <ModuleRuleScanPanel
          title="Layout Rules - Active / Inactive by Module"
          ziaTitle="Zia Recommendation - Layout Rules"
          ziaInsight={ziaLayoutRuleInsight}
          scan={layoutRuleScan}
          search={drilldownSearch}
          onSearchChange={setDrilldownSearch}
          matchesSearch={matchesSearch}
          onClose={() => setSelectedCard(null)}
        />
      )}

      {selectedCard === "validationRules" && (
        <ModuleRuleScanPanel
          title="Validation Rules - Active / Inactive by Module"
          ziaTitle="Zia Recommendation - Validation Rules"
          ziaInsight={ziaValidationRuleInsight}
          scan={validationRuleScan}
          search={drilldownSearch}
          onSearchChange={setDrilldownSearch}
          matchesSearch={matchesSearch}
          onClose={() => setSelectedCard(null)}
        />
      )}

      {selectedCard === "assignmentRules" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Assignment Rules - Active / Inactive</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.assignmentRules.error && entityData.assignmentRules.items.length === 0 ? (
            <PanelEmptyState state={entityData.assignmentRules} label="assignment rules" onRetry={() => fetchEntity("assignmentRules")} />
          ) : (
            <>
            <div className="zia-rec zia-rec-medium activity-zia-rec">
              <div className="zia-rec-header">
                <span className="zia-rec-icon">✦</span>
                <span className="zia-rec-title">Zia Recommendation - Assignment Rules</span>
              </div>
              <ZiaRecBody {...ziaAssignmentRuleInsight} />
            </div>
            <input
              type="text"
              className="kpi-drilldown-search"
              placeholder="Search assignment rules…"
              value={drilldownSearch}
              onChange={e => setDrilldownSearch(e.target.value)}
            />
            {(() => {
              const assignmentRuleRows = itemsToRuleRows(entityData.assignmentRules.items);
              const assignmentDupNames = duplicateRuleNameSet(duplicateRuleGroups(assignmentRuleRows));
              return (
                <>
                <div className="kpi-drilldown-summary">
                  <button
                    className={`kpi-drilldown-stat kpi-drilldown-stat-clickable good ${assignmentRuleFilter === "active" ? "selected" : ""}`}
                    onClick={() => setAssignmentRuleFilter(prev => (prev === "active" ? "all" : "active"))}
                  >
                    {assignmentRuleRows.filter(r => r.active).length} Active
                  </button>
                  <button
                    className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${assignmentRuleFilter === "inactive" ? "selected" : ""}`}
                    onClick={() => setAssignmentRuleFilter(prev => (prev === "inactive" ? "all" : "inactive"))}
                  >
                    {assignmentRuleRows.filter(r => !r.active).length} Inactive
                  </button>
                  <button
                    className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${assignmentRuleFilter === "duplicate" ? "selected" : ""}`}
                    onClick={() => setAssignmentRuleFilter(prev => (prev === "duplicate" ? "all" : "duplicate"))}
                  >
                    {assignmentRuleRows.filter(r => assignmentDupNames.has(r.name.trim().toLowerCase())).length} Duplicate
                  </button>
                  {assignmentRuleFilter !== "all" && (
                    <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setAssignmentRuleFilter("all")}>Show All</button>
                  )}
                </div>
                <div className="kpi-drilldown-table kpi-drilldown-table-single">
                  {assignmentRuleRows
                    .map(row => ({ ...row, duplicate: assignmentDupNames.has(row.name.trim().toLowerCase()) }))
                    .filter(row => assignmentRuleFilter === "all" || (assignmentRuleFilter === "duplicate" ? row.duplicate : (assignmentRuleFilter === "active") === row.active))
                    .filter(row => matchesSearch(row.name, row.module))
                    .map((row, idx) => (
                      <div key={row.name + idx} className="kpi-drilldown-row">
                        <span className="kpi-drilldown-name">{row.name}</span>
                        <span className="kpi-drilldown-module">{row.module || "-"}</span>
                        {row.duplicate && <span className="kpi-drilldown-badge status-inactive" data-tooltip="Same rule name used elsewhere in the org">duplicate</span>}
                        <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
                      </div>
                    ))}
                </div>
                </>
              );
            })()}
            </>
          )}
        </div>
      )}

      {selectedCard === "approvalRules" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Approval Rules - Active / Inactive</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.approvalRules.error && entityData.approvalRules.items.length === 0 ? (
            <PanelEmptyState state={entityData.approvalRules} label="approval rules" onRetry={() => fetchEntity("approvalRules")} />
          ) : (
            <>
            <div className="zia-rec zia-rec-medium activity-zia-rec">
              <div className="zia-rec-header">
                <span className="zia-rec-icon">✦</span>
                <span className="zia-rec-title">Zia Recommendation - Approval Rules</span>
              </div>
              <ZiaRecBody {...ziaApprovalRuleInsight} />
            </div>
            <input
              type="text"
              className="kpi-drilldown-search"
              placeholder="Search approval rules…"
              value={drilldownSearch}
              onChange={e => setDrilldownSearch(e.target.value)}
            />
            {(() => {
              const approvalRuleRows = itemsToRuleRows(entityData.approvalRules.items);
              const approvalDupNames = duplicateRuleNameSet(duplicateRuleGroups(approvalRuleRows));
              return (
                <>
                <div className="kpi-drilldown-summary">
                  <button
                    className={`kpi-drilldown-stat kpi-drilldown-stat-clickable good ${approvalRuleFilter === "active" ? "selected" : ""}`}
                    onClick={() => setApprovalRuleFilter(prev => (prev === "active" ? "all" : "active"))}
                  >
                    {approvalRuleRows.filter(r => r.active).length} Active
                  </button>
                  <button
                    className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${approvalRuleFilter === "inactive" ? "selected" : ""}`}
                    onClick={() => setApprovalRuleFilter(prev => (prev === "inactive" ? "all" : "inactive"))}
                  >
                    {approvalRuleRows.filter(r => !r.active).length} Inactive
                  </button>
                  <button
                    className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${approvalRuleFilter === "duplicate" ? "selected" : ""}`}
                    onClick={() => setApprovalRuleFilter(prev => (prev === "duplicate" ? "all" : "duplicate"))}
                  >
                    {approvalRuleRows.filter(r => approvalDupNames.has(r.name.trim().toLowerCase())).length} Duplicate
                  </button>
                  {approvalRuleFilter !== "all" && (
                    <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setApprovalRuleFilter("all")}>Show All</button>
                  )}
                </div>
                <div className="kpi-drilldown-table kpi-drilldown-table-single">
                  {approvalRuleRows
                    .map(row => ({ ...row, duplicate: approvalDupNames.has(row.name.trim().toLowerCase()) }))
                    .filter(row => approvalRuleFilter === "all" || (approvalRuleFilter === "duplicate" ? row.duplicate : (approvalRuleFilter === "active") === row.active))
                    .filter(row => matchesSearch(row.name, row.module))
                    .map((row, idx) => (
                      <div key={row.name + idx} className="kpi-drilldown-row">
                        <span className="kpi-drilldown-name">{row.name}</span>
                        <span className="kpi-drilldown-module">{row.module || "-"}</span>
                        {row.duplicate && <span className="kpi-drilldown-badge status-inactive" data-tooltip="Same process name used elsewhere in the org">duplicate</span>}
                        <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
                      </div>
                    ))}
                </div>
                </>
              );
            })()}
            </>
          )}
        </div>
      )}

      {selectedCard === "activity" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Activity - Email / Task / Call</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation - Recent Activity</span>
            </div>
            <div className="activity-zia-grid">
              <div className="activity-zia-item">
                <span className="activity-zia-label">Last Email</span>
                <span className="activity-zia-value">{ziaActivityInsight.lastEmail.date ? formatLastTriggered(ziaActivityInsight.lastEmail.date) : "None found"}</span>
              </div>
              <div className="activity-zia-item">
                <span className="activity-zia-label">Last Call</span>
                <span className="activity-zia-value">{ziaActivityInsight.lastCall.date ? formatLastTriggered(ziaActivityInsight.lastCall.date) : "None found"}</span>
              </div>
              <div className="activity-zia-item">
                <span className="activity-zia-label">Last Task Due</span>
                <span className="activity-zia-value">{ziaActivityInsight.lastTaskDue.date ? formatLastTriggered(ziaActivityInsight.lastTaskDue.date) : "None found"}</span>
              </div>
            </div>
            <ZiaRecBody {...ziaActivityInsight} />
          </div>

          <div className="activity-subkpi-grid">
            {activityStats.map(stat => (
              <div key={stat.key} className="activity-subkpi-tile">
                <span className="kpi-tile-label">{stat.label}</span>
                <span className="kpi-tile-value">{stat.loading ? "…" : stat.total.toLocaleString()}</span>
                <ul className="activity-subkpi-suggestion">
                  <li>{stat.suggestion}</li>
                </ul>
              </div>
            ))}
          </div>

          {activityTableRows.length > 0 && (
            <>
              <div className="kpi-drilldown-summary">
                {(["all", "email", "task", "call"] as const).map(t => {
                  const count = t === "all" ? activityTableRows.length : activityTableRows.filter(r => r.type === t).length;
                  return (
                    <button
                      key={t}
                      className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${activityTypeFilter === t ? "selected" : ""}`}
                      onClick={() => setActivityTypeFilter(t)}
                    >
                      {count} {t === "all" ? "All" : t === "email" ? "Email" : t === "task" ? "Task" : "Call"}
                    </button>
                  );
                })}
              </div>
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {pagedActivityRows.map(row => (
                  <div key={row.id} className="kpi-drilldown-row">
                    <span className="kpi-drilldown-badge status-hidden">{row.type}</span>
                    <span className={`kpi-drilldown-badge status-${row.severity === "good" ? "active" : row.severity === "bad" ? "inactive" : "hidden"}`}>{row.status}</span>
                    <span className="kpi-drilldown-module">{row.date ? formatLastTriggered(row.date) : "No date"}</span>
                  </div>
                ))}
              </div>
              {activityTotalPages > 1 && (
                <div className="kpi-drilldown-pagination">
                  <button className="btn-secondary" disabled={activityCurrentPage <= 1} onClick={() => setActivityPage(p => Math.max(1, p - 1))}>← Prev</button>
                  <span>Page {activityCurrentPage} of {activityTotalPages} ({filteredActivityRows.length} record{filteredActivityRows.length !== 1 ? "s" : ""})</span>
                  <button className="btn-secondary" disabled={activityCurrentPage >= activityTotalPages} onClick={() => setActivityPage(p => Math.min(activityTotalPages, p + 1))}>Next →</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {selectedCard === "profiles" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Profiles</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {profileItems.length === 0 ? (
            <PanelEmptyState state={entityData.profiles} label="Profiles" onRetry={() => fetchEntity("profiles")} />
          ) : (
            <>
            <input
              type="text"
              className="kpi-drilldown-search"
              placeholder="Search profiles…"
              value={drilldownSearch}
              onChange={e => setDrilldownSearch(e.target.value)}
            />
            <ul className="panel-item-list">
              {profileItems
                .map((item, idx) => ({ item, name: getItemName(item, idx) }))
                .filter(({ name }) => matchesSearch(name))
                .map(({ item, name }, idx) => {
                const admin = isAdminProfile(item);
                return (
                  <li key={idx} className="panel-item-row">
                    <span className="panel-avatar">{name.charAt(0).toUpperCase()}</span>
                    <span className="panel-item-body">
                      <span className="panel-item-name">{name}</span>
                      <span className="panel-item-sub">{admin ? "Full system access" : "Standard access"}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            </>
          )}
        </div>
      )}

      {selectedCard === "users" && (
        <div className="kpi-drilldown">
          <h5 className="kpi-drilldown-subheading">Full User List</h5>
          {userItemsForPanel.length === 0 ? (
            <PanelEmptyState state={entityData.users} label="Users" onRetry={() => fetchEntity("users")} />
          ) : (
            <ul className="panel-item-list">
              {userItemsForPanel
                .map((item, idx) => {
                  const name = getItemName(item, idx);
                  const r = (item ?? {}) as Record<string, unknown>;
                  const profileName = typeof r.profile === "object" && r.profile
                    ? String((r.profile as Record<string, unknown>).name ?? "-")
                    : String(r.role ?? "-");
                  return { item, idx, name, profileName };
                })
                .filter(({ name, profileName }) => matchesSearch(name, profileName))
                .map(({ item, idx, name, profileName }) => {
                const status = getItemStatus(item);
                return (
                  <li key={idx} className="panel-item-row">
                    <span className="panel-avatar">{name.charAt(0).toUpperCase()}</span>
                    <span className="panel-item-body">
                      <span className="panel-item-name">{name}</span>
                      <span className="panel-item-sub">{profileName}</span>
                    </span>
                    {status && (
                      <span className={`panel-item-badge ${status === "Active" ? "badge-active" : "badge-inactive"}`}>
                        {status}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      </div>
      </div>

      {/* ── Zia Recommendations ─────────────────────────────────────────────── */}
      <div className="crm-recs-section" ref={ziaRecsSectionRef}>
        <div className="crm-right">
          <div className="crm-right-header">
            <p className="crm-panel-label">Zia Recommendations</p>
            <div className="crm-right-header-actions">
              {ziaTool && (
                <span className="zia-tool-badge" title={ziaTool.description ?? ziaTool.name}>
                  ⚡ {ziaTool.name}
                </span>
              )}
              {filteredRecs.length > 0 && (
                <button
                  type="button"
                  className="zia-recs-expand-btn"
                  onClick={() => setZiaRecsExpanded(prev => !prev)}
                >
                  {ziaRecsExpanded ? "Collapse ↑" : "Expand ↓"}
                </button>
              )}
            </div>
          </div>

          <div className="zia-tabs">
            {(["changes", "integrations", "architecture"] as ReportTab[]).map(tab => {
              const count = recommendations.filter(r => r.category === tab).length;
              const highCount = recommendations.filter(r => r.category === tab && r.severity === "high").length;
              return (
                <button
                  key={tab}
                  className={`zia-tab ${activeTab === tab ? "active" : ""}`}
                  onClick={() => setActiveTab(tab)}
                >
                  <span>{tab === "changes" ? "Changes" : tab === "integrations" ? "Integrations" : "Architecture"}</span>
                  <span className={`zia-tab-count ${highCount > 0 ? "zia-tab-count-high" : ""}`}>{count}</span>
                </button>
              );
            })}
          </div>

          <div className={`zia-recs ${ziaRecsExpanded ? "zia-recs-expanded" : ""}`}>
            {filteredRecs.length === 0 ? (
              <div className="zia-recs-empty">No recommendations for this category.</div>
            ) : (
              filteredRecs.map(rec => {
                const rem = remediation[rec.id];
                return (
                  <div key={rec.id} className={`zia-rec zia-rec-${rec.severity}`}>
                    <div className="zia-rec-header">
                      <span className="zia-rec-icon">{rec.icon}</span>
                      <span className="zia-rec-title">{rec.title}</span>
                      <span className={`zia-rec-sev sev-${rec.severity}`}>
                        {rec.severity === "high" ? "HIGH" : rec.severity === "medium" ? "MED" : "LOW"}
                      </span>
                    </div>
                    <p className="zia-rec-desc">{rec.description}</p>
                    <button
                      className="btn-secondary zia-rec-remediate"
                      onClick={() => askZiaAbout(rec)}
                      disabled={rem?.loading}
                    >
                      {rem?.loading ? <span className="spinner" /> : rem ? "↺ Get remediation steps →" : "Get remediation steps →"}
                    </button>
                    {rem && !rem.loading && (
                      <div className="zia-rec-remediation">
                        <div className="zia-rec-remediation-header">
                          <span className="zia-rec-remediation-icon">✦</span>
                          <span>Remediation steps</span>
                        </div>
                        <div className="zia-rec-remediation-body">{rem.text}</div>
                        {rem.usage && (
                          <div className="zia-rec-token-usage">
                            <span className="zia-rec-token-pill">
                              {rem.usage.inputTokens + rem.usage.outputTokens} tokens
                            </span>
                            <span className="zia-rec-token-detail">
                              {rem.usage.inputTokens} in · {rem.usage.outputTokens} out
                            </span>
                            <span className="zia-rec-token-model">{rem.usage.model}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Ask Zia chat */}
          <div className="zia-chat">
            <p className="zia-chat-label">
              Ask Zia
              {ziaTool
                ? <span className="zia-chat-hint"> via {ziaTool.name}</span>
                : tools.length > 0
                  ? <span className="zia-chat-hint"> via {tools[0].name}</span>
                  : null
              }
            </p>
            <div className="zia-chat-messages" ref={chatMessagesRef}>
              {ziaMessages.length === 0 ? (
                <div className="zia-chat-empty">
                  Ask Zia anything about your CRM - process gaps, optimization ideas, or specific entities.
                </div>
              ) : (
                ziaMessages.map((msg, i) => (
                  <div key={i} className={`zia-msg zia-msg-${msg.role}`}>
                    {msg.isLoading ? (
                      <span className="evoai-typing"><span /><span /><span /></span>
                    ) : (
                      <span className="zia-msg-text">{msg.content}</span>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="zia-input-row">
              <input
                className="zia-input"
                type="text"
                placeholder={ziaTool ? `Ask about your CRM…` : "Ask about your CRM setup…"}
                value={ziaInput}
                onChange={e => setZiaInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendToZia()}
                disabled={ziaLoading || tools.length === 0}
              />
              <button
                className="btn-connect"
                onClick={() => sendToZia()}
                disabled={ziaLoading || !ziaInput.trim() || tools.length === 0}
              >
                {ziaLoading ? <span className="spinner" /> : "Ask"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Reports ─────────────────────────────────────────────────────────── */}
      <div className="crm-reports">
        <p className="crm-panel-label">Downloadable Reports</p>
        <div className="crm-report-grid">
          {(["changes", "integrations", "architecture"] as ReportTab[]).map(cat => {
            const catRecs = recommendations.filter(r => r.category === cat);
            const highCount = catRecs.filter(r => r.severity === "high").length;
            const medCount = catRecs.filter(r => r.severity === "medium").length;
            return (
              <div key={cat} className={`crm-report-card ${highCount > 0 ? "crm-report-urgent" : ""}`}>
                <div className="crm-report-top">
                  <span className="crm-report-icon">
                    {cat === "changes" ? "⚙" : cat === "integrations" ? "⧉" : "◧"}
                  </span>
                  <div className="crm-report-meta">
                    <span className="crm-report-title">
                      Recommended {cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </span>
                    <div className="crm-report-pills">
                      {highCount > 0 && <span className="crm-pill crm-pill-high">{highCount} High</span>}
                      {medCount > 0 && <span className="crm-pill crm-pill-med">{medCount} Med</span>}
                      <span className="crm-pill crm-pill-total">{catRecs.length} Total</span>
                    </div>
                  </div>
                </div>
                <ul className="crm-report-preview">
                  {catRecs.slice(0, 3).map(r => (
                    <li key={r.id}>
                      <button type="button" className="crm-report-preview-item crm-report-preview-item-clickable" onClick={() => jumpToRecommendations(cat)}>
                        <span className={`crm-dot dot-${r.severity}`} />
                        <span className="crm-report-preview-text">{r.title}</span>
                      </button>
                    </li>
                  ))}
                  {catRecs.length > 3 && (
                    <li>
                      <button type="button" className="crm-report-more crm-report-more-clickable" onClick={() => jumpToRecommendations(cat)}>
                        +{catRecs.length - 3} more items
                      </button>
                    </li>
                  )}
                </ul>
                <button className="btn-secondary crm-report-btn" onClick={() => downloadReport(cat)}>
                  ↓ Download PDF Report
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
