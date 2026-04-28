/**
 * @file prospects
 *
 * HTTP handlers for the Prospects resource (Phase 0, P0-2).
 *
 * ## Endpoints
 *
 *   POST /api/prospects
 *     Creates a new Prospect and immediately enqueues a KYC_VERIFY task.
 *     The response is returned before the KYC check completes (fire-and-forget).
 *
 * ## KYC task enqueue
 *
 * After inserting the Prospect row, a `kyc_verify` task is enqueued with:
 *   - idempotency_key: `kyc_verify:${prospect.id}`
 *   - agent_type:      `kyc_verify`
 *   - job_type:        `KYC_VERIFY`
 *   - payload:         `{ prospect_id: prospect.id }`
 *   - created_by:      authenticated user ID
 *
 * The idempotency key ensures that a retried POST request for the same
 * Prospect never double-enqueues the task.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/4
 */

import { createProspect } from 'db/kyc-provider';
import { enqueueTask, TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';

/** Minimal authenticated user shape returned by getAuthenticatedUser. */
interface AuthenticatedUser {
  id: string;
  username: string;
}

export interface CreateProspectBody {
  name: string;
  email: string;
  company?: string;
  funding_stage?: string;
  annual_revenue_est?: number;
}

/**
 * Handles `POST /api/prospects`.
 *
 * Validates the request body, creates a Prospect, enqueues a KYC_VERIFY task,
 * and returns the created Prospect row plus the enqueued task ID.
 *
 * The handler returns 201 immediately after creating the Prospect and
 * enqueuing the task. It does not wait for the KYC result.
 *
 * @param req  Incoming HTTP request.
 * @param user Authenticated user context (for `created_by`).
 * @returns    HTTP Response with the created Prospect JSON.
 */
export async function handleProspectsRequest(
  req: Request,
  user: AuthenticatedUser,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: CreateProspectBody;
  try {
    body = (await req.json()) as CreateProspectBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { name, email, company, funding_stage, annual_revenue_est } = body;

  if (!name || typeof name !== 'string') {
    return new Response(JSON.stringify({ error: 'name is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!email || typeof email !== 'string') {
    return new Response(JSON.stringify({ error: 'email is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1. Create the Prospect row.
  const prospect = await createProspect({
    name,
    email,
    company,
    funding_stage,
    annual_revenue_est,
    created_by: user.id,
  });

  // 2. Enqueue KYC_VERIFY task (fire-and-forget).
  //    Idempotency key is scoped to the prospect so retried requests never
  //    double-enqueue.
  const task = await enqueueTask({
    idempotency_key: `kyc_verify:${prospect.id}`,
    agent_type: TASK_TYPE_AGENT_MAP[TaskType.KYC_VERIFY],
    job_type: TaskType.KYC_VERIFY,
    payload: { prospect_id: prospect.id },
    created_by: user.id,
  });

  return new Response(
    JSON.stringify({
      prospect,
      kyc_task_id: task.id,
    }),
    {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
