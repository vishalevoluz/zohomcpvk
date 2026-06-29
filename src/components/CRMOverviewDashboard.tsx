"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { McpConfig, McpTool, ExecutionLog } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";

// ─── Types ────────────────────────────────────────────────────────────────────

type CrmEntityType = "blueprints" | "modules" | "layouts" | "tasks" | "pipelines" | "stages" | "workflows" | "profiles" | "users" | "fields";
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

interface EntityState {
  items: unknown[];
  loading: boolean;
  error: string | null;
  toolUsed: string | null;
  expanded: boolean;
  lastFetched: number | null;
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CRM_ENTITIES: { type: CrmEntityType; label: string; icon: string; plural: string }[] = [
  { type: "modules",    label: "Modules",    icon: "⊞", plural: "modules" },
  { type: "layouts",    label: "Layouts",    icon: "⊟", plural: "layouts" },
  { type: "pipelines",  label: "Pipelines",  icon: "⇥", plural: "pipelines" },
  { type: "stages",     label: "Stages",     icon: "◉", plural: "stages" },
  { type: "workflows",  label: "Workflows",  icon: "⟳", plural: "workflows" },
  { type: "blueprints", label: "Blueprints", icon: "◈", plural: "blueprints" },
  { type: "fields",     label: "Fields",     icon: "▤", plural: "fields" },
  { type: "profiles",   label: "Profiles",   icon: "◑", plural: "profiles" },
  { type: "users",      label: "Users",      icon: "◎", plural: "users" },
  { type: "tasks",      label: "Tasks",      icon: "✓", plural: "tasks" },
];

const ENTITY_PREFS: Record<CrmEntityType, { preferred: string[]; patterns: RegExp[] }> = {
  blueprints: {
    preferred: ["getBlueprints", "getAllBlueprints", "listBlueprints", "getBlueprintList", "getBlueprintProcesses"],
    patterns: [/getallblueprint/i, /getblueprint(?!byid|id|record|stage)/i, /listblueprint/i],
  },
  modules: {
    preferred: ["getModules", "getAllModules", "listModules", "getCRMModules", "getAvailableModules"],
    patterns: [/getmodule(?!field|layout|byid|byname)/i, /listmodule/i, /allmodule/i],
  },
  layouts: {
    // getLayouts is the exact tool name the user added
    preferred: ["getLayouts", "getAllLayouts", "getModuleLayouts", "listLayouts", "getLayoutList"],
    patterns: [/getlayout(?!byid)/i, /listlayout/i, /alllayout/i],
  },
  tasks: {
    preferred: ["getTasks", "getAllTasks", "listTasks", "getActivities", "getAllActivities", "getTaskList"],
    patterns: [/gettask(?!byid)/i, /listtask/i, /alltask/i, /getactivit/i],
  },
  pipelines: {
    // getPipelines is the exact tool name the user added
    preferred: ["getPipelines", "getAllPipelines", "listPipelines", "getSalesPipelines", "getDealPipelines"],
    patterns: [/getpipeline(?!byid)/i, /listpipeline/i, /allpipeline/i, /salespipeline/i],
  },
  stages: {
    preferred: ["getStages", "getAllStages", "getDealStages", "getPipelineStages", "listStages"],
    patterns: [/getstage(?!byid)/i, /liststage/i, /allstage/i, /dealstage/i, /pipelinestage/i],
  },
  workflows: {
    preferred: ["getWorkflowRules", "getWorkflows", "getAllWorkflows", "listWorkflows", "getAutomationWorkflows"],
    patterns: [/getworkflowrule(?!byid)/i, /listworkflow/i, /allworkflow/i, /getworkflows?$/i],
  },
  // ── New tools added by user ─────────────────────────────────────────────────
  profiles: {
    // getProfile is the exact tool name the user added
    preferred: ["getProfile", "getProfiles", "getAllProfiles", "listProfiles", "getCRMProfiles"],
    patterns: [/getprofile(?!byid|field)/i, /listprofile/i, /allprofile/i, /profile/i],
  },
  users: {
    // getUser is the exact tool name the user added
    preferred: ["getUser", "getUsers", "getAllUsers", "listUsers", "getCRMUsers", "getUserList"],
    patterns: [/getuser(?!byid|profile|pref)/i, /listuser/i, /alluser/i],
  },
  fields: {
    // getFields is the exact tool name the user added
    preferred: ["getFields", "getAllFields", "listFields", "getModuleFields", "getCRMFields"],
    patterns: [/getfield(?!byid)/i, /listfield/i, /allfield/i, /getfields/i],
  },
};

const ZIA_PATTERNS = [/\bzia\b/i, /recommend/i, /\banalyze\b/i, /\binsight/i, /\bsuggest/i];

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

function findToolForEntity(tools: McpTool[], type: CrmEntityType): McpTool | null {
  const { preferred, patterns } = ENTITY_PREFS[type];
  for (const name of preferred) {
    const t = tools.find(t => t.name === name);
    if (t) return t;
  }
  return tools.find(t => patterns.some(p => p.test(t.name))) ?? null;
}

function findZiaTool(tools: McpTool[]): McpTool | null {
  for (const p of ZIA_PATTERNS) {
    const t = tools.find(t => p.test(t.name) || p.test(t.description ?? ""));
    if (t) return t;
  }
  return null;
}

function extractArray(output: unknown): unknown[] {
  if (!output) return [];
  if (Array.isArray(output)) return output;
  if (typeof output !== "object") return [];
  const r = output as Record<string, unknown>;

  // Unwrap MCP content wrapper: { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(r.content)) {
    for (const c of r.content as Record<string, unknown>[]) {
      if (c.type === "text" && typeof c.text === "string") {
        try {
          const parsed = JSON.parse(c.text);
          if (Array.isArray(parsed)) return parsed;
          if (typeof parsed === "object" && parsed !== null) return extractArray(parsed);
        } catch { /* not JSON */ }
      }
    }
  }

