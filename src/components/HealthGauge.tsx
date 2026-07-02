"use client";

import type { HealthZone } from "@/lib/businessScore";

const GAUGE_CX = 100;
const GAUGE_CY = 100;
const GAUGE_R = 80;
const GAUGE_PATH = `M ${GAUGE_CX - GAUGE_R} ${GAUGE_CY} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${GAUGE_CX + GAUGE_R} ${GAUGE_CY}`;
const GAUGE_ARC_LEN = Math.PI * GAUGE_R;

interface Props {
  score: number;
  zone: HealthZone;
  resolved: boolean;
}

export default function HealthGauge({ score, zone, resolved }: Props) {
  const pct = resolved ? score / 100 : 0;
  const dashOffset = GAUGE_ARC_LEN * (1 - pct);

  return (
    <div className="health-gauge-wrap">
      <svg className="health-gauge-svg" viewBox="0 0 200 110">
        <path d={GAUGE_PATH} className="health-gauge-arc-bg" />
        <path
          d={GAUGE_PATH}
          className={`health-gauge-arc-fill ${resolved ? `zone-${zone}` : "zone-loading"}`}
          style={{ strokeDasharray: GAUGE_ARC_LEN, strokeDashoffset: dashOffset }}
        />
      </svg>
      <div className="health-gauge-center">
        {resolved ? (
          <>
            <span className="health-gauge-score-num">{score}</span>
            <span className="health-gauge-score-max">/100</span>
          </>
        ) : (
          <span className="health-gauge-loading">Calculating…</span>
        )}
      </div>
    </div>
  );
}
