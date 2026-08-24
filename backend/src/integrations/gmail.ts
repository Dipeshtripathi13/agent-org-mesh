/** Real Gmail reads — read-only scope, today's messages only, metadata + snippet rather
 *  than full bodies. Never writes anything back to Gmail. */

export interface EmailSummary {
  subject: string;
  from: string;
  snippet: string;
}

export async function getEmailsSince(accessToken: string, since: Date): Promise<EmailSummary[]> {
  const query = `after:${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status} ${await listRes.text()}`);
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const ids = list.messages ?? [];

  const emails: EmailSummary[] = [];
  for (const { id } of ids) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!msgRes.ok) continue;
    const msg = (await msgRes.json()) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
    const headers = msg.payload?.headers ?? [];
    emails.push({
      subject: headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)',
      from: headers.find((h) => h.name === 'From')?.value ?? '(unknown sender)',
      snippet: msg.snippet ?? '',
    });
  }
  return emails;
}

export function formatGmailDigest(emails: EmailSummary[]): string | null {
  if (emails.length === 0) return null;
  return emails.map((e) => `- From ${e.from}: "${e.subject}" — ${e.snippet}`).join('\n');
}
