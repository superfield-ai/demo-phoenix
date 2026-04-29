/**
 * @file ar-aging.ts
 *
 * Database query functions for the AR Aging dashboard (issue #16).
 *
 * Exports:
 *   getArAging        — bucket totals + 12-month trend snapshots
 *   getArAgingInvoices — invoice list for a given aging bucket
 *
 * Aging bucket definitions (based on days between today and due_date):
 *   current  — due_date >= today  (not yet overdue)
 *   30       — 1–30 days overdue
 *   60       — 31–60 days overdue
 *   90       — 61–90 days overdue
 *   120+     — 91+ days overdue
 *
 * Only invoices in status 'sent', 'partial_paid', 'overdue', or 'in_collection'
 * are considered receivables. Terminal statuses (paid, settled, written_off, draft)
 * are excluded.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/16
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgingBucket = 'current' | '30' | '60' | '90' | '120+';

export interface ArAgingBuckets {
  current: number;
  '30': number;
  '60': number;
  '90': number;
  '120+': number;
}

/** One monthly snapshot entry for the 12-month trend line. */
export interface ArAgingMonthlySnapshot {
  /** Month label in YYYY-MM format, e.g. "2024-03". */
  month: string;
  buckets: ArAgingBuckets;
}

export interface ArAgingResponse {
  /** Current bucket totals (sum of invoice amounts). */
  buckets: ArAgingBuckets;
  /** 12 most-recent monthly snapshots, ordered oldest-first. */
  trend: ArAgingMonthlySnapshot[];
}

