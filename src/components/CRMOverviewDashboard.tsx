"use client";

import React, { useState, useEffect, useRef } from "react";
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
import { isActiveWorkflow, isAdminProfile, isCustomModule, isInactiveUser, blueprintStatus, type BlueprintStatus, workflowModuleLabel, workflowLastTriggered, moduleApiName, isCustomLayout } from "@/lib/crmPredicates";
import type { RuleCoverage } from "@/lib/businessScore";

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
  ruleCoverage: RuleCoverage | null;
}

type Severity = "critical" | "warning" | "good";

interface KpiItem {
  key: string;
  label: string;
  value: number;
  severity: Severity;
  note: string;
  clickable?: boolean;
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
  const mods     = entityData.modules.items;
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

function isHiddenModule(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return r.visible === false || r.show_as_tab === false || r.viewable === false;
}

interface ModuleBreakdownRow {
  apiName: string;
  name: string;
  active: boolean;
  custom: boolean;
}

// Sorted hidden-first — same "surface the actionable ones first" convention
// as the blueprint/workflow breakdowns elsewhere in this file.
function computeModuleBreakdown(entityData: Record<CrmEntityType, EntityState>): ModuleBreakdownRow[] {
  return entityData.modules.items
    .map((m, i) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const apiName = moduleApiName(m);
      return {
        apiName: apiName || String(i),
        name: String(r.plural_label ?? r.singular_label ?? r.module_name ?? apiName ?? `Module ${i + 1}`),
        active: !isHiddenModule(m),
        custom: isCustomModule(m),
      };
    })
    .sort((a, b) => Number(a.active) - Number(b.active));
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

