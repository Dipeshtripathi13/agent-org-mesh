import { useEffect, useMemo, useState } from 'react';
import { api, type AgentRuntime, type OrgAdmin, type OrgMainAgent, type OrgRole, type Person } from '../lib/api';
import { CredentialsFields } from '../components/primitives';
import { useAuth } from '../lib/AuthContext';
import { useOrg } from '../lib/OrgContext';
import { useStepUp } from '../lib/StepUpContext';

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', viewer: 'Viewer' };
const ROLES: OrgRole[] = ['owner', 'admin', 'viewer'];
const SCOPE_LABEL: Record<'full' | 'narrow' | 'pending', string> = {
  full: 'Full scope', narrow: 'Narrowed scope', pending: 'Awaiting approval',
};

function OrganizationList() {
  const { orgId, organizations, setOrgId, refresh } = useOrg();
  const { refresh: refreshAuth } = useAuth();
  const { runWithStepUp } = useStepUp();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { organization } = await runWithStepUp(() => api.createOrganization(name.trim()));
      setName('');
      // Creating an org also makes the caller its first person now (see api.ts's own
      // comment) — AuthContext's orgRoles/people are what App.tsx's Shell uses to decide
      // whether "My agent" still shows the empty "no organization yet" state and whether
      // Admin's sidebar is still limited to just this screen, so both need a refresh, not
      // just OrgContext's own org list.
      await Promise.all([refresh(), refreshAuth()]);
      setOrgId(organization.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not create organization');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <header>
        <span className="label">Your organizations</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
          {organizations.length} set up
        </span>
      </header>
      <div className="inner">
        {organizations.map((o) => (
          <button
            key={o.id}
            onClick={() => setOrgId(o.id)}
            aria-pressed={o.id === orgId}
            className="org-pick"
          >
            <span>
              <span className="org-pick-name">{o.name}</span>
              <span className="org-pick-meta">{o.slug} &middot; created {o.createdAt.slice(0, 10)}</span>
            </span>
            <span className="org-pick-count">{o.peopleCount} {o.peopleCount === 1 ? 'person' : 'people'}</span>
          </button>
        ))}

        <div className="form-row" style={{ marginTop: 12, borderTop: '1px solid var(--rule)', paddingTop: 12 }}>
          <input
            aria-label="New organization name"
            placeholder="New organization name&hellip;"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            className="input" style={{ flex: 1 }}
          />
          <button
            disabled={busy || !name.trim()}
            onClick={create}
            className="btn btn-primary btn-sm"
          >
            + Create
          </button>
        </div>
        {error && <p style={{ fontSize: 11, color: 'var(--hold)', marginTop: 8 }}>{error}</p>}
        <p className="glossary" style={{ marginTop: 10 }}>
          One admin, several organizations. Switching here changes what every other Admin
          screen shows — the same selector is in the topbar.
        </p>
      </div>
    </div>
  );
}

const EMPTY_FORM = { name: '', title: '', team: '', managerId: '' as number | '', agentDeployed: true, email: '' };

