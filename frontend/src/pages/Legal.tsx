import type { ReactNode } from 'react';

/**
 * Privacy policy, terms and subprocessor list (release audit UX-08). Public — rendered by
 * App before any auth provider mounts — and linked from sign-in and sign-up.
 *
 * Every statement about what the product does is drawn from the code as of 2026-09-12. Facts
 * only the operator can supply live in LEGAL below and render as visible placeholders until
 * filled in. This is a draft: have counsel review it before relying on it.
 */
const LEGAL = {
  companyName: '[Company legal name]',
  contactEmail: '[privacy contact email]',
  postalAddress: '[registered postal address]',
  governingLaw: '[governing law and courts]',
  liabilityCap: '[liability cap — set with counsel]',
  hostingRegion: '[hosting region, e.g. United States]',
  eventRetention: '[retention period for pushed tool activity]',
  effectiveDate: '[effective date]',
  isDraft: true,
};

export type LegalPageKey = 'privacy' | 'terms' | 'subprocessors';

const PAGES: { key: LegalPageKey; label: string }[] = [
  { key: 'privacy', label: 'Privacy policy' },
  { key: 'terms', label: 'Terms of service' },
  { key: 'subprocessors', label: 'Subprocessors' },
];

export function legalPageFromPath(pathname: string): LegalPageKey | null {
  const match = pathname.match(/^\/legal\/(privacy|terms|subprocessors)\/?$/);
  return match ? (match[1] as LegalPageKey) : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 'var(--text-lg, 18px)', fontWeight: 600, margin: '0 0 8px', textWrap: 'balance' }}>{title}</h2>
      <div style={{ display: 'grid', gap: 10, maxWidth: '68ch', lineHeight: 1.6, color: 'var(--ink2)' }}>{children}</div>
    </section>
  );
}

function Privacy() {
  return (
    <>
      <Section title="Who we are">
        <p>
          Agent Org Mesh is operated by {LEGAL.companyName}, {LEGAL.postalAddress}. Questions about this policy or your
          data: {LEGAL.contactEmail}.
        </p>
      </Section>

      <Section title="What the service does">
        <p>
          Agent Org Mesh answers questions about work across an organization by reading from tools people choose to
          connect. It is read-only: it never creates, edits or deletes anything in a connected tool. What an answer may
          include is decided by your organization&rsquo;s disclosure policy, and anything withheld is shown as withheld.
        </p>
      </Section>

      <Section title="Information we collect">
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li><strong>Your account:</strong> name, email address, and your password stored only as a salted scrypt hash. We keep records of sign-in sessions.</li>
          <li><strong>Organization details an admin enters:</strong> the organization&rsquo;s name, the people in its chart (name, title, team, manager, and optionally an email), who administers it, and its disclosure policy.</li>
          <li><strong>Tools you connect, only when you connect them:</strong> the access token, API key or other credential you provide, and the activity that tool reports back — for example pull request titles, issue titles, pipeline run status, or calendar events. For Gmail, only sender, subject and a short snippet are read, and only to answer your own questions about yourself.</li>
          <li><strong>Activity your own tools send us:</strong> if you create an ingest token and configure a tool such as Claude Code, Codex CLI or a custom agent to use it, the short activity summaries that tool sends.</li>
          <li><strong>Questions and answers:</strong> the questions asked, the answers given, what was withheld, and which tools were consulted. Questions about people in an organization are recorded in that organization&rsquo;s audit log. Chats with a personal agent are stored with your account.</li>
          <li><strong>Technical data:</strong> IP addresses, used for rate limiting and in server logs. We use no analytics, advertising or tracking tools.</li>
        </ul>
      </Section>

      <Section title="What we never collect">
        <p>
          The service has no connector for HR systems such as Workday, contract systems such as Ironclad, benefits data,
          or direct messages. There is no setting that turns these on.
        </p>
      </Section>

      <Section title="How we use it">
        <p>
          To provide the service: answering questions within your organization&rsquo;s policy, showing people who asked
          about them, keeping the audit log, sending invitation emails, and protecting accounts (for example, limiting
          repeated failed sign-ins). We do not sell your information, use it for advertising, or use it to train our own
          models.
        </p>
      </Section>

      <Section title="AI model providers">
        <p>
          To write an answer, the question and only the information the disclosure policy allows are sent to the AI
          model provider configured for your organization or personal agent — Anthropic, OpenAI, or an endpoint your
          administrator sets. Information the policy withholds is never sent to a model. If your organization supplies its
          own provider key or endpoint, that provider&rsquo;s terms govern its handling of the data.
        </p>
      </Section>

      <Section title="Who can see your information">
        <p>
          People in your organization see only what its disclosure policy allows for their relationship to you. You can
          see every question asked about you and by whom. Administrators of your organization can view its audit log.
          Personal-agent chats are visible only to you.
        </p>
      </Section>

      <Section title="Cookies and third-party requests">
        <p>
          We set two cookies, both strictly necessary: <code>aom_session</code> keeps you signed in (HTTP-only, up to 7
          days), and <code>aom_oauth_state</code> protects a Google connection while it is in progress (10 minutes). The
          app loads its fonts from Google Fonts, so your browser sends your IP address to Google when a page loads.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Account and organization data is kept while the account or organization exists. Audit log entries are
          append-only by design and are kept for the life of the organization, so the record of what was disclosed
          cannot be rewritten. Disconnecting a tool deletes its stored credential. You can delete personal-agent chats at
          any time. Activity sent by your own tools is kept for {LEGAL.eventRetention}.
        </p>
      </Section>

      <Section title="Your choices">
        <p>
          In the app you can disconnect any tool, revoke ingest tokens, delete personal chats, and export everything held
          about you in an organization (Controls &rarr; Export). To delete your account or exercise any other right you
          have under applicable law, email {LEGAL.contactEmail}.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Connections are encrypted in transit. Passwords are stored as salted scrypt hashes and session tokens as SHA-256
          hashes. Credentials for tools you connect, and model provider keys an organization supplies, are encrypted at
          rest with AES-256-GCM. The audit log is hash-chained so tampering is detectable.
        </p>
      </Section>

      <Section title="Where data is stored">
        <p>Service data is hosted with Railway in {LEGAL.hostingRegion}. See the subprocessor list for every provider involved.</p>
      </Section>

      <Section title="Children">
        <p>The service is intended for work use and is not directed to anyone under 16.</p>
      </Section>

      <Section title="Region-specific rights">
        <p>[Jurisdiction-specific section — for example GDPR legal bases and data subject rights, or CCPA notices — to be completed with counsel.]</p>
      </Section>

      <Section title="Changes">
        <p>We will update the effective date above when this policy changes, and notify account holders by email of material changes.</p>
      </Section>
    </>
  );
}

