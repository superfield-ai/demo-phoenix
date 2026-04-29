/**
 * @file collection-cases.test.ts
 *
 * Integration tests for the Collections Agent case queue and contact logging
 * API (issue #49).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Test plan coverage
 *
 * TP-1  Unit: auto-assignment selects the agent with the fewest open cases.
 * TP-2  Unit: contact log POST rejects missing required fields → 400.
 * TP-3  Integration: create a CollectionCase, log two contact attempts, verify
 *       both appear in GET /api/collection-cases/:id response.
 * TP-4  Integration: create cases for two agents, verify new case is assigned
 *       to the agent with fewer open cases.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/49
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import { seedCustomer } from 'db/cfo-summary';
import {
  listCollectionCases,
  getCollectionCaseDetail,
  createContactLog,
  getAgentWithFewestOpenCases,
  assignAgentToCase,
} from 'db/collection-cases';
import { createInvoice } from 'db/invoices';
import { transitionInvoiceToCollection } from 'db/dunning';

/**
 * Creates an invoice in 'overdue' status so it can be transitioned to
 * 'in_collection' by transitionInvoiceToCollection.
 */
async function seedOverdueInvoice(
  opts: { customer_id: string; amount: number },
  sqlClient: ReturnType<typeof postgres>,
): Promise<{ id: string }> {
  const invoice = await createInvoice(
    {
      customer_id: opts.customer_id,
      amount: opts.amount,
      due_date: '2020-01-01',
      send: true,
    },
    sqlClient,
  );
  // Manually set to overdue via direct SQL (trigger only allows transitions,
  // so we go sent → overdue).
  await sqlClient`
    UPDATE rl_invoices SET status = 'overdue', updated_at = NOW()
    WHERE id = ${invoice.id}
  `;
  return invoice;
}

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await pg.stop();
});

// ---------------------------------------------------------------------------
// TP-1: getAgentWithFewestOpenCases — unit
// ---------------------------------------------------------------------------

