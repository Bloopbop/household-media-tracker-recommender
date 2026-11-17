import { href, parseRoute, type Route } from './routes';

export const router = $state({ route: parseRoute(location.hash) as Route });

function sync(): void {
  router.route = parseRoute(location.hash);
}

addEventListener('popstate', sync);
addEventListener('hashchange', sync);

export function go(route: Route, options: { replace?: boolean } = {}): void {
  const target = href(route);
  if (options.replace) history.replaceState(history.state, '', target);
  else history.pushState({ inApp: true }, '', target);
  sync();
  scrollTo(0, 0);
}

/** Back to the previous screen of this app, or to the fallback if there is none. */
export function back(fallback: Route): void {
  if ((history.state as { inApp?: boolean } | null)?.inApp) history.back();
  else go(fallback, { replace: true });
}

/** Props for an <a> that navigates within the app: `<a {...nav(route)}>`. */
export function nav(route: Route): { href: string; onclick: (event: MouseEvent) => void } {
  return {
    href: href(route),
    onclick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      go(route);
    },
  };
}
