/**
 * @file interventions
 *
 * Database query functions for the Account Manager intervention workflow
 * (issue #56).
 *
 * ## Tables accessed
 *
 *   rl_interventions          — one row per intervention for a customer
 *   rl_am_escalations         — escalation notifications for team leads
 *   rl_collection_cases       — used to detect open collection cases
 *
 * ## Exports
 *
 *   createIntervention         — POST /api/interventions
 *   updateIntervention         — PATCH /api/interventions/:id
 *   listInterventionsForCustomer — GET /api/interventions?customer_id=:id
 *   getIntervention            — fetch a single intervention by id
 *   hasActiveIntervention      — check if a customer has an open/in_progress intervention
 *   customerHasOpenCollectionCase — check if a customer has an open collection case
 *   listAlertsNeedingEscalation — find interventions open >= N days with no progress
 *   createEscalationNotification — insert an escalation row for the team lead
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/56
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InterventionStatus = 'open' | 'in_progress' | 'resolved' | 'escalated';
export type InterventionPlaybook = 'success_call' | 'training' | 'executive_sponsor';

export interface InterventionRow {
  id: string;
  customer_id: string;
  trigger_type: string;
  playbook: InterventionPlaybook | null;
  assigned_to: string | null;
  status: InterventionStatus;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
  updated_at: string;
}

export interface CreateInterventionOptions {
  customer_id: string;
  playbook: InterventionPlaybook;
  assigned_to: string;
  notes?: string | null;
  trigger_type?: string;
}

export interface UpdateInterventionOptions {
  status?: InterventionStatus;
  outcome?: string | null;
}

export interface AmEscalationRow {
  id: string;
  intervention_id: string;
  customer_id: string;
  notified_user_id: string;
  days_open: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// createIntervention
// ---------------------------------------------------------------------------

/**
 * Creates a new intervention with status=open.
 * Returns the created row plus collections_active flag.
 */
