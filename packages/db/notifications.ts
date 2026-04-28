/**
 * @file notifications
 *
 * Database query helpers for in-app notifications (Phase 1, P1-2, issue #11).
 *
 * ## Tables accessed
 *
 *   rl_notifications  — one row per notification event for a rep
 *
 * ## Row shapes
 *
 *   NotificationRow   — a row returned by getUnreadNotifications
 *
 * ## Query semantics
 *
 *   createNotification:
 *     - Inserts a new notification row for the given rep.
 *
 *   getUnreadNotifications:
 *     - Returns unread (read_at IS NULL) notifications for the requesting rep.
 *     - Ordered by created_at DESC.
 *
 *   markNotificationRead:
 *     - Sets read_at = NOW() on the given notification row.
 *     - Returns the updated row, or null if not found / already read.
 *     - Authorization check (rep_id match) is enforced at the caller.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/11
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event type values stored in rl_notifications.event_type. */
export type NotificationEventType = 'new_lead' | 'score_drop';

/** A single notification row. */
export interface NotificationRow {
  id: string;
  rep_id: string;
  prospect_id: string;
  event_type: NotificationEventType;
  description: string;
  read_at: Date | null;
  created_at: Date;
}

/** Options for creating a notification. */
export interface CreateNotificationOptions {
  rep_id: string;
  prospect_id: string;
  event_type: NotificationEventType;
  description: string;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Inserts a new notification row for the given rep.
 *
 * @param opts       Notification data.
 * @param sqlClient  Optional postgres client (for tests).
 * @returns          The inserted notification row.
 */
export async function createNotification(
  opts: CreateNotificationOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<NotificationRow> {
  const { rep_id, prospect_id, event_type, description } = opts;
  const [row] = await sqlClient<NotificationRow[]>`
    INSERT INTO rl_notifications (rep_id, prospect_id, event_type, description)
    VALUES (${rep_id}, ${prospect_id}, ${event_type}, ${description})
    RETURNING *
  `;
  return row;
}

/**
 * Sets read_at = NOW() on the notification row identified by id.
 *
 * Authorization (rep_id match) must be enforced by the caller before this
 * function is invoked.
 *
 * @param id         The notification ID.
 * @param repId      The rep's user ID (used as WHERE guard).
 * @param sqlClient  Optional postgres client (for tests).
 * @returns          The updated row, or null when not found.
 */
export async function markNotificationRead(
  id: string,
  repId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<NotificationRow | null> {
  const rows = await sqlClient<NotificationRow[]>`
    UPDATE rl_notifications
    SET read_at = NOW()
    WHERE id = ${id}
      AND rep_id = ${repId}
      AND read_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns all unread notifications for the given rep, ordered by
 * created_at DESC.
 *
 * @param repId      The authenticated rep's user ID.
 * @param sqlClient  Optional postgres client (for tests).
 * @returns          Array of unread notification rows (may be empty).
 */
export async function getUnreadNotifications(
  repId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<NotificationRow[]> {
  return sqlClient<NotificationRow[]>`
    SELECT *
    FROM rl_notifications
    WHERE rep_id = ${repId}
      AND read_at IS NULL
    ORDER BY created_at DESC
  `;
}
