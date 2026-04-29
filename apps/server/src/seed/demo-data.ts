/**
 * @file seed/demo-data
 * Idempotent seeding of rich demo revenue-lifecycle data for DEMO_MODE deployments.
 *
 * Populates all revenue-lifecycle tables with obviously fictional data that
 * covers every persona view, every score tier, and every lifecycle edge case:
 *
 *   - 50+ rl_prospects spanning all 6 stages and all 4 CLTV tiers (A/B/C/D)
 *   - rl_kyc_records for each prospect
 *   - rl_cltv_scores for all tiers (macro/industry/company components + rationale)
 *   - 20+ rl_customers with health_score spread (healthy, at-risk, churned)
 *   - rl_deals in all 5 pipeline stages (contacted/qualified/proposal/closed_won/closed_lost),
 *     each linked to a prospect with a CLTV score (tier A/B/C/D) and rationale text
 *   - 40+ rl_invoices spanning all invoice_status values with aging buckets
 *   - rl_dunning_actions: D+1/D+7/D+14/D+30 sequences with realistic sent_at timestamps
 *   - rl_collection_cases in all statuses, each with 3+ rl_contact_logs
 *   - rl_payment_plans in all statuses (current, breached, completed, cancelled)
 *   - rl_write_off_approvals: pending, approved, rejected
 *   - rl_interventions: resolved (5), in_progress (2), open (1)
 *   - rl_customer_health_scores: 4 open alerts at 1/3/7/14 days
 *   - rl_notifications (new_lead + score_drop) for demo sales rep — mix of read/unread
 *   - rl_macro_indicators for 8 quarters
 *   - rl_industry_benchmarks for all seeded SIC codes
 *   - KYC manual review: 3 prospects with distinct failure reasons
 *
 * All rows use deterministic IDs derived from a stable namespace via a simple
 * string-keyed map so ON CONFLICT DO NOTHING ensures idempotency on re-runs.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/46
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/58
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/76
 */

import type { sql as SqlPool } from 'db';
import { log } from 'core';
import { isDemoMode } from '../api/demo-session';

export interface SeedDemoDataOptions {
  /** postgres.js connection pool to the app database */
  sql: typeof SqlPool;
}

// ---------------------------------------------------------------------------
// Deterministic ID helpers
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic UUID-format ID for a given string key.
 * We store all IDs in a registry so re-runs produce the same values.
 */
const ID_REGISTRY = new Map<string, string>();

