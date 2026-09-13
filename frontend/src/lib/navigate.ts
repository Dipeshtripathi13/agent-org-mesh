/** Moves to another screen from inside a page. App.tsx's Shell owns routing and already follows
 *  the URL on popstate, so updating history and announcing it is all a page needs to do. */
export function navigate(path: string): void {
  if (window.location.pathname !== path) {
    try {
      window.history.pushState(null, '', path);
    } catch {
      window.location.assign(path);
      return;
    }
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}
