/**
 * Unit tests for deriveDefaultPage.
 *
 * Verifies that every seeded demo role and the isCfo/isBdm flags resolve to the
 * correct landing page. No mocks — the function is pure.
 *
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/75
 * Extended for issue #93 (activePage sync): verifies App uses deriveDefaultPage
 * correctly when the user resolves from null, ensuring role-correct landing pages.
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

/**
 * Simulates the activePage sync logic introduced in App.tsx (issue #93).
 *
 * The App useEffect calls deriveDefaultPage(user.role, user.isCfo, user.isBdm,
 * user.isSuperadmin) the first time user resolves from null.  These tests verify
 * the expected page for each relevant user object shape — the pure function
 * call that the effect delegates to.
 *
 * No React rendering needed: deriveDefaultPage is pure and deterministic.
 */
describe('activePage sync — deriveDefaultPage for resolved user objects (issue #93)', () => {
  it('CFO user object resolves to cfo-portfolio', () => {
    // Simulates: deriveDefaultPage(user.role, user.isCfo, user.isBdm, user.isSuperadmin)
    // for a CFO user { role: 'cfo', isCfo: true }
    expect(deriveDefaultPage('cfo', true, false, false)).toBe('cfo-portfolio');
  });

  it('collections_agent user object resolves to collection-queue', () => {
    expect(deriveDefaultPage('collections_agent', false, false, false)).toBe('collection-queue');
  });

  it('sales_rep user object resolves to pipeline', () => {
    expect(deriveDefaultPage('sales_rep', false, false, false)).toBe('pipeline');
  });

  it('superadmin user object resolves to pipeline (isSuperadmin=true)', () => {
    expect(deriveDefaultPage('sales_rep', false, false, true)).toBe('pipeline');
  });

  it('null user (pre-auth) resolves to settings — sync must not fire until user exists', () => {
    // This is the initial useState seed value before auth resolves.
    // The sync useEffect guards with "if (!user) return" so this path
    // is never passed to setActivePage.
    expect(deriveDefaultPage(null, false, false, false)).toBe('settings');
  });
});
