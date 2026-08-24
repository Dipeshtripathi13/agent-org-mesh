import type { ResponseItem, SurfaceState, Tier } from '../lib/api';

const TIER_LABEL: Record<Tier, string> = {
  T1: 'T1', T2: 'T2', T3: 'T3', WONT: "\u25EB won't", CANT: '\u2298 can\u0027t',
};

/** Tier badge. T1 and T3 must never be confusable at a glance. */
export function TierBadge({ tier }: { tier: Tier }) {
  return <span className="badge">{TIER_LABEL[tier]}</span>;
}

/** One claim or one withholding. Withholding is always visible, never a silent drop. */
export function ClaimItem({ item }: { item: ResponseItem }) {
  return (
    <div className={`item t-${item.tier}`}>
      <div className="row">
        <TierBadge tier={item.tier} />
        <p>{item.text}</p>
      </div>
      {item.evidenceId && (
        <button className={`evidence-chip e-${item.tier}`}>{item.evidenceId} &#8599;</button>
      )}
    </div>
  );
}

const SURFACE_COLOR: Record<SurfaceState, string> = {
  connected: 'var(--ok)',
  partial: 'var(--partial)',
  stale: 'var(--stale)',
  absent: 'var(--hatch)',
  outOfScope: 'transparent',
};

const KEY: { state: SurfaceState; label: string }[] = [
  { state: 'connected', label: 'connected' },
  { state: 'partial', label: 'partial scope' },
  { state: 'stale', label: 'stale' },
  { state: 'absent', label: 'not connected' },
];

export function swatchStyle(state: SurfaceState): React.CSSProperties {
  if (state === 'absent') return { background: 'var(--hatch)', border: '1px solid var(--rule2)' };
  if (state === 'outOfScope') return { border: '1px dashed var(--rule2)' };
  return { background: SURFACE_COLOR[state] };
}

/** Coverage bar. Gaps are named, never smoothed over. */
export function CoverageBar({ states, height = 6 }: { states: SurfaceState[]; height?: number }) {
  return (
    <div className="bar" style={{ height }}>
      {states.map((s, i) => (
        <div key={i} style={{ flex: 1, ...swatchStyle(s) }} />
      ))}
    </div>
  );
}

export function CoverageKey() {
  return (
    <div className="key">
      {KEY.map((k) => (
        <span key={k.state}>
          <i className="swatch" style={swatchStyle(k.state)} />
          {k.label}
        </span>
      ))}
    </div>
  );
}

/** Distinguishes won't (reversible by policy) from can't (never ingested). */
export function RefusalGlossary() {
  return (
    <p className="glossary">
      <strong>&#9707; won&rsquo;t</strong> &mdash; the agent holds it, policy blocks disclosure;
      reversible in the policy matrix. <strong>&#8856; can&rsquo;t</strong> &mdash; never ingested,
      so no policy change applies.
    </p>
  );
}