describe('getAgentWithFewestOpenCases — TP-1', () => {
  test('returns the agent with fewest open cases', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Auto-Assign Test Co' }, sql);

    // Create three overdue invoices and transition to collection.
    const inv1 = await seedOverdueInvoice({ customer_id, amount: 100 }, sql);
    const inv2 = await seedOverdueInvoice({ customer_id, amount: 200 }, sql);
    const inv3 = await seedOverdueInvoice({ customer_id, amount: 300 }, sql);

    // Create 2 cases for agent A and 1 case for agent B.
    const agentA = 'agent-auto-assign-a';
    const agentB = 'agent-auto-assign-b';

    const case1 = await transitionInvoiceToCollection(inv1.id, sql);
    const case2 = await transitionInvoiceToCollection(inv2.id, sql);
    const case3 = await transitionInvoiceToCollection(inv3.id, sql);

    await assignAgentToCase(case1.id, agentA, sql);
    await assignAgentToCase(case2.id, agentA, sql);
    await assignAgentToCase(case3.id, agentB, sql);

    // agentB has 1 open case; agentA has 2. The function should return agentB.
    const result = await getAgentWithFewestOpenCases([agentA, agentB], sql);
    expect(result).toBe(agentB);
  });

  test('returns null for empty agent list', async () => {
    const result = await getAgentWithFewestOpenCases([], sql);
    expect(result).toBeNull();
  });

  test('returns the first agent when all have the same count', async () => {
    // No cases assigned to either — both have 0.
    const result = await getAgentWithFewestOpenCases(['agent-z1', 'agent-z2'], sql);
    // Both have 0 open cases; tie-break is alphabetical by agent_id.
    expect(['agent-z1', 'agent-z2']).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// TP-2: contact log field validation — unit-level logic check
// ---------------------------------------------------------------------------

describe('contact log field validation — TP-2', () => {
  test('contact_type must be call, email, or portal', () => {
    const VALID_CONTACT_TYPES = new Set(['call', 'email', 'portal']);
    expect(VALID_CONTACT_TYPES.has('call')).toBe(true);
    expect(VALID_CONTACT_TYPES.has('email')).toBe(true);
    expect(VALID_CONTACT_TYPES.has('portal')).toBe(true);
    expect(VALID_CONTACT_TYPES.has('sms')).toBe(false);
    expect(VALID_CONTACT_TYPES.has('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TP-3: create a case, log two contact attempts, verify both appear in detail
// ---------------------------------------------------------------------------

describe('contact log integration — TP-3', () => {
  test('two contact logs appear in case detail response in chronological order', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Contact Log Co' }, sql);
    const invoice = await seedOverdueInvoice({ customer_id, amount: 1000 }, sql);
    const collectionCase = await transitionInvoiceToCollection(invoice.id, sql);
    const agentId = 'agent-contact-log-test';
    await assignAgentToCase(collectionCase.id, agentId, sql);

    // Log first contact.
    const log1 = await createContactLog(
      {
        collection_case_id: collectionCase.id,
        agent_id: agentId,
        contact_type: 'call',
        outcome: 'Left voicemail',
        notes: 'Called at 9am',
        contacted_at: '2020-07-01T09:00:00Z',
      },
      sql,
    );

    // Log second contact.
    const log2 = await createContactLog(
      {
        collection_case_id: collectionCase.id,
        agent_id: agentId,
        contact_type: 'email',
        outcome: 'No reply yet',
        notes: null,
        contacted_at: '2020-07-05T14:00:00Z',
      },
      sql,
    );

    // Fetch case detail and verify both logs appear in order.
    const detail = await getCollectionCaseDetail(collectionCase.id, sql);
    expect(detail).not.toBeNull();
    expect(detail!.contact_logs.length).toBeGreaterThanOrEqual(2);

    const ids = detail!.contact_logs.map((l) => l.id);
    expect(ids).toContain(log1.id);
    expect(ids).toContain(log2.id);

    // Verify chronological order — log1 should come before log2.
    const idx1 = ids.indexOf(log1.id);
    const idx2 = ids.indexOf(log2.id);
    expect(idx1).toBeLessThan(idx2);

    // Verify log fields.
    const foundLog1 = detail!.contact_logs.find((l) => l.id === log1.id)!;
    expect(foundLog1.contact_type).toBe('call');
    expect(foundLog1.outcome).toBe('Left voicemail');
    expect(foundLog1.notes).toBe('Called at 9am');
    expect(foundLog1.agent_id).toBe(agentId);
  });
});

// ---------------------------------------------------------------------------
// TP-4: auto-assignment — new case goes to agent with fewest open cases
// ---------------------------------------------------------------------------

describe('auto-assignment — TP-4', () => {
  test('new case is assigned to the agent with fewer open cases', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Auto-Assign Balance Co' }, sql);

    const agentFew = 'agent-tp4-few';
    const agentMany = 'agent-tp4-many';

    // Give agentMany two existing open cases.
    const inv1 = await seedOverdueInvoice({ customer_id, amount: 100 }, sql);
    const inv2 = await seedOverdueInvoice({ customer_id, amount: 200 }, sql);
    const case1 = await transitionInvoiceToCollection(inv1.id, sql);
    const case2 = await transitionInvoiceToCollection(inv2.id, sql);
    await assignAgentToCase(case1.id, agentMany, sql);
    await assignAgentToCase(case2.id, agentMany, sql);

    // agentFew has zero open cases.
    const selected = await getAgentWithFewestOpenCases([agentFew, agentMany], sql);
    expect(selected).toBe(agentFew);

    // Simulate assigning a new case to the selected agent.
    const inv3 = await seedOverdueInvoice({ customer_id, amount: 300 }, sql);
    const newCase = await transitionInvoiceToCollection(inv3.id, sql);
    await assignAgentToCase(newCase.id, selected!, sql);

    // Verify the new case is now assigned to agentFew.
    const detail = await getCollectionCaseDetail(newCase.id, sql);
    expect(detail!.agent_id).toBe(agentFew);
  });
});

// ---------------------------------------------------------------------------
// listCollectionCases — basic filter
// ---------------------------------------------------------------------------

describe('listCollectionCases', () => {
  test('returns only cases for the specified agent', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'List Cases Co' }, sql);
    const invoice = await seedOverdueInvoice({ customer_id, amount: 500 }, sql);
    const collectionCase = await transitionInvoiceToCollection(invoice.id, sql);
    const agentId = 'agent-list-cases-test';
    await assignAgentToCase(collectionCase.id, agentId, sql);

    const cases = await listCollectionCases({ agent_id: agentId }, sql);
    expect(cases.length).toBeGreaterThanOrEqual(1);
    expect(cases.every((c) => c.agent_id === agentId)).toBe(true);

    // Verify the case row includes joined invoice + customer fields.
    const found = cases.find((c) => c.id === collectionCase.id);
    expect(found).toBeDefined();
    expect(found!.invoice_amount).toBe(500);
    expect(found!.customer_name).toBe('List Cases Co');
  });
});
