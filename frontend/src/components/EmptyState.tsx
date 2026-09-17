import type { ReactNode } from 'react';

/** A quiet, centred "nothing here yet" block with an optional action — used inside panels
 *  instead of a bare sentence so an empty screen still reads as designed. */
export function EmptyState({ icon, title, children, action }: {
  icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon" aria-hidden="true">{icon}</span>}
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** The loading placeholder every screen shows while its first request is in flight. */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" />
      <span className="loading-label">{label}&hellip;</span>
    </div>
  );
}