    const scheduleTool = tools.find(t => /getschedules$/i.test(t.name));
    if (!scheduleTool) { setState(prev => ({ ...prev, unavailable: true })); return; }

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

function computeKpis(entityData: Record<CrmEntityType, EntityState>, ruleCoverage: RuleCoverage | null): KpiItem[] {
  const modules = entityData.modules.items;
  const blueprints = entityData.blueprints.items;
  const users = entityData.users.items;
  const layouts = entityData.layouts.items;

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
      severity: hiddenPct >= 40 ? "critical" : hiddenPct >= 15 ? "warning" : "good",
      note: modules.length ? `${activePct}% active · ${hiddenPct}% inactive — click to see which` : "No modules found",
      clickable: modules.length > 0,
    },
    {
      key: "blueprints", label: "Blueprints", value: blueprints.length,
      severity: blueprints.length > 0 && inactiveBps + draftBps === blueprints.length ? "critical" : inactiveBps > 0 ? "warning" : "good",
      note: blueprints.length ? `${inactiveBps} inactive${draftBps > 0 ? `, ${draftBps} draft` : ""} — click to see which` : "No blueprints found",
      clickable: blueprints.length > 0,
    },
    {
      key: "users", label: "Active Users", value: activeUsers,
      severity: activeUsers <= 1 ? "critical" : activeUsers < 5 ? "warning" : "good",
      note: `${users.length} total licensed`,
    },
    {
      key: "layouts", label: "Layouts", value: layouts.length,
      severity: layouts.length === 0 && modules.length > 0 ? "critical" : layoutGap > 0 ? "warning" : "good",
      note: layoutGap > 0 ? `${layoutGap} module${layoutGap === 1 ? "" : "s"} missing a layout — click for breakdown` : "Covers all modules — click for breakdown",
      clickable: layouts.length > 0,
    },
    {
      key: "schedules", label: "Schedules", value: ruleCoverage?.scheduleCount ?? 0,
      severity: ruleCoverage?.scheduleCount === 0 ? "critical" : ruleCoverage?.scheduleCount ? "good" : "warning",
      note: ruleCoverage === null ? "Loading…"
        : ruleCoverage.scheduleCount === null ? "No schedule-listing tool connected"
        : ruleCoverage.scheduleCount === 0 ? "No schedules configured"
        : "click to see active/inactive and last run",
      clickable: !!ruleCoverage?.scheduleCount,
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

function computeBlueprintBreakdown(entityData: Record<CrmEntityType, EntityState>): BlueprintBreakdownRow[] {
  return entityData.blueprints.items
    .map((bp, i) => ({
      id: String((bp as Record<string, unknown> | null)?.id ?? i),
      name: getItemName(bp, i),
      module: workflowModuleLabel(bp) || "—",
      status: blueprintStatus(bp),
    }))
    .sort((a, b) => BP_STATUS_ORDER[a.status] - BP_STATUS_ORDER[b.status]);
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
}

const CONFIG_ROW_DEFS: { type: CrmEntityType; label: string; targetSection: Section | null }[] = [
  { type: "pipelines", label: "Pipelines", targetSection: "modules" },
  { type: "stages",    label: "Stages",    targetSection: "blueprints" },
  { type: "workflows", label: "Workflows", targetSection: "workflows" },
  { type: "profiles",  label: "Profiles",  targetSection: null },
  { type: "tasks",     label: "Activity",  targetSection: "modules" },
];

function computeConfigRows(entityData: Record<CrmEntityType, EntityState>): ConfigRow[] {
  return CONFIG_ROW_DEFS.map(def => {
    const st = entityData[def.type];
    if (!isEntityResolved(st)) {
      return { key: def.type, label: def.label, value: "…", status: "Loading", severity: "neutral" as const, targetSection: def.targetSection };
    }
    const count = st.items.length;
    if (count === 0) {
      return { key: def.type, label: def.label, value: "N/A", status: "Not found", severity: "critical" as const, targetSection: def.targetSection };
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
      default:
        status = "Configured";
        severity = "good";
    }

    return { key: def.type, label: def.label, value: String(count), status, severity, targetSection: def.targetSection };
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

export default function CRMOverviewDashboard({ config, tools, onLog, entityData, fetchEntity, fetchAll, lastRefresh, onSelectSection, pipelineStageCount, ruleCoverage }: Props) {
  const [activeTab, setActiveTab] = useState<ReportTab>("changes");
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
  const [functionHealth, setFunctionHealth] = useState<FunctionHealth | null>(null);
  const functionHealthFetched = useRef(false);
  const [expandedKpi, setExpandedKpi] = useState<"modules" | "blueprints" | "layouts" | "schedules" | null>(null);
  const layoutsByModule = useLayoutsByModule(config, tools, entityData.modules.items, expandedKpi === "layouts", onLog);
  const scheduleRecords = useScheduleRecords(config, tools, expandedKpi === "schedules", onLog);
  // Workflows/Activity are always-visible cards (not click-to-reveal like the
  // KPI strip drilldowns above), so this fetches as soon as tools are ready
  // rather than waiting on a click.
  const activityRecords = useActivityRecords(config, tools, true, onLog);

  // Tick for relative-time display
  useEffect(() => {
    const id = setInterval(() => setRefreshTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Function naming/duplicate/failure health — bounded to the first ~1000
  // functions (5 pages of 200) so a huge org doesn't trigger unbounded fetches.
  useEffect(() => {
    if (functionHealthFetched.current) return;
    if (tools.length === 0) return;
    const functionsTool = tools.find(t => /getfunctions$/i.test(t.name));
    const failuresTool = tools.find(t => /getautomationfunctionfailures$/i.test(t.name));
    if (!functionsTool && !failuresTool) return;

    functionHealthFetched.current = true;
    void (async () => {
      const names: string[] = [];
      let hasMore = false;
      if (functionsTool) {
        for (let page = 1; page <= MAX_FUNCTION_PAGES; page++) {
          const start = Date.now();
          const input = { query_params: { page, per_page: 200 } };
          try {
            const output = await executeTool(config, functionsTool.name, input);
            const items = extractArray(output) as Record<string, unknown>[];
            for (const f of items) {
              if (typeof f.name === "string" && f.name) names.push(f.name);
            }
            onLog({ id: crypto.randomUUID(), tool: functionsTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
            hasMore = hasMoreRecords(output);
            if (items.length === 0 || !hasMore) break;
          } catch (e: unknown) {
            onLog({ id: crypto.randomUUID(), tool: functionsTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
            break;
          }
        }
      }

      let failureCount = 0;
      const failuresChecked = !!failuresTool;
      if (failuresTool) {
        const start = Date.now();
        const input = { query_params: { page: 1, per_page: 200 } };
        try {
          const output = await executeTool(config, failuresTool.name, input);
          failureCount = extractArray(output).length;
          onLog({ id: crypto.randomUUID(), tool: failuresTool.name, input, output, status: "success", durationMs: Date.now() - start, timestamp: new Date() });
        } catch (e: unknown) {
          onLog({ id: crypto.randomUUID(), tool: failuresTool.name, input, output: null, status: "error", errorMessage: e instanceof Error ? e.message : "Failed", durationMs: Date.now() - start, timestamp: new Date() });
        }
      }

      const nameCounts = new Map<string, number>();
      names.forEach(n => { const k = n.trim().toLowerCase(); nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1); });
      const duplicateGroups = Array.from(nameCounts.entries())
        .filter(([, count]) => count > 1)
        .map(([key, count]) => ({ name: names.find(n => n.trim().toLowerCase() === key) ?? key, count }));
      const suspiciousNames = names.filter(n => SUSPICIOUS_FUNCTION_NAME.test(n.trim()));

      setFunctionHealth({ totalScanned: names.length, hasMore, duplicateGroups, suspiciousNames, failuresChecked, failureCount });
    })();
  }, [tools, config, onLog]);

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

  const recommendations = generateRecommendations(entityData, tools, ruleCoverage, functionHealth);
  const filteredRecs = recommendations.filter(r => r.category === activeTab);
  const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityData[e.type].items.length, 0);
  const loadingCount = CRM_ENTITIES.filter(e => entityData[e.type].loading).length;
  const loadedCount = CRM_ENTITIES.filter(e => entityData[e.type].lastFetched !== null).length;
  const ziaTool = findZiaTool(tools);

  const kpis = computeKpis(entityData, ruleCoverage);
  const moduleBreakdown = expandedKpi === "modules" ? computeModuleBreakdown(entityData) : [];
  const blueprintBreakdown = expandedKpi === "blueprints" ? computeBlueprintBreakdown(entityData) : [];
  const layoutBreakdown = expandedKpi === "layouts" ? computeLayoutBreakdown(entityData.modules.items, layoutsByModule.byModule) : [];
  const scheduleBreakdown = expandedKpi === "schedules" ? computeScheduleBreakdown(scheduleRecords.items) : [];
  const ziaScheduleInsight = expandedKpi === "schedules" ? buildZiaScheduleInsight(scheduleBreakdown) : null;
  const configRows = computeConfigRows(entityData);
  const workflowBreakdown = computeWorkflowBreakdown(entityData);
  const ziaWorkflowInsight = buildZiaWorkflowInsight(workflowBreakdown);
  const activityStats = buildActivityStats(isEntityResolved(entityData.tasks), entityData.tasks.items, activityRecords.calls, activityRecords.emails);
  const ziaActivityInsight = buildZiaActivityInsight(entityData.tasks.items, activityRecords.calls, activityRecords.emails);
  const blueprintItems = entityData.blueprints.items;
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
          <button className="btn-secondary" onClick={fetchAll} disabled={loadingCount > 0}>
            ↺ Refresh All
          </button>
          <button className="btn-connect" onClick={downloadFullReport}>
            ↓ Download Full Report (PDF)
          </button>
        </div>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────────────────── */}
      <div className="kpi-strip">
        {kpis.map(k => {
          const toggle = () => setExpandedKpi(prev => (prev === k.key ? null : (k.key as "modules" | "blueprints" | "layouts" | "schedules")));
          return (
            <div
              key={k.key}
              className={`kpi-tile kpi-${k.severity} ${k.clickable ? "kpi-clickable" : ""} ${expandedKpi === k.key ? "kpi-expanded" : ""}`}
              onClick={k.clickable ? toggle : undefined}
              role={k.clickable ? "button" : undefined}
              tabIndex={k.clickable ? 0 : undefined}
              onKeyDown={k.clickable ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } : undefined}
            >
              <span className="kpi-tile-label">{k.label}</span>
              <span className="kpi-tile-value">{k.value.toLocaleString()}</span>
              <span className="kpi-tile-note">{k.note}</span>
            </div>
          );
        })}
      </div>

      {expandedKpi === "modules" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Modules — Active vs Inactive</h4>
            <button className="kpi-drilldown-close" onClick={() => setExpandedKpi(null)}>✕</button>
          </div>
          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good">{moduleBreakdown.filter(r => r.active).length} Active</span>
            <span className="kpi-drilldown-stat bad">{moduleBreakdown.filter(r => !r.active).length} Inactive</span>
          </div>
          <div className="kpi-drilldown-table">
            {moduleBreakdown.map(row => (
              <div key={row.apiName} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module">{row.apiName}</span>
                {row.custom && <span className="kpi-drilldown-badge neutral">custom</span>}
                <span className={`kpi-drilldown-badge status-${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {expandedKpi === "blueprints" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Blueprints — Active vs Inactive</h4>
            <button className="kpi-drilldown-close" onClick={() => setExpandedKpi(null)}>✕</button>
          </div>
          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good">{blueprintBreakdown.filter(r => r.status === "active").length} Active</span>
            <span className="kpi-drilldown-stat bad">{blueprintBreakdown.filter(r => r.status === "inactive").length} Inactive</span>
            {blueprintBreakdown.some(r => r.status === "draft") && (
              <span className="kpi-drilldown-stat neutral">{blueprintBreakdown.filter(r => r.status === "draft").length} Draft</span>
            )}
          </div>
          <div className="kpi-drilldown-table">
            {blueprintBreakdown.map(row => (
              <div key={row.id} className="kpi-drilldown-row">
                <span className="kpi-drilldown-name">{row.name}</span>
                <span className="kpi-drilldown-module">{row.module}</span>
                <span className={`kpi-drilldown-badge status-${row.status}`}>{row.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {expandedKpi === "layouts" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Layouts — Standard vs Custom, Per Module</h4>
            <button className="kpi-drilldown-close" onClick={() => setExpandedKpi(null)}>✕</button>
          </div>
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
        </div>
      )}

      {expandedKpi === "schedules" && (
        <div className="kpi-drilldown">
          <div className="kpi-drilldown-header">
            <h4>Schedules — Active / Inactive / Last Run</h4>
            <button className="kpi-drilldown-close" onClick={() => setExpandedKpi(null)}>✕</button>
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

      {/* ── CRM Configuration summary ──────────────────────────────────────────── */}
      <div className="business-view-section">
        <h3 className="business-view-section-title">CRM Configuration</h3>
        <div className="config-grid">
          {configRows.map(row => {
            const clickable = row.targetSection !== null;
            return (
              <div
                key={row.key}
                className={`config-tile config-${row.severity} ${clickable ? "clickable" : ""}`}
                onClick={clickable ? () => onSelectSection(row.targetSection as Section) : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectSection(row.targetSection as Section); } } : undefined}
              >
                <span className="config-tile-label">{row.label}</span>
                <span className="config-tile-value">{row.value}</span>
                <span className="config-tile-status">{row.status}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Workflows / Activity detail cards ──────────────────────────────────── */}
      <div className="crm-panels-row crm-panels-row-2col">
        <div className="business-view-section crm-panel-card">
          <h3 className="business-view-section-title">Workflows — Active / Inactive / Last Triggered</h3>
          <div className="kpi-drilldown-summary">
            <span className="kpi-drilldown-stat good">{workflowBreakdown.filter(r => r.active).length} Active</span>
            <span className="kpi-drilldown-stat bad">{workflowBreakdown.filter(r => !r.active).length} Inactive</span>
            <span className="kpi-drilldown-stat neutral">{workflowBreakdown.filter(r => !r.lastTriggered).length} Never Triggered</span>
          </div>
          <div className="kpi-drilldown-table">
            {workflowBreakdown.map(row => (
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

        <div className="business-view-section crm-panel-card">
          <h3 className="business-view-section-title">Activity — Email / Task / Call</h3>
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
      </div>

      {/* ── Blueprints / Profiles / Users panels ───────────────────────────────── */}
      <div className="crm-panels-row">
        <div className="business-view-section crm-panel-card">
          <h3 className="business-view-section-title">Blueprints</h3>
          {blueprintItems.length === 0 ? (
            <PanelEmptyState state={entityData.blueprints} label="Blueprints" onRetry={() => fetchEntity("blueprints")} />
          ) : (
            <>
              <ul className="panel-item-list">
                {blueprintItems.slice(0, 8).map((item, idx) => {
                  const active = isActiveWorkflow(item);
                  return (
                    <li key={idx} className="panel-item-row">
                      <span className="panel-item-name">{getItemName(item, idx)}</span>
                      <span className={`panel-item-badge ${active ? "badge-active" : "badge-inactive"}`}>
                        {active ? "Active" : "Inactive"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {blueprintItems.length > 8 && (
                <p className="panel-more">+{blueprintItems.length - 8} more</p>
              )}
              <button className="btn-secondary panel-remediate-btn" onClick={() => onSelectSection("blueprints")}>
                Get remediation help
              </button>
            </>
          )}
        </div>

        <div className="business-view-section crm-panel-card">
          <h3 className="business-view-section-title">Profiles</h3>
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

        <div className="business-view-section crm-panel-card">
          <h3 className="business-view-section-title">Users</h3>
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
      </div>

      {/* ── Zia Recommendations ─────────────────────────────────────────────── */}
      <div className="crm-recs-section">
        <div className="crm-right">
          <div className="crm-right-header">
            <p className="crm-panel-label">Zia Recommendations</p>
            {ziaTool && (
              <span className="zia-tool-badge" title={ziaTool.description ?? ziaTool.name}>
                ⚡ {ziaTool.name}
              </span>
            )}
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

          <div className="zia-recs">
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
