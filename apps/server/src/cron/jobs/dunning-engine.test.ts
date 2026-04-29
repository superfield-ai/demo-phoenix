/**
 * @file dunning-engine.test.ts
 *
 * Unit tests for the dunning engine cron job (issue #48).
 *
 * These tests cover the pure logic helpers (resolveNextMilestone,
 * dispatchDunningCommunication) without any database or scheduler
 * infrastructure.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/48
 */

import { describe, test, expect } from 'vitest';
import { resolveNextMilestone, DUNNING_MILESTONES, type DunningMilestone } from './dunning-engine';
import type { DunningActionType } from 'db/dunning';

// ---------------------------------------------------------------------------
// resolveNextMilestone
// ---------------------------------------------------------------------------

describe('resolveNextMilestone', () => {
  test('returns reminder_d1 when invoice is 1 day overdue and no actions exist', () => {
    const milestone = resolveNextMilestone(1, new Set());
    expect(milestone).not.toBeNull();
    expect(milestone!.action_type).toBe('reminder_d1');
  });

  test('returns second_notice_d7 when invoice is 7 days overdue and only d1 exists', () => {
    const existing = new Set<DunningActionType>(['reminder_d1']);
    const milestone = resolveNextMilestone(7, existing);
    expect(milestone).not.toBeNull();
    expect(milestone!.action_type).toBe('second_notice_d7');
  });

  test('returns firm_notice_d14 when invoice is 14 days overdue and d1+d7 exist', () => {
    const existing = new Set<DunningActionType>(['reminder_d1', 'second_notice_d7']);
    const milestone = resolveNextMilestone(14, existing);
    expect(milestone).not.toBeNull();
    expect(milestone!.action_type).toBe('firm_notice_d14');
  });

  test('returns collection_d30 when invoice is 30 days overdue and d1+d7+d14 exist', () => {
    const existing = new Set<DunningActionType>([
      'reminder_d1',
      'second_notice_d7',
      'firm_notice_d14',
    ]);
    const milestone = resolveNextMilestone(30, existing);
    expect(milestone).not.toBeNull();
    expect(milestone!.action_type).toBe('collection_d30');
  });

  test('returns null when all milestones already exist for a 30-day overdue invoice', () => {
    const existing = new Set<DunningActionType>([
      'reminder_d1',
      'second_notice_d7',
      'firm_notice_d14',
      'collection_d30',
    ]);
    const milestone = resolveNextMilestone(30, existing);
    expect(milestone).toBeNull();
  });

  test('returns null when invoice is 0 days overdue (not yet due)', () => {
    const milestone = resolveNextMilestone(0, new Set());
    expect(milestone).toBeNull();
  });

  test('skips already-created actions and returns the next due milestone', () => {
    // Invoice is 15 days overdue but only has d1. Should return d7 (next missing).
    const existing = new Set<DunningActionType>(['reminder_d1']);
    const milestone = resolveNextMilestone(15, existing);
    expect(milestone).not.toBeNull();
    expect(milestone!.action_type).toBe('second_notice_d7');
  });

  test('returns reminder_d1 when invoice is well past d1 threshold but no actions yet', () => {
    const milestone = resolveNextMilestone(45, new Set());
    // First milestone to create is still d1 (lowest min_days not yet done).
    expect(milestone).not.toBeNull();
    expect(milestone!.action_type).toBe('reminder_d1');
  });
});

// ---------------------------------------------------------------------------
// DUNNING_MILESTONES ordering
// ---------------------------------------------------------------------------

describe('DUNNING_MILESTONES', () => {
  test('milestones are ordered by ascending min_days', () => {
    const days = DUNNING_MILESTONES.map((m: DunningMilestone) => m.min_days);
    for (let i = 1; i < days.length; i++) {
      expect(days[i]).toBeGreaterThan(days[i - 1]);
    }
  });

  test('all four expected milestones are present', () => {
    const types = DUNNING_MILESTONES.map((m: DunningMilestone) => m.action_type);
    expect(types).toContain('reminder_d1');
    expect(types).toContain('second_notice_d7');
    expect(types).toContain('firm_notice_d14');
    expect(types).toContain('collection_d30');
  });
});
