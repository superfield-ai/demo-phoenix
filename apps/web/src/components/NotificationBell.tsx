/**
 * @file NotificationBell.tsx
 *
 * In-app notification bell with unread count badge and notification list panel
 * (Phase 1, P1-2, issue #11).
 *
 * Renders a bell icon button in the nav bar. When clicked it opens a panel
 * listing unread notifications. Each entry shows the company name, event type,
 * description, and timestamp, plus a link to the relevant lead.
 *
 * Polling: unread count is refreshed every 30 seconds while the component is
 * mounted so new notifications surface without a manual reload.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types (mirrors server/api/notifications.ts)
// ---------------------------------------------------------------------------

export interface NotificationEntry {
  id: string;
  prospect_id: string;
  event_type: 'new_lead' | 'score_drop';
  description: string;
  created_at: string;
}

interface NotificationsResponse {
  notifications: NotificationEntry[];
  unread_count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const EVENT_LABELS: Record<string, string> = {
  new_lead: 'New lead',
  score_drop: 'Score drop',
};

const EVENT_COLORS: Record<string, string> = {
  new_lead: 'bg-indigo-100 text-indigo-700',
  score_drop: 'bg-amber-100 text-amber-700',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NotificationBellProps {
  /** Called when the user clicks on a notification entry to navigate to a lead. */
  onSelectLead?: (prospectId: string) => void;
}

export function NotificationBell({ onSelectLead }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationEntry[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { credentials: 'include' });
      if (!res.ok) return;
      const data: NotificationsResponse = await res.json();
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
    } catch {
      // Silently ignore network errors — bell will just show stale count.
    }
  }, []);

  // Initial fetch + polling every 30 seconds.
  useEffect(() => {
    void fetchNotifications();
    const interval = setInterval(() => void fetchNotifications(), 30_000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Close panel when clicking outside.
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  async function markRead(id: string) {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'include',
      });
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // Ignore — will refresh on next poll.
    }
  }

  async function handleNotificationClick(notification: NotificationEntry) {
    setLoading(true);
    await markRead(notification.id);
    setLoading(false);
    setOpen(false);
    onSelectLead?.(notification.prospect_id);
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
        className={`relative p-3 rounded-xl flex items-center justify-center transition-all ${
          open
            ? 'bg-indigo-50 text-indigo-600'
            : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
        }`}
      >
        <Bell size={20} strokeWidth={2.5} />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Notification panel */}
      {open && (
        <div className="absolute left-full top-0 ml-2 z-50 w-80 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <span className="text-sm font-semibold text-zinc-800">Notifications</span>
            {unreadCount > 0 && <span className="text-xs text-zinc-500">{unreadCount} unread</span>}
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-zinc-100">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-400">
                No unread notifications
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => void handleNotificationClick(n)}
                  disabled={loading}
                  className="w-full text-left px-4 py-3 hover:bg-zinc-50 transition-colors group"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${EVENT_COLORS[n.event_type] ?? 'bg-zinc-100 text-zinc-600'}`}
                    >
                      {EVENT_LABELS[n.event_type] ?? n.event_type}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-700 group-hover:text-zinc-900 leading-snug">
                        {n.description}
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {formatRelativeTime(n.created_at)}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
