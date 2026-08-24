import { useEffect, useRef, useState } from 'react';
import { api, type Person, type Surface } from '../lib/api';
import { relativeTime, turnFromAuditEntry, type RawEntry, type ThreadTurn, type ConversationSummary } from '../lib/conversations';
import { ClaimItem, CoverageBar, CoverageKey, RefusalGlossary } from '../components/primitives';
import { useMe } from '../lib/MeContext';

type Side = 'connected' | 'ask';

let localTurnId = 0;

export function MyAgent() {
  const { meId, meOrgId } = useMe();
  const [me, setMe] = useState<Person | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [neverIngested, setNever] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [window_, setWindow] = useState<'today' | 'week'>('today');
  const [entries, setEntries] = useState<RawEntry[]>([]);
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
    ? entries
        .filter((e) => e.conversationId === activeConversationId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(turnFromAuditEntry)
    : [];
  const displayedThread = pending ? [...thread, pending] : thread;

  const loadHistory = async (personId: number) => {
    const [auditRes, convRes] = await Promise.all([api.auditForSubject(personId), api.listConversations(personId, personId)]);
    const mine = auditRes.entries.filter((e) => e.requesterId === personId && e.requesterRole === 'Self');
    setEntries(mine);
    setConversations(convRes.conversations);
    return convRes.conversations;
  };

  useEffect(() => {
    api.org(meOrgId).then((d) => {
      setMe(d.people.find((p) => p.id === meId) ?? null);
      setSurfaces(d.surfaces);
      setNever(d.neverIngested);
    });
    // New identity — reload from that person's own real chats rather than carrying over
    // whoever we were a moment ago.
    setDraft('');
    setPending(null);
    setHistoryLoaded(false);
    loadHistory(meId).then((convos) => {
      // Land on the most recent chat, same as opening a chat app — "New chat" is one click
      // away either way.
      setActiveConversationId(convos[0]?.id ?? null);
      setHistoryLoaded(true);
    });
  }, [meId, meOrgId]);

  useEffect(() => {
    if (!historyLoaded) return; // don't animate-scroll on the initial history load
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [displayedThread.length, activeConversationId, historyLoaded]);

  const newChat = () => {
    setActiveConversationId(null);
    setPending(null);
    setDraft('');
  };

  const askSelf = async (q: string) => {
    if (!q.trim() || busy) return;
    const localId = `local-${++localTurnId}`;
    setPending({ id: localId, question: q.trim(), result: null, error: null, busy: true });
    setDraft('');
    try {
      // Same real endpoint, same real audit trail as the Ask page — target and role are
      // just locked to you rather than left as an open choice. Each turn is its own real,
      // persisted ask (its own "Self asked: ..." line in your audit log). Passing the
      // active conversationId is what gives the model this chat's own prior turns as
      // real context; omitting it (a brand-new chat) mints a fresh one server-side.
      const r = await api.agentAsk(meId, 'Self', q.trim(), meId, window_, true, activeConversationId ?? undefined);
      await loadHistory(meId);
      if (r.conversationId) setActiveConversationId(r.conversationId);
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

  if (!me) return <p className="sub">Loading&hellip;</p>;

  return (
    <>
      <div className="crumb">My agent &middot; {me.name}</div>
      <h1>What your agent is connected to</h1>
      <p className="sub">
        Nothing on this page is hidden from you. See <strong>Preview</strong> for exactly what
        each requester would get if they asked right now.
      </p>

      <div className="split-row" style={{ marginTop: 18 }}>
        <div
          className={`split-col ${sideClass('connected')}`}
          onMouseEnter={() => setHoverSide('connected')}
          onMouseLeave={() => setHoverSide((s) => (s === 'connected' ? null : s))}
        >
          <div className="grid2">
            <div className="panel" style={{ marginTop: 0 }}>
              <header>
                <span className="label">Connected surfaces</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                  {me.coverage.connectedCount} of {me.coverage.inScopeCount} in scope &middot; {me.coverage.percent}%
                </span>
              </header>
              <div className="inner">
                <CoverageBar states={surfaces.map((s) => me.surfaces[s.key])} height={8} />
                <CoverageKey />
                <table style={{ marginTop: 12 }}>
                  <tbody>
                    {surfaces.map((s) => (
                      <tr key={s.key}>
                        <td style={{ fontSize: 12 }}>{s.name} <span style={{ color: 'var(--ink4)', fontFamily: 'var(--mono)', fontSize: 10 }}>{s.feedsTier}</span></td>
                        <td style={{ fontSize: 11, color: 'var(--ink3)' }}>{s.doesNotRead}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                          {me.surfaces[s.key]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="coverage-note">
                  {me.coverage.gaps.length
                    ? `Because ${me.coverage.gaps.join(', and ')}, answers about those areas are incomplete — and every answer says so.`
                    : 'All surfaces in scope for your role are live and inside the freshness window.'}
                </div>
              </div>
            </div>

            <div className="panel" style={{ marginTop: 0 }}>
              <header><span className="label">Never connected, by construction</span></header>
              <div className="inner">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {neverIngested.map((n) => (
                    <span key={n} className="locked">&#8856; {n}</span>
                  ))}
                </div>
                <p className="glossary">
                  These are absent from ingestion org-wide. There is no setting on this page, or
                  anywhere else, that turns them on.
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
          <div className="panel" style={{ marginTop: 0, display: 'flex', flexDirection: 'column' }}>
            <header>
              <span className="label">Ask yourself</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>same real Ask, just about you</span>
              <span className="spacer" />
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>Since</span>
                <button className="chip" aria-pressed={window_ === 'today'} onClick={() => setWindow('today')}>Today</button>
                <button className="chip" aria-pressed={window_ === 'week'} onClick={() => setWindow('week')}>This week</button>
              </span>
            </header>
            <div className="inner chat-panel-body" style={{ padding: 0 }}>
              <div className="chat-rail">
                <button className="chat-new-btn" onClick={newChat}>+ New chat</button>
                <div className="chat-list">
                  {conversations.length === 0 && <p className="chat-list-empty">No chats yet</p>}
                  {conversations.map((c) => (
                    <button
                      key={c.id}
                      className={`chat-list-item${c.id === activeConversationId ? ' active' : ''}`}
                      onClick={() => setActiveConversationId(c.id)}
                      title={c.title}
                    >
                      <span className="chat-list-title">{c.title}</span>
                      <span className="chat-list-meta">{relativeTime(c.updatedAt)} &middot; {c.turnCount}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="chat-main">
                {displayedThread.length === 0 ? (
                  <p className="glossary" style={{ margin: '0 0 12px' }}>
                    Runs the exact same <strong>Ask</strong> your manager or a peer would use —
                    role fixed to <strong>Self</strong> (always fully allowed). Each question
                    decides on its own which of your connected tools (Claude Code, GitHub,
                    Gmail) are actually relevant and only reads those — shown as
                    &ldquo;Consulted&rdquo; under the answer. Follow-ups in this chat are
                    answered with this chat's own earlier turns as real context. Every turn is
                    its own real, audited ask, written into your own &ldquo;Who asked about
                    me&rdquo; log. For asking about someone else, use
                    <strong> Ask</strong> in the sidebar.
                  </p>
                ) : (
                  <div className="ask-thread">
                    {displayedThread.map((turn) => (
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
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>
                                ANSWER &middot; {turn.result.withheldCount > 0 ? `${turn.result.withheldCount} item(s) withheld, not included below` : 'nothing withheld for Self'}
                              </span>
                              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 13 }}>{turn.result.answer}</p>
                            </div>
                            {turn.result.consultedSources.length > 0 && (
                              <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)', margin: '6px 0 0' }}>
                                CONSULTED &middot; {turn.result.consultedSources.join(', ')}
                              </p>
                            )}
                            <button
                              onClick={() => toggleDetail(turn.id)}
                              style={{ background: 'none', border: 'none', padding: 0, marginTop: 6, fontSize: 11, color: 'var(--ink3)', textDecoration: 'underline', cursor: 'pointer' }}
                            >
                              {expandedIds.has(turn.id) ? 'Hide' : 'Show'} how this was derived — the full, unmodified disclosure
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
                      </div>
                    ))}
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
        </div>
      </div>
    </>
  );
}
