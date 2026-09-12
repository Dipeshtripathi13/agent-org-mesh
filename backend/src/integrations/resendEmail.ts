/** Transactional email via Resend (resend.com) — a single HTTP POST, no SDK.
 *
 *  Sends one-time links only — invitations, email verification, password reset — never a
 *  password (release audit AUTH-02 / SEC-08).
 *
 *  Verified 2026-09-12: production has RESEND_API_KEY and EMAIL_FROM
 *  (noreply@contact.eternitynest.com, a domain verified in Resend). A direct send to Resend's
 *  delivered@resend.dev test inbox reported `delivered`, and sendInvitationEmail, driven by a
 *  real add-person invite through the local API, returned true and stamped the invitation as
 *  emailed. Without a key nothing is sent and callers fall back as documented at each call site.
 *
 *  EMAIL_TRANSPORT=memory (the API test suite) records messages in `outbox` instead of sending,
 *  so tests can follow real links end to end. It is ignored under NODE_ENV=production. */

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface OutboxMessage { to: string; subject: string; text: string; html: string; sentAt: string }
export const outbox: OutboxMessage[] = [];

const memoryTransport = () => process.env.EMAIL_TRANSPORT === 'memory' && process.env.NODE_ENV !== 'production';

export function emailConfigured(): boolean {
  return memoryTransport() || !!process.env.RESEND_API_KEY;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Returns whether the send succeeded — never throws. */
async function deliver(message: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
  if (memoryTransport()) {
    outbox.push({ ...message, sentAt: new Date().toISOString() });
    return true;
  }
  if (!process.env.RESEND_API_KEY) return false;
  const from = process.env.EMAIL_FROM || 'Agent Org Mesh <onboarding@resend.dev>';
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, ...message }),
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

export interface InvitationEmailInput {
  to: string;
  invitedByName: string;
  orgName: string;
  /** e.g. "Staff Engineer in Northbeam's org chart" or "an admin (viewer) for Northbeam". */
  roleDescription: string;
  acceptUrl: string;
  expiresAt: string;
}

export async function sendInvitationEmail(input: InvitationEmailInput): Promise<boolean> {
  const expires = new Date(input.expiresAt).toUTCString();
  return deliver({
    to: input.to,
    subject: `${input.invitedByName} invited you to ${input.orgName} on Agent Org Mesh`,
    text: [
      `${input.invitedByName} invited you to join ${input.orgName} as ${input.roleDescription}.`,
      ``,
      `Accept the invitation: ${input.acceptUrl}`,
      ``,
      `Sign in or create an account with ${input.to} to accept. This link works once and expires ${expires}.`,
      `If you weren't expecting this, you can ignore this email.`,
    ].join('\n'),
    html: `
      <p>${escapeHtml(input.invitedByName)} invited you to join ${escapeHtml(input.orgName)} as ${escapeHtml(input.roleDescription)}.</p>
      <p><a href="${escapeHtml(input.acceptUrl)}">Accept the invitation</a></p>
      <p>Sign in or create an account with ${escapeHtml(input.to)} to accept. This link works once and expires ${escapeHtml(expires)}.</p>
      <p>If you weren't expecting this, you can ignore this email.</p>`.trim(),
  });
}

export async function sendVerificationEmail(input: { to: string; name: string; verifyUrl: string }): Promise<boolean> {
  return deliver({
    to: input.to,
    subject: 'Verify your email for Agent Org Mesh',
    text: [
      `Hi ${input.name},`,
      ``,
      `Confirm this is your email address to finish setting up Agent Org Mesh: ${input.verifyUrl}`,
      ``,
      `The link works once and expires in 24 hours. If you didn't create an account, ignore this email.`,
    ].join('\n'),
    html: `
      <p>Hi ${escapeHtml(input.name)},</p>
      <p>Confirm this is your email address to finish setting up Agent Org Mesh.</p>
      <p><a href="${escapeHtml(input.verifyUrl)}">Verify my email</a></p>
      <p>The link works once and expires in 24 hours. If you didn't create an account, ignore this email.</p>`.trim(),
  });
}

export async function sendPasswordResetEmail(input: { to: string; name: string; resetUrl: string }): Promise<boolean> {
  return deliver({
    to: input.to,
    subject: 'Reset your Agent Org Mesh password',
    text: [
      `Hi ${input.name},`,
      ``,
      `Someone asked to reset the password for this account. To choose a new one: ${input.resetUrl}`,
      ``,
      `The link works once and expires in 30 minutes. Resetting signs you out everywhere.`,
      `If you didn't ask for this, ignore this email — your password stays the same.`,
    ].join('\n'),
    html: `
      <p>Hi ${escapeHtml(input.name)},</p>
      <p>Someone asked to reset the password for this account.</p>
      <p><a href="${escapeHtml(input.resetUrl)}">Choose a new password</a></p>
      <p>The link works once and expires in 30 minutes. Resetting signs you out everywhere.</p>
      <p>If you didn't ask for this, ignore this email — your password stays the same.</p>`.trim(),
  });
}
