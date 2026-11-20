// Hash routes, so every screen has an address that works on GitHub Pages
// without server rewrites, and the back button behaves. Pure, unit tested.

export type Route =
  | { name: 'library' }
  | { name: 'recommend' }
  | { name: 'title'; id: string }
  | { name: 'add'; query: string; link?: string }
  | { name: 'settings' }
  | { name: 'device-check' }
  | { name: 'about' }
  | { name: 'import' }
  | { name: 'agree'; person: 'A' | 'B' }
  | { name: 'pick'; key: string; mode: 'A' | 'B' | 'US' }
  | { name: 'rec-check' }
  | { name: 'rec-compare' };

/** The app opens on recommendations (spec, story R1). */
export const HOME: Route = { name: 'recommend' };

export function parseRoute(hash: string): Route {
  const [path, search = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(search);
  switch (parts[0]) {
    case 'library':
      return { name: 'library' };
    case 'recommend':
      return { name: 'recommend' };
    case 'title':
      return parts[1] ? { name: 'title', id: parts[1] } : HOME;
    case 'add': {
      const link = params.get('link') ?? undefined;
      return link ? { name: 'add', query: params.get('q') ?? '', link } : { name: 'add', query: params.get('q') ?? '' };
    }
    case 'import':
      return { name: 'import' };
    case 'agree':
      return { name: 'agree', person: params.get('person') === 'B' ? 'B' : 'A' };
    case 'pick': {
      const mode = params.get('mode');
      return parts[1] ? { name: 'pick', key: parts[1], mode: mode === 'A' || mode === 'B' ? mode : 'US' } : HOME;
    }
    case 'settings':
      if (parts[1] === 'device-check') return { name: 'device-check' };
      if (parts[1] === 'about') return { name: 'about' };
      if (parts[1] === 'recommendation-check') return { name: 'rec-check' };
      if (parts[1] === 'picks-compared') return { name: 'rec-compare' };
      return { name: 'settings' };
    default:
      return HOME;
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'library':
    case 'recommend':
    case 'settings':
      return `#/${route.name}`;
    case 'title':
      return `#/title/${encodeURIComponent(route.id)}`;
    case 'add': {
      const params = new URLSearchParams();
      if (route.query) params.set('q', route.query);
      if (route.link) params.set('link', route.link);
      const search = params.toString();
      return search ? `#/add?${search}` : '#/add';
    }
    case 'device-check':
      return '#/settings/device-check';
    case 'about':
      return '#/settings/about';
    case 'import':
      return '#/import';
    case 'agree':
      return `#/agree?person=${route.person}`;
    case 'pick':
      return `#/pick/${encodeURIComponent(route.key)}?mode=${route.mode}`;
    case 'rec-check':
      return '#/settings/recommendation-check';
    case 'rec-compare':
      return '#/settings/picks-compared';
  }
}
