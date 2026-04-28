/**
 * @file lead-routing.test.ts
 *
 * Integration tests for the lead qualification routing engine (issue #6, P0-4).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Test plan coverage
 *
 *   TP-1  Create a Prospect with verified KYCRecord and CLTVScore above threshold;
 *         call route(); assert stage=qualified and assigned_rep_id is populated.
 *
 *   TP-2  Create a Prospect with verified KYCRecord and CLTVScore below threshold;
 *         call route(); assert stage=disqualified and disqualification_reason=score_below_threshold.
 *
 *   TP-3  Create a Prospect with kyc_manual_review stage;
 *         call route(); assert stage=disqualified and disqualification_reason=kyc_manual_review.
 *
 *   TP-4  Create 3 Prospects all above threshold with QUEUE_ASSIGN_MODE=round_robin
 *         and 2 active reps; assert assignments alternate between the two reps.
 *
 *   TP-5  Update QUALIFICATION_THRESHOLD upward so a previously qualifying score
 *         no longer qualifies; call route() again; assert Prospect is now disqualified.
 *
 *   TP-6  Assert a RESCORE_SCHEDULE task exists in task_queue for each disqualified
 *         Prospect after route() runs.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/6
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { route, resetRoundRobinCounter } from './lead-routing';
import { TaskType, TASK_TYPE_AGENT_MAP } from './task-queue';

// ─────────────────────────────────────────────────────────────────────────────
// Test container lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

beforeEach(() => {
  resetRoundRobinCounter();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Creates an rl_prospects row and returns its id. */
async function insertProspect(
  db: ReturnType<typeof postgres>,
  overrides: { company_name?: string; stage?: string } = {},
): Promise<string> {
  const company_name = overrides.company_name ?? `Test Co ${crypto.randomUUID()}`;
  const stage = overrides.stage ?? 'scored';
  const [row] = await db<{ id: string }[]>`
    INSERT INTO rl_prospects (company_name, stage)
    VALUES (${company_name}, ${stage})
    RETURNING id
  `;
  return row.id;
}

/** Inserts a verified KYCRecord for a Prospect and returns its id. */
async function insertVerifiedKyc(
  db: ReturnType<typeof postgres>,
  prospectId: string,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO rl_kyc_records (prospect_id, verification_status, checked_at)
    VALUES (${prospectId}, 'verified', NOW())
    RETURNING id
  `;
  return row.id;
}

/** Inserts a CLTVScore row for a Prospect and returns its id. */
async function insertCltvScore(
  db: ReturnType<typeof postgres>,
  prospectId: string,
  compositeScore: number,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO rl_cltv_scores
      (entity_id, entity_type, composite_score, score_version, computed_at)
    VALUES
      (${prospectId}, 'prospect', ${compositeScore}, 'v1', NOW())
    RETURNING id
  `;
  return row.id;
}

