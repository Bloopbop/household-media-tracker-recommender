// Hash routes, so every screen has an address that works on GitHub Pages
// without server rewrites, and the back button behaves. Pure, unit tested.

export type Route =
  | { name: 'library' }
  | { name: 'recommend' }
  | { name: 'title'; id: string }
  | { name: 'add'; query: string; link?: string }
  | { name: 'settings' }
  | { name: 'device-check' }
  | { name: 'about' };

export const HOME: Route = { name: 'library' };

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
    case 'settings':
      return parts[1] === 'device-check' ? { name: 'device-check' } : parts[1] === 'about' ? { name: 'about' } : { name: 'settings' };
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
  }
}