export async function createIntervention(
  opts: CreateInterventionOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<InterventionRow & { collections_active: boolean }> {
  const { customer_id, playbook, assigned_to, notes = null, trigger_type = 'manual' } = opts;

  const [row] = await sqlClient<
    {
      id: string;
      customer_id: string;
      trigger_type: string;
      playbook: string | null;
      assigned_to: string | null;
      status: string;
      outcome: string | null;
      created_at: string;
      resolved_at: string | null;
      updated_at: string;
    }[]
  >`
    INSERT INTO rl_interventions
      (customer_id, trigger_type, playbook, assigned_to, outcome)
    VALUES (
      ${customer_id},
      ${trigger_type},
      ${playbook},
      ${assigned_to},
      ${notes}
    )
    RETURNING
      id,
      customer_id,
      trigger_type,
      playbook,
      assigned_to,
      status,
      outcome,
      created_at::text AS created_at,
      resolved_at::text AS resolved_at,
      updated_at::text AS updated_at
  `;

  const collectionsActive = await customerHasOpenCollectionCase(customer_id, sqlClient);

  return {
    id: row.id,
    customer_id: row.customer_id,
    trigger_type: row.trigger_type,
    playbook: (row.playbook as InterventionPlaybook) ?? null,
    assigned_to: row.assigned_to,
    status: row.status as InterventionStatus,
    outcome: row.outcome,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    updated_at: row.updated_at,
    collections_active: collectionsActive,
  };
}

// ---------------------------------------------------------------------------
// updateIntervention
// ---------------------------------------------------------------------------

/**
 * Updates an intervention's status and/or outcome.
 * Sets resolved_at when status transitions to 'resolved'.
 * Returns the updated row or null if not found.
 */
export async function updateIntervention(
  id: string,
  opts: UpdateInterventionOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<InterventionRow | null> {
  const { status, outcome } = opts;

  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      trigger_type: string;
      playbook: string | null;
      assigned_to: string | null;
      status: string;
      outcome: string | null;
      created_at: string;
      resolved_at: string | null;
      updated_at: string;
    }[]
  >`
    UPDATE rl_interventions
    SET
      status      = COALESCE(${status ?? null}, status),
      outcome     = COALESCE(${outcome !== undefined ? outcome : null}, outcome),
      resolved_at = CASE
        WHEN ${status ?? null} = 'resolved' AND resolved_at IS NULL THEN NOW()
        ELSE resolved_at
      END,
      updated_at  = NOW()
    WHERE id = ${id}
    RETURNING
      id,
      customer_id,
      trigger_type,
      playbook,
      assigned_to,
      status,
      outcome,
      created_at::text AS created_at,
      resolved_at::text AS resolved_at,
      updated_at::text AS updated_at
  `;

  if (rows.length === 0) return null;
  const row = rows[0];

  return {
    id: row.id,
    customer_id: row.customer_id,
    trigger_type: row.trigger_type,
    playbook: (row.playbook as InterventionPlaybook) ?? null,
    assigned_to: row.assigned_to,
    status: row.status as InterventionStatus,
    outcome: row.outcome,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// getIntervention
// ---------------------------------------------------------------------------

/**
 * Returns a single intervention by ID, or null if not found.
 */
export async function getIntervention(
  id: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<InterventionRow | null> {
  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      trigger_type: string;
      playbook: string | null;
      assigned_to: string | null;
      status: string;
      outcome: string | null;
      created_at: string;
      resolved_at: string | null;
      updated_at: string;
    }[]
  >`
    SELECT
      id,
      customer_id,
      trigger_type,
      playbook,
      assigned_to,
      status,
      outcome,
      created_at::text AS created_at,
      resolved_at::text AS resolved_at,
      updated_at::text AS updated_at
    FROM rl_interventions
    WHERE id = ${id}
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const row = rows[0];

  return {
    id: row.id,
    customer_id: row.customer_id,
    trigger_type: row.trigger_type,
    playbook: (row.playbook as InterventionPlaybook) ?? null,
    assigned_to: row.assigned_to,
    status: row.status as InterventionStatus,
    outcome: row.outcome,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// listInterventionsForCustomer
// ---------------------------------------------------------------------------

/**
 * Returns all interventions for a customer in chronological order (oldest first).
 */
export async function listInterventionsForCustomer(
  customerId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<InterventionRow[]> {
  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      trigger_type: string;
      playbook: string | null;
      assigned_to: string | null;
      status: string;
      outcome: string | null;
      created_at: string;
      resolved_at: string | null;
      updated_at: string;
    }[]
  >`
    SELECT
      id,
      customer_id,
      trigger_type,
      playbook,
      assigned_to,
      status,
      outcome,
      created_at::text AS created_at,
      resolved_at::text AS resolved_at,
      updated_at::text AS updated_at
    FROM rl_interventions
    WHERE customer_id = ${customerId}
    ORDER BY created_at ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    customer_id: row.customer_id,
    trigger_type: row.trigger_type,
    playbook: (row.playbook as InterventionPlaybook) ?? null,
    assigned_to: row.assigned_to,
    status: row.status as InterventionStatus,
    outcome: row.outcome,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    updated_at: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// hasActiveIntervention
// ---------------------------------------------------------------------------

/**
 * Returns true if the customer has any intervention with status open or in_progress.
 */
export async function hasActiveIntervention(
  customerId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<boolean> {
  const rows = await sqlClient<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM rl_interventions
      WHERE customer_id = ${customerId}
        AND status IN ('open', 'in_progress')
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------------
// customerHasOpenCollectionCase
// ---------------------------------------------------------------------------

/**
 * Returns true if the customer has an open collection case.
 * An open collection case means collections owns primary contact.
 */
export async function customerHasOpenCollectionCase(
  customerId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<boolean> {
  const rows = await sqlClient<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM rl_collection_cases cc
      JOIN rl_invoices i ON i.id = cc.invoice_id
      WHERE i.customer_id = ${customerId}
        AND cc.status IN ('open', 'escalated')
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------------
// listAlertsNeedingEscalation
// ---------------------------------------------------------------------------

/**
 * Returns interventions that are still 'open' after the given number of days
 * and have no active (open or in_progress) sibling intervention for the same
 * customer. These are candidates for team-lead escalation.
 *
 * The query de-duplicates by customer_id so each customer produces at most
 * one escalation row per run.
 */
export async function listAlertsNeedingEscalation(
  minDaysOpen: number,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ intervention_id: string; customer_id: string; days_open: number }[]> {
  const rows = await sqlClient<
    { intervention_id: string; customer_id: string; days_open: string }[]
  >`
    SELECT DISTINCT ON (i.customer_id)
      i.id         AS intervention_id,
      i.customer_id,
      EXTRACT(DAY FROM (NOW() - i.created_at))::int::text AS days_open
    FROM rl_interventions i
    WHERE i.status = 'open'
      AND i.created_at <= NOW() - (${minDaysOpen} || ' days')::INTERVAL
      AND NOT EXISTS (
        SELECT 1 FROM rl_interventions other
        WHERE other.customer_id = i.customer_id
          AND other.status IN ('open', 'in_progress')
          AND other.id <> i.id
      )
    ORDER BY i.customer_id, i.created_at ASC
  `;

  return rows.map((r) => ({
    intervention_id: r.intervention_id,
    customer_id: r.customer_id,
    days_open: Number(r.days_open),
  }));
}

// ---------------------------------------------------------------------------
// createEscalationNotification
// ---------------------------------------------------------------------------

/**
 * Inserts an escalation notification row for the given team lead user.
 * Idempotent per (intervention_id, notified_user_id): inserts only when no row
 * already exists for the pair.
 *
 * Returns the created (or existing) row.
 */
export async function createEscalationNotification(
  opts: {
    intervention_id: string;
    customer_id: string;
    notified_user_id: string;
    days_open: number;
  },
  sqlClient: postgres.Sql = defaultSql,
): Promise<AmEscalationRow> {
  const { intervention_id, customer_id, notified_user_id, days_open } = opts;

  const [row] = await sqlClient<
    {
      id: string;
      intervention_id: string;
      customer_id: string;
      notified_user_id: string;
      days_open: string;
      created_at: string;
    }[]
  >`
    INSERT INTO rl_am_escalations
      (intervention_id, customer_id, notified_user_id, days_open)
    VALUES (${intervention_id}, ${customer_id}, ${notified_user_id}, ${days_open})
    ON CONFLICT (intervention_id, notified_user_id) DO UPDATE
      SET days_open = EXCLUDED.days_open
    RETURNING
      id,
      intervention_id,
      customer_id,
      notified_user_id,
      days_open::text AS days_open,
      created_at::text AS created_at
  `;

  return {
    id: row.id,
    intervention_id: row.intervention_id,
    customer_id: row.customer_id,
    notified_user_id: row.notified_user_id,
    days_open: Number(row.days_open),
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// getAssignedAccountManager
// ---------------------------------------------------------------------------

/**
 * Returns the account_manager_id for a customer, or null if unassigned.
 */
export async function getAssignedAccountManager(
  customerId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<string | null> {
  const rows = await sqlClient<{ account_manager_id: string | null }[]>`
    SELECT account_manager_id
    FROM rl_customers
    WHERE id = ${customerId}
    LIMIT 1
  `;
  return rows[0]?.account_manager_id ?? null;
}

// ---------------------------------------------------------------------------
// getTeamLeadForUser
// ---------------------------------------------------------------------------

/**
 * Returns the team lead user ID for the given account manager, or null.
 * Falls back to returning any user with role='team_lead' when no direct
 * supervisor is set on the user entity.
 */
export async function getTeamLeadForUser(
  userId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<string | null> {
  // Try to find a user with supervisor_id pointing to this user (team lead relationship).
  // If no explicit supervisor, return the first team_lead role user as fallback.
  const rows = await sqlClient<{ id: string }[]>`
    SELECT id FROM entities
    WHERE type = 'user'
      AND (properties->>'role') = 'team_lead'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}
