"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  GitBranch, ShoppingCart, Cog, ShieldCheck, Database, HeartPulse,
  ChevronDown, TrendingUp, AlertTriangle, CheckCircle2, XCircle,
} from "lucide-react";
import type { CrmEntityType, EntityState } from "@/lib/useCrmEntities";
import type { RuleCoverage } from "@/lib/crmPredicates";
import type { MandatoryFieldsState } from "@/lib/useMandatoryFields";
import {
  buildHealthAuditModel,
  type DimensionKey,
  type DimensionCard,
  type DimensionIconKey,
} from "@/lib/healthAuditModel";

// Signal point values are usually whole numbers (e.g. 1 pt each for the
// typical 4-core-module case) but can come out fractional for orgs missing
// some core modules (weight/5 doesn't always divide evenly) - shown to one
// decimal only when it's not a whole number instead of a noisy "1.2000000...".
function formatSignalPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

interface Props {
  entityData: Record<CrmEntityType, EntityState>;
  pipelineStageCount: number;
  ruleCoverage: RuleCoverage | null;
  outOfOrderStageCount?: number;
  pipelineCount?: number | null;
  pipelineStagesResolved?: boolean;
  mandatoryFields?: MandatoryFieldsState;
}

const IMPACT_TOOLTIPS: Record<string, string> = {
  High: "Fixing this meaningfully improves revenue, risk, or how efficiently your team works.",
  Medium: "Fixing this helps, but the business impact is moderate.",
  Low: "Fixing this is minor cleanup - nice to have, not a priority.",
};

const EFFORT_TOOLTIPS: Record<string, string> = {
  Easy: "A quick change your Zoho admin or consultant can make in one sitting.",
  Medium: "Takes some planning and setup time, but isn't a major project.",
  Hard: "A bigger project - expect it to take real time and testing to get right.",
};

// ── Category mapping - presentation only ────────────────────────────────────
// The 5 real dimensions computed in healthAuditModel.ts/businessScore.ts
// (their identity, score, and what feeds that score) are completely
// untouched - this just relabels each one's existing iconKey into the
// workflow/sales/automation/security/data vocabulary for this card's icons,
// a 1:1 rename with no scoring logic behind it:
//   automation        -> automation   (Automation Coverage)
//   process           -> sales        (Sales Process Setup - pipeline/blueprint)
//   security          -> security     (Team Security)
//   data              -> data         (Data Structure)
//   workflow-health   -> workflow     (Workflow Health)
type MetricCategory = "workflow" | "sales" | "automation" | "security" | "data";
const CATEGORY_BY_ICON_KEY: Record<DimensionIconKey, MetricCategory> = {
  automation: "automation",
  process: "sales",
  security: "security",
  data: "data",
  "workflow-health": "workflow",
};
const CATEGORY_ICONS: Record<MetricCategory, LucideIcon> = {
  workflow: GitBranch,
  sales: ShoppingCart,
  automation: Cog,
  security: ShieldCheck,
  data: Database,
};

// ── Per-metric severity tiers (0-20 scale), presentational only - computed
// straight from the real dim.score, never fed back into it. Thresholds and
// colors kept as constants up top so they're easy to retune in one place. ──
const METRIC_TIER_MAX = 20;
const METRIC_TIERS = [
  { key: "critical", cutoff: 5, color: "#E24B4A", iconColor: "#E24B4A", label: "Critical" },
  { key: "warning", cutoff: 10, color: "#EF9F27", iconColor: "#BA7517", label: "Warning" },
  { key: "fair", cutoff: 15, color: "#378ADD", iconColor: "#378ADD", label: "Fair" },
  { key: "good", cutoff: METRIC_TIER_MAX, color: "#1D9E75", iconColor: "#1D9E75", label: "Good" },
] as const;
type MetricTier = typeof METRIC_TIERS[number];
function tierForScore(score: number): MetricTier {
  return METRIC_TIERS.find(t => score <= t.cutoff) ?? METRIC_TIERS[METRIC_TIERS.length - 1];
}

