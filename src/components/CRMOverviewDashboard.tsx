"use client";

import React, { useState, useEffect, useRef } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";
import {
  type CrmEntityType,
  type EntityState,
  CRM_ENTITIES,
  getItemName,
  getItemStatus,
  isEntityResolved,
} from "@/lib/useCrmEntities";
import type { Section } from "@/lib/sections";
import { isActiveWorkflow, isAdminProfile, isCustomModule, isInactiveUser } from "@/lib/crmPredicates";
import { computeHealthScore, HEALTH_SCORE_ENTITIES, type HealthScoreDimensions } from "@/lib/businessScore";
import HealthGauge from "@/components/HealthGauge";

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
}

type Severity = "critical" | "warning" | "good";

interface KpiItem {
  key: string;
  label: string;
  value: number;
  severity: Severity;
  note: string;
}

interface MissingDataItem {
  key: string;
  label: string;
  severity: "critical" | "warning";
  message: string;
  targetSection: Section;
}

const CATEGORY_GROUPS: { key: string; label: string; dims: (keyof HealthScoreDimensions)[] }[] = [
  { key: "process",    label: "Process Health",  dims: ["processCompleteness"] },
  { key: "hygiene",    label: "Module Hygiene",  dims: ["dataArchitecture"] },
  { key: "adoption",   label: "User Adoption",   dims: ["accessSecurity"] },
  { key: "automation", label: "Automation",      dims: ["automationCoverage", "automationHealth"] },
];

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
  tools: McpTool[]
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

function categoryScorePct(dims: HealthScoreDimensions, keys: (keyof HealthScoreDimensions)[]): number {
  const sum = keys.reduce((s, k) => s + dims[k], 0);
  return Math.round((sum / (keys.length * 20)) * 100);
}

function computeKpis(entityData: Record<CrmEntityType, EntityState>): KpiItem[] {
  const modules = entityData.modules.items;
  const blueprints = entityData.blueprints.items;
  const users = entityData.users.items;
  const layouts = entityData.layouts.items;

  const hiddenCount = modules.filter(isHiddenModule).length;
  const hiddenPct = modules.length ? Math.round((hiddenCount / modules.length) * 100) : 0;
  const inactiveBps = blueprints.filter(b => !isActiveWorkflow(b)).length;
  const activeUsers = users.filter(u => !isInactiveUser(u)).length;
  const layoutGap = Math.max(0, modules.length - layouts.length);

  return [
    {
      key: "modules", label: "Modules", value: modules.length,
      severity: hiddenPct >= 40 ? "critical" : hiddenPct >= 15 ? "warning" : "good",
      note: modules.length ? `${hiddenPct}% hidden from users` : "No modules found",
    },
    {
      key: "blueprints", label: "Blueprints", value: blueprints.length,
      severity: blueprints.length > 0 && inactiveBps === blueprints.length ? "critical" : inactiveBps > 0 ? "warning" : "good",
      note: blueprints.length ? `${inactiveBps} inactive` : "No blueprints found",
    },
    {
      key: "users", label: "Active Users", value: activeUsers,
      severity: activeUsers <= 1 ? "critical" : activeUsers < 5 ? "warning" : "good",
      note: `${users.length} total licensed`,
    },
    {
      key: "layouts", label: "Layouts", value: layouts.length,
      severity: layouts.length === 0 && modules.length > 0 ? "critical" : layoutGap > 0 ? "warning" : "good",
      note: layoutGap > 0 ? `${layoutGap} module${layoutGap === 1 ? "" : "s"} missing a layout` : "Covers all modules",
    },
  ];
}