function Terms() {
  return (
    <>
      <Section title="Agreement">
        <p>
          These terms are an agreement between you and {LEGAL.companyName}. By creating an account or using Agent Org
          Mesh you agree to them. If you use it on behalf of an organization, you confirm you are authorized to accept
          them for that organization.
        </p>
      </Section>

      <Section title="The service">
        <p>
          Agent Org Mesh reads from tools you connect and answers questions within your organization&rsquo;s disclosure
          policy. It does not write to connected tools. Features may change while the service is in beta.
        </p>
      </Section>

      <Section title="Your account">
        <p>
          Give accurate information, keep your password confidential, and tell us at {LEGAL.contactEmail} if you believe
          your account has been accessed without permission. You are responsible for activity under your account.
        </p>
      </Section>

      <Section title="Organization administrators">
        <p>
          If you administer an organization, you are responsible for having the authority to add people to it, for
          informing them that the service is in use, and for the disclosure policy you set.
        </p>
      </Section>

      <Section title="Acceptable use">
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li>Connect only tools and accounts you are authorized to use, and only within those tools&rsquo; own terms.</li>
          <li>Do not attempt to access data, accounts or organizations you are not permitted to, or to get around the disclosure policy or rate limits.</li>
          <li>Do not probe, scan or load-test the service without written permission.</li>
          <li>Do not use the service to break the law or infringe anyone&rsquo;s rights.</li>
        </ul>
      </Section>

      <Section title="Your content">
        <p>
          You keep your rights in the information you and your tools provide. You grant us permission to process it only
          as needed to provide and secure the service, as described in the privacy policy.
        </p>
      </Section>

      <Section title="AI-generated answers">
        <p>
          Answers are written by AI models and can be incomplete or wrong. Check anything important against the source
          before acting on it. Withheld items are shown so you know an answer is partial.
        </p>
      </Section>

      <Section title="Third-party tools and providers">
        <p>
          Connected tools and AI model providers are run by other companies under their own terms. We are not responsible
          for their availability or for changes they make that affect what can be read.
        </p>
      </Section>

      <Section title="Fees">
        <p>[Pricing terms — for example, free during beta; paid plans billed as described at purchase.]</p>
      </Section>

      <Section title="Ending your use">
        <p>
          You can stop using the service at any time and ask us to delete your account. We may suspend or end access for
          a breach of these terms or to protect the service or other users.
        </p>
      </Section>

      <Section title="Disclaimers and liability">
        <p>
          The service is provided &ldquo;as is&rdquo; without warranties to the extent the law allows. Our total liability
          is limited to {LEGAL.liabilityCap}.
        </p>
      </Section>

      <Section title="Governing law">
        <p>These terms are governed by {LEGAL.governingLaw}.</p>
      </Section>

      <Section title="Changes and contact">
        <p>We will update the effective date when these terms change. Contact: {LEGAL.contactEmail}.</p>
      </Section>
    </>
  );
}

