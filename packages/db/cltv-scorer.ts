/**
 * @file cltv-scorer.ts
 *
 * Versioned CLTV (Customer Lifetime Value) scoring engine for Phase 0 (P0-3).
 *
 * ## Responsibility
 *
 * `score()` is the single public entry point.  Given an `entity_id` and
 * `entity_type` it:
 *
 *   1. Reads the latest MacroIndicator rows.
 *   2. Reads the latest IndustryBenchmark row matching the entity's SIC code
 *      (from rl_prospects or rl_customers via the rl_prospects FK).
 *   3. Reads the entity's active KYCRecord (for company-level signals).
 *   4. Computes a weighted composite score (0–100) from three normalised
 *      sub-scores (macro, industry, company) using weights read from
 *      environment variables.
 *   5. Classifies the composite score into a tier (A/B/C/D) using configurable
 *      thresholds read from environment variables.
 *   6. Generates plain-English rationale strings for each input dimension.
 *   7. Writes an immutable CLTVScore row and returns it.
 *
 * ## score_version
 *
 * The version string is a SHA-256 hash of the serialised weight + threshold
 * config.  Any change to CLTV_WEIGHT_MACRO, CLTV_WEIGHT_INDUSTRY,
 * CLTV_WEIGHT_COMPANY, CLTV_TIER_A, or CLTV_TIER_B produces a distinct hash,
 * so old rows are never destroyed and version drift is auditable.
 *
 * ## Weights (environment variables)
 *
 * | Variable              | Default | Meaning                              |
 * |-----------------------|---------|--------------------------------------|
 * | CLTV_WEIGHT_MACRO     | 0.30    | Weight applied to macro_score        |
 * | CLTV_WEIGHT_INDUSTRY  | 0.30    | Weight applied to industry_score     |
 * | CLTV_WEIGHT_COMPANY   | 0.40    | Weight applied to company_score      |
 *
 * Weights are normalised automatically so they always sum to 1.0.
 *
 * ## Tier thresholds (environment variables)
 *
 * | Variable   | Default | Meaning                                          |
 * |------------|---------|--------------------------------------------------|
 * | CLTV_TIER_A | 80     | composite_score >= this value → tier A           |
 * | CLTV_TIER_B | 60     | composite_score >= this value (and < A) → tier B |
 * | CLTV_TIER_C | 40     | composite_score >= this value (and < B) → tier C |
 * | (implicit)  |         | composite_score < C threshold → tier D           |
 *
 * ## Scoring formulae
 *
 * ### Macro sub-score (0–1)
 * Derived from the latest values of three standard indicator types:
 *   - interest_rate     → lower is better;  normalised as (1 - rate/20) clamped [0,1]
 *   - gdp_growth_rate   → higher is better; normalised as (rate+5)/15  clamped [0,1]
 *   - inflation_rate    → lower is better;  normalised as (1 - rate/20) clamped [0,1]
 * The three normalised values are averaged.  If none of the three types are
 * present the sub-score defaults to 0.5 (neutral).
 *
 * ### Industry sub-score (0–1)
 * Derived from the latest IndustryBenchmark matching the entity's SIC code:
 *   - growth_rate    → higher is better; normalised as (rate+0.1)/0.3  clamped [0,1]
 *   - default_rate   → lower is better;  normalised as (1 - rate/0.2)  clamped [0,1]
 * If no benchmark is found the sub-score defaults to 0.5 (neutral).
 *
 * ### Company sub-score (0–1)
 * Derived from the entity's active KYCRecord:
 *   - annual_revenue_est → higher is better; log-normalised against $10M cap
 *   - debt_load_est      → lower is better;  normalised as debt / annual_revenue_est
 * If no KYC record is present the sub-score defaults to 0.5 (neutral).
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/5
 */

import { createHash } from 'crypto';
import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type EntityType = 'prospect' | 'customer';
export type Tier = 'A' | 'B' | 'C' | 'D';

/** Row shape returned from the rl_cltv_scores table. */
export interface CLTVScoreRow {
  id: string;
  entity_id: string;
  entity_type: EntityType;
  macro_score: number | null;
  industry_score: number | null;
  company_score: number | null;
  composite_score: number;
  tier: Tier;
  score_version: string;
  macro_inputs_snapshot: MacroSnapshot | null;
  industry_inputs_snapshot: IndustrySnapshot | null;
  company_inputs_snapshot: CompanySnapshot | null;
  rationale_macro: string | null;
  rationale_industry: string | null;
  rationale_company: string | null;
  computed_at: Date;
  created_at: Date;
}

