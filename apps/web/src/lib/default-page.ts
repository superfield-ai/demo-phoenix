/**
 * @file default-page.ts
 *
 * Pure function that derives the landing page for a given user role and access flags.
 * Extracted from App.tsx so it can be unit-tested without React.
 *
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/75
 */

export type ActivePage =
  | 'pipeline'
  | 'leads'
  | 'settings'
  | 'cfo-portfolio'
  | 'cfo-dashboard'
  | 'collection-queue'
  | 'kyc-review'
  | 'account-manager-dashboard'
  | 'campaign-analysis';

/**
 * Derive the default landing page from role and access flags.
 * Each persona lands on the page most relevant to their job.
 */
export function deriveDefaultPage(
  role: string | null | undefined,
  isCfo: boolean | undefined,
  isBdm: boolean | undefined,
): ActivePage {
  if (isCfo || role === 'cfo') return 'cfo-portfolio';
  if (isBdm || role === 'bdm') return 'campaign-analysis';
  if (role === 'collections_agent') return 'collection-queue';
  if (role === 'finance_controller') return 'cfo-dashboard';
  if (role === 'account_manager') return 'account-manager-dashboard';
  return 'pipeline';
}
