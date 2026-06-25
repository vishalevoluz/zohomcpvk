"use client";

type IntgStatus = "coming_soon" | "beta" | "available";

interface Integration {
  name: string;
  letter: string;
  bg: string;
  fg: string;
  category: string;
  categoryColor: string;
  desc: string;
  status: IntgStatus;
}

const INTEGRATIONS: Integration[] = [
  {
    name: "OpenAI",
    letter: "✦",
    bg: "#10A37F", fg: "#fff",
    category: "AI",
    categoryColor: "#7C3AED",
    desc: "GPT-powered field suggestions, auto-summaries, and smart CRM insights.",
    status: "coming_soon",
  },
  {
    name: "WhatsApp Business",
    letter: "W",
    bg: "#25D366", fg: "#fff",
    category: "Messaging",
    categoryColor: "#059669",
    desc: "Send automated follow-ups and nurture leads directly via WhatsApp.",
    status: "coming_soon",
  },
  {
    name: "Lead Health Tracker",
    letter: "♥",
    bg: "#E53E3E", fg: "#fff",
    category: "Analytics",
    categoryColor: "#2563EB",
    desc: "Score and monitor lead quality in real-time across your CRM pipeline.",
    status: "coming_soon",
  },
  {
    name: "Slack",
    letter: "#",
    bg: "#4A154B", fg: "#fff",
    category: "Notifications",
    categoryColor: "#D97706",
    desc: "Instant alerts on deal changes, workflow failures, and CRM events.",
    status: "coming_soon",
  },
  {
    name: "Google Workspace",
    letter: "G",
    bg: "#4285F4", fg: "#fff",
    category: "Productivity",
    categoryColor: "#0891B2",
    desc: "Sync contacts, calendar events, and Gmail threads with Zoho CRM.",
    status: "coming_soon",
  },
  {
    name: "Twilio",
    letter: "T",
    bg: "#F22F46", fg: "#fff",
    category: "Messaging",
    categoryColor: "#059669",
    desc: "Trigger SMS and automated voice calls from CRM workflow actions.",
    status: "coming_soon",
  },
  {
    name: "HubSpot",
    letter: "H",
    bg: "#FF7A59", fg: "#fff",
    category: "CRM Sync",
    categoryColor: "#EA580C",
    desc: "Bi-directional contact and deal sync between HubSpot and Zoho CRM.",
    status: "coming_soon",
  },
  {
    name: "Mailchimp",
    letter: "M",
    bg: "#FFE01B", fg: "#241c15",
    category: "Email",
    categoryColor: "#DC2626",
    desc: "Sync CRM contacts to Mailchimp audiences and track campaign results.",
    status: "coming_soon",
  },
  {
    name: "Stripe",
    letter: "S",
    bg: "#635BFF", fg: "#fff",
    category: "Payments",
    categoryColor: "#7C3AED",
    desc: "Map Stripe payment events to deal stages and trigger CRM automations.",
    status: "coming_soon",
  },
  {
    name: "Zapier",
    letter: "⚡",
    bg: "#FF4A00", fg: "#fff",
    category: "Automation",
    categoryColor: "#EA580C",
    desc: "Connect 5,000+ apps to your Zoho CRM data with no-code Zap triggers.",
    status: "beta",
  },
  {
    name: "Microsoft Teams",
    letter: "T",
    bg: "#464EB8", fg: "#fff",
    category: "Notifications",
    categoryColor: "#D97706",
    desc: "Post CRM alerts and deal updates directly into Microsoft Teams channels.",
    status: "coming_soon",
  },
  {
    name: "Calendly",
    letter: "C",
    bg: "#006BFF", fg: "#fff",
    category: "Productivity",
    categoryColor: "#0891B2",
    desc: "Auto-create CRM leads when prospects book meetings via Calendly.",
    status: "coming_soon",
  },
];

const STATUS_LABEL: Record<IntgStatus, string> = {
  available:    "Available",
  beta:         "Beta",
  coming_soon:  "Coming Soon",
};

export default function IntegrationsPanel() {
  return (
    <div className="integrations-panel">
      <div className="audit-header">
        <div className="audit-header-left">
          <span className="pane-icon">⧉</span>
          <h2 className="pane-title">Integrations</h2>
          <span className="pane-count">{INTEGRATIONS.length} integrations</span>
        </div>
      </div>
      <p className="integrations-sub">
        Extend your Zoho CRM workflows with third-party tools and services. Connect once, automate everything.
      </p>

      <div className="integrations-grid">
        {INTEGRATIONS.map(intg => (
          <div
            key={intg.name}
            className={`intg-card${intg.status === "beta" ? " intg-card-beta" : ""}${intg.status === "available" ? " intg-card-available" : ""}`}
          >
            <div className="intg-card-top">
              <div className="intg-icon" style={{ background: intg.bg, color: intg.fg }}>
                {intg.letter}
              </div>
              <div className="intg-meta">
                <p className="intg-name">{intg.name}</p>
                <span className="intg-category" style={{ color: intg.categoryColor }}>
                  {intg.category}
                </span>
              </div>
              <span className={`intg-status intg-status-${intg.status}`}>
                {STATUS_LABEL[intg.status]}
              </span>
            </div>
            <p className="intg-desc">{intg.desc}</p>
            <button
              className={intg.status === "available" ? "btn-connect" : intg.status === "beta" ? "btn-secondary" : "intg-notify-btn"}
              disabled={intg.status === "coming_soon"}
            >
              {intg.status === "available" ? "Connect" : intg.status === "beta" ? "Try Beta" : "Notify Me"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
