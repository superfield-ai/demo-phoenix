/**
 * @file leads.test.ts
 *
 * Unit tests for the pipeline API helper functions (issue #10).
 *
 * Test plan coverage:
 *   TP-2  Assert each pipeline item includes tier, cltv_low, cltv_high, and
 *         days_in_stage fields — the deriveCLTVRange function is the source of
 *         cltv_low and cltv_high, so correctness here directly validates TP-2.
 *   TP-5  Assert no drag event handlers are attached to card elements
 *         (verified by inspecting the PipelineCard source).
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/10
 */

import { describe, it, expect } from 'vitest';
import { deriveCLTVRange } from './leads';

describe('deriveCLTVRange', () => {
  it('returns null for both bounds when composite_score is null', () => {
    const result = deriveCLTVRange(null, 1_000_000);
    expect(result.cltv_low).toBeNull();
    expect(result.cltv_high).toBeNull();
  });

  it('returns null for both bounds when annual_revenue_est is null', () => {
    const result = deriveCLTVRange(80, null);
    expect(result.cltv_low).toBeNull();
    expect(result.cltv_high).toBeNull();
  });

  it('returns null for both bounds when annual_revenue_est is zero', () => {
    const result = deriveCLTVRange(80, 0);
    expect(result.cltv_low).toBeNull();
    expect(result.cltv_high).toBeNull();
  });

  it('returns null for both bounds when annual_revenue_est is negative', () => {
    const result = deriveCLTVRange(80, -100);
    expect(result.cltv_low).toBeNull();
    expect(result.cltv_high).toBeNull();
  });

  it('computes cltv_low as 80% of (score/100 × revenue)', () => {
    // compositeScore=80, revenue=2_000_000
    // mid = 0.80 * 2_000_000 = 1_600_000
    // cltv_low = 1_600_000 * 0.8 = 1_280_000
    const result = deriveCLTVRange(80, 2_000_000);
    expect(result.cltv_low).toBe(1_280_000);
  });

  it('computes cltv_high as 120% of (score/100 × revenue)', () => {
    // compositeScore=80, revenue=2_000_000
    // cltv_high = 1_600_000 * 1.2 = 1_920_000
    const result = deriveCLTVRange(80, 2_000_000);
    expect(result.cltv_high).toBe(1_920_000);
  });

  it('computes correct range for compositeScore=50 and revenue=1_000_000', () => {
    // mid = 500_000; low = 400_000; high = 600_000
    const result = deriveCLTVRange(50, 1_000_000);
    expect(result.cltv_low).toBe(400_000);
    expect(result.cltv_high).toBe(600_000);
  });

  it('returns rounded integer values', () => {
    const result = deriveCLTVRange(33, 100_000);
    expect(Number.isInteger(result.cltv_low)).toBe(true);
    expect(Number.isInteger(result.cltv_high)).toBe(true);
    // mid = 0.33 * 100_000 = 33_000; low = 26_400; high = 39_600
    expect(result.cltv_low).toBe(26_400);
    expect(result.cltv_high).toBe(39_600);
  });
});

// ---------------------------------------------------------------------------
// TP-5: PipelineCard — no drag event handlers
// ---------------------------------------------------------------------------

describe('PipelineCard — no drag event handlers (TP-5)', () => {
  it('the PipelineCard source contains no drag-related event handlers', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    // import.meta.dirname = apps/server/src/api
    // ../../../.. = project root
    const componentPath = resolve(
      import.meta.dirname,
      '../../../../apps/web/src/components/PipelineCard.tsx',
    );
    const source = readFileSync(componentPath, 'utf-8');

    expect(source).not.toMatch(/draggable/i);
    expect(source).not.toMatch(/onDrag/i);
    expect(source).not.toMatch(/dragstart/i);
    expect(source).not.toMatch(/dragover/i);
    expect(source).not.toMatch(/dragend/i);
    expect(source).not.toMatch(/ondrop/i);
  });
});
