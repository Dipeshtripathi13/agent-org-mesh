/** Real transactional email via Resend (resend.com) — a single HTTP POST, no SDK, same
 *  fetch-based-adapter shape as jira.ts/openaiCompatible.ts. Used to notify someone the
 *  moment they're added to an org's chart or invited as an org admin, so a manager
 *  adding people doesn't have to manually relay a temp password over Slack themselves.
 *
 *  UNVERIFIED AGAINST A REAL SEND — built the same way as every other connector in this
 *  project, but there was no real Resend API key available to test against as of
 *  2026-08-21 (see CLAUDE.md's "Where to go next"). Request shape follows Resend's
 *  documented REST API exactly (POST https://api.resend.com/emails), and what *was*
 *  verified without a key: the "not configured" fallback (invite/add-person still works,
 *  temp password still shown once in the UI, no send attempted), and that a request with
 *  an invalid key fails cleanly (a real 401 from Resend, caught and logged, not thrown
 *  past the caller) rather than silently succeeding. Nothing has round-tripped an actual
 *  inbox yet.
 *
 *  Fails open by design: `sendInviteEmail` never throws past what the caller already
 *  handles — see server.ts's usage, which always keeps the one-time temp-password
 *  reveal in the API response as the fallback regardless of whether the email attempt
 *  succeeded, matching the "raw data instead of AI prose" fail-open pattern the model
 *  providers already use. */

const RESEND_API_URL = 'https://api.resend.com/emails';

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface InviteEmailInput {
  to: string;
  recipientName: string;
  invitedByName: string;
  orgName: string;
  /** e.g. "a person in Northbeam's org chart" or "an admin (owner) for Northbeam" —
   *  written once here so the two call sites in server.ts don't duplicate the phrasing. */
  roleDescription: string;
  tempPassword: string;
  loginUrl: string;
}

/** Returns whether the send actually succeeded — never throws. Callers that already have
 *  a perfectly good fallback (the temp password shown once in the API response) should
 *  never have that response derailed by an email provider having a bad day. */
export async function sendInviteEmail(input: InviteEmailInput): Promise<boolean> {
  if (!emailConfigured()) return false;
  const from = process.env.EMAIL_FROM || 'Agent Org Mesh <onboarding@resend.dev>';
  const subject = `${input.invitedByName} added you to ${input.orgName}`;
  const text = [
    `${input.invitedByName} added you as ${input.roleDescription} on Agent Org Mesh.`,
    ``,
    `Sign in at ${input.loginUrl}`,
    `Email: ${input.to}`,
    `Temporary password: ${input.tempPassword}`,
    ``,
    `You can change this password after signing in.`,
  ].join('\n');
  const html = `
    <p>${escapeHtml(input.invitedByName)} added you as ${escapeHtml(input.roleDescription)} on Agent Org Mesh.</p>
    <p><a href="${input.loginUrl}">Sign in</a></p>
    <p>Email: ${escapeHtml(input.to)}<br>Temporary password: <code>${escapeHtml(input.tempPassword)}</code></p>
    <p>You can change this password after signing in.</p>
  `.trim();

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: input.to, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`resend send failed: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('resend send failed:', err);
    return false;
  }
}
