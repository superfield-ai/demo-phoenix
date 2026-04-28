/**
 * @file pages/pipeline-board
 *
 * Read-only pipeline kanban board for Sales Reps (issue #10).
 *
 * Renders five fixed columns matching Deal.stage values:
 *   Contacted | Qualified | Proposal | Closed Won | Closed Lost
 *
 * Each card shows company name, tier badge, CLTV estimate range, and days in stage.
 * Column footers show the sum of cltv_low and cltv_high for all cards in that column.
 * Cards are not draggable — stage changes happen in the lead detail view only.
 *
 * Clicking a card navigates to /leads/:prospectId.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/10
 */

import React, { useEffect, useState } from 'react';
import { PipelineCard, type PipelineCardData } from '../components/PipelineCard';

export type PipelineStage = 'contacted' | 'qualified' | 'proposal' | 'closed_won' | 'closed_lost';

export interface PipelineStages {
  contacted: PipelineCardData[];
  qualified: PipelineCardData[];
  proposal: PipelineCardData[];
  closed_won: PipelineCardData[];
  closed_lost: PipelineCardData[];
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
};

const STAGE_ORDER: PipelineStage[] = [
  'contacted',
  'qualified',
  'proposal',
  'closed_won',
  'closed_lost',
];

function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

interface ColumnFooterProps {
  cards: PipelineCardData[];
}

function ColumnFooter({ cards }: ColumnFooterProps) {
  const cardsWithCltv = cards.filter((c) => c.cltv_low !== null && c.cltv_high !== null);
  if (cardsWithCltv.length === 0) {
    return (
      <div className="mt-2 pt-2 border-t border-zinc-100">
        <span className="text-xs text-zinc-400">No CLTV data</span>
      </div>
    );
  }

  const totalLow = cardsWithCltv.reduce((sum, c) => sum + (c.cltv_low ?? 0), 0);
  const totalHigh = cardsWithCltv.reduce((sum, c) => sum + (c.cltv_high ?? 0), 0);

  return (
    <div className="mt-2 pt-2 border-t border-zinc-100" data-testid="column-footer">
      <div className="text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">
          {formatCurrency(totalLow)} – {formatCurrency(totalHigh)}
        </span>
        <span className="ml-1">total CLTV</span>
      </div>
    </div>
  );
}

interface PipelineBoardProps {
  /** Called when a card is clicked. Defaults to navigating via window.location. */
  onNavigate?: (prospectId: string) => void;
}

export function PipelineBoard({ onNavigate }: PipelineBoardProps) {
  const [stages, setStages] = useState<PipelineStages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/leads/pipeline', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ stages: PipelineStages }>;
      })
      .then((data) => {
        setStages(data.stages);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message ?? 'Failed to load pipeline');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleNavigate = (prospectId: string) => {
    if (onNavigate) {
      onNavigate(prospectId);
    } else {
      window.location.href = `/leads/${prospectId}`;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-lg border border-red-200">
          Failed to load pipeline: {error}
        </div>
      </div>
    );
  }

  if (!stages) return null;

  return (
    <div className="flex-1 overflow-x-auto">
      <div className="flex gap-4 p-6 min-w-max">
        {STAGE_ORDER.map((stage) => {
          const cards = stages[stage] ?? [];
          return (
            <div
              key={stage}
              className="flex flex-col w-64 shrink-0"
              data-testid={`column-${stage}`}
            >
              {/* Column header */}
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-700">{STAGE_LABELS[stage]}</h3>
                <span className="text-xs bg-zinc-100 text-zinc-600 font-medium px-2 py-0.5 rounded-full">
                  {cards.length}
                </span>
              </div>

              {/* Cards */}
              <div className="flex flex-col gap-2 flex-1 min-h-16 bg-zinc-50 rounded-lg p-2">
                {cards.length === 0 ? (
                  <div className="flex items-center justify-center h-16 text-xs text-zinc-400">
                    No leads
                  </div>
                ) : (
                  cards.map((card) => (
                    <PipelineCard key={card.deal_id} card={card} onNavigate={handleNavigate} />
                  ))
                )}
              </div>

              {/* Column footer: CLTV totals */}
              <ColumnFooter cards={cards} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PipelineBoardPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-2 border-b border-zinc-200">
        <h1 className="text-xl font-bold text-zinc-900">Pipeline</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          Your leads by stage. Click a card to view details.
        </p>
      </div>
      <PipelineBoard />
    </div>
  );
}