// ── Overall gauge health bands (0-100 scale) - a separate, coarser
// classification than the per-metric tiers above (3 bands, not 4), matching
// what the gauge's legend and verdict strip promise. ────────────────────────
const HEALTHY_LINE = 70; // below this = Unhealthy
const GOAL_LINE = 80;    // at/above this = Healthy; the 70-79 gap is Fair
const GAUGE_BANDS = [
  { key: "unhealthy", label: "Unhealthy", from: 0, to: HEALTHY_LINE, color: "#E24B4A" },
  { key: "fair", label: "Fair", from: HEALTHY_LINE, to: GOAL_LINE, color: "#EF9F27" },
  { key: "healthy", label: "Healthy", from: GOAL_LINE, to: 100, color: "#1D9E75" },
] as const;
function gaugeBandForScore(score: number) {
  return GAUGE_BANDS.find(b => score < b.to) ?? GAUGE_BANDS[GAUGE_BANDS.length - 1];
}

const GAUGE_RADIUS = 85;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
const BAND_RADIUS = 102;
const BAND_CIRCUMFERENCE = 2 * Math.PI * BAND_RADIUS;
// The "70"/"80" boundary labels sit outside BAND_RADIUS (see pointOnRing
// below), so the viewBox needs real margin past BAND_RADIUS or an SVG (which
// clips at its viewBox edge by default, unlike a plain CSS box) silently cuts
// their text off - this was the whole bug behind "circle below content not
// visible": labels drawn at radius 116 inside a 220x220 (radius-110) viewBox.
const GAUGE_CENTER = 135;
const GAUGE_VIEWBOX = GAUGE_CENTER * 2;

// Position for the "70"/"80" boundary labels on the band ring - 0% is 12
// o'clock (the SVG is rotated -90deg, same convention the old ScoreRing
// used), moving clockwise as pct increases.
function pointOnRing(pct: number, radius: number) {
  const angle = pct * 2 * Math.PI - Math.PI / 2;
  return { x: GAUGE_CENTER + radius * Math.cos(angle), y: GAUGE_CENTER + radius * Math.sin(angle) };
}

// ── Reduced-motion-aware count-up (ease-out cubic, ~1.2s) ───────────────────
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = () => setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useCountUp(target: number, active: boolean, durationMs = 1200): number {
  const reducedMotion = usePrefersReducedMotion();
  const [value, setValue] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) { setValue(0); return; }
    if (reducedMotion) { setValue(target); return; }
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setValue(target * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    }
    frameRef.current = requestAnimationFrame(tick);
    return () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); };
  }, [target, active, reducedMotion, durationMs]);

  return Math.round(value);
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

// Shared with the verdict strip so the two never drift into disagreeing
// wording about the same score.
function gapToHealthyText(score: number, resolved: boolean): string {
  const gapToHealthy = Math.max(0, HEALTHY_LINE - score);
  const aboveGoal = Math.max(0, score - GOAL_LINE);
  if (!resolved) return "Reading your CRM setup…";
  if (score >= GOAL_LINE) return `${aboveGoal} point${aboveGoal !== 1 ? "s" : ""} above the healthy line`;
  if (score >= HEALTHY_LINE) return "In the fair range, just below the healthy line";
  return `${gapToHealthy} point${gapToHealthy !== 1 ? "s" : ""} below healthy`;
}

