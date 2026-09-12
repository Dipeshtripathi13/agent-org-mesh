import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../lib/errorReporting';

/** Catches a render crash anywhere below it (release audit OPS-09): the page shows a way
 *  forward instead of going blank, and the crash is reported to the backend. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError('render', error, { componentStack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', boxSizing: 'border-box', background: 'var(--bg, #f5f4f1)' }}>
        <div className="panel" role="alert" style={{ width: '100%', maxWidth: 400, marginTop: 0 }}>
          <header><span className="label">Something went wrong</span></header>
          <div className="inner">
            <p className="sub" style={{ marginTop: 0 }}>
              This page hit an unexpected problem. It&rsquo;s been reported &mdash; reloading usually gets you going again.
            </p>
            <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => window.location.reload()}>Reload the page</button>
              <a className="btn" href="/" style={{ display: 'flex', justifyContent: 'center', textDecoration: 'none' }}>Go to the start</a>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
