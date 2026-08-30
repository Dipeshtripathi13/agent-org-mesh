/** Real Google Calendar reads — deliberately has no connection of its own. It reuses
 *  Gmail's exact OAuth connection (`gmailConnection.ts`'s `getValidGmailAccessToken`): the
 *  same Google sign-in, the same access token, now carrying `calendar.readonly` alongside
 *  `gmail.readonly` (see googleOAuth.ts's SCOPE). Connecting Gmail *is* connecting
 *  Calendar — there's no separate "connect Calendar" button, matching
 *  `connectorCatalog.ts`'s `authType: 'oauth-google', fields: []` for this entry.
 *
 *  UNVERIFIED AGAINST A REAL ACCOUNT — same honest gap as the Gmail bridge itself
 *  (docs/CLAUDE.md): no real Google consent screen has been completed against this app
 *  yet, so this has never round-tripped live either, though it follows Google Calendar's
 *  documented REST API exactly. */
import { getValidGmailAccessToken } from './gmailConnection.js';

export interface CalendarActivityItem {
  summary: string;
  start: string;
  end: string;
}

export async function getRecentCalendarActivity(personId: number, since: Date): Promise<CalendarActivityItem[]> {
  const token = await getValidGmailAccessToken(personId);
  if (!token) return [];
  const params = new URLSearchParams({
    timeMin: since.toISOString(),
    timeMax: new Date().toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '25',
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google Calendar failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: any[] };
  return (data.items ?? []).map((e) => ({
    summary: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
  }));
}

export function formatCalendarDigest(items: CalendarActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- "${i.summary}" (${i.start})`).join('\n');
}
