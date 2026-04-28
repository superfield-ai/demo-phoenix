/**
 * @file notifications
 *
 * HTTP handlers for the Sales Rep in-app notification endpoints (Phase 1,
 * P1-2, issue #11).
 *
 * ## Endpoints
 *
 *   GET  /api/notifications
 *     Returns all unread notifications for the authenticated rep, ordered by
 *     created_at DESC.  Each entry includes:
 *       - id, prospect_id, event_type, description, created_at
 *     Also includes an `unread_count` integer in the response envelope.
 *
 *   POST /api/notifications/:id/read
 *     Marks the notification identified by :id as read.  Only the owning rep
 *     may mark their own notifications read; returns 403 for cross-rep access.
 *     Returns 404 if the notification does not exist or is already read.
 *
 * ## Authentication
 *
 * Both endpoints require a valid session cookie.  The authenticated user's ID
 * is used as the `rep_id` filter — reps can only see/mark their own
 * notifications.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/11
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import {
  getUnreadNotifications,
  markNotificationRead,
  type NotificationRow,
} from 'db/notifications';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface NotificationEntry {
  id: string;
  prospect_id: string;
  event_type: string;
  description: string;
  created_at: string;
}

export interface NotificationsResponse {
  notifications: NotificationEntry[];
  unread_count: number;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handles all /api/notifications/* routes.
 *
 * Returns null for paths that do not match — the caller falls through to the
 * next handler.
 */
export async function handleNotificationsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/notifications')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ── GET /api/notifications ───────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const rows: NotificationRow[] = await getUnreadNotifications(user.id, sql);

    const notifications: NotificationEntry[] = rows.map((r) => ({
      id: r.id,
      prospect_id: r.prospect_id,
      event_type: r.event_type,
      description: r.description,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));

    const response: NotificationsResponse = {
      notifications,
      unread_count: notifications.length,
    };

    return json(response);
  }

  // ── POST /api/notifications/:id/read ────────────────────────────────────
  if (req.method === 'POST' && url.pathname.match(/^\/api\/notifications\/[^/]+\/read$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const notificationId = url.pathname.split('/')[3];

    // markNotificationRead enforces the rep_id guard internally.
    const updated = await markNotificationRead(notificationId, user.id, sql);

    if (!updated) {
      return json({ error: 'Notification not found or already read' }, 404);
    }

    return json({ ok: true });
  }

  return null;
}
