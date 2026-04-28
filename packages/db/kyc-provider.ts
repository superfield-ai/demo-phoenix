/**
 * @file kyc-provider
 *
 * KYC (Know Your Customer) provider interface, record types, and deterministic
 * stub implementation for Phase 0 (P0-2).
 *
 * ## Architecture
 *
 * The integration is built around a single abstract boundary — the `KycProvider`
 * interface. Application code (the KYC_VERIFY task worker) always calls through
 * this interface; it never imports the stub or any real adapter directly. The
 * correct implementation is injected at runtime based on the FEATURE_KYC_PROVIDER
 * environment variable:
 *
 *   FEATURE_KYC_PROVIDER=stub  → StubKycProvider (default in development/test)
 *   FEATURE_KYC_PROVIDER=real  → RealKycProvider (placeholder; real HTTP adapter TBD)
 *
 * Swapping from stub to real requires only an adapter change inside this module —
 * no call sites, no tests, no task-worker code changes.
 *
 * ## Determinism guarantee (StubKycProvider)
 *
 * The stub derives all KYCRecord fields from a SHA-256 hash of the prospectId
 * string, ensuring that identical inputs always produce identical outputs across
 * processes, restarts, and test runs. This is intentional: the determinism check
 * in the test plan can be validated mechanically.
 *
 * ## KYCRecord fields
 *
 * | Field                | Source                                        |
 * |----------------------|-----------------------------------------------|
 * | verification_status  | hash byte 0 mod 10 ≥ 2 → pass, else fail      |
 * | funding_stage        | hash byte 1 mod 5 → one of five stage labels  |
 * | annual_revenue_est   | hash bytes 2-5 → integer in [0, 10 000 000)   |
 * | debt_load_est        | hash bytes 6-9 → integer in [0,  5 000 000)   |
 * | checked_at           | current wall clock (not derived from hash)    |
 *
 * The stub sets `provider = 'stub'`.
 *
 * ## Database helpers
 *
 * `createProspect` and `writeKycRecord` provide typed access to the `prospects`
 * and `kyc_records` tables. The KYC_VERIFY task worker calls these helpers; it
 * does not write raw SQL.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/4
 */

import { createHash } from 'crypto';
import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// Prospect types and DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KYC status values for the `prospects.kyc_status` column.
 * These mirror the CHECK constraint in schema.sql.
 */
export type KycStatus = 'pending_kyc' | 'kyc_passed' | 'kyc_failed' | 'kyc_manual_review';

