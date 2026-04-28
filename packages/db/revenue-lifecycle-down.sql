-- ============================================================================
-- Down migration: revenue-lifecycle-001 (issue #3)
--
-- Removes all objects created by the revenue lifecycle up migration from
-- schema.sql. Run this to roll back to the pre-migration state.
--
-- Execution order: dependent tables first, then parent tables, then types.
-- Canonical docs: docs/prd.md §5 Data Model
-- ============================================================================

-- Drop triggers and functions (CASCADE removes the trigger automatically)
DROP FUNCTION IF EXISTS guard_invoice_status_transition() CASCADE;

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS rl_industry_benchmarks;
DROP TABLE IF EXISTS rl_macro_indicators;
DROP TABLE IF EXISTS rl_interventions;
DROP TABLE IF EXISTS rl_payment_plans;
DROP TABLE IF EXISTS rl_collection_cases;
DROP TABLE IF EXISTS rl_dunning_actions;
DROP TABLE IF EXISTS rl_payments;
DROP TABLE IF EXISTS rl_invoices;
DROP TABLE IF EXISTS rl_deals;
DROP TABLE IF EXISTS rl_customers;
DROP TABLE IF EXISTS rl_cltv_scores;
DROP TABLE IF EXISTS rl_kyc_records;
DROP TABLE IF EXISTS rl_prospects;

-- Drop the invoice_status enum type
DROP TYPE IF EXISTS invoice_status;

-- Drop revenue lifecycle roles.
-- Tables have already been dropped above, so any table-level privileges granted
-- to these roles no longer exist. However PostgreSQL tracks schema usage grants
-- separately; revoke those first so the roles can be cleanly dropped.
DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['sales_rep','collections_agent','finance_controller','cfo','account_manager']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA public FROM ' || quote_ident(r);
      EXECUTE 'DROP ROLE ' || quote_ident(r);
    END IF;
  END LOOP;
END;
$$;

-- Remove migration version record
DELETE FROM _schema_version WHERE migration = 'revenue-lifecycle-001';