function computeModuleVisibility(entityData: Record<CrmEntityType, EntityState>) {
  const modules = entityData.modules.items;
  const blueprints = entityData.blueprints.items;
  const hidden = modules.filter(isHiddenModule).length;
  const visible = modules.length - hidden;
  const hiddenPct = modules.length ? Math.round((hidden / modules.length) * 100) : 0;
  const visiblePct = modules.length ? 100 - hiddenPct : 0;
  const customCount = modules.filter(isCustomModule).length;
  const blueprintsActive = blueprints.filter(isActiveWorkflow).length;
  const blueprintsPct = blueprints.length ? Math.round((blueprintsActive / blueprints.length) * 100) : 0;
  return {
    total: modules.length, visible, hidden, hiddenPct, visiblePct, customCount,
    blueprintsActive, blueprintsTotal: blueprints.length, blueprintsPct,
  };
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
  { type: "blueprints", label: "Blueprints", targetSection: "blueprints" },
  { type: "fields",    label: "Fields",    targetSection: "fields" },
  { type: "profiles",  label: "Profiles",  targetSection: null },
  { type: "users",     label: "Users",     targetSection: null },
  { type: "tasks",     label: "Tasks",     targetSection: "modules" },
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
      case "workflows":
      case "blueprints": {
        const inactive = st.items.filter(i => !isActiveWorkflow(i)).length;
        if (inactive === 0) { status = "Active"; severity = "good"; }
        else if (inactive === count) { status = `${inactive} inactive`; severity = "critical"; }
        else { status = `${inactive} inactive`; severity = "warning"; }
        break;
      }
      case "users": {
        const inactive = st.items.filter(isInactiveUser).length;
        if (inactive === 0) { status = "Active"; severity = "good"; }
        else { status = `${inactive} inactive`; severity = "warning"; }
        break;
      }
      case "fields":
        status = count < 10 ? "Low" : "Configured";
        severity = count < 10 ? "warning" : "good";
        break;
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

const MISSING_DATA_CHECKS: { type: CrmEntityType; label: string; targetSection: Section; severity: "critical" | "warning" }[] = [
  { type: "stages",    label: "Stages",    targetSection: "blueprints", severity: "critical" },
  { type: "tasks",     label: "Tasks",     targetSection: "modules",    severity: "critical" },
  { type: "fields",    label: "Fields",    targetSection: "fields",     severity: "warning" },
  { type: "pipelines", label: "Pipelines", targetSection: "modules",    severity: "warning" },
];

function computeMissingData(entityData: Record<CrmEntityType, EntityState>): MissingDataItem[] {
  const items: MissingDataItem[] = [];
  for (const check of MISSING_DATA_CHECKS) {
    const st = entityData[check.type];
    if (!isEntityResolved(st) || st.items.length > 0) continue;
    // No matching tool means we simply have no visibility into this entity —
    // that's a tooling gap, not a real "missing data" finding, so don't flag it.
    if (!st.toolUsed) continue;
    const message = st.error
      ? `${check.label} not found — ${st.error}`
      : `No ${check.label.toLowerCase()} configured`;
    items.push({ key: check.type, label: check.label, severity: check.severity, message, targetSection: check.targetSection });
  }
  return items;
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

export default function CRMOverviewDashboard({ config, tools, onLog, entityData, fetchEntity, fetchAll, lastRefresh, onSelectSection }: Props) {
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
  const [remediation, setRemediation] = useState<Record<string, { loading: boolean; text: string }>>({});

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
  async function askZiaAbout(rec: Recommendation) {
    setRemediation(prev => ({ ...prev, [rec.id]: { loading: true, text: "" } }));
    try {
      const text = await runZiaQuery(`How do I fix "${rec.title}"? ${rec.description} Give me concrete remediation steps.`, rec.id, rec.title);
      setRemediation(prev => ({ ...prev, [rec.id]: { loading: false, text } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Tool call failed";
      setRemediation(prev => ({ ...prev, [rec.id]: { loading: false, text: `⚠ ${msg}` } }));
    }
  }

  void refreshTick; // used for relative time updates

  const recommendations = generateRecommendations(entityData, tools);
  const filteredRecs = recommendations.filter(r => r.category === activeTab);
  const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityData[e.type].items.length, 0);
  const loadingCount = CRM_ENTITIES.filter(e => entityData[e.type].loading).length;
  const loadedCount = CRM_ENTITIES.filter(e => entityData[e.type].lastFetched !== null).length;
  const ziaTool = findZiaTool(tools);

  const healthResolved = HEALTH_SCORE_ENTITIES.every(t => isEntityResolved(entityData[t]));
  const healthScore = computeHealthScore(entityData);
  const kpis = computeKpis(entityData);
  const moduleVis = computeModuleVisibility(entityData);
  const missingData = computeMissingData(entityData);
  const configRows = computeConfigRows(entityData);
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

  function formatReportAsText(category: ReportTab, catRecs: Recommendation[]): string {
    const lines: string[] = [];
    const categoryLabel = category === "changes" ? "Changes" : category === "integrations" ? "Integrations" : "Architecture";
    lines.push(`ZOHO CRM ${categoryLabel.toUpperCase()} REPORT`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("=".repeat(60));

    lines.push("");
    lines.push("CRM SUMMARY");
    lines.push("-".repeat(60));
    CRM_ENTITIES.forEach(e => {
      const state = entityData[e.type];
      const status = state.error ? `ERROR — ${state.error}` : `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
      lines.push(`${e.label.padEnd(14)} ${status}${state.toolUsed ? `  (via ${state.toolUsed})` : ""}`);
    });

    lines.push("");
    lines.push(`RECOMMENDATIONS (${catRecs.length})`);
    lines.push("-".repeat(60));
    if (catRecs.length === 0) {
      lines.push("No recommendations in this category.");
    } else {
      catRecs.forEach((r, i) => {
        lines.push("");
        lines.push(`[${i + 1}] ${r.title}  (${r.severity.toUpperCase()})`);
        lines.push(r.description);
      });
    }

    return lines.join("\n");
  }

  function downloadReport(category: ReportTab) {
    const catRecs = recommendations.filter(r => r.category === category);
    const blob = new Blob([formatReportAsText(category, catRecs)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zoho-crm-${category}-report-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
        </div>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────────────────── */}
      <div className="kpi-strip">
        {kpis.map(k => (
          <div key={k.key} className={`kpi-tile kpi-${k.severity}`}>
            <span className="kpi-tile-label">{k.label}</span>
            <span className="kpi-tile-value">{k.value.toLocaleString()}</span>
            <span className="kpi-tile-note">{k.note}</span>
          </div>
        ))}
      </div>

      {/* ── Health score / module visibility / missing data ───────────────────── */}
      <div className="crm-insights-row">
        <div className="business-view-section health-gauge-card crm-health-card">
          <h3 className="business-view-section-title">CRM Health Score</h3>
          <HealthGauge score={healthScore.total} zone={healthScore.zone} resolved={healthResolved} />
          <p className={`health-gauge-verdict ${healthResolved ? `zone-${healthScore.zone}` : ""}`}>
            {healthResolved ? healthScore.verdict : "Reading your CRM setup…"}
          </p>
          <div className="health-subscores">
            {CATEGORY_GROUPS.map(g => {
              const pct = healthResolved ? categoryScorePct(healthScore.dimensions, g.dims) : 0;
              return (
                <div key={g.key} className="health-subscore-row" style={{ cursor: "default" }}>
                  <span className="health-subscore-label">{g.label}</span>
                  <span className="health-subscore-track">
                    <span className="health-subscore-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="health-subscore-value">{healthResolved ? `${pct}%` : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="business-view-section crm-vis-card">
          <h3 className="business-view-section-title">Module Visibility</h3>
          <div className="module-vis-bar">
            <div className="module-vis-fill" style={{ width: `${100 - moduleVis.hiddenPct}%` }} />
          </div>
          {moduleVis.total === 0 ? (
            <p className="business-view-hint">No modules found.</p>
          ) : (
            <div className="module-breakdown">
              <div className="module-breakdown-row">
                <span className="module-breakdown-label">Visible to users</span>
                <span className="module-breakdown-value good">{moduleVis.visible} ({moduleVis.visiblePct}%)</span>
              </div>
              <div className="module-breakdown-row">
                <span className="module-breakdown-label">Hidden modules</span>
                <span className="module-breakdown-value critical">{moduleVis.hidden} ({moduleVis.hiddenPct}%)</span>
              </div>
              <div className="module-breakdown-row">
                <span className="module-breakdown-label">Custom modules</span>
                <span className="module-breakdown-value">{moduleVis.customCount} active</span>
              </div>
              <div className="module-breakdown-row">
                <span className="module-breakdown-label">Blueprints active</span>
                <span className="module-breakdown-value">
                  {moduleVis.blueprintsTotal === 0 ? "N/A" : `${moduleVis.blueprintsActive} of ${moduleVis.blueprintsTotal} (${moduleVis.blueprintsPct}%)`}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="business-view-section crm-missing-card">
          <div className="missing-data-header">
            <h3 className="business-view-section-title" style={{ marginBottom: 0 }}>Missing Data</h3>
            {missingData.length > 0 && <span className="crm-fb-count">{missingData.length}</span>}
          </div>
          <p className="business-view-hint" style={{ padding: "4px 0 8px" }}>
            Flags CRM areas — stages, tasks, fields, pipelines — that have no data configured yet, so you can spot and address gaps.
          </p>
          {missingData.length === 0 ? (
            <p className="business-view-hint">No critical data gaps detected.</p>
          ) : (
            missingData.map(item => (
              <div key={item.key} className={`missing-data-row sev-${item.severity}`}>
                <span className="missing-data-msg">{item.message}</span>
                <button className="btn-secondary missing-data-view" onClick={() => onSelectSection(item.targetSection)}>
                  View
                </button>
              </div>
            ))
          )}
        </div>
      </div>

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
              >
                <span className="config-tile-label">{row.label}</span>
                <span className="config-tile-value">{row.value}</span>
                <span className="config-tile-status">{row.status}</span>
              </div>
            );
          })}
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
                      <div className="zia-rec-remediation">{rem.text}</div>
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
                  ↓ Download TXT Report
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
