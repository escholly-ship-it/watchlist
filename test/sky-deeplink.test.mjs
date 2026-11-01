// WL-43: Sky-Go-Deep-Link-Verarbeitung in app.js (providersFromVerdict,
// detailCtaHtml, applyProviders, resolveSkyDeepLink) — node --test test/sky-deeplink.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadAppContext(fetchImpl) {
  const syncSrc = readFileSync(new URL('../sync-merge.js', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
    .replace(/\ninit\(\);\s*$/, '\n');

  const makeEl = () => {
    let txt = '';
    return {
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      appendChild() {},
      set textContent(v) {
        txt = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
      get innerHTML() { return txt; },
      set innerHTML(v) { txt = String(v); },
    };
  };

  const nav = { onLine: true, userAgent: 'Mozilla/5.0', serviceWorker: { register: () => Promise.resolve() } };
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
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    document: {
      body: makeEl(),
      visibilityState: 'visible',
      getElementById: () => makeEl(),
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => makeEl(),
    },
    IntersectionObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (s) => s },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })),
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInContext(syncSrc, ctx);
  vm.runInContext(appSrc, ctx);
  return ctx;
}

test('providersFromVerdict erlaubt skygo:// nur fuer Sky und weist fremde Schemata ab', () => {
  const ctx = loadAppContext();
  const p = ctx.providersFromVerdict({
    best: { service: 'sky', kind: 'flat', link: 'skygo://', direct: true, prefilled: false },
    alternatives: [
      { service: 'netflix', kind: 'flat', link: 'skygo://watch/0ec07222-aef4-43e9-9bc6-a78b3ab439a7', direct: true, prefilled: true },
      { service: 'prime', kind: 'flat', link: 'javascript:alert(1)', direct: true, prefilled: true },
    ],
    rentOnly: [],
    checkedAt: 1000,
  });
  assert.equal(p.links.sky, 'skygo://');
  assert.equal(p.direct.sky, true);
  assert.equal(p.prefilled.sky, false);
  assert.equal(p.links.netflix, undefined);
  assert.equal(p.direct.netflix, false);
  assert.equal(p.links.prime, undefined);
  assert.equal(p.direct.prime, false);
});

test('detailCtaHtml rendert skygo:// ohne target="_blank" und hebt alte sky.de/suche-Links um', () => {
  const ctx = loadAppContext();
  const sky = vm.runInContext("SERVICES.find((s) => s.id === 'sky')", ctx);
  const netflix = vm.runInContext("SERVICES.find((s) => s.id === 'netflix')", ctx);

  const legacyHtml = ctx.detailCtaHtml({
    type: 'tv',
    tmdbId: 94997,
    title: 'House of the Dragon',
    serviceId: 'sky',
    providers: {
      flat: ['sky'],
      links: { sky: 'https://www.sky.de/suche?query=House%20of%20the%20Dragon' },
      direct: { sky: true },
      prefilled: { sky: true },
    },
  }, sky);
  assert.match(legacyHtml, /href="skygo:\/\/"/);
  assert.doesNotMatch(legacyHtml, /target="_blank"/);
  assert.match(legacyHtml, /Bei Sky suchen/);

  const resolvedHtml = ctx.detailCtaHtml({
    type: 'movie',
    tmdbId: 570670,
    title: 'Der Unsichtbare',
    serviceId: 'sky',
    providers: {
      flat: ['sky'],
      links: { sky: 'skygo://watch/c42d69c3-e0bc-48ef-a8dc-a6763ebbf94d' },
      direct: { sky: true },
      prefilled: { sky: true },
    },
  }, sky);
  assert.match(resolvedHtml, /href="skygo:\/\/watch\/c42d69c3-e0bc-48ef-a8dc-a6763ebbf94d"/);
  assert.doesNotMatch(resolvedHtml, /target="_blank"/);
  assert.match(resolvedHtml, /Bei Sky ansehen/);

  const nfHtml = ctx.detailCtaHtml({
    type: 'tv',
    tmdbId: 1,
    title: 'Dark',
    serviceId: 'netflix',
    providers: {
      flat: ['netflix'],
      links: { netflix: 'https://www.netflix.com/search?q=Dark' },
      direct: { netflix: true },
      prefilled: { netflix: true },
    },
  }, netflix);
  assert.match(nfHtml, /target="_blank" rel="noopener"/);
  assert.match(nfHtml, /Bei Netflix ansehen/);
});

test('resolveSkyDeepLink speichert UUID-Link und applyProviders bewahrt ihn bei 12-h-Checks', async () => {
  let skyCalls = 0;
  const ctx = loadAppContext(async (url) => {
    if (String(url).includes('/sky-link')) {
      skyCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          link: 'skygo://series/06411f70-9e6f-45ef-8565-a8eac23857f4',
          direct: true,
          prefilled: true,
          resolved: true,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };
  });

  const item = vm.runInContext(`(() => {
    const it = {
      id: 'it1',
      type: 'tv',
      tmdbId: 94997,
      title: 'House of the Dragon',
      serviceId: 'sky',
      watched: false,
      updatedAt: 1000,
      providers: {
        flat: ['sky'], rent: [], buy: [], rentOnly: [],
        links: { sky: 'skygo://' }, direct: { sky: true }, prefilled: { sky: false }, checkedAt: 1000,
      },
    };
    items.push(it);
    return it;
  })()`, ctx);

  await ctx.resolveSkyDeepLink(item);
  assert.equal(skyCalls, 1);
  assert.equal(item.providers.links.sky, 'skygo://series/06411f70-9e6f-45ef-8565-a8eac23857f4');
  assert.equal(item.providers.prefilled.sky, true);

  // Zweiter Aufruf fuer bereits aufgeloesten Titel macht keinen weiteren Netzwerk-Call
  await ctx.resolveSkyDeepLink(item);
  assert.equal(skyCalls, 1);

  // 12-h-Batch-Refresh liefert wieder generisches skygo:// -> aufgeloeste UUID bleibt erhalten
  const change = ctx.applyProviders(item, vm.runInContext(`({
    flat: ['sky'], rent: [], buy: [], rentOnly: [],
    links: { sky: 'skygo://' }, direct: { sky: true }, prefilled: { sky: false }, checkedAt: 5000,
  })`, ctx));
  assert.equal(change, null);
  assert.equal(item.providers.links.sky, 'skygo://series/06411f70-9e6f-45ef-8565-a8eac23857f4');
  assert.equal(item.providers.prefilled.sky, true);
});
