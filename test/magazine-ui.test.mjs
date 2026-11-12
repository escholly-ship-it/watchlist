// Magazin v3 („Für-Dich Streaming-Hub“) Client-UI-Tests — node --test test/magazine-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadAppContext({ fetchImpl } = {}) {
  const syncSrc = readFileSync(new URL('../sync-merge.js', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
    .replace(/\ninit\(\);\s*$/, '\n');

  const elementsById = new Map();
  const makeEl = (id = '') => {
    let txt = '';
    const classes = new Set();
    const listeners = new Map();
    const attrs = new Map();
    const el = {
      id,
      dataset: {},
      style: {},
      classList: {
        add(...cs) { cs.forEach((c) => classes.add(c)); },
        remove(...cs) { cs.forEach((c) => classes.delete(c)); },
        toggle(c, force) {
          if (force === undefined) {
            if (classes.has(c)) { classes.delete(c); return false; }
            classes.add(c); return true;
          }
          if (force) classes.add(c); else classes.delete(c);
          return !!force;
        },
        contains(c) { return classes.has(c); },
      },
      addEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        listeners.set(type, arr.filter((f) => f !== fn));
      },
      dispatch(type, evt) {
        for (const fn of listeners.get(type) || []) fn(evt);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      focus() {},
      select() {},
      remove() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      appendChild(child) {
        if (child && child.id) elementsById.set(child.id, child);
      },
      get textContent() { return txt; },
      set textContent(v) {
        txt = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
      get innerHTML() { return txt; },
      set innerHTML(v) { txt = String(v); },
    };
    return el;
  };

  const getEl = (id) => {
    if (!elementsById.has(id)) elementsById.set(id, makeEl(id));
    return elementsById.get(id);
  };

  const nav = {
    onLine: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
    serviceWorker: { register: () => Promise.resolve({ update: () => Promise.resolve() }) },
  };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, Map, Set, Number, String, Promise, RegExp,
    encodeURIComponent, decodeURIComponent,
    crypto: { getRandomValues: (a) => a },
    localStorage: { getItem: () => 'k'.repeat(32), setItem() {}, removeItem() {} },
    navigator: nav,
    window: {
      navigator: nav,
      location: { search: `?key=${'k'.repeat(32)}`, hash: '', origin: 'https://example.test', pathname: '/' },
      history: { replaceState() {} },
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    document: {
      body: makeEl('body'),
      activeElement: null,
      visibilityState: 'visible',
      getElementById: (id) => getEl(id),
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => makeEl(),
      execCommand: () => true,
    },
    IntersectionObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (s) => s },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })),
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx._getEl = getEl;
  vm.runInContext(syncSrc, ctx);
  vm.runInContext(appSrc, ctx);
  return ctx;
}

const SAMPLE_MAGAZINE = {
  engine: 3,
  issue: { date: '2026-11-12T04:15:00Z' },
  taste_summary: {
    watchlist_count: 48,
    top_genres: ['Thriller', 'Sci-Fi', 'Drama'],
    seed_titles: ['Severance', 'Dune: Part Two'],
    top_services: ['disney', 'netflix'],
  },
  counts: { neu: 2, entdeckt: 1, demnaechst: 1 },
  sections: [
    {
      id: 'neu',
      items: [
        {
          key: 'tv_101',
          tmdb_id: 101,
          type: 'tv',
          title: 'Andor',
          year: '2025',
          rating: 8.4,
          match_pct: 94,
          backdrop_path: '/andor-bg.jpg',
          poster_path: '/andor-p.jpg',
          providers_app: ['disney'],
          trailer_key: 'cKOegEuCcfw',
          reason: 'Sci-Fi-Spannung passend zu Severance',
          overview: 'Cassian Andor schließt sich dem Widerstand an.',
        },
        {
          key: 'movie_102',
          tmdb_id: 102,
          type: 'movie',
          title: 'The Electric State',
          year: '2026',
          rating: 7.5,
          match_pct: 86,
          backdrop_path: '/elec-bg.jpg',
          poster_path: '/elec-p.jpg',
          providers_app: ['netflix'],
          trailer_key: 'abc123xyz',
          reason: 'Neu bei Netflix in deinem Sci-Fi-Fokus',
        },
      ],
    },
    {
      id: 'entdeckt',
      items: [
        {
          key: 'tv_201',
          tmdb_id: 201,
          type: 'tv',
          title: 'Dark Matter',
          year: '2024',
          rating: 7.9,
          match_pct: 91,
          backdrop_path: '/dm-bg.jpg',
          poster_path: '/dm-p.jpg',
          providers_app: ['apple'],
          fan_of: 'Severance',
          reason: 'Aus deiner Watchlist abgeleitet',
        },
      ],
    },
    {
      id: 'demnaechst',
      items: [
        {
          key: 'movie_301',
          tmdb_id: 301,
          type: 'movie',
          title: 'Project Hail Mary',
          year: '2026',
          rating: 8.1,
          match_pct: 93,
          is_upcoming: true,
          upcoming_date: '2026-11-28',
          backdrop_path: '/phm-bg.jpg',
          poster_path: '/phm-p.jpg',
          providers_app: [],
          reason: 'Kommender Kinostart zum Vormerken',
        },
      ],
    },
  ],
};

