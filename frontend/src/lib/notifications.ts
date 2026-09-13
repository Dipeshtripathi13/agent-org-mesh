/** Pure helpers behind the top-bar notification bell (components/NotificationBell.tsx). */

export interface AskedAboutYou {
  id: string;
  askedAt: string;
  askerName: string;
  askerRole: string;
  question: string;
  personId: number;
  orgId: number;
  orgName: string;
  unread: boolean;
}

/** What the badge on the bell says: nothing at zero, and never more than two characters. */
export function badgeLabel(unread: number): string {
  if (unread <= 0) return '';
  return unread > 9 ? '9+' : String(unread);
}

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", then a date. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(then.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** The sentence a notification reads as: "Marta Vieira asked about you, as an executive".
 *  The role is the one the asker claimed for that question (the policy engine checked it
 *  against the org chart). "Self" never appears, since asking about yourself isn't a
 *  notification. */
export function describeAsk(item: AskedAboutYou, showOrg: boolean): string {
  const where = showOrg ? ` in ${item.orgName}` : '';
  return `${item.askerName} asked about you${where}, as ${articleFor(item.askerRole)} ${item.askerRole.toLowerCase()}`;
}

function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** Org names are only worth showing when the list actually spans more than one org. */
export function spansSeveralOrgs(items: AskedAboutYou[]): boolean {
  return new Set(items.map((i) => i.orgId)).size > 1;
}

export function unreadLabel(unread: number): string {
  return unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`;
}