function demoId(key: string): string {
  const cached = ID_REGISTRY.get(key);
  if (cached) return cached;

  // Build a v4-format UUID from a hash of the key. We use a simple but
  // stable XOR-fold so we do not depend on any external UUID library.
  // The resulting string satisfies the TEXT PRIMARY KEY column — the schema
  // uses TEXT, not UUID, for all rl_* tables.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  const id = `demo-${key.replace(/[^a-z0-9]/g, '-').slice(0, 20)}-${hex}`;
  ID_REGISTRY.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------
// Fixture tables
// ---------------------------------------------------------------------------

interface ProspectRow {
  id: string;
  company_name: string;
  industry: string;
  sic_code: string;
  stage: 'new' | 'kyc_pending' | 'kyc_manual_review' | 'scored' | 'qualified' | 'disqualified';
  disqualification_reason?: 'score_below_threshold' | 'kyc_not_verified' | 'kyc_manual_review';
  disqualified_at?: string | null;
  company_segment?: 'SMB' | 'Mid-Market' | 'Enterprise';
}

interface CustomerRow {
  id: string;
  prospect_id?: string;
  company_name: string;
  segment?: string;
  health_score: number;
}

// ---------------------------------------------------------------------------
// Prospect data — 55 obviously fictional companies
// ---------------------------------------------------------------------------

const PROSPECTS: ProspectRow[] = [
  // ---- Stage: new (5) ----
  {
    id: demoId('p-new-1'),
    company_name: 'Frobnicorp Ltd',
    industry: 'Software',
    sic_code: '7372',
    stage: 'new',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-new-2'),
    company_name: 'Widgets Unlimited',
    industry: 'Manufacturing',
    sic_code: '3490',
    stage: 'new',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-new-3'),
    company_name: 'Thingamajig Co',
    industry: 'Retail',
    sic_code: '5999',
    stage: 'new',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-new-4'),
    company_name: 'Doohickey Systems',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'new',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-new-5'),
    company_name: 'Whatsit Ventures',
    industry: 'Finance',
    sic_code: '6199',
    stage: 'new',
    company_segment: 'Mid-Market',
  },

  // ---- Stage: kyc_pending (8) ----
  {
    id: demoId('p-kycp-1'),
    company_name: 'Gizmotech Inc',
    industry: 'Software',
    sic_code: '7372',
    stage: 'kyc_pending',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-kycp-2'),
    company_name: 'Acmecorp PLC',
    industry: 'Logistics',
    sic_code: '4731',
    stage: 'kyc_pending',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-kycp-3'),
    company_name: 'Blamco Industries',
    industry: 'Food',
    sic_code: '2099',
    stage: 'kyc_pending',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-kycp-4'),
    company_name: 'Vandelay Exports',
    industry: 'Wholesale',
    sic_code: '5040',
    stage: 'kyc_pending',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-kycp-5'),
    company_name: 'Initech Solutions',
    industry: 'Software',
    sic_code: '7372',
    stage: 'kyc_pending',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-kycp-6'),
    company_name: 'Umbrella Analytics',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'kyc_pending',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-kycp-7'),
    company_name: 'Prestige Worldwide',
    industry: 'Media',
    sic_code: '7812',
    stage: 'kyc_pending',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-kycp-8'),
    company_name: 'Globex Trading',
    industry: 'Finance',
    sic_code: '6199',
    stage: 'kyc_pending',
    company_segment: 'Mid-Market',
  },

  // ---- Stage: kyc_manual_review (5) ----
  {
    id: demoId('p-kycm-1'),
    company_name: 'Wolfram Holdings',
    industry: 'Finance',
    sic_code: '6199',
    stage: 'kyc_manual_review',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-kycm-2'),
    company_name: 'Rekall Robotics',
    industry: 'Manufacturing',
    sic_code: '3490',
    stage: 'kyc_manual_review',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-kycm-3'),
    company_name: 'Omni Consumer Products',
    industry: 'Retail',
    sic_code: '5999',
    stage: 'kyc_manual_review',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-kycm-4'),
    company_name: 'Weyland Corp',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'kyc_manual_review',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-kycm-5'),
    company_name: 'Soylent Dynamics',
    industry: 'Food',
    sic_code: '2099',
    stage: 'kyc_manual_review',
    company_segment: 'SMB',
  },

  // ---- Stage: scored (12) — mix of tiers ----
  {
    id: demoId('p-scored-1'),
    company_name: 'Nakatomi Corp',
    industry: 'Real Estate',
    sic_code: '6512',
    stage: 'scored',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-scored-2'),
    company_name: 'Duff Industries',
    industry: 'Manufacturing',
    sic_code: '3490',
    stage: 'scored',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-scored-3'),
    company_name: 'Springfield Nuclear',
    industry: 'Utilities',
    sic_code: '4911',
    stage: 'scored',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-scored-4'),
    company_name: 'Kwik-E-Mart Retail',
    industry: 'Retail',
    sic_code: '5999',
    stage: 'scored',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-scored-5'),
    company_name: "Moe's Tavern Supply",
    industry: 'Wholesale',
    sic_code: '5040',
    stage: 'scored',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-scored-6'),
    company_name: 'Burns Energy Group',
    industry: 'Utilities',
    sic_code: '4911',
    stage: 'scored',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-scored-7'),
    company_name: 'Krusty Krab Media',
    industry: 'Media',
    sic_code: '7812',
    stage: 'scored',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-scored-8'),
    company_name: 'Stark Robotics',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'scored',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-scored-9'),
    company_name: 'Oscorp Pharma',
    industry: 'Pharma',
    sic_code: '2836',
    stage: 'scored',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-scored-10'),
    company_name: 'Luthor Labs',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'scored',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-scored-11'),
    company_name: 'Daily Bugle Publishing',
    industry: 'Media',
    sic_code: '2711',
    stage: 'scored',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-scored-12'),
    company_name: 'Wayne Enterprises',
    industry: 'Conglomerate',
    sic_code: '6719',
    stage: 'scored',
    company_segment: 'Enterprise',
  },

  // ---- Stage: qualified (15) — mix of tiers ----
  {
    id: demoId('p-qual-1'),
    company_name: 'Veridian Dynamics',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'qualified',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-qual-2'),
    company_name: 'Awesome Pants Corp',
    industry: 'Retail',
    sic_code: '5699',
    stage: 'qualified',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-qual-3'),
    company_name: 'Bluth Company',
    industry: 'Real Estate',
    sic_code: '6512',
    stage: 'qualified',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-qual-4'),
    company_name: 'Meeseeks Solutions',
    industry: 'Consulting',
    sic_code: '7389',
    stage: 'qualified',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-qual-5'),
    company_name: 'Megacorp Industries',
    industry: 'Manufacturing',
    sic_code: '3490',
    stage: 'qualified',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-qual-6'),
    company_name: 'Dunder Mifflin Paper',
    industry: 'Wholesale',
    sic_code: '5112',
    stage: 'qualified',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-qual-7'),
    company_name: 'Pawnee Harvest Foods',
    industry: 'Food',
    sic_code: '2099',
    stage: 'qualified',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-qual-8'),
    company_name: 'Sabre Tech',
    industry: 'Technology',
    sic_code: '7372',
    stage: 'qualified',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-qual-9'),
    company_name: 'Flynt Industries',
    industry: 'Manufacturing',
    sic_code: '3490',
    stage: 'qualified',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-qual-10'),
    company_name: 'Beneke Fabricators',
    industry: 'Manufacturing',
    sic_code: '3490',
    stage: 'qualified',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-qual-11'),
    company_name: 'Los Pollos Logistics',
    industry: 'Logistics',
    sic_code: '4731',
    stage: 'qualified',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-qual-12'),
    company_name: 'Sterling Archer Labs',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'qualified',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-qual-13'),
    company_name: 'Pied Piper Data',
    industry: 'Software',
    sic_code: '7372',
    stage: 'qualified',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-qual-14'),
    company_name: 'Hooli Cloud',
    industry: 'Software',
    sic_code: '7372',
    stage: 'qualified',
    company_segment: 'Enterprise',
  },
  {
    id: demoId('p-qual-15'),
    company_name: 'Aviato Aviation',
    industry: 'Transport',
    sic_code: '4512',
    stage: 'qualified',
    company_segment: 'Mid-Market',
  },

  // ---- Stage: disqualified (10) ----
  {
    id: demoId('p-disq-1'),
    company_name: 'Dodgy Finance LLC',
    industry: 'Finance',
    sic_code: '6199',
    stage: 'disqualified',
    disqualification_reason: 'score_below_threshold',
    disqualified_at: '2025-01-10T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-2'),
    company_name: 'Scam Corp',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'disqualified',
    disqualification_reason: 'kyc_not_verified',
    disqualified_at: '2025-01-15T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-3'),
    company_name: 'Shell Games Inc',
    industry: 'Finance',
    sic_code: '6199',
    stage: 'disqualified',
    disqualification_reason: 'score_below_threshold',
    disqualified_at: '2025-02-01T12:00:00Z',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-disq-4'),
    company_name: 'Ponzi Partners',
    industry: 'Finance',
    sic_code: '6199',
    stage: 'disqualified',
    disqualification_reason: 'kyc_manual_review',
    disqualified_at: '2025-02-14T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-5'),
    company_name: 'Fly-by-Night Couriers',
    industry: 'Logistics',
    sic_code: '4731',
    stage: 'disqualified',
    disqualification_reason: 'score_below_threshold',
    disqualified_at: '2025-02-20T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-6'),
    company_name: 'Shady Dealings Corp',
    industry: 'Wholesale',
    sic_code: '5040',
    stage: 'disqualified',
    disqualification_reason: 'kyc_not_verified',
    disqualified_at: '2025-03-01T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-7'),
    company_name: 'Ghost Ventures',
    industry: 'Technology',
    sic_code: '7372',
    stage: 'disqualified',
    disqualification_reason: 'score_below_threshold',
    disqualified_at: '2025-03-10T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-8'),
    company_name: 'Mirage Holdings',
    industry: 'Real Estate',
    sic_code: '6512',
    stage: 'disqualified',
    disqualification_reason: 'kyc_manual_review',
    disqualified_at: '2025-03-15T12:00:00Z',
    company_segment: 'Mid-Market',
  },
  {
    id: demoId('p-disq-9'),
    company_name: 'No-Show Systems',
    industry: 'Software',
    sic_code: '7371',
    stage: 'disqualified',
    disqualification_reason: 'score_below_threshold',
    disqualified_at: '2025-03-22T12:00:00Z',
    company_segment: 'SMB',
  },
  {
    id: demoId('p-disq-10'),
    company_name: 'Vapor Solutions',
    industry: 'Technology',
    sic_code: '7371',
    stage: 'disqualified',
    disqualification_reason: 'kyc_not_verified',
    disqualified_at: '2025-04-01T12:00:00Z',
    company_segment: 'SMB',
  },
];

// ---------------------------------------------------------------------------
// CLTV score assignments — each tier gets multiple prospects
// ---------------------------------------------------------------------------

interface CltvAssignment {
  prospect_key: string;
  tier: 'A' | 'B' | 'C' | 'D';
  composite_score: number;
  macro_score: number;
  industry_score: number;
  company_score: number;
}

