/**
 * @file cfo-report-delivery.test.ts
 *
 * Unit tests for the CFO report delivery cron job helpers (issue #18).
 *
 * Tests the pure schedule-gating logic (`isDeliveryDue`) and the CSV renderer
 * (`renderSummaryCsv`) without any database or email infrastructure.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/18
 */

import { describe, test, expect } from 'vitest';
import { isDeliveryDue, renderSummaryCsv } from './cfo-report-delivery';

// ─────────────────────────────────────────────────────────────────────────────
// isDeliveryDue
// ─────────────────────────────────────────────────────────────────────────────

describe('isDeliveryDue', () => {
  // 2026-04-27 is a Monday (day-of-week = 1)
  const monday = new Date('2026-04-27T07:00:00Z');
  // 2026-04-28 is a Tuesday
  const tuesday = new Date('2026-04-28T07:00:00Z');
  // 2026-04-01 is the 1st of the month
  const firstOfMonth = new Date('2026-04-01T07:00:00Z');
  // 2026-04-15 is mid-month
  const midMonth = new Date('2026-04-15T07:00:00Z');

  test('weekly is due on Monday', () => {
    expect(isDeliveryDue('weekly', monday)).toBe(true);
  });

  test('weekly is not due on Tuesday', () => {
    expect(isDeliveryDue('weekly', tuesday)).toBe(false);
  });

  test('monthly is due on the 1st', () => {
    expect(isDeliveryDue('monthly', firstOfMonth)).toBe(true);
  });

  test('monthly is not due mid-month', () => {
    expect(isDeliveryDue('monthly', midMonth)).toBe(false);
  });

  test('weekly is not due on the 1st when the 1st is not a Monday', () => {
    // 2026-04-01 is a Wednesday
    expect(isDeliveryDue('weekly', firstOfMonth)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderSummaryCsv
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_SUMMARY = {
  pipeline_by_tier: { A: 4_000_000, B: 1_500_000, C: 500_000 },
  weighted_close_rate: 0.857,
  ar_aging_buckets: { current: 100, '30': 200, '60': 300, '90': 400, '120+': 500 },
  collection_recovery_rate_90d: 0.625,
  active_score_model_version: 'v2',
};

describe('renderSummaryCsv', () => {
  test('includes scenario_state block with default values', () => {
    const csv = renderSummaryCsv(MOCK_SUMMARY);
    expect(csv).toContain('# scenario_state');
    expect(csv).toContain('interest_rate_delta');
    expect(csv).toContain('"0"');
    expect(csv).toContain('"moderate"');
  });

  test('includes pipeline_by_tier section', () => {
    const csv = renderSummaryCsv(MOCK_SUMMARY);
    expect(csv).toContain('# pipeline_by_tier');
    expect(csv).toContain('"A"');
    expect(csv).toContain('"4000000"');
    expect(csv).toContain('"B"');
    expect(csv).toContain('"1500000"');
    expect(csv).toContain('"C"');
    expect(csv).toContain('"500000"');
  });

  test('includes summary_metrics section', () => {
    const csv = renderSummaryCsv(MOCK_SUMMARY);
    expect(csv).toContain('# summary_metrics');
    expect(csv).toContain('weighted_close_rate');
    expect(csv).toContain('collection_recovery_rate_90d');
    expect(csv).toContain('active_score_model_version');
    expect(csv).toContain('"v2"');
  });

  test('includes ar_aging_buckets section', () => {
    const csv = renderSummaryCsv(MOCK_SUMMARY);
    expect(csv).toContain('# ar_aging_buckets');
    expect(csv).toContain('"current"');
    expect(csv).toContain('"100"');
    expect(csv).toContain('"120+"');
    expect(csv).toContain('"500"');
  });

  test('handles null active_score_model_version', () => {
    const csv = renderSummaryCsv({ ...MOCK_SUMMARY, active_score_model_version: null });
    expect(csv).toContain('active_score_model_version');
    // Version cell should be an empty quoted string.
    expect(csv).toContain('""');
  });
});
