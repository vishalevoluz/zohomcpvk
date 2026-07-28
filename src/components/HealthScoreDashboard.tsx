"use client";

import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Workflow, GitBranch, ShieldCheck, Database, Activity,
  ChevronDown, TrendingUp, AlertTriangle, CheckCircle2, XCircle,
} from "lucide-react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { Section } from "@/lib/sections";
import {
  buildHealthAuditModel,
  type DimensionKey,
  type DimensionCard,
  type DimensionIconKey,
} from "@/lib/healthAuditModel";

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  pipelineStageCount: number;
  ruleCoverage: RuleCoverage | null;
  onSelectSection: (s: Section) => void;
}

const DIMENSION_ICON_COMPONENTS: Record<DimensionIconKey, LucideIcon> = {
  automation: Workflow,
  process: GitBranch,
  security: ShieldCheck,
  data: Database,
  "workflow-health": Activity,
};

const ZONE_LABEL: Record<string, string> = {
  healthy: "Excellent",
  "needs-attention": "Needs Attention",
  "at-risk": "At Risk",
  critical: "Critical",
};

const IMPACT_TOOLTIPS: Record<string, string> = {
  High: "Fixing this meaningfully improves revenue, risk, or how efficiently your team works.",
  Medium: "Fixing this helps, but the business impact is moderate.",
  Low: "Fixing this is minor cleanup — nice to have, not a priority.",
};

const EFFORT_TOOLTIPS: Record<string, string> = {
  Easy: "A quick change your Zoho admin or consultant can make in one sitting.",
  Medium: "Takes some planning and setup time, but isn't a major project.",
  Hard: "A bigger project — expect it to take real time and testing to get right.",
};

const RING_RADIUS = 85;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ScoreRing({ score, zone, resolved, displayScore }: { score: number; zone: string; resolved: boolean; displayScore: number }) {
  const pct = resolved ? score / 100 : 0;
  const offset = RING_CIRCUMFERENCE * (1 - pct);
  return (
    <div className="hsd-ring-wrap">
      <svg className="hsd-ring-svg" viewBox="0 0 200 200">
        <circle className="hsd-ring-bg" cx="100" cy="100" r={RING_RADIUS} />
        <circle
          className={`hsd-ring-fill zone-${resolved ? zone : "loading"}`}
          cx="100" cy="100" r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="hsd-ring-center">
        <span className="hsd-score-num">{resolved ? displayScore : "—"}</span>
        <span className="hsd-score-max">/100</span>
      </div>
    </div>
  );
}

function SectionTitle({ text, tooltip }: { text: string; tooltip: string }) {
  return (
    <h3 className="business-view-section-title">
      <span className="th-tip" data-tooltip-below={tooltip}>
        {text}
        <span className="th-info">i</span>
      </span>
    </h3>
  );
}