function ChartBuilder() {
  const { orgId, organizations, refresh } = useOrg();
  const { orgRoles } = useAuth();
  const { runWithStepUp } = useStepUp();
  const canEdit = orgRoles[orgId] === 'owner' || orgRoles[orgId] === 'admin';
  const org = organizations.find((o) => o.id === orgId);
  const [people, setPeople] = useState<Person[]>([]);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Adding someone with an email issues a one-time invitation link (release audit SEC-08):
  // shown once here, and emailed too when email is configured.
  const [justAdded, setJustAdded] = useState<{ name: string; invite: InviteLinkT } | null>(null);
  const [resetFor, setResetFor] = useState<{ name: string; email: string | null; tempPassword: string } | null>(null);

  // Emails and sign-in status come from an admin-only endpoint; if it's refused, the chart
  // still renders without them.
  const [details, setDetails] = useState<Map<number, Awaited<ReturnType<typeof api.orgPeopleDetails>>['people'][number]>>(new Map());
  const [openDetails, setOpenDetails] = useState<number | null>(null);
  const load = () => Promise.all([
    api.org(orgId).then((d) => setPeople(d.people)),
    api.orgPeopleDetails(orgId)
      .then((d) => setDetails(new Map(d.people.map((x) => [x.personId, x]))))
      .catch(() => setDetails(new Map())),
  ]);
  useEffect(() => { void load(); setForm(EMPTY_FORM); setError(null); setJustAdded(null); }, [orgId]);

  const children = useMemo(() => {
    const m = new Map<number, Person[]>();
    for (const p of people) {
      if (p.managerId == null) continue;
      const arr = m.get(p.managerId) ?? [];
      arr.push(p);
      m.set(p.managerId, arr);
    }
    return m;
  }, [people]);

  const rows = useMemo(() => {
    const out: { person: Person; depth: number; hasKids: boolean }[] = [];
    const walk = (p: Person, depth: number) => {
      const kids = children.get(p.id) ?? [];
      out.push({ person: p, depth, hasKids: kids.length > 0 });
      if (!collapsed[p.id]) for (const k of kids) walk(k, depth + 1);
    };
    for (const p of people) if (p.managerId == null) walk(p, 0);
    return out;
  }, [people, children, collapsed]);

  const addPerson = async () => {
    if (!form.name.trim() || !form.title.trim() || !form.team.trim()) {
      setError('name, title, and team are required');
      return;
    }
    setBusy(true);
    setError(null);
    setJustAdded(null);
    try {
      const { invite } = await api.addPerson(orgId, {
        name: form.name.trim(),
        title: form.title.trim(),
        team: form.team.trim(),
        managerId: form.managerId === '' ? null : form.managerId,
        agentDeployed: form.agentDeployed,
        email: form.email.trim() || undefined,
      });
      if (invite) setJustAdded({ name: form.name.trim(), invite });
      setForm(EMPTY_FORM);
      await load();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not add person');
    } finally {
      setBusy(false);
    }
  };

  /** Admin-initiated reset — the no-email half of "I forgot my password". The server
   *  refuses (409) for an account that also belongs to another organization, since an
   *  `accounts` row is a global login rather than something this org owns; that error is
   *  surfaced as-is rather than second-guessed here. */
  const resetPassword = async (id: number, name: string) => {
    setError(null);
    setResetFor(null);
    try {
      const { tempPassword, email } = await runWithStepUp(() => api.resetPersonPassword(orgId, id));
      setResetFor({ name, email, tempPassword });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reset that password');
    }
  };

  const removePerson = async (id: number) => {
    setError(null);
    try {
      await runWithStepUp(() => api.removePerson(orgId, id));
      await load();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not remove person');
    }
  };

  if (!org) {
    return (
      <div className="panel" style={{ marginTop: 0 }}>
        <div className="inner">
          <p className="sub" style={{ margin: 0 }}>Create an organization to start building its chart.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <header>
        <span className="label">{org.name} &middot; org chart</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{people.length} people</span>
      </header>

      <div className="inner" style={{ borderBottom: '1px solid var(--rule)' }}>
        {/* auto-fit + minWidth:0 on each input — plain 1fr columns don't actually shrink
            below an <input>'s intrinsic content width, which is how this used to overflow
            its own panel (and drag the whole page into horizontal scroll) once the panel
            itself got narrower than three inputs' natural width. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          <input
            aria-label="Name" placeholder="Name"
            value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            style={{ height: 32, minWidth: 0, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
          />
          <input
            aria-label="Title" placeholder="Title"
            value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            style={{ height: 32, minWidth: 0, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
          />
          <input
            aria-label="Team" placeholder="Team"
            value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}
            style={{ height: 32, minWidth: 0, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <select
            aria-label="Manager"
            value={form.managerId}
            onChange={(e) => setForm((f) => ({ ...f, managerId: e.target.value === '' ? '' : Number(e.target.value) }))}
            className="input" style={{ flex: '1 1 180px', minWidth: 0 }}
          >
            <option value="">No manager — top of chart</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name} &middot; {p.title}</option>)}
          </select>
          <input
            aria-label="Email (optional — sends an invitation link)"
            placeholder="Email (optional invite)"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            className="input" style={{ flex: '1 1 160px', minWidth: 0 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={form.agentDeployed}
              onChange={(e) => setForm((f) => ({ ...f, agentDeployed: e.target.checked }))}
            />
            agent deployed
          </label>
          <button
            disabled={busy || !canEdit}
            onClick={addPerson}
            title={canEdit ? undefined : 'Viewers can see the org chart but not edit it'}
            className="btn btn-primary btn-sm"
          >
            + Add person
          </button>
        </div>
        {error && <p style={{ fontSize: 11, color: 'var(--hold)', marginTop: 8 }}>{error}</p>}
        {justAdded && <InviteLinkNote who={justAdded.name} invite={justAdded.invite} />}
        {resetFor && (
          <div className="coverage-note" style={{ marginTop: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--hold)' }}>
              Shown once &mdash; new temporary password for {resetFor.name}
            </span>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, margin: '8px 0', wordBreak: 'break-all', background: 'var(--panel-bg, #f4f4f2)', padding: '7px 9px', borderRadius: 2 }}>
              {resetFor.email ? `${resetFor.email} · ` : ''}{resetFor.tempPassword}
            </p>
            <p style={{ fontSize: 11, color: 'var(--ink3)', margin: 0 }}>
              Their old password no longer works and they&rsquo;ve been signed out
              everywhere. Hand this over through a channel you trust &mdash; they&rsquo;ll
              have to choose their own password the moment they sign in with it.
            </p>
          </div>
        )}
        <p className="glossary" style={{ marginTop: 8 }}>
          New people start with every surface disconnected — nothing is asserted about them
          until an admin or the employee connects one, from Connections or Controls. Add
          an email and they get a one-time invitation link to claim this place in the chart
          with their own login; nothing is linked until someone signed in with that exact
          email accepts it.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="inner">
          <p style={{ margin: 0, fontSize: 12, color: 'var(--ink2)' }}>
            No one added yet. Start at the top — add whoever has no manager first.
          </p>
        </div>
      ) : (
        <div>
          {rows.map(({ person: p, depth, hasKids }) => (
            <div key={p.id} className={`tree-row${p.agentDeployed ? '' : ' no-agent'}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: depth * 18, minWidth: 0 }}>
                {hasKids ? (
                  <button className="tree-toggle" onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
                    {collapsed[p.id] ? '+' : '−'}
                  </button>
                ) : (
                  <span className="tree-toggle leaf">&middot;</span>
                )}
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--ink3)' }}>{p.title}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{p.team}</span>
                  </span>
                  {details.get(p.id)?.email && (
                    <span style={{ fontSize: 11, color: 'var(--ink3)', overflowWrap: 'anywhere' }}>{details.get(p.id)!.email}</span>
                  )}
                </span>
              </div>
              <span style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
                {details.has(p.id) && (
                  <button
                    className="chip"
                    aria-expanded={openDetails === p.id}
                    aria-controls={`person-details-${p.id}`}
                    onClick={() => setOpenDetails((cur) => (cur === p.id ? null : p.id))}
                  >
                    {openDetails === p.id ? 'Hide details' : 'Details'}
                  </button>
                )}
                {canEdit && p.accountId != null && (
                  <button
                    className="chip"
                    title={`Issue ${p.name} a new temporary password`}
                    onClick={() => resetPassword(p.id, p.name)}
                  >
                    Reset password
                  </button>
                )}
                {canEdit && <button className="chip" onClick={() => removePerson(p.id)}>Remove</button>}
              </span>
              {openDetails === p.id && details.get(p.id) && (
                <PersonDetailsPanel
                  id={`person-details-${p.id}`}
                  person={p}
                  details={details.get(p.id)!}
                  manager={people.find((m) => m.id === p.managerId) ?? null}
                  indent={depth * 18}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** The expanded "Details" block under one person in the chart. */
function PersonDetailsPanel({ id, person, details, manager, indent }: {
  id: string;
  person: Person;
  details: Awaited<ReturnType<typeof api.orgPeopleDetails>>['people'][number];
  manager: Person | null;
  indent: number;
}) {
  const signIn =
    details.status === 'active'
      ? details.lastSignInAt ? `Has a login · last signed in ${formatDate(details.lastSignInAt)}` : 'Has a login · hasn’t signed in yet'
    : details.status === 'invited' && details.invitation
      ? `Invitation ${details.invitation.emailed ? 'emailed' : 'created (link shared by hand)'} ${formatDate(details.invitation.sentAt)} · expires ${formatDate(details.invitation.expiresAt)}`
    : details.status === 'invite-expired' && details.invitation
      ? `Invitation expired ${formatDate(details.invitation.expiresAt)} — they can’t sign in until they’re invited again`
    : 'No login — added without an email, so they can’t sign in yet';
  const rows: [string, string][] = [
    ['Email', details.email ?? '—'],
    ['Sign-in', signIn],
    ['Title', person.title],
    ['Team', person.team],
    ['Reports to', manager ? `${manager.name} · ${manager.title}` : 'No one — top of the chart'],
    ['Admin role', details.adminRole ? details.adminRole[0].toUpperCase() + details.adminRole.slice(1) : 'Not an admin'],
    ['Agent', person.agentDeployed ? 'Deployed' : 'Not deployed'],
    ['Connected tools', details.connectedTools.length ? details.connectedTools.join(', ') : 'None yet'],
  ];
  return (
    <div id={id} style={{ flexBasis: '100%', margin: `8px 0 4px ${indent + 25}px`, padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)' }}>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, max-content) 1fr', gap: '6px 16px', margin: 0, fontSize: 12 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--ink3)' }}>{label}</dt>
            <dd style={{ margin: 0, color: 'var(--ink)', overflowWrap: 'anywhere' }}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const EMPTY_INVITE = { email: '', name: '', role: 'admin' as OrgRole };

/** Real multi-admin RBAC, not a placeholder — every action here round-trips through
 *  server-side role checks (backend/src/server.ts's requireOrgRole); this UI only grays
 *  out what the server would reject anyway, the same "convenience, not the boundary"
 *  split roles.ts already documents for Ask's role chips. */
function OrgAdmins() {
  const { account: me, orgRoles } = useAuth();
  const { orgId, organizations } = useOrg();
  const { runWithStepUp } = useStepUp();
  const org = organizations.find((o) => o.id === orgId);
  const myRole = orgRoles[orgId];
  const isOwner = myRole === 'owner';

  const [admins, setAdmins] = useState<OrgAdmin[]>([]);
  const [invite, setInvite] = useState(EMPTY_INVITE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justInvited, setJustInvited] = useState<InviteLinkT | null>(null);
  const [pending, setPending] = useState<PendingT[]>([]);

  const load = () => {
    void api.orgAdmins(orgId).then((d) => setAdmins(d.admins)).catch(() => setAdmins([]));
    // Admins and owners only; a viewer gets a 403 and simply sees no pending list.
    void api.orgInvitations(orgId).then((d) => setPending(d.invitations)).catch(() => setPending([]));
  };
  // Only fetch once `orgId` is confirmed to be one of this account's real orgs (`org`
  // resolved from the list `useOrg` already loaded) — orgId starts at a hardcoded
  // default before that list arrives, and firing this admin-scoped request against a
  // stale/inaccessible org in that brief window was a real, if harmless, spurious 403.
  useEffect(() => {
    setInvite(EMPTY_INVITE);
    setError(null);
    setJustInvited(null);
    if (org) void load(); else setAdmins([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, org?.id]);

  const inviteAdmin = async () => {
    if (!invite.email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { invite: link } = await runWithStepUp(() => api.inviteOrgAdmin(orgId, invite.email.trim(), invite.name.trim(), invite.role));
      setInvite(EMPTY_INVITE);
      load();
      setJustInvited(link);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not invite admin');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (accountId: number, role: OrgRole) => {
    setError(null);
    try {
      await runWithStepUp(() => api.setOrgAdminRole(orgId, accountId, role));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not change role');
    }
  };

  const revoke = async (invitationId: string) => {
    setError(null);
    try {
      await runWithStepUp(() => api.revokeInvitation(orgId, invitationId));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not withdraw that invitation');
    }
  };

  const remove = async (accountId: number) => {
    setError(null);
    try {
      await runWithStepUp(() => api.removeOrgAdmin(orgId, accountId));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not remove admin');
    }
  };

  if (!org) return null;

  return (
    <div className="panel">
      <header>
        <span className="label">{org.name} &middot; admins</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
          {admins.length} {admins.length === 1 ? 'admin' : 'admins'} &middot; you're {myRole ? ROLE_LABEL[myRole] : 'not a member'}
        </span>
      </header>
      <div className="inner">
        <div className="scroll">
        <table>
          <tbody>
            {admins.map((a) => (
              <tr key={a.accountId}>
                <td style={{ fontSize: 13 }}>
                  {a.name} {a.accountId === me?.id && <span style={{ color: 'var(--ink4)' }}>(you)</span>}
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{a.email}</div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {isOwner ? (
                    <select
                      aria-label={`Role for ${a.email}`}
                      value={a.role}
                      onChange={(e) => changeRole(a.accountId, e.target.value as OrgRole)}
                      style={{ height: 28, border: '1px solid var(--rule2)', borderRadius: 2, fontSize: 11, padding: '0 6px' }}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{ROLE_LABEL[a.role]}</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {isOwner && (
                    <button className="chip" onClick={() => remove(a.accountId)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        {isOwner && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, borderTop: '1px solid var(--rule)', paddingTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 160 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>Email</span>
              <input
                aria-label="Invite email"
                placeholder="name@company.com"
                value={invite.email}
                onChange={(e) => setInvite((f) => ({ ...f, email: e.target.value }))}
                className="input"
              />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 140 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>Name</span>
              <input
                aria-label="Invite name"
                placeholder="Name"
                value={invite.name}
                onChange={(e) => setInvite((f) => ({ ...f, name: e.target.value }))}
                className="input"
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>Role</span>
              <select
                aria-label="Invite role"
                value={invite.role}
                onChange={(e) => setInvite((f) => ({ ...f, role: e.target.value as OrgRole }))}
                className="input"
              >
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </label>
            <button
              disabled={busy || !invite.email.trim()}
              onClick={inviteAdmin}
              className="btn btn-primary btn-sm"
            >
              + Invite
            </button>
          </div>
        )}

        {error && <p style={{ fontSize: 11, color: 'var(--hold)', marginTop: 8 }}>{error}</p>}

        {justInvited && <InviteLinkNote who={justInvited.email} invite={justInvited} />}

        {pending.length > 0 && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--rule)', paddingTop: 12 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Pending invitations
            </span>
            <div className="scroll" style={{ marginTop: 6 }}>
              <table>
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.id}>
                      <td style={{ fontSize: 12 }}>
                        {p.email}
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>
                          {p.kind === 'admin' ? `admin · ${p.adminRole}` : `chart · ${p.personName}`} &middot; expires {new Date(p.expiresAt).toLocaleDateString()}
                          {p.emailSent ? ' · emailed' : ' · link shared manually'}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {(isOwner || (myRole === 'admin' && p.kind === 'person')) && (
                          <button className="chip" onClick={() => revoke(p.id)}>Withdraw</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="glossary" style={{ marginTop: isOwner ? 8 : 14 }}>
          {isOwner
            ? 'Owners can invite, promote/demote, and remove other admins for this org. Admins can do everything else that changes org state; viewers can see admin screens but not change anything — the server enforces this on every request, not just this page.'
            : 'Only an owner can manage who has access to this organization.'}
        </p>
      </div>
    </div>
  );
}

type InviteLinkT = NonNullable<Awaited<ReturnType<typeof api.addPerson>>['invite']>;
type PendingT = Awaited<ReturnType<typeof api.orgInvitations>>['invitations'][number];

/** The one-time invitation link, shown once to the admin who created it. */
function InviteLinkNote({ who, invite }: { who: string; invite: InviteLinkT }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="coverage-note" style={{ marginTop: 10 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: invite.emailSent ? 'var(--good, #2c6e4f)' : 'var(--hold)' }}>
        {invite.emailSent
          ? `Invitation emailed to ${invite.email} — the link is also shown once below`
          : `Shown once — no email was sent, so copy this link and send it to ${who} yourself`}
      </span>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12, margin: '8px 0', wordBreak: 'break-all', background: 'var(--panel-bg, #f4f4f2)', padding: '7px 9px', borderRadius: 2 }}>
        {invite.url}
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="chip" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
        <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
          Works once, only for someone signed in as {invite.email}, until {new Date(invite.expiresAt).toLocaleDateString()}.
        </span>
      </div>
    </div>
  );
}

/** The org's one main/aggregator agent — admin/owner-settable here, read-only everywhere
 *  else ("Set up my agent" for every person in the org shows the same registration with
 *  no edit controls). Mirrors OrgAdmins' load-on-org-change pattern above. */
function OrgMainAgentPanel() {
  const { orgRoles } = useAuth();
  const { orgId, organizations } = useOrg();
  const { runWithStepUp } = useStepUp();
  const org = organizations.find((o) => o.id === orgId);
  const myRole = orgRoles[orgId];
  const canEdit = myRole === 'admin' || myRole === 'owner';

  const [catalog, setCatalog] = useState<AgentRuntime[]>([]);
  const [main, setMain] = useState<OrgMainAgent | null>(null);
  const [editing, setEditing] = useState(false);
  const [formRuntime, setFormRuntime] = useState('');
  const [formScope, setFormScope] = useState<'full' | 'narrow'>('full');
  const [useOwnCredentials, setUseOwnCredentials] = useState(false);
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.orgMainAgent(orgId).then((d) => { setCatalog(d.catalog); setMain(d.registered); });
  useEffect(() => {
    setEditing(false);
    setError(null);
    if (org) void load(); else { setCatalog([]); setMain(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, org?.id]);

  const byKey = new Map(catalog.map((r) => [r.key, r]));
  // Same eligibility rule as before this moved to the org level: a real ModelProvider
  // adapter (apiFamily !== 'unsupported') AND flagged mainEligible — e.g. Claude Code has
  // a real adapter but is a dev tool, sub-agent-only.
  const mainOptions = catalog.filter((r) => r.mainEligible && r.apiFamily !== 'unsupported' && !r.blocked);
  const showForm = canEdit && (!main || editing);
  const effectiveRuntime = formRuntime || main?.runtimeKey || mainOptions[0]?.key || '';
  const formEntry = byKey.get(effectiveRuntime) ?? null;
  const supportsBaseUrl = formEntry?.apiFamily === 'openai-compatible';

  const openEdit = () => {
    setFormRuntime(main?.runtimeKey ?? mainOptions[0]?.key ?? '');
    setFormScope(main?.scope === 'narrow' ? 'narrow' : 'full');
    setUseOwnCredentials(!!(main?.hasCustomApiKey || main?.baseUrl || main?.model));
    setFormApiKey('');
    setFormBaseUrl(main?.baseUrl ?? '');
    setFormModel(main?.model ?? '');
    setEditing(true);
  };
  const submit = async () => {
    if (!effectiveRuntime) return;
    setBusy(true);
    setError(null);
    try {
      const credentials = useOwnCredentials
        ? {
            apiKey: formApiKey.trim() === '' ? undefined : formApiKey.trim(),
            baseUrl: supportsBaseUrl ? (formBaseUrl.trim() || null) : null,
            model: formModel.trim() || null,
          }
        : { apiKey: null, baseUrl: null, model: null };
      await runWithStepUp(() => api.setOrgMainAgent(orgId, effectiveRuntime, formScope, credentials));
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not set main agent');
    } finally {
      setBusy(false);
    }
  };

  if (!org) return null;

  return (
    <div className="panel">
      <header>
        <span className="label">{org.name} &middot; main agent</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
          shared by everyone in this org
        </span>
      </header>
      <div className="inner">
        {showForm ? (
          <>
            <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>
              {main
                ? `Editing this org's main agent. Everyone in ${org.name} will read through the new runtime immediately.`
                : `No main agent set yet. Nothing is connected to the org until one is set — everyone's "Set up my agent" stays empty until then.`}
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
                Agent
                <select
                  aria-label="Main agent runtime"
                  value={effectiveRuntime}
                  onChange={(e) => setFormRuntime(e.target.value)}
                  className="input" style={{ minWidth: 200 }}
                >
                  {mainOptions.map((o) => (
                    <option key={o.key} value={o.key}>{o.name} — {o.vendor}</option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--ink3)' }}>Scope</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="chip" aria-pressed={formScope === 'full'} onClick={() => setFormScope('full')}>
                    Full scope
                  </button>
                  <button type="button" className="chip" aria-pressed={formScope === 'narrow'} onClick={() => setFormScope('narrow')}>
                    Narrow scope
                  </button>
                </div>
              </div>
            </div>
            {formEntry && (
              <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '10px 0 0' }}>
                <strong>Reads:</strong> {formEntry.reads}. <strong>Hosted:</strong> {formEntry.host}.
              </p>
            )}
            {formEntry && !formEntry.approved && (
              <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '6px 0 0' }}>
                {formEntry.name} requires IT &amp; Security approval — it will register as
                pending regardless of the scope chosen above.
              </p>
            )}
            <CredentialsFields
              useOwnCredentials={useOwnCredentials}
              setUseOwnCredentials={setUseOwnCredentials}
              hasCustomApiKey={!!main?.hasCustomApiKey}
              hasBaseUrlOrModel={!!(main?.baseUrl || main?.model)}
              supportsBaseUrl={supportsBaseUrl}
              formApiKey={formApiKey}
              setFormApiKey={setFormApiKey}
              formBaseUrl={formBaseUrl}
              setFormBaseUrl={setFormBaseUrl}
              formModel={formModel}
              setFormModel={setFormModel}
              ownerLabel="this org"
            />
            <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
              <button
                disabled={busy || !effectiveRuntime}
                onClick={submit}
                className="btn btn-primary btn-sm"
              >
                {main ? 'Save changes' : 'Set main agent'}
              </button>
              {main && (
                <button className="chip" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              )}
            </div>
          </>
        ) : main ? (
          <div className="runtime-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{byKey.get(main.runtimeKey)?.name ?? main.runtimeKey}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{byKey.get(main.runtimeKey)?.vendor}</span>
              <span className={`pill pill-${main.scope}`}><i />{SCOPE_LABEL[main.scope]}</span>
              <span className="spacer" />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>added {main.addedAt}</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
              <strong>Reads:</strong> {byKey.get(main.runtimeKey)?.reads}. <strong>Hosted:</strong> {byKey.get(main.runtimeKey)?.host}.
            </p>
            {main.scope === 'pending' && (
              <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '8px 0 0' }}>
                Registration filed. Nothing connects until IT &amp; Security approves this runtime.
              </p>
            )}
            <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '8px 0 0' }}>
              {main.hasCustomApiKey || main.baseUrl || main.model
                ? <>Using this org's own credentials{main.baseUrl ? <> — <strong>{main.baseUrl}</strong></> : ''}{main.model ? <> (model: <strong>{main.model}</strong>)</> : ''}.</>
                : "Using the platform's shared key."}
            </p>
            {canEdit && (
              <div style={{ marginTop: 9 }}>
                <button className="chip" disabled={busy} onClick={openEdit}>Edit</button>
              </div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--ink3)' }}>
            No main agent set yet — an owner or admin for {org.name} needs to set one.
          </p>
        )}
        {error && <p style={{ fontSize: 11, color: 'var(--hold)', marginTop: 8 }}>{error}</p>}
      </div>
    </div>
  );
}

export function OrgSetup() {
  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Organizations</h1>
      <p className="sub">
        Set up an organization from scratch, then build its chart person by person. One admin
        can run several organizations side by side — switching here (or from the topbar)
        changes what every other Admin screen shows.
      </p>

      <div className="grid2" style={{ marginTop: 18, alignItems: 'start' }}>
        <OrganizationList />
        <ChartBuilder />
      </div>
      <OrgAdmins />
      <div style={{ marginTop: 18 }}>
        <OrgMainAgentPanel />
      </div>
    </>
  );
}
