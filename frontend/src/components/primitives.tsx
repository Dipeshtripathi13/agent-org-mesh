import { useEffect, useRef, useState } from 'react';
import type { ResponseItem, SurfaceState, Tier } from '../lib/api';

/** A metric tile's number counting up from 0 on first mount instead of just appearing —
 *  the one place in this pass motion touches real data, not just chrome. Re-triggers
 *  whenever `value` itself changes (a different org selected, a refetch), not on every
 *  render. Skips the animation entirely under prefers-reduced-motion or for a value that
 *  can't sensibly count up (NaN) — jumps straight to the final number either way. */
export function AnimatedNumber({ value, durationMs = 700 }: { value: number; durationMs?: number }) {
  const [display, setDisplay] = useState(value);
  const prevValue = useRef(value);
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (reduceMotion || !Number.isFinite(value) || value === prevValue.current) {
      setDisplay(value);
      prevValue.current = value;
      return;
    }
    const from = prevValue.current;
    const delta = value - from;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out-cubic
      setDisplay(Math.round(from + delta * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevValue.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <>{display}</>;
}

/** Tier codes are for the policy engine; people see what they mean. Withheld (policy said no)
 *  and never collected (structurally absent) stay visibly different — never one label. */
const TIER_LABEL: Record<Tier, string> = {
  T1: 'From records', T2: 'From activity', T3: 'Unconfirmed', WONT: '\u25EB Withheld', CANT: '\u2298 Never collected',
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
      <strong>&#9707; Withheld</strong> &mdash; the agent has this, but your organization&rsquo;s
      sharing rules don&rsquo;t allow it for this person; an admin can change those rules.{' '}
      <strong>&#8856; Never collected</strong> &mdash; no agent ever reads this, so no rule change
      could reveal it.
    </p>
  );
}

/** The "bring your own provider credentials" block shared by OrgSetup.tsx's
 *  OrgMainAgentPanel and SetUpMyAgent.tsx's personal main-agent panel — same fields
 *  (API key, optional endpoint URL, optional model), same tri-state semantics (blank key
 *  input means "leave the already-stored one untouched" when one exists), just pointed at
 *  whichever registration (org or personal) is being edited. `ownerLabel` is interpolated
 *  into the two messages that need to say *whose* credential this is ("this org" / "you"). */
export function CredentialsFields({
  useOwnCredentials, setUseOwnCredentials, hasCustomApiKey, hasBaseUrlOrModel, supportsBaseUrl,
  formApiKey, setFormApiKey, formBaseUrl, setFormBaseUrl, formModel, setFormModel, ownerLabel,
}: {
  useOwnCredentials: boolean;
  setUseOwnCredentials: (v: boolean) => void;
  hasCustomApiKey: boolean;
  hasBaseUrlOrModel: boolean;
  supportsBaseUrl: boolean;
  formApiKey: string;
  setFormApiKey: (v: string) => void;
  formBaseUrl: string;
  setFormBaseUrl: (v: string) => void;
  formModel: string;
  setFormModel: (v: string) => void;
  ownerLabel: string;
}) {
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule2)' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="chip" aria-pressed={!useOwnCredentials} onClick={() => setUseOwnCredentials(false)}>
          Use the shared platform key
        </button>
        <button type="button" className="chip" aria-pressed={useOwnCredentials} onClick={() => setUseOwnCredentials(true)}>
          Use {ownerLabel === 'you' ? 'my' : "our"} own credentials
        </button>
      </div>
      {useOwnCredentials ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
            API key
            <input
              type="password"
              autoComplete="off"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={hasCustomApiKey ? '•••• already set — leave blank to keep it' : 'sk-...'}
              className="input" style={{ minWidth: 220 }}
            />
          </label>
          {supportsBaseUrl && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
              Endpoint URL
              <input
                type="text"
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="input" style={{ minWidth: 220 }}
              />
            </label>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
            Model
            <input
              type="text"
              value={formModel}
              onChange={(e) => setFormModel(e.target.value)}
              placeholder={supportsBaseUrl ? 'gpt-4o-mini' : 'claude-sonnet-5'}
              className="input" style={{ minWidth: 160 }}
            />
          </label>
        </div>
      ) : (
        <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '8px 0 0' }}>
          {hasCustomApiKey || hasBaseUrlOrModel
            ? `Saving will clear ${ownerLabel === 'you' ? 'your' : "this org's"} own credentials and switch back to the platform default.`
            : `${ownerLabel === 'you' ? 'You use' : 'This org uses'} the platform's shared key — no credentials to enter.`}
        </p>
      )}
    </div>
  );
}