test('switchMainView schaltet sauber zwischen Meine Liste und Für dich um', () => {
  const ctx = loadAppContext();
  vm.runInContext(`magazine = ${JSON.stringify(SAMPLE_MAGAZINE)};`, ctx);

  ctx.switchMainView('discover');
  assert.equal(ctx._getEl('app').classList.contains('view-discover'), true);
  assert.equal(ctx._getEl('discoverView').classList.contains('hidden'), false);
  assert.equal(ctx._getEl('tabDiscover').getAttribute('aria-selected'), 'true');
  assert.equal(ctx._getEl('tabList').getAttribute('aria-selected'), 'false');

  ctx.switchMainView('list');
  assert.equal(ctx._getEl('app').classList.contains('view-discover'), false);
  assert.equal(ctx._getEl('discoverView').classList.contains('hidden'), true);
  assert.equal(ctx._getEl('tabList').getAttribute('aria-selected'), 'true');
});

test('renderDiscoverView rendert Taste-Lens, Anbieter-Chips, Spotlight-Hero und Themen-Rails', () => {
  const ctx = loadAppContext();
  vm.runInContext(`magazine = ${JSON.stringify(SAMPLE_MAGAZINE)};`, ctx);
  ctx.switchMainView('discover');

  const html = ctx._getEl('discoverView').innerHTML;
  assert.match(html, /Gelernt aus <strong>48 Titeln<\/strong>/);
  assert.match(html, /Thriller, Sci-Fi, Drama/);
  assert.match(html, /Severance, Dune: Part Two/);
  assert.match(html, /Neu mischen/);
  assert.match(html, /data-mag-prov="disney"/);
  assert.match(html, /data-mag-prov="netflix"/);
  assert.match(html, /data-mag-prov="__upcoming__"/);
  // Hero bevorzugt Neu-Titel mit Backdrop + Trailer (Andor)
  assert.match(html, /class="mag-spot-hero" data-mag-key="tv_101"/);
  assert.match(html, /94% Match/);
  // Übrige Titel landen ohne Duplikat in den 3 Themen-Rails
  assert.match(html, /data-rail="neu"/);
  assert.match(html, /The Electric State/);
  assert.match(html, /data-rail="entdeckt"/);
  assert.match(html, /Dark Matter/);
  assert.match(html, /data-rail="demnaechst"/);
  assert.match(html, /Project Hail Mary/);
});

test('filterMagazineByProvider filtert nach Dienst und Demnaechst', () => {
  const ctx = loadAppContext();
  vm.runInContext(`magazine = ${JSON.stringify(SAMPLE_MAGAZINE)};`, ctx);
  const all = ctx.magazineItems();

  const disneyOnly = ctx.filterMagazineByProvider(all, 'disney');
  assert.deepEqual(Array.from(disneyOnly, (x) => x.key), ['tv_101']);

  const netflixOnly = ctx.filterMagazineByProvider(all, 'netflix');
  assert.deepEqual(Array.from(netflixOnly, (x) => x.key), ['movie_102']);

  const upcomingOnly = ctx.filterMagazineByProvider(all, '__upcoming__');
  assert.deepEqual(Array.from(upcomingOnly, (x) => x.key), ['movie_301']);
});

test('dismissMagazineItemByKey entfernt Titel sofort, sendet Feedback und Undo stellt ihn wieder her', async () => {
  const calls = [];
  const ctx = loadAppContext({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  vm.runInContext(`magazine = ${JSON.stringify(SAMPLE_MAGAZINE)};`, ctx);
  ctx.switchMainView('discover');

  let undoFn = null;
  vm.runInContext('showUndoBar = (msg, fn) => { globalThis._lastUndoMsg = msg; globalThis._lastUndoFn = fn; };', ctx);
  ctx.dismissMagazineItemByKey('movie_102');

  assert.equal(ctx.findMagazineItem('movie_102'), null);
  assert.doesNotMatch(ctx._getEl('discoverView').innerHTML, /The Electric State/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/magazine\/feedback$/);
  assert.deepEqual(calls[0].body, { key: 'movie_102', action: 'dismiss', title: 'The Electric State' });

  undoFn = ctx._lastUndoFn;
  assert.equal(typeof undoFn, 'function');
  undoFn();

  assert.notEqual(ctx.findMagazineItem('movie_102'), null);
  assert.match(ctx._getEl('discoverView').innerHTML, /The Electric State/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { key: 'movie_102', action: 'undo', title: 'The Electric State' });
});

test('pickBestYoutubeKey bevorzugt offiziellen deutschen Trailer vor englischem Teaser und openTrailerModal bettet YouTube ein', async () => {
  const ctx = loadAppContext();
  const chosen = ctx.pickBestYoutubeKey([
    { site: 'YouTube', key: 'en_teaser', type: 'Teaser', official: true, iso_639_1: 'en' },
    { site: 'YouTube', key: 'en_trailer', type: 'Trailer', official: true, iso_639_1: 'en' },
    { site: 'YouTube', key: 'de_trailer', type: 'Trailer', official: true, iso_639_1: 'de' },
  ]);
  assert.equal(chosen, 'de_trailer');

  await ctx.openTrailerModal({
    title: 'Andor',
    year: '2025',
    type: 'tv',
    tmdbId: 101,
    trailerKey: 'cKOegEuCcfw',
    magItem: SAMPLE_MAGAZINE.sections[0].items[0],
  });
  assert.match(ctx._getEl('trailerStage').innerHTML, /youtube-nocookie\.com\/embed\/cKOegEuCcfw/);
  assert.match(ctx._getEl('trailerFooter').innerHTML, /trailerAddBtn/);

  ctx.closeTrailerModal();
  assert.equal(ctx._getEl('trailerStage').innerHTML, '');
});
