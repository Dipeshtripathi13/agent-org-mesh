import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PRODUCT_NAME } from '../lib/brand';

/**
 * The left half of sign in / create account / reset password: the product at work, as a
 * looping scene. The whole organization is a dim constellation; one question lights a
 * path through it. Each hop is checked against the org chart, each agent wakes only the
 * tools that matter, the sharing rules visibly withhold one item, one answer assembles
 * on the asker's screen, and the person asked about is told who asked.
 *
 * Three parallax depths follow the mouse (constellation, chart, cards). Pauses when the
 * tab is hidden or the scene is off screen; holds a still final frame under
 * prefers-reduced-motion. Everything is time-driven from one clock, so the story stays in
 * sync no matter how the frame rate behaves.
 */

const LOOP = 14.6;
const STILL_FRAME = 11.9;
const QUESTION = 'What’s the status of the billing migration?';

const STEPS: { at: number; label: string }[] = [
  { at: 0, label: 'Someone asks' },
  { at: 1.8, label: 'Checked against the org chart' },
  { at: 4.2, label: 'Agents read only what matters' },
  { at: 6.4, label: 'Sharing rules decide' },
  { at: 7.9, label: 'One answer, on the record' },
  { at: 11.0, label: 'They see who asked' },
];

// Chart geometry (viewBox 560 × 540).
const ASKER = { x: 205, y: 136, w: 150, name: 'Asha Rao', role: 'VP Engineering' };
const MANAGER = { x: 205, y: 232, w: 150, name: 'Maya Okafor', role: 'Engineering Manager' };
const BEN = { x: 40, y: 330, w: 140, name: 'Ben Carter', role: 'Engineer' };
const CHEN = { x: 380, y: 330, w: 140, name: 'Chen Li', role: 'Engineer' };
const E1 = 'M280 186 L280 232';
const E2 = 'M280 282 C280 322, 110 294, 110 330';
const E3 = 'M280 282 C280 322, 450 294, 450 330';

interface Tool { x: number; y: number; w: number; label: string; litAt: number | null; owner: 'ben' | 'chen' }
const TOOLS: Tool[] = [
  { x: 44, y: 396, w: 64, label: 'GitHub', litAt: 4.4, owner: 'ben' },
  { x: 114, y: 396, w: 52, label: 'Jira', litAt: 4.9, owner: 'ben' },
  { x: 44, y: 428, w: 128, label: 'Notion · not needed', litAt: null, owner: 'ben' },
  { x: 382, y: 396, w: 92, label: 'Claude Code', litAt: 5.3, owner: 'chen' },
  { x: 480, y: 396, w: 72, label: 'Calendar', litAt: 5.8, owner: 'chen' },
  { x: 382, y: 428, w: 118, label: 'Slack · not needed', litAt: null, owner: 'chen' },
];

const GATE_ROWS: { label: string; at: number; withheld?: boolean }[] = [
  { label: 'Billing PR status', at: 6.7 },
  { label: 'Jira tickets closed', at: 6.95 },
  { label: 'Tax module shipped', at: 7.2 },
  { label: 'Review notes', at: 7.45, withheld: true },
];

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const between = (t: number, a: number, b: number) => t >= a && t < b;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The rest of the organization: small clusters of dim people, laid out once with a
 *  seeded generator so the picture is the same on every visit. */
function useConstellation() {
  return useMemo(() => {
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const clusters = [
      { cx: 58, cy: 72, n: 6, r: 44 },
      { cx: 70, cy: 208, n: 6, r: 46 },
      { cx: 332, cy: 482, n: 7, r: 50 },
      { cx: 508, cy: 58, n: 5, r: 40 },
    ];
    const nodes: { x: number; y: number; hub: boolean; delay: number }[] = [];
    const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const c of clusters) {
      nodes.push({ x: c.cx, y: c.cy, hub: true, delay: rnd() * 6 });
      for (let i = 0; i < c.n; i++) {
        const a = rnd() * Math.PI * 2;
        const d = c.r * (0.45 + rnd() * 0.55);
        const x = c.cx + Math.cos(a) * d;
        const y = c.cy + Math.sin(a) * d * 0.8;
        nodes.push({ x, y, hub: false, delay: rnd() * 6 });
        edges.push({ x1: c.cx, y1: c.cy, x2: x, y2: y });
      }
    }
    // Faint threads that tie the clusters to the chart, so it reads as one org.
    edges.push({ x1: 58, y1: 72, x2: 205, y2: 150 });
    edges.push({ x1: 70, y1: 208, x2: 205, y2: 250 });
    edges.push({ x1: 508, y1: 58, x2: 355, y2: 150 });
    edges.push({ x1: 332, y1: 482, x2: 176, y2: 440 });
    edges.push({ x1: 332, y1: 482, x2: 382, y2: 440 });
    return { nodes, edges };
  }, []);
}

