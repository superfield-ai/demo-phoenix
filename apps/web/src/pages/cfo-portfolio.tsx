/**
 * @file cfo-portfolio
 *
 * CFO CLTV portfolio dashboard — Phase 2 P2-2, issue #14.
 *
 * Features:
 *   - Bubble/treemap chart: industry on X, total CLTV as bubble size, avg tier as color
 *   - View toggle: bubble/treemap ↔ stacked bar by company segment
 *   - 12-month trend line overlay on primary chart
 *   - Macro scenario modeler: interest rate delta slider, GDP growth selector,
 *     industry stress multi-select
 *   - Client-side recomputation (no server round-trip on slider change)
 *   - Reset to actuals button
 *   - Save scenario: downloads CSV
 *
 * Canonical docs: docs/prd.md §4.3
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { BarChart3, TrendingUp, Sliders, RotateCcw, Bell } from 'lucide-react';
import { ExportButton, type MacroScenarioState } from '../components/ExportButton';
import { ScheduledReportModal, type ScheduledReport } from '../components/ScheduledReportModal';
import { SkeletonChart } from '../components/Skeleton';
import { ContextualEmptyState } from '../components/ContextualEmptyState';
import { ScoreTooltip } from '../components/ScoreTooltip';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PortfolioEntity {
  prospect_id: string;
  macro_inputs_snapshot: {
    interest_rate: number | null;
    gdp_growth_rate: number | null;
    inflation_rate: number | null;
  } | null;
}

interface PortfolioSegment {
  industry: string;
  company_segment: string;
  total_cltv: number;
  lead_count: number;
  average_composite_score: number;
  score_tier_distribution: { A: number; B: number; C: number; D: number };
  entities: PortfolioEntity[];
}

interface TrendEntry {
  month: string;
  tier_A: number;
  tier_B: number;
  tier_C: number;
  tier_D: number;
  total: number;
}

type ChartView = 'bubble' | 'bar';
type GdpGrowthScenario = 'recession' | 'flat' | 'moderate' | 'strong';

// ─────────────────────────────────────────────────────────────────────────────
// Client-side macro recomputation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GDP scenario → gdp_growth_rate value used in recomputation.
 * Mirrors the normalisation used by the server-side cltv-scorer.
 */
const GDP_SCENARIO_VALUES: Record<GdpGrowthScenario, number> = {
  recession: -3,
  flat: 0,
  moderate: 2.5,
  strong: 5,
};

/**
 * Normalise a single macro indicator value to [0, 1] using the same formulae
 * as packages/db/cltv-scorer.ts.
 */
function normaliseMacroIndicator(
  type: 'interest_rate' | 'gdp_growth_rate' | 'inflation_rate',
  value: number,
): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (type === 'interest_rate') return clamp(1 - value / 20);
  if (type === 'gdp_growth_rate') return clamp((value + 5) / 15);
  // inflation_rate
  return clamp(1 - value / 20);
}

/**
 * Applies scenario deltas to a prospect's macro_inputs_snapshot and returns a
 * new composite_score estimate (0–100).
 *
 * The macro sub-score is recomputed; the industry and company sub-scores are
 * held constant at their original value (0.5 neutral default when unknown).
 *
 * Weights are the defaults from resolveScoringConfig (30/30/40).
 */