/** Inserts an entity with role=sales_rep and returns its id. */
async function insertSalesRep(db: ReturnType<typeof postgres>, username?: string): Promise<string> {
  const name = username ?? `rep-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  await db`
    INSERT INTO entities (id, type, properties)
    VALUES (${id}, 'user', ${db.json({ role: 'sales_rep', username: name })})
  `;
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// TP-1 / AC-1: Verified KYC + score above threshold → qualified
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-1: qualified path — verified KYC and score above threshold', () => {
  test('route() sets stage=qualified and populates assigned_rep_id', async () => {
    const repId = await insertSalesRep(sql);
    const prospectId = await insertProspect(sql);
    await insertVerifiedKyc(sql, prospectId);
    await insertCltvScore(sql, prospectId, 0.75); // above default threshold 0.5

    const result = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
    });

    expect(result.stage).toBe('qualified');
    expect(result.assigned_rep_id).toBe(repId);
    expect(result.disqualification_reason).toBeNull();
    expect(result.rescore_task_id).toBeNull();

    // Verify persisted in DB.
    const [row] = await sql<{ stage: string; assigned_rep_id: string | null }[]>`
      SELECT stage, assigned_rep_id FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(row.stage).toBe('qualified');
    expect(row.assigned_rep_id).toBe(repId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-2 / AC-2: Score below threshold → disqualified with score_below_threshold
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-2: disqualified — score below threshold', () => {
  test('route() sets stage=disqualified and disqualification_reason=score_below_threshold', async () => {
    const prospectId = await insertProspect(sql);
    await insertVerifiedKyc(sql, prospectId);
    await insertCltvScore(sql, prospectId, 0.2); // below threshold 0.5

    const result = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
    });

    expect(result.stage).toBe('disqualified');
    expect(result.disqualification_reason).toBe('score_below_threshold');
    expect(result.assigned_rep_id).toBeNull();

    // Verify persisted in DB.
    const [row] = await sql<
      {
        stage: string;
        disqualification_reason: string | null;
        disqualified_at: Date | null;
      }[]
    >`
      SELECT stage, disqualification_reason, disqualified_at
      FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(row.stage).toBe('disqualified');
    expect(row.disqualification_reason).toBe('score_below_threshold');
    expect(row.disqualified_at).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-3 / AC-3: kyc_manual_review stage → disqualified with kyc_manual_review reason
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-3: disqualified — kyc_manual_review stage', () => {
  test('route() sets stage=disqualified and disqualification_reason=kyc_manual_review', async () => {
    const prospectId = await insertProspect(sql, { stage: 'kyc_manual_review' });
    // Add a score above threshold — the KYC gate should still block qualification.
    await insertCltvScore(sql, prospectId, 0.9);

    const result = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
    });

    expect(result.stage).toBe('disqualified');
    expect(result.disqualification_reason).toBe('kyc_manual_review');
    expect(result.assigned_rep_id).toBeNull();

    const [row] = await sql<{ stage: string; disqualification_reason: string | null }[]>`
      SELECT stage, disqualification_reason FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(row.stage).toBe('disqualified');
    expect(row.disqualification_reason).toBe('kyc_manual_review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-4 / AC-4: Round-robin assignment distributes leads across reps
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-4: round-robin assignment across 2 active reps', () => {
  test('3 Prospects assigned in alternating round-robin order', async () => {
    // Delete all existing sales reps to get a clean slate for this test.
    await sql`
      DELETE FROM entities
      WHERE type = 'user' AND properties->>'role' = 'sales_rep'
    `;

    // Insert exactly 2 sales reps. Sort by id so we know the expected order.
    const rep1 = await insertSalesRep(sql, 'rr-rep-alpha');
    const rep2 = await insertSalesRep(sql, 'rr-rep-beta');

    // Determine expected order from DB (sorted by id ASC, matching fetchActiveSalesReps).
    const repRows = await sql<{ id: string }[]>`
      SELECT id FROM entities
      WHERE id = ANY(ARRAY[${rep1}, ${rep2}]::TEXT[])
      ORDER BY id ASC
    `;
    const sorted = repRows.map((r) => r.id);

    // Reset counter so cycle starts at index 0.
    resetRoundRobinCounter();

    // Create 3 qualifying prospects.
    const prospects: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertProspect(sql);
      await insertVerifiedKyc(sql, id);
      await insertCltvScore(sql, id, 0.8);
      prospects.push(id);
    }

    const assigned: string[] = [];
    for (const prospectId of prospects) {
      const result = await route(prospectId, {
        sqlClient: sql,
        env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
      });
      expect(result.stage).toBe('qualified');
      assigned.push(result.assigned_rep_id ?? '');
    }

    // Each of the 3 assignments should cycle through the sorted rep list.
    expect(assigned[0]).toBe(sorted[0]);
    expect(assigned[1]).toBe(sorted[1]);
    expect(assigned[2]).toBe(sorted[0]); // wraps back
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-5 / AC-5: Changing QUALIFICATION_THRESHOLD takes effect immediately
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-5: QUALIFICATION_THRESHOLD env var takes effect without redeploy', () => {
  test('raising the threshold disqualifies a previously qualifying Prospect', async () => {
    const prospectId = await insertProspect(sql);
    await insertVerifiedKyc(sql, prospectId);
    await insertCltvScore(sql, prospectId, 0.6); // above 0.5

    // First call: qualifies at threshold 0.5.
    const first = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
    });
    expect(first.stage).toBe('qualified');

    // Raise threshold above the score — now should disqualify.
    const second = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.8', QUEUE_ASSIGN_MODE: 'round_robin' },
    });
    expect(second.stage).toBe('disqualified');
    expect(second.disqualification_reason).toBe('score_below_threshold');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-6 / AC-6: Disqualified Prospect has a RESCORE_SCHEDULE task in task_queue
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-6: RESCORE_SCHEDULE task enqueued for disqualified Prospects', () => {
  test('score_below_threshold disqualification enqueues a RESCORE_SCHEDULE task', async () => {
    const prospectId = await insertProspect(sql);
    await insertVerifiedKyc(sql, prospectId);
    await insertCltvScore(sql, prospectId, 0.1); // well below threshold

    const result = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
    });

    expect(result.stage).toBe('disqualified');
    expect(result.rescore_task_id).not.toBeNull();

    // Verify task exists in DB with correct type.
    const tasks = await sql<{ id: string; job_type: string; agent_type: string }[]>`
      SELECT id, job_type, agent_type
      FROM task_queue
      WHERE id = ${result.rescore_task_id!}
    `;
    expect(tasks.length).toBe(1);
    expect(tasks[0].job_type).toBe(TaskType.RESCORE_SCHEDULE);
    expect(tasks[0].agent_type).toBe(TASK_TYPE_AGENT_MAP[TaskType.RESCORE_SCHEDULE]);
  });

  test('kyc_manual_review disqualification also enqueues a RESCORE_SCHEDULE task', async () => {
    const prospectId = await insertProspect(sql, { stage: 'kyc_manual_review' });

    const result = await route(prospectId, {
      sqlClient: sql,
      env: { QUALIFICATION_THRESHOLD: '0.5', QUEUE_ASSIGN_MODE: 'round_robin' },
    });

    expect(result.stage).toBe('disqualified');
    expect(result.rescore_task_id).not.toBeNull();

    const tasks = await sql<{ job_type: string }[]>`
      SELECT job_type FROM task_queue WHERE id = ${result.rescore_task_id!}
    `;
    expect(tasks.length).toBe(1);
    expect(tasks[0].job_type).toBe(TaskType.RESCORE_SCHEDULE);
  });
});
