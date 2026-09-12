import { useEffect, useRef, useState } from 'react';
import { api, type Person } from '../lib/api';
import { relativeTime, turnFromAuditEntry, type RawEntry, type ThreadTurn, type ConversationSummary } from '../lib/conversations';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { useMe } from '../lib/MeContext';
import { deriveAllowedRoles } from '../lib/roles';

const ROLES = ['Direct manager', 'Skip-level', 'Peer', 'Executive', 'IT admin'];

let localTurnId = 0;

type MultiAskResult = Awaited<ReturnType<typeof api.askMulti>>;

export function Ask() {
  const { meId, meOrgId } = useMe();
  const [people, setPeople] = useState<Person[]>([]);
  const [role, setRole] = useState('Direct manager');
  // 0 is never a real person id — just a placeholder until the org roster loads and the
  // effect below picks a real, real-someone-else default.
  const [target, setTarget] = useState(0);
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<RawEntry[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState<ThreadTurn | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const busy = pending != null && pending.busy;

  // Ask the same question about several freely-chosen people at once — a real, open
  // selection (a CEO picking the Eng manager and the Fin manager, say), not derived from
  // the org chart the way an earlier version of this restricted it to direct reports.
  // Its own small, stateless panel — there's no per-selection chat history endpoint, so
  // this doesn't try to be a conversation the way the single-target thread above is.
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [multiRole, setMultiRole] = useState('Executive');
  const [multiQuestion, setMultiQuestion] = useState('');
  const [multiBusy, setMultiBusy] = useState(false);
  const [multiError, setMultiError] = useState<string | null>(null);
  const [multiResult, setMultiResult] = useState<MultiAskResult | null>(null);
  const [multiDetailId, setMultiDetailId] = useState<number | null>(null);

  const toggleMultiSelected = (id: number) =>
    setMultiSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const askMulti = async (q: string) => {
    if (!q.trim() || multiBusy || multiSelected.size === 0) return;
    setMultiBusy(true);
    setMultiError(null);
    try {
      const r = await api.askMulti(q.trim(), multiRole, [...multiSelected], true);
      setMultiResult(r);
      setMultiQuestion('');
    } catch (e) {
      setMultiError(e instanceof Error ? e.message : 'could not get an answer');
    } finally {
      setMultiBusy(false);
    }
  };

  // Ask is for asking about someone *else* — "My agent" → "Ask yourself" already owns
  // asking about yourself, with its own separate chat history. Excluding yourself here
  // isn't just a nicer default: without it, `target` could equal `meId`, and since chats
  // are grouped by the (requester, target) pair, that would show this tab the exact same
  // self-conversations "My agent" already has — confusing, and not what this page is for.
  const others = people.filter((p) => p.id !== meId);

  useEffect(() => {
    api.org(meOrgId).then((d) => {
      setPeople(d.people);
      const choices = d.people.filter((p) => p.id !== meId);
      setTarget((current) => (choices.some((p) => p.id === current) ? current : (choices[0]?.id ?? 0)));
    });
  }, [meOrgId, meId]);

  const targetPerson = people.find((p) => p.id === target);
  const allowedRoles = deriveAllowedRoles(meId, target, people);

  // Keep the selected role truthful as identity or target changes — never leave a
  // stale, no-longer-valid role selected (it would just be rejected on Ask anyway).
  useEffect(() => {
    if (allowedRoles.length && !allowedRoles.includes(role)) setRole(allowedRoles[0]);
  }, [meId, target, people]);

  // Every real chat is a UI grouping over that (requester, target) pair's own real
  // audit rows — same mechanism "My agent" → "Ask yourself" uses (self-chat is just the
  // case requesterId === targetId), so switching who you're asking about switches to
  // that person's own separate thread list, same real durable history either way.
  const loadHistory = async (requesterId: number, targetId: number) => {
    const [auditRes, convRes] = await Promise.all([
      api.auditForSubject(targetId),
      api.listConversations(targetId),
    ]);
    const mine = auditRes.entries.filter((e) => e.requesterId === requesterId);
    setEntries(mine);
    setConversations(convRes.conversations);
    return convRes.conversations;
  };

  useEffect(() => {
    setQuestion('');
    setPending(null);
    setHistoryLoaded(false);
    // target stays 0 — not a real person id — whenever there's genuinely no one else in
    // the org to ask about yet (a brand-new chart of one). Nothing to load in that case;
    // skip the request instead of asking the backend about a person that doesn't exist.
    if (!target) { setEntries([]); setConversations([]); setActiveConversationId(null); setHistoryLoaded(true); return; }
    loadHistory(meId, target).then((convos) => {
      setActiveConversationId(convos[0]?.id ?? null);
      setHistoryLoaded(true);
    });
  }, [meId, target]);

  const thread: ThreadTurn[] = activeConversationId
    ? entries
        .filter((e) => e.conversationId === activeConversationId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(turnFromAuditEntry)
    : [];
  const displayedThread = pending ? [...thread, pending] : thread;

  useEffect(() => {
    if (!historyLoaded) return; // don't animate-scroll on the initial history load
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [displayedThread.length, activeConversationId, historyLoaded]);

  const newChat = () => {
    setActiveConversationId(null);
    setPending(null);
    setQuestion('');
  };

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    const localId = `local-${++localTurnId}`;
    setPending({ id: localId, question: q.trim(), result: null, error: null, busy: true });
    setQuestion('');
    try {
      // Same real endpoint "Ask yourself" uses — target and role are just an open choice
      // here rather than locked to you. Each turn is its own real, persisted ask, written
      // into the target's own audit log. Passing the active conversationId is what gives
      // the model this chat's own prior turns as real context; omitting it (a brand-new
      // chat) mints a fresh one server-side.
      const r = await api.agentAsk(target, role, q.trim(), true, activeConversationId ?? undefined);
      await loadHistory(meId, target);
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

  return (
    <>
      <div className="crumb">My agent &middot; ask</div>
      <h1>Ask</h1>
      <p className="sub">
        Ask a real question — the target's main agent gathers its own real, connected
        resources, then answers using only what the policy grid already authorizes for
        your role. Your name is written into the target&rsquo;s own log the moment you ask.
      </p>

      <div className="panel">
        <header><span className="label">Ask a question</span></header>
        <div className="inner">
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 5 }}>
                Asking as
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {ROLES.map((r) => {
                  const truthful = allowedRoles.includes(r);
                  return (
                    <button
                      key={r}
                      className="chip"
                      aria-pressed={role === r}
                      disabled={!truthful}
                      title={truthful ? undefined : `Not truthful — your real relationship to ${targetPerson?.name ?? 'this person'} isn't "${r}"`}
                      onClick={() => setRole(r)}
                      style={truthful ? undefined : { opacity: 0.4, cursor: 'not-allowed' }}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
              <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '5px 0 0' }}>
                {allowedRoles.length
                  ? `Your real relationship, derived from the org chart: ${allowedRoles.join(', ')}. A real ask is rejected if the role you claim isn't in that list.`
                  : `You have no relationship to ${targetPerson?.name ?? 'this person'} in the org chart — a real ask about them will be rejected.`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 180 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
                  About
                </span>
                <select
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                  style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, fontSize: 12, padding: '0 6px' }}
                >
                  {others.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} &middot; {p.title}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="inner chat-panel-body" style={{ padding: 0, borderTop: '1px solid var(--rule)' }}>
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
                Every turn is its own real, audited ask, written into{' '}
                {targetPerson?.name ?? 'the target'}&rsquo;s own &ldquo;Who asked about
                me&rdquo; log. Follow-ups in this chat are answered with this chat&rsquo;s
                own earlier turns as real context — as long as you keep asking under the
                same role; changing the role chip starts that turn fresh (still in this
                same chat) rather than risk a broader-access answer leaking into a
                narrower-access one.
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
                            ANSWER &middot; {turn.result.withheldCount > 0 ? `${turn.result.withheldCount} item(s) withheld, not included below` : 'nothing withheld for this role'}
                          </span>
                          <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 13 }}>{turn.result.answer}</p>
                        </div>
                        {turn.result.consultedSources.length > 0 && (
                          <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)', margin: '6px 0 0' }}>
                            CONSULTED &middot; {targetPerson ? `${targetPerson.name}'s` : 'Their'} own agent called: {turn.result.consultedSources.join(', ')}
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
                aria-label="Question"
                placeholder="What's the status of the payments migration?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') ask(question); }}
                style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
              />
              <button
                onClick={() => ask(question)}
                disabled={busy || !question.trim()}
                style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
              >
                {busy ? 'Asking…' : 'Ask'}
              </button>
            </div>
          </div>
        </div>

        <div className="inner">
          <p className="glossary" style={{ margin: 0 }}>
            Every query you run is written into the target&rsquo;s own &ldquo;Who asked about
            me&rdquo; log, with your name on it, at the moment you run it.
          </p>
          <p className="glossary" style={{ marginTop: 8 }}>
            The answer above is written by a real Claude API call from only the items
            below marked as disclosed — never from anything withheld — if the backend
            has an API key configured; otherwise you get that same authorized data
            as-is, clearly labeled as such.
          </p>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <header><span className="label">Ask several people</span></header>
        <div className="inner">
          <p className="glossary" style={{ margin: '0 0 12px' }}>
            Pick anyone in the chart — not just your own reports — and ask them all the
            same question in one go: a CEO checking the Eng manager and the Fin manager at
            once, say. One claimed relationship applies to the whole selection; it&rsquo;s
            still verified against the org chart separately for each person, and anyone
            it isn&rsquo;t truthful for is shown as a plain, visible rejection rather than
            silently left out. Everyone it does hold for still gets their own real,
            audited disclosure event, exactly like asking about them one at a time.
          </p>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 5 }}>
              Asking as
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {ROLES.map((r) => (
                <button
                  key={r}
                  className="chip"
                  aria-pressed={multiRole === r}
                  onClick={() => setMultiRole(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 5 }}>
              About ({multiSelected.size} selected)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 140, overflowY: 'auto', border: '1px solid var(--rule2)', borderRadius: 2, padding: 8 }}>
              {others.map((p) => (
                <button
                  key={p.id}
                  className="chip"
                  aria-pressed={multiSelected.has(p.id)}
                  onClick={() => toggleMultiSelected(p.id)}
                  title={p.title}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              aria-label="Question"
              placeholder="What's the status of the payments migration?"
              value={multiQuestion}
              onChange={(e) => setMultiQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askMulti(multiQuestion); }}
              style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
            />
            <button
              onClick={() => askMulti(multiQuestion)}
              disabled={multiBusy || !multiQuestion.trim() || multiSelected.size === 0}
              style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
            >
              {multiBusy ? 'Asking…' : 'Ask selected'}
            </button>
          </div>

          {multiError && (
            <p style={{ marginTop: 10, fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px' }}>
              {multiError}
            </p>
          )}

          {multiResult && (
            <div style={{ marginTop: 12 }}>
              <div className="runtime-card" style={{ background: '#f8f9fa' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>
                  COMBINED ANSWER &middot; {multiResult.askedCount} asked
                  {multiResult.rejectedCount > 0 ? `, ${multiResult.rejectedCount} rejected` : ''}
                </span>
                <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 13 }}>{multiResult.answer}</p>
              </div>

              {multiResult.perPerson.length > 0 && (
                <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                  {multiResult.perPerson.map((p) => (
                    <div key={p.personId} style={{ border: '1px solid var(--rule2)', borderRadius: 2, padding: '8px 10px' }}>
                      {p.ok ? (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                            <button
                              onClick={() => setMultiDetailId((cur) => (cur === p.personId ? null : p.personId))}
                              style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: 'var(--ink3)', textDecoration: 'underline', cursor: 'pointer' }}
                            >
                              {multiDetailId === p.personId ? 'Hide' : 'Show'} their own answer
                            </button>
                          </div>
                          {multiDetailId === p.personId && (
                            <>
                              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 12 }}>{p.answer}</p>
                              <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)', margin: '6px 0 0' }}>
                                {p.withheldCount > 0 ? `${p.withheldCount} item(s) withheld` : 'nothing withheld'}
                                {p.consultedSources.length > 0 && ` · consulted: ${p.consultedSources.join(', ')}`}
                              </p>
                            </>
                          )}
                        </>
                      ) : (
                        <div style={{ fontSize: 12, color: 'var(--hold)' }}>
                          <strong>{p.name ?? `Person #${p.personId}`}</strong> — not asked: {p.reason}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