const SUBPROCESSORS = [
  { name: 'Railway', purpose: 'Application hosting and database', data: 'All service data', when: 'Always' },
  { name: 'Anthropic', purpose: 'AI model (Claude)', data: 'Questions and the policy-allowed information needed to answer them', when: 'When the configured agent is Claude on our key' },
  { name: 'OpenAI', purpose: 'AI model', data: 'Questions and the policy-allowed information needed to answer them', when: 'When the configured agent is an OpenAI model on our key' },
  { name: 'Resend', purpose: 'Transactional email', data: 'Recipient name and email, invitation content', when: 'When invitation email is enabled' },
  { name: 'Google', purpose: 'Gmail and Calendar sign-in; web fonts', data: 'OAuth tokens for accounts you connect; visitor IP address for fonts', when: 'When you connect Gmail or Calendar; on every page load (fonts)' },
];

function Subprocessors() {
  return (
    <>
      <Section title="Providers that process data for us">
        <p>These companies process data on our behalf to run the service.</p>
      </Section>
      <div className="scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr><th>Provider</th><th>Purpose</th><th>Data involved</th><th>When</th></tr>
          </thead>
          <tbody>
            {SUBPROCESSORS.map((s) => (
              <tr key={s.name}><td>{s.name}</td><td>{s.purpose}</td><td>{s.data}</td><td>{s.when}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Section title="Tools you connect">
        <p>
          Tools you choose to connect — such as GitHub, Jira, Confluence, Linear, Notion, Asana, GitLab, HubSpot, Zendesk,
          Trello, Airflow, dbt Cloud, Snowflake or Databricks — are not our subprocessors. You direct us to read from them
          under your own agreement with each vendor, and we only read.
        </p>
      </Section>
      <Section title="Organization-supplied providers">
        <p>
          If your organization sets its own model provider key or endpoint, that provider processes data under your
          organization&rsquo;s agreement with it, not ours.
        </p>
      </Section>
    </>
  );
}

export function Legal({ page }: { page: LegalPageKey }) {
  const current = PAGES.find((p) => p.key === page)!;
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #fff)' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', paddingBlock: '32px 72px', paddingInline: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <a href="/" className="brand" style={{ color: 'var(--ink)', textDecoration: 'none' }}>Agent Org Mesh</a>
          <nav aria-label="Legal" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13 }}>
            {PAGES.map((p) => (
              <a key={p.key} href={`/legal/${p.key}`} aria-current={p.key === page ? 'page' : undefined}
                style={{ color: p.key === page ? 'var(--ink)' : 'var(--accent)', fontWeight: p.key === page ? 600 : 400 }}>
                {p.label}
              </a>
            ))}
          </nav>
        </div>

        {LEGAL.isDraft && (
          <p role="note" style={{ marginTop: 20, fontSize: 13, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '9px 12px' }}>
            Draft &mdash; bracketed items still need to be completed, and this text should be reviewed with counsel before
            it is relied on.
          </p>
        )}

        <div className="crumb" style={{ marginTop: 24 }}>Legal</div>
        <h1>{current.label}</h1>
        <p className="sub">Effective {LEGAL.effectiveDate}</p>

        {page === 'privacy' && <Privacy />}
        {page === 'terms' && <Terms />}
        {page === 'subprocessors' && <Subprocessors />}

        <p className="glossary" style={{ marginTop: 40 }}>
          <a href="/">Back to Agent Org Mesh</a>
        </p>
      </div>
    </div>
  );
}