const CLTV_ASSIGNMENTS: CltvAssignment[] = [
  // Tier A — high value (composite >= 75)
  {
    prospect_key: 'p-qual-1',
    tier: 'A',
    composite_score: 92,
    macro_score: 0.9,
    industry_score: 0.88,
    company_score: 0.95,
  },
  {
    prospect_key: 'p-qual-8',
    tier: 'A',
    composite_score: 88,
    macro_score: 0.85,
    industry_score: 0.84,
    company_score: 0.92,
  },
  {
    prospect_key: 'p-scored-8',
    tier: 'A',
    composite_score: 82,
    macro_score: 0.8,
    industry_score: 0.82,
    company_score: 0.85,
  },
  {
    prospect_key: 'p-qual-14',
    tier: 'A',
    composite_score: 79,
    macro_score: 0.78,
    industry_score: 0.8,
    company_score: 0.81,
  },
  {
    prospect_key: 'p-qual-12',
    tier: 'A',
    composite_score: 76,
    macro_score: 0.75,
    industry_score: 0.76,
    company_score: 0.78,
  },

  // Tier B — moderate value (composite 50-74)
  {
    prospect_key: 'p-qual-3',
    tier: 'B',
    composite_score: 72,
    macro_score: 0.7,
    industry_score: 0.68,
    company_score: 0.75,
  },
  {
    prospect_key: 'p-qual-6',
    tier: 'B',
    composite_score: 65,
    macro_score: 0.62,
    industry_score: 0.64,
    company_score: 0.68,
  },
  {
    prospect_key: 'p-scored-1',
    tier: 'B',
    composite_score: 60,
    macro_score: 0.58,
    industry_score: 0.6,
    company_score: 0.62,
  },
  {
    prospect_key: 'p-qual-11',
    tier: 'B',
    composite_score: 55,
    macro_score: 0.54,
    industry_score: 0.52,
    company_score: 0.58,
  },
  {
    prospect_key: 'p-scored-3',
    tier: 'B',
    composite_score: 51,
    macro_score: 0.5,
    industry_score: 0.52,
    company_score: 0.53,
  },

  // Tier C — low value (composite 25-49)
  {
    prospect_key: 'p-qual-4',
    tier: 'C',
    composite_score: 45,
    macro_score: 0.42,
    industry_score: 0.44,
    company_score: 0.48,
  },
  {
    prospect_key: 'p-qual-7',
    tier: 'C',
    composite_score: 38,
    macro_score: 0.36,
    industry_score: 0.38,
    company_score: 0.4,
  },
  {
    prospect_key: 'p-scored-4',
    tier: 'C',
    composite_score: 32,
    macro_score: 0.3,
    industry_score: 0.32,
    company_score: 0.35,
  },
  {
    prospect_key: 'p-scored-7',
    tier: 'C',
    composite_score: 28,
    macro_score: 0.26,
    industry_score: 0.28,
    company_score: 0.3,
  },

  // Tier D — very low value (composite < 25)
  {
    prospect_key: 'p-qual-2',
    tier: 'D',
    composite_score: 22,
    macro_score: 0.2,
    industry_score: 0.22,
    company_score: 0.24,
  },
  {
    prospect_key: 'p-qual-5',
    tier: 'D',
    composite_score: 18,
    macro_score: 0.16,
    industry_score: 0.18,
    company_score: 0.2,
  },
  {
    prospect_key: 'p-scored-5',
    tier: 'D',
    composite_score: 12,
    macro_score: 0.1,
    industry_score: 0.12,
    company_score: 0.14,
  },
  {
    prospect_key: 'p-scored-2',
    tier: 'D',
    composite_score: 8,
    macro_score: 0.08,
    industry_score: 0.1,
    company_score: 0.08,
  },
];

// ---------------------------------------------------------------------------
// Customer rows — 22 customers with health_score spread
// ---------------------------------------------------------------------------

const CUSTOMERS: CustomerRow[] = [
  // Healthy (health_score >= 0.75)
  {
    id: demoId('c-healthy-1'),
    prospect_id: demoId('p-qual-1'),
    company_name: 'Veridian Dynamics',
    segment: 'Enterprise',
    health_score: 0.95,
  },
  {
    id: demoId('c-healthy-2'),
    prospect_id: demoId('p-qual-3'),
    company_name: 'Bluth Company',
    segment: 'Mid-Market',
    health_score: 0.9,
  },
  {
    id: demoId('c-healthy-3'),
    prospect_id: demoId('p-qual-6'),
    company_name: 'Dunder Mifflin Paper',
    segment: 'Mid-Market',
    health_score: 0.88,
  },
  {
    id: demoId('c-healthy-4'),
    prospect_id: demoId('p-qual-8'),
    company_name: 'Sabre Tech',
    segment: 'Enterprise',
    health_score: 0.85,
  },
  {
    id: demoId('c-healthy-5'),
    prospect_id: demoId('p-qual-11'),
    company_name: 'Los Pollos Logistics',
    segment: 'Mid-Market',
    health_score: 0.82,
  },
  {
    id: demoId('c-healthy-6'),
    prospect_id: demoId('p-qual-12'),
    company_name: 'Sterling Archer Labs',
    segment: 'Enterprise',
    health_score: 0.8,
  },
  {
    id: demoId('c-healthy-7'),
    prospect_id: demoId('p-qual-14'),
    company_name: 'Hooli Cloud',
    segment: 'Enterprise',
    health_score: 0.78,
  },
  {
    id: demoId('c-healthy-8'),
    company_name: 'Dharma Initiative',
    segment: 'Enterprise',
    health_score: 0.76,
  },

  // At-risk (0.40 - 0.74)
  {
    id: demoId('c-risk-1'),
    prospect_id: demoId('p-qual-9'),
    company_name: 'Flynt Industries',
    segment: 'Mid-Market',
    health_score: 0.72,
  },
  {
    id: demoId('c-risk-2'),
    prospect_id: demoId('p-qual-10'),
    company_name: 'Beneke Fabricators',
    segment: 'SMB',
    health_score: 0.65,
  },
  {
    id: demoId('c-risk-3'),
    prospect_id: demoId('p-qual-13'),
    company_name: 'Pied Piper Data',
    segment: 'SMB',
    health_score: 0.58,
  },
  {
    id: demoId('c-risk-4'),
    company_name: 'Wernham Hogg UK',
    segment: 'Mid-Market',
    health_score: 0.52,
  },
  {
    id: demoId('c-risk-5'),
    company_name: 'Pendant Publishing',
    segment: 'SMB',
    health_score: 0.48,
  },
  {
    id: demoId('c-risk-6'),
    company_name: 'Strickland Propane',
    segment: 'SMB',
    health_score: 0.44,
  },
  {
    id: demoId('c-risk-7'),
    company_name: 'Hamlin Hamlin McGill',
    segment: 'Mid-Market',
    health_score: 0.42,
  },

  // Churned (< 0.40)
  { id: demoId('c-churn-1'), company_name: 'Tex Mex Holdings', segment: 'SMB', health_score: 0.38 },
  { id: demoId('c-churn-2'), company_name: 'Fring Consulting', segment: 'SMB', health_score: 0.3 },
  { id: demoId('c-churn-3'), company_name: 'Badger Creamery', segment: 'SMB', health_score: 0.22 },
  {
    id: demoId('c-churn-4'),
    company_name: 'Salamanca Transport',
    segment: 'Mid-Market',
    health_score: 0.18,
  },
  {
    id: demoId('c-churn-5'),
    company_name: 'Desert Bloom Farms',
    segment: 'SMB',
    health_score: 0.12,
  },
  {
    id: demoId('c-churn-6'),
    company_name: 'Tortuga Fisheries',
    segment: 'SMB',
    health_score: 0.08,
  },
  {
    id: demoId('c-churn-7'),
    company_name: 'Otter Mouth Brewing',
    segment: 'SMB',
    health_score: 0.05,
  },
];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