/** Snapshot of macro indicator values captured at score time. */
export interface MacroSnapshot {
  interest_rate: number | null;
  gdp_growth_rate: number | null;
  inflation_rate: number | null;
}

/** Snapshot of industry benchmark values captured at score time. */
export interface IndustrySnapshot {
  sic_code: string | null;
  growth_rate: number | null;
  default_rate: number | null;
  payment_norm_days: number | null;
}

/** Snapshot of company-level values captured at score time. */
export interface CompanySnapshot {
  annual_revenue_est: number | null;
  debt_load_est: number | null;
  funding_stage: string | null;
  kyc_record_id: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoringConfig {
  /** Raw weight for macro sub-score (before normalisation). */
  weightMacro: number;
  /** Raw weight for industry sub-score (before normalisation). */
  weightIndustry: number;
  /** Raw weight for company sub-score (before normalisation). */
  weightCompany: number;
  /** composite_score >= this → tier A. */
  tierA: number;
  /** composite_score >= this (and < tierA) → tier B. */
  tierB: number;
  /** composite_score >= this (and < tierB) → tier C. */
  tierC: number;
}

/**
 * Resolves scoring configuration from environment variables.
 * All values have safe defaults so no deployment configuration is required.
 *
 * @param env Defaults to `process.env`. Pass a custom object in tests.
 */
export function resolveScoringConfig(env: NodeJS.ProcessEnv = process.env): ScoringConfig {
  const weightMacro = parseFloat(env.CLTV_WEIGHT_MACRO ?? '0.30');
  const weightIndustry = parseFloat(env.CLTV_WEIGHT_INDUSTRY ?? '0.30');
  const weightCompany = parseFloat(env.CLTV_WEIGHT_COMPANY ?? '0.40');
  const tierA = parseFloat(env.CLTV_TIER_A ?? '80');
  const tierB = parseFloat(env.CLTV_TIER_B ?? '60');
  const tierC = parseFloat(env.CLTV_TIER_C ?? '40');

  return {
    weightMacro: isNaN(weightMacro) ? 0.3 : weightMacro,
    weightIndustry: isNaN(weightIndustry) ? 0.3 : weightIndustry,
    weightCompany: isNaN(weightCompany) ? 0.4 : weightCompany,
    tierA: isNaN(tierA) ? 80 : tierA,
    tierB: isNaN(tierB) ? 60 : tierB,
    tierC: isNaN(tierC) ? 40 : tierC,
  };
}

/**
 * Computes a stable score_version string from the current scoring config.
 *
 * The version is a truncated (12-hex-char) SHA-256 hash of the JSON-serialised
 * weights and tier thresholds.  Any weight or threshold change produces a new
 * version; all other fields in the hash input are fixed.
 */
export function computeScoreVersion(config: ScoringConfig): string {
  const payload = JSON.stringify({
    wm: config.weightMacro,
    wi: config.weightIndustry,
    wc: config.weightCompany,
    tA: config.tierA,
    tB: config.tierB,
    tC: config.tierC,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a composite score (0–100) to a tier label (A/B/C/D) using the
 * configured thresholds.
 */
export function classifyTier(compositeScore: number, config: ScoringConfig): Tier {
  if (compositeScore >= config.tierA) return 'A';
  if (compositeScore >= config.tierB) return 'B';
  if (compositeScore >= config.tierC) return 'C';
  return 'D';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-score computation helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes the macro sub-score (0–1) from a snapshot of macro indicators.
 *
 * Each present indicator is normalised independently and the results are
 * averaged.  Missing indicators are omitted from the average (not treated as
 * zero) so that partial data does not disproportionately penalise the score.
 *
 * If no indicators are present the sub-score defaults to 0.5 (neutral).
 */
export function computeMacroSubScore(snapshot: MacroSnapshot): number {
  const components: number[] = [];

  if (snapshot.interest_rate !== null) {
    // Lower interest rates are better.  Rate of 0 → 1.0; rate of 20 → 0.0.
    components.push(clamp(1 - snapshot.interest_rate / 20, 0, 1));
  }
  if (snapshot.gdp_growth_rate !== null) {
    // Higher GDP growth is better.  -5% → 0.0; +10% → 1.0.
    components.push(clamp((snapshot.gdp_growth_rate + 5) / 15, 0, 1));
  }
  if (snapshot.inflation_rate !== null) {
    // Lower inflation is better.  0% → 1.0; 20% → 0.0.
    components.push(clamp(1 - snapshot.inflation_rate / 20, 0, 1));
  }

  if (components.length === 0) return 0.5;
  return components.reduce((a, b) => a + b, 0) / components.length;
}

/**
 * Computes the industry sub-score (0–1) from a snapshot of benchmark data.
 *
 * Missing benchmarks default to 0.5 (neutral).
 */
export function computeIndustrySubScore(snapshot: IndustrySnapshot): number {
  const components: number[] = [];

  if (snapshot.growth_rate !== null) {
    // Higher growth is better.  -10% → 0.0; +20% → 1.0.
    components.push(clamp((snapshot.growth_rate + 0.1) / 0.3, 0, 1));
  }
  if (snapshot.default_rate !== null) {
    // Lower default rate is better.  0% → 1.0; 20% → 0.0.
    components.push(clamp(1 - snapshot.default_rate / 0.2, 0, 1));
  }

  if (components.length === 0) return 0.5;
  return components.reduce((a, b) => a + b, 0) / components.length;
}

/**
 * Computes the company sub-score (0–1) from a snapshot of KYC data.
 *
 * Missing KYC defaults to 0.5 (neutral).
 */
export function computeCompanySubScore(snapshot: CompanySnapshot): number {
  const components: number[] = [];

  if (snapshot.annual_revenue_est !== null && snapshot.annual_revenue_est > 0) {
    // Log-normalised against $10M cap (in USD cents: $10M = 10_000_000).
    const MAX_REV = 10_000_000;
    const logNorm = Math.log10(snapshot.annual_revenue_est + 1) / Math.log10(MAX_REV + 1);
    components.push(clamp(logNorm, 0, 1));
  }

  if (
    snapshot.debt_load_est !== null &&
    snapshot.annual_revenue_est !== null &&
    snapshot.annual_revenue_est > 0
  ) {
    // Debt-to-revenue ratio — lower is better.  0 → 1.0; 2x revenue → 0.0.
    const ratio = snapshot.debt_load_est / snapshot.annual_revenue_est;
    components.push(clamp(1 - ratio / 2, 0, 1));
  } else if (snapshot.debt_load_est !== null) {
    // Revenue unknown but debt is known — use a conservative mid-point.
    components.push(0.5);
  }

  if (components.length === 0) return 0.5;
  return components.reduce((a, b) => a + b, 0) / components.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rationale generator
// ─────────────────────────────────────────────────────────────────────────────

/** Generates a plain-English rationale string for the macro sub-score. */
export function buildMacroRationale(snapshot: MacroSnapshot, subScore: number): string {
  const parts: string[] = [];
  if (snapshot.interest_rate !== null)
    parts.push(`interest rate ${snapshot.interest_rate.toFixed(2)}%`);
  if (snapshot.gdp_growth_rate !== null)
    parts.push(`GDP growth ${snapshot.gdp_growth_rate.toFixed(2)}%`);
  if (snapshot.inflation_rate !== null)
    parts.push(`inflation ${snapshot.inflation_rate.toFixed(2)}%`);

  if (parts.length === 0) return 'No macro indicators available; defaulted to neutral (0.50).';
  return (
    `Macro environment scored ${(subScore * 100).toFixed(1)}/100 based on: ` +
    parts.join(', ') +
    '.'
  );
}

/** Generates a plain-English rationale string for the industry sub-score. */
export function buildIndustryRationale(snapshot: IndustrySnapshot, subScore: number): string {
  if (!snapshot.sic_code) return 'No industry benchmark available; defaulted to neutral (0.50).';

  const parts: string[] = [`SIC code ${snapshot.sic_code}`];
  if (snapshot.growth_rate !== null)
    parts.push(`growth rate ${(snapshot.growth_rate * 100).toFixed(2)}%`);
  if (snapshot.default_rate !== null)
    parts.push(`default rate ${(snapshot.default_rate * 100).toFixed(2)}%`);
  if (snapshot.payment_norm_days !== null)
    parts.push(`payment norm ${snapshot.payment_norm_days} days`);

  return `Industry scored ${(subScore * 100).toFixed(1)}/100 based on: ` + parts.join(', ') + '.';
}

/** Generates a plain-English rationale string for the company sub-score. */
export function buildCompanyRationale(snapshot: CompanySnapshot, subScore: number): string {
  if (!snapshot.kyc_record_id) return 'No KYC record available; defaulted to neutral (0.50).';

  const parts: string[] = [];
  if (snapshot.annual_revenue_est !== null)
    parts.push(`annual revenue ~$${Math.round(snapshot.annual_revenue_est).toLocaleString()}`);
  if (snapshot.debt_load_est !== null)
    parts.push(`debt load ~$${Math.round(snapshot.debt_load_est).toLocaleString()}`);
  if (snapshot.funding_stage !== null) parts.push(`stage: ${snapshot.funding_stage}`);

  return `Company scored ${(subScore * 100).toFixed(1)}/100 based on: ` + parts.join(', ') + '.';
}

// ─────────────────────────────────────────────────────────────────────────────
// DB row types for reading input data
// ─────────────────────────────────────────────────────────────────────────────

interface MacroIndicatorRow {
  id: string;
  indicator_type: string;
  value: number;
  effective_date: string;
}

interface IndustryBenchmarkRow {
  id: string;
  sic_code: string;
  growth_rate: number | null;
  default_rate: number | null;
  payment_norm_days: number | null;
  effective_date: string;
}

interface KycRecordRow {
  id: string;
  annual_revenue_est: number | null;
  debt_load_est: number | null;
  funding_stage: string | null;
}

interface ProspectSicRow {
  sic_code: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// score() — main entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreOptions {
  entity_id: string;
  entity_type: EntityType;
  /** Override environment config — primarily for tests. */
  config?: ScoringConfig;
}

/**
 * Computes a versioned CLTVScore for the given entity and writes the row.
 *
 * The function reads the latest available MacroIndicator, IndustryBenchmark,
 * and KYCRecord data, computes sub-scores, applies weighted combination, and
 * persists an immutable CLTVScore row.  Previous rows for the same entity are
 * never modified or deleted.
 *
 * @param options    Entity identifier and optional config override.
 * @param sqlClient  Postgres client (defaults to the module-level pool).
 * @returns          The newly written CLTVScore row.
 */
export async function score(
  options: ScoreOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CLTVScoreRow> {
  const { entity_id, entity_type } = options;
  const config = options.config ?? resolveScoringConfig();

  // ── 1. Fetch macro indicators (latest value per type) ──────────────────────
  const macroRows = await sqlClient<MacroIndicatorRow[]>`
    SELECT DISTINCT ON (indicator_type)
      id, indicator_type, value::float8 AS value, effective_date::text AS effective_date
    FROM rl_macro_indicators
    ORDER BY indicator_type, effective_date DESC, created_at DESC
  `;

  const macroMap = new Map<string, number>();
  for (const row of macroRows) {
    macroMap.set(row.indicator_type, row.value);
  }

  const macroSnapshot: MacroSnapshot = {
    interest_rate: macroMap.get('interest_rate') ?? null,
    gdp_growth_rate: macroMap.get('gdp_growth_rate') ?? null,
    inflation_rate: macroMap.get('inflation_rate') ?? null,
  };

  // ── 2. Fetch SIC code for the entity ──────────────────────────────────────
  let sicCode: string | null = null;

  if (entity_type === 'prospect') {
    const rows = await sqlClient<ProspectSicRow[]>`
      SELECT sic_code FROM rl_prospects WHERE id = ${entity_id} LIMIT 1
    `;
    sicCode = rows[0]?.sic_code ?? null;
  } else {
    // For customers, follow the prospect FK.
    const rows = await sqlClient<ProspectSicRow[]>`
      SELECT p.sic_code
      FROM rl_customers c
      JOIN rl_prospects p ON p.id = c.prospect_id
      WHERE c.id = ${entity_id}
      LIMIT 1
    `;
    sicCode = rows[0]?.sic_code ?? null;
  }

  // ── 3. Fetch industry benchmark ────────────────────────────────────────────
  let industryRow: IndustryBenchmarkRow | null = null;
  if (sicCode) {
    const rows = await sqlClient<IndustryBenchmarkRow[]>`
      SELECT id, sic_code, growth_rate::float8 AS growth_rate,
             default_rate::float8 AS default_rate,
             payment_norm_days, effective_date::text AS effective_date
      FROM rl_industry_benchmarks
      WHERE sic_code = ${sicCode}
      ORDER BY effective_date DESC, created_at DESC
      LIMIT 1
    `;
    industryRow = rows[0] ?? null;
  }

  const industrySnapshot: IndustrySnapshot = {
    sic_code: sicCode,
    growth_rate: industryRow?.growth_rate ?? null,
    default_rate: industryRow?.default_rate ?? null,
    payment_norm_days: industryRow?.payment_norm_days ?? null,
  };

  // ── 4. Fetch KYC record ────────────────────────────────────────────────────
  //
  // For prospects, read from rl_kyc_records (the revenue lifecycle table).
  // For customers, follow the prospect FK to get their KYC record.
  let kycRow: KycRecordRow | null = null;

  if (entity_type === 'prospect') {
    const rows = await sqlClient<KycRecordRow[]>`
      SELECT id,
             annual_revenue_est::float8 AS annual_revenue_est,
             debt_load_est::float8 AS debt_load_est,
             funding_stage
      FROM rl_kyc_records
      WHERE prospect_id = ${entity_id}
        AND verification_status != 'archived'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    kycRow = rows[0] ?? null;
  } else {
    const rows = await sqlClient<KycRecordRow[]>`
      SELECT k.id,
             k.annual_revenue_est::float8 AS annual_revenue_est,
             k.debt_load_est::float8 AS debt_load_est,
             k.funding_stage
      FROM rl_customers c
      JOIN rl_prospects p ON p.id = c.prospect_id
      JOIN rl_kyc_records k ON k.prospect_id = p.id
      WHERE c.id = ${entity_id}
        AND k.verification_status != 'archived'
      ORDER BY k.created_at DESC
      LIMIT 1
    `;
    kycRow = rows[0] ?? null;
  }

  const companySnapshot: CompanySnapshot = {
    annual_revenue_est: kycRow?.annual_revenue_est ?? null,
    debt_load_est: kycRow?.debt_load_est ?? null,
    funding_stage: kycRow?.funding_stage ?? null,
    kyc_record_id: kycRow?.id ?? null,
  };

  // ── 5. Compute sub-scores ──────────────────────────────────────────────────
  const macroSubScore = computeMacroSubScore(macroSnapshot);
  const industrySubScore = computeIndustrySubScore(industrySnapshot);
  const companySubScore = computeCompanySubScore(companySnapshot);

  // ── 6. Weighted composite (normalised weights) ─────────────────────────────
  const totalWeight = config.weightMacro + config.weightIndustry + config.weightCompany;
  const wMacro = config.weightMacro / totalWeight;
  const wIndustry = config.weightIndustry / totalWeight;
  const wCompany = config.weightCompany / totalWeight;

  const compositeRaw =
    macroSubScore * wMacro + industrySubScore * wIndustry + companySubScore * wCompany;
  // Scale to 0–100 and round to 4 decimal places.
  const compositeScore = Math.round(compositeRaw * 100 * 10000) / 10000;

  // ── 7. Tier classification ─────────────────────────────────────────────────
  const tier = classifyTier(compositeScore, config);

  // ── 8. Rationale strings ───────────────────────────────────────────────────
  const rationaleM = buildMacroRationale(macroSnapshot, macroSubScore);
  const rationaleI = buildIndustryRationale(industrySnapshot, industrySubScore);
  const rationaleC = buildCompanyRationale(companySnapshot, companySubScore);

  // ── 9. score_version ───────────────────────────────────────────────────────
  const scoreVersion = computeScoreVersion(config);

  // ── 10. Write CLTVScore row ────────────────────────────────────────────────
  const [row] = await sqlClient<CLTVScoreRow[]>`
    INSERT INTO rl_cltv_scores (
      entity_id, entity_type,
      macro_score, industry_score, company_score,
      composite_score, tier,
      score_version,
      macro_inputs_snapshot, industry_inputs_snapshot, company_inputs_snapshot,
      rationale_macro, rationale_industry, rationale_company
    ) VALUES (
      ${entity_id}, ${entity_type},
      ${macroSubScore}, ${industrySubScore}, ${companySubScore},
      ${compositeScore}, ${tier},
      ${scoreVersion},
      ${sqlClient.json(macroSnapshot as never)},
      ${sqlClient.json(industrySnapshot as never)},
      ${sqlClient.json(companySnapshot as never)},
      ${rationaleM}, ${rationaleI}, ${rationaleC}
    )
    RETURNING
      id, entity_id, entity_type, tier, score_version,
      macro_inputs_snapshot, industry_inputs_snapshot, company_inputs_snapshot,
      rationale_macro, rationale_industry, rationale_company,
      computed_at, created_at,
      macro_score::float8 AS macro_score,
      industry_score::float8 AS industry_score,
      company_score::float8 AS company_score,
      composite_score::float8 AS composite_score
  `;

  return row;
}
