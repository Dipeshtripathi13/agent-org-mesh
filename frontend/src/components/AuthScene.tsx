import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PRODUCT_NAME } from '../lib/brand';

/**
 * The left half of sign in / create account / reset password: the product working, as a
 * looping scene. A manager asks a question, it travels down the org chart, each agent lights
 * up only the tools that matter, the sharing rules mark one item withheld, and one answer
 * travels back up. Pauses when the tab is hidden or the scene is off screen, follows the mouse
 * slightly, and shows a still final frame under prefers-reduced-motion.
 */

const LOOP = 10.4;
const STILL_FRAME = 8.6;

const STEPS: { at: number; label: string }[] = [
  { at: 0, label: 'Someone asks' },
  { at: 1.2, label: 'It travels the org chart' },
  { at: 3.2, label: 'Agents read only the tools that matter' },
  { at: 5.2, label: 'Sharing rules decide what’s shown' },
  { at: 6.0, label: 'One answer comes back' },
];

const EDGE_BEN = 'M260 174 C 260 252, 140 244, 140 318';
const EDGE_CHEN = 'M260 174 C 260 252, 380 244, 380 318';

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const between = (t: number, a: number, b: number) => t >= a && t < b;

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

function Chip({ x, y, w, label, state }: { x: number; y: number; w: number; label: string; state: 'idle' | 'lit' | 'withheld' }) {
  return (
    <g className={`sc-chip${state === 'lit' ? ' is-lit' : state === 'withheld' ? ' is-withheld' : ''}`}>
      <rect x={x} y={y} width={w} height={26} rx={13} />
      <text x={x + w / 2} y={y + 17} textAnchor="middle">{label}</text>
    </g>
  );
}

function Person({ x, y, name, role, active, checking }: { x: number; y: number; name: string; role: string; active: boolean; checking: boolean }) {
  return (
    <g>
      {checking && <rect className="sc-pulse" x={x} y={y} width={140} height={50} rx={14} />}
      <rect className={`sc-card${active ? ' is-active' : ''}`} x={x} y={y} width={140} height={50} rx={14} />
      <circle cx={x + 24} cy={y + 25} r={11} className="sc-avatar" />
      <text x={x + 24} y={y + 29} textAnchor="middle" className="sc-initial">{name[0]}</text>
      <text x={x + 44} y={y + 22} className="sc-name">{name}</text>
      <text x={x + 44} y={y + 37} className="sc-meta">{role}</text>
    </g>
  );
}

export function AuthScene() {
  const reduced = useReducedMotion();
  const [t, setT] = useState(reduced ? STILL_FRAME : 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const benRef = useRef<SVGPathElement>(null);
  const chenRef = useRef<SVGPathElement>(null);
  const [gates, setGates] = useState<{ ben: DOMPoint; chen: DOMPoint } | null>(null);

  useLayoutEffect(() => {
    const b = benRef.current, c = chenRef.current;
    if (b && c) setGates({ ben: b.getPointAtLength(b.getTotalLength() * 0.78), chen: c.getPointAtLength(c.getTotalLength() * 0.78) });
  }, []);

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

  const resetting = t >= 9.9;
  const packet = (ref: React.RefObject<SVGPathElement | null>): ReactNode => {
    const path = ref.current;
    if (!path || reduced) return null;
    let p: number | null = null;
    if (between(t, 1.2, 2.6)) p = ease((t - 1.2) / 1.4);
    else if (between(t, 6.0, 7.4)) p = 1 - ease((t - 6.0) / 1.4);
    if (p == null) return null;
    const pt = path.getPointAtLength(path.getTotalLength() * p);
    return <circle className="sc-packet" cx={pt.x} cy={pt.y} r={5.5} />;
  };

  const edgesLit = between(t, 1.2, 2.6) || between(t, 6.0, 7.4);
  const lit = (at: number) => (t >= at && !resetting ? 'lit' : 'idle');
  const checking = between(t, 2.6, 5.2);
  const agentsActive = between(t, 2.6, 9.9);
  const gated = between(t, 5.2, 9.9);
  const activeStep = STEPS.reduce((i, s, idx) => (t >= s.at ? idx : i), 0);

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
        <svg className="auth-svg" viewBox="0 0 520 480" role="presentation">
          <defs>
            <filter id="sc-glow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="3.5" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          <g className={`sc-fade${resetting ? ' sc-hidden' : ''}`}>
            {/* question → answer */}
            <g className={`sc-fade${between(t, 0.2, 7.2) ? '' : ' sc-hidden'}`}>
              <rect className="sc-card" x={100} y={24} width={320} height={64} rx={14} />
              <text x={122} y={49} className="sc-meta">Asha · VP Engineering</text>
              <text x={122} y={70} className="sc-text">What’s the status of the billing migration?</text>
            </g>
            <g className={`sc-fade${t >= 7.4 ? '' : ' sc-hidden'}`}>
              <rect className="sc-card is-active" x={62} y={8} width={396} height={104} rx={14} />
              <text x={84} y={32} className="sc-meta">Answer for Asha</text>
              <text x={84} y={53} className="sc-text">Ben: billing PR is in review, 2 Jira tickets closed.</text>
              <text x={84} y={72} className="sc-text">Chen: finished the tax module with Claude Code.</text>
              <text x={84} y={96} className="sc-meta">Checked 4 tools · 1 item withheld</text>
            </g>

            <Person x={190} y={124} name="Asha Rao" role="VP Engineering" active={t >= 7.4} checking={false} />

            <path ref={benRef} d={EDGE_BEN} className={`sc-edge${edgesLit ? ' is-lit' : ''}`} />
            <path ref={chenRef} d={EDGE_CHEN} className={`sc-edge${edgesLit ? ' is-lit' : ''}`} />
            {packet(benRef)}
            {packet(chenRef)}

            {gates && gated && (
              <>
                <circle cx={gates.ben.x} cy={gates.ben.y} r={8} className="sc-check" />
                <path d={`M${gates.ben.x - 3.5} ${gates.ben.y} l2.5 2.5 l4.5 -5`} className="sc-tick" />
                <circle cx={gates.chen.x} cy={gates.chen.y} r={8} className="sc-check" />
                <path d={`M${gates.chen.x - 3.5} ${gates.chen.y} l2.5 2.5 l4.5 -5`} className="sc-tick" />
              </>
            )}

            <Person x={70} y={318} name="Ben Carter" role="Engineer" active={agentsActive} checking={checking} />
            <Person x={310} y={318} name="Chen Li" role="Engineer" active={agentsActive} checking={checking} />

            <path d="M140 368 V 384 H 98 V 400 M140 384 H 176 V 400" className="sc-wire" />
            <path d="M380 368 V 384 H 342 V 400 M380 384 H 434 V 400" className="sc-wire" />
            <Chip x={62} y={400} w={72} label="GitHub" state={lit(3.3)} />
            <Chip x={146} y={400} w={60} label="Jira" state={lit(3.8)} />
            <Chip x={296} y={400} w={92} label="Claude Code" state={lit(4.3)} />
            <Chip x={396} y={400} w={76} label="Calendar" state={lit(4.8)} />
            <Chip x={70} y={436} w={140} label="Notion · not needed" state="idle" />
            <Chip x={316} y={436} w={128} label="1 item withheld" state={t >= 5.5 && !resetting ? 'withheld' : 'idle'} />
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