  // Try standard response keys (includes new entity keys)
  const keys = ["data", "blueprints", "modules", "layouts", "tasks", "pipelines", "stages",
                 "workflows", "profiles", "users", "fields", "result", "results", "records",
                 "items", "list", "response"];
  for (const key of keys) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  for (const val of Object.values(r)) {
    if (Array.isArray(val) && val.length > 0) return val;
  }
  // Single-object responses (e.g. getProfile / getUser returning one record) — wrap in array
  const hasId = "id" in r || "userId" in r || "profileId" in r || "name" in r;
  if (hasId) return [r];
  return [];
}

function getItemName(item: unknown, idx: number): string {
  if (!item || typeof item !== "object") return `Item ${idx + 1}`;
  const r = item as Record<string, unknown>;
  return String(
    r.name ?? r.display_name ?? r.label ?? r.api_name ??
    r.workflow_name ?? r.blueprint_name ?? r.pipeline_name ??
    r.stage_name ?? r.title ?? `Item ${idx + 1}`
  );
}

function getItemId(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const r = item as Record<string, unknown>;
  return String(r.id ?? r.workflow_id ?? r.blueprint_id ?? r.pipeline_id ?? "");
}

function getItemStatus(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const raw = r.status ?? r.active ?? r.enabled ?? r.is_active;
  if (raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "Active" : "Inactive";
  const s = String(raw);
  return s || null;
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

// ─── Main component ───────────────────────────────────────────────────────────

const INIT_STATE: EntityState = {
  items: [], loading: false, error: null, toolUsed: null, expanded: true, lastFetched: null,
};

function makeInitial(): Record<CrmEntityType, EntityState> {
  return {
    blueprints: { ...INIT_STATE },
    modules:    { ...INIT_STATE },
    layouts:    { ...INIT_STATE },
    tasks:      { ...INIT_STATE },
    pipelines:  { ...INIT_STATE },
    stages:     { ...INIT_STATE },
    workflows:  { ...INIT_STATE },
    profiles:   { ...INIT_STATE },
    users:      { ...INIT_STATE },
    fields:     { ...INIT_STATE },
  };
}

export default function CRMOverviewDashboard({ config, tools, onLog }: Props) {
  const [entityData, setEntityData] = useState<Record<CrmEntityType, EntityState>>(makeInitial);
  const [activeTab, setActiveTab] = useState<ReportTab>("changes");
  const [ziaMessages, setZiaMessages] = useState<ZiaMessage[]>([]);
  const [ziaInput, setZiaInput] = useState("");
  const [ziaLoading, setZiaLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const hasFetched = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [feedbackForm, setFeedbackForm] = useState<{ name: string; category: FeedbackCategory; rating: number; message: string }>({
    name: "", category: "general", rating: 0, message: "",
  });
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "success">("idle");

  const fetchEntity = useCallback(async (type: CrmEntityType) => {
    const tool = findToolForEntity(tools, type);

    setEntityData(prev => ({
      ...prev,
      [type]: { ...prev[type], loading: true, error: null, toolUsed: tool?.name ?? null },
    }));

    if (!tool) {
      setEntityData(prev => ({
        ...prev,
        [type]: { ...prev[type], loading: false, error: "No matching tool found", toolUsed: null },
      }));
      return;
    }

    const start = Date.now();
    try {
      const output = await executeTool(config, tool.name, {});
      const items = extractArray(output);
      const durationMs = Date.now() - start;

      onLog({
        id: Math.random().toString(36).slice(2),
        tool: tool.name,
        input: {},
        output,
        status: "success",
        durationMs,
        timestamp: new Date(),
      });

      setEntityData(prev => ({
        ...prev,
        [type]: { ...prev[type], loading: false, items, error: null, toolUsed: tool.name, lastFetched: Date.now() },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to fetch";
      onLog({
        id: Math.random().toString(36).slice(2),
        tool: tool.name,
        input: {},
        output: null,
        status: "error",
        errorMessage: msg,
        durationMs: Date.now() - start,
        timestamp: new Date(),
      });
      setEntityData(prev => ({
        ...prev,
        [type]: { ...prev[type], loading: false, error: msg, toolUsed: tool.name },
      }));
    }
  }, [config, tools, onLog]);

  const fetchAll = useCallback(() => {
    hasFetched.current = true;
    setLastRefresh(new Date());
    CRM_ENTITIES.forEach(e => fetchEntity(e.type));
    setRefreshTick(t => t + 1);
  }, [fetchEntity]);

  // Auto-fetch when tools are available
  useEffect(() => {
    if (!hasFetched.current && tools.length > 0) {
      fetchAll();
    }
  }, [tools, fetchAll]);

  // Tick for relative-time display
  useEffect(() => {
    const id = setInterval(() => setRefreshTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const toggleExpand = (type: CrmEntityType) => {
    setEntityData(prev => ({
      ...prev,
      [type]: { ...prev[type], expanded: !prev[type].expanded },
    }));
  };

  async function sendToZia() {
    const q = ziaInput.trim();
    if (!q || ziaLoading) return;
    setZiaInput("");
    setZiaMessages(prev => [...prev, { role: "user", content: q }]);

    const ziaTool = findZiaTool(tools);
    const tool = ziaTool ?? tools[0];

    if (!tool) {
      setZiaMessages(prev => [...prev, {
        role: "zia",
        content: "No MCP tools available. Please ensure your MCP server is connected.",
      }]);
      return;
    }

    setZiaLoading(true);
    setZiaMessages(prev => [...prev, { role: "zia", content: "", isLoading: true }]);

    // Build rich CRM context from all loaded entities
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
    // Profiles detail
    const profItems = entityData.profiles.items;
    if (profItems.length > 0) {
      ctxLines.push(`Profile Names: ${profItems.map((p, i) => getItemName(p, i)).join(", ")}`);
    }
    // Users detail
    const userItems = entityData.users.items;
    if (userItems.length > 0) {
      ctxLines.push(`Users (${userItems.length}): ${userItems.slice(0, 3).map((u, i) => getItemName(u, i)).join(", ")}${userItems.length > 3 ? ", …" : ""}`);
    }
    // Pipelines detail
    const pipeItems = entityData.pipelines.items;
    if (pipeItems.length > 0) {
      ctxLines.push(`Pipeline Names: ${pipeItems.map((p, i) => getItemName(p, i)).join(", ")}`);
    }
    const crmContext = ctxLines.join("\n");

    const props = tool.inputSchema?.properties ?? {};
    const params: Record<string, unknown> = {};
    const queryKey = Object.keys(props).find(k =>
      ["query", "question", "prompt", "text", "message", "input", "search", "context"].includes(k.toLowerCase())
    );
    if (queryKey) {
      params[queryKey] = `${q}\n\n${crmContext}`;
    }

    try {
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
      setZiaMessages(prev => [
        ...prev.slice(0, -1),
        { role: "zia", content: text || "No response received from tool." },
      ]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Tool call failed";
      setZiaMessages(prev => [
        ...prev.slice(0, -1),
        { role: "zia", content: `Error: ${msg}` },
      ]);
    } finally {
      setZiaLoading(false);
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [ziaMessages]);

  void refreshTick; // used for relative time updates

  const recommendations = generateRecommendations(entityData, tools);
  const filteredRecs = recommendations.filter(r => r.category === activeTab);
  const totalItems = CRM_ENTITIES.reduce((sum, e) => sum + entityData[e.type].items.length, 0);
  const loadingCount = CRM_ENTITIES.filter(e => entityData[e.type].loading).length;
  const loadedCount = CRM_ENTITIES.filter(e => entityData[e.type].lastFetched !== null).length;
  const ziaTool = findZiaTool(tools);

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

  function downloadReport(category: ReportTab) {
    const catRecs = recommendations.filter(r => r.category === category);
    const report = {
      generated: new Date().toISOString(),
      category,
      crmSummary: Object.fromEntries(
        CRM_ENTITIES.map(e => [e.type, {
          count: entityData[e.type].items.length,
          toolUsed: entityData[e.type].toolUsed,
          error: entityData[e.type].error,
        }])
      ),
      recommendations: catRecs,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zoho-crm-${category}-report-${Date.now()}.json`;
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
            <h2 className="crm-header-title">CRM Overview Dashboard</h2>
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

      {/* ── Stats row ───────────────────────────────────────────────────────── */}
      <div className="crm-stats-row">
        {CRM_ENTITIES.map(e => {
          const st = entityData[e.type];
          return (
            <div key={e.type} className={`crm-stat ${st.loading ? "crm-stat-loading" : ""}`}>
              <span className="crm-stat-icon">{e.icon}</span>
              <div className="crm-stat-info">
                <span className="crm-stat-label">{e.label}</span>
                {st.loading ? (
                  <span className="crm-stat-count crm-stat-loading-val">…</span>
                ) : st.error && st.items.length === 0 ? (
                  <span className="crm-stat-count crm-stat-err">—</span>
                ) : (
                  <span className="crm-stat-count">{st.items.length.toLocaleString()}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Split layout ────────────────────────────────────────────────────── */}
      <div className="crm-split">

        {/* Left: Current CRM */}
        <div className="crm-left">
          <p className="crm-panel-label">Current CRM</p>
          <div className="crm-entities">
            {CRM_ENTITIES.map(e => {
              const st = entityData[e.type];
              return (
                <div key={e.type} className="crm-entity">
                  <div className="crm-entity-header" onClick={() => toggleExpand(e.type)}>
                    <span className="crm-entity-icon">{e.icon}</span>
                    <span className="crm-entity-label">{e.label}</span>
                    <div className="crm-entity-meta">
                      {st.loading ? (
                        <span className="spinner" style={{ width: 10, height: 10 }} />
                      ) : st.error && st.items.length === 0 ? (
                        <span className="crm-entity-badge crm-badge-error" title={st.error}>
                          {st.toolUsed ? "Err" : "N/A"}
                        </span>
                      ) : (
                        <span className="crm-entity-badge">{st.items.length}</span>
                      )}
                    </div>
                    <button
                      className="crm-entity-refresh"
                      onClick={ev => { ev.stopPropagation(); fetchEntity(e.type); }}
                      disabled={st.loading}
                      title={`Refresh ${e.label}`}
                    >↺</button>
                    <span className="crm-entity-chevron">{st.expanded ? "▴" : "▾"}</span>
                  </div>

                  {st.expanded && (
                    <div className="crm-entity-body">
                      {st.loading ? (
                        <div className="crm-entity-state">
                          <span className="spinner" />
                          <span>Fetching via <code>{st.toolUsed}</code>…</span>
                        </div>
                      ) : st.error && st.items.length === 0 ? (
                        <div className="crm-entity-state crm-entity-err">
                          <span>⚠ {st.error}</span>
                          {!st.toolUsed && (
                            <span className="crm-entity-hint">
                              Expected tool: <code>{ENTITY_PREFS[e.type].preferred[0]}</code>
                            </span>
                          )}
                        </div>
                      ) : st.items.length === 0 ? (
                        <div className="crm-entity-state crm-entity-empty">
                          No {e.plural} found
                        </div>
                      ) : (
                        <ul className="crm-item-list">
                          {st.items.slice(0, 8).map((item, idx) => {
                            const name = getItemName(item, idx);
                            const id = getItemId(item);
                            const status = getItemStatus(item);
                            const isActive = status === "Active" || status === "true";
                            return (
                              <li key={idx} className="crm-item">
                                <span className="crm-item-dot" />
                                <span className="crm-item-name" title={id || name}>{name}</span>
                                {status && (
                                  <span className={`crm-item-status ${isActive ? "crm-status-active" : "crm-status-inactive"}`}>
                                    {status}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                          {st.items.length > 8 && (
                            <li className="crm-item-more">+{st.items.length - 8} more {e.plural}</li>
                          )}
                        </ul>
                      )}
                      {st.toolUsed && !st.loading && (
                        <p className="crm-tool-used">via <code>{st.toolUsed}</code></p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Zia Recommendations */}
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
              filteredRecs.map(rec => (
                <div key={rec.id} className={`zia-rec zia-rec-${rec.severity}`}>
                  <div className="zia-rec-header">
                    <span className="zia-rec-icon">{rec.icon}</span>
                    <span className="zia-rec-title">{rec.title}</span>
                    <span className={`zia-rec-sev sev-${rec.severity}`}>
                      {rec.severity === "high" ? "HIGH" : rec.severity === "medium" ? "MED" : "LOW"}
                    </span>
                  </div>
                  <p className="zia-rec-desc">{rec.description}</p>
                </div>
              ))
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
            <div className="zia-chat-messages">
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
              <div ref={messagesEndRef} />
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
                onClick={sendToZia}
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
                  ↓ Download JSON Report
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
