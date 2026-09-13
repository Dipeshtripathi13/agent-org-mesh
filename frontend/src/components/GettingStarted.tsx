import { useState } from 'react';
import { gettingStartedSteps, progressLabel, type GettingStartedInput } from '../lib/gettingStarted';
import { navigate } from '../lib/navigate';

const hiddenKey = (accountId: number) => `getting-started-hidden:${accountId}`;

function readHidden(accountId: number): boolean {
  try { return window.localStorage.getItem(hiddenKey(accountId)) === '1'; } catch { return false; }
}

/** First-run checklist. Disappears on its own once every step is done; "Hide" only tucks it
 *  away in this browser. */
export function GettingStarted({ accountId, input }: { accountId: number; input: GettingStartedInput }) {
  const [hidden, setHidden] = useState(() => readHidden(accountId));
  const steps = gettingStartedSteps(input);
  if (hidden || steps.every((s) => s.done)) return null;

  const hide = () => {
    try { window.localStorage.setItem(hiddenKey(accountId), '1'); } catch { /* still hides for this visit */ }
    setHidden(true);
  };

  return (
    <section className="getting-started" aria-labelledby="getting-started-title">
      <header>
        <div>
          <h2 id="getting-started-title">Get started</h2>
          <span className="getting-started-progress">{progressLabel(steps)}</span>
        </div>
        <button type="button" className="getting-started-hide" onClick={hide}>Hide</button>
      </header>
      <ol>
        {steps.map((s) => (
          <li key={s.key} className={s.done ? 'is-done' : undefined}>
            <span className="getting-started-check" aria-label={s.done ? 'Done' : 'Not done yet'}>{s.done ? '✓' : ''}</span>
            <div className="getting-started-text">
              <strong>{s.title}</strong>
              <span>{s.detail}</span>
            </div>
            {s.action && (
              <button type="button" className="btn btn-secondary" onClick={() => navigate(s.action!.path)}>
                {s.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
