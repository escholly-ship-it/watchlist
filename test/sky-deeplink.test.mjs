// WL-43: Sky-CTA plattformbewusst in app.js — macOS Desktop startet Sky Go App
// (`skygo://`) + kopiert den Titel fuer die Suche (⌘V); iOS/iPadOS/Web bleiben
// beim fehlerfreien https-Suchlink (`sky.de/suche`) inkl. Selbstheilung gecachter
// `skygo://`-Links — node --test test/sky-deeplink.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadAppContext({
  userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  platform = 'iPhone',
  maxTouchPoints = 5,
  userAgentData = undefined,
  writeText = undefined,
} = {}) {
  const syncSrc = readFileSync(new URL('../sync-merge.js', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
    .replace(/\ninit\(\);\s*$/, '\n');

  const elementsById = new Map();
  const makeEl = (id = '') => {
    let txt = '';
    const listeners = new Map();
    const el = {
      id,
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      dispatch(type, evt) {
        for (const fn of listeners.get(type) || []) fn(evt);
      },
      setAttribute() {},
      removeAttribute() {},
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
    userAgent,
    platform,
    maxTouchPoints,
    userAgentData,
    clipboard: writeText ? { writeText } : undefined,
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
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }),
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx._getEl = getEl;
  vm.runInContext(syncSrc, ctx);
  vm.runInContext(appSrc, ctx);
  return ctx;
}

test('isMacDesktop erkennt echtes macOS und schliesst iOS sowie iPadOS im Desktop-Modus aus', () => {
  const macChrome = loadAppContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    maxTouchPoints: 0,
    userAgentData: { platform: 'macOS' },
  });
  assert.equal(macChrome.isMacDesktop(), true);

  const iphone = loadAppContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    platform: 'iPhone',
    maxTouchPoints: 5,
  });
  assert.equal(iphone.isMacDesktop(), false);

  // iPadOS Safari sendet standardmaessig Macintosh-UA, hat aber maxTouchPoints === 5
  const ipadDesktopMode = loadAppContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  });
  assert.equal(ipadDesktopMode.isMacDesktop(), false);

  const windows = loadAppContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
    platform: 'Win32',
    maxTouchPoints: 0,
  });
  assert.equal(windows.isMacDesktop(), false);
});

test('iOS/iPadOS: detailCtaHtml rendert fehlerfreien https-Suchlink und heilt gecachte skygo://-Links', () => {
  const ctx = loadAppContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
  });
  const sky = vm.runInContext("SERVICES.find((s) => s.id === 'sky')", ctx);

  const normalHtml = ctx.detailCtaHtml({
    type: 'tv',
    tmdbId: 270572,
    title: 'Lord of the Flies',
    serviceId: 'sky',
    providers: {
      flat: ['sky'],
      links: { sky: 'https://www.sky.de/suche?query=Lord%20of%20the%20Flies' },
      direct: { sky: true },
      prefilled: { sky: true },
    },
  }, sky);
  assert.match(normalHtml, /href="https:\/\/www\.sky\.de\/suche\?query=Lord%20of%20the%20Flies"/);
  assert.match(normalHtml, /target="_blank" rel="noopener"/);
  assert.doesNotMatch(normalHtml, /skygo:\/\//);
  assert.doesNotMatch(normalHtml, /data-sky-copy/);

  // Selbstheilung: falls aus KV/localStorage noch ein skygo://watch/...-Link anliegt
  const staleHtml = ctx.detailCtaHtml({
    type: 'movie',
    tmdbId: 1234821,
    title: 'Jurassic World: Die Wiedergeburt',
    serviceId: 'sky',
    providers: {
      flat: ['sky'],
      links: { sky: 'skygo://watch/e48613d0-0a6b-4e46-98e3-49a8a42f3975' },
      direct: { sky: true },
      prefilled: { sky: true },
    },
  }, sky);
  assert.match(staleHtml, /href="https:\/\/www\.sky\.de\/suche\?query=Jurassic%20World%3A%20Die%20Wiedergeburt"/);
  assert.match(staleHtml, /target="_blank" rel="noopener"/);
  assert.doesNotMatch(staleHtml, /skygo:\/\//);
});

