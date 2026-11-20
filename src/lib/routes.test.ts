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
      { name: 'import' },
      { name: 'agree', person: 'A' },
      { name: 'agree', person: 'B' },
      { name: 'pick', key: 'movie:550', mode: 'US' },
      { name: 'pick', key: 'series:1396', mode: 'B' },
      { name: 'rec-check' },
      { name: 'rec-compare' },
    ];
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route);
  });

  it('sends unknown or empty addresses to recommendations, the launch view', () => {
    expect(parseRoute('')).toEqual({ name: 'recommend' });
    expect(parseRoute('#/nowhere')).toEqual({ name: 'recommend' });
    expect(parseRoute('#/title/')).toEqual({ name: 'recommend' });
    expect(parseRoute('#/pick/movie%3A550')).toEqual({ name: 'pick', key: 'movie:550', mode: 'US' });
  });
});
