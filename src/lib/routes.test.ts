import { describe, expect, it } from 'vitest';
import { href, parseRoute, type Route } from './routes';

describe('routes', () => {
  it('round-trips every route', () => {
    const routes: Route[] = [
      { name: 'library' },
      { name: 'recommend' },
      { name: 'title', id: '3f2a-uuid' },
      { name: 'add', query: '' },
      { name: 'add', query: 'The Wire & more' },
      { name: 'add', query: 'Shameless', link: 'abc' },
      { name: 'settings' },
      { name: 'device-check' },
      { name: 'about' },
    ];
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route);
  });

  it('sends unknown or empty addresses to the library', () => {
    expect(parseRoute('')).toEqual({ name: 'library' });
    expect(parseRoute('#/nowhere')).toEqual({ name: 'library' });
    expect(parseRoute('#/title/')).toEqual({ name: 'library' });
  });
});