function recomputeCompositeScore(
  originalCompositeScore: number,
  macroSnapshot: PortfolioEntity['macro_inputs_snapshot'],
  interestRateDelta: number,
  gdpScenario: GdpGrowthScenario,
  stressedIndustries: string[],
  entityIndustry: string,
): number {
  // If no macro snapshot we can't recompute — return original.
  if (!macroSnapshot) return originalCompositeScore;

  // Apply scenario deltas to the macro snapshot values.
  const newInterestRate =
    macroSnapshot.interest_rate !== null
      ? macroSnapshot.interest_rate + interestRateDelta
      : interestRateDelta;
  const newGdpGrowthRate = GDP_SCENARIO_VALUES[gdpScenario];
  const newInflationRate = macroSnapshot.inflation_rate ?? 2.0;

  // Recompute macro sub-score using the same normalisation formula.
  const components: number[] = [];
  components.push(normaliseMacroIndicator('interest_rate', newInterestRate));
  components.push(normaliseMacroIndicator('gdp_growth_rate', newGdpGrowthRate));
  components.push(normaliseMacroIndicator('inflation_rate', newInflationRate));
  const newMacroSubScore = components.reduce((a, b) => a + b, 0) / components.length;

  // Industry stress: apply a 20% penalty to the macro sub-score when the
  // entity's industry is in the stressed list.
  const stressFactor = stressedIndustries.includes(entityIndustry) ? 0.8 : 1.0;
  const adjustedMacroSubScore = newMacroSubScore * stressFactor;

  // Reverse-engineer original industry+company combined score.
  // composite = 0.30 * macro + 0.70 * non_macro
  // non_macro = (composite/100 - 0.30 * macro) / 0.70
  const originalComposite = originalCompositeScore / 100;
  const originalMacroSubScore =
    macroSnapshot.interest_rate !== null ||
    macroSnapshot.gdp_growth_rate !== null ||
    macroSnapshot.inflation_rate !== null
      ? (() => {
          const comps: number[] = [];
          if (macroSnapshot.interest_rate !== null)
            comps.push(normaliseMacroIndicator('interest_rate', macroSnapshot.interest_rate));
          if (macroSnapshot.gdp_growth_rate !== null)
            comps.push(normaliseMacroIndicator('gdp_growth_rate', macroSnapshot.gdp_growth_rate));
          if (macroSnapshot.inflation_rate !== null)
            comps.push(normaliseMacroIndicator('inflation_rate', macroSnapshot.inflation_rate));
          return comps.length > 0 ? comps.reduce((a, b) => a + b, 0) / comps.length : 0.5;
        })()
      : 0.5;

  const nonMacro = (originalComposite - 0.3 * originalMacroSubScore) / 0.7;
  const newComposite = 0.3 * adjustedMacroSubScore + 0.7 * nonMacro;
  return Math.max(0, Math.min(100, Math.round(newComposite * 100 * 100) / 100));
}

/**
 * Applies scenario parameters to the full portfolio and returns recomputed
 * segment totals. Uses mid-point CLTV: (score/100) × annual_revenue proxy.
 *
 * Since we don't have annual_revenue_est in the entity snapshot, we derive the
 * per-entity mid-point CLTV from the segment's average_composite_score and
 * total_cltv baseline (distributing evenly across entities).
 */