function CategoryCard({
  dim, expanded, onToggle, onSelectSection, resolved,
}: {
  dim: DimensionCard;
  expanded: boolean;
  onToggle: () => void;
  onSelectSection: (s: Section) => void;
  resolved: boolean;
}) {
  const Icon = DIMENSION_ICON_COMPONENTS[dim.iconKey];
  const fillPct = resolved ? (dim.score / 20) * 100 : 0;

  return (
    <div className={`hsd-category-card zone-${resolved ? dim.zone : "loading"} ${expanded ? "expanded" : ""}`}>
      <button type="button" className="hsd-category-header" onClick={onToggle} data-tooltip-below={dim.tooltip}>
        <span className="hsd-category-icon"><Icon size={17} strokeWidth={2} /></span>
        <span className="hsd-category-label">{dim.label}</span>
        <span className="hsd-category-score">{resolved ? `${dim.score}/20` : "—"}</span>
        <span className={`hsd-category-pill zone-${resolved ? dim.zone : "loading"}`}>
          {resolved ? ZONE_LABEL[dim.zone] : "Checking…"}
        </span>
        <ChevronDown size={16} className="hsd-category-chevron" />
      </button>
      <div className="hsd-category-bar-track">
        <span className={`hsd-category-bar-fill zone-${resolved ? dim.zone : "loading"}`} style={{ width: `${fillPct}%` }} />
      </div>

      {expanded && resolved && (
        <div className="hsd-category-body">
          {dim.criticalAlert && (
            <div className="hsd-critical-alert">
              <AlertTriangle size={15} />
              <div>
                <strong>Critical Issues Found</strong>
                <p>{dim.criticalAlert}</p>
              </div>
            </div>
          )}

          <ul className="hsd-checklist">
            {dim.checklist.map(item => (
              <li key={item.id} className={`hsd-checklist-item ${item.status}`}>
                {item.status === "pass" ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                <div className="hsd-checklist-text">
                  <span className="hsd-checklist-label">{item.label}</span>
                  <span className="hsd-checklist-detail">{item.detail}</span>
                </div>
                {item.status === "fail" && <span className="hsd-checklist-weight">+{item.weight} pts available</span>}
              </li>
            ))}
          </ul>

          {dim.moduleBreakdown && dim.moduleBreakdown.length > 0 && (
            <div className="hsd-module-breakdown">
              <h4>Module Breakdown</h4>
              <div className="hsd-module-breakdown-grid">
                {dim.moduleBreakdown.map(group => {
                  const total = group.rows.reduce((sum, r) => sum + r.count, 0);
                  return (
                    <div key={group.label} className="hsd-module-group">
                      <span className="hsd-module-group-label">{group.label}</span>
                      {group.rows.map(row => (
                        <div key={row.label} className="hsd-module-row">
                          <span className="hsd-module-row-label">{row.label}</span>
                          <span className="hsd-module-row-track">
                            <span className="hsd-module-row-fill" style={{ width: total > 0 ? `${(row.count / total) * 100}%` : "0%" }} />
                          </span>
                          <span className="hsd-module-row-count">{row.count}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="hsd-recommendations">
            <h4>How to Maximize Your Score</h4>
            {dim.allSet ? (
              <p className="hsd-all-set">Nothing to fix here — this category is in good shape.</p>
            ) : (
              <>
                {dim.recommendations.map(rec => (
                  <div key={rec.id} className="hsd-recommendation-card">
                    <div className="hsd-recommendation-body">
                      <h5>{rec.title}</h5>
                      <p>{rec.why}</p>
                      <div className="priority-action-badges">
                        <span className={`impact-badge ${rec.impact.toLowerCase()}`} data-tooltip={IMPACT_TOOLTIPS[rec.impact]}>
                          Impact: {rec.impact}
                        </span>
                        <span className={`effort-badge ${rec.effort.toLowerCase()}`} data-tooltip={EFFORT_TOOLTIPS[rec.effort]}>
                          Effort: {rec.effort}
                        </span>
                      </div>
                    </div>
                    <button className="btn-secondary" onClick={() => onSelectSection(rec.targetSection)}>View Details</button>
                  </div>
                ))}
                <p className="hsd-recommendation-potential">
                  Current <strong>{dim.score}/20</strong> → Potential <strong>{dim.potential}/20</strong> (+{dim.gain})
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HealthScoreDashboard({ entityData, pipelineStageCount, ruleCoverage, onSelectSection }: Props) {
  const [expandedKey, setExpandedKey] = useState<DimensionKey | null>(null);
  const [displayScore, setDisplayScore] = useState(0);

  const model = useMemo(
    () => buildHealthAuditModel(entityData, pipelineStageCount, ruleCoverage),
    [entityData, pipelineStageCount, ruleCoverage],
  );

  useEffect(() => {
    if (!model.resolved) { setDisplayScore(0); return; }
    const id = requestAnimationFrame(() => setDisplayScore(model.total));
    return () => cancelAnimationFrame(id);
  }, [model.resolved, model.total]);

  return (
    <div className="hsd-dashboard">
      <div className="hsd-grid">
        <div className="hsd-categories">
          {model.dimensions.map(dim => (
            <CategoryCard
              key={dim.key}
              dim={dim}
              expanded={expandedKey === dim.key}
              onToggle={() => setExpandedKey(prev => (prev === dim.key ? null : dim.key))}
              onSelectSection={onSelectSection}
              resolved={model.resolved}
            />
          ))}
        </div>

        <div className="hsd-score-panel business-view-section">
          <SectionTitle text="CRM Health Score" tooltip="Is my CRM working well or broken? A single score built from automation, process setup, security, data structure, and workflow health." />
          <ScoreRing score={model.total} zone={model.zone} resolved={model.resolved} displayScore={displayScore} />
          <p className={`hsd-score-verdict zone-${model.resolved ? model.zone : ""}`}>
            {model.resolved ? model.verdict : "Reading your CRM setup…"}
          </p>
          {model.resolved && (
            <p className="hsd-score-potential">Estimated Potential Score: {model.total} → {model.potentialTotal}</p>
          )}

          <div className="hsd-kpi-row">
            <div className="hsd-kpi-tile tone-neutral">
              <span className="hsd-kpi-value">{model.resolved ? `${model.total}/100` : "—"}</span>
              <span className="hsd-kpi-label">Current Score</span>
            </div>
            <div className="hsd-kpi-tile tone-neutral">
              <span className="hsd-kpi-value">{model.potentialTotal}/100</span>
              <span className="hsd-kpi-label">Potential Score</span>
            </div>
            <div className={`hsd-kpi-tile ${model.resolved && model.gainTotal === 0 ? "tone-healthy" : "tone-warning"}`}>
              <span className="hsd-kpi-value"><TrendingUp size={14} /> {model.resolved ? `+${model.gainTotal}` : "—"}</span>
              <span className="hsd-kpi-label">Improvement Available</span>
            </div>
          </div>
        </div>
      </div>

      <div className="hsd-roadmap business-view-section">
        <SectionTitle text="CRM Improvement Roadmap" tooltip="Which category should I fix first? Ranked worst-to-best so the most urgent gap always sits at the top." />
        {!model.resolved ? (
          <p className="business-view-hint">Reading your CRM setup…</p>
        ) : (
          <>
            {model.roadmap.map((entry, i) => (
              <div key={entry.key} className="hsd-roadmap-row">
                <span className="hsd-roadmap-rank">Priority {i + 1}</span>
                <span className="hsd-roadmap-label">
                  {entry.zone === "healthy" ? "Maintain" : "Fix"} {entry.label}
                </span>
                <span className={`hsd-roadmap-severity zone-${entry.zone}`}>{entry.severityLabel}</span>
              </div>
            ))}
            <p className="hsd-roadmap-summary">
              Estimated Overall Score — Current <strong>{model.total}</strong> → Potential <strong>{model.potentialTotal}</strong> ({model.gainTotal} points available)
            </p>
          </>
        )}
      </div>
    </div>
  );
}