/** One row in the invoice drilldown for a specific aging bucket. */
export interface ArAgingInvoiceRow {
  invoice_id: string;
  customer_name: string;
  amount: number;
  due_date: string;
  days_overdue: number;
  status: string;
  assigned_agent_name: string | null;
  collection_case_open: boolean;
  collection_case_escalation_level: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECEIVABLE_STATUSES_LITERAL = `('sent','partial_paid','overdue','in_collection')`;

/** Convert a raw bucket query row into a typed ArAgingBuckets object. */
function rowsToBuckets(rows: { bucket: string; total: string }[]): ArAgingBuckets {
  const result: ArAgingBuckets = { current: 0, '30': 0, '60': 0, '90': 0, '120+': 0 };
  for (const row of rows) {
    const key = row.bucket as AgingBucket;
    if (key in result) {
      result[key] = Math.round(parseFloat(row.total));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// getArAging
// ---------------------------------------------------------------------------

/**
 * Returns current AR aging bucket totals and a 12-month trend line.
 *
 * The trend line approximates the historical aging profile by assigning each
 * invoice to a bucket relative to the last day of each calendar month.
 *
 * @param sqlClient Optional postgres.js client (defaults to the app pool).
 */
export async function getArAging(sqlClient: postgres.Sql = defaultSql): Promise<ArAgingResponse> {
  // ── Current bucket totals ────────────────────────────────────────────────
  const bucketRows = await sqlClient.unsafe<{ bucket: string; total: string }[]>(`
    SELECT
      CASE
        WHEN due_date >= CURRENT_DATE THEN 'current'
        WHEN due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '30'
        WHEN due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '60'
        WHEN due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '90'
        ELSE '120+'
      END AS bucket,
      COALESCE(SUM(amount), 0) AS total
    FROM rl_invoices
    WHERE status IN ${RECEIVABLE_STATUSES_LITERAL}
      AND due_date IS NOT NULL
    GROUP BY bucket
  `);

  const buckets = rowsToBuckets(bucketRows);

  // ── 12-month trend line ──────────────────────────────────────────────────
  // For each of the last 12 calendar months (including the current month),
  // compute the aging profile relative to the last day of that month.
  //
  // Approximation: we use receivable invoices that exist today and whose
  // due_date falls within the 12-month lookback window. This is a display-only
  // approximation suitable for trend visualisation.
  const trendRows = await sqlClient.unsafe<
    {
      month: string;
      bucket: string;
      total: string;
    }[]
  >(`
    WITH months AS (
      SELECT
        TO_CHAR(DATE_TRUNC('month', CURRENT_DATE) - (gs.n * INTERVAL '1 month'), 'YYYY-MM') AS month,
        (DATE_TRUNC('month', CURRENT_DATE) - (gs.n * INTERVAL '1 month') + INTERVAL '1 month - 1 day')::DATE AS month_end
      FROM generate_series(0, 11) AS gs(n)
    )
    SELECT
      m.month,
      CASE
        WHEN i.due_date >= m.month_end THEN 'current'
        WHEN i.due_date >= m.month_end - INTERVAL '30 days' THEN '30'
        WHEN i.due_date >= m.month_end - INTERVAL '60 days' THEN '60'
        WHEN i.due_date >= m.month_end - INTERVAL '90 days' THEN '90'
        ELSE '120+'
      END AS bucket,
      COALESCE(SUM(i.amount), 0) AS total
    FROM months m
    JOIN rl_invoices i
      ON i.due_date BETWEEN m.month_end - INTERVAL '11 months' AND m.month_end
    WHERE i.status IN ${RECEIVABLE_STATUSES_LITERAL}
      AND i.due_date IS NOT NULL
    GROUP BY m.month, bucket
    ORDER BY m.month ASC
  `);

  // Collect the trend data into a map keyed by month.
  const monthMap = new Map<string, ArAgingBuckets>();
  for (const row of trendRows) {
    if (!monthMap.has(row.month)) {
      monthMap.set(row.month, { current: 0, '30': 0, '60': 0, '90': 0, '120+': 0 });
    }
    const entry = monthMap.get(row.month)!;
    const key = row.bucket as AgingBucket;
    if (key in entry) {
      entry[key] = Math.round(parseFloat(row.total));
    }
  }

  // Ensure all 12 months are represented (oldest first).
  const trend: ArAgingMonthlySnapshot[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    trend.push({
      month,
      buckets: monthMap.get(month) ?? { current: 0, '30': 0, '60': 0, '90': 0, '120+': 0 },
    });
  }

  return { buckets, trend };
}

// ---------------------------------------------------------------------------
// getArAgingInvoices
// ---------------------------------------------------------------------------

/**
 * Returns the invoice drilldown list for a specific aging bucket.
 *
 * Results are sorted by amount descending. Each row includes the open
 * CollectionCase status (if any).
 *
 * @param bucket  The bucket ('current' | '30' | '60' | '90' | '120+').
 * @param sqlClient Optional postgres.js client (defaults to the app pool).
 */
export async function getArAgingInvoices(
  bucket: AgingBucket,
  sqlClient: postgres.Sql = defaultSql,
): Promise<ArAgingInvoiceRow[]> {
  // The bucket value is validated by the API layer before reaching here.
  // The CASE expression is fully static; only the bucket string literal
  // is interpolated, and it is constrained to the AgingBucket union type.
  // Using .unsafe() avoids postgres.js parameter-binding issues with CASE
  // expressions that contain quoted string literals.
  const escapedBucket = bucket.replace(/'/g, "''"); // prevent SQL injection (bucket is always a known literal)
  const rows = await sqlClient.unsafe<
    {
      invoice_id: string;
      customer_name: string;
      amount: string;
      due_date: string;
      days_overdue: string;
      status: string;
      assigned_agent_name: string | null;
      collection_case_open: boolean;
      collection_case_escalation_level: number | null;
    }[]
  >(`
    SELECT
      i.id                                    AS invoice_id,
      c.company_name                          AS customer_name,
      i.amount                                AS amount,
      i.due_date::TEXT                        AS due_date,
      GREATEST(0, CURRENT_DATE - i.due_date)  AS days_overdue,
      i.status                                AS status,
      e.properties->>'username'               AS assigned_agent_name,
      (cc.id IS NOT NULL)                     AS collection_case_open,
      cc.escalation_level                     AS collection_case_escalation_level
    FROM rl_invoices i
    JOIN rl_customers c ON c.id = i.customer_id
    LEFT JOIN rl_collection_cases cc
      ON cc.invoice_id = i.id
      AND cc.status = 'open'
    LEFT JOIN entities e
      ON e.id = cc.agent_id
      AND e.type = 'user'
    WHERE i.status IN ${RECEIVABLE_STATUSES_LITERAL}
      AND i.due_date IS NOT NULL
      AND (
        CASE
          WHEN i.due_date >= CURRENT_DATE THEN 'current'
          WHEN i.due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '30'
          WHEN i.due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '60'
          WHEN i.due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '90'
          ELSE '120+'
        END
      ) = '${escapedBucket}'
    ORDER BY i.amount DESC
  `);

  return rows.map((row) => ({
    invoice_id: row.invoice_id,
    customer_name: row.customer_name,
    amount: Math.round(parseFloat(row.amount)),
    due_date: row.due_date,
    days_overdue: parseInt(String(row.days_overdue), 10),
    status: row.status,
    assigned_agent_name: row.assigned_agent_name ?? null,
    collection_case_open: Boolean(row.collection_case_open),
    collection_case_escalation_level:
      row.collection_case_escalation_level != null
        ? Number(row.collection_case_escalation_level)
        : null,
  }));
}
