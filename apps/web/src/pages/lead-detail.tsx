/**
 * @file lead-detail.tsx
 *
 * Phase 1 Sales Rep UX — Lead detail view (issue #9).
 *
 * Answers "should I call this person right now and what do I say?" without
 * requiring the rep to hunt for information.
 *
 * Layout (top → bottom):
 *   1. Score rationale panel — composite gauge + three sub-score bars — above the fold
 *   2. KYC summary panel
 *   3. CLTV estimate panel with macro stress toggle
 *   4. Activity timeline
 *   5. Pipeline stage selector — pinned to viewport bottom
 *      → Stage change opens a required-note modal
 *   6. Quick action buttons (log call, send email, schedule follow-up) — inline forms
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/9
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Phone, Mail, Calendar, RefreshCw, ChevronDown } from 'lucide-react';
import { ScoreTooltip, type ScoreDetailContent } from '../components/ScoreTooltip';

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirroring server LeadDetailResponse)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProspectDetail {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  stage: string;
  assigned_rep_id: string | null;
  kyc_status: string;
  disqualification_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CltvScoreDetail {
  id: string;
  composite_score: number;
  tier: string;
  macro_score: number | null;
  industry_score: number | null;
  company_score: number | null;
  rationale_macro: string | null;
  rationale_industry: string | null;
  rationale_company: string | null;
  score_version: string;
  computed_at: string;
  macro_inputs_snapshot: MacroInputsSnapshot | null;
  industry_inputs_snapshot: unknown;
  company_inputs_snapshot: unknown;
}

export interface MacroInputsSnapshot {
  interest_rate: number | null;
  gdp_growth_rate: number | null;
  inflation_rate: number | null;
}

export interface KycRecordDetail {
  id: string;
  verification_status: string;
  funding_stage: string | null;
  annual_revenue_est: number | null;
  debt_load_est: number | null;
  checked_at: string | null;
}

export interface DealDetail {
  id: string;
  stage: string;
  value: number | null;
  currency: string;
  close_date: string | null;
  owner_rep_id: string | null;
}

export interface ActivityEntry {
  id: string;
  activity_type: string;
  actor_id: string | null;
  note: string | null;
  metadata: unknown;
  occurred_at: string;
}

export interface LeadDetailData {
  prospect: ProspectDetail;
  cltv_score: CltvScoreDetail | null;
  kyc_record: KycRecordDetail | null;
  deal: DealDetail | null;
  timeline: ActivityEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEAL_STAGES = ['contacted', 'qualified', 'proposal', 'closed_won', 'closed_lost'] as const;
type DealStage = (typeof DEAL_STAGES)[number];

const STAGE_LABELS: Record<DealStage, string> = {
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
};

/**
 * The macro stress delta applied to CLTV low/mid/high when the stress toggle
 * is on.  Applied client-side — no server round-trip required.
 */
const MACRO_STRESS_DELTA = -0.1;

/** Formats a dollar amount with thousands separators. */
function formatCurrency(value: number | null, currency = 'USD'): string {
  if (value === null) return 'N/A';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(value)
    .replace(/\.00$/, '');
}

/** Computes the CLTV low/mid/high 3-year estimate from a composite score. */
function computeCltvRange(
  compositeScore: number,
  stressMode: boolean,
): { low: number; mid: number; high: number } {
  const delta = stressMode ? MACRO_STRESS_DELTA : 0;
  const adjusted = Math.max(0, Math.min(100, compositeScore + delta * 100));
  const base = (adjusted / 100) * 500_000;
  return {
    low: Math.round(base * 0.7),
    mid: Math.round(base),
    high: Math.round(base * 1.4),
  };
}

/** Percentage (0–100) for a sub-score in [0, 1]. */
function subScorePct(score: number | null): number {
  if (score === null) return 50;
  return Math.round(score * 100);
}

/** Colour class for a sub-score bar. */
function scoreColor(pct: number): string {
  if (pct >= 70) return 'bg-emerald-500';
  if (pct >= 45) return 'bg-amber-400';
  return 'bg-red-400';
}

