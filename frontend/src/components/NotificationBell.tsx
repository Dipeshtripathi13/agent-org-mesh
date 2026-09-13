import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { badgeLabel, describeAsk, spansSeveralOrgs, timeAgo, unreadLabel, type AskedAboutYou } from '../lib/notifications';

const POLL_MS = 60_000;

/** "Someone asked about you" — a bell in the top bar. Polls once a minute while the tab is
 *  visible (and again whenever it becomes visible), shows an unread badge, and opening it marks
 *  what's shown as read. Every entry is also on the "Who asked about me" screen. */
export function NotificationBell({ onOpenAll }: { onOpenAll: (orgId: number | null) => void }) {
  const [items, setItems] = useState<AskedAboutYou[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.notifications();
      setItems(data.items);
      setUnread(data.unreadCount);
      setFailed(false);
      return data;
    } catch {
      setFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    const whenVisible = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(whenVisible, POLL_MS);
    document.addEventListener('visibilitychange', whenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', whenVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    const data = await load();
    const newest = data?.items[0]?.askedAt;
    if (data && data.unreadCount > 0 && newest) {
      // Entries keep their "new" highlight for as long as the list stays open.
      try {
        await api.markNotificationsSeen(newest);
        setUnread(0);
      } catch {
        /* the count stays; the next poll will try again when it's reopened */
      }
    }
  };

  const showOrg = items ? spansSeveralOrgs(items) : false;
  const badge = badgeLabel(unread);

  return (
    <div className="notif" ref={ref}>
      <button
        type="button"
        className="notif-bell"
        onClick={() => void toggle()}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unreadLabel(unread)}
        title="Notifications"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.6l-1.6 2.9A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6Zm-2.5 15.5a2.5 2.5 0 0 0 5 0"
            fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
        {badge && <span className="notif-badge" aria-hidden="true">{badge}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Who asked about you">
          <div className="notif-head">
            <strong>Who asked about you</strong>
          </div>

          {items == null ? (
            <p className="notif-empty">{failed ? 'Couldn’t load notifications. Try again in a moment.' : 'Loading…'}</p>
          ) : items.length === 0 ? (
            <p className="notif-empty">
              No one has asked about you yet. When someone asks your agent about you, you’ll see it here.
            </p>
          ) : (
            <ul className="notif-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.unread ? 'notif-item is-unread' : 'notif-item'}
                    onClick={() => { setOpen(false); onOpenAll(item.orgId); }}
                  >
                    <span className="notif-line">
                      {item.unread && <span className="notif-dot" aria-label="New" />}
                      {describeAsk(item, showOrg)}
                    </span>
                    <span className="notif-question">“{item.question}”</span>
                    <time className="notif-time" dateTime={item.askedAt} title={new Date(item.askedAt).toLocaleString()}>
                      {timeAgo(item.askedAt)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="notif-all" onClick={() => { setOpen(false); onOpenAll(null); }}>
            See everything in Who asked about me
          </button>
        </div>
      )}
    </div>
  );
}
