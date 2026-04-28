/**
 * @file revenue-lifecycle-schema.test.ts
 *
 * Integration tests for the Phase 0 revenue lifecycle schema migration (issue #3).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## What is tested (acceptance criteria)
 *
 * AC-1  Up migration creates all 13 entity tables.
 * AC-2  Invoice status transition draft → in_collection is rejected by the DB.
 * AC-3  Inserting a second active KYCRecord for the same prospect is rejected.
 * AC-4  Inserting a second open CollectionCase for the same invoice is rejected.
 * AC-5  All five named roles can be created and granted permissions without error.
 * AC-6  Down migration removes all 13 tables and the migration version record.
 *
 * ## Test plan items
 *
 * TP-1  Run up migration; assert all 13 tables exist via information_schema.
 * TP-2  Attempt draft → in_collection transition; assert constraint violation.
 * TP-3  Insert two active KYCRecord rows for same prospect; assert second fails.
 * TP-4  Insert two open CollectionCase rows for same invoice; assert second fails.
 * TP-5  CREATE ROLE for each of the five named roles; assert pg_has_role checks pass.
 * TP-6  Run down migration; assert no revenue-lifecycle tables remain.
 *
 * Canonical docs: docs/prd.md §5 Data Model
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate, splitSqlStatements } from './index';
import { configureRevenueLicycleRoles } from './init-remote';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  // Apply full schema (creates all baseline tables + revenue lifecycle tables).
  await migrate({ databaseUrl: pg.url });

  // Provision revenue lifecycle roles and grants (requires superuser — runs on
  // the admin connection, matching the runInitRemote production path).
  await configureRevenueLicycleRoles(sql);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1 / AC-1: Up migration creates all 13 entity tables
// ---------------------------------------------------------------------------

const REVENUE_LIFECYCLE_TABLES = [
  'rl_prospects',
  'rl_kyc_records',
  'rl_cltv_scores',
  'rl_customers',
  'rl_deals',
  'rl_invoices',
  'rl_payments',
  'rl_dunning_actions',
  'rl_collection_cases',
  'rl_payment_plans',
  'rl_interventions',
  'rl_macro_indicators',
  'rl_industry_benchmarks',
] as const;

async function existingTables(
  db: ReturnType<typeof postgres>,
  tableNames: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const name of tableNames) {
    const rows = await db<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists
    `;
    if (rows[0]?.exists) found.add(name);
  }
  return found;
}

describe('up migration — AC-1 / TP-1', () => {
  test('all 13 revenue lifecycle tables exist in information_schema after migration', async () => {
    const found = await existingTables(sql, REVENUE_LIFECYCLE_TABLES);
    for (const table of REVENUE_LIFECYCLE_TABLES) {
      expect(found.has(table), `Expected table "${table}" to exist after migration`).toBe(true);
    }
  });

  test('migration version record revenue-lifecycle-001 is recorded in _schema_version', async () => {
    const rows = await sql`
      SELECT migration FROM _schema_version WHERE migration = 'revenue-lifecycle-001'
    `;
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TP-2 / AC-2: Invoice status transition draft → in_collection is rejected
// ---------------------------------------------------------------------------

describe('invoice status transition constraint — AC-2 / TP-2', () => {
  test('draft → in_collection is rejected with a constraint violation', async () => {
    // Insert a minimal customer so the FK is satisfied.
    const [customer] = await sql`
      INSERT INTO rl_customers (company_name) VALUES ('Constraint Test Co')
      RETURNING id
    `;

    // Insert an invoice in draft status.
    const [invoice] = await sql`
      INSERT INTO rl_invoices (customer_id, amount, status)
      VALUES (${customer.id}, 1000.00, 'draft')
      RETURNING id
    `;

    // Attempt illegal transition: draft → in_collection (skips sent/overdue).
    await expect(
      sql`UPDATE rl_invoices SET status = 'in_collection' WHERE id = ${invoice.id}`,
    ).rejects.toThrow();
  });

  test('draft → sent → overdue → in_collection succeeds (valid path)', async () => {
    const [customer] = await sql`
      INSERT INTO rl_customers (company_name) VALUES ('Valid Transition Co')
      RETURNING id
    `;

    const [invoice] = await sql`
      INSERT INTO rl_invoices (customer_id, amount, status)
      VALUES (${customer.id}, 500.00, 'draft')
      RETURNING id
    `;

    await sql`UPDATE rl_invoices SET status = 'sent' WHERE id = ${invoice.id}`;
    await sql`UPDATE rl_invoices SET status = 'overdue' WHERE id = ${invoice.id}`;
    await sql`UPDATE rl_invoices SET status = 'in_collection' WHERE id = ${invoice.id}`;

    const [row] = await sql`SELECT status FROM rl_invoices WHERE id = ${invoice.id}`;
    expect(row.status).toBe('in_collection');
  });
});

// ---------------------------------------------------------------------------
// TP-3 / AC-3: At most one active KYCRecord per Prospect
// ---------------------------------------------------------------------------

describe('KYCRecord active uniqueness constraint — AC-3 / TP-3', () => {
  test('second active KYCRecord for same prospect is rejected', async () => {
    const [prospect] = await sql`
      INSERT INTO rl_prospects (company_name) VALUES ('KYC Uniqueness Corp')
      RETURNING id
    `;

    // Insert first active record — should succeed.
    await sql`
      INSERT INTO rl_kyc_records (prospect_id, verification_status)
      VALUES (${prospect.id}, 'verified')
    `;

    // Insert second active record — must fail on the partial unique index.
    await expect(
      sql`
        INSERT INTO rl_kyc_records (prospect_id, verification_status)
        VALUES (${prospect.id}, 'verified')
      `,
    ).rejects.toThrow();
  });

  test('archiving the first record allows a new active record', async () => {
    const [prospect] = await sql`
      INSERT INTO rl_prospects (company_name) VALUES ('KYC Re-check Corp')
      RETURNING id
    `;

    const [first] = await sql`
      INSERT INTO rl_kyc_records (prospect_id, verification_status)
      VALUES (${prospect.id}, 'verified')
      RETURNING id
    `;

    // Archive the first record.
    await sql`
      UPDATE rl_kyc_records SET verification_status = 'archived' WHERE id = ${first.id}
    `;

    // Now a new active record should be accepted.
    await sql`
      INSERT INTO rl_kyc_records (prospect_id, verification_status)
      VALUES (${prospect.id}, 'pending')
    `;

    const rows = await sql`
      SELECT id FROM rl_kyc_records
      WHERE prospect_id = ${prospect.id} AND verification_status != 'archived'
    `;
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TP-4 / AC-4: At most one open CollectionCase per Invoice
// ---------------------------------------------------------------------------

describe('CollectionCase open uniqueness constraint — AC-4 / TP-4', () => {
  test('second open CollectionCase for same invoice is rejected', async () => {
    const [customer] = await sql`
      INSERT INTO rl_customers (company_name) VALUES ('Collection Uniqueness Co')
      RETURNING id
    `;

    // Build invoice in a state that allows a collection case (in_collection).
    const [invoice] = await sql`
      INSERT INTO rl_invoices (customer_id, amount, status)
      VALUES (${customer.id}, 2000.00, 'draft')
      RETURNING id
    `;
    await sql`UPDATE rl_invoices SET status = 'sent' WHERE id = ${invoice.id}`;
    await sql`UPDATE rl_invoices SET status = 'overdue' WHERE id = ${invoice.id}`;
    await sql`UPDATE rl_invoices SET status = 'in_collection' WHERE id = ${invoice.id}`;

    // Insert first open case — should succeed.
    await sql`
      INSERT INTO rl_collection_cases (invoice_id, status)
      VALUES (${invoice.id}, 'open')
    `;

    // Insert second open case — must fail on the partial unique index.
    await expect(
      sql`
        INSERT INTO rl_collection_cases (invoice_id, status)
        VALUES (${invoice.id}, 'open')
      `,
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TP-5 / AC-5: Five named roles exist and accept GRANT statements
// ---------------------------------------------------------------------------

describe('PostgreSQL role definitions — AC-5 / TP-5', () => {
  const ROLES = [
    'sales_rep',
    'collections_agent',
    'finance_controller',
    'cfo',
    'account_manager',
  ] as const;

  test('all five named roles exist in pg_roles after migration', async () => {
    const rows = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
      WHERE rolname = ANY(${sql.array(ROLES as unknown as string[])})
    `;
    const found = new Set(rows.map((r) => r.rolname));
    for (const role of ROLES) {
      expect(found.has(role), `Expected role "${role}" to exist`).toBe(true);
    }
  });

  test('sales_rep has SELECT on rl_prospects', async () => {
    const rows = await sql`
      SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'rl_prospects'
        AND grantee = 'sales_rep'
        AND privilege_type = 'SELECT'
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  test('collections_agent has INSERT and UPDATE on rl_collection_cases', async () => {
    const rows = await sql`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'rl_collection_cases'
        AND grantee = 'collections_agent'
    `;
    const privileges = new Set(rows.map((r) => r.privilege_type));
    expect(privileges.has('INSERT')).toBe(true);
    expect(privileges.has('UPDATE')).toBe(true);
  });

  test('cfo has SELECT on rl_macro_indicators and rl_industry_benchmarks', async () => {
    for (const table of ['rl_macro_indicators', 'rl_industry_benchmarks']) {
      const rows = await sql`
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE table_name = ${table}
          AND grantee = 'cfo'
          AND privilege_type = 'SELECT'
      `;
      expect(rows.length, `cfo should have SELECT on ${table}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-6 / AC-6: Down migration cleanly removes all created objects
// ---------------------------------------------------------------------------

describe('down migration — AC-6 / TP-6', () => {
  test('running the down migration removes all 13 revenue lifecycle tables', async () => {
    // Apply down migration.
    const downSql = readFileSync(resolve(__dirname, 'revenue-lifecycle-down.sql'), 'utf-8');

    // Use splitSqlStatements which correctly handles dollar-quoted PL/pgSQL blocks.
    const cleanSql = downSql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const statements = splitSqlStatements(cleanSql).filter((s) => s.length > 0);

    for (const stmt of statements) {
      await sql.unsafe(stmt);
    }

    // Verify tables are gone.
    const found = await existingTables(sql, REVENUE_LIFECYCLE_TABLES);
    expect(found.size).toBe(0);
  });

  test('migration version record is removed after down migration', async () => {
    const rows = await sql`
      SELECT migration FROM _schema_version WHERE migration = 'revenue-lifecycle-001'
    `;
    expect(rows.length).toBe(0);
  });

  test('re-running the up migration after down migration succeeds (round-trip)', async () => {
    // Re-apply schema — this exercises full round-trip idempotency.
    await migrate({ databaseUrl: pg.url });

    const found = await existingTables(sql, REVENUE_LIFECYCLE_TABLES);
    for (const table of REVENUE_LIFECYCLE_TABLES) {
      expect(found.has(table), `Expected "${table}" to exist after re-applying migration`).toBe(
        true,
      );
    }
  });
});