/** Tier badge colour. */
function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'A':
      return 'bg-emerald-100 text-emerald-800';
    case 'B':
      return 'bg-sky-100 text-sky-800';
    case 'C':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-zinc-100 text-zinc-700';
  }
}

/** Human-readable tier label. */
function tierLabel(tier: string): string {
  switch (tier) {
    case 'A':
      return 'Excellent';
    case 'B':
      return 'Good';
    case 'C':
      return 'Fair';
    case 'D':
      return 'Poor';
    default:
      return tier;
  }
}

/** Formats an ISO timestamp as a short locale date string. */
function shortDate(iso: string | null): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Activity type display label. */
function activityLabel(type: string): string {
  switch (type) {
    case 'stage_change':
      return 'Stage change';
    case 'note':
      return 'Note';
    case 'kyc_event':
      return 'KYC event';
    case 'score_update':
      return 'Score updated';
    case 'call':
      return 'Call logged';
    case 'email':
      return 'Email sent';
    case 'follow_up':
      return 'Follow-up scheduled';
    default:
      return type;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Score tooltip content helpers
// ─────────────────────────────────────────────────────────────────────────────

const TIER_SUMMARY_MAP: Record<string, string> = {
  A: 'Tier A leads have the highest composite CLTV score (≥ 80) and represent your strongest near-term revenue opportunities.',
  B: 'Tier B leads have a good composite CLTV score (60–79) and are solid opportunities worth active pursuit.',
  C: 'Tier C leads have a fair composite CLTV score (40–59) and may require more qualification before significant investment.',
  D: 'Tier D leads have a low composite CLTV score (< 40) and are unlikely to convert without significant effort.',
};

const TIER_FORMULA = 'composite = macro × 0.30 + industry × 0.30 + company × 0.40';

function buildTierDetailContent(score: CltvScoreDetail): ScoreDetailContent {
  return {
    formula: TIER_FORMULA,
    inputs: {
      macro_score: score.macro_score,
      industry_score: score.industry_score,
      company_score: score.company_score,
      composite_score: score.composite_score / 100,
    },
  };
}

function buildMacroDetailContent(score: CltvScoreDetail): ScoreDetailContent | undefined {
  const snap = score.macro_inputs_snapshot;
  if (!snap) return undefined;
  return {
    formula: 'macro = avg(norm(interest_rate), norm(gdp_growth_rate), norm(inflation_rate))',
    inputs: {
      interest_rate: snap.interest_rate,
      gdp_growth_rate: snap.gdp_growth_rate,
      inflation_rate: snap.inflation_rate,
    },
  };
}

function buildIndustryDetailContent(score: CltvScoreDetail): ScoreDetailContent | undefined {
  const snap = score.industry_inputs_snapshot;
  if (!snap || typeof snap !== 'object') return undefined;
  return {
    formula: 'industry = avg(norm(growth_rate), 1 - norm(default_rate), norm(payment_speed))',
    inputs: snap as Record<string, number | string | null>,
  };
}

function buildCompanyDetailContent(score: CltvScoreDetail): ScoreDetailContent | undefined {
  const snap = score.company_inputs_snapshot;
  if (!snap || typeof snap !== 'object') return undefined;
  return {
    formula: 'company = avg(liquidity, revenue_stability, debt_load_penalty)',
    inputs: snap as Record<string, number | string | null>,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score rationale panel
// ─────────────────────────────────────────────────────────────────────────────

function ScoreRationalePanel({ score }: { score: CltvScoreDetail }) {
  const compositePct = Math.round(score.composite_score);
  const macroPct = subScorePct(score.macro_score);
  const industryPct = subScorePct(score.industry_score);
  const companyPct = subScorePct(score.company_score);

  return (
    <section className="border border-zinc-200 rounded-xl p-5 bg-white space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">Score Rationale</h3>
        <span className="inline-flex items-center gap-1">
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-full ${tierBadgeClass(score.tier)}`}
            data-testid="detail-tier-badge"
          >
            Tier {score.tier} — {tierLabel(score.tier)}
          </span>
          <ScoreTooltip
            summary_text={
              TIER_SUMMARY_MAP[score.tier] ?? `Tier ${score.tier} composite CLTV score.`
            }
            detail_content={buildTierDetailContent(score)}
            aria_label={`Tier ${score.tier} score explanation`}
          />
        </span>
      </div>

      {/* Composite gauge */}
      <div className="flex items-center gap-4">
        <div className="relative flex items-center justify-center w-20 h-20 rounded-full bg-zinc-50 border-4 border-zinc-200 shrink-0">
          <span className="text-xl font-black text-zinc-900">{compositePct}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-zinc-500 mb-1">Composite score (0–100)</p>
          <div className="h-3 rounded-full bg-zinc-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${scoreColor(compositePct)}`}
              style={{ width: `${compositePct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Sub-score bars */}
      <div className="space-y-3">
        <SubScoreBar
          label="Macro health"
          pct={macroPct}
          rationale={score.rationale_macro}
          summary="The macro health score reflects the current interest rate, GDP growth, and inflation environment — higher is better for CLTV."
          detail_content={buildMacroDetailContent(score)}
        />
        <SubScoreBar
          label="Industry signal"
          pct={industryPct}
          rationale={score.rationale_industry}
          summary="The industry signal score is based on your prospect's sector growth rate, historical default rates, and typical payment speed."
          detail_content={buildIndustryDetailContent(score)}
        />
        <SubScoreBar
          label="Company signal"
          pct={companyPct}
          rationale={score.rationale_company}
          summary="The company signal score reflects the prospect's liquidity, revenue stability, and debt load — drawn from KYC and public filings."
          detail_content={buildCompanyDetailContent(score)}
        />
      </div>

      {/* Metadata footer */}
      <div className="flex items-center justify-between text-xs text-zinc-400 pt-1 border-t border-zinc-100">
        <span>Computed {shortDate(score.computed_at)}</span>
        <span className="font-mono">v{score.score_version}</span>
      </div>
    </section>
  );
}

function SubScoreBar({
  label,
  pct,
  rationale,
  summary,
  detail_content,
}: {
  label: string;
  pct: number;
  rationale: string | null;
  summary?: string;
  detail_content?: ScoreDetailContent;
}) {
  return (
    <div data-testid="sub-score-bar">
      <div className="flex items-center justify-between mb-1">
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-zinc-700">
          {label}
          {summary && (
            <ScoreTooltip
              summary_text={summary}
              detail_content={detail_content}
              aria_label={`${label} score explanation`}
            />
          )}
        </span>
        <span className="text-xs font-semibold text-zinc-900">{pct}</span>
      </div>
      <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
        <div className={`h-full rounded-full ${scoreColor(pct)}`} style={{ width: `${pct}%` }} />
      </div>
      {rationale && <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{rationale}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KYC summary panel
// ─────────────────────────────────────────────────────────────────────────────

function KycSummaryPanel({
  kyc,
  prospect,
  onRetrigger,
}: {
  kyc: KycRecordDetail | null;
  prospect: ProspectDetail;
  onRetrigger: () => void;
}) {
  const isManualReview = prospect.kyc_status === 'kyc_manual_review';

  return (
    <section className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
      <h3 className="text-sm font-semibold text-zinc-900">KYC Summary</h3>

      {kyc ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <KycField label="Status" value={kyc.verification_status} />
          <KycField label="Checked" value={shortDate(kyc.checked_at)} />
          <KycField label="Funding stage" value={kyc.funding_stage ?? 'N/A'} />
          <KycField label="Revenue est." value={formatCurrency(kyc.annual_revenue_est)} />
          <KycField label="Debt est." value={formatCurrency(kyc.debt_load_est)} />
        </dl>
      ) : (
        <p className="text-sm text-zinc-400">No KYC record available.</p>
      )}

      {isManualReview && (
        <button
          type="button"
          onClick={onRetrigger}
          className="flex items-center gap-2 text-xs font-medium text-indigo-600 hover:text-indigo-700 mt-1"
        >
          <RefreshCw size={12} />
          Re-trigger KYC review
        </button>
      )}
    </section>
  );
}

function KycField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-medium text-zinc-900">{value}</dd>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLTV estimate panel
// ─────────────────────────────────────────────────────────────────────────────

function CltvEstimatePanel({
  score,
  stressMode,
  onToggleStress,
}: {
  score: CltvScoreDetail | null;
  stressMode: boolean;
  onToggleStress: () => void;
}) {
  if (!score) {
    return (
      <section className="border border-zinc-200 rounded-xl p-5 bg-white">
        <h3 className="text-sm font-semibold text-zinc-900 mb-2">CLTV Estimate</h3>
        <p className="text-sm text-zinc-400">No score available.</p>
      </section>
    );
  }

  const range = computeCltvRange(score.composite_score, stressMode);

  return (
    <section className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="inline-flex items-center gap-1 text-sm font-semibold text-zinc-900">
          CLTV Estimate (3-year)
          <ScoreTooltip
            summary_text="This 3-year customer lifetime value estimate is a forward projection derived from the composite CLTV score — the range reflects model uncertainty at the low, mid, and high confidence bounds."
            aria_label="CLTV estimate explanation"
          />
        </h3>
        <button
          type="button"
          onClick={onToggleStress}
          className={`text-xs font-medium px-2 py-0.5 rounded-full border transition-colors ${
            stressMode
              ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-zinc-50 text-zinc-600 border-zinc-200 hover:bg-zinc-100'
          }`}
        >
          {stressMode ? 'Macro stress ON' : 'Macro stress OFF'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg bg-zinc-50 border border-zinc-100 p-3">
          <p className="text-xs text-zinc-400 mb-1">Low</p>
          <p className="text-sm font-semibold text-zinc-900">{formatCurrency(range.low)}</p>
        </div>
        <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3">
          <p className="text-xs text-indigo-500 mb-1">Mid</p>
          <p className="text-sm font-semibold text-indigo-900">{formatCurrency(range.mid)}</p>
        </div>
        <div className="rounded-lg bg-zinc-50 border border-zinc-100 p-3">
          <p className="text-xs text-zinc-400 mb-1">High</p>
          <p className="text-sm font-semibold text-zinc-900">{formatCurrency(range.high)}</p>
        </div>
      </div>

      {stressMode && (
        <p className="text-xs text-amber-600">
          Stress scenario applies a −10% macro adjustment to the composite score.
        </p>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity timeline
// ─────────────────────────────────────────────────────────────────────────────

function ActivityTimeline({ entries }: { entries: ActivityEntry[] }) {
  return (
    <section className="border border-zinc-200 rounded-xl p-5 bg-white space-y-2">
      <h3 className="text-sm font-semibold text-zinc-900 mb-3">Activity Timeline</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-400">No activity recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 text-sm">
              <div className="flex-shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-indigo-400 mt-2" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-zinc-800">
                    {activityLabel(entry.activity_type)}
                  </span>
                  <span className="text-xs text-zinc-400 shrink-0">
                    {shortDate(entry.occurred_at)}
                  </span>
                </div>
                {entry.note && <p className="text-zinc-600 mt-0.5 leading-relaxed">{entry.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage change modal
// ─────────────────────────────────────────────────────────────────────────────

interface StageChangeModalProps {
  currentStage: string;
  targetStage: DealStage;
  onConfirm: (note: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
}

function StageChangeModal({
  currentStage,
  targetStage,
  onConfirm,
  onCancel,
  error,
}: StageChangeModalProps) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (note.trim().length < 3) return;
    setSubmitting(true);
    await onConfirm(note.trim());
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-base font-semibold text-zinc-900">Change stage</h2>
        <p className="text-sm text-zinc-500">
          Moving from{' '}
          <span className="font-medium text-zinc-800">
            {STAGE_LABELS[currentStage as DealStage] ?? currentStage}
          </span>{' '}
          to <span className="font-medium text-zinc-800">{STAGE_LABELS[targetStage]}</span>.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="stage-note" className="block text-xs font-medium text-zinc-700 mb-1">
              Note <span className="text-red-500">*</span>
            </label>
            <textarea
              id="stage-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Add a note explaining this stage change…"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              required
              minLength={3}
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 rounded-lg border border-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || note.trim().length < 3}
              className="px-4 py-2 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick action bar
// ─────────────────────────────────────────────────────────────────────────────

type QuickActionType = 'call' | 'email' | 'follow_up';

interface QuickActionFormProps {
  prospectId: string;
  actionType: QuickActionType;
  onLogged: () => void;
  onCancel: () => void;
}

function QuickActionForm({ prospectId, actionType, onLogged, onCancel }: QuickActionFormProps) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labelMap: Record<QuickActionType, string> = {
    call: 'Log call',
    email: 'Send email',
    follow_up: 'Schedule follow-up',
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${prospectId}/activities`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: actionType, note: note.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? 'Failed to log activity');
        setSubmitting(false);
        return;
      }
      onLogged();
    } catch {
      setError('Network error');
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-zinc-200 rounded-xl p-4 bg-white space-y-3"
    >
      <h4 className="text-sm font-medium text-zinc-800">{labelMap[actionType]}</h4>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Optional note…"
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 rounded-lg border border-zinc-200"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stage selector (pinned bottom)
// ─────────────────────────────────────────────────────────────────────────────

function PipelineStageBar({
  currentStage,
  onSelectStage,
}: {
  currentStage: string;
  onSelectStage: (stage: DealStage) => void;
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-zinc-200 px-4 py-3 z-40">
      <div className="flex items-center gap-2 max-w-3xl mx-auto overflow-x-auto">
        <span className="text-xs font-medium text-zinc-500 shrink-0 mr-1">Pipeline:</span>
        {DEAL_STAGES.map((stage) => (
          <button
            key={stage}
            type="button"
            onClick={() => onSelectStage(stage)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              currentStage === stage
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {STAGE_LABELS[stage]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main LeadDetailPage component
// ─────────────────────────────────────────────────────────────────────────────

interface LeadDetailPageProps {
  prospectId: string;
  onBack?: () => void;
}

export function LeadDetailPage({ prospectId, onBack }: LeadDetailPageProps) {
  const [data, setData] = useState<LeadDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stressMode, setStressMode] = useState(false);
  const [stageModal, setStageModal] = useState<DealStage | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [activeQuickAction, setActiveQuickAction] = useState<QuickActionType | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${prospectId}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as LeadDetailData;
      setData(json);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [prospectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStageSelect = useCallback((stage: DealStage) => {
    setStageError(null);
    setStageModal(stage);
  }, []);

  const handleStageConfirm = useCallback(
    async (note: string) => {
      if (!stageModal) return;
      setStageError(null);
      const res = await fetch(`/api/leads/${prospectId}/stage`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: stageModal, note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStageError((body as { error?: string }).error ?? 'Failed to update stage');
        return;
      }
      setStageModal(null);
      await load();
    },
    [stageModal, prospectId, load],
  );

  const handleQuickActionLogged = useCallback(async () => {
    setActiveQuickAction(null);
    await load();
  }, [load]);

  const handleRetriggerKyc = useCallback(() => {
    // Placeholder: in a future phase this would POST to a KYC re-trigger endpoint.
    alert('KYC re-trigger is not yet wired to a backend endpoint in this phase.');
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 max-w-2xl">
        <p className="text-sm text-red-600">{error ?? 'No data'}</p>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mt-4 text-sm text-indigo-600 hover:underline"
          >
            &larr; Back to queue
          </button>
        )}
      </div>
    );
  }

  const { prospect, cltv_score, kyc_record, deal, timeline } = data;
  const currentDealStage = deal?.stage ?? 'contacted';

  return (
    <div className="relative h-full">
      {/* Scrollable main area, padded at bottom for the pinned stage bar */}
      <div className="overflow-y-auto h-full pb-20 px-4 md:px-8 py-6 max-w-2xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="text-xs text-zinc-500 hover:text-indigo-600 mb-2 flex items-center gap-1"
              >
                &larr; Queue
              </button>
            )}
            <h1 className="text-xl font-bold text-zinc-900">{prospect.company_name}</h1>
            <p className="text-sm text-zinc-500 mt-0.5">
              {prospect.industry ?? 'Unknown industry'}
              {prospect.sic_code ? ` · SIC ${prospect.sic_code}` : ''}
            </p>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <span className="text-xs font-medium text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded-full">
              {prospect.stage}
            </span>
          </div>
        </div>

        {/* Score rationale — must be above the fold on 1280x800 */}
        {cltv_score ? (
          <ScoreRationalePanel score={cltv_score} />
        ) : (
          <section className="border border-zinc-200 rounded-xl p-5 bg-white">
            <h3 className="text-sm font-semibold text-zinc-900 mb-2">Score Rationale</h3>
            <p className="text-sm text-zinc-400">No score available yet.</p>
          </section>
        )}

        {/* KYC summary */}
        <KycSummaryPanel kyc={kyc_record} prospect={prospect} onRetrigger={handleRetriggerKyc} />

        {/* CLTV estimate */}
        <CltvEstimatePanel
          score={cltv_score}
          stressMode={stressMode}
          onToggleStress={() => setStressMode((s) => !s)}
        />

        {/* Quick action buttons */}
        {activeQuickAction ? (
          <QuickActionForm
            prospectId={prospectId}
            actionType={activeQuickAction}
            onLogged={handleQuickActionLogged}
            onCancel={() => setActiveQuickAction(null)}
          />
        ) : (
          <div className="flex gap-2">
            <QuickActionButton
              icon={<Phone size={14} />}
              label="Log call"
              onClick={() => setActiveQuickAction('call')}
            />
            <QuickActionButton
              icon={<Mail size={14} />}
              label="Send email"
              onClick={() => setActiveQuickAction('email')}
            />
            <QuickActionButton
              icon={<Calendar size={14} />}
              label="Follow-up"
              onClick={() => setActiveQuickAction('follow_up')}
            />
          </div>
        )}

        {/* Activity timeline */}
        <ActivityTimeline entries={timeline} />
      </div>

      {/* Pinned pipeline stage selector */}
      <PipelineStageBar currentStage={currentDealStage} onSelectStage={handleStageSelect} />

      {/* Stage change modal */}
      {stageModal && (
        <StageChangeModal
          currentStage={currentDealStage}
          targetStage={stageModal}
          onConfirm={handleStageConfirm}
          onCancel={() => {
            setStageModal(null);
            setStageError(null);
          }}
          error={stageError}
        />
      )}
    </div>
  );
}

function QuickActionButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead queue list (simple list to navigate to detail view)
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueLead {
  id: string;
  company_name: string;
  industry: string | null;
  stage: string;
  composite_score: number | null;
  tier: string | null;
}

export function LeadQueuePage({ onSelectLead }: { onSelectLead: (id: string) => void }) {
  const [leads, setLeads] = useState<QueueLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/leads', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { leads: QueueLead[] };
        setLeads(data.leads);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error) {
    return <p className="p-8 text-sm text-red-600">{error}</p>;
  }

  if (leads.length === 0) {
    return (
      <div className="p-8">
        <p className="text-sm text-zinc-500">No leads assigned to you yet.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-2">
      <h2 className="text-base font-semibold text-zinc-900 mb-4">Your lead queue</h2>
      {leads.map((lead) => (
        <button
          key={lead.id}
          type="button"
          onClick={() => onSelectLead(lead.id)}
          className="w-full text-left border border-zinc-200 rounded-xl p-4 bg-white hover:bg-zinc-50 transition-colors group"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900 truncate">{lead.company_name}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {lead.industry ?? 'Unknown industry'} · {lead.stage}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {lead.tier && (
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded-full ${tierBadgeClass(lead.tier)}`}
                >
                  {lead.tier}
                </span>
              )}
              {lead.composite_score !== null && (
                <span className="text-sm font-bold text-zinc-700">
                  {Math.round(lead.composite_score)}
                </span>
              )}
              <ChevronDown
                size={14}
                className="text-zinc-300 -rotate-90 group-hover:text-zinc-500 transition-colors"
              />
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
