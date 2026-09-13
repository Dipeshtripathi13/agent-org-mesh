import { useEffect, useRef, useState } from 'react';
import { api, type Person, type Surface } from '../lib/api';
import {
  relativeTime, turnFromAuditEntry, turnFromPersonalEntry,
  type RawEntry, type RawPersonalEntry, type ThreadTurn, type ConversationSummary,
} from '../lib/conversations';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { GettingStarted } from '../components/GettingStarted';
import { navigate } from '../lib/navigate';
import { useAuth } from '../lib/AuthContext';
import { useMe } from '../lib/MeContext';

type Side = 'connected' | 'ask';

let localTurnId = 0;

/** "My agent" for someone connected to no organization at all — no claims, no coverage,
 *  no policy engine, none of that has anything to do with a private chat nobody else
 *  could ever ask about. `personal` is derived the same way App.tsx's Shell derives
 *  `hasOwnIdentity` — a real account with zero linked org-chart identities — rather than
 *  threaded down as a prop, since both MyAgent and SetUpMyAgent need it independently and
 *  the nav array that renders them isn't set up to pass props through. */
export function MyAgent() {
  const { account, orgRoles, people: identities } = useAuth();
  const personal = identities.length === 0;
  // An org member can still ask their own, separate personal agent — `usePersonalAgent`
  // is the toggle for that; a true no-org account has no toggle at all, it's always on.
  const [usePersonalAgent, setUsePersonalAgent] = useState(false);
  const showPersonalChat = personal || usePersonalAgent;
  const { meId, meOrgId } = useMe();
  const [me, setMe] = useState<Person | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [neverIngested, setNever] = useState<string[]>([]);
  const [orgHasAgent, setOrgHasAgent] = useState(false);
  const [peopleInOrg, setPeopleInOrg] = useState(1);
  const [draft, setDraft] = useState('');
  const [entries, setEntries] = useState<RawEntry[]>([]);
  const [personalEntries, setPersonalEntries] = useState<RawPersonalEntry[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState<ThreadTurn | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hoverSide, setHoverSide] = useState<Side | null>(null);
  const [askFocused, setAskFocused] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  // Typing/focused in the Ask side wins even if the pointer has drifted elsewhere.
  const activeSide: Side | null = askFocused ? 'ask' : hoverSide;
  const sideClass = (side: Side) =>
    activeSide == null ? '' : activeSide === side ? 'split-wide' : 'split-narrow';
  const busy = pending != null && pending.busy;

  const thread: ThreadTurn[] = activeConversationId
    ? showPersonalChat
      ? personalEntries
          .filter((e) => e.conversationId === activeConversationId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(turnFromPersonalEntry)
      : entries
          .filter((e) => e.conversationId === activeConversationId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(turnFromAuditEntry)
    : [];
  const displayedThread = pending ? [...thread, pending] : thread;

  const loadHistory = async () => {
    if (showPersonalChat) {
      const [asksRes, convRes] = await Promise.all([api.personalAsks(), api.personalConversations()]);
      setPersonalEntries(asksRes.entries);
      setConversations(convRes.conversations);
      return convRes.conversations;
    }
    const [auditRes, convRes] = await Promise.all([api.auditForSubject(meId), api.listConversations(meId)]);
    const mine = auditRes.entries.filter((e) => e.requesterId === meId && e.requesterRole === 'Self');
    setEntries(mine);
    setConversations(convRes.conversations);
    return convRes.conversations;
  };

  useEffect(() => {
    // `cancelled` guards against a slower, stale request (e.g. the placeholder demo org
    // MeContext starts on before a real identity loads) resolving *after* the real
    // meId/meOrgId's own request already has — without it, a fresh signup could flip to
    // its own real org almost immediately, fire both requests close together, and still
    // end up displaying the first (wrong) one if it happened to come back last. Same race,
    // same fix, as Overview.tsx's own `cancelled` guard. Not needed for the personal path
    // at all — there's no org roster fetch to race against.
    let cancelled = false;
    if (!personal) {
      api.org(meOrgId).then((d) => {
        if (cancelled) return;
        setMe(d.people.find((p) => p.id === meId) ?? null);
        setSurfaces(d.surfaces);
        setNever(d.neverIngested);
        setPeopleInOrg(d.people.length);
      });
      api.orgMainAgent(meOrgId).then((d) => { if (!cancelled) setOrgHasAgent(d.registered != null); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [personal, meId, meOrgId]);

  useEffect(() => {
    // Separate from the org-roster fetch above: switching `showPersonalChat` (the org-vs-
    // personal-agent toggle) must reload chat history without re-fetching surfaces/never-
    // ingested every time — and must reset `activeConversationId`, since an org thread id
    // means nothing inside `personalEntries` and vice versa; carrying it over would land on
    // a silently blank chat instead of a real one.
    let cancelled = false;
    setDraft('');
    setPending(null);
    setHistoryLoaded(false);
    loadHistory().then((convos) => {
      if (cancelled) return;
      // Land on the most recent chat, same as opening a chat app — "New chat" is one click
      // away either way.
      setActiveConversationId(convos[0]?.id ?? null);
      setHistoryLoaded(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPersonalChat, meId, meOrgId]);

  useEffect(() => {
    if (!historyLoaded) return; // don't animate-scroll on the initial history load
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [displayedThread.length, activeConversationId, historyLoaded]);

  const newChat = () => {
    setActiveConversationId(null);
    setPending(null);
    setDraft('');
  };

  // Real, permanent delete — only offered for personal chat. Org self-ask/cross-person Ask
  // threads are audit_log rows and can never be deleted (rule 2, non-negotiable) — no
  // delete affordance exists for those here at all, not just a disabled one.
  const deleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat? This can\'t be undone.')) return;
    await api.deletePersonalConversation(id);
    const convos = await loadHistory();
    if (activeConversationId === id) {
      setActiveConversationId(convos[0]?.id ?? null);
    }
  };

  const askSelf = async (q: string) => {
    if (!q.trim() || busy) return;
    const localId = `local-${++localTurnId}`;
    setPending({ id: localId, question: q.trim(), result: null, error: null, busy: true });
    setDraft('');
    try {
      if (showPersonalChat) {
        // No org, no target/role/requesterId — the requester is always the target.
        const r = await api.askPersonal(q.trim(), activeConversationId ?? undefined);
        await loadHistory();
        setActiveConversationId(r.conversationId);
      } else {
        // Same real endpoint, same real audit trail as the Ask page — target and role are
        // just locked to you rather than left as an open choice. Each turn is its own real,
        // persisted ask (its own "Self asked: ..." line in your audit log). Passing the
        // active conversationId is what gives the model this chat's own prior turns as
        // real context; omitting it (a brand-new chat) mints a fresh one server-side.
        const r = await api.agentAsk(meId, 'Self', q.trim(), true, activeConversationId ?? undefined);
        await loadHistory();
        if (r.conversationId) setActiveConversationId(r.conversationId);
      }
      setPending(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'could not get an answer';
      setPending((p) => (p ? { ...p, error: message, busy: false } : p));
    }
  };
  const toggleDetail = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const chatPanel = (
    <div className="panel" style={{ marginTop: 0, display: 'flex', flexDirection: 'column' }}>
      <header>
        <span className="label">Ask about your own work</span>
        <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
          {showPersonalChat ? 'your private agent' : 'your organization’s agent'}
        </span>
      </header>
      <div className="inner chat-panel-body" style={{ padding: 0 }}>
        <div className="chat-rail">
          <button className="chat-new-btn" onClick={newChat}>+ New chat</button>
          <div className="chat-list">
            {conversations.length === 0 && <p className="chat-list-empty">No chats yet</p>}
            {conversations.map((c) => (
              <div key={c.id} className={`chat-list-item${c.id === activeConversationId ? ' active' : ''}`}>
                <button
                  className="chat-list-item-select"
                  onClick={() => setActiveConversationId(c.id)}
                  title={c.title}
                >
                  <span className="chat-list-title">{c.title}</span>
                  <span className="chat-list-meta">{relativeTime(c.updatedAt)} &middot; {c.turnCount}</span>
                </button>
                {showPersonalChat && (
                  <button
                    className="chat-list-delete"
                    aria-label="Delete chat"
                    title="Delete this chat"
                    onClick={(e) => void deleteConversation(e, c.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="chat-main">
          {displayedThread.length === 0 ? (
            <p className="glossary" style={{ margin: '0 0 12px' }}>
              {showPersonalChat ? (
                <>
                  Answered by your private agent, which only you can use &mdash; choose which AI
                  it uses in <strong>Set up my agent</strong>. Nothing here is shared with anyone.
                </>
              ) : (
                <>
                  Ask anything about your own work. For each question your agent picks which of
                  your connected tools are relevant, reads only those, and lists them under the
                  answer. Follow-up questions in the same chat keep the earlier context. To ask
                  about someone else, use <strong>Ask</strong> in the sidebar.
                </>
              )}
            </p>
          ) : (
            <div className="ask-thread">
              {displayedThread.map((turn) => {
                const hasDerivation = turn.result != null && (turn.result.items.length > 0 || !!turn.result.coverage.text);
                return (
                  <div key={turn.id} className="ask-turn">
                    <p className="ask-turn-q">{turn.question}</p>

                    {turn.busy && (
                      <div className="runtime-card" style={{ background: '#f8f9fa' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>Asking&hellip;</span>
                      </div>
                    )}

                    {turn.error && (
                      <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px' }}>
                        {turn.error}
                      </p>
                    )}

                    {turn.result && (
                      <>
                        <div className="runtime-card" style={{ background: '#f8f9fa' }}>
                          {!showPersonalChat && (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>
                              ANSWER{turn.result.withheldCount > 0 ? ` · ${turn.result.withheldCount === 1 ? '1 item' : `${turn.result.withheldCount} items`} withheld` : ''}
                            </span>
                          )}
                          <p style={{ margin: showPersonalChat ? 0 : '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 13 }}>{turn.result.answer}</p>
                        </div>
                        {turn.result.consultedSources.length > 0 && (
                          <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)', margin: '6px 0 0' }}>
                            CHECKED &middot; {turn.result.consultedSources.join(', ')}
                          </p>
                        )}
                        {hasDerivation && (
                          <>
                            <button
                              onClick={() => toggleDetail(turn.id)}
                              style={{ background: 'none', border: 'none', padding: 0, marginTop: 6, fontSize: 11, color: 'var(--ink3)', textDecoration: 'underline', cursor: 'pointer' }}
                            >
                              {expandedIds.has(turn.id) ? 'Hide' : 'Show'} where this answer came from
                            </button>
                            {expandedIds.has(turn.id) && (
                              <div style={{ marginTop: 8 }}>
                                {turn.result.items.map((item, i) => <ClaimItem key={i} item={item} />)}
                                <div className="coverage-note">{turn.result.coverage.text}</div>
                                <RefusalGlossary />
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              <div ref={threadEndRef} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: displayedThread.length ? 12 : 0 }}>
            <input
              aria-label="Ask yourself a question"
              placeholder={activeConversationId ? 'Ask a follow-up…' : 'What have I been working on?'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askSelf(draft); }}
              onFocus={() => setAskFocused(true)}
              onBlur={() => setAskFocused(false)}
              style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
            />
            <button
              onClick={() => askSelf(draft)}
              disabled={busy || !draft.trim()}
              style={{ height: 32, padding: '0 14px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
            >
              {busy ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (personal) {
    return (
      <>
        <div className="crumb">My agent &middot; Personal</div>
        <h1>Ask yourself</h1>
        <p className="sub">
          This is your private agent &mdash; no one else can use it or see your chats. Choose
          which AI answers, and connect your tools, in <strong>Set up my agent</strong>. To bring
          in a team, open the menu under your name and choose <strong>Admin</strong>.
        </p>
        <div style={{ marginTop: 18 }}>{chatPanel}</div>
      </>
    );
  }

  if (!me) return <p className="sub">Loading&hellip;</p>;

  const connected = surfaces.filter((s) => me.surfaces[s.key] === 'connected' || me.surfaces[s.key] === 'partial' || me.surfaces[s.key] === 'stale');
  const unconnectedCount = me.coverage.inScopeCount - me.coverage.connectedCount;

  return (
    <>
      <div className="crumb">My agent &middot; {me.name}</div>
      <h1>Your agent</h1>
      <p className="sub">
        Ask it about your own work below. When someone else asks about you, it answers them with
        only what their relationship to you allows &mdash; and you can see every question in{' '}
        <strong>Who asked about me</strong>.
      </p>

      {account && (
        <GettingStarted
          accountId={account.id}
          input={{
            hasAnsweringAgent: orgHasAgent,
            isOrgAdmin: orgRoles[meOrgId] === 'owner' || orgRoles[meOrgId] === 'admin',
            connectedTools: me.coverage.connectedCount,
            askedQuestions: conversations.length,
            peopleInOrg,
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
        <button className="chip" aria-pressed={!usePersonalAgent} onClick={() => setUsePersonalAgent(false)}>Your organization&rsquo;s agent</button>
        <button className="chip" aria-pressed={usePersonalAgent} onClick={() => setUsePersonalAgent(true)}>Your private agent</button>
      </div>

      <div className="split-row" style={{ marginTop: 18 }}>
        <div
          className={`split-col ${sideClass('connected')}`}
          onMouseEnter={() => setHoverSide('connected')}
          onMouseLeave={() => setHoverSide((s) => (s === 'connected' ? null : s))}
        >
          <div className="grid2">
            <div className="panel" style={{ marginTop: 0 }}>
              <header>
                <span className="label">Tools it reads</span>
                <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
                  {me.coverage.connectedCount} of {me.coverage.inScopeCount} connected
                </span>
              </header>
              <div className="inner">
                {connected.length === 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--ink2)', margin: 0 }}>
                    None yet. Connect the tools you work in from{' '}
                    <button type="button" className="linklike" onClick={() => navigate('/me/setup')}>Set up my agent</button>
                    {' '}&mdash; your agent only ever reads them.
                  </p>
                ) : (
                  <ul className="tool-list">
                    {connected.map((s) => (
                      <li key={s.key}>
                        <strong>{s.name}</strong>
                        {me.surfaces[s.key] !== 'connected' && <span className="tool-note"> &middot; {me.surfaces[s.key] === 'stale' ? 'out of date' : 'limited'}</span>}
                        <span className="tool-reads">{s.reads}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {unconnectedCount > 0 && (
                  <div className="coverage-note">
                    {connected.length === 0
                      ? 'Until a tool is connected, answers about your work will say there was nothing to check.'
                      : `Answers say plainly which of the other ${unconnectedCount === 1 ? 'tool' : `${unconnectedCount} tools`} they couldn’t check — nothing is guessed to fill the gap.`}
                  </div>
                )}
              </div>
            </div>

            <div className="panel" style={{ marginTop: 0 }}>
              <header><span className="label">Never read, for anyone</span></header>
              <div className="inner">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {neverIngested.map((n) => (
                    <span key={n} className="locked">&#8856; {n}</span>
                  ))}
                </div>
                <p className="glossary">
                  No agent in this product collects these, in any organization, and there is no
                  setting anywhere that changes that.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div
          className={`split-col ${sideClass('ask')}`}
          onMouseEnter={() => setHoverSide('ask')}
          onMouseLeave={() => setHoverSide((s) => (s === 'ask' ? null : s))}
        >
          {chatPanel}
        </div>
      </div>
    </>
  );
}
