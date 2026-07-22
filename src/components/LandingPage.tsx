import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  FileText,
  FlaskConical,
  Gauge,
  Link2,
  ListChecks,
  Lock,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const STEPS = [
  {
    icon: Link2,
    title: "Connect via Zoho MCP",
    body: "Create a Zoho MCP endpoint for your CRM (we walk you through every click and exactly which read-only tools to enable), then paste the URL here.",
  },
  {
    icon: Gauge,
    title: "We audit 115 parameters",
    body: "Deterministic checks over your live metadata and records, plus one AI judgment pass for the things only an experienced consultant would spot. Watch it run live.",
  },
  {
    icon: ListChecks,
    title: "Fix, re-audit, improve",
    body: "Every finding becomes a ranked action with the exact score gain — “fix these 3 things and you move from 64 to 78”. Re-audit to prove the improvement.",
  },
];

// Mirrors CATEGORIES from the EvoAudit v2 catalog (shared/catalog.js).
const CATEGORIES = [
  "Data Quality", "CRM Structure & Setup", "Workflows & Automation", "Approval Processes",
  "Scoring Rules", "Customer Portal", "Users & Team Management", "Integrations & Connections",
  "Reports & Dashboards", "Security & Compliance", "Leads & Pipeline", "Email & Communication",
  "Interface & Usability",
];

function ScoreRing({ score }: { score: number }) {
  const r = 56;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="landing-hero-ring">
      <svg viewBox="0 0 128 128" width={180} height={180}>
        <circle cx={64} cy={64} r={r} fill="none" stroke="var(--l-surface-2)" strokeWidth={9} />
        <circle
          cx={64} cy={64} r={r} fill="none"
          stroke="var(--l-accent)" strokeWidth={9} strokeLinecap="round"
          className="landing-hero-ring-arc"
          style={{ strokeDasharray: circumference, strokeDashoffset: offset }}
        />
      </svg>
      <div className="landing-hero-ring-num">
        <span className="n">{score}</span>
        <span className="of">/ 100</span>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="landing-page">
      <header className="landing-nav">
        <div className="landing-logo">
          <span className="landing-logo-mark">
            <ShieldCheck size={15} strokeWidth={2} />
          </span>
          <span>Evo<span className="landing-logo-accent">Audit</span></span>
        </div>
        <div className="landing-nav-right">
          <span className="landing-by-evoluz">by Evoluz Global Solutions</span>
          <Link href="/dashboard" className="landing-btn landing-btn-primary">
            Run your free audit <ArrowRight size={14} strokeWidth={1.75} />
          </Link>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <div className="landing-hero-eyebrow">
            <Sparkles size={13} strokeWidth={1.75} />
            115-parameter Zoho CRM audit · AI-assisted · free
          </div>
          <h1 className="landing-hero-title">
            How healthy is your
            <br />
            <span className="landing-accent-text">Zoho CRM</span>, really?
          </h1>
          <p className="landing-hero-sub">
            Connect your CRM in minutes and get a scored audit across data quality, automation,
            adoption, pipeline hygiene and 9 more dimensions — with an exact, prioritized plan
            showing how each fix moves your score.
          </p>
          <div className="landing-hero-ctas">
            <Link href="/dashboard" className="landing-btn landing-btn-primary landing-btn-lg">
              Run your free audit <ArrowRight size={15} strokeWidth={1.75} />
            </Link>
            <Link href="/dashboard" className="landing-btn landing-btn-lg">
              <FlaskConical size={15} strokeWidth={1.75} /> See a sample audit
            </Link>
          </div>
          <div className="landing-hero-trust">
            <span><Lock size={12} strokeWidth={1.75} /> Read-only — we never change your CRM</span>
            <span><BadgeCheck size={12} strokeWidth={1.75} /> You control the connection and can revoke it in Zoho anytime</span>
          </div>
        </div>

        <div className="landing-hero-visual" aria-hidden="true">
          <ScoreRing score={82} />
          <div className="landing-hero-chips">
            <span className="landing-chip landing-chip-critical">2 critical</span>
            <span className="landing-chip landing-chip-high">5 high</span>
            <span className="landing-chip landing-chip-gain">+14 pts available</span>
          </div>
        </div>
      </section>

      <section className="landing-steps">
        <h2>Three steps, about ten minutes</h2>
        <div className="landing-steps-grid">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="landing-step-card">
                <div className="landing-step-num">{i + 1}</div>
                <Icon size={18} strokeWidth={1.75} />
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="landing-cats">
        <h2>What we look at</h2>
        <div className="landing-cats-grid">
          {CATEGORIES.map(label => (
            <div key={label} className="landing-cat-chip">{label}</div>
          ))}
        </div>
      </section>

      <section className="landing-report">
        <div className="landing-report-copy">
          <FileText size={18} strokeWidth={1.75} />
          <h2>A report you can put in front of management</h2>
          <p>
            Consulting-grade PDF: executive summary, category scores, every finding with evidence
            and recommendations, plus the manual-review checklist for what automation can&rsquo;t see.
          </p>
        </div>
      </section>

      <footer className="landing-footer">
        <span>Built by <strong>Evoluz Global Solutions</strong> — Zoho implementation specialists.</span>
        <span className="faint">
          Your data: we read only what your MCP endpoint allows, nothing is ever written to your
          CRM, and you can delete your audit data on request.
        </span>
      </footer>
    </div>
  );
}