/**
 * Seed rich demo revenue-lifecycle data if running in DEMO_MODE.
 * Must be called after seedDemoUsers() so the demo user IDs exist.
 */
export async function seedDemoData({ sql }: SeedDemoDataOptions): Promise<void> {
  if (!isDemoMode()) {
    return;
  }

  log('info', '[seed] Seeding demo revenue-lifecycle data...');

  // ------------------------------------------------------------------
  // 1. Resolve demo user IDs
  // ------------------------------------------------------------------
  const repRows = await sql<{ id: string }[]>`
    SELECT id FROM entities
    WHERE type = 'user' AND properties->>'role' = 'sales_rep'
    LIMIT 1
  `;
  const collectionsRows = await sql<{ id: string }[]>`
    SELECT id FROM entities
    WHERE type = 'user' AND properties->>'role' = 'collections_agent'
    LIMIT 1
  `;
  const amRows = await sql<{ id: string }[]>`
    SELECT id FROM entities
    WHERE type = 'user' AND properties->>'role' = 'account_manager'
    LIMIT 1
  `;

  const repId = repRows[0]?.id ?? 'demo-sales-rep';
  const collectionsAgentId = collectionsRows[0]?.id ?? 'demo-collections-agent';
  const accountManagerId = amRows[0]?.id ?? 'demo-account-manager';

  // ------------------------------------------------------------------
  // 2. Industry benchmarks (inserted first — no foreign key deps)
  // ------------------------------------------------------------------
  const SIC_CODES = [
    '7372',
    '3490',
    '5999',
    '7371',
    '6199',
    '4731',
    '2099',
    '5040',
    '7812',
    '6512',
    '4911',
    '7389',
    '5112',
    '2836',
    '6719',
    '5699',
    '4512',
    '2711',
  ];

  const benchmarkBase = new Date('2024-01-01');
  for (const sic of SIC_CODES) {
    const effectiveDate = benchmarkBase.toISOString().slice(0, 10);
    await sql`
      INSERT INTO rl_industry_benchmarks
        (id, sic_code, growth_rate, default_rate, payment_norm_days, effective_date)
      VALUES (
        ${demoId(`bench-${sic}`)},
        ${sic},
        ${0.04 + Math.random() * 0.06},
        ${0.01 + Math.random() * 0.04},
        ${30 + Math.floor(Math.random() * 30)},
        ${effectiveDate}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Industry benchmarks done.');

  // ------------------------------------------------------------------
  // 3. Macro indicators — 8 quarters for CFO trend charts
  // ------------------------------------------------------------------
  const MACRO_TYPES = ['gdp_growth', 'interest_rate', 'inflation', 'unemployment'];
  const QUARTER_OFFSETS = [0, -90, -180, -270, -360, -450, -540, -630]; // days back

  const now = new Date();
  for (const type of MACRO_TYPES) {
    for (const offset of QUARTER_OFFSETS) {
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      const effectiveDate = d.toISOString().slice(0, 10);
      const key = `macro-${type}-${offset}`;
      await sql`
        INSERT INTO rl_macro_indicators
          (id, indicator_type, value, effective_date, source)
        VALUES (
          ${demoId(key)},
          ${type},
          ${parseFloat((1.5 + Math.random() * 5).toFixed(3))},
          ${effectiveDate},
          'demo-seed'
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
  log('info', '[seed] Macro indicators done.');

  // ------------------------------------------------------------------
  // 4. Prospects
  // ------------------------------------------------------------------
  for (const p of PROSPECTS) {
    await sql`
      INSERT INTO rl_prospects
        (id, company_name, industry, sic_code, stage, assigned_rep_id,
         disqualification_reason, disqualified_at, company_segment)
      VALUES (
        ${p.id}, ${p.company_name}, ${p.industry}, ${p.sic_code}, ${p.stage},
        ${repId},
        ${p.disqualification_reason ?? null},
        ${p.disqualified_at ?? null},
        ${p.company_segment ?? null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', `[seed] ${PROSPECTS.length} prospects done.`);

  // ------------------------------------------------------------------
  // 5. KYC records — one per prospect (non-disqualified get 'verified')
  // ------------------------------------------------------------------
  for (const p of PROSPECTS) {
    const status =
      p.stage === 'kyc_pending'
        ? 'pending'
        : p.disqualification_reason === 'kyc_not_verified'
          ? 'failed'
          : 'verified';

    await sql`
      INSERT INTO rl_kyc_records
        (id, prospect_id, verification_status, credit_score, funding_stage,
         annual_revenue_est, debt_load_est, checked_at)
      VALUES (
        ${demoId(`kyc-${p.id}`)},
        ${p.id},
        ${status},
        ${500 + Math.floor(Math.random() * 350)},
        ${'series-a'},
        ${parseFloat((500000 + Math.random() * 9500000).toFixed(2))},
        ${parseFloat((50000 + Math.random() * 950000).toFixed(2))},
        ${new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] KYC records done.');

  // ------------------------------------------------------------------
  // 6. CLTV scores — one per assigned prospect (all 4 tiers)
  // ------------------------------------------------------------------
  const SCORE_VERSION = 'demo-v1-seed';
  for (const ca of CLTV_ASSIGNMENTS) {
    const pid = demoId(ca.prospect_key);
    await sql`
      INSERT INTO rl_cltv_scores
        (id, entity_id, entity_type, macro_score, industry_score, company_score,
         composite_score, tier, score_version,
         macro_inputs_snapshot, industry_inputs_snapshot, company_inputs_snapshot,
         rationale_macro, rationale_industry, rationale_company, computed_at)
      VALUES (
        ${demoId(`score-${ca.prospect_key}`)},
        ${pid},
        'prospect',
        ${ca.macro_score},
        ${ca.industry_score},
        ${ca.company_score},
        ${ca.composite_score},
        ${ca.tier},
        ${SCORE_VERSION},
        ${sql.json({ gdp_growth: 2.4, interest_rate: 5.25 })},
        ${sql.json({ default_rate: 0.02, growth_rate: 0.05 })},
        ${sql.json({ revenue: 4200000, credit_score: 720 })},
        ${`Macro environment is ${ca.tier === 'A' || ca.tier === 'B' ? 'favourable' : 'challenging'} with ${ca.macro_score > 0.6 ? 'positive' : 'negative'} GDP growth signals.`},
        ${`Industry default rate is ${ca.industry_score > 0.5 ? 'below' : 'above'} sector average; growth outlook is ${ca.industry_score > 0.7 ? 'strong' : 'moderate'}.`},
        ${`Company fundamentals are ${ca.company_score > 0.7 ? 'strong' : ca.company_score > 0.4 ? 'adequate' : 'weak'} with credit score ${ca.company_score > 0.6 ? 'above' : 'below'} threshold.`},
        ${new Date(Date.now() - Math.floor(Math.random() * 30) * 24 * 3600 * 1000).toISOString()}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] CLTV scores done.');

  // ------------------------------------------------------------------
  // 7. Historical CLTV scores for CFO trend charts — 6 quarters per tier
  // ------------------------------------------------------------------
  const TIERS = ['A', 'B', 'C', 'D'] as const;
  const HIST_QUARTERS = [0, 90, 180, 270, 360, 450] as const;
  for (const tier of TIERS) {
    for (const daysBack of HIST_QUARTERS) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysBack);
      const key = `hist-score-${tier}-${daysBack}`;
      const baseScore = tier === 'A' ? 80 : tier === 'B' ? 60 : tier === 'C' ? 35 : 15;
      await sql`
        INSERT INTO rl_cltv_scores
          (id, entity_id, entity_type, composite_score, tier, score_version,
           macro_inputs_snapshot, industry_inputs_snapshot, company_inputs_snapshot,
           rationale_macro, rationale_industry, rationale_company, computed_at)
        VALUES (
          ${demoId(key)},
          ${'demo-portfolio-snapshot'},
          'prospect',
          ${baseScore + (Math.random() * 10 - 5)},
          ${tier},
          ${'demo-hist-seed'},
          ${sql.json({ gdp_growth: 2.0 })},
          ${sql.json({ default_rate: 0.02 })},
          ${sql.json({ revenue: 1000000 })},
          ${'Historical macro signal.'},
          ${'Historical industry signal.'},
          ${'Historical company signal.'},
          ${d.toISOString()}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
  log('info', '[seed] Historical CLTV trend data done.');

  // ------------------------------------------------------------------
  // 8. Customers
  // ------------------------------------------------------------------
  for (const c of CUSTOMERS) {
    await sql`
      INSERT INTO rl_customers
        (id, prospect_id, company_name, segment, health_score, account_manager_id)
      VALUES (
        ${c.id},
        ${c.prospect_id ?? null},
        ${c.company_name},
        ${c.segment ?? null},
        ${c.health_score},
        ${accountManagerId}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', `[seed] ${CUSTOMERS.length} customers done.`);

  // ------------------------------------------------------------------
  // 8b. Customer health signals and 30-day score history (issue #55)
  // ------------------------------------------------------------------
  const SIGNAL_SOURCES = [
    'payment_timeliness',
    'usage',
    'support_tickets',
    'contract_renewal',
    'engagement',
  ] as const;

  for (const c of CUSTOMERS) {
    // Seed 30 daily score history snapshots (with some noise).
    for (let day = 30; day >= 0; day--) {
      const recordedAt = new Date(Date.now() - day * 24 * 3600 * 1000).toISOString();
      // Add ±5% noise around the final score to simulate realistic drift.
      const noise = (Math.random() - 0.5) * 0.1;
      const snapshotScore = Math.max(0.01, Math.min(0.99, c.health_score + noise));
      await sql`
        INSERT INTO rl_health_score_history (id, customer_id, score, recorded_at)
        VALUES (
          ${demoId(`hsh-${c.id}-${day}`)},
          ${c.id},
          ${parseFloat(snapshotScore.toFixed(4))},
          ${recordedAt}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // Seed 3–4 contributing signals for each customer.
    const numSignals = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numSignals; i++) {
      const label = SIGNAL_SOURCES[i % SIGNAL_SOURCES.length];
      // Healthy customers have mostly positive contributions.
      const isHealthy = c.health_score >= 0.75;
      const contribution = isHealthy
        ? parseFloat((Math.random() * 0.15).toFixed(4))
        : parseFloat((-0.05 - Math.random() * 0.2).toFixed(4));
      await sql`
        INSERT INTO rl_health_signals (id, customer_id, source_label, contribution)
        VALUES (
          ${demoId(`sig-${c.id}-${label}`)},
          ${c.id},
          ${label},
          ${contribution}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
  log('info', '[seed] Customer health signals and score history done.');

  // ------------------------------------------------------------------
  // 9. Deals — one per qualified prospect
  // ------------------------------------------------------------------
  const DEAL_STAGES = ['contacted', 'qualified', 'proposal', 'closed_won', 'closed_lost'] as const;
  const qualifiedProspects = PROSPECTS.filter((p) => p.stage === 'qualified');
  for (let i = 0; i < qualifiedProspects.length; i++) {
    const p = qualifiedProspects[i];
    const stage = DEAL_STAGES[i % DEAL_STAGES.length];
    await sql`
      INSERT INTO rl_deals
        (id, prospect_id, stage, value, currency, close_date, owner_rep_id)
      VALUES (
        ${demoId(`deal-${p.id}`)},
        ${p.id},
        ${stage},
        ${parseFloat((20000 + Math.random() * 480000).toFixed(2))},
        'USD',
        ${new Date(Date.now() + (30 + Math.floor(Math.random() * 180)) * 24 * 3600 * 1000).toISOString().slice(0, 10)},
        ${repId}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Deals done.');

  // ------------------------------------------------------------------
  // 10. Invoices — all statuses, all aging buckets
  //
  // Status flow: draft → sent → partial_paid | overdue → in_collection → paid | settled | written_off
  // We INSERT each invoice at its final status directly (INSERT is always
  // allowed regardless of status, per the trigger which only guards UPDATEs).
  // ------------------------------------------------------------------

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const daysAhead = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // Helper: seed one invoice and return its id
  const insertInvoice = async (
    key: string,
    customerId: string,
    amount: number,
    status: string,
    dueDate: string,
  ): Promise<string> => {
    const id = demoId(key);
    await sql`
      INSERT INTO rl_invoices
        (id, customer_id, amount, currency, due_date, status, issued_at)
      VALUES (
        ${id}, ${customerId}, ${amount}, 'USD', ${dueDate}, ${status},
        ${new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    return id;
  };

  // Distribute invoices across all customers
  const custIds = CUSTOMERS.map((c) => c.id);
  const pickCustomer = (i: number) => custIds[i % custIds.length];

  // draft (5)
  for (let i = 0; i < 5; i++) {
    await insertInvoice(
      `inv-draft-${i}`,
      pickCustomer(i),
      1000 + i * 500,
      'draft',
      daysAhead(30 + i * 5),
    );
  }

  // sent (5) — due in future (current aging bucket)
  for (let i = 0; i < 5; i++) {
    await insertInvoice(
      `inv-sent-${i}`,
      pickCustomer(i + 5),
      2000 + i * 300,
      'sent',
      daysAhead(10 + i * 5),
    );
  }

  // partial_paid (3)
  for (let i = 0; i < 3; i++) {
    await insertInvoice(
      `inv-partial-${i}`,
      pickCustomer(i + 10),
      3000 + i * 400,
      'partial_paid',
      daysAhead(5 + i),
    );
  }

  // overdue — spread across aging buckets (30-60, 60-90, 90-120, 120+) — 12 invoices
  const overdueSpec = [
    { i: 0, days: 15 },
    { i: 1, days: 25 },
    { i: 2, days: 35 }, // 1-30
    { i: 3, days: 45 },
    { i: 4, days: 55 }, // 30-60 bucket
    { i: 5, days: 65 },
    { i: 6, days: 75 }, // 60-90 bucket
    { i: 7, days: 85 },
    { i: 8, days: 95 }, // 90-120 bucket  (was missing before)
    { i: 9, days: 125 },
    { i: 10, days: 150 },
    { i: 11, days: 200 }, // 120+ bucket
  ];
  for (const { i, days } of overdueSpec) {
    await insertInvoice(
      `inv-overdue-${i}`,
      pickCustomer(i + 13),
      4000 + i * 250,
      'overdue',
      daysAgo(days),
    );
  }

  // in_collection (10)
  const inCollectionIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = await insertInvoice(
      `inv-incol-${i}`,
      pickCustomer(i),
      5000 + i * 500,
      'in_collection',
      daysAgo(60 + i * 10),
    );
    inCollectionIds.push(id);
  }

  // paid (5)
  for (let i = 0; i < 5; i++) {
    await insertInvoice(
      `inv-paid-${i}`,
      pickCustomer(i + 3),
      6000 + i * 200,
      'paid',
      daysAgo(90 + i * 5),
    );
  }

  // settled (3)
  for (let i = 0; i < 3; i++) {
    await insertInvoice(
      `inv-settled-${i}`,
      pickCustomer(i + 8),
      7000 + i * 150,
      'settled',
      daysAgo(100 + i * 7),
    );
  }

  // written_off (2) — near-write-off accounts
  for (let i = 0; i < 2; i++) {
    await insertInvoice(
      `inv-writeoff-${i}`,
      pickCustomer(i + 11),
      8000 + i * 300,
      'written_off',
      daysAgo(180 + i * 20),
    );
  }

  log('info', '[seed] Invoices done.');

  // ------------------------------------------------------------------
  // 11. Dunning actions — for overdue and in_collection invoices
  // ------------------------------------------------------------------
  for (const { i } of overdueSpec.slice(0, 6)) {
    const invId = demoId(`inv-overdue-${i}`);
    await sql`
      INSERT INTO rl_dunning_actions
        (id, invoice_id, action_type, scheduled_at, sent_at, response)
      VALUES (
        ${demoId(`dunning-overdue-${i}`)},
        ${invId},
        ${'email_reminder'},
        ${new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString()},
        ${new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString()},
        ${'no_response'}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (let i = 0; i < inCollectionIds.length; i++) {
    await sql`
      INSERT INTO rl_dunning_actions
        (id, invoice_id, action_type, scheduled_at, sent_at, response)
      VALUES (
        ${demoId(`dunning-incol-${i}`)},
        ${inCollectionIds[i]},
        ${'legal_notice'},
        ${new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()},
        ${new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString()},
        ${'disputed'}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Dunning actions done.');

  // ------------------------------------------------------------------
  // 12. Collection cases — all statuses, wired to collections agent
  // ------------------------------------------------------------------
  // open (4), resolved (2), escalated (2), written_off (2)
  const caseStatuses: Array<{ status: string; resolution_type?: string }> = [
    { status: 'open' },
    { status: 'open' },
    { status: 'open' },
    { status: 'open' },
    { status: 'resolved', resolution_type: 'paid' },
    { status: 'resolved', resolution_type: 'payment_plan' },
    { status: 'escalated' },
    { status: 'escalated' },
    { status: 'written_off', resolution_type: 'written_off' },
    { status: 'written_off', resolution_type: 'legal' },
  ];

  const collectionCaseIds: string[] = [];
  for (let i = 0; i < inCollectionIds.length && i < caseStatuses.length; i++) {
    const cs = caseStatuses[i];
    const caseId = demoId(`case-${i}`);
    collectionCaseIds.push(caseId);
    const isResolved = cs.status === 'resolved' || cs.status === 'written_off';
    await sql`
      INSERT INTO rl_collection_cases
        (id, invoice_id, agent_id, status, escalation_level, resolution_type,
         opened_at, resolved_at)
      VALUES (
        ${caseId},
        ${inCollectionIds[i]},
        ${collectionsAgentId},
        ${cs.status},
        ${cs.status === 'escalated' ? 2 : 0},
        ${cs.resolution_type ?? null},
        ${new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()},
        ${isResolved ? new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() : null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Collection cases done.');

  // ------------------------------------------------------------------
  // 13. Payment plans — one per status (current, breached, completed, cancelled)
  //     Must be linked to collection cases that exist
  // ------------------------------------------------------------------
  const paymentPlanStatuses = ['current', 'breached', 'completed', 'cancelled'] as const;
  for (let i = 0; i < paymentPlanStatuses.length && i < collectionCaseIds.length; i++) {
    const status = paymentPlanStatuses[i];
    const totalAmount = 10000 + i * 2000;
    const installmentCount = 4 + i;
    await sql`
      INSERT INTO rl_payment_plans
        (id, collection_case_id, total_amount, installment_count, installment_amount,
         next_due_date, status)
      VALUES (
        ${demoId(`plan-${status}`)},
        ${collectionCaseIds[i]},
        ${totalAmount},
        ${installmentCount},
        ${parseFloat((totalAmount / installmentCount).toFixed(2))},
        ${daysAhead(30 - i * 5)},
        ${status}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Payment plans done.');

  // ------------------------------------------------------------------
  // 14. Notifications — for demo sales rep (mix of read / unread)
  //     Require at least 3 unread
  // ------------------------------------------------------------------
  const notifProspects = PROSPECTS.filter((p) => ['scored', 'qualified'].includes(p.stage)).slice(
    0,
    8,
  );

  for (let i = 0; i < notifProspects.length; i++) {
    const p = notifProspects[i];
    const eventType = i % 2 === 0 ? 'new_lead' : 'score_drop';
    // First 3 are unread (read_at = null), rest are read
    const readAt = i < 3 ? null : new Date(Date.now() - i * 24 * 3600 * 1000).toISOString();
    await sql`
      INSERT INTO rl_notifications
        (id, rep_id, prospect_id, event_type, description, read_at, created_at)
      VALUES (
        ${demoId(`notif-${i}`)},
        ${repId},
        ${p.id},
        ${eventType},
        ${
          eventType === 'new_lead'
            ? `New qualified lead: ${p.company_name} scored tier ${CLTV_ASSIGNMENTS.find((ca) => demoId(ca.prospect_key) === p.id)?.tier ?? 'B'}.`
            : `Score drop alert: ${p.company_name} moved to lower tier.`
        },
        ${readAt},
        ${new Date(Date.now() - i * 12 * 3600 * 1000).toISOString()}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Notifications done.');

  // ------------------------------------------------------------------
  // 15. Contact logs — 3+ per collection case (call, email, portal)
  // ------------------------------------------------------------------
  const contactOutcomes = {
    call: [
      'reached_payment_promise',
      'no_answer',
      'left_voicemail',
      'disputed',
      'partial_commitment',
    ],
    email: [
      'opened_no_reply',
      'bounced',
      'replied_promise_to_pay',
      'out_of_office',
      'payment_received',
    ],
    portal: ['viewed', 'message_sent', 'payment_initiated', 'no_activity', 'document_uploaded'],
  } as const;

  const contactTypes = ['call', 'email', 'portal'] as const;

  for (let i = 0; i < collectionCaseIds.length; i++) {
    const caseId = collectionCaseIds[i];
    // Insert at least 3 contact log entries per case with different types
    for (let j = 0; j < 3; j++) {
      const ctype = contactTypes[j % contactTypes.length];
      const outcomes = contactOutcomes[ctype];
      const outcome = outcomes[i % outcomes.length];
      const daysBack = 25 - j * 5; // stagger contacts over time
      await sql`
        INSERT INTO rl_contact_logs
          (id, collection_case_id, agent_id, contact_type, outcome, notes, contacted_at)
        VALUES (
          ${demoId(`contact-log-${i}-${j}`)},
          ${caseId},
          ${collectionsAgentId},
          ${ctype},
          ${outcome},
          ${`Attempt ${j + 1}: ${outcome.replace(/_/g, ' ')}. Case #${i + 1} follow-up.`},
          ${new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString()}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
    // Add a 4th log to some cases (variety)
    if (i % 2 === 0) {
      const ctype = contactTypes[(i + 1) % contactTypes.length];
      await sql`
        INSERT INTO rl_contact_logs
          (id, collection_case_id, agent_id, contact_type, outcome, notes, contacted_at)
        VALUES (
          ${demoId(`contact-log-${i}-3`)},
          ${caseId},
          ${collectionsAgentId},
          ${ctype},
          ${'escalated_to_manager'},
          ${'Escalated after no response. Manager notified.'},
          ${new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
  log('info', '[seed] Contact logs done.');

  // ------------------------------------------------------------------
  // 16. Enhanced dunning actions — D+1/D+7/D+14/D+30 sequences
  //     Replace basic dunning with rich sequences per invoice
  // ------------------------------------------------------------------
  const dunningSequence = [
    { dayOffset: 1, action_type: 'email_reminder', response: 'no_response' },
    { dayOffset: 7, action_type: 'email_reminder', response: 'no_response' },
    { dayOffset: 14, action_type: 'sms_reminder', response: 'opened_no_action' },
    { dayOffset: 30, action_type: 'legal_notice', response: 'disputed' },
  ] as const;

  // Add dunning sequences to first 4 overdue invoices (D+1 through D+30 pattern)
  for (let i = 0; i < 4; i++) {
    const invId = demoId(`inv-overdue-${i}`);
    const overdueDate = new Date(Date.now() - overdueSpec[i].days * 24 * 3600 * 1000);
    for (const step of dunningSequence) {
      const scheduledAt = new Date(overdueDate.getTime() + step.dayOffset * 24 * 3600 * 1000);
      const sentAt = new Date(scheduledAt.getTime() + 2 * 3600 * 1000); // sent 2h after scheduled
      // Only include sent_at if the step date is in the past
      const isPast = sentAt.getTime() < Date.now();
      await sql`
        INSERT INTO rl_dunning_actions
          (id, invoice_id, action_type, scheduled_at, sent_at, response)
        VALUES (
          ${demoId(`dunning-seq-${i}-d${step.dayOffset}`)},
          ${invId},
          ${step.action_type},
          ${scheduledAt.toISOString()},
          ${isPast ? sentAt.toISOString() : null},
          ${isPast ? step.response : null}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
  log('info', '[seed] Enhanced dunning sequences done.');

  // ------------------------------------------------------------------
  // 17. Write-off approvals — pending (above threshold), approved, rejected
  // ------------------------------------------------------------------
  // Use first 3 collection cases
  const writeOffSpecs = [
    {
      key: 'writeoff-pending',
      caseIdx: 0,
      status: 'pending_approval',
      settlement: 4500,
      writeoff: 7500,
      notes:
        'Customer has been unresponsive for 90+ days. Recommend settlement at 37.5% of face value.',
      review_notes: null,
    },
    {
      key: 'writeoff-approved',
      caseIdx: 1,
      status: 'approved',
      settlement: 6000,
      writeoff: 6000,
      notes: 'Customer agreed to partial settlement after negotiation.',
      review_notes: 'Approved. Settlement is above 40% threshold. Case closed.',
    },
    {
      key: 'writeoff-rejected',
      caseIdx: 2,
      status: 'rejected',
      settlement: 2000,
      writeoff: 10000,
      notes: 'Proposed settlement far below threshold — customer at 16% of face value.',
      review_notes: 'Rejected. Settlement is below minimum 30% threshold. Escalate to legal.',
    },
  ] as const;

  // Get FC user id
  const fcRows = await sql<{ id: string }[]>`
    SELECT id FROM entities
    WHERE type = 'user' AND properties->>'role' = 'finance_controller'
    LIMIT 1
  `;
  const financeControllerId = fcRows[0]?.id ?? 'demo-finance-controller';

  for (const spec of writeOffSpecs) {
    const caseId = collectionCaseIds[spec.caseIdx];
    const invoiceId = inCollectionIds[spec.caseIdx];
    const customerId = CUSTOMERS[spec.caseIdx % CUSTOMERS.length].id;
    const isReviewed = spec.status !== 'pending_approval';
    await sql`
      INSERT INTO rl_write_off_approvals
        (id, collection_case_id, invoice_id, customer_id,
         proposed_by, reviewed_by, settlement_amount, implied_write_off_amount,
         status, notes, review_notes, reviewed_at)
      VALUES (
        ${demoId(spec.key)},
        ${caseId},
        ${invoiceId},
        ${customerId},
        ${collectionsAgentId},
        ${isReviewed ? financeControllerId : null},
        ${spec.settlement},
        ${spec.writeoff},
        ${spec.status},
        ${spec.notes},
        ${spec.review_notes},
        ${isReviewed ? new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() : null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Write-off approvals done.');

  // ------------------------------------------------------------------
  // 18. Interventions — 5 resolved, 2 in_progress, 1 open
  // ------------------------------------------------------------------
  const interventionSpecs = [
    // Resolved (5)
    {
      key: 'interv-resolved-1',
      custIdx: 8, // c-risk-1 Flynt Industries
      trigger_type: 'health_score_drop',
      playbook: 'at_risk_outreach',
      status: 'resolved',
      outcome: 'Customer confirmed continued subscription after executive call.',
    },
    {
      key: 'interv-resolved-2',
      custIdx: 9, // c-risk-2 Beneke Fabricators
      trigger_type: 'overdue_invoice',
      playbook: 'invoice_recovery',
      status: 'resolved',
      outcome: 'Payment plan established. First installment received.',
    },
    {
      key: 'interv-resolved-3',
      custIdx: 10, // c-risk-3 Pied Piper Data
      trigger_type: 'health_score_drop',
      playbook: 'at_risk_outreach',
      status: 'resolved',
      outcome: 'Root cause was a billing contact change. Updated and re-sent invoices.',
    },
    {
      key: 'interv-resolved-4',
      custIdx: 11, // c-risk-4 Wernham Hogg UK
      trigger_type: 'payment_plan_breach',
      playbook: 'breach_recovery',
      status: 'resolved',
      outcome: 'Missed installment recovered. Plan back on track.',
    },
    {
      key: 'interv-resolved-5',
      custIdx: 12, // c-risk-5 Pendant Publishing
      trigger_type: 'health_score_drop',
      playbook: 'executive_escalation',
      status: 'resolved',
      outcome: 'Executive sponsor engaged. Customer renewed annual contract.',
    },
    // In-progress (2)
    {
      key: 'interv-inprogress-1',
      custIdx: 13, // c-risk-6 Strickland Propane
      trigger_type: 'health_score_drop',
      playbook: 'at_risk_outreach',
      status: 'in_progress',
      outcome: null,
    },
    {
      key: 'interv-inprogress-2',
      custIdx: 14, // c-risk-7 Hamlin Hamlin McGill
      trigger_type: 'overdue_invoice',
      playbook: 'invoice_recovery',
      status: 'in_progress',
      outcome: null,
    },
    // Open (1)
    {
      key: 'interv-open-1',
      custIdx: 15, // c-churn-1 Tex Mex Holdings
      trigger_type: 'health_score_drop',
      playbook: 'at_risk_outreach',
      status: 'open',
      outcome: null,
    },
  ] as const;

  for (const spec of interventionSpecs) {
    const custId = CUSTOMERS[spec.custIdx % CUSTOMERS.length].id;
    const isResolved = spec.status === 'resolved';
    await sql`
      INSERT INTO rl_interventions
        (id, customer_id, trigger_type, playbook, assigned_to, status, outcome, resolved_at)
      VALUES (
        ${demoId(spec.key)},
        ${custId},
        ${spec.trigger_type},
        ${spec.playbook},
        ${accountManagerId},
        ${spec.status},
        ${spec.outcome},
        ${isResolved ? new Date(Date.now() - Math.floor(Math.random() * 14 + 1) * 24 * 3600 * 1000).toISOString() : null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Interventions done.');

  // ------------------------------------------------------------------
  // 19. Customer health scores (rl_customer_health_scores)
  //     4 open alerts at ages 1, 3, 7, 14 days
  //     The 14-day alert has NO intervention (triggers escalation demo)
  //     + 2 additional alerts with in-progress interventions
  // ------------------------------------------------------------------
  const healthAlertSpecs = [
    // 4 open health alerts at 1, 3, 7, 14 days ago
    {
      key: 'health-alert-1d',
      custIdx: 13,
      daysAgoVal: 1,
      score: 35,
      signal: 0.8,
      breach: 0.4,
      escalation: 0.0,
    },
    {
      key: 'health-alert-3d',
      custIdx: 14,
      daysAgoVal: 3,
      score: 28,
      signal: 0.9,
      breach: 0.5,
      escalation: 0.1,
    },
    {
      key: 'health-alert-7d',
      custIdx: 15,
      daysAgoVal: 7,
      score: 22,
      signal: 0.95,
      breach: 0.7,
      escalation: 0.3,
    },
    // 14-day alert: no intervention — this is the escalation demo case
    {
      key: 'health-alert-14d',
      custIdx: 16,
      daysAgoVal: 14,
      score: 15,
      signal: 1.0,
      breach: 0.9,
      escalation: 0.8,
    },
    // 2 additional alerts for in-progress intervention customers
    {
      key: 'health-alert-am1',
      custIdx: 8,
      daysAgoVal: 5,
      score: 42,
      signal: 0.6,
      breach: 0.3,
      escalation: 0.0,
    },
    {
      key: 'health-alert-am2',
      custIdx: 9,
      daysAgoVal: 2,
      score: 38,
      signal: 0.7,
      breach: 0.4,
      escalation: 0.1,
    },
  ] as const;

  for (const spec of healthAlertSpecs) {
    const custId = CUSTOMERS[spec.custIdx % CUSTOMERS.length].id;
    const scoreDate = new Date(Date.now() - spec.daysAgoVal * 24 * 3600 * 1000);
    await sql`
      INSERT INTO rl_customer_health_scores
        (id, customer_id, score_date, score,
         days_overdue_signal, breach_count_signal, escalation_signal,
         days_overdue_value, breach_count_value, escalation_level_value)
      VALUES (
        ${demoId(spec.key)},
        ${custId},
        ${scoreDate.toISOString().slice(0, 10)},
        ${spec.score},
        ${spec.signal},
        ${spec.breach},
        ${spec.escalation},
        ${Math.round(spec.signal * 60)},
        ${Math.round(spec.breach * 5)},
        ${Math.round(spec.escalation * 3)}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] Customer health scores (alerts) done.');

  // ------------------------------------------------------------------
  // 20. KYC manual review records — 3 prospects with distinct failure reasons
  //     The kyc_manual_review stage prospects already exist (p-kycm-1/2/3)
  //     We update their KYC records to have distinct failure reasons stored in notes
  // ------------------------------------------------------------------
  const kycManualSpecs = [
    {
      prospectKey: 'p-kycm-1', // Wolfram Holdings
      failure_reason: 'identity_mismatch',
      notes:
        'Registered director name does not match submitted ID documents. Requires manual verification by compliance officer.',
    },
    {
      prospectKey: 'p-kycm-2', // Rekall Robotics
      failure_reason: 'insufficient_data',
      notes:
        'Insufficient financial documentation provided. Annual accounts are >24 months old. Request updated statements.',
    },
    {
      prospectKey: 'p-kycm-3', // Omni Consumer Products
      failure_reason: 'failed_credit_check',
      notes:
        'Credit bureau check returned adverse finding: 2 CCJs in last 36 months. Manual review required before onboarding.',
    },
  ] as const;

  // The KYC records for these prospects were already inserted in step 5 with status 'verified'.
  // We need to update them to reflect their manual_review status. We use an UPSERT approach:
  // delete by key and re-insert with correct status + notes, or add separate manual_review records.
  // Since ON CONFLICT (prospect_id) WHERE status != 'archived' prevents duplicate non-archived records,
  // we insert with a distinct ID suffix to represent the review flag.
  // Instead we seed a separate notes-carrying KYC record for the manual review.
  for (const spec of kycManualSpecs) {
    const pid = demoId(spec.prospectKey);
    // First, archive the auto-generated KYC record for this prospect to allow inserting manual review one
    await sql`
      UPDATE rl_kyc_records
      SET verification_status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE prospect_id = ${pid}
        AND id = ${demoId(`kyc-${pid}`)}
        AND verification_status != 'archived'
    `;
    // Now insert a 'failed' KYC record with the specific failure reason in the notes column
    await sql`
      INSERT INTO rl_kyc_records
        (id, prospect_id, verification_status, credit_score, funding_stage,
         annual_revenue_est, debt_load_est, checked_at)
      VALUES (
        ${demoId(`kyc-manual-${spec.prospectKey}`)},
        ${pid},
        ${'failed'},
        ${480 + kycManualSpecs.indexOf(spec) * 30},
        ${'series-a'},
        ${parseFloat((1000000 + kycManualSpecs.indexOf(spec) * 500000).toFixed(2))},
        ${parseFloat((100000 + kycManualSpecs.indexOf(spec) * 50000).toFixed(2))},
        ${new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
  log('info', '[seed] KYC manual review records done.');

  log('info', '[seed] Demo data seeding complete.');
}
