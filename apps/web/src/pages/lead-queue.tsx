/**
 * @file lead-queue.tsx
 *
 * Sales Rep lead queue with score-ranked virtual scroll and filters (Phase 1, P1-1).
 *
 * ## Component hierarchy
 *
 *   LeadQueuePage
 *   ├── FilterPanel          — tier multi-select, industry multi-select,
 *   │                          days-in-queue range, sort control
 *   ├── LeadQueueTab         — active (qualified) leads
 *   │   └── VirtualLeadList  — renders rows using an Intersection-Observer
 *   │       └── LeadRow      — company, industry, SIC, tier badge, CLTV, KYC, days, rep
 *   ├── DisqualifiedTab      — disqualified leads (read-only)
 *   │   └── DisqualifiedRow
 *   └── EmptyState           — shown when qualified leads === 0
 *
 * ## Data flow
 *
 *   1. LeadQueuePage fetches GET /api/leads/queue on mount and on filter/sort change.
 *   2. GET /api/leads/disqualified is fetched when the Disqualified tab is opened.
 *   3. Rows are rendered with a virtual-scroll container: the row list is always
 *      in the DOM but only a visible window is rendered at full quality; rows
 *      outside the viewport are rendered as placeholder spacers (no DOM nodes
 *      inside) to keep scroll bar height stable.
 *
 * Canonical docs: docs/prd.md §4.1
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/7
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types (mirrors server/api/leads.ts and db/leads-queue.ts)
// ---------------------------------------------------------------------------

export type ScoreTier = 'A' | 'B' | 'C';
export type LeadQueueSort = 'score' | 'cltv' | 'days';

export interface QueueLead {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  assigned_rep_id: string | null;
  days_in_queue: number;
  composite_score: number | null;
  score_tier: ScoreTier | null;
  cltv_low: number | null;
  cltv_high: number | null;
  kyc_status: string | null;
  deal_stage: string | null;
  nudge: boolean;
  created_at: string;
}

export interface DisqualifiedLead {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  assigned_rep_id: string | null;
  disqualification_reason: string | null;
  disqualified_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT_PX = 72;
const OVERSCAN = 5;

const TIER_COLORS: Record<ScoreTier, { bg: string; text: string; label: string }> = {
  A: { bg: 'bg-green-100', text: 'text-green-800', label: 'A' },
  B: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'B' },
  C: { bg: 'bg-orange-100', text: 'text-orange-800', label: 'C' },
};

const KYC_COLORS: Record<string, { bg: string; text: string }> = {
  verified: { bg: 'bg-green-50', text: 'text-green-700' },
  pending: { bg: 'bg-zinc-100', text: 'text-zinc-600' },
  failed: { bg: 'bg-red-50', text: 'text-red-700' },
  archived: { bg: 'bg-zinc-100', text: 'text-zinc-400' },
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCltv(low: number | null, high: number | null): string {
  if (low === null || high === null) return '—';
  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
    return `$${n}`;
  };
  return `${fmt(low)} – ${fmt(high)}`;
}

// ---------------------------------------------------------------------------
// Score tier badge
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: ScoreTier | null }) {
  if (!tier) return <span className="text-zinc-400 text-xs">—</span>;
  const { bg, text, label } = TIER_COLORS[tier];
  return (
    <span
      className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-black text-sm ${bg} ${text} ring-2 ring-offset-1 ${tier === 'A' ? 'ring-green-400' : tier === 'B' ? 'ring-yellow-400' : 'ring-orange-400'}`}
      title={`Score tier ${label}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// KYC status pill
// ---------------------------------------------------------------------------

function KycPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-zinc-400 text-xs">—</span>;
  const colors = KYC_COLORS[status] ?? { bg: 'bg-zinc-100', text: 'text-zinc-600' };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LeadRow
// ---------------------------------------------------------------------------

function LeadRow({ lead }: { lead: QueueLead }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-zinc-100 hover:bg-zinc-50 transition-colors">
      {/* Tier badge — most prominent element */}
      <div className="flex-shrink-0 w-10 flex justify-center">
        <TierBadge tier={lead.score_tier} />
      </div>

      {/* Company / industry / SIC */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-zinc-900 truncate">{lead.company_name}</p>
        <p className="text-xs text-zinc-500 truncate">
          {[lead.industry, lead.sic_code].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>

      {/* CLTV estimate */}
      <div className="w-32 text-right shrink-0">
        <p className="text-xs text-zinc-400 uppercase tracking-wide">CLTV</p>
        <p className="text-sm font-medium text-zinc-700">
          {formatCltv(lead.cltv_low, lead.cltv_high)}
        </p>
      </div>

      {/* KYC status */}
      <div className="w-24 text-center shrink-0">
        <KycPill status={lead.kyc_status} />
      </div>

      {/* Days in queue */}
      <div className="w-16 text-center shrink-0">
        <p className="text-xs text-zinc-400 uppercase tracking-wide">Days</p>
        <p className="text-sm font-medium text-zinc-700">{lead.days_in_queue}</p>
      </div>

      {/* Follow-up nudge — shown when deal is in Contacted stage with no recent activity */}
      {lead.nudge && (
        <div className="shrink-0">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 uppercase tracking-wide whitespace-nowrap">
            Follow up?
          </span>
        </div>
      )}

      {/* Assigned rep */}
      <div className="w-28 text-right shrink-0 hidden md:block">
        <p className="text-xs text-zinc-400 truncate">{lead.assigned_rep_id?.slice(0, 8) ?? '—'}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Virtual lead list
// ---------------------------------------------------------------------------

/**
 * Renders a virtually-scrolled list of LeadRow components.
 *
 * Only the rows within the visible viewport (plus OVERSCAN rows above and below)
 * are rendered; the rest are replaced by a single spacer div. This avoids
 * pagination controls while keeping DOM size bounded.
 */
function VirtualLeadList({ leads }: { leads: QueueLead[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  const totalHeight = leads.length * ROW_HEIGHT_PX;
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN);
  const lastVisible = Math.min(
    leads.length - 1,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT_PX) + OVERSCAN,
  );

  const paddingTop = firstVisible * ROW_HEIGHT_PX;
  const paddingBottom = Math.max(0, (leads.length - 1 - lastVisible) * ROW_HEIGHT_PX);
  const visibleLeads = leads.slice(firstVisible, lastVisible + 1);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto"
      style={{ height: '100%' }}
      aria-label="Lead queue"
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ paddingTop, paddingBottom }}>
          {visibleLeads.map((lead) => (
            <div key={lead.id} style={{ height: ROW_HEIGHT_PX }}>
              <LeadRow lead={lead} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disqualified row
// ---------------------------------------------------------------------------

function DisqualifiedRow({ lead }: { lead: DisqualifiedLead }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-zinc-100">
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-zinc-900 truncate">{lead.company_name}</p>
        <p className="text-xs text-zinc-500 truncate">
          {[lead.industry, lead.sic_code].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-400 uppercase tracking-wide mb-0.5">Reason</p>
        <p className="text-sm text-zinc-600 truncate">{lead.disqualification_reason ?? '—'}</p>
      </div>
      <div className="w-28 text-right shrink-0">
        <p className="text-xs text-zinc-400">
          {lead.disqualified_at ? new Date(lead.disqualified_at).toLocaleDateString() : '—'}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ pendingKycCount }: { pendingKycCount: number }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-24 text-center">
      <div className="w-16 h-16 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
        <span className="text-3xl">🎯</span>
      </div>
      <h2 className="text-xl font-semibold text-zinc-800 mb-2">Your queue is empty</h2>
      <p className="text-zinc-500 max-w-sm">
        The scoring engine is working.{' '}
        {pendingKycCount > 0 ? (
          <>
            There {pendingKycCount === 1 ? 'is' : 'are'} <strong>{pendingKycCount}</strong>{' '}
            {pendingKycCount === 1 ? 'prospect' : 'prospects'} pending KYC — leads will appear here
            once scoring completes.
          </>
        ) : (
          'No prospects are currently pending KYC.'
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------

interface FilterPanelProps {
  sort: LeadQueueSort;
  onSortChange: (s: LeadQueueSort) => void;
  tiers: ScoreTier[];
  onTiersChange: (t: ScoreTier[]) => void;
  industries: string[];
  allIndustries: string[];
  onIndustriesChange: (i: string[]) => void;
}

function FilterPanel({
  sort,
  onSortChange,
  tiers,
  onTiersChange,
  industries,
  allIndustries,
  onIndustriesChange,
}: FilterPanelProps) {
  const allTiers: ScoreTier[] = ['A', 'B', 'C'];

  function toggleTier(tier: ScoreTier) {
    onTiersChange(tiers.includes(tier) ? tiers.filter((t) => t !== tier) : [...tiers, tier]);
  }

  function toggleIndustry(industry: string) {
    onIndustriesChange(
      industries.includes(industry)
        ? industries.filter((i) => i !== industry)
        : [...industries, industry],
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-white border-b border-zinc-200">
      {/* Sort control */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-zinc-500 mr-1">Sort:</span>
        {(['score', 'cltv', 'days'] as LeadQueueSort[]).map((s) => (
          <button
            key={s}
            onClick={() => onSortChange(s)}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              sort === s
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            {s === 'score' ? 'Score' : s === 'cltv' ? 'CLTV' : 'Days'}
          </button>
        ))}
      </div>

      {/* Tier filter */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-zinc-500 mr-1">Tier:</span>
        {allTiers.map((tier) => {
          const { bg, text } = TIER_COLORS[tier];
          const active = tiers.includes(tier);
          return (
            <button
              key={tier}
              onClick={() => toggleTier(tier)}
              className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                active ? `${bg} ${text} ring-1 ring-current` : 'bg-zinc-100 text-zinc-500'
              }`}
            >
              {tier}
            </button>
          );
        })}
      </div>

      {/* Industry filter */}
      {allIndustries.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-zinc-500 mr-1">Industry:</span>
          {allIndustries.slice(0, 5).map((ind) => (
            <button
              key={ind}
              onClick={() => toggleIndustry(ind)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                industries.includes(ind)
                  ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              }`}
            >
              {ind}
            </button>
          ))}
        </div>
      )}

      {/* Clear filters */}
      {(tiers.length > 0 || industries.length > 0) && (
        <button
          onClick={() => {
            onTiersChange([]);
            onIndustriesChange([]);
          }}
          className="px-2 py-1 rounded text-xs text-red-500 hover:bg-red-50 transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

type TabId = 'queue' | 'disqualified';

export function LeadQueuePage() {
  const [activeTab, setActiveTab] = useState<TabId>('queue');

  // Queue state
  const [leads, setLeads] = useState<QueueLead[]>([]);
  const [pendingKycCount, setPendingKycCount] = useState(0);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  // Disqualified state
  const [disqualified, setDisqualified] = useState<DisqualifiedLead[]>([]);
  const [loadingDisqualified, setLoadingDisqualified] = useState(false);
  const [disqualifiedError, setDisqualifiedError] = useState<string | null>(null);
  const [disqualifiedFetched, setDisqualifiedFetched] = useState(false);

  // Filter + sort state
  const [sort, setSort] = useState<LeadQueueSort>('score');
  const [tierFilter, setTierFilter] = useState<ScoreTier[]>([]);
  const [industryFilter, setIndustryFilter] = useState<string[]>([]);

  // Derive unique industries from loaded leads for the filter panel.
  const allIndustries = Array.from(
    new Set(leads.map((l) => l.industry).filter((i): i is string => Boolean(i))),
  ).sort();

  // Build the queue URL from current filters.
  const buildQueueUrl = useCallback(() => {
    const params = new URLSearchParams();
    params.set('sort', sort);
    if (tierFilter.length > 0) params.set('filter[tier]', tierFilter.join(','));
    if (industryFilter.length > 0) params.set('filter[industry]', industryFilter.join(','));
    return `/api/leads/queue?${params.toString()}`;
  }, [sort, tierFilter, industryFilter]);

  // Fetch the queue.
  const fetchQueue = useCallback(async () => {
    setLoadingQueue(true);
    setQueueError(null);
    try {
      const res = await fetch(buildQueueUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { leads: QueueLead[]; pending_kyc_count: number };
      setLeads(data.leads);
      setPendingKycCount(data.pending_kyc_count);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Failed to load lead queue');
    } finally {
      setLoadingQueue(false);
    }
  }, [buildQueueUrl]);

  // Fetch disqualified leads (lazy — only when the tab is first opened).
  const fetchDisqualified = useCallback(async () => {
    if (disqualifiedFetched) return;
    setLoadingDisqualified(true);
    setDisqualifiedError(null);
    try {
      const res = await fetch('/api/leads/disqualified');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { leads: DisqualifiedLead[] };
      setDisqualified(data.leads);
      setDisqualifiedFetched(true);
    } catch (err) {
      setDisqualifiedError(
        err instanceof Error ? err.message : 'Failed to load disqualified leads',
      );
    } finally {
      setLoadingDisqualified(false);
    }
  }, [disqualifiedFetched]);

  // Initial load and re-fetch when filters/sort change.
  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  // Lazy-load disqualified when the tab is opened.
  useEffect(() => {
    if (activeTab === 'disqualified') void fetchDisqualified();
  }, [activeTab, fetchDisqualified]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-200">
        <h1 className="text-xl font-bold text-zinc-900">Lead Queue</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Score-ranked qualified leads assigned to you</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-3 border-b border-zinc-200">
        {(['queue', 'disqualified'] as TabId[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              activeTab === tab
                ? 'bg-white border border-b-white border-zinc-200 text-indigo-700 -mb-px'
                : 'text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {tab === 'queue' ? `Queue (${leads.length})` : 'Disqualified'}
          </button>
        ))}
      </div>

      {/* Filter panel (queue tab only) */}
      {activeTab === 'queue' && (
        <FilterPanel
          sort={sort}
          onSortChange={setSort}
          tiers={tierFilter}
          onTiersChange={setTierFilter}
          industries={industryFilter}
          allIndustries={allIndustries}
          onIndustriesChange={setIndustryFilter}
        />
      )}

      {/* Column headers (queue tab only) */}
      {activeTab === 'queue' && leads.length > 0 && (
        <div className="flex items-center gap-4 px-4 py-2 bg-zinc-50 border-b border-zinc-200 text-xs font-medium text-zinc-500 uppercase tracking-wide">
          <div className="w-10 text-center shrink-0">Tier</div>
          <div className="flex-1">Company</div>
          <div className="w-32 text-right shrink-0">CLTV</div>
          <div className="w-24 text-center shrink-0">KYC</div>
          <div className="w-16 text-center shrink-0">Days</div>
          <div className="w-28 text-right shrink-0 hidden md:block">Rep</div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'queue' && (
          <>
            {loadingQueue && (
              <div className="flex justify-center items-center h-32">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
              </div>
            )}
            {!loadingQueue && queueError && (
              <div className="px-6 py-8 text-center text-red-500">{queueError}</div>
            )}
            {!loadingQueue && !queueError && leads.length === 0 && (
              <EmptyState pendingKycCount={pendingKycCount} />
            )}
            {!loadingQueue && !queueError && leads.length > 0 && <VirtualLeadList leads={leads} />}
          </>
        )}

        {activeTab === 'disqualified' && (
          <>
            {loadingDisqualified && (
              <div className="flex justify-center items-center h-32">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
              </div>
            )}
            {!loadingDisqualified && disqualifiedError && (
              <div className="px-6 py-8 text-center text-red-500">{disqualifiedError}</div>
            )}
            {!loadingDisqualified && !disqualifiedError && disqualified.length === 0 && (
              <div className="px-6 py-12 text-center text-zinc-400 text-sm">
                No disqualified leads.
              </div>
            )}
            {!loadingDisqualified && !disqualifiedError && disqualified.length > 0 && (
              <div className="overflow-y-auto h-full">
                {/* Column header */}
                <div className="flex items-center gap-4 px-4 py-2 bg-zinc-50 border-b border-zinc-200 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  <div className="flex-1">Company</div>
                  <div className="flex-1">Reason</div>
                  <div className="w-28 text-right shrink-0">Disqualified</div>
                </div>
                {disqualified.map((lead) => (
                  <DisqualifiedRow key={lead.id} lead={lead} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