function applyScenarioToSegments(
  segments: PortfolioSegment[],
  interestRateDelta: number,
  gdpScenario: GdpGrowthScenario,
  stressedIndustries: string[],
): PortfolioSegment[] {
  return segments.map((seg) => {
    if (seg.entities.length === 0 || seg.average_composite_score === 0) return seg;

    // Compute average score delta across entities in this segment.
    const recomputedScores = seg.entities.map((entity) =>
      recomputeCompositeScore(
        seg.average_composite_score,
        entity.macro_inputs_snapshot,
        interestRateDelta,
        gdpScenario,
        stressedIndustries,
        seg.industry,
      ),
    );

    const newAvgScore = recomputedScores.reduce((a, b) => a + b, 0) / recomputedScores.length;

    // Scale total_cltv proportionally to the score change.
    const scaleFactor =
      seg.average_composite_score > 0 ? newAvgScore / seg.average_composite_score : 1;
    const newTotalCltv = Math.round(seg.total_cltv * scaleFactor);

    return {
      ...seg,
      total_cltv: newTotalCltv,
      average_composite_score: Math.round(newAvgScore * 100) / 100,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers
// ─────────────────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  A: '#10b981', // emerald
  B: '#3b82f6', // blue
  C: '#f59e0b', // amber
  D: '#ef4444', // red
};

function getSegmentColor(avgScore: number): string {
  if (avgScore >= 80) return TIER_COLORS['A'];
  if (avgScore >= 60) return TIER_COLORS['B'];
  if (avgScore >= 40) return TIER_COLORS['C'];
  return TIER_COLORS['D'];
}

function getDominantTier(dist: { A: number; B: number; C: number; D: number }): string {
  const entries = Object.entries(dist) as [string, number][];
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? 'D';
}

function formatCltv(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier legend (with ScoreTooltip explanations)
// ─────────────────────────────────────────────────────────────────────────────

const TIER_DESCRIPTIONS: Record<string, string> = {
  A: 'Tier A — Composite score ≥ 80. Highest-quality leads with strong macro, industry, and company signals. These represent your most predictable and valuable revenue opportunities.',
  B: 'Tier B — Composite score 60–79. Good-quality leads with solid fundamentals. Worth active sales effort; some risk factors present but manageable.',
  C: 'Tier C — Composite score 40–59. Fair-quality leads with mixed signals. Require closer qualification; revenue potential is more variable.',
  D: 'Tier D — Composite score < 40. Low-quality leads with significant risk factors. Likely require re-scoring or further KYC before investing sales time.',
};

function TierLegend() {
  return (
    <div
      className="flex flex-wrap gap-3 items-center"
      data-testid="tier-legend"
      aria-label="Tier color legend"
    >
      {(['A', 'B', 'C', 'D'] as const).map((tier) => (
        <span
          key={tier}
          className="inline-flex items-center gap-1.5"
          data-testid={`tier-legend-item-${tier}`}
        >
          <span
            className="inline-block w-3 h-3 rounded-sm shrink-0"
            style={{ backgroundColor: TIER_COLORS[tier] }}
            aria-hidden="true"
          />
          <span className="text-xs text-zinc-600 font-medium">Tier {tier}</span>
          <ScoreTooltip
            summary_text={TIER_DESCRIPTIONS[tier]}
            aria_label={`Tier ${tier} explanation`}
          />
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bubble chart component
// ─────────────────────────────────────────────────────────────────────────────

interface BubbleChartProps {
  segments: PortfolioSegment[];
  onHover: (seg: PortfolioSegment | null) => void;
  hoveredSegment: PortfolioSegment | null;
  trend: TrendEntry[];
}

function BubbleChart({ segments, onHover, hoveredSegment, trend }: BubbleChartProps) {
  const industries = Array.from(new Set(segments.map((s) => s.industry)));
  const maxCltv = Math.max(...segments.map((s) => s.total_cltv), 1);

  const WIDTH = 700;
  const HEIGHT = 340;
  const PADDING = { top: 20, right: 20, bottom: 60, left: 60 };
  const CHART_W = WIDTH - PADDING.left - PADDING.right;
  const CHART_H = HEIGHT - PADDING.top - PADDING.bottom;

  const industryX = (industry: string) => {
    const idx = industries.indexOf(industry);
    return PADDING.left + (idx + 0.5) * (CHART_W / industries.length);
  };

  const bubbleRadius = (totalCltv: number) => {
    const maxR = 50;
    const minR = 8;
    return minR + (maxR - minR) * Math.sqrt(totalCltv / maxCltv);
  };

  // Trend line — total CLTV per month scaled to chart height
  const trendMax = Math.max(...trend.map((t) => t.total), 1);
  const trendPoints = trend.map((t, i) => {
    const x = PADDING.left + (i / (trend.length - 1)) * CHART_W;
    const y = PADDING.top + CHART_H - (t.total / trendMax) * CHART_H;
    return `${x},${y}`;
  });

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full h-full"
      style={{ maxHeight: 360 }}
      role="img"
      aria-label="CLTV portfolio bubble chart"
    >
      {/* Axis lines */}
      <line
        x1={PADDING.left}
        y1={PADDING.top + CHART_H}
        x2={PADDING.left + CHART_W}
        y2={PADDING.top + CHART_H}
        stroke="#e5e7eb"
        strokeWidth={1}
      />
      <line
        x1={PADDING.left}
        y1={PADDING.top}
        x2={PADDING.left}
        y2={PADDING.top + CHART_H}
        stroke="#e5e7eb"
        strokeWidth={1}
      />

      {/* 12-month trend line overlay */}
      {trend.length >= 2 && (
        <polyline
          points={trendPoints.join(' ')}
          fill="none"
          stroke="#6366f1"
          strokeWidth={2}
          strokeDasharray="5 3"
          opacity={0.6}
        />
      )}

      {/* Bubbles */}
      {segments.map((seg, i) => {
        const cx = industryX(seg.industry);
        // Stagger bubbles vertically by company_segment to avoid overlap
        const segmentOffset =
          seg.company_segment === 'Enterprise' ? -30 : seg.company_segment === 'SMB' ? 30 : 0;
        const cy = PADDING.top + CHART_H / 2 + segmentOffset;
        const r = bubbleRadius(seg.total_cltv);
        const color = getSegmentColor(seg.average_composite_score);
        const isHovered =
          hoveredSegment?.industry === seg.industry &&
          hoveredSegment?.company_segment === seg.company_segment;

        return (
          <g key={`${seg.industry}-${seg.company_segment}-${i}`}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={color}
              fillOpacity={isHovered ? 0.9 : 0.65}
              stroke={color}
              strokeWidth={isHovered ? 2 : 1}
              style={{ cursor: 'pointer', transition: 'r 0.2s, fill-opacity 0.15s' }}
              onMouseEnter={() => onHover(seg)}
              onMouseLeave={() => onHover(null)}
            />
            {r > 18 && (
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={10}
                fill="white"
                fontWeight="bold"
                style={{ pointerEvents: 'none' }}
              >
                {getDominantTier(seg.score_tier_distribution)}
              </text>
            )}
          </g>
        );
      })}

      {/* X-axis labels */}
      {industries.map((ind) => (
        <text
          key={ind}
          x={industryX(ind)}
          y={PADDING.top + CHART_H + 20}
          textAnchor="middle"
          fontSize={11}
          fill="#6b7280"
        >
          {ind.length > 14 ? ind.slice(0, 12) + '…' : ind}
        </text>
      ))}

      {/* Y-axis label */}
      <text
        x={12}
        y={PADDING.top + CHART_H / 2}
        textAnchor="middle"
        fontSize={10}
        fill="#9ca3af"
        transform={`rotate(-90, 12, ${PADDING.top + CHART_H / 2})`}
      >
        CLTV
      </text>

      {/* Trend line legend */}
      {trend.length >= 2 && (
        <g>
          <line
            x1={WIDTH - 120}
            y1={16}
            x2={WIDTH - 100}
            y2={16}
            stroke="#6366f1"
            strokeWidth={2}
            strokeDasharray="5 3"
          />
          <text x={WIDTH - 96} y={20} fontSize={10} fill="#6366f1">
            12-mo trend
          </text>
        </g>
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stacked bar chart component
// ─────────────────────────────────────────────────────────────────────────────

interface StackedBarChartProps {
  segments: PortfolioSegment[];
  onHover: (seg: PortfolioSegment | null) => void;
  hoveredSegment: PortfolioSegment | null;
}

function StackedBarChart({
  segments,
  onHover,
  hoveredSegment: _hoveredSegment,
}: StackedBarChartProps) {
  const companySegments = ['SMB', 'Mid-Market', 'Enterprise', 'Unknown'];
  const grouped = new Map<string, Record<string, number>>();

  for (const seg of segments) {
    if (!grouped.has(seg.industry)) {
      grouped.set(seg.industry, {});
    }
    const entry = grouped.get(seg.industry)!;
    entry[seg.company_segment] = (entry[seg.company_segment] ?? 0) + seg.total_cltv;
  }

  const industries = Array.from(grouped.keys());
  const maxTotal = Math.max(
    ...industries.map((ind) => {
      const entry = grouped.get(ind)!;
      return Object.values(entry).reduce((a, b) => a + b, 0);
    }),
    1,
  );

  const WIDTH = 700;
  const HEIGHT = 340;
  const PADDING = { top: 20, right: 20, bottom: 60, left: 70 };
  const CHART_W = WIDTH - PADDING.left - PADDING.right;
  const CHART_H = HEIGHT - PADDING.top - PADDING.bottom;
  const barW = Math.min(60, (CHART_W / industries.length) * 0.6);

  const SEG_COLORS: Record<string, string> = {
    SMB: '#6366f1',
    'Mid-Market': '#3b82f6',
    Enterprise: '#10b981',
    Unknown: '#9ca3af',
  };

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full h-full"
      style={{ maxHeight: 360 }}
      role="img"
      aria-label="CLTV portfolio stacked bar chart by company segment"
    >
      {/* Axis lines */}
      <line
        x1={PADDING.left}
        y1={PADDING.top + CHART_H}
        x2={PADDING.left + CHART_W}
        y2={PADDING.top + CHART_H}
        stroke="#e5e7eb"
        strokeWidth={1}
      />
      <line
        x1={PADDING.left}
        y1={PADDING.top}
        x2={PADDING.left}
        y2={PADDING.top + CHART_H}
        stroke="#e5e7eb"
        strokeWidth={1}
      />

      {/* Bars */}
      {industries.map((ind, idx) => {
        const entry = grouped.get(ind)!;
        const total = Object.values(entry).reduce((a, b) => a + b, 0);
        const x = PADDING.left + (idx + 0.5) * (CHART_W / industries.length) - barW / 2;
        let yOffset = PADDING.top + CHART_H;

        return (
          <g key={ind}>
            {companySegments.map((cs) => {
              const val = entry[cs] ?? 0;
              if (val === 0) return null;
              const h = (val / maxTotal) * CHART_H;
              yOffset -= h;
              return (
                <rect
                  key={cs}
                  x={x}
                  y={yOffset}
                  width={barW}
                  height={h}
                  fill={SEG_COLORS[cs] ?? '#9ca3af'}
                  opacity={0.8}
                  rx={2}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => {
                    const seg = segments.find(
                      (s) => s.industry === ind && s.company_segment === cs,
                    );
                    if (seg) onHover(seg);
                  }}
                  onMouseLeave={() => onHover(null)}
                />
              );
            })}
            {/* CLTV label on top of bar */}
            <text
              x={x + barW / 2}
              y={PADDING.top + CHART_H - (total / maxTotal) * CHART_H - 4}
              textAnchor="middle"
              fontSize={9}
              fill="#6b7280"
            >
              {formatCltv(total)}
            </text>
          </g>
        );
      })}

      {/* X-axis labels */}
      {industries.map((ind, idx) => (
        <text
          key={ind}
          x={PADDING.left + (idx + 0.5) * (CHART_W / industries.length)}
          y={PADDING.top + CHART_H + 18}
          textAnchor="middle"
          fontSize={11}
          fill="#6b7280"
        >
          {ind.length > 14 ? ind.slice(0, 12) + '…' : ind}
        </text>
      ))}

      {/* Legend */}
      {companySegments.map((cs, i) => (
        <g key={cs}>
          <rect
            x={PADDING.left + i * 90}
            y={HEIGHT - 18}
            width={10}
            height={10}
            fill={SEG_COLORS[cs] ?? '#9ca3af'}
            rx={2}
          />
          <text x={PADDING.left + i * 90 + 13} y={HEIGHT - 9} fontSize={10} fill="#6b7280">
            {cs}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip
// ─────────────────────────────────────────────────────────────────────────────

function SegmentTooltip({ seg }: { seg: PortfolioSegment }) {
  const dominant = getDominantTier(seg.score_tier_distribution);
  return (
    <div className="absolute z-20 bg-white border border-zinc-200 rounded-lg shadow-lg p-3 text-xs w-56 pointer-events-none">
      <div className="font-semibold text-zinc-900 mb-1">
        {seg.industry} · {seg.company_segment}
      </div>
      <div className="text-zinc-600 space-y-0.5">
        <div>
          Total CLTV:{' '}
          <span className="font-medium text-zinc-900">{formatCltv(seg.total_cltv)}</span>
        </div>
        <div>
          Leads: <span className="font-medium text-zinc-900">{seg.lead_count}</span>
        </div>
        <div>
          Avg score:{' '}
          <span className="font-medium text-zinc-900">
            {seg.average_composite_score.toFixed(1)}
          </span>
        </div>
        <div>
          Dominant tier:{' '}
          <span className="font-medium" style={{ color: TIER_COLORS[dominant] }}>
            {dominant}
          </span>
        </div>
      </div>
      <div className="mt-1.5 flex gap-1">
        {(['A', 'B', 'C', 'D'] as const).map(
          (t) =>
            seg.score_tier_distribution[t] > 0 && (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded text-white text-xs font-medium"
                style={{ backgroundColor: TIER_COLORS[t] }}
              >
                {t}: {seg.score_tier_distribution[t]}
              </span>
            ),
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page component
// ─────────────────────────────────────────────────────────────────────────────

export function CfoPortfolioPage() {
  const [segments, setSegments] = useState<PortfolioSegment[]>([]);
  const [trend, setTrend] = useState<TrendEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartView, setChartView] = useState<ChartView>('bubble');
  const [hoveredSegment, setHoveredSegment] = useState<PortfolioSegment | null>(null);

  // Scenario state
  const [interestRateDelta, setInterestRateDelta] = useState(0);
  const [gdpScenario, setGdpScenario] = useState<GdpGrowthScenario>('moderate');
  const [stressedIndustries, setStressedIndustries] = useState<string[]>([]);
  const [isScenarioActive, setIsScenarioActive] = useState(false);

  // Displayed segments (actual or scenario-recomputed)
  const [displayedSegments, setDisplayedSegments] = useState<PortfolioSegment[]>([]);

  // Scheduled report modal
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduledReports, setScheduledReports] = useState<ScheduledReport[]>([]);

  const fetchAbortRef = useRef<AbortController | null>(null);

  // Fetch portfolio data
  useEffect(() => {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;

    setLoading(true);
    setError(null);

    Promise.all([
      fetch('/api/cfo/portfolio', { credentials: 'include', signal: ctrl.signal }),
      fetch('/api/cfo/portfolio/trend', { credentials: 'include', signal: ctrl.signal }),
    ])
      .then(async ([portfolioRes, trendRes]) => {
        if (!portfolioRes.ok) throw new Error(`Portfolio fetch failed: ${portfolioRes.status}`);
        if (!trendRes.ok) throw new Error(`Trend fetch failed: ${trendRes.status}`);
        const portfolioData = await portfolioRes.json();
        const trendData = await trendRes.json();
        setSegments(portfolioData.segments ?? []);
        setDisplayedSegments(portfolioData.segments ?? []);
        setTrend(trendData.trend ?? []);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, []);

  // Apply scenario when slider/selector changes — no network request
  const applyScenario = useCallback(() => {
    const isDefault =
      interestRateDelta === 0 && gdpScenario === 'moderate' && stressedIndustries.length === 0;

    if (isDefault) {
      setDisplayedSegments(segments);
      setIsScenarioActive(false);
      return;
    }

    setIsScenarioActive(true);
    const recomputed = applyScenarioToSegments(
      segments,
      interestRateDelta / 100, // slider is in bps → convert to percentage points
      gdpScenario,
      stressedIndustries,
    );
    setDisplayedSegments(recomputed);
  }, [segments, interestRateDelta, gdpScenario, stressedIndustries]);

  useEffect(() => {
    applyScenario();
  }, [applyScenario]);

  const handleReset = () => {
    setInterestRateDelta(0);
    setGdpScenario('moderate');
    setStressedIndustries([]);
    setIsScenarioActive(false);
    setDisplayedSegments(segments);
  };

  const toggleIndustryStress = (industry: string) => {
    setStressedIndustries((prev) =>
      prev.includes(industry) ? prev.filter((i) => i !== industry) : [...prev, industry],
    );
  };

  const allIndustries = Array.from(new Set(segments.map((s) => s.industry))).sort();

  // Summary bar totals
  const totalCltv = displayedSegments.reduce((s, seg) => s + seg.total_cltv, 0);
  const totalLeads = displayedSegments.reduce((s, seg) => s + seg.lead_count, 0);
  const tierCounts = displayedSegments.reduce(
    (acc, seg) => {
      acc.A += seg.score_tier_distribution.A;
      acc.B += seg.score_tier_distribution.B;
      acc.C += seg.score_tier_distribution.C;
      acc.D += seg.score_tier_distribution.D;
      return acc;
    },
    { A: 0, B: 0, C: 0, D: 0 },
  );

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        <SkeletonChart />
        <SkeletonChart />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-red-600 text-sm">
        Failed to load portfolio data: {error}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">CLTV Portfolio</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Revenue quality signal by segment</p>
        </div>
        <div className="flex items-center gap-2">
          {isScenarioActive && (
            <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-medium border border-amber-200">
              Scenario active
            </span>
          )}
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-600 border border-zinc-200 hover:bg-zinc-50 transition-colors"
          >
            <RotateCcw size={14} />
            Reset to actuals
          </button>
          {/* One-click chart export (PDF) */}
          <ExportButton
            mode="chart"
            scenarioState={
              {
                interest_rate_delta: interestRateDelta,
                gdp_assumption: gdpScenario,
                stressed_industries: stressedIndustries,
              } satisfies MacroScenarioState
            }
            filename={`cfo-portfolio-${new Date().toISOString().slice(0, 10)}`}
            ariaLabel="Export portfolio chart as PDF"
          />
          {/* One-click portfolio CSV export */}
          <ExportButton
            mode="csv"
            csvRows={[
              [
                'industry',
                'company_segment',
                'total_cltv',
                'lead_count',
                'average_composite_score',
              ],
              ...displayedSegments.map((s) => [
                s.industry,
                s.company_segment,
                String(s.total_cltv),
                String(s.lead_count),
                String(s.average_composite_score),
              ]),
            ]}
            scenarioState={
              {
                interest_rate_delta: interestRateDelta,
                gdp_assumption: gdpScenario,
                stressed_industries: stressedIndustries,
              } satisfies MacroScenarioState
            }
            filename={`cfo-portfolio-${new Date().toISOString().slice(0, 10)}`}
          />
          {/* Schedule recurring report */}
          <button
            onClick={() => setShowScheduleModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-600 border border-zinc-200 hover:bg-zinc-50 transition-colors"
            aria-label="Schedule recurring report"
            title={`Schedule recurring report${scheduledReports.length > 0 ? ` (${scheduledReports.length} active)` : ''}`}
          >
            <Bell size={14} />
            Schedule
            {scheduledReports.length > 0 && (
              <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
                {scheduledReports.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Executive summary bar */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Total CLTV</div>
          <div className="text-2xl font-semibold text-zinc-900 mt-1">{formatCltv(totalCltv)}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Total Leads</div>
          <div className="text-2xl font-semibold text-zinc-900 mt-1">{totalLeads}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Tier distribution</div>
          <div className="flex gap-1.5 mt-2">
            {(['A', 'B', 'C', 'D'] as const).map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded text-white text-xs font-semibold"
                style={{ backgroundColor: TIER_COLORS[t] }}
              >
                {t}:{tierCounts[t]}
              </span>
            ))}
          </div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Segments</div>
          <div className="text-2xl font-semibold text-zinc-900 mt-1">
            {displayedSegments.length}
          </div>
        </div>
      </div>

      {/* Chart area */}
      <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
        {/* Chart header + view toggle */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            {chartView === 'bubble' ? (
              <TrendingUp size={15} className="text-indigo-500" />
            ) : (
              <BarChart3 size={15} className="text-indigo-500" />
            )}
            {chartView === 'bubble' ? 'Portfolio Bubble Chart' : 'Stacked Bar by Segment'}
          </div>
          <div className="flex rounded-lg border border-zinc-200 overflow-hidden text-xs">
            <button
              onClick={() => setChartView('bubble')}
              className={`px-3 py-1.5 transition-colors ${chartView === 'bubble' ? 'bg-indigo-50 text-indigo-600 font-medium' : 'text-zinc-500 hover:bg-zinc-50'}`}
            >
              Bubble
            </button>
            <button
              onClick={() => setChartView('bar')}
              className={`px-3 py-1.5 transition-colors ${chartView === 'bar' ? 'bg-indigo-50 text-indigo-600 font-medium' : 'text-zinc-500 hover:bg-zinc-50'}`}
            >
              Stacked bar
            </button>
          </div>
        </div>

        {/* Chart with tooltip */}
        <div className="relative p-4">
          {displayedSegments.length === 0 ? (
            <ContextualEmptyState
              message="No portfolio data yet — prospects must be scored and assigned to a rep before they appear here"
              testId="portfolio-chart-empty-state"
            />
          ) : chartView === 'bubble' ? (
            <BubbleChart
              segments={displayedSegments}
              onHover={setHoveredSegment}
              hoveredSegment={hoveredSegment}
              trend={trend}
            />
          ) : (
            <StackedBarChart
              segments={displayedSegments}
              onHover={setHoveredSegment}
              hoveredSegment={hoveredSegment}
            />
          )}

          {/* Hover tooltip */}
          {hoveredSegment && (
            <div className="absolute top-4 right-4">
              <SegmentTooltip seg={hoveredSegment} />
            </div>
          )}
        </div>

        {/* Tier color legend with score explanation tooltips */}
        <div className="px-5 py-3 border-t border-zinc-100">
          <TierLegend />
        </div>
      </div>

      {/* Macro scenario modeler */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Sliders size={16} className="text-indigo-500" />
          <h2 className="text-sm font-semibold text-zinc-800">Macro Scenario Modeler</h2>
          <span className="text-xs text-zinc-400 ml-1">(client-side, no server round-trip)</span>
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Interest rate delta */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-2">
              Interest rate delta:{' '}
              <span
                className={`font-semibold ${interestRateDelta > 0 ? 'text-red-600' : interestRateDelta < 0 ? 'text-emerald-600' : 'text-zinc-600'}`}
              >
                {interestRateDelta > 0 ? '+' : ''}
                {interestRateDelta} bps
              </span>
            </label>
            <input
              type="range"
              min={-200}
              max={300}
              step={25}
              value={interestRateDelta}
              onChange={(e) => setInterestRateDelta(Number(e.target.value))}
              className="w-full accent-indigo-600"
              aria-label="Interest rate delta slider"
            />
            <div className="flex justify-between text-xs text-zinc-400 mt-1">
              <span>−200 bps</span>
              <span>+300 bps</span>
            </div>
          </div>

          {/* GDP growth scenario */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-2">
              GDP growth scenario
            </label>
            <select
              value={gdpScenario}
              onChange={(e) => setGdpScenario(e.target.value as GdpGrowthScenario)}
              className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              aria-label="GDP growth scenario selector"
            >
              <option value="recession">Recession (−3%)</option>
              <option value="flat">Flat (0%)</option>
              <option value="moderate">Moderate (+2.5%)</option>
              <option value="strong">Strong (+5%)</option>
            </select>
          </div>

          {/* Industry stress multi-select */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-2">
              Industry stress ({stressedIndustries.length} selected)
            </label>
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {allIndustries.map((ind) => (
                <button
                  key={ind}
                  onClick={() => toggleIndustryStress(ind)}
                  className={`px-2 py-1 text-xs rounded-full border transition-colors ${
                    stressedIndustries.includes(ind)
                      ? 'bg-red-50 border-red-300 text-red-700'
                      : 'bg-zinc-50 border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                  }`}
                  aria-label={`${stressedIndustries.includes(ind) ? 'Remove' : 'Add'} industry stress: ${ind}`}
                  aria-pressed={stressedIndustries.includes(ind)}
                >
                  {ind}
                </button>
              ))}
              {allIndustries.length === 0 && (
                <span className="text-xs text-zinc-400">No industries loaded</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Segment table — with one-click CSV export */}
      {displayedSegments.length > 0 && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100">
            <span className="text-sm font-medium text-zinc-700">Segment breakdown</span>
            <ExportButton
              mode="csv"
              csvRows={[
                [
                  'industry',
                  'company_segment',
                  'total_cltv',
                  'lead_count',
                  'average_composite_score',
                ],
                ...displayedSegments.map((s) => [
                  s.industry,
                  s.company_segment,
                  String(s.total_cltv),
                  String(s.lead_count),
                  String(s.average_composite_score),
                ]),
              ]}
              scenarioState={
                {
                  interest_rate_delta: interestRateDelta,
                  gdp_assumption: gdpScenario,
                  stressed_industries: stressedIndustries,
                } satisfies MacroScenarioState
              }
              filename={`cfo-segments-${new Date().toISOString().slice(0, 10)}`}
              ariaLabel="Export segment breakdown as CSV"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 text-xs text-zinc-500 uppercase">
                  <th className="text-left px-4 py-2.5 font-medium">Industry</th>
                  <th className="text-left px-4 py-2.5 font-medium">Segment</th>
                  <th className="text-right px-4 py-2.5 font-medium">Total CLTV</th>
                  <th className="text-right px-4 py-2.5 font-medium">Leads</th>
                  <th className="text-right px-4 py-2.5 font-medium">Avg Score</th>
                  <th className="text-center px-4 py-2.5 font-medium">Tiers</th>
                </tr>
              </thead>
              <tbody>
                {displayedSegments.map((seg, i) => (
                  <tr
                    key={`${seg.industry}-${seg.company_segment}-${i}`}
                    className="border-t border-zinc-100 hover:bg-zinc-50 transition-colors"
                    onMouseEnter={() => setHoveredSegment(seg)}
                    onMouseLeave={() => setHoveredSegment(null)}
                  >
                    <td className="px-4 py-2.5 text-zinc-700 font-medium">{seg.industry}</td>
                    <td className="px-4 py-2.5 text-zinc-500">{seg.company_segment}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-zinc-900">
                      {formatCltv(seg.total_cltv)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-600">{seg.lead_count}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className="font-medium"
                        style={{ color: getSegmentColor(seg.average_composite_score) }}
                      >
                        {seg.average_composite_score.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {(['A', 'B', 'C', 'D'] as const).map(
                          (t) =>
                            seg.score_tier_distribution[t] > 0 && (
                              <span
                                key={t}
                                className="inline-block px-1.5 py-0.5 rounded text-white text-xs font-medium"
                                style={{ backgroundColor: TIER_COLORS[t] }}
                              >
                                {t}:{seg.score_tier_distribution[t]}
                              </span>
                            ),
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Scheduled report modal */}
      {showScheduleModal && (
        <ScheduledReportModal
          onClose={() => setShowScheduleModal(false)}
          onCreated={(report) => setScheduledReports((prev) => [report, ...prev])}
        />
      )}
    </div>
  );
}
