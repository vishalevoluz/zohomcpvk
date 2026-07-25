"use client";

import BusinessJourneyCard from "@/components/BusinessJourneyCard";
import Sidebar from "@/components/Sidebar";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { RecordSampleStageId, RecordSampleState, PipelineStagesState } from "@/lib/flowMapModel";
import type { RuleCoverage } from "@/lib/crmPredicates";

const NOW = 1750000000000;

function entity(items: unknown[]): EntityState {
  return { items, loading: false, error: null, toolUsed: "mock", expanded: true, lastFetched: NOW };
}

const modules = [
  { api_name: "Leads", plural_label: "Leads", visible: true },
  { api_name: "Campaigns", plural_label: "Campaigns", visible: true },
  { api_name: "Contacts", plural_label: "Contacts", visible: true },
  { api_name: "Deals", plural_label: "Deals", visible: true },
  // Accounts intentionally omitted — demonstrates the "gap / not connected" stage state.
  { api_name: "Invoices", plural_label: "Invoices", visible: true },
];

const workflows = [
  { id: "w1", module: "Leads", status: { active: true } },
  { id: "w2", module: "Contacts", status: { active: false } },
  { id: "w3", module: "Deals", status: { active: true } },
];

const blueprints = [
  { id: "bp1", module: "Deals", status: "Active", field: { api_name: "Stage" } },
];

const entityData: Record<CrmEntityType, EntityState> = {
  modules: entity(modules),
  workflows: entity(workflows),
  blueprints: entity(blueprints),
  layouts: entity([]),
  tasks: entity([]),
  pipelines: entity([]),
  stages: entity([]),
  profiles: entity([{ id: "p1", name: "Administrator" }]),
  users: entity([{ id: "u1", name: "Jane Rep" }]),
  roles: entity([]),
  fields: entity([]),
};

function leadRecord(id: string, converted: boolean): unknown {
  return { id, Last_Name: `Lead ${id}`, Email: `${id}@example.com`, Converted__s: converted, Owner: { id: "u1", name: "Jane Rep" } };
}
function contactRecord(id: string): unknown {
  return { id, Last_Name: `Contact ${id}`, Email: `${id}@example.com` };
}
function dealRecord(id: string, contactId: string | null): unknown {
  return {
    id, Deal_Name: `Deal ${id}`,
    ...(contactId ? { Contact_Name: { id: contactId, name: `Contact ${contactId}` } } : {}),
    Stage: "Negotiation",
  };
}
function invoiceRecordUnlinked(id: string): unknown {
  return { id, Subject: `Invoice ${id}` };
}

const leadIds = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];
const contactIds = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
const dealIds = ["d1", "d2", "d3", "d4", "d5", "d6"];
const invoiceIds = ["inv1", "inv2", "inv3"];

function sample(items: unknown[]): RecordSampleState {
  return { items, loading: false, error: null, lastFetched: NOW };
}

const recordSamples: Record<RecordSampleStageId, RecordSampleState> = {
  leads: sample(leadIds.map((id, i) => leadRecord(id, i < 6))),
  contacts: sample(contactIds.map(id => contactRecord(id))),
  // 5 of 6 deals link back to a real sampled contact — one clean gap so the
  // connector isn't a flat 100%.
  deals: sample(dealIds.map((id, i) => dealRecord(id, i < 5 ? contactIds[i] : null))),
  accounts: { items: [], loading: false, error: null, lastFetched: null }, // never fetched — no Accounts module
  // No invoice links back to any sampled deal — demonstrates the broken/red-pulse connector.
  invoices: sample(invoiceIds.map(id => invoiceRecordUnlinked(id))),
};

const pipelineStages: PipelineStagesState = { items: [], loading: false, error: null, lastFetched: NOW };

const ruleCoverage: RuleCoverage = {
  validation: { Leads: 2, Contacts: 0, Deals: 1, Campaigns: 0 },
  layout: { Leads: 0, Contacts: 0, Deals: 1, Campaigns: 0 },
  assignment: { Leads: 1, Contacts: 0, Deals: 0, Campaigns: 0 },
  approval: { Leads: 0, Contacts: 0, Deals: 1, Campaigns: 0 },
  scheduleCount: 3,
};

export default function TestJourneyPage() {
  return (
    <div className="app-shell">
      <Sidebar
        connected
        activeSection="crm-dashboard"
        onSelectSection={() => {}}
        categorized={{ "crm-dashboard": [], modules: [], workflows: [], blueprints: [], functions: [], fields: [], logs: [], integrations: [] }}
        logCount={0}
        onDisconnect={() => {}}
        allTools={[]}
      />
      <div className="app-main">
        <BusinessJourneyCard
          entityData={entityData}
          recordSamples={recordSamples}
          pipelineStages={pipelineStages}
          ruleCoverage={ruleCoverage}
          onSelectSection={() => {}}
        />
      </div>
    </div>
  );
}