/** Row shape for the `prospects` table. */
export interface ProspectRow {
  id: string;
  name: string;
  email: string;
  company: string;
  funding_stage: string | null;
  annual_revenue_est: number | null;
  kyc_status: KycStatus;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProspectOptions {
  name: string;
  email: string;
  company?: string;
  funding_stage?: string;
  annual_revenue_est?: number;
  created_by: string;
}

/**
 * Inserts a new Prospect row and returns it.
 * The initial `kyc_status` is always `pending_kyc`.
 *
 * @param options   Field values for the new prospect.
 * @param sqlClient Optional sql client override (for tests using a pg-container).
 */
export async function createProspect(
  options: CreateProspectOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<ProspectRow> {
  const {
    name,
    email,
    company = '',
    funding_stage = null,
    annual_revenue_est = null,
    created_by,
  } = options;

  const [row] = await sqlClient<ProspectRow[]>`
    INSERT INTO prospects (name, email, company, funding_stage, annual_revenue_est, created_by)
    VALUES (${name}, ${email}, ${company}, ${funding_stage}, ${annual_revenue_est}, ${created_by})
    RETURNING *
  `;
  return row;
}

/**
 * Updates the `kyc_status` column on a Prospect row.
 *
 * @param prospectId  The prospect to update.
 * @param status      The new KYC status.
 * @param sqlClient   Optional sql client override.
 */
export async function updateProspectKycStatus(
  prospectId: string,
  status: KycStatus,
  sqlClient: postgres.Sql = defaultSql,
): Promise<ProspectRow | null> {
  const rows = await sqlClient<ProspectRow[]>`
    UPDATE prospects
    SET kyc_status = ${status}, updated_at = NOW()
    WHERE id = ${prospectId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// KYCRecord types and DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verification status values from the KYC provider.
 * These mirror the CHECK constraint in schema.sql.
 */
export type VerificationStatus = 'pass' | 'fail' | 'insufficient_data';

/** The result of a KYC verification check — stored in the `kyc_records` table. */
export interface KYCRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `prospects.id`. */
  prospect_id: string;
  /** Outcome of the check. */
  verification_status: VerificationStatus;
  /** Provider-determined funding stage (e.g. "seed", "series_a"). Nullable. */
  funding_stage: string | null;
  /** Provider-determined annual revenue estimate in USD cents. Nullable. */
  annual_revenue_est: number | null;
  /** Provider-determined debt load estimate in USD cents. Nullable. */
  debt_load_est: number | null;
  /** When the provider performed the check. */
  checked_at: Date;
  /** Which provider produced this record. */
  provider: string;
  created_at: Date;
}

export interface WriteKycRecordOptions {
  prospect_id: string;
  verification_status: VerificationStatus;
  funding_stage?: string | null;
  annual_revenue_est?: number | null;
  debt_load_est?: number | null;
  checked_at: Date;
  provider?: string;
}

/**
 * Inserts a KYCRecord row and returns it.
 *
 * @param options   Field values for the new record.
 * @param sqlClient Optional sql client override.
 */
export async function writeKycRecord(
  options: WriteKycRecordOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<KYCRecord> {
  const {
    prospect_id,
    verification_status,
    funding_stage = null,
    annual_revenue_est = null,
    debt_load_est = null,
    checked_at,
    provider = 'stub',
  } = options;

  const [row] = await sqlClient<KYCRecord[]>`
    INSERT INTO kyc_records
      (prospect_id, verification_status, funding_stage, annual_revenue_est, debt_load_est, checked_at, provider)
    VALUES
      (${prospect_id}, ${verification_status}, ${funding_stage}, ${annual_revenue_est}, ${debt_load_est}, ${checked_at}, ${provider})
    RETURNING *
  `;
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// KycProvider interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract KYC provider interface.
 *
 * All application code calls `verify(prospectId)` through this interface.
 * The concrete implementation is selected at startup via `resolveKycProvider`.
 *
 * Contract:
 * - MUST return a `KYCRecord` on success.
 * - MUST throw (or return a record with `verification_status: 'fail'` or
 *   `'insufficient_data'`) to signal that the prospect should be placed into
 *   `kyc_manual_review`.
 * - MUST NOT write to the database — the task worker owns the write path.
 *
 * Swap rule: replacing the stub with a real adapter requires no changes outside
 * this module. The task worker, the enqueue call, and the tests are
 * implementation-agnostic.
 */
export interface KycProvider {
  /**
   * Runs a KYC verification check for the given prospect.
   *
   * @param prospectId  The `prospects.id` UUID of the prospect to check.
   * @returns A `KYCRecord` (without `id`, `prospect_id`, or `created_at` —
   *          those are assigned by `writeKycRecord`). The `checked_at` field
   *          must be populated by the implementation.
   */
  verify(prospectId: string): Promise<Omit<KYCRecord, 'id' | 'prospect_id' | 'created_at'>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// StubKycProvider — deterministic, hash-derived results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Funding stage labels returned by the stub, indexed by `hash[1] % 5`.
 */
const STUB_FUNDING_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'growth'] as const;

/**
 * Deterministic stub implementation of `KycProvider`.
 *
 * All fields are derived from a SHA-256 hash of `prospectId` so that identical
 * inputs always produce identical outputs. This property is tested explicitly in
 * the integration test suite (determinism check).
 *
 * ## Field derivation
 *
 * | Field                | Derivation                                              |
 * |----------------------|---------------------------------------------------------|
 * | verification_status  | `hash[0] % 10 >= 2` → `"pass"`, else `"fail"`           |
 * | funding_stage        | `STUB_FUNDING_STAGES[hash[1] % 5]`                      |
 * | annual_revenue_est   | `readUInt32BE(hash, 2) % 10_000_000`  (USD cents)       |
 * | debt_load_est        | `readUInt32BE(hash, 6) % 5_000_000`   (USD cents)       |
 * | checked_at           | current wall clock (not hash-derived)                   |
 *
 * The stub intentionally makes ~80 % of prospects pass KYC so the demo sales
 * queue is populated with usable leads out of the box.
 *
 * To simulate an `insufficient_data` result for testing, use a prospectId that
 * has `hash[0] % 10 === 1` (exactly). This is rare (~10 %) and can be forced
 * in tests by iterating prospect IDs until the desired hash bucket is hit, or
 * by constructing a specific UUID whose SHA-256 hash satisfies the condition.
 *
 * In practice, the test plan uses a `fail` result path (hash[0] % 10 < 2,
 * i.e. hash[0] % 10 === 0) to trigger `kyc_manual_review`.
 */
export class StubKycProvider implements KycProvider {
  async verify(prospectId: string): Promise<Omit<KYCRecord, 'id' | 'prospect_id' | 'created_at'>> {
    const hash = createHash('sha256').update(prospectId, 'utf8').digest();

    const bucket = hash[0]! % 10;
    let verification_status: VerificationStatus;
    if (bucket >= 2) {
      verification_status = 'pass';
    } else if (bucket === 1) {
      verification_status = 'insufficient_data';
    } else {
      // bucket === 0
      verification_status = 'fail';
    }

    const funding_stage = STUB_FUNDING_STAGES[hash[1]! % STUB_FUNDING_STAGES.length]!;
    const annual_revenue_est = hash.readUInt32BE(2) % 10_000_000;
    const debt_load_est = hash.readUInt32BE(6) % 5_000_000;

    return {
      verification_status,
      funding_stage,
      annual_revenue_est,
      debt_load_est,
      checked_at: new Date(),
      provider: 'stub',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RealKycProvider — placeholder skeleton
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Skeletal real provider class — satisfies the `KycProvider` interface so the
 * test plan can assert both implementations compile without errors.
 *
 * This is intentionally a minimal stub: the real HTTP adapter will be
 * implemented once the provider is selected (out of scope for P0-2).
 *
 * To activate: set `FEATURE_KYC_PROVIDER=real` in the environment and supply
 * KYC_PROVIDER_API_KEY. Until then this class will throw on every call.
 */
export class RealKycProvider implements KycProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async verify(_prospectId: string): Promise<Omit<KYCRecord, 'id' | 'prospect_id' | 'created_at'>> {
    // Real HTTP integration TBD. When implemented, use this.apiKey to
    // authenticate with the selected KYC provider and map the response to
    // a KYCRecord. Do not change call sites or the worker handler — only
    // the body of this method changes.
    throw new Error(
      'RealKycProvider: HTTP adapter not yet implemented. ' +
        'Set FEATURE_KYC_PROVIDER=stub for development.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory — resolves the active provider from environment variables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the active `KycProvider` implementation from environment variables.
 *
 * | FEATURE_KYC_PROVIDER | Result                                      |
 * |----------------------|---------------------------------------------|
 * | `stub` (default)     | `StubKycProvider`                           |
 * | `real`               | `RealKycProvider` (needs KYC_PROVIDER_API_KEY) |
 *
 * Swapping from stub to real requires no changes outside this function.
 *
 * @param env Defaults to `process.env`. Pass a custom object in tests.
 */
export function resolveKycProvider(env: NodeJS.ProcessEnv = process.env): KycProvider {
  const variant = env.FEATURE_KYC_PROVIDER ?? 'stub';

  if (variant === 'real') {
    const apiKey = env.KYC_PROVIDER_API_KEY ?? '';
    return new RealKycProvider(apiKey);
  }

  // Default: stub
  return new StubKycProvider();
}
