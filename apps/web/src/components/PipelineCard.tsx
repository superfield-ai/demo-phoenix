/**
 * @file PipelineCard
 *
 * Read-only pipeline card component for the Sales Rep kanban board (issue #10).
 *
 * Displays:
 *   - Company name
 *   - Score tier badge (A/B/C/D)
 *   - CLTV estimate range ($low – $high)
 *   - Days in stage
 *
 * Cards are purely navigational — clicking navigates to /leads/:prospectId.
 * No drag-and-drop: there are no drag event handlers attached to the element.
 */

import React from 'react';

export interface PipelineCardData {
  deal_id: string;
  prospect_id: string;
  company_name: string;
  stage: string;
  tier: string | null;
  cltv_low: number | null;
  cltv_high: number | null;
  days_in_stage: number;
}

interface PipelineCardProps {
  card: PipelineCardData;
  onNavigate: (prospectId: string) => void;
}

const TIER_COLORS: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-800',
  B: 'bg-blue-100 text-blue-800',
  C: 'bg-amber-100 text-amber-800',
  D: 'bg-red-100 text-red-800',
};

function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

export function PipelineCard({ card, onNavigate }: PipelineCardProps) {
  const tierColor = card.tier
    ? (TIER_COLORS[card.tier] ?? 'bg-zinc-100 text-zinc-700')
    : 'bg-zinc-100 text-zinc-500';

  const cltvDisplay =
    card.cltv_low !== null && card.cltv_high !== null
      ? `${formatCurrency(card.cltv_low)} – ${formatCurrency(card.cltv_high)}`
      : '—';

  const daysLabel = card.days_in_stage === 1 ? '1 day' : `${card.days_in_stage} days`;

  return (
    <button
      type="button"
      className="w-full text-left bg-white border border-zinc-200 rounded-lg p-3 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
      onClick={() => onNavigate(card.prospect_id)}
      data-testid="pipeline-card"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900 leading-tight flex-1 min-w-0 truncate">
          {card.company_name}
        </span>
        {card.tier && (
          <span
            className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shrink-0 ${tierColor}`}
            title={`Tier ${card.tier}`}
          >
            {card.tier}
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1">
        <div className="flex items-center gap-1">
          <span className="text-xs text-zinc-500">CLTV</span>
          <span className="text-xs font-medium text-zinc-800">{cltvDisplay}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-zinc-500">In stage</span>
          <span className="text-xs font-medium text-zinc-700">{daysLabel}</span>
        </div>
      </div>
    </button>
  );
}
