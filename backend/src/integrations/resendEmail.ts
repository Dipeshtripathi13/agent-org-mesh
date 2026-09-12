/** Transactional email via Resend (resend.com) — a single HTTP POST, no SDK.
 *
 *  Sends invitation links, never passwords (release audit AUTH-02 / SEC-08): the link is the
 *  one-time proof that its recipient may claim an invited chart entry or admin role.
 *
 *  UNVERIFIED AGAINST A REAL SEND — production has no RESEND_API_KEY configured as of
 *  2026-09-12. The request follows Resend's documented API (POST /emails). Without a key,
 *  nothing is sent and the caller still shows the invitation link once to the inviting admin. */

const RESEND_API_URL = 'https://api.resend.com/emails';

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface InvitationEmailInput {
  to: string;
  invitedByName: string;
  orgName: string;
  /** e.g. "Staff Engineer in Northbeam's org chart" or "an admin (viewer) for Northbeam". */
  roleDescription: string;
  acceptUrl: string;
  expiresAt: string;
}

/** Returns whether the send succeeded — never throws. The inviting admin always sees the
 *  link once regardless, so a provider failure never blocks the invitation itself. */
export async function sendInvitationEmail(input: InvitationEmailInput): Promise<boolean> {
  if (!emailConfigured()) return false;
  const from = process.env.EMAIL_FROM || 'Agent Org Mesh <onboarding@resend.dev>';
  const expires = new Date(input.expiresAt).toUTCString();
  const subject = `${input.invitedByName} invited you to ${input.orgName} on Agent Org Mesh`;
  const text = [
    `${input.invitedByName} invited you to join ${input.orgName} as ${input.roleDescription}.`,
    ``,
    `Accept the invitation: ${input.acceptUrl}`,
    ``,
    `Sign in or create an account with ${input.to} to accept. This link works once and expires ${expires}.`,
    `If you weren't expecting this, you can ignore this email.`,
  ].join('\n');
  const html = `
    <p>${escapeHtml(input.invitedByName)} invited you to join ${escapeHtml(input.orgName)} as ${escapeHtml(input.roleDescription)}.</p>
    <p><a href="${escapeHtml(input.acceptUrl)}">Accept the invitation</a></p>
    <p>Sign in or create an account with ${escapeHtml(input.to)} to accept. This link works once and expires ${escapeHtml(expires)}.</p>
    <p>If you weren't expecting this, you can ignore this email.</p>
  `.trim();

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: input.to, subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`resend send failed: ${res.status} ${await res.text().catch(() => '')}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('resend send failed:', err);
    return false;
  }
}
