import { useEffect, useRef, useState } from 'react';
import { api, type Person, type PersonConversation } from '../lib/api';
import { relativeTime, turnFromAuditEntry, type RawEntry, type ThreadTurn, type ConversationSummary } from '../lib/conversations';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { LoadingState } from '../components/EmptyState';
import { IconSend } from '../components/icons';
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
  const [, setConversations] = useState<ConversationSummary[]>([]);
  // Every chat with anyone, labelled by person — a manager asking several reports needs to
  // see who each chat is with, and switch between them (2026-09-15).
  const [allConversations, setAllConversations] = useState<PersonConversation[]>([]);
  const openAfterLoad = useRef<string | null>(null);
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

  const loadAllConversations = () =>
    api.myConversations(meOrgId).then((d) => setAllConversations(d.conversations)).catch(() => setAllConversations([]));
  useEffect(() => { void loadAllConversations(); }, [meOrgId, meId]);

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
      // Opening someone else's chat from the list switches `target` first; land on that
      // exact chat once their history loads, not on their most recent one.
      const wanted = openAfterLoad.current;
      openAfterLoad.current = null;
      setActiveConversationId(wanted && convos.some((c) => c.id === wanted) ? wanted : (convos[0]?.id ?? null));
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

  // Asks are part of the permanent record (the person asked about sees them in "Who asked
  // about me"), so a chat can't be deleted — only removed from your own list.
  const removeConversation = async (c: PersonConversation) => {
    const ok = window.confirm(
      `Remove this chat with ${c.targetName} from your list?\n\n` +
      `This only tidies your list. The questions stay in the permanent record: ${c.targetName} can still see that you asked in “Who asked about me”, and your organization’s admins can see them in the audit log.`,
    );
    if (!ok) return;
    try {
      await api.hideConversation(meOrgId, c.id);
      if (c.id === activeConversationId) newChat();
      await Promise.all([loadAllConversations(), target ? loadHistory(meId, target) : Promise.resolve([])]);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'could not remove that chat');
    }
  };

  const openConversation = (c: PersonConversation) => {
    if (c.targetId === target) { setActiveConversationId(c.id); return; }
    openAfterLoad.current = c.id;
    setTarget(c.targetId);
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
      void loadAllConversations();
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
        Ask about someone&rsquo;s work. Their agent checks the tools they&rsquo;ve connected and
        answers with only what your relationship to them allows. They can see that you asked,
        and what you were told.
      </p>

      <div className="panel">
        <header><span className="label">Ask a question</span></header>
        <div className="inner">
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <div className="field-label" style={{ marginBottom: 5 }}>Asking as</div>
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
              <label className="field" style={{ flex: 1, minWidth: 180, maxWidth: 420 }}>
                <span>About</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                  className="input"
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
              {allConversations.length === 0 && <p className="chat-list-empty">No chats yet</p>}
              {allConversations.map((c) => (
                <div key={c.id} className={`chat-list-item${c.id === activeConversationId ? ' active' : ''}`}>
                  <button
                    className="chat-list-item-select"
                    onClick={() => openConversation(c)}
                    title={`${c.title} — with ${c.targetName}`}
                    aria-label={`Chat with ${c.targetName}: ${c.title}`}
                  >
                    <span className="chat-list-person">{c.targetName}</span>
                    <span className="chat-list-title">{c.title}</span>
                    <span className="chat-list-meta">{relativeTime(c.updatedAt)} &middot; {c.turnCount}</span>
                  </button>
                  <button
                    className="chat-list-delete"
                    aria-label={`Remove chat with ${c.targetName} from your list`}
                    title="Remove from my list"
                    onClick={() => void removeConversation(c)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="chat-main">
            {targetPerson && (
              <div className="chat-with">
                <span className="chat-with-avatar" aria-hidden="true">{targetPerson.name.charAt(0).toUpperCase()}</span>
                <span className="chat-with-text">
                  <strong>{activeConversationId ? 'Chat with' : 'New chat with'} {targetPerson.name}</strong>
                  <span className="chat-with-meta">{targetPerson.title} &middot; asking as {role.toLowerCase()}</span>
                </span>
              </div>
            )}
            {displayedThread.length === 0 ? (
              <p className="chat-intro">
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
                      <div className="answer-card is-busy"><LoadingState label={`Asking ${targetPerson?.name ?? 'their'} agent`} /></div>
                    )}

                    {turn.error && <div className="answer-card is-error">{turn.error}</div>}

                    {turn.result && (
                      <>
                        <div className="answer-card">
                          {turn.result.withheldCount > 0 && (
                            <div className="answer-kicker">
                              <span className="withheld">
                                {turn.result.withheldCount === 1 ? '1 item' : `${turn.result.withheldCount} items`} withheld by your organization’s sharing rules
                              </span>
                            </div>
                          )}
                          <p>{turn.result.answer}</p>
                        </div>
                        {turn.result.consultedSources.length > 0 && (
                          <div className="answer-tools">
                            <span className="answer-tools-label">Checked</span>
                            {turn.result.consultedSources.map((src) => <span key={src} className="answer-tool">{src}</span>)}
                          </div>
                        )}
                        <button className="answer-detail-toggle" onClick={() => toggleDetail(turn.id)}>
                          {expandedIds.has(turn.id) ? 'Hide' : 'Show'} where this answer came from
                        </button>
                        {expandedIds.has(turn.id) && (
                          <div className="answer-detail">
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

            <div className="composer">
              <input
                aria-label="Question"
                placeholder="What's the status of the payments migration?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') ask(question); }}
              />
              <button
                type="button"
                className="composer-send"
                aria-label={busy ? 'Asking' : 'Ask'}
                onClick={() => ask(question)}
                disabled={busy || !question.trim()}
              >
                <IconSend />
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
            The answer is written only from what you&rsquo;re allowed to see &mdash; never from
            anything withheld. &ldquo;Show where this answer came from&rdquo; lists every item, including
            what was withheld and why.
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
            recorded answer, shown to them by name, exactly like asking about them one at a time.
          </p>

          <div style={{ marginBottom: 10 }}>
            <div className="field-label" style={{ marginBottom: 5 }}>Asking as</div>
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
            <div className="field-label" style={{ marginBottom: 5 }}>About ({multiSelected.size} selected)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 140, overflowY: 'auto', border: '1px solid var(--rule2)', borderRadius: 'var(--radius-sm)', padding: 8, background: '#fff' }}>
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

          <div className="form-row">
            <input
              aria-label="Question"
              placeholder="What's the status of the payments migration?"
              value={multiQuestion}
              onChange={(e) => setMultiQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askMulti(multiQuestion); }}
              className="input"
            />
            <button
              onClick={() => askMulti(multiQuestion)}
              disabled={multiBusy || !multiQuestion.trim() || multiSelected.size === 0}
              className="btn btn-primary"
            >
              {multiBusy ? 'Asking…' : `Ask ${multiSelected.size > 0 ? multiSelected.size : ''} selected`.replace('  ', ' ')}
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
                                {p.withheldCount > 0 ? `${p.withheldCount === 1 ? '1 item' : `${p.withheldCount} items`} withheld` : 'nothing withheld'}
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
