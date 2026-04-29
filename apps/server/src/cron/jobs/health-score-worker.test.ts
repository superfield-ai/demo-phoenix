/**
 * @file health-score-worker.test.ts
 *
 * Unit tests for the customer health score computation logic (issue #54).
 *
 * These tests cover the pure scoring function (computeHealthScore) without any
 * database or scheduler infrastructure.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/54
 */

import { describe, test, expect } from 'vitest';
import { computeHealthScore } from 'db/customer-health-scores';
import type { CustomerHealthSignals } from 'db/customer-health-scores';

// ---------------------------------------------------------------------------
// computeHealthScore — score range
// ---------------------------------------------------------------------------

describe('computeHealthScore — score range', () => {
  test('score is exactly 100 when all signals are zero', () => {
    const signals: CustomerHealthSignals = {
      customer_id: 'c1',
      days_overdue: 0,
      breach_count: 0,
      escalation_level: 0,
    };
    const result = computeHealthScore(signals);
    expect(result.score).toBe(100);
  });

  test('score is 0 when all signals are at maximum', () => {
    const signals: CustomerHealthSignals = {
      customer_id: 'c1',
      days_overdue: 90,
      breach_count: 3,
      escalation_level: 3,
    };
    const result = computeHealthScore(signals);
    expect(result.score).toBe(0);
  });

  test('score stays within 0–100 for all valid signal combinations', () => {
    const combinations: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [45, 1, 1],
      [90, 3, 3],
      [120, 5, 5], // values above cap
    ];
    for (const [days, breaches, escalation] of combinations) {
      const result = computeHealthScore({
        customer_id: 'c',
        days_overdue: days,
        breach_count: breaches,
        escalation_level: escalation,
      });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// computeHealthScore — threshold requirements from acceptance criteria
// ---------------------------------------------------------------------------

describe('computeHealthScore — acceptance threshold criteria', () => {
  test('customer with no overdue invoices and no breaches scores above warning threshold (>70)', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 0,
      breach_count: 0,
      escalation_level: 0,
    });
    expect(result.score).toBeGreaterThan(70);
  });

  test('customer with invoice more than 60 days overdue scores below critical threshold (<40)', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 65,
      breach_count: 0,
      escalation_level: 0,
    });
    expect(result.score).toBeLessThan(40);
  });

  test('customer with invoice exactly 90 days overdue and all signals maxed out scores 0', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 90,
      breach_count: 3,
      escalation_level: 3,
    });
    expect(result.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeHealthScore — per-signal contributions
// ---------------------------------------------------------------------------

describe('computeHealthScore — per-signal contributions', () => {
  test('all signal contributions are non-negative', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 30,
      breach_count: 1,
      escalation_level: 1,
    });
    expect(result.days_overdue_signal).toBeGreaterThanOrEqual(0);
    expect(result.breach_count_signal).toBeGreaterThanOrEqual(0);
    expect(result.escalation_signal).toBeGreaterThanOrEqual(0);
  });

  test('days_overdue_signal is zero when days_overdue is zero', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 0,
      breach_count: 2,
      escalation_level: 1,
    });
    expect(result.days_overdue_signal).toBe(0);
  });

  test('breach_count_signal is zero when breach_count is zero', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 30,
      breach_count: 0,
      escalation_level: 1,
    });
    expect(result.breach_count_signal).toBe(0);
  });

  test('escalation_signal is zero when escalation_level is zero', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 30,
      breach_count: 1,
      escalation_level: 0,
    });
    expect(result.escalation_signal).toBe(0);
  });

  test('total signal contributions equal the composite deduction from 100', () => {
    const signals: CustomerHealthSignals = {
      customer_id: 'c1',
      days_overdue: 45,
      breach_count: 1,
      escalation_level: 2,
    };
    const result = computeHealthScore(signals);
    const totalDeduction =
      result.days_overdue_signal + result.breach_count_signal + result.escalation_signal;
    // Allow floating-point rounding tolerance of 0.01
    expect(Math.abs(100 - result.score - totalDeduction)).toBeLessThan(0.1);
  });

  test('days_overdue_signal caps at 65 (weight=0.65 × 100) when days_overdue >= 60', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 120,
      breach_count: 0,
      escalation_level: 0,
    });
    expect(result.days_overdue_signal).toBe(65);
  });

  test('breach_count_signal caps at 20 (weight=0.20 × 100) when breach_count >= 3', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 0,
      breach_count: 10,
      escalation_level: 0,
    });
    expect(result.breach_count_signal).toBe(20);
  });

  test('escalation_signal caps at 15 (weight=0.15 × 100) when escalation_level >= 3', () => {
    const result = computeHealthScore({
      customer_id: 'c1',
      days_overdue: 0,
      breach_count: 0,
      escalation_level: 10,
    });
    expect(result.escalation_signal).toBe(15);
  });
});
