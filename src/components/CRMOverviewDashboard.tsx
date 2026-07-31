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
} from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import { isActiveWorkflow, isAdminProfile, isCustomModule, isInactiveUser, blueprintStatus, type BlueprintStatus, workflowModuleLabel, workflowLastTriggered, moduleApiName, isCustomLayout, isDeletedModule, isHiddenModule, isEmptyModule } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/businessScore";
import type { PipelineStagesState } from "@/lib/flowMapModel";
import { isScheduleTool } from "@/lib/useRuleCoverage";
import { analyzeFunctionScript, sortIssuesBySeverity, reviewCodeQuality, ISSUE_CATEGORY_LABELS, type FunctionIssue } from "@/lib/functionAnalysis";

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

// Functions naming/duplicate/failure health — like RuleCoverage (see
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
}

// Placeholder/test names left over from building or copy-pasting a function —
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
type FeedbackCategory = "general" | "feature" | "improvement" | "bug";

interface FeedbackEntry {
  id: string;
  name: string;
  category: FeedbackCategory;
  rating: number;
  message: string;
  timestamp: string;
}

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
  fetchEntity: (type: CrmEntityType) => Promise<void>;
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
  /** True when the underlying fetch failed and this count could not be confirmed — render "—", not a fake 0. */
  unknown?: boolean;
  /** Hover/click attribution: which tool this came from and how many records it saw — shown as a tooltip on the tile. */
  source: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// No \b around these — tool names are camelCase/PascalCase (e.g. "getZiaInsights"),
// so a word-boundary regex never matches inside the concatenated identifier.
const ZIA_PATTERNS = [/zia/i, /recommend/i, /analy[sz]/i, /insight/i, /suggest/i];

const QUERY_KEYS = ["query", "question", "prompt", "text", "message", "input", "search", "context"];

const FB_CATEGORIES: { value: FeedbackCategory; label: string; icon: string }[] = [
  { value: "general",     label: "General",         icon: "◎" },
  { value: "feature",     label: "Feature Request",  icon: "◈" },
  { value: "improvement", label: "Improvement",      icon: "⊞" },
  { value: "bug",         label: "Bug Report",       icon: "⚠" },
];

const FB_RATING_LABELS: Record<number, string> = {
  1: "Poor", 2: "Fair", 3: "Good", 4: "Great", 5: "Excellent",
};

const FB_STORAGE_KEY = "zoho-crm-feedback";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasQueryField(tool: McpTool): boolean {
  const props = tool.inputSchema?.properties ?? {};
  return Object.keys(props).some(k => QUERY_KEYS.includes(k.toLowerCase()));
}