// ── 1 + 2: header + circular gauge with 3 health bands ──────────────────────
// Hovering zooms the ring in slightly and pops a callout with an arrow
// pointing at it (pure CSS - see .hsd-gauge-wrap:hover in globals.css) that
// names the single weakest real dimension, so the hover reveals a concrete
// "why" instead of just re-showing the same number.
function HealthGauge({
  score, resolved, weakestLabel, weakestScore,
}: { score: number; resolved: boolean; weakestLabel: string | null; weakestScore: number | null }) {
  const reducedMotion = usePrefersReducedMotion();
  const displayScore = useCountUp(score, resolved, 1200);
  const band = gaugeBandForScore(score);
  const pct = resolved ? score / 100 : 0;
  const offset = GAUGE_CIRCUMFERENCE * (1 - pct);
  const label70 = pointOnRing(HEALTHY_LINE / 100, BAND_RADIUS + 14);
  const label80 = pointOnRing(GOAL_LINE / 100, BAND_RADIUS + 14);

  return (
    <div className={`hsd-gauge-wrap ${resolved ? "hoverable" : ""}`}>
      <svg className="hsd-gauge-svg" viewBox={`0 0 ${GAUGE_VIEWBOX} ${GAUGE_VIEWBOX}`}>
        {GAUGE_BANDS.map(b => {
          const segLen = BAND_CIRCUMFERENCE * ((b.to - b.from) / 100);
          const startOffset = BAND_CIRCUMFERENCE * (b.from / 100);
          return (
            <circle
              key={b.key}
              className="hsd-gauge-band"
              cx={GAUGE_CENTER} cy={GAUGE_CENTER} r={BAND_RADIUS}
              stroke={b.color}
              strokeDasharray={`${segLen} ${BAND_CIRCUMFERENCE - segLen}`}
              strokeDashoffset={-startOffset}
            />
          );
        })}
        <circle className="hsd-gauge-track" cx={GAUGE_CENTER} cy={GAUGE_CENTER} r={GAUGE_RADIUS} />
        <circle
          className={`hsd-gauge-fill ${reducedMotion ? "no-motion" : ""}`}
          cx={GAUGE_CENTER} cy={GAUGE_CENTER} r={GAUGE_RADIUS}
          style={{ stroke: resolved ? band.color : "var(--color-border-strong)" }}
          strokeDasharray={GAUGE_CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
        <text x={label70.x} y={label70.y} className="hsd-gauge-boundary-label" textAnchor="middle" dominantBaseline="middle">70</text>
        <text x={label80.x} y={label80.y} className="hsd-gauge-boundary-label" textAnchor="middle" dominantBaseline="middle">80</text>
      </svg>
      <div className="hsd-gauge-center">
        <span className="hsd-gauge-num">{resolved ? displayScore : "-"}</span>
        <span className="hsd-gauge-max">/ 100</span>
      </div>
      {resolved && (
        <div className="hsd-gauge-annotation" role="tooltip">
          <span className="hsd-gauge-annotation-title">{score}/100 · {gapToHealthyText(score, resolved)}</span>
          {weakestLabel && weakestScore !== null && (
            <span className="hsd-gauge-annotation-sub">Weakest area: {weakestLabel} ({weakestScore}/20)</span>
          )}
          <span className="hsd-gauge-annotation-arrow" />
        </div>
      )}
    </div>
  );
}

function GaugeLegend() {
  return (
    <div className="hsd-gauge-legend">
      {GAUGE_BANDS.map(b => (
        <span key={b.key} className="hsd-gauge-legend-item">
          <span className="hsd-gauge-legend-dot" style={{ background: b.color }} />
          {b.label}
        </span>
      ))}
    </div>
  );
}

// ── 3: verdict strip ─────────────────────────────────────────────────────────
function VerdictStrip({ score, resolved }: { score: number; resolved: boolean }) {
  const band = gaugeBandForScore(score);
  const text = gapToHealthyText(score, resolved);

  return (
    <div className={`hsd-verdict-strip band-${resolved ? band.key : "loading"}`} style={{ borderLeftColor: resolved ? band.color : "var(--color-border-strong)" }}>
      <span className="hsd-verdict-text">{text}</span>
      <span className="hsd-verdict-pill" style={{ color: resolved ? band.color : "var(--color-text-tertiary)" }}>
        {resolved ? score : "-"} → 100
      </span>
    </div>
  );
}

// ── 4: metric rows, worst-first, each expandable into the real checklist ────
function MetricRow({
  dim, expanded, onToggle, resolved, animate,
}: {
  dim: DimensionCard;
  expanded: boolean;
  onToggle: () => void;
  resolved: boolean;
  animate: boolean;
}) {
  const category = CATEGORY_BY_ICON_KEY[dim.iconKey];
  const Icon = CATEGORY_ICONS[category];
  const tier = tierForScore(dim.score);
  const barPct = animate && resolved ? (dim.score / METRIC_TIER_MAX) * 100 : 0;

  return (
    <div className="hsd-metric-row" style={{ borderLeftColor: resolved ? tier.color : "var(--color-border-strong)" }}>
      <button type="button" className="hsd-metric-header" onClick={onToggle} data-tooltip-below={dim.tooltip}>
        <span className="hsd-metric-icon" style={{ background: `${tier.color}1f`, color: resolved ? tier.iconColor : "var(--color-text-tertiary)" }}>
          <Icon size={16} strokeWidth={2} />
        </span>
        <div className="hsd-metric-main">
          <div className="hsd-metric-top-line">
            <span className="hsd-metric-name">{dim.label}</span>
            <span className="hsd-metric-score-pill" style={{ color: resolved ? tier.color : "var(--color-text-tertiary)" }}>
              {resolved ? dim.score : "-"}/{METRIC_TIER_MAX}
            </span>
          </div>
          <div className="hsd-metric-bar-track">
            <span className="hsd-metric-bar-fill" style={{ width: `${barPct}%`, background: resolved ? tier.color : "var(--color-border-strong)" }} />
          </div>
          <p className="hsd-metric-detail">{resolved ? dim.reason : "Checking…"}</p>
        </div>
        <ChevronDown size={16} className={`hsd-metric-chevron ${expanded ? "open" : ""}`} />
      </button>

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
                  {item.signals && (
                    <ul className="hsd-checklist-signals">
                      {item.signals.map(sig => (
                        <li key={sig.label} className={sig.on ? "on" : "off"}>
                          <span className="hsd-checklist-signal-left">
                            <span className="hsd-checklist-signal-dot" />
                            <span className="hsd-checklist-signal-label">{sig.label}</span>
                          </span>
                          <span className={`hsd-checklist-signal-pts ${sig.on ? "plus" : "minus"}`}>
                            {sig.on ? "+" : "−"}{formatSignalPoints(sig.points)} pt{sig.points !== 1 ? "s" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.bullets && item.bullets.length > 0 && (
                    <ul className="hsd-checklist-signals">
                      {item.bullets.map((b, i) => (
                        <li key={i}>
                          <span className="hsd-checklist-signal-left">
                            <span className="hsd-checklist-signal-dot" />
                            <span className="hsd-checklist-signal-label">{b}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.tags && item.tags.length > 0 && (
                    <div className="hsd-checklist-tags">
                      {item.tags.map(tag => <span key={tag} className="hsd-checklist-tag">{tag}</span>)}
                    </div>
                  )}
                </div>
                {item.weight === 0 ? (
                  <span className="hsd-checklist-weight">Info</span>
                ) : item.earnedWeight !== undefined ? (
                  <span className={`hsd-checklist-weight ${item.earnedWeight > 0 ? "earned" : ""}`}>
                    {item.earnedWeight === item.weight ? `+${item.weight} pts` : `+${item.earnedWeight} of ${item.weight} pts`}
                  </span>
                ) : item.status === "pass"
                  ? <span className="hsd-checklist-weight earned">+{item.weight} pts</span>
                  : <span className="hsd-checklist-weight">+{item.weight} pts available</span>}
              </li>
            ))}
          </ul>

          <div className="hsd-recommendations">
            <h4>How to Maximize Your Score</h4>
            {dim.allSet ? (
              <p className="hsd-all-set">Nothing to fix here - this category is in good shape.</p>
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

export default function HealthScoreDashboard({
  entityData, pipelineStageCount, ruleCoverage, outOfOrderStageCount = 0, pipelineCount = null, pipelineStagesResolved = true,
  mandatoryFields,
}: Props) {
  const [expandedKey, setExpandedKey] = useState<DimensionKey | null>(null);
  const [animate, setAnimate] = useState(false);

  const mandatoryFieldsResolved = !mandatoryFields || (!mandatoryFields.loading && mandatoryFields.lastFetched !== null);
  // perModule stays empty whenever EVERY core module's layout fetch failed
  // (see useMandatoryFields.ts) - lastFetched still gets set in that case (so
  // the loader doesn't hang forever waiting on a fetch that's done, just
  // failed), so checking only lastFetched here would read a total failure as
  // a confirmed "0 mandatory fields" instead of the honest "unknown" the
  // dimension's own copy ("this isn't a confirmed 0") already assumes.
  const mandatoryFieldCount = mandatoryFields?.lastFetched !== null && mandatoryFields && mandatoryFields.perModule.length > 0
    ? mandatoryFields.count
    : null;

  const model = useMemo(
    () => buildHealthAuditModel(
      entityData, pipelineStageCount, ruleCoverage, outOfOrderStageCount, pipelineCount, pipelineStagesResolved,
      mandatoryFieldCount, mandatoryFields?.error ?? null, mandatoryFieldsResolved,
    ),
    [entityData, pipelineStageCount, ruleCoverage, outOfOrderStageCount, pipelineCount, pipelineStagesResolved, mandatoryFieldCount, mandatoryFields?.error, mandatoryFieldsResolved],
  );

  // Drives the gauge sweep, count-ups, and metric bar fills together, once,
  // the moment real data actually lands - not on every re-render while
  // still loading, and not restarted by an unrelated prop change once it's
  // already played.
  useEffect(() => {
    if (!model.resolved) { setAnimate(false); return; }
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [model.resolved]);

  const displayCurrent = useCountUp(model.total, animate, 1200);
  const displayGain = useCountUp(model.gainTotal, animate, 1200);

  // Worst-first (ascending score) - the whole point of this list is "what
  // needs attention first", so the lowest-scoring real dimension always
  // leads regardless of the fixed dimension order businessScore.ts computes
  // them in.
  const sortedDimensions = useMemo(
    () => [...model.dimensions].sort((a, b) => a.score - b.score),
    [model.dimensions],
  );

  return (
    <div className="hsd-dashboard">
      <div className="hsd-score-card business-view-section">
        <div className="hsd-score-header">
          <HeartPulse size={18} strokeWidth={2} />
          <SectionTitle text="CRM health score" tooltip="Is my CRM working well or broken? A single score built from automation, sales process setup, security, data structure, and workflow health." />
        </div>

        <div className="hsd-score-body">
          <div className="hsd-score-left">
            <div className="hsd-metrics">
              {sortedDimensions.map(dim => (
                <MetricRow
                  key={dim.key}
                  dim={dim}
                  expanded={expandedKey === dim.key}
                  onToggle={() => setExpandedKey(prev => (prev === dim.key ? null : dim.key))}
                  resolved={model.resolved}
                  animate={animate}
                />
              ))}
            </div>
          </div>

          <div className="hsd-score-right">
            <HealthGauge
              score={model.total}
              resolved={model.resolved}
              weakestLabel={sortedDimensions[0]?.label ?? null}
              weakestScore={sortedDimensions[0]?.score ?? null}
            />
            <GaugeLegend />

            <VerdictStrip score={model.total} resolved={model.resolved} />

            <div className="hsd-kpi-row">
              <div className="hsd-kpi-tile tone-neutral">
                <span className="hsd-kpi-value">{model.resolved ? displayCurrent : "-"}</span>
                <span className="hsd-kpi-label">Current score</span>
              </div>
              <div className="hsd-kpi-tile tone-healthy">
                <span className="hsd-kpi-value"><TrendingUp size={14} /> {model.resolved ? `+${displayGain}` : "-"}</span>
                <span className="hsd-kpi-label">Improvement available</span>
              </div>
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
              Estimated Overall Score - Current <strong>{model.total}</strong> → Potential <strong>{model.potentialTotal}</strong> ({model.gainTotal} points available)
            </p>
          </>
        )}
      </div>
    </div>
  );
}
