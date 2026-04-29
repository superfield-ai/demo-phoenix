/**
 * Integration tests for the settlement proposal and write-off approval flow.
 *
 * Covers:
 *   - Above-threshold proposals create a pending approval and leave the invoice untouched
 *   - Below-threshold proposals auto-apply without creating an approval record
 *   - Approving a pending request closes the case and updates the invoice
 *   - Rejecting a pending request leaves the case open and records the reason
 *   - Threshold changes are read live from process.env
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { migrate } from './index';
import { startPostgres, type PgContainer } from './pg-container';
import { seedCustomer } from './cfo-summary';
import { createInvoice } from './invoices';
import { transitionInvoiceToCollection } from './dunning';
import {
  decideWriteOffApproval,
  getLatestWriteOffApprovalForCase,
  getWriteOffApprovalThreshold,
  listWriteOffApprovals,
  proposeSettlement,
} from './write-off-approvals';
import { getCollectionCaseDetail } from './collection-cases';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
const originalThreshold = process.env.WRITE_OFF_APPROVAL_THRESHOLD;

function restoreThreshold(value: string | undefined) {
  if (value === undefined) {
    delete process.env.WRITE_OFF_APPROVAL_THRESHOLD;
  } else {
    process.env.WRITE_OFF_APPROVAL_THRESHOLD = value;
  }
}

async function seedOpenCollectionCase(amount = 1000) {
  const { customer_id } = await seedCustomer({ company_name: `Write-Off Test ${amount}` }, sql);
  const invoice = await createInvoice(
    {
      customer_id,
      amount,
      due_date: '2020-01-01',
      send: true,
    },
    sql,
  );
  await sql`
    UPDATE rl_invoices SET status = 'overdue', updated_at = NOW()
    WHERE id = ${invoice.id}
  `;
  const collectionCase = await transitionInvoiceToCollection(invoice.id, sql);
  return { customer_id, invoice, collectionCase };
}

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  restoreThreshold(originalThreshold);
  await sql.end({ timeout: 5 });
  await pg.stop();
});

test('getWriteOffApprovalThreshold reads the live env var', () => {
  process.env.WRITE_OFF_APPROVAL_THRESHOLD = '123.45';
  expect(getWriteOffApprovalThreshold()).toBeCloseTo(123.45, 5);
  process.env.WRITE_OFF_APPROVAL_THRESHOLD = '';
  expect(getWriteOffApprovalThreshold()).toBe(Number.POSITIVE_INFINITY);
  restoreThreshold(originalThreshold);
});

describe('proposeSettlement', () => {
  test('creates a pending approval above threshold without changing the invoice', async () => {
    process.env.WRITE_OFF_APPROVAL_THRESHOLD = '50';
    const { invoice, collectionCase } = await seedOpenCollectionCase(1000);

    const result = await proposeSettlement(sql, {
      collection_case_id: collectionCase.id,
      settlement_amount: 900,
      notes: 'Customer requested a discount',
      proposed_by: 'agent-1',
      actor_id: 'agent-1',
    });

    expect(result.auto_approved).toBe(false);
    expect(result.approval).not.toBeNull();
    expect(result.approval!.status).toBe('pending_approval');
    expect(result.approval!.implied_write_off_amount).toBe(100);

    const invoiceAfter = await sql`
      SELECT status FROM rl_invoices WHERE id = ${invoice.id}
    `;
    expect(invoiceAfter[0].status).toBe('in_collection');

    const latestApproval = await getLatestWriteOffApprovalForCase(sql, collectionCase.id);
    expect(latestApproval).not.toBeNull();
    expect(latestApproval!.status).toBe('pending_approval');
  });

  test('auto-approves below threshold without creating an approval record', async () => {
    process.env.WRITE_OFF_APPROVAL_THRESHOLD = '250';
    const { invoice, collectionCase } = await seedOpenCollectionCase(1000);

    const result = await proposeSettlement(sql, {
      collection_case_id: collectionCase.id,
      settlement_amount: 900,
      notes: null,
      proposed_by: 'agent-2',
      actor_id: 'agent-2',
    });

    expect(result.auto_approved).toBe(true);
    expect(result.approval).toBeNull();
    expect(result.settlement).not.toBeNull();
    expect(result.settlement!.invoice_status).toBe('written_off');

    const approvalRows = await listWriteOffApprovals(sql, { status: 'pending_approval' });
    expect(approvalRows.some((row) => row.collection_case_id === collectionCase.id)).toBe(false);

    const detail = await getCollectionCaseDetail(collectionCase.id, sql);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('written_off');
    expect(detail!.resolution_type).toBe('settlement');

    const invoiceAfter = await sql`
      SELECT status FROM rl_invoices WHERE id = ${invoice.id}
    `;
    expect(invoiceAfter[0].status).toBe('written_off');
  });
});

describe('decideWriteOffApproval', () => {
  test('approving a pending request closes the case and updates the invoice', async () => {
    process.env.WRITE_OFF_APPROVAL_THRESHOLD = '10';
    const { collectionCase } = await seedOpenCollectionCase(1000);

    const proposal = await proposeSettlement(sql, {
      collection_case_id: collectionCase.id,
      settlement_amount: 900,
      proposed_by: 'agent-3',
      actor_id: 'agent-3',
      notes: 'Need approval',
    });

    expect(proposal.approval).not.toBeNull();

    const result = await decideWriteOffApproval(sql, {
      approval_id: proposal.approval!.id,
      decision: 'approved',
      reviewed_by: 'finance-1',
      review_notes: 'Approved by Finance Controller',
      actor_id: 'finance-1',
    });

    expect(result.approval.status).toBe('approved');
    expect(result.settlement).not.toBeNull();
    expect(result.settlement!.invoice_status).toBe('written_off');

    const detail = await getCollectionCaseDetail(collectionCase.id, sql);
    expect(detail!.status).toBe('written_off');
    expect(detail!.resolution_type).toBe('settlement');
    expect(detail!.latest_write_off_approval?.status).toBe('approved');
    expect(detail!.latest_write_off_approval?.review_notes).toContain('Finance Controller');
  });

  test('rejecting a pending request leaves the case open and records the reason', async () => {
    process.env.WRITE_OFF_APPROVAL_THRESHOLD = '10';
    const { collectionCase } = await seedOpenCollectionCase(1000);

    const proposal = await proposeSettlement(sql, {
      collection_case_id: collectionCase.id,
      settlement_amount: 900,
      proposed_by: 'agent-4',
      actor_id: 'agent-4',
    });

    const result = await decideWriteOffApproval(sql, {
      approval_id: proposal.approval!.id,
      decision: 'rejected',
      reviewed_by: 'finance-2',
      review_notes: 'Please collect the full balance',
      actor_id: 'finance-2',
    });

    expect(result.approval.status).toBe('rejected');
    expect(result.settlement).toBeNull();

    const detail = await getCollectionCaseDetail(collectionCase.id, sql);
    expect(detail!.status).toBe('open');
    expect(detail!.latest_write_off_approval?.status).toBe('rejected');
    expect(detail!.latest_write_off_approval?.review_notes).toContain('full balance');
  });
});