// Zoho API errors often come back as a JSON string inside the tool's text
// output (e.g. {"code":"MANDATORY_NOT_FOUND",...}) — show it as a readable
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
  // Prefer a Zia-ish tool that actually accepts free text — avoids matching a
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
  functionHealth: FunctionHealth | null
): Recommendation[] {
  const recs: Recommendation[] = [];

  const wfs      = entityData.workflows.items;
  const bps      = entityData.blueprints.items;
  const mods     = entityData.modules.items.filter(m => !isDeletedModule(m));
  const pipes    = entityData.pipelines.items;
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
      description: `${inactiveBps.length} blueprint${inactiveBps.length > 1 ? "s are" : " is"} inactive. Reactivate needed processes or archive them to reduce confusion in process management.`,
      severity: "medium", category: "changes", icon: "◈",
    });
  }

  if (wfs.length > 20) {
    recs.push({
      id: "workflow-sprawl",
      title: "High Workflow Count — Consider Consolidation",
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

  // Functions — the shared entityData doesn't track custom functions (see
  // FunctionAudit.tsx, which fetches them separately), so naming/duplicate/
  // failure health is fetched independently (see functionHealth effect) and
  // falls back to a tool-presence check when that data isn't in yet.
  if (functionHealth) {
    const scannedNote = functionHealth.hasMore
      ? ` (based on the first ${functionHealth.totalScanned} scanned — your org has more)`
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
        description: `Multiple functions share the exact same name${scannedNote}: ${top}. Duplicate names make it impossible to tell which one a workflow or button actually calls — rename or delete the unused copies.`,
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
          description: `${functionHealth.failureCount} function run${functionHealth.failureCount !== 1 ? "s have" : " has"} failed recently. A failing function silently breaks whatever workflow, button, or blueprint action depends on it — check getAutomationFunctionFailures for the specific errors.`,
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
        description: `Scanned ${functionHealth.totalScanned} functions — no duplicate or placeholder names detected. Connect getAutomationFunctionFailures too so failed executions can be surfaced here as well.`,
        severity: "low", category: "changes", icon: "ƒ",
      });
    }
  } else {
    const hasFunctionTools = tools.some(t => /function/i.test(t.name));
    recs.push(hasFunctionTools ? {
      id: "audit-functions",
      title: "Audit Custom Functions for Orphaned Scripts",
      description: "Function tools are connected. Review your Deluge functions for ones no longer linked to any workflow, button, or blueprint action — orphaned functions still count against your org's script limits and are easy to lose track of. Check the Functions tab for the full breakdown.",
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
        description: `${adminCount} profiles have admin-level naming. Audit whether all of these actually require full administrator access — excess admin profiles are a security risk.`,
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
    const inactiveUsers = users.filter(u => {
      const r = u as Record<string, unknown>;
      return r.status === "Inactive" || r.active === false || r.enabled === false;
    });
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
        title: `${fields.length} Fields — Review for Redundancy`,
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

  if (pipes.length === 0) {
    recs.push({
      id: "zoho-campaigns",
      title: "Bridge Marketing with Zoho Campaigns",
      description: "No pipeline data found. Connect Zoho Campaigns to bridge marketing efforts with CRM — track lead conversion from campaigns and attribute revenue to marketing activities.",
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
      description: "Push CRM notifications — new leads, deal stage changes, task assignments — directly to Slack or Microsoft Teams channels for instant team awareness.",
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

  if (pipes.length > 5) {
    recs.push({
      id: "pipeline-consolidation",
      title: "Consolidate Sales Pipelines",
      description: `You have ${pipes.length} pipelines. Consider consolidating to 2-3 focused pipelines (e.g. New Business, Expansion, Renewal) to reduce complexity and improve forecast accuracy.`,
      severity: "medium", category: "architecture", icon: "⇥",
    });
  } else if (pipes.length === 0) {
    recs.push({
      id: "pipeline-setup",
      title: "Define a Structured Sales Pipeline",
      description: "No sales pipelines detected. Set up a clear pipeline with defined stages — Lead, Qualification, Proposal, Negotiation, Closed Won/Lost — to improve deal visibility and forecasting.",
      severity: "high", category: "architecture", icon: "⇥",
    });
  }

  if (bps.length > 0 && wfs.length > bps.length * 3) {
    recs.push({
      id: "blueprint-over-workflow",
      title: "Migrate Complex Workflows to Blueprints",
      description: `You have ${wfs.length} workflows but only ${bps.length} blueprints. Complex sequential processes should be modeled as Blueprints — they provide better visibility, audit trails, and enforce process adherence.`,
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
      title: `Review ${profiles.length} Profile${profiles.length > 1 ? "s" : ""} — Enforce Least Privilege`,
      description: `${profiles.length} profile${profiles.length > 1 ? "s are" : " is"} configured. Map each profile to specific modules and fields. Restrict module creation/deletion rights to managers only and read-only for standard roles.`,
      severity: "high", category: "architecture", icon: "◑",
    });
  } else {
    recs.push({
      id: "profile-access",
      title: "Audit Profile-Based Module Access",
      description: "Review which profiles have access to each module and sensitive fields. Apply the principle of least privilege — restrict data access to roles that genuinely need it.",
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
      description: `${fields.length} fields are in use. Establish a field registry — document each field's purpose, owner, and allowed values. Prevent duplicate fields by enforcing a naming convention before any new fields are added.`,
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
      description: `You have ${mods.length} modules. Audit custom modules for utilization — underused custom modules should be merged, repurposed, or decommissioned to reduce system complexity.`,
      severity: "low", category: "architecture", icon: "⊞",
    });
  }

  recs.push({
    id: "automation-hierarchy",
    title: "Define Automation Hierarchy: Field Updates → Workflows → Blueprints",
    description: "Establish clear rules: use field-level defaults for simple values, workflows for event-triggered notifications/updates, and blueprints for multi-step approval and process adherence.",
    severity: "medium", category: "architecture", icon: "⟳",
  });

  // Approval Process — real per-module counts when getApprovalRules is connected;
  // falls back to the general best-practice suggestion otherwise.
  const approvalEntries = ruleCoverage ? Object.entries(ruleCoverage.approval) : [];
  if (approvalEntries.length > 0) {
    const zeroApproval = approvalEntries.filter(([, count]) => count === 0).map(([name]) => name);
    if (zeroApproval.length > 0) {
      recs.push({
        id: "approval-process",
        title: `${zeroApproval.length} of ${approvalEntries.length} Core Modules Have No Approval Process`,
        description: `${zeroApproval.join(", ")} ${zeroApproval.length > 1 ? "have" : "has"} no approval process configured. Approval Processes require manager sign-off before a record change goes through — e.g. blocking a high-value deal or large discount from closing without review — instead of letting any rep close or edit sensitive records with no checkpoint.`,
        severity: "medium", category: "architecture", icon: "☑",
      });
    } else {
      recs.push({
        id: "approval-process",
        title: "Approval Processes Are Configured Across Core Modules",
        description: `All ${approvalEntries.length} core modules have at least one approval process (${approvalEntries.map(([n, c]) => `${n}: ${c}`).join(", ")}). Keep reviewing thresholds as deal sizes and discount policy change.`,
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

  // Assignment Rules — real per-module counts when getAssignmentRules is connected.
  const assignmentEntries = ruleCoverage ? Object.entries(ruleCoverage.assignment) : [];
  if (assignmentEntries.length > 0) {
    const zeroAssignment = assignmentEntries.filter(([, count]) => count === 0).map(([name]) => name);
    if (zeroAssignment.length > 0) {
      recs.push({
        id: "assignment-rules",
        title: `${zeroAssignment.length} of ${assignmentEntries.length} Core Modules Have No Assignment Rules`,
        description: `${zeroAssignment.join(", ")} ${zeroAssignment.length > 1 ? "have" : "has"} zero assignment rules configured. Assignment rules automatically route new records to the right rep or queue — e.g. sending Leads from a specific source straight to the SDR on rotation — instead of leaving them sitting unassigned until someone notices.`,
        severity: "medium", category: "architecture", icon: "➜",
      });
    } else {
      recs.push({
        id: "assignment-rules",
        title: "Assignment Rules Are Configured Across Core Modules",
        description: `All ${assignmentEntries.length} core modules have at least one assignment rule (${assignmentEntries.map(([n, c]) => `${n}: ${c}`).join(", ")}). Keep reviewing them as territories or reps change.`,
        severity: "low", category: "architecture", icon: "➜",
      });
    }
  } else {
    recs.push({
      id: "assignment-rules",
      title: "Add Assignment Rules to Route Records Automatically",
      description: "Assignment rules automatically route new records to the right rep or queue based on criteria like source, region, or product — e.g. sending Leads from a specific source straight to the SDR on rotation. Without one, new records sit unassigned until someone manually claims them.",
      severity: "medium", category: "architecture", icon: "➜",
    });
  }

  // Validation Rules — real per-module counts when getValidationRules is connected.
  const valEntries = ruleCoverage ? Object.entries(ruleCoverage.validation) : [];
  if (valEntries.length > 0) {
    const zeroVal = valEntries.filter(([, count]) => count === 0).map(([name]) => name);
    if (zeroVal.length > 0) {
      recs.push({
        id: "validation-rules",
        title: `${zeroVal.length} of ${valEntries.length} Core Modules Have No Validation Rules`,
        description: `${zeroVal.join(", ")} ${zeroVal.length > 1 ? "have" : "has"} zero validation rules configured. Validation rules stop bad data before it's ever saved — e.g. blocking a Closed Won deal with no amount, or an invalid email format — instead of relying on a workflow to clean it up afterward.`,
        severity: "medium", category: "architecture", icon: "⚑",
      });
    } else {
      recs.push({
        id: "validation-rules",
        title: "Validation Rules Are Configured Across Core Modules",
        description: `All ${valEntries.length} core modules have at least one validation rule (${valEntries.map(([n, c]) => `${n}: ${c}`).join(", ")}). Keep reviewing them as new fields and picklists get added.`,
        severity: "low", category: "architecture", icon: "⚑",
      });
    }
  } else {
    recs.push({
      id: "validation-rules",
      title: "Add Validation Rules to Enforce Data Quality at Entry",
      description: "Validation rules stop bad data before it's ever saved — e.g. blocking a Closed Won deal with no amount, or an email field with an invalid format. They catch mistakes at the source instead of relying on a workflow to clean them up afterward.",
      severity: "medium", category: "architecture", icon: "⚑",
    });
  }

  // Layout Rules — real per-module counts when getLayoutRules is connected.
  const layoutEntries = ruleCoverage ? Object.entries(ruleCoverage.layout) : [];
  if (layoutEntries.length > 0) {
    const zeroLayout = layoutEntries.filter(([, count]) => count === 0).map(([name]) => name);
    if (zeroLayout.length > 0) {
      recs.push({
        id: "layout-rules",
        title: `${zeroLayout.length} of ${layoutEntries.length} Core Modules Have No Layout Rules`,
        description: `${zeroLayout.join(", ")} ${zeroLayout.length > 1 ? "have" : "has"} no layout rules. They dynamically show, hide, or require fields based on other field values — e.g. only showing "Reason for Loss" once Stage is set to Closed Lost — so forms stay focused instead of showing every field to every rep.`,
        severity: "low", category: "architecture", icon: "⊡",
      });
    } else {
      recs.push({
        id: "layout-rules",
        title: "Layout Rules Are Configured Across Core Modules",
        description: `All ${layoutEntries.length} core modules have at least one layout rule (${layoutEntries.map(([n, c]) => `${n}: ${c}`).join(", ")}). Nice — reps only see fields relevant to the record they're on.`,
        severity: "low", category: "architecture", icon: "⊡",
      });
    }
  } else {
    recs.push({
      id: "layout-rules",
      title: "Use Layout Rules to Show Only Relevant Fields",
      description: "Layout rules dynamically show, hide, or require fields based on other field values — e.g. only showing \"Reason for Loss\" once Stage is set to Closed Lost. This keeps forms focused instead of showing every field to every rep regardless of context.",
      severity: "low", category: "architecture", icon: "⊡",
    });
  }

  // Schedules — an org-level count (not per-module) when getSchedules is connected.
  if (ruleCoverage && ruleCoverage.scheduleCount !== null) {
    if (ruleCoverage.scheduleCount === 0) {
      recs.push({
        id: "schedules",
        title: "No Schedules Configured for Recurring Automation",
        description: "This org has zero schedules set up. Schedules run workflows, functions, or blueprint actions automatically on a recurring cadence — e.g. a nightly cleanup of stale Leads or a weekly digest email — instead of relying on someone to trigger them by hand.",
        severity: "low", category: "architecture", icon: "◷",
      });
    } else {
      recs.push({
        id: "schedules",
        title: `${ruleCoverage.scheduleCount} Schedule${ruleCoverage.scheduleCount > 1 ? "s" : ""} Configured for Recurring Automation`,
        description: `This org has ${ruleCoverage.scheduleCount} schedule${ruleCoverage.scheduleCount > 1 ? "s" : ""} set up to run automation on a recurring cadence. Review them periodically to make sure they're still needed and pointed at the right functions or workflows.`,
        severity: "low", category: "architecture", icon: "◷",
      });
    }
  } else {
    recs.push({
      id: "schedules",
      title: "Use Schedules to Automate Recurring Tasks",
      description: "Schedules run workflows, functions, or blueprint actions automatically on a recurring cadence — e.g. nightly data cleanup or a weekly digest email — without needing a person to trigger them by hand.",
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

const MODULE_FILTER_LABELS: Record<ModuleCategory, string> = { active: "Active", hidden: "Hidden", empty: "Empty" };

interface ModuleBreakdownRow {
  apiName: string;
  name: string;
  category: ModuleCategory;
  custom: boolean;
}

// A module can technically be both hidden and empty at once — hidden takes
// priority since visibility is the more prominent state, so each module
// gets exactly one category for filtering rather than overlapping tags.
const MODULE_CATEGORY_ORDER: Record<ModuleCategory, number> = { hidden: 0, empty: 1, active: 2 };

// Sorted actionable-first (hidden, then empty, then active) — same
// convention as the blueprint/workflow breakdowns elsewhere in this file.
function computeModuleBreakdown(entityData: Record<CrmEntityType, EntityState>): ModuleBreakdownRow[] {
  return entityData.modules.items
    .filter(m => !isDeletedModule(m))
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

interface WorkflowBreakdownRow {
  id: string;
  name: string;
  module: string;
  active: boolean;
  lastTriggered: string | null;
}

// Sorted inactive-first, then never-triggered-first within active — same
// "surface the actionable ones" convention as the other breakdowns here.
function computeWorkflowBreakdown(entityData: Record<CrmEntityType, EntityState>): WorkflowBreakdownRow[] {
  return entityData.workflows.items
    .map((w, i) => ({
      id: String((w as Record<string, unknown> | null)?.id ?? i),
      name: getItemName(w, i),
      module: workflowModuleLabel(w) || "—",
      active: isActiveWorkflow(w),
      lastTriggered: workflowLastTriggered(w),
    }))
    .sort((a, b) => Number(a.active) - Number(b.active) || Number(!!a.lastTriggered) - Number(!!b.lastTriggered));
}

// "never" isn't mutually exclusive with active/inactive (an active workflow
// can genuinely have never fired yet), so each toggle applies its own
// independent predicate rather than assigning one category per row.
function matchesWorkflowFilter(row: WorkflowBreakdownRow, filter: "all" | "active" | "inactive" | "never"): boolean {
  if (filter === "all") return true;
  if (filter === "active") return row.active;
  if (filter === "inactive") return !row.active;
  return !row.lastTriggered;
}

function formatLastTriggered(iso: string | null): string {
  if (!iso) return "Never triggered";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Same "flag the stale ones, praise the healthy ones" synthesis as
// buildZiaActivityInsight below, applied to the workflow breakdown instead.
function buildZiaWorkflowInsight(rows: WorkflowBreakdownRow[]): { summary: string } {
  if (rows.length === 0) return { summary: "No workflows found — nothing to evaluate yet." };
  const inactive = rows.filter(r => !r.active).length;
  const neverTriggered = rows.filter(r => r.active && !r.lastTriggered).length;
  const flags: string[] = [];
  if (inactive > 0) flags.push(`${inactive} workflow${inactive !== 1 ? "s are" : " is"} inactive`);
  if (neverTriggered > 0) flags.push(`${neverTriggered} active workflow${neverTriggered !== 1 ? "s have" : " has"} never fired`);
  if (flags.length === 0) return { summary: "All workflows are active and have fired at least once — automation looks healthy." };
  return { summary: `Zia flags: ${flags.join("; ")}. Reactivate what's still needed, and fix or remove the rest — a workflow that never fires isn't protecting anything.` };
}

// ─── Activity (Email / Task / Call) drill-down ─────────────────────────────────
// Tasks already ride along in entityData (the "tasks" entity), but Calls and
// Emails aren't fetched anywhere else in this app — pulled in lazily here,
// only once the Activity tile is opened, the same on-demand pattern as
// useLayoutsByModule above, so a dashboard load that never opens this panel
// never pays for two extra API calls' worth of pagination.
interface ActivityFetchState {
  items: unknown[];
  loading: boolean;
  fetched: boolean;
  unavailable: boolean;
}

const ACTIVITY_FETCH_INIT: ActivityFetchState = { items: [], loading: false, fetched: false, unavailable: false };
const ACTIVITY_MAX_PAGES = 5;

function useActivityRecords(config: McpConfig | null, tools: McpTool[], active: boolean, onLog: (log: ExecutionLog) => void) {
  const [calls, setCalls] = useState<ActivityFetchState>(ACTIVITY_FETCH_INIT);
  const [emails, setEmails] = useState<ActivityFetchState>(ACTIVITY_FETCH_INIT);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!active || fetchedRef.current) return;
    if (!config || tools.length === 0) return;
    fetchedRef.current = true;

    const callsTool = tools.find(t => /getcalls$/i.test(t.name)) ?? tools.find(t => /listcalls|allcalls/i.test(t.name));
    const emailsTool = tools.find(t => /getemails$/i.test(t.name)) ?? tools.find(t => /listemails|allemails|sentemails/i.test(t.name));

    async function fetchOne(tool: McpTool | undefined, setState: React.Dispatch<React.SetStateAction<ActivityFetchState>>) {
      if (!tool) { setState(prev => ({ ...prev, unavailable: true })); return; }
      setState(prev => ({ ...prev, loading: true }));
      const pageLoc = findParam(findParamLocations(tool), /^page$/i);
      let items: unknown[] = [];
      for (let page = 1; page <= ACTIVITY_MAX_PAGES; page++) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        if (page > 1 && pageLoc) setParam(input, pageLoc, page);
        try {
          const output = await executeTool(config as McpConfig, tool.name, input);
          const pageItems = extractArray(output);
          items = items.concat(pageItems);
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          if (!pageLoc || pageItems.length === 0) break;
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          break;
        }
      }
      setState({ items, loading: false, fetched: true, unavailable: false });
    }

    void fetchOne(callsTool, setCalls);
    void fetchOne(emailsTool, setEmails);
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
    : taskTotal === 0 ? "No tasks logged in this CRM — reps may not be tracking follow-ups here at all."
    : taskOverdue > 0 ? `${taskOverdue} of ${taskTotal} tasks (${Math.round((taskOverdue / taskTotal) * 100)}%) are overdue — assign owners or set due-date reminders so leads don't go cold.`
    : "Tasks are being kept current — no overdue items right now.";

  const callTotal = calls.items.length;
  const callMissed = calls.items.filter(isMissedCall).length;
  const callSuggestion = calls.unavailable ? "No call-logging tool is connected — call activity can't be measured from here."
    : calls.loading ? "Fetching…"
    : callTotal === 0 ? "No calls logged against records — outreach may be happening outside the CRM, so you can't measure it."
    : callMissed > 0 ? `${callMissed} of ${callTotal} calls are logged as missed, no-answer, or cancelled — follow up before these leads go cold.`
    : "Calls are being logged consistently — no missed calls outstanding.";

  const emailTotal = emails.items.length;
  const emailSuggestion = emails.unavailable ? "No email-logging tool is connected — email activity can't be measured from here."
    : emails.loading ? "Fetching…"
    : emailTotal === 0 ? "No emails logged against records — you can't verify follow-up actually happened."
    : "Email activity is being tracked against records.";

  return [
    { key: "email", label: "Email", total: emailTotal, loading: emails.loading, suggestion: emailSuggestion },
    { key: "task", label: "Task", total: taskTotal, loading: !tasksResolved, suggestion: taskSuggestion },
    { key: "call", label: "Call", total: callTotal, loading: calls.loading, suggestion: callSuggestion },
  ];
}

interface LatestActivity {
  date: string | null;
  label: string;
}

// Scans for whichever date field the item actually carries (varies by MCP
// server/API version — same defensive fallback-chain pattern as the rest of
// this file) and keeps the most recent one found.
function latestActivity(items: unknown[], dateFields: string[], titleFields: string[]): LatestActivity {
  let best: { date: string; label: string } | null = null;
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
    if (!best || d.getTime() > new Date(best.date).getTime()) {
      let label = "";
      for (const f of titleFields) {
        const v = r[f];
        if (typeof v === "string" && v) { label = v; break; }
      }
      best = { date: dateVal, label };
    }
  }
  return best ?? { date: null, label: "" };
}

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

interface ZiaActivityInsight {
  lastEmail: LatestActivity;
  lastCall: LatestActivity;
  lastTaskDue: LatestActivity;
  summary: string;
}

// Synthesizes the three freshest-activity signals into one Zia-style verdict —
// same "flag the stale ones, praise the healthy ones" tone as the rest of the
// dashboard's recommendation copy.
function buildZiaActivityInsight(taskItems: unknown[], calls: ActivityFetchState, emails: ActivityFetchState): ZiaActivityInsight {
  const lastEmail = latestActivity(emails.items, ["sent_time", "Sent_Time", "created_time", "Created_Time", "Modified_Time"], ["subject", "Subject"]);
  const lastCall = latestActivity(calls.items, ["call_start_time", "Call_Start_Time", "created_time", "Created_Time"], ["subject", "Subject", "description", "Description"]);
  const lastTaskDue = latestActivity(taskItems, ["due_date", "Due_Date", "closingdate"], ["subject", "Subject", "title", "Title"]);

  const STALE_DAYS = 14;
  const flags: string[] = [];

  if (!emails.unavailable) {
    const days = daysSince(lastEmail.date);
    if (days === null) flags.push("no emails have been logged yet");
    else if (days > STALE_DAYS) flags.push(`the last email was ${days} days ago`);
  }
  if (!calls.unavailable) {
    const days = daysSince(lastCall.date);
    if (days === null) flags.push("no calls have been logged yet");
    else if (days > STALE_DAYS) flags.push(`the last call was ${days} days ago`);
  }
  const taskDays = daysSince(lastTaskDue.date);
  if (taskDays !== null && taskDays > 0) flags.push(`the most recently due task is now ${taskDays} day${taskDays !== 1 ? "s" : ""} overdue`);

  const summary = flags.length === 0
    ? "Recent activity looks healthy across email, calls, and tasks — no gaps flagged."
    : `Zia flags: ${flags.join("; ")}. Re-engage before this account goes cold.`;

  return { lastEmail, lastCall, lastTaskDue, summary };
}

// ─── Schedules drill-down ───────────────────────────────────────────────────────
// useRuleCoverage.ts already fetches a flat schedule *count* for the KPI's
// collapsed state, but discards the actual items — active/inactive and last-run
// need the real records, fetched lazily here only once the tile is clicked, same
// on-demand pattern as useLayoutsByModule/useActivityRecords above.
function scheduleStatusText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const r = item as Record<string, unknown>;
  return String(r.status ?? r.Status ?? r.state ?? r.State ?? "").toLowerCase();
}

function isActiveSchedule(item: unknown): boolean {
  if (!item || typeof item !== "object") return true;
  const r = item as Record<string, unknown>;
  if (r.enabled === false || r.active === false) return false;
  const s = scheduleStatusText(item);
  return !(s === "inactive" || s === "disabled" || s === "false" || s === "paused" || s === "stopped");
}

function scheduleLastRun(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const raw = r.last_run_time ?? r.Last_Run_Time ?? r.last_executed_time ?? r.lastRunTime ?? r.last_run ?? r.Last_Run;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function useScheduleRecords(config: McpConfig | null, tools: McpTool[], active: boolean, onLog: (log: ExecutionLog) => void) {
  const [state, setState] = useState<ActivityFetchState>(ACTIVITY_FETCH_INIT);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!active || fetchedRef.current) return;
    if (!config || tools.length === 0) return;
    fetchedRef.current = true;

    const scheduleTool = tools.find(t => isScheduleTool(t.name));
    if (!scheduleTool) {
      // Surfaces in the Audit Logs panel so it's visible without DevTools —
      // either the near-miss candidates the regex almost matched (fix the
      // pattern to include them), or confirmation the server truly has no
      // schedule-listing tool under any name containing "sched"/"cron"/"recur".
      const candidates = tools.filter(t => /sched|cron|recur/i.test(t.name)).map(t => t.name);
      onLog({
        id: crypto.randomUUID(), tool: "schedule-tool-lookup", input: {},
        output: { totalToolsConnected: tools.length, possibleScheduleTools: candidates },
        status: candidates.length > 0 ? "success" : "error",
        errorMessage: candidates.length > 0 ? undefined : "No connected tool name contains 'sched', 'cron', or 'recur' — this MCP server may not expose schedule data at all.",
        durationMs: 0, timestamp: new Date(),
      });
      setState(prev => ({ ...prev, unavailable: true }));
      return;
    }

    void (async () => {
      setState(prev => ({ ...prev, loading: true }));
      const pageLoc = findParam(findParamLocations(scheduleTool), /^page$/i);
      let items: unknown[] = [];
      for (let page = 1; page <= ACTIVITY_MAX_PAGES; page++) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        if (page > 1 && pageLoc) setParam(input, pageLoc, page);
        try {
          const output = await executeTool(config as McpConfig, scheduleTool.name, input);
          const pageItems = extractArray(output);
          items = items.concat(pageItems);
          onLog({ id: crypto.randomUUID(), tool: scheduleTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
          if (!pageLoc || pageItems.length === 0) break;
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: scheduleTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
          break;
        }
      }
      setState({ items, loading: false, fetched: true, unavailable: false });
    })();
  }, [active, config, tools, onLog]);

  return state;
}

interface ScheduleBreakdownRow {
  id: string;
  name: string;
  active: boolean;
  lastRun: string | null;
}

function computeScheduleBreakdown(items: unknown[]): ScheduleBreakdownRow[] {
  return items
    .map((s, i) => ({
      id: String((s as Record<string, unknown> | null)?.id ?? i),
      name: getItemName(s, i),
      active: isActiveSchedule(s),
      lastRun: scheduleLastRun(s),
    }))
    .sort((a, b) => Number(a.active) - Number(b.active) || Number(!!a.lastRun) - Number(!!b.lastRun));
}

// "Not used" = inactive, or active but has never actually run — both read as
// automation nobody would notice if it disappeared.
function buildZiaScheduleInsight(rows: ScheduleBreakdownRow[]): { summary: string } {
  if (rows.length === 0) return { summary: "No schedules found — nothing to evaluate yet." };
  const inactive = rows.filter(r => !r.active).length;
  const neverRun = rows.filter(r => r.active && !r.lastRun).length;
  const flags: string[] = [];
  if (inactive > 0) flags.push(`${inactive} schedule${inactive !== 1 ? "s are" : " is"} inactive`);
  if (neverRun > 0) flags.push(`${neverRun} active schedule${neverRun !== 1 ? "s have" : " has"} never actually run`);
  if (flags.length === 0) return { summary: "Every schedule is active and has run at least once — nothing sitting unused." };
  return { summary: `Zia flags: ${flags.join("; ")}. These schedules aren't doing anything right now — reactivate what's still needed, or delete the rest so it's not mistaken for working automation.` };
}

// ─── Functions: list, duplicates, active/inactive, code fetch + analysis ──────
// Verified against a live org via ZohoCRM_getFunctions/getFunctionCode: the
// modern Functions API has no module scoping (only "category": Standalone /
// Button / Automation / etc.) and exposes a flat "state" field for active/
// inactive — a different, more reliable shape than the older workflow-linked
// "associated" concept FunctionAudit.tsx uses. Code is fetched fresh per
// function from the MCP server and held only in React state for the session —
// never persisted to localStorage.

interface FunctionItem {
  id: string;
  apiName: string;
  name: string;
  category: string;
  active: boolean;
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
  if (!state) return true; // no signal at all — default active, same fallback isActiveWorkflow uses
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

// getFunctionCode's response is the raw Deluge/runtime source text itself
// (confirmed via a live call), not a JSON envelope like the other entity
// fetches — so this reads structuredContent.data.text / content[0].text
// directly instead of running it through the generic JSON-array extractor.
function extractFunctionCode(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const r = output as Record<string, unknown>;
  const structured = r.structuredContent as Record<string, unknown> | undefined;
  const data = structured?.data as Record<string, unknown> | undefined;
  if (typeof data?.text === "string" && data.text.trim()) return data.text;
  if (Array.isArray(r.content)) {
    for (const item of r.content as Record<string, unknown>[]) {
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) return item.text;
    }
  }
  return null;
}

const FUNCTION_CODE_TOOL_PATTERNS = [/getfunctioncode$/i, /getfunctionscript$/i, /getfunctionbyid$/i, /getfunctiondetail/i];
const FUNCTION_CODE_SCAN_CAP = 100;

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
  const detailToolRef = useRef<McpTool | null | undefined>(undefined);

  // List + failures — eager (bounded to ~1000 functions), same eagerness as
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
          category: String(r.category ?? "—"),
          active: getFunctionActive(f),
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

  // On-demand single-function code fetch (preview) — downloaded fresh from the
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
      if (code) setIssuesByFnId(prev => ({ ...prev, [fnId]: analyzeFunctionScript(code) }));
      onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
    } catch (e: unknown) {
      setCodeByFnId(prev => ({ ...prev, [fnId]: { code: null, loading: false, unavailable: true } }));
      onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
    }
  }

  // Capped batch scan for the aggregate "% of functions with issues" stat —
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
          }
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: tool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
        setScanProgress(prev => ({ ...prev, done: prev.done + 1 }));
      }
      setScanProgress(prev => ({ ...prev, loading: false }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanActive, listState.fetched, items, config, tools, onLog]);

  return { items, listState, failureCount, codeByFnId, issuesByFnId, scanProgress, fetchCode };
}

interface FunctionIssueRow { key: string; functionName: string; category: string; issue: FunctionIssue; }
const FUNCTION_SEVERITY_ORDER: Record<FunctionIssue["severity"], number> = { high: 0, medium: 1, low: 2 };

function buildFunctionZiaSummary(
  functionsWithIssuesPct: number, scannedCount: number, duplicates: FunctionDuplicateGroup[],
  suspiciousCount: number, failureCount: number | null,
): string {
  if (scannedCount === 0) return "Open this card to scan function code for issues — nothing analyzed yet.";
  const parts: string[] = [];
  if (functionsWithIssuesPct > 0) {
    parts.push(`${functionsWithIssuesPct}% of the ${scannedCount} functions scanned have at least one flagged issue — mostly missing error handling and API calls made inside loops`);
  }
  if (duplicates.length > 0) {
    const dupItemCount = duplicates.reduce((s, g) => s + g.items.length, 0);
    parts.push(`${duplicates.length} function name${duplicates.length !== 1 ? "s are" : " is"} duplicated across ${dupItemCount} functions total — rename or delete the unused copies so workflows/buttons unambiguously call the right one`);
  }
  if (suspiciousCount > 0) {
    parts.push(`${suspiciousCount} function${suspiciousCount !== 1 ? "s" : ""} still carr${suspiciousCount !== 1 ? "y" : "ies"} a placeholder/test name`);
  }
  if (failureCount) {
    parts.push(`${failureCount} recent execution failure${failureCount !== 1 ? "s" : ""} logged`);
  }
  if (parts.length === 0) return "No issues, duplicates, or placeholder names found in the functions scanned — code quality looks solid.";
  return `Zia flags: ${parts.join("; ")}.`;
}

interface FunctionKpiSummary { total: number; active: number; inactive: number; fetched: boolean; }

// Source attribution shown on hover — names the tool the count came from and
// how many records it actually saw, so every number on the tile traces back
// to a real fetch instead of being taken on faith.
function kpiSource(state: EntityState, count: number): string {
  return state.toolUsed ? `Source: ${state.toolUsed} — ${count} record${count !== 1 ? "s" : ""}` : "Source: no matching tool found for this data";
}

function computeKpis(entityData: Record<CrmEntityType, EntityState>, ruleCoverage: RuleCoverage | null, functionSummary: FunctionKpiSummary): KpiItem[] {
  const modules = entityData.modules.items.filter(m => !isDeletedModule(m));
  const blueprints = entityData.blueprints.items;
  const users = entityData.users.items;
  const layouts = entityData.layouts.items;

  // A fetch that failed before returning any pages leaves items at [] — the
  // same shape as a genuinely empty org. Treating both alike would render a
  // false "0 found, all good" tile instead of an honest "couldn't verify"
  // one, so each entity's real error must gate its tile's severity/note.
  const modulesFailed = entityData.modules.error !== null && modules.length === 0;
  const blueprintsFailed = entityData.blueprints.error !== null && blueprints.length === 0;
  const usersFailed = entityData.users.error !== null && users.length === 0;
  const layoutsFailed = entityData.layouts.error !== null && layouts.length === 0;

  const hiddenCount = modules.filter(isHiddenModule).length;
  const hiddenPct = modules.length ? Math.round((hiddenCount / modules.length) * 100) : 0;
  const activePct = modules.length ? 100 - hiddenPct : 0;
  // Blueprint status is a flat Active/Inactive/Draft string, not the nested
  // workflow shape — blueprintStatus keeps Draft from silently counting as
  // active the way isActiveWorkflow's default-true fallback used to (see
  // crmPredicates.ts).
  const bpStatuses = blueprints.map(blueprintStatus);
  const draftBps = bpStatuses.filter(s => s === "draft").length;
  const inactiveBps = bpStatuses.filter(s => s === "inactive").length;
  const activeUsers = users.filter(u => !isInactiveUser(u)).length;
  const layoutGap = Math.max(0, modules.length - layouts.length);

  return [
    {
      key: "modules", label: "Modules", value: modules.length,
      severity: modulesFailed ? "unknown" : hiddenPct >= 40 ? "critical" : hiddenPct >= 15 ? "warning" : "good",
      note: modulesFailed ? `Couldn't verify — ${entityData.modules.error}` : modules.length ? `${activePct}% active · ${hiddenPct}% inactive — click to see which` : "No modules found",
      clickable: modules.length > 0 || modulesFailed,
      unknown: modulesFailed,
      source: modulesFailed ? `Source: ${entityData.modules.toolUsed ?? "no matching tool found"} — fetch failed, count not confirmed` : kpiSource(entityData.modules, modules.length),
    },
    {
      key: "blueprints", label: "Blueprints", value: blueprints.length,
      severity: blueprintsFailed ? "unknown" : blueprints.length > 0 && inactiveBps + draftBps === blueprints.length ? "critical" : inactiveBps > 0 ? "warning" : "good",
      note: blueprintsFailed ? `Couldn't verify — ${entityData.blueprints.error}` : blueprints.length ? `${inactiveBps} inactive${draftBps > 0 ? `, ${draftBps} draft` : ""} — click to see which` : "No blueprints found",
      clickable: blueprints.length > 0 || blueprintsFailed,
      unknown: blueprintsFailed,
      source: blueprintsFailed ? `Source: ${entityData.blueprints.toolUsed ?? "no matching tool found"} — fetch failed, count not confirmed` : kpiSource(entityData.blueprints, blueprints.length),
    },
    {
      key: "users", label: "Active Users", value: activeUsers,
      severity: usersFailed ? "unknown" : activeUsers <= 1 ? "critical" : activeUsers < 5 ? "warning" : "good",
      note: usersFailed ? `Couldn't verify — ${entityData.users.error}` : `${users.length} total licensed — click to see who's active/inactive`,
      clickable: users.length > 0 || usersFailed,
      unknown: usersFailed,
      source: usersFailed ? `Source: ${entityData.users.toolUsed ?? "no matching tool found"} — fetch failed, count not confirmed` : kpiSource(entityData.users, users.length),
    },
    {
      key: "layouts", label: "Layouts", value: layouts.length,
      severity: layoutsFailed ? "unknown" : layouts.length === 0 && modules.length > 0 ? "critical" : layoutGap > 0 ? "warning" : "good",
      note: layoutsFailed ? `Couldn't verify — ${entityData.layouts.error}` : layoutGap > 0 ? `${layoutGap} module${layoutGap === 1 ? "" : "s"} missing a layout — click for breakdown` : "Covers all modules — click for breakdown",
      clickable: layouts.length > 0 || layoutsFailed,
      unknown: layoutsFailed,
      source: layoutsFailed ? `Source: ${entityData.layouts.toolUsed ?? "no matching tool found"} — fetch failed, count not confirmed` : kpiSource(entityData.layouts, layouts.length),
    },
    {
      key: "schedules", label: "Schedules", value: ruleCoverage?.scheduleCount ?? 0,
      severity: ruleCoverage?.scheduleCount === 0 ? "critical" : ruleCoverage?.scheduleCount ? "good" : "warning",
      note: ruleCoverage === null ? "Loading…"
        : ruleCoverage.scheduleCount === null ? "No schedule-listing tool connected"
        : ruleCoverage.scheduleCount === 0 ? "No schedules configured"
        : "click to see active/inactive and last run",
      clickable: !!ruleCoverage?.scheduleCount,
      source: ruleCoverage?.scheduleCount === null ? "Source: no schedule-listing tool connected for this CRM" : `Source: schedule listing — ${ruleCoverage?.scheduleCount ?? 0} record${(ruleCoverage?.scheduleCount ?? 0) !== 1 ? "s" : ""}`,
    },
    {
      key: "functions", label: "Functions", value: functionSummary.active,
      severity: !functionSummary.fetched ? "warning" : functionSummary.total === 0 ? "critical" : functionSummary.inactive > 0 ? "warning" : "good",
      note: !functionSummary.fetched ? "Loading…"
        : functionSummary.total === 0 ? "No functions found"
        : `${functionSummary.inactive} inactive of ${functionSummary.total} — click for issues, duplicates & code`,
      clickable: functionSummary.total > 0,
      source: `Source: function list — ${functionSummary.total} record${functionSummary.total !== 1 ? "s" : ""}`,
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
// module + driving field) — so getItemName's generic fallback chain lands on
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
  if (moduleLabel && fieldLabel) return `${moduleLabel} — ${fieldLabel} Process`;
  if (moduleLabel) return `${moduleLabel} Blueprint`;
  return r.id ? `Blueprint ${r.id}` : `Item ${i + 1}`;
}

function computeBlueprintBreakdown(entityData: Record<CrmEntityType, EntityState>): BlueprintBreakdownRow[] {
  return entityData.blueprints.items
    .map((bp, i) => {
      const module = workflowModuleLabel(bp) || "—";
      return {
        id: String((bp as Record<string, unknown> | null)?.id ?? i),
        name: blueprintDisplayName(bp, i, module === "—" ? "" : module),
        module,
        status: blueprintStatus(bp),
      };
    })
    .sort((a, b) => BP_STATUS_ORDER[a.status] - BP_STATUS_ORDER[b.status]);
}

interface UserBreakdownRow {
  id: string;
  name: string;
  profile: string;
  active: boolean;
}

// Inactive users surface first — they're the actionable ones (a licensed seat
// with nobody using it), same "flag the useless ones first" convention as
// the blueprint/module breakdowns above.
function computeUserBreakdown(entityData: Record<CrmEntityType, EntityState>): UserBreakdownRow[] {
  return entityData.users.items
    .map((u, i) => {
      const r = (u ?? {}) as Record<string, unknown>;
      const profile = typeof r.profile === "object" && r.profile
        ? String((r.profile as Record<string, unknown>).name ?? "—")
        : String(r.role ?? "—");
      return {
        id: String(r.id ?? i),
        name: getItemName(u, i),
        profile,
        active: !isInactiveUser(u),
      };
    })
    .sort((a, b) => Number(a.active) - Number(b.active));
}

interface LayoutModuleBreakdownRow {
  apiName: string;
  moduleLabel: string;
  total: number;
  standard: number;
  custom: number;
  layouts: { name: string; custom: boolean }[];
}

// Modules stacking unusually many custom layouts are worth a second look —
// not because multiple layouts is inherently wrong (see the explanatory copy
// rendered alongside this), but because past that many it's more likely to be
// abandoned one-off layouts than genuine per-profile designs.
const LAYOUT_REVIEW_THRESHOLD = 3;

// getLayouts is module-scoped on Zoho's real API (same as getValidationRules/
// getAssignmentRules etc. — see useRuleCoverage.ts), so the flat, unscoped
// fetch useCrmEntities.ts does for the "layouts" entity only ever returns one
// module's layouts. This builds the per-module breakdown from a real
// per-module fetch (see useLayoutsByModule below) instead of that flat list —
// grouping the flat list by module can never surface custom modules that
// weren't the one module the unscoped call happened to default to.
function computeLayoutBreakdown(
  modules: unknown[],
  layoutsByModule: Record<string, unknown[]>,
): LayoutModuleBreakdownRow[] {
  return Object.entries(layoutsByModule)
    .filter(([, ls]) => ls.length > 0)
    .map(([apiName, ls]) => {
      const mod = modules.find(m => moduleApiName(m) === apiName) as Record<string, unknown> | undefined;
      const moduleLabel = mod ? String(mod.plural_label ?? mod.singular_label ?? apiName) : apiName;
      const layoutRows = ls.map((l, i) => ({ name: getItemName(l, i), custom: isCustomLayout(l) }));
      const custom = layoutRows.filter(l => l.custom).length;
      return { apiName, moduleLabel, total: ls.length, standard: ls.length - custom, custom, layouts: layoutRows };
    })
    .sort((a, b) => b.total - a.total);
}

// Fetches getLayouts per module (module-scoped, like the rule-coverage hook)
// instead of relying on the flat "layouts" entity, which only ever covers one
// module. Lazy — only starts once the Layouts KPI drill-down is opened — and
// capped so a 300+ module org doesn't fire hundreds of sequential calls; the
// panel tells the user how many modules were actually covered.
const LAYOUT_MODULE_FETCH_CAP = 60;

function useLayoutsByModule(
  config: McpConfig | null,
  tools: McpTool[],
  modules: unknown[],
  active: boolean,
  onLog: (log: ExecutionLog) => void,
) {
  const [byModule, setByModule] = useState<Record<string, unknown[]>>({});
  const [progress, setProgress] = useState<{ done: number; total: number; loading: boolean }>({ done: 0, total: 0, loading: false });
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!active || fetchedRef.current) return;
    if (!config || tools.length === 0 || modules.length === 0) return;
    const layoutsTool = findToolForEntity(tools, "layouts");
    if (!layoutsTool) return;

    fetchedRef.current = true;
    const targets = modules
      .filter(m => !isHiddenModule(m))
      .map(m => moduleApiName(m))
      .filter(Boolean)
      .slice(0, LAYOUT_MODULE_FETCH_CAP);

    setProgress({ done: 0, total: targets.length, loading: true });

    void (async () => {
      const moduleLoc = findParam(findParamLocations(layoutsTool), /^module$/i) ?? { group: null, key: "module" };
      const result: Record<string, unknown[]> = {};
      for (const apiName of targets) {
        const start = Date.now();
        const input: Record<string, unknown> = {};
        setParam(input, moduleLoc, apiName);
        try {
          const output = await executeTool(config, layoutsTool.name, input);
          result[apiName] = extractArray(output);
          onLog({ id: crypto.randomUUID(), tool: layoutsTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: layoutsTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
        setProgress(prev => ({ ...prev, done: prev.done + 1 }));
      }
      setByModule(result);
      setProgress(prev => ({ ...prev, loading: false }));
    })();
  }, [active, config, tools, modules, onLog]);

  return { byModule, progress, targetCount: Math.min(modules.filter(m => !isHiddenModule(m)).length, LAYOUT_MODULE_FETCH_CAP) };
}

interface ConfigRow {
  key: CrmEntityType;
  label: string;
  value: string;
  status: string;
  severity: Severity | "neutral";
  targetSection: Section | null;
  source: string;
}

const CONFIG_ROW_DEFS: { type: CrmEntityType; label: string; targetSection: Section | null }[] = [
  { type: "pipelines", label: "Pipelines", targetSection: "modules" },
  { type: "workflows", label: "Workflows", targetSection: "workflows" },
  { type: "profiles",  label: "Profiles",  targetSection: null },
  { type: "tasks",     label: "Activity",  targetSection: "modules" },
];

function computeConfigRows(entityData: Record<CrmEntityType, EntityState>, outOfOrderStageCount: number): ConfigRow[] {
  return CONFIG_ROW_DEFS.map(def => {
    const st = entityData[def.type];
    if (!isEntityResolved(st)) {
      return { key: def.type, label: def.label, value: "…", status: "Loading", severity: "neutral" as const, targetSection: def.targetSection, source: "Loading…" };
    }
    const count = st.items.length;
    const source = st.toolUsed ? `Source: ${st.toolUsed} — ${count} record${count !== 1 ? "s" : ""}` : "Source: no matching tool found";
    if (count === 0) {
      // A fetch error and a genuinely empty CRM both leave items at [] — only
      // the former means "couldn't verify". Conflating them into the same
      // critical "Not found" reads as a confirmed gap when it might just be
      // a broken connection.
      if (st.error) {
        return { key: def.type, label: def.label, value: "—", status: `Couldn't verify — ${st.error}`, severity: "unknown" as const, targetSection: def.targetSection, source: `Source: ${st.toolUsed ?? "no matching tool found"} — fetch failed` };
      }
      return { key: def.type, label: def.label, value: "N/A", status: "Not found", severity: "critical" as const, targetSection: def.targetSection, source };
    }

    let status: string;
    let severity: Severity;
    switch (def.type) {
      case "workflows": {
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
      case "pipelines":
        if (outOfOrderStageCount > 0) {
          status = `${outOfOrderStageCount} stage${outOfOrderStageCount !== 1 ? "s" : ""} out of order`;
          severity = "critical";
        } else {
          status = "Configured";
          severity = "good";
        }
        break;
      default:
        status = "Configured";
        severity = "good";
    }

    return { key: def.type, label: def.label, value: String(count), status, severity, targetSection: def.targetSection, source };
  });
}

function PanelEmptyState({ state, label, onRetry }: { state: EntityState; label: string; onRetry: () => void }) {
  if (state.loading) {
    return <p className="business-view-hint"><span className="spinner" /> Loading {label.toLowerCase()}…</p>;
  }
  if (state.error) {
    return (
      <div className="panel-empty-error">
        <p className="business-view-hint">⚠ {state.error}{state.toolUsed ? ` (via ${state.toolUsed})` : " — no matching tool found"}</p>
        <button className="btn-secondary" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return <p className="business-view-hint">No {label.toLowerCase()} found.</p>;
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
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [feedbackForm, setFeedbackForm] = useState<{ name: string; category: FeedbackCategory; rating: number; message: string }>({
    name: "", category: "general", rating: 0, message: "",
  });
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "success">("idle");
  const [remediation, setRemediation] = useState<Record<string, {
    loading: boolean;
    text: string;
    usage?: { inputTokens: number; outputTokens: number; model: string };
  }>>({});
  // Single source of truth for the master-detail layout below: the one card
  // (out of the 6 KPI tiles + 4 CRM Configuration tiles) currently selected
  // in the left-hand list, whose detail renders in the right-hand panel.
  // Replaces the old expandedKpi + pipelinesOpen pair — those two used to
  // gate two visually-separate "expand below" sections; now there's only one
  // selection driving one detail slot.
  type CardKey = "modules" | "blueprints" | "users" | "layouts" | "schedules" | "functions"
               | "pipelines" | "workflows" | "profiles" | "activity";
  const [selectedCard, setSelectedCard] = useState<CardKey | null>("modules");
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const isFirstCardRender = useRef(true);
  useEffect(() => {
    // Cards further down the left-hand list can sit well below the fold;
    // without this, selecting one pops the detail panel in at the top of
    // the grid row, off-screen from where the user just clicked. Skip the
    // very first render though — "modules" is preselected by default, and
    // scrolling then would auto-scroll the page the instant it connects,
    // before the user has clicked anything.
    if (isFirstCardRender.current) { isFirstCardRender.current = false; return; }
    if (selectedCard) detailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedCard]);
  const [moduleFilter, setModuleFilter] = useState<ModuleCategory | "all">("all");
  const [workflowFilter, setWorkflowFilter] = useState<"all" | "active" | "inactive" | "never">("all");
  const [blueprintFilter, setBlueprintFilter] = useState<BlueprintStatus | "all">("all");
  const layoutsByModule = useLayoutsByModule(config, tools, entityData.modules.items, selectedCard === "layouts", onLog);
  const scheduleRecords = useScheduleRecords(config, tools, selectedCard === "schedules", onLog);
  const functionRecords = useFunctionRecords(config, tools, selectedCard === "functions", onLog);
  const [expandedFunctionDuplicate, setExpandedFunctionDuplicate] = useState<string | null>(null);
  const [previewFunctionId, setPreviewFunctionId] = useState<string | null>(null);
  const [functionsListExpanded, setFunctionsListExpanded] = useState(false);
  type FunctionsSubTab = "issues" | "duplicates" | "all";
  const [functionsSubTab, setFunctionsSubTab] = useState<FunctionsSubTab>("issues");
  function toggleFunctionPreview(fnId: string) {
    setPreviewFunctionId(prev => {
      const next = prev === fnId ? null : fnId;
      if (next) functionRecords.fetchCode(next);
      return next;
    });
  }
  // Deliberately kept eager (fetches as soon as tools are ready) rather than
  // gated on selectedCard === "activity" like the on-demand hooks above —
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
    const pipeItems = entityData.pipelines.items;
    if (pipeItems.length > 0) {
      ctxLines.push(`Pipeline Names: ${pipeItems.map((p, i) => getItemName(p, i)).join(", ")}`);
    }
    return ctxLines.join("\n");
  }

  // Fills every property the tool's schema exposes (not just a free-text query
  // field) so structural tools like a "ZiaRecommendation" create/action tool
  // can still be called — e.g. a "recommendations" array field gets [{id}].
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
  // tool is connected — filling its full schema generically — rather than
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
    // Scroll only within the chat's own message list — never the page —
    // and only once there's actually something to show (skip the empty initial mount).
    if (ziaMessages.length === 0) return;
    const el = chatMessagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ziaMessages]);

  // Remediation answers render inline on the recommendation card itself —
  // routing them into the shared Ask Zia chat (further down the page) meant
  // clicking the button either forced an unwanted scroll or landed the user
  // among unrelated Reports/Feedback content instead of the actual answer.
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
  // Adapter so generateRecommendations (unchanged below) keeps reading the
  // same FunctionHealth shape it always has — now sourced from the new hook's
  // full items instead of the old names-only fetch, so duplicate/suspicious
  // counts here always match what the Functions KPI drilldown shows.
  const functionHealth: FunctionHealth | null = functionRecords.listState.fetched ? {
    totalScanned: functionRecords.items.length,
    hasMore: functionRecords.listState.hasMore,
    duplicateGroups: functionDuplicates.map(g => ({ name: g.name, count: g.items.length })),
    suspiciousNames: functionSuspiciousNames,
    failuresChecked: functionRecords.failureCount !== null,
    failureCount: functionRecords.failureCount ?? 0,
  } : null;

  const recommendations = generateRecommendations(entityData, tools, ruleCoverage, functionHealth);
  const filteredRecs = recommendations.filter(r => r.category === activeTab);
  const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityData[e.type].items.length, 0);
  const loadingCount = CRM_ENTITIES.filter(e => entityData[e.type].loading).length;
  const loadedCount = CRM_ENTITIES.filter(e => entityData[e.type].lastFetched !== null).length;
  const ziaTool = findZiaTool(tools);

  const kpis = computeKpis(entityData, ruleCoverage, {
    total: functionRecords.items.length, active: functionActiveCount, inactive: functionInactiveCount,
    fetched: functionRecords.listState.fetched,
  });
  const moduleBreakdown = selectedCard === "modules" ? computeModuleBreakdown(entityData) : [];
  const blueprintBreakdown = selectedCard === "blueprints" ? computeBlueprintBreakdown(entityData) : [];
  const layoutBreakdown = selectedCard === "layouts" ? computeLayoutBreakdown(entityData.modules.items, layoutsByModule.byModule) : [];
  const scheduleBreakdown = selectedCard === "schedules" ? computeScheduleBreakdown(scheduleRecords.items) : [];
  const ziaScheduleInsight = selectedCard === "schedules" ? buildZiaScheduleInsight(scheduleBreakdown) : null;
  const userBreakdown = selectedCard === "users" ? computeUserBreakdown(entityData) : [];

  const functionIssueRows: FunctionIssueRow[] = selectedCard === "functions"
    ? functionRecords.items.flatMap(fn => (functionRecords.issuesByFnId[fn.id] ?? []).map((issue, i) => ({ key: `${fn.id}-${i}`, functionName: fn.name, category: fn.category, issue })))
    : [];
  const sortedFunctionIssueRows = [...functionIssueRows].sort((a, b) => FUNCTION_SEVERITY_ORDER[a.issue.severity] - FUNCTION_SEVERITY_ORDER[b.issue.severity]);
  const scannedFnIds = Object.keys(functionRecords.issuesByFnId);
  const scannedFnCount = scannedFnIds.length;
  const functionsWithIssuesCount = scannedFnIds.filter(id => (functionRecords.issuesByFnId[id]?.length ?? 0) > 0).length;
  const functionsWithIssuesPct = scannedFnCount > 0 ? Math.round((functionsWithIssuesCount / scannedFnCount) * 100) : 0;
  const functionZiaSummary = buildFunctionZiaSummary(functionsWithIssuesPct, scannedFnCount, functionDuplicates, functionSuspiciousNames.length, functionRecords.failureCount);
  const configRows = computeConfigRows(entityData, pipelineStages.items.filter(s => s.outOfOrder).length);
  const workflowBreakdown = computeWorkflowBreakdown(entityData);
  const ziaWorkflowInsight = buildZiaWorkflowInsight(workflowBreakdown);
  const activityStats = buildActivityStats(isEntityResolved(entityData.tasks), entityData.tasks.items, activityRecords.calls, activityRecords.emails);
  const ziaActivityInsight = buildZiaActivityInsight(entityData.tasks.items, activityRecords.calls, activityRecords.emails);
  const profileItems = entityData.profiles.items;
  const userItemsForPanel = entityData.users.items;

  // Load persisted feedback on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FB_STORAGE_KEY);
      if (stored) setFeedbackEntries(JSON.parse(stored) as FeedbackEntry[]);
    } catch { /* ignore */ }
  }, []);

  function submitFeedback() {
    if (!feedbackForm.message.trim()) return;
    const entry: FeedbackEntry = {
      id: Math.random().toString(36).slice(2),
      name: feedbackForm.name.trim() || "Anonymous",
      category: feedbackForm.category,
      rating: feedbackForm.rating,
      message: feedbackForm.message.trim(),
      timestamp: new Date().toISOString(),
    };
    const updated = [entry, ...feedbackEntries];
    setFeedbackEntries(updated);
    try { localStorage.setItem(FB_STORAGE_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
    setFeedbackForm({ name: "", category: "general", rating: 0, message: "" });
    setFeedbackStatus("success");
    setTimeout(() => setFeedbackStatus("idle"), 3000);
  }

  function deleteFeedback(id: string) {
    const updated = feedbackEntries.filter(e => e.id !== id);
    setFeedbackEntries(updated);
    try { localStorage.setItem(FB_STORAGE_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  }

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
    // page number must always be read live rather than tracked in a variable —
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
      if (!s) return "—";
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
    const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityData[e.type].items.length, 0);
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
      // column below can be wrapped to whatever width is actually left over —
      // drawing both at a fixed x with unbounded text is what let a long error
      // message run straight into the "via <tool>" label.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      const toolText = state.toolUsed ? `via ${state.toolUsed}` : "";
      const toolWidth = toolText ? doc.getTextWidth(toolText) : 0;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      const statusRaw = isError
        ? `Error — ${state.error}`
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

      // Actual item list (not just the count) rendered as a real table — large
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
          // ensureSpace()/drawFooter() calls — without these hooks, every page
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
            <p className="crm-header-sub">
              {loadingCount > 0
                ? `Loading ${loadingCount} of ${CRM_ENTITIES.length} data sources…`
                : `${totalItems.toLocaleString()} total items across ${loadedCount} sources`}
              {lastRefresh && ` · Updated ${formatRelative(lastRefresh)}`}
            </p>
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
        {kpis.map(k => (
          <button
            key={k.key}
            type="button"
            className={`crmov-card kpi-${k.severity} ${k.clickable ? "clickable" : ""} ${selectedCard === k.key ? "selected" : ""}`}
            onClick={k.clickable ? () => setSelectedCard(prev => (prev === k.key ? null : (k.key as CardKey))) : undefined}
            disabled={!k.clickable}
            data-tooltip={k.source}
          >
            <span className="kpi-tile-label">{k.label}</span>
            <span className="kpi-tile-value">{k.unknown ? "—" : k.value.toLocaleString()}</span>
            <span className="kpi-tile-note">{k.note}</span>
          </button>
        ))}
        <div className="crmov-card-list-divider">CRM Configuration</div>
        {configRows.map(row => {
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
            <h4>Modules — Active / Hidden / Empty</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.modules.error && entityData.modules.items.length === 0 ? (
            <PanelEmptyState state={entityData.modules} label="modules" onRetry={() => fetchEntity("modules")} />
          ) : (
          <>
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
            {moduleBreakdown.filter(row => moduleFilter === "all" || row.category === moduleFilter).map(row => (
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
            <h4>Blueprints — Active / Inactive / Draft</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.blueprints.error && entityData.blueprints.items.length === 0 ? (
            <PanelEmptyState state={entityData.blueprints} label="blueprints" onRetry={() => fetchEntity("blueprints")} />
          ) : (
          <>
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
            {blueprintBreakdown.filter(row => blueprintFilter === "all" || row.status === blueprintFilter).map(row => (
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
            <h4>Active Users — Active vs Inactive</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.users.error && entityData.users.items.length === 0 ? (
            <PanelEmptyState state={entityData.users} label="users" onRetry={() => fetchEntity("users")} />
          ) : (
          <>
          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good">{userBreakdown.filter(r => r.active).length} Active</span>
            <span className="kpi-drilldown-stat bad">{userBreakdown.filter(r => !r.active).length} Inactive</span>
          </div>
          <div className="kpi-drilldown-table">
            {userBreakdown.map(row => (
              <div key={row.id} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module">{row.profile}</span>
                <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
              </div>
            ))}
          </div>
          </>
          )}
        </div>
      )}

      {selectedCard === "layouts" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Layouts — Standard vs Custom, Per Module</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {entityData.layouts.error && entityData.layouts.items.length === 0 ? (
            <PanelEmptyState state={entityData.layouts} label="layouts" onRetry={() => fetchEntity("layouts")} />
          ) : (
          <>
          <p className="kpi-drilldown-note">
            More than one layout on a module usually isn&apos;t clutter — Zoho lets each profile use a different layout on the same module, so Sales and Support can see different required fields on the same Leads module. It&apos;s only worth a closer look when a module is stacking several custom layouts with no clear reason.
          </p>
          {layoutsByModule.progress.loading && (
            <p className="kpi-drilldown-progress">
              <span className="spinner" /> Fetching layouts per module… {layoutsByModule.progress.done} of {layoutsByModule.progress.total}
            </p>
          )}
          {!layoutsByModule.progress.loading && layoutsByModule.progress.total > 0 && (
            <p className="kpi-drilldown-note">
              Checked {layoutsByModule.targetCount} visible module{layoutsByModule.targetCount !== 1 ? "s" : ""}
              {layoutsByModule.targetCount >= LAYOUT_MODULE_FETCH_CAP ? " (capped — this org has more visible modules than were checked)" : ""}.
            </p>
          )}
          {!layoutsByModule.progress.loading && layoutsByModule.progress.total > 0 && layoutBreakdown.length === 0 && (
            <p className="business-view-hint">No layouts found on any checked module.</p>
          )}
          <div className="kpi-drilldown-table">
            {layoutBreakdown.map(row => (
              <div key={row.apiName} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                <div className="kpi-drilldown-row-top">
                  <span className="kpi-drilldown-name">{row.moduleLabel}</span>
                  <span className="kpi-drilldown-module">{row.total} layout{row.total !== 1 ? "s" : ""}</span>
                  <span className="kpi-drilldown-badge neutral">{row.standard} standard · {row.custom} custom</span>
                  {row.custom > LAYOUT_REVIEW_THRESHOLD && <span className="kpi-drilldown-flag">Review</span>}
                </div>
                <div className="kpi-drilldown-layout-names">
                  {row.layouts.map((l, i) => (
                    <span key={i} className={`kpi-drilldown-layout-chip ${l.custom ? "custom" : "standard"}`}>{l.name}</span>
                  ))}
                </div>
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
            <h4>Schedules — Active / Inactive / Last Run</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          {scheduleRecords.unavailable && (
            <p className="business-view-hint">No schedule-listing tool is connected — schedule activity can't be checked from here.</p>
          )}
          {scheduleRecords.loading && (
            <p className="kpi-drilldown-progress"><span className="spinner" /> Fetching schedules…</p>
          )}
          {!scheduleRecords.unavailable && !scheduleRecords.loading && scheduleRecords.fetched && (
            <>
              <div className="kpi-drilldown-summary">
                <span className="kpi-drilldown-stat good">{scheduleBreakdown.filter(r => r.active).length} Active</span>
                <span className="kpi-drilldown-stat bad">{scheduleBreakdown.filter(r => !r.active).length} Inactive</span>
                <span className="kpi-drilldown-stat neutral">{scheduleBreakdown.filter(r => !r.lastRun).length} Never Run</span>
              </div>
              <div className="kpi-drilldown-table">
                {scheduleBreakdown.map(row => (
                  <div key={row.id} className="kpi-drilldown-row">
                    <span className="kpi-drilldown-name">{row.name}</span>
                    <span className={`kpi-drilldown-date ${!row.lastRun ? "never" : ""}`}>{formatLastTriggered(row.lastRun)}</span>
                    <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
                  </div>
                ))}
              </div>
              {ziaScheduleInsight && (
                <div className="zia-rec zia-rec-medium activity-zia-rec">
                  <div className="zia-rec-header">
                    <span className="zia-rec-icon">✦</span>
                    <span className="zia-rec-title">Zia Recommendation — Unused Schedules</span>
                  </div>
                  <p className="zia-rec-desc">{ziaScheduleInsight.summary}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {selectedCard === "functions" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Functions — Issues, Duplicates &amp; Code</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good">{functionActiveCount} Active</span>
            <span className="kpi-drilldown-stat bad">{functionInactiveCount} Inactive</span>
            <span className="kpi-drilldown-stat neutral">{functionDuplicates.length} Duplicate Names</span>
          </div>

          {/* Recommendations stay visible regardless of which tab below is open */}
          <h5 className="kpi-drilldown-subheading">Recommendations</h5>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation — Functions</span>
            </div>
            <p className="zia-rec-desc">{functionZiaSummary}</p>
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
            >
              <span>Duplicate Function Names</span>
              <span className="function-tab-count">{functionDuplicates.length}</span>
            </button>
            <button
              type="button"
              className={`function-tab ${functionsSubTab === "all" ? "active" : ""}`}
              onClick={() => setFunctionsSubTab("all")}
            >
              <span>All Functions</span>
              <span className="function-tab-count">{functionRecords.items.length}</span>
            </button>
          </div>

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
                  {scannedFnCount > 0 ? ` — ${functionsWithIssuesPct}% have at least one flagged issue.` : "."}
                </p>
              )}
              {!functionRecords.scanProgress.loading && sortedFunctionIssueRows.length === 0 && scannedFnCount > 0 && (
                <p className="business-view-hint">No issues flagged in the functions scanned.</p>
              )}
              {sortedFunctionIssueRows.length > 0 && (
                <div className="kpi-drilldown-table kpi-drilldown-table-single">
                  {sortedFunctionIssueRows.slice(0, 15).map(row => (
                    <div key={row.key} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                      <div className="kpi-drilldown-row-top">
                        <span className="kpi-drilldown-name">{row.functionName}</span>
                        <span className="kpi-drilldown-module">{row.category}</span>
                        <span className={`kpi-drilldown-badge status-${row.issue.severity === "high" ? "inactive" : row.issue.severity === "medium" ? "draft" : "active"}`}>
                          {ISSUE_CATEGORY_LABELS[row.issue.category]}
                        </span>
                      </div>
                      <p className="function-issue-message">{row.issue.message}</p>
                    </div>
                  ))}
                  {sortedFunctionIssueRows.length > 15 && (
                    <p className="business-view-hint">+{sortedFunctionIssueRows.length - 15} more issues found</p>
                  )}
                </div>
              )}
            </>
          )}

          {functionsSubTab === "duplicates" && (
            functionDuplicates.length === 0 ? (
              <p className="business-view-hint">No duplicate function names found.</p>
            ) : (
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {functionDuplicates.map(group => (
                  <div key={group.name} className="kpi-drilldown-row kpi-drilldown-row-layouts">
                    <button
                      className="function-dup-toggle"
                      onClick={() => setExpandedFunctionDuplicate(prev => (prev === group.name ? null : group.name))}
                    >
                      <span className="kpi-drilldown-name">{group.name}</span>
                      <span className="kpi-drilldown-badge neutral">{group.items.length}×</span>
                      <span className="function-dup-caret">{expandedFunctionDuplicate === group.name ? "▾" : "▸"}</span>
                    </button>
                    {expandedFunctionDuplicate === group.name && (
                      <div className="kpi-drilldown-layout-names">
                        {group.items.map(it => (
                          <span key={it.id} className="kpi-drilldown-layout-chip custom">{it.apiName || it.id} · {it.category}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {functionsSubTab === "all" && (
            <>
              <div className="kpi-drilldown-table kpi-drilldown-table-single">
                {(functionsListExpanded ? functionRecords.items : functionRecords.items.slice(0, 8)).map(fn => (
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
                                <span className="zia-rec-title">Zia Recommendation — Formatting &amp; Comments</span>
                              </div>
                              <p className="zia-rec-desc">{reviewCodeQuality(functionRecords.codeByFnId[fn.id]!.code!).summary}</p>
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
              {functionRecords.items.length > 8 && !functionsListExpanded && (
                <button className="cost-cards-more" onClick={() => setFunctionsListExpanded(true)}>
                  + {functionRecords.items.length - 8} more functions
                </button>
              )}
            </>
          )}
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
          {!pipelineStages.loading && !pipelineStages.error && pipelineStages.items.length === 0 && (
            <p className="business-view-hint">No pipeline stages were found on your Deals layout.</p>
          )}
          {!pipelineStages.loading && pipelineStages.items.length > 0 && (
            <div className="kpi-drilldown-table">
              {pipelineStages.items.map(stage => (
                <div key={stage.apiName} className="kpi-drilldown-row">
                  <span className="kpi-drilldown-name">{stage.name}</span>
                  {stage.outOfOrder && (
                    <span className="kpi-drilldown-badge status-inactive" title="This stage is sequenced after a Closed Won/Lost stage">Out of order</span>
                  )}
                  {stage.forecastType && <span className="kpi-drilldown-badge neutral">{stage.forecastType}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedCard === "workflows" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Workflows — Active / Inactive / Last Triggered</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          <div className="kpi-drilldown-summary">
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable good ${workflowFilter === "active" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "active" ? "all" : "active"))}
            >
              {workflowBreakdown.filter(r => r.active).length} Active
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable bad ${workflowFilter === "inactive" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "inactive" ? "all" : "inactive"))}
            >
              {workflowBreakdown.filter(r => !r.active).length} Inactive
            </button>
            <button
              className={`kpi-drilldown-stat kpi-drilldown-stat-clickable neutral ${workflowFilter === "never" ? "selected" : ""}`}
              onClick={() => setWorkflowFilter(prev => (prev === "never" ? "all" : "never"))}
            >
              {workflowBreakdown.filter(r => !r.lastTriggered).length} Never Triggered
            </button>
            {workflowFilter !== "all" && (
              <button className="kpi-drilldown-stat kpi-drilldown-stat-clickable" onClick={() => setWorkflowFilter("all")}>
                Show All
              </button>
            )}
          </div>
          <div className="kpi-drilldown-table kpi-drilldown-table-single">
            {workflowBreakdown.filter(row => matchesWorkflowFilter(row, workflowFilter)).map(row => (
              <div key={row.id} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module">{row.module}</span>
                <span className={`kpi-drilldown-date ${!row.lastTriggered ? "never" : ""}`}>{formatLastTriggered(row.lastTriggered)}</span>
                <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
              </div>
            ))}
          </div>
          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation — Workflows</span>
            </div>
            <p className="zia-rec-desc">{ziaWorkflowInsight.summary}</p>
          </div>
        </div>
      )}

      {selectedCard === "activity" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Activity — Email / Task / Call</h4>
            <button className="kpi-drilldown-close" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          <div className="activity-subkpi-grid">
            {activityStats.map(stat => (
              <div key={stat.key} className="activity-subkpi-tile">
                <span className="kpi-tile-label">{stat.label}</span>
                <span className="kpi-tile-value">{stat.loading ? "…" : stat.total.toLocaleString()}</span>
                <p className="activity-subkpi-suggestion">{stat.suggestion}</p>
              </div>
            ))}
          </div>

          <div className="zia-rec zia-rec-medium activity-zia-rec">
            <div className="zia-rec-header">
              <span className="zia-rec-icon">✦</span>
              <span className="zia-rec-title">Zia Recommendation — Recent Activity</span>
            </div>
            <div className="activity-zia-grid">
              <div className="activity-zia-item">
                <span className="activity-zia-label">Last Email</span>
                <span className="activity-zia-value">{ziaActivityInsight.lastEmail.date ? formatLastTriggered(ziaActivityInsight.lastEmail.date) : "None found"}</span>
                {ziaActivityInsight.lastEmail.label && <span className="activity-zia-sub">{ziaActivityInsight.lastEmail.label}</span>}
              </div>
              <div className="activity-zia-item">
                <span className="activity-zia-label">Last Call</span>
                <span className="activity-zia-value">{ziaActivityInsight.lastCall.date ? formatLastTriggered(ziaActivityInsight.lastCall.date) : "None found"}</span>
                {ziaActivityInsight.lastCall.label && <span className="activity-zia-sub">{ziaActivityInsight.lastCall.label}</span>}
              </div>
              <div className="activity-zia-item">
                <span className="activity-zia-label">Last Task Due</span>
                <span className="activity-zia-value">{ziaActivityInsight.lastTaskDue.date ? formatLastTriggered(ziaActivityInsight.lastTaskDue.date) : "None found"}</span>
                {ziaActivityInsight.lastTaskDue.label && <span className="activity-zia-sub">{ziaActivityInsight.lastTaskDue.label}</span>}
              </div>
            </div>
            <p className="zia-rec-desc">{ziaActivityInsight.summary}</p>
          </div>
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
            <ul className="panel-item-list">
              {profileItems.map((item, idx) => {
                const name = getItemName(item, idx);
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
              {userItemsForPanel.map((item, idx) => {
                const name = getItemName(item, idx);
                const r = (item ?? {}) as Record<string, unknown>;
                const profileName = typeof r.profile === "object" && r.profile
                  ? String((r.profile as Record<string, unknown>).name ?? "—")
                  : String(r.role ?? "—");
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
      <div className="crm-recs-section">
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
                  Ask Zia anything about your CRM — process gaps, optimization ideas, or specific entities.
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
                    <li key={r.id} className="crm-report-preview-item">
                      <span className={`crm-dot dot-${r.severity}`} />
                      <span className="crm-report-preview-text">{r.title}</span>
                    </li>
                  ))}
                  {catRecs.length > 3 && (
                    <li className="crm-report-more">+{catRecs.length - 3} more items</li>
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
      {/* ── Feedback ────────────────────────────────────────────────────────── */}
      <div className="crm-feedback">
        <div className="crm-feedback-header">
          <p className="crm-panel-label">Feedback</p>
          <span className="crm-feedback-sub">Help us improve the Zoho CRM Audit tool</span>
        </div>
        <div className="crm-feedback-body">

          {/* Form */}
          <div className="crm-feedback-form">
            <h3 className="crm-fb-form-title">Share Your Feedback</h3>

            <div className="crm-fb-field">
              <label className="crm-fb-label">Category</label>
              <div className="crm-fb-categories">
                {FB_CATEGORIES.map(cat => (
                  <button
                    key={cat.value}
                    className={`crm-fb-cat ${feedbackForm.category === cat.value ? "active" : ""}`}
                    onClick={() => setFeedbackForm(prev => ({ ...prev, category: cat.value }))}
                  >
                    <span>{cat.icon}</span>
                    <span>{cat.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="crm-fb-field">
              <label className="crm-fb-label">Rating <span className="crm-fb-optional">(optional)</span></label>
              <div className="crm-fb-stars">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    className={`crm-fb-star ${feedbackForm.rating >= star ? "filled" : ""}`}
                    onClick={() => setFeedbackForm(prev => ({
                      ...prev, rating: prev.rating === star ? 0 : star,
                    }))}
                  >★</button>
                ))}
                {feedbackForm.rating > 0 && (
                  <span className="crm-fb-rating-label">{FB_RATING_LABELS[feedbackForm.rating]}</span>
                )}
              </div>
            </div>

            <div className="crm-fb-field">
              <label className="crm-fb-label">Your Name <span className="crm-fb-optional">(optional)</span></label>
              <input
                className="crm-fb-input"
                type="text"
                placeholder="Anonymous"
                value={feedbackForm.name}
                onChange={e => setFeedbackForm(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="crm-fb-field">
              <label className="crm-fb-label">Message <span className="crm-fb-required">*</span></label>
              <textarea
                className="crm-fb-textarea"
                placeholder="Describe your feedback, suggestion, or issue…"
                value={feedbackForm.message}
                onChange={e => setFeedbackForm(prev => ({ ...prev, message: e.target.value }))}
                rows={4}
              />
            </div>

            {feedbackStatus === "success" && (
              <div className="form-success">
                Thank you! Your feedback has been recorded.
                <button className="bp-dismiss" onClick={() => setFeedbackStatus("idle")}>✕</button>
              </div>
            )}

            <button
              className="btn-connect crm-fb-submit"
              onClick={submitFeedback}
              disabled={!feedbackForm.message.trim()}
            >
              Submit Feedback
            </button>
          </div>

          {/* Entries list */}
          {feedbackEntries.length > 0 && (
            <div className="crm-feedback-list">
              <h3 className="crm-fb-form-title">
                Submitted Feedback
                <span className="crm-fb-count">{feedbackEntries.length}</span>
              </h3>
              <div className="crm-fb-entries">
                {feedbackEntries.map(entry => {
                  const cat = FB_CATEGORIES.find(c => c.value === entry.category);
                  return (
                    <div key={entry.id} className="crm-fb-entry">
                      <div className="crm-fb-entry-header">
                        <span className="crm-fb-entry-cat">{cat?.icon} {cat?.label}</span>
                        {entry.rating > 0 && (
                          <span className="crm-fb-entry-stars">
                            {"★".repeat(entry.rating)}{"☆".repeat(5 - entry.rating)}
                          </span>
                        )}
                        <span className="crm-fb-entry-author">{entry.name}</span>
                        <span className="crm-fb-entry-date">
                          {new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                        <button
                          className="crm-fb-entry-del"
                          title="Remove"
                          onClick={() => deleteFeedback(entry.id)}
                        >✕</button>
                      </div>
                      <p className="crm-fb-entry-msg">{entry.message}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
