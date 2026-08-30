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
              style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12, minWidth: 220 }}
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
                style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12, minWidth: 220 }}
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
              style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12, minWidth: 160 }}
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