test('macOS Desktop: detailCtaHtml rendert Sky-Go-App-Start mit Titel-Copy und lässt TMDB-Fallback intakt', () => {
  const ctx = loadAppContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  });
  const sky = vm.runInContext("SERVICES.find((s) => s.id === 'sky')", ctx);
  const netflix = vm.runInContext("SERVICES.find((s) => s.id === 'netflix')", ctx);

  const macSkyHtml = ctx.detailCtaHtml({
    type: 'movie',
    tmdbId: 1234821,
    title: 'Jurassic World: "Wiedergeburt"',
    serviceId: 'sky',
    providers: {
      flat: ['sky'],
      links: { sky: 'https://www.sky.de/suche?query=Jurassic' },
      direct: { sky: true },
      prefilled: { sky: true },
    },
  }, sky);
  assert.match(macSkyHtml, /href="skygo:\/\/"/);
  assert.doesNotMatch(macSkyHtml, /target="_blank"/);
  assert.match(macSkyHtml, /Sky Go öffnen/);
  assert.match(macSkyHtml, /data-sky-copy="Jurassic World: &quot;Wiedergeburt&quot;"/);

  // Manuell gepinnter Sky-Titel auf macOS bekommt ebenfalls App-Start + Titel-Copy
  const pinnedSkyHtml = ctx.detailCtaHtml({
    type: 'tv',
    tmdbId: 270572,
    title: 'Lord of the Flies',
    serviceId: 'sky',
    pinnedServiceId: 'sky',
    providers: { flat: [], links: {}, direct: {} },
  }, sky);
  assert.match(pinnedSkyHtml, /href="skygo:\/\/"/);
  assert.match(pinnedSkyHtml, /data-sky-copy="Lord of the Flies"/);

  // Gesehener Titel ohne aktives Sky-Angebot und ohne Pin bleibt ehrlich bei TMDB
  const expiredHtml = ctx.detailCtaHtml({
    type: 'movie',
    tmdbId: 1114967,
    title: 'Good Fortune',
    watched: true,
    serviceId: 'sky',
    providers: { flat: [], links: {}, direct: {} },
  }, sky);
  assert.match(expiredHtml, /href="https:\/\/www\.themoviedb\.org\/movie\/1114967\/watch\?locale=DE"/);
  assert.match(expiredHtml, /Sky-Angebot auf TMDB/);

  // Andere Dienste bleiben auf macOS unveraendert bei https + target="_blank"
  const nfHtml = ctx.detailCtaHtml({
    type: 'tv',
    tmdbId: 66732,
    title: 'Stranger Things',
    serviceId: 'netflix',
    providers: {
      flat: ['netflix'],
      links: { netflix: 'https://www.netflix.com/search?q=Stranger%20Things' },
      direct: { netflix: true },
      prefilled: { netflix: true },
    },
  }, netflix);
  assert.match(nfHtml, /target="_blank" rel="noopener"/);
  assert.doesNotMatch(nfHtml, /data-sky-copy/);
});

test('macOS Klick auf Sky-CTA kopiert den Titel in die Zwischenablage und zeigt Hinweis-Toast', () => {
  const copied = [];
  const ctx = loadAppContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0',
    platform: 'MacIntel',
    maxTouchPoints: 0,
    writeText: async (txt) => { copied.push(txt); },
  });
  ctx.bindEvents();

  const detailModal = ctx._getEl('detailModal');
  const fakeCta = {
    getAttribute(attr) {
      return attr === 'data-sky-copy' ? 'Jurassic World: Die Wiedergeburt' : null;
    },
  };
  let prevented = false;
  detailModal.dispatch('click', {
    target: {
      closest(sel) {
        return sel === 'a.btn-primary-cta[data-sky-copy]' ? fakeCta : null;
      },
    },
    preventDefault() { prevented = true; },
  });

  assert.deepEqual(copied, ['Jurassic World: Die Wiedergeburt']);
  // Kein preventDefault, damit der Browser das native skygo://-Protokoll an macOS uebergibt
  assert.equal(prevented, false);
  const toast = ctx._getEl('autoAddToast');
  assert.match(toast.textContent, /Jurassic World: Die Wiedergeburt/);
  assert.match(toast.textContent, /⌘V/);
});

test('providersFromVerdict akzeptiert nur https-Links und applyProviders ueberschreibt alte skygo://-Eintraege', () => {
  const ctx = loadAppContext();
  const p = ctx.providersFromVerdict({
    best: { service: 'sky', kind: 'flat', link: 'skygo://watch/e48613d0-0a6b-4e46-98e3-49a8a42f3975', direct: true, prefilled: true },
    alternatives: [
      { service: 'netflix', kind: 'flat', link: 'https://www.netflix.com/search?q=Test', direct: true, prefilled: true },
    ],
    rentOnly: [],
    checkedAt: 1000,
  });
  assert.equal(p.links.sky, undefined);
  assert.equal(p.direct.sky, false);
  assert.equal(p.links.netflix, 'https://www.netflix.com/search?q=Test');

  const item = {
    id: '1',
    type: 'movie',
    tmdbId: 1234821,
    title: 'Jurassic World: Die Wiedergeburt',
    serviceId: 'sky',
    watched: false,
    updatedAt: 100,
    providers: {
      flat: ['sky'],
      rent: [],
      buy: [],
      rentOnly: [],
      links: { sky: 'skygo://watch/e48613d0-0a6b-4e46-98e3-49a8a42f3975' },
      direct: { sky: true },
      prefilled: { sky: true },
      checkedAt: 100,
      skyCheckedAt: 100,
    },
  };
  const fresh = {
    flat: ['sky'],
    rent: [],
    buy: [],
    rentOnly: [],
    links: { sky: 'https://www.sky.de/suche?query=Jurassic%20World' },
    direct: { sky: true },
    prefilled: { sky: true },
    checkedAt: 200,
  };
  const res = ctx.applyProviders(item, fresh);
  assert.equal(res, 'updated');
  assert.equal(item.providers.links.sky, 'https://www.sky.de/suche?query=Jurassic%20World');
  assert.equal(item.providers.skyCheckedAt, undefined);
});