function useReducedMotion(): boolean {
  const query = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
  const [reduced, setReduced] = useState(!!query?.matches);
  useEffect(() => {
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return reduced;
}

function Person({ p, active, thinking }: { p: typeof ASKER; active: boolean; thinking: boolean }) {
  return (
    <g>
      {thinking && <rect className="sc-pulse" x={p.x} y={p.y} width={p.w} height={50} rx={14} />}
      <rect className={`sc-card${active ? ' is-active' : ''}`} x={p.x} y={p.y} width={p.w} height={50} rx={14} />
      <circle cx={p.x + 24} cy={p.y + 25} r={11} className={`sc-avatar${active ? ' is-active' : ''}`} />
      <text x={p.x + 24} y={p.y + 29} textAnchor="middle" className="sc-initial">{p.name[0]}</text>
      <text x={p.x + 44} y={p.y + 22} className="sc-name">{p.name}</text>
      <text x={p.x + 44} y={p.y + 37} className="sc-meta">{p.role}</text>
    </g>
  );
}

function Pill({ x, y, label, shown }: { x: number; y: number; label: string; shown: boolean }) {
  const w = label.length * 6.2 + 18;
  return (
    <g className={`sc-pill${shown ? ' is-shown' : ''}`} style={{ transformOrigin: `${x + w / 2}px ${y + 9}px` }}>
      <rect x={x} y={y} width={w} height={18} rx={9} />
      <text x={x + w / 2} y={y + 12.5} textAnchor="middle">{label}</text>
    </g>
  );
}

export function AuthScene() {
  const reduced = useReducedMotion();
  const [t, setT] = useState(reduced ? STILL_FRAME : 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const e1 = useRef<SVGPathElement>(null);
  const e2 = useRef<SVGPathElement>(null);
  const e3 = useRef<SVGPathElement>(null);
  const [ready, setReady] = useState(false);
  const stars = useConstellation();

  useLayoutEffect(() => { setReady(true); }, []);

  // The clock: runs only while the tab is visible and the scene is on screen.
  useEffect(() => {
    if (reduced) { setT(STILL_FRAME); return; }
    let raf = 0;
    let elapsed = 0;
    let last: number | null = null;
    let onScreen = true;
    const frame = (now: number) => {
      if (last != null) elapsed += Math.min(now - last, 100);
      last = now;
      setT((elapsed / 1000) % LOOP);
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf && onScreen && document.visibilityState === 'visible') { last = null; raf = requestAnimationFrame(frame); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    document.addEventListener('visibilitychange', onVisibility);
    const io = typeof IntersectionObserver !== 'undefined' && rootRef.current
      ? new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; if (onScreen) start(); else stop(); })
      : null;
    if (io && rootRef.current) io.observe(rootRef.current);
    start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); io?.disconnect(); };
  }, [reduced]);

  // Mouse parallax, written straight to CSS variables (no re-render per mouse move).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || reduced) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const r = el.getBoundingClientRect();
      const x = Math.max(-0.5, Math.min(0.5, (e.clientX - r.left) / r.width - 0.5));
      const y = Math.max(-0.5, Math.min(0.5, (e.clientY - r.top) / r.height - 0.5));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { el.style.setProperty('--px', x.toFixed(3)); el.style.setProperty('--py', y.toFixed(3)); });
    };
    const onLeave = () => { el.style.setProperty('--px', '0'); el.style.setProperty('--py', '0'); };
    window.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); el.removeEventListener('pointerleave', onLeave); };
  }, [reduced]);

  const resetting = t >= LOOP - 0.8;
  const still = reduced;

  // --- beats ------------------------------------------------------------------------
  const typedChars = still ? QUESTION.length : Math.round(QUESTION.length * clamp01(t / 1.6));
  const caretOn = !still && t < 2.0 && Math.floor(t * 2) % 2 === 0;
  const questionShown = !still && t < 9.5;
  const managerActive = t >= 2.6;
  const engineersActive = t >= 3.8;
  const thinking = !still && between(t, 3.8, 5.2);
  const wiresLit = t >= 4.2;
  const gateShown = t >= 6.4;
  const askerActive = t >= 9.4;
  const answerShown = t >= 9.5;
  const toastShown = t >= 11.0;
  const activeStep = STEPS.reduce((i, s, idx) => (t >= s.at ? idx : i), 0);

  const packetOn = (ref: React.RefObject<SVGPathElement | null>, down: [number, number], up: [number, number]): ReactNode => {
    const path = ref.current;
    if (!path || still || !ready) return null;
    let p: number | null = null;
    if (between(t, down[0], down[1])) p = ease((t - down[0]) / (down[1] - down[0]));
    else if (between(t, up[0], up[1])) p = 1 - ease((t - up[0]) / (up[1] - up[0]));
    if (p == null) return null;
    const pt = path.getPointAtLength(path.getTotalLength() * p);
    return (
      <g>
        <circle className="sc-packet-halo" cx={pt.x} cy={pt.y} r={11} />
        <circle className="sc-packet" cx={pt.x} cy={pt.y} r={4.5} />
      </g>
    );
  };

  // A spark leaving each lit tool for its person, right after the tool wakes.
  const sparks = TOOLS.filter((tool) => tool.litAt != null).map((tool) => {
    const from = { x: tool.x + tool.w / 2, y: tool.y };
    const to = tool.owner === 'ben' ? { x: 110, y: 380 } : { x: 450, y: 380 };
    const t0 = tool.litAt! + 0.25;
    if (still || !between(t, t0, t0 + 0.55)) return null;
    const p = ease((t - t0) / 0.55);
    return <circle key={tool.label} className="sc-spark" cx={from.x + (to.x - from.x) * p} cy={from.y + (to.y - from.y) * p} r={2.6} />;
  });

  return (
    <div className="auth-scene" ref={rootRef}>
      <div>
        <p className="auth-kicker">{PRODUCT_NAME}</p>
        <h2 className="auth-headline">Know what your team is working on, without asking them.</h2>
        <p className="auth-lede">
          Each answer shows only what the asker is allowed to see, and the person asked about can
          see who asked.
        </p>
      </div>

      <div className="auth-stage" aria-hidden="true">
        <svg className="auth-svg" viewBox="0 0 560 540" role="presentation">
          <defs>
            <filter id="sc-glow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="3.5" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* depth 1: the rest of the organization */}
          <g className="auth-layer auth-layer-back">
            {stars.edges.map((e, i) => <line key={i} className="sc-bg-edge" x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />)}
            {stars.nodes.map((n, i) => (
              <circle key={i} className={`sc-bg-node${n.hub ? ' is-hub' : ''}`} cx={n.x} cy={n.y} r={n.hub ? 4 : 2.6}
                style={{ animationDelay: `${-n.delay}s` }} />
            ))}
          </g>

          <g className={`sc-fade${resetting ? ' sc-hidden' : ''}`}>
            {/* depth 2: the chart the question travels */}
            <g className="auth-layer auth-layer-mid">
              <path ref={e1} d={E1} className={`sc-edge${t >= 1.8 && t < 9.4 ? ' is-lit' : ''}`} />
              <path ref={e2} d={E2} className={`sc-edge${t >= 2.9 && t < 8.7 ? ' is-lit' : ''}`} />
              <path ref={e3} d={E3} className={`sc-edge${t >= 2.9 && t < 8.7 ? ' is-lit' : ''}`} />

              <Person p={ASKER} active={askerActive} thinking={false} />
              <Person p={MANAGER} active={managerActive} thinking={false} />
              <Person p={BEN} active={engineersActive} thinking={thinking} />
              <Person p={CHEN} active={engineersActive} thinking={thinking} />

              <Pill x={158} y={200} label="Direct manager ✓" shown={t >= 2.6} />
              <Pill x={128} y={282} label="Skip-level ✓" shown={t >= 3.8} />
              <Pill x={346} y={282} label="Skip-level ✓" shown={t >= 3.8} />

              {/* tools under each engineer */}
              <path d="M110 380 V 388 H 76 V 396 M110 388 H 140 V 396" className={`sc-wire${wiresLit ? ' is-lit' : ''}`} />
              <path d="M450 380 V 388 H 428 V 396 M450 388 H 516 V 396" className={`sc-wire${wiresLit ? ' is-lit' : ''}`} />
              {TOOLS.map((tool) => {
                const lit = tool.litAt != null && t >= tool.litAt;
                const idle = tool.litAt == null;
                return (
                  <g key={tool.label} className={`sc-chip${lit ? ' is-lit' : ''}${idle ? ' is-idle' : ''}`}>
                    <rect x={tool.x} y={tool.y} width={tool.w} height={24} rx={12} />
                    <text x={tool.x + tool.w / 2} y={tool.y + 16} textAnchor="middle">{tool.label}</text>
                  </g>
                );
              })}
              {sparks}

              {packetOn(e1, [1.8, 2.6], [8.8, 9.4])}
              {packetOn(e2, [2.9, 3.8], [7.9, 8.7])}
              {packetOn(e3, [2.9, 3.8], [7.9, 8.7])}
            </g>

            {/* depth 3: what people actually see */}
            <g className="auth-layer auth-layer-front">
              {/* the question, typed */}
              <g className={`sc-fade${questionShown ? '' : ' sc-hidden'}`}>
                <rect className="sc-card" x={110} y={22} width={340} height={62} rx={14} />
                <text x={132} y={46} className="sc-meta">Asha · VP Engineering</text>
                <text x={132} y={67} className="sc-text">
                  {QUESTION.slice(0, typedChars)}
                  {caretOn && <tspan className="sc-caret">|</tspan>}
                </text>
              </g>

              {/* the answer, assembling */}
              <g className={`sc-fade${answerShown ? '' : ' sc-hidden'}`}>
                <rect className="sc-card is-active" x={90} y={8} width={380} height={112} rx={14} />
                <text x={112} y={32} className="sc-meta">Answer for Asha · checked as skip-level</text>
                <text x={112} y={55} className={`sc-text sc-line${t >= 9.6 || still ? ' is-in' : ''}`}>Ben: billing PR is in review, 2 Jira tickets closed.</text>
                <text x={112} y={75} className={`sc-text sc-line${t >= 9.95 || still ? ' is-in' : ''}`}>Chen: tax module finished, tested with Claude Code.</text>
                <g className={`sc-line${t >= 10.7 || still ? ' is-in' : ''}`}>
                  <text x={112} y={102} className="sc-meta">Checked GitHub, Jira, Claude Code, Calendar</text>
                  <rect x={352} y={90} width={98} height={17} rx={8.5} className="sc-withheld-tag" />
                  <text x={401} y={102} textAnchor="middle" className="sc-withheld-text">1 item withheld</text>
                </g>
              </g>

              {/* the sharing rules gate */}
              <g className={`sc-gate${gateShown ? ' is-shown' : ''}`}>
                <rect x={392} y={126} width={160} height={104} rx={12} className="sc-gate-bg" />
                <text x={406} y={146} className="sc-gate-head">Sharing rules</text>
                <text x={538} y={146} textAnchor="end" className="sc-gate-rev">rev 12</text>
                <line x1={392} y1={154} x2={552} y2={154} className="sc-gate-rule" />
                {GATE_ROWS.map((row, i) => {
                  const y = 170 + i * 17;
                  const on = t >= row.at || still;
                  return (
                    <g key={row.label} className={`sc-gate-row${on ? ' is-on' : ''}${row.withheld ? ' is-withheld' : ''}`}>
                      <text x={406} y={y} className="sc-gate-label">{row.label}</text>
                      {row.withheld ? (
                        <>
                          <rect x={490} y={y - 11} width={58} height={14} rx={7} className="sc-gate-tag" />
                          <text x={519} y={y} textAnchor="middle" className="sc-gate-tag-text">Withheld</text>
                        </>
                      ) : (
                        <>
                          <circle cx={540} cy={y - 4} r={6} className="sc-check" />
                          <path d={`M${537} ${y - 4} l2 2 l4 -4.5`} className="sc-tick" />
                        </>
                      )}
                    </g>
                  );
                })}
              </g>

              {/* the other side */}
              <g className={`sc-toast${toastShown ? ' is-shown' : ''}`}>
                <rect x={30} y={470} width={252} height={50} rx={12} className="sc-toast-bg" />
                <circle cx={54} cy={495} r={12} className="sc-toast-avatar" />
                <text x={54} y={499} textAnchor="middle" className="sc-toast-initial">A</text>
                <text x={74} y={491} className="sc-toast-title">Asha Rao asked about you</text>
                <text x={74} y={507} className="sc-toast-meta">as a skip-level manager · just now</text>
              </g>
            </g>
          </g>
        </svg>
      </div>

      <ol className="auth-steps">
        {STEPS.map((s, i) => (
          <li key={s.label} className={i === activeStep && !resetting ? 'is-active' : undefined}>{s.label}</li>
        ))}
      </ol>
    </div>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <AuthScene />
      <main className="auth-main">{children}</main>
    </div>
  );
}
