/**
 * Unit tests for deriveDefaultPage.
 *
 * Verifies that every seeded demo role and the isCfo/isBdm flags resolve to the
 * correct landing page. No mocks — the function is pure.
 *
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/75
 */

import { describe, it, expect } from 'vitest';
import { deriveDefaultPage } from '../../src/lib/default-page';

describe('deriveDefaultPage', () => {
  it('returns cfo-portfolio for role=cfo', () => {
    expect(deriveDefaultPage('cfo', false, false)).toBe('cfo-portfolio');
  });

  it('returns cfo-portfolio when isCfo=true regardless of role', () => {
    expect(deriveDefaultPage(null, true, false)).toBe('cfo-portfolio');
  });

  it('returns campaign-analysis for role=bdm', () => {
    expect(deriveDefaultPage('bdm', false, false)).toBe('campaign-analysis');
  });

  it('returns campaign-analysis when isBdm=true regardless of role', () => {
    expect(deriveDefaultPage(null, false, true)).toBe('campaign-analysis');
  });

  it('returns collection-queue for role=collections_agent', () => {
    expect(deriveDefaultPage('collections_agent', false, false)).toBe('collection-queue');
  });

  it('returns cfo-dashboard for role=finance_controller', () => {
    expect(deriveDefaultPage('finance_controller', false, false)).toBe('cfo-dashboard');
  });

  it('returns account-manager-dashboard for role=account_manager', () => {
    expect(deriveDefaultPage('account_manager', false, false)).toBe('account-manager-dashboard');
  });

  it('returns pipeline for role=sales_rep', () => {
    expect(deriveDefaultPage('sales_rep', false, false)).toBe('pipeline');
  });

  it('returns pipeline when isSuperadmin=true regardless of role', () => {
    expect(deriveDefaultPage(null, false, false, true)).toBe('pipeline');
  });

  it('returns settings for unknown role (never pipeline)', () => {
    expect(deriveDefaultPage('unknown_role', false, false)).toBe('settings');
  });

  it('returns settings when role is null and no flags', () => {
    expect(deriveDefaultPage(null, false, false)).toBe('settings');
  });

  it('isCfo takes precedence over isBdm', () => {
    expect(deriveDefaultPage(null, true, true)).toBe('cfo-portfolio');
  });
});
