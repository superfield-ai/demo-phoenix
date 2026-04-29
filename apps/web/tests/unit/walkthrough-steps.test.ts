/**
 * @file walkthrough-steps.test.ts
 *
 * Unit tests for the role-specific walkthrough step constants added in issue #57.
 *
 * Verifies:
 *   1. COLLECTIONS_AGENT_STEPS exports exactly 3 steps with the expected titles.
 *   2. ACCOUNT_MANAGER_STEPS exports exactly 3 steps with the expected titles.
 *   3. FINANCE_CONTROLLER_STEPS exports exactly 3 steps with the expected titles.
 *   4. Each step has non-empty title and description strings.
 *
 * No mocks — pure data validation against the exported constants.
 *
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/57
 */

import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS_AGENT_STEPS,
  ACCOUNT_MANAGER_STEPS,
  FINANCE_CONTROLLER_STEPS,
} from '../../src/components/walkthrough-steps';

// ---------------------------------------------------------------------------
// Collections Agent
// ---------------------------------------------------------------------------

describe('COLLECTIONS_AGENT_STEPS', () => {
  it('has exactly 3 steps', () => {
    expect(COLLECTIONS_AGENT_STEPS).toHaveLength(3);
  });

  it('step 1 is Case Queue', () => {
    expect(COLLECTIONS_AGENT_STEPS[0].title).toBe('Case Queue');
  });

  it('step 2 is Contact Log', () => {
    expect(COLLECTIONS_AGENT_STEPS[1].title).toBe('Contact Log');
  });

  it('step 3 is Payment Plan Panel', () => {
    expect(COLLECTIONS_AGENT_STEPS[2].title).toBe('Payment Plan Panel');
  });

  it('every step has a non-empty description', () => {
    for (const step of COLLECTIONS_AGENT_STEPS) {
      expect(step.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Account Manager
// ---------------------------------------------------------------------------

describe('ACCOUNT_MANAGER_STEPS', () => {
  it('has exactly 3 steps', () => {
    expect(ACCOUNT_MANAGER_STEPS).toHaveLength(3);
  });

  it('step 1 is Customer Health Dashboard', () => {
    expect(ACCOUNT_MANAGER_STEPS[0].title).toBe('Customer Health Dashboard');
  });

  it('step 2 is Health Alerts & Signal Labels', () => {
    expect(ACCOUNT_MANAGER_STEPS[1].title).toBe('Health Alerts & Signal Labels');
  });

  it('step 3 is Intervention Form', () => {
    expect(ACCOUNT_MANAGER_STEPS[2].title).toBe('Intervention Form');
  });

  it('every step has a non-empty description', () => {
    for (const step of ACCOUNT_MANAGER_STEPS) {
      expect(step.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Finance Controller
// ---------------------------------------------------------------------------

describe('FINANCE_CONTROLLER_STEPS', () => {
  it('has exactly 3 steps', () => {
    expect(FINANCE_CONTROLLER_STEPS).toHaveLength(3);
  });

  it('step 1 is AR Aging Dashboard', () => {
    expect(FINANCE_CONTROLLER_STEPS[0].title).toBe('AR Aging Dashboard');
  });

  it('step 2 is Invoice Drilldown', () => {
    expect(FINANCE_CONTROLLER_STEPS[1].title).toBe('Invoice Drilldown');
  });

  it('step 3 is Write-off Approvals Queue', () => {
    expect(FINANCE_CONTROLLER_STEPS[2].title).toBe('Write-off Approvals Queue');
  });

  it('every step has a non-empty description', () => {
    for (const step of FINANCE_CONTROLLER_STEPS) {
      expect(step.description.length).toBeGreaterThan(0);
    }
  });
});
