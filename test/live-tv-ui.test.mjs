import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const MERGE_SRC = fs.readFileSync(path.join(ROOT, 'sync-merge.js'), 'utf8');

function makeElement(id, tagName = 'div') {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  const el = {
    id,
    tagName: tagName.toUpperCase(),
    value: '',
    innerHTML: '',
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    classList: {
      add(...c) { c.forEach((k) => classes.add(k)); },
      remove(...c) { c.forEach((k) => classes.delete(k)); },
      toggle(k, force) {
        if (force === undefined) {
          if (classes.has(k)) { classes.delete(k); return false; }
          classes.add(k); return true;
        }
        if (force) classes.add(k); else classes.delete(k);
        return !!force;
      },
      contains(k) { return classes.has(k); },
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      listeners.set(type, list.filter((f) => f !== fn));
    },
    dispatchEvent(evt) {
      const list = listeners.get(evt.type) || [];
      list.forEach((fn) => fn(evt));
    },
    focus() {},
    select() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(child) { el.children.push(child); return child; },
    closest() { return null; },
  };
  return el;
}

function loadAppContext({ platform = 'MacIntel', maxTouchPoints = 0 } = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  [
    'app', 'watchlist', 'shortlistSection', 'shortlistTrack', 'liveView',
    'emptyState', 'loadingState', 'filterBar', 'pillFilter', 'pillFilterValue',
    'pillWoche', 'pillWocheLabel', 'pillWocheValue',
    'tabList', 'tabDiscover', 'tabLiveNow', 'tabLivePrime',
    'tabListCount', 'tabDiscoverCount', 'tabLiveCount', 'tabPrimeCount',
    'discoverView', 'filterModal', 'magazineModal', 'magazineModalBody',
    'trailerModal', 'trailerModalTitle', 'trailerStage', 'trailerFooter', 'trailerModalClose',
    'seenSection', 'seenBar', 'seenCount', 'seenGrid', 'addModal',
    'detailModal', 'pinModal', 'syncModal', 'syncKeyInput', 'syncKeyError',
    'btnSyncKey', 'btnEmptySyncKey', 'btnSyncShare', 'btnSyncCopyUrl',
    'searchInput', 'searchClear', 'searchResults', 'serviceSelect',
    'selectedTitle', 'serviceGrid', 'btnSave', 'btnAdd', 'modalClose',
    'filterClose', 'magazineModalClose', 'pinCancel',
  ].forEach(getEl);

  const opens = [];
  const toasts = [];
  let copiedText = '';
  const loc = {
    origin: 'https://escholly-ship-it.github.io',
    pathname: '/watchlist/',
    search: '?key=' + 't'.repeat(32),
    href: 'https://escholly-ship-it.github.io/watchlist/?key=' + 't'.repeat(32),
  };
  const storage = new Map();

  const context = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Intl,
    Event: class Event { constructor(type) { this.type = type; } },
    Map,
    Set,
    WeakMap,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: {
      platform,
      maxTouchPoints,
      clipboard: {
        writeText: async (text) => { copiedText = text; },
      },
    },
    window: {
      location: loc,
      history: { replaceState() {} },
      open(url, target, features) { opens.push({ url, target, features }); },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    document: {
      activeElement: null,
      getElementById: (id) => getEl(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => {
        if (tag === 'div') {
          let raw = '';
          const div = makeElement('', 'div');
          Object.defineProperty(div, 'textContent', {
            get() { return raw; },
            set(v) {
              raw = String(v ?? '');
              div.innerHTML = raw
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            },
          });
          return div;
        }
        return makeElement('', tag);
      },
      addEventListener() {},
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    _getEl: getEl,
    _opens: opens,
    _toasts: toasts,
    _getCopiedText: () => copiedText,
  };
  context.window.navigator = context.navigator;
  context.window.document = context.document;
  context.window.localStorage = context.localStorage;
  context.location = loc;

  vm.createContext(context);
  vm.runInContext(MERGE_SRC, context);
  const patchedApp = APP_SRC.replace(/\ninit\(\);\s*$/, '\n');
  vm.runInContext(patchedApp, context);
  context.showAutoAddToast = (msg, kind) => toasts.push({ msg, kind });
  context.copyTextToClipboard = (text) => { copiedText = text; };
  return context;
}

test('index.html, style.css und sw.js enthalten V1 4-Tab-Navigation und #liveView (v7-Cache)', () => {
  assert.match(HTML_SRC, /id="tabList"/);
  assert.match(HTML_SRC, /id="tabDiscover"/);
  assert.match(HTML_SRC, /id="tabLiveNow"/);
  assert.match(HTML_SRC, /id="tabLivePrime"/);
  assert.match(HTML_SRC, /id="liveView"/);
  assert.doesNotMatch(HTML_SRC, /id="liveBandSection"/);
  assert.doesNotMatch(HTML_SRC, /id="liveTvModal"/);
  assert.match(CSS_SRC, /\.live-view/);
  assert.match(CSS_SRC, /#app\.view-live #watchlist/);
  assert.match(CSS_SRC, /#app\.view-primetime #watchlist/);
  assert.match(SW_SRC, /CACHE_VERSION = 'v7'/);
});

test('buildLiveNowItems und buildPrimetimeItems trennen Live vs. 20:15 strikt und filtern unempfangbare Sender heraus', () => {
  const ctx = loadAppContext();
  const sampleLive = {
    ok: true,
    now: [
      {
        id: 'sat_wdr_1500',
        channel: 'WDR',
        shortChannel: 'WDR HD',
        track: 'sat',
        trackLabel: 'SAT HD',
        badge: 'SAT',
        title: 'Watzmann ermittelt',
        startTime: '14:30',
        endTime: '15:20',
        isLive: true,
        progressPct: 45,
        webUrl: 'https://www.ardmediathek.de/live',
        mediathekServiceId: 'ard',
      },
      {
        id: 'sat_ndr_1500',
        channel: 'NDR',
        shortChannel: 'NDR HD',
        track: 'sat',
        trackLabel: 'SAT HD',
        badge: 'SAT',
        title: 'Watzmann ermittelt',
        startTime: '14:30',
        endTime: '15:20',
        isLive: true,
        progressPct: 45,
        webUrl: 'https://www.ardmediathek.de/live',
        mediathekServiceId: 'ard',
      },
      {
        id: 'sky_atl_now',
        channel: 'Sky Atlantic',
        shortChannel: 'SKY ATLANTIC',
        track: 'sky',
        trackLabel: 'SKY · HDMI 3',
        badge: 'SKY',
        title: 'The Last of Us',
        startTime: '14:15',
        endTime: '15:15',
        isLive: true,
        progressPct: 60,
        tmdbId: 100088,
        mediaType: 'tv',
        rating: 8.6,
      },
    ],
    primetime: [
      {
        id: 'pay_kinowelt_1700',
        channel: 'Kinowelt TV',
        shortChannel: 'KINOWELT TV',
        track: 'sky',
        title: 'Malcom X',
        startTime: '17:00',
        isLive: false,
      },
      {
        id: 'sat_zdf_2220',
        channel: 'ZDF',
        shortChannel: 'ZDF HD',
        track: 'sat',
        title: 'Spätfilm',
        startTime: '22:20',
        isLive: false,
      },
      {
        id: 'sat_zdf_2015',
        channel: 'ZDF',
        shortChannel: 'ZDF HD',
        track: 'sat',
        title: 'Heute Journal Spezial',
        startTime: '20:15',
        isLive: false,
      },
      {
        id: 'sky_dune_2015',
        channel: 'Sky Cinema Premiere',
        shortChannel: 'SKY CINEMA',
        track: 'sky',
        title: 'Dune: Part Two',
        startTime: '20:15',
        isLive: false,
        tmdbId: 693134,
        mediaType: 'movie',
        rating: 8.2,
      },
    ],
    sport: [
      {
        id: 'sky_sport_live',
        channel: 'Sky Sport Bundesliga',
        shortChannel: 'SKY BUNDESLIGA',
        track: 'sky',
        title: '2. Bundesliga live',
        description: '17.11. · 14:00 Uhr · Konferenz',
        startTime: '14:00',
        endTime: '16:00',
        isLive: false,
        slot: 'sport',
      },
      {
        id: 'sky_sport_future',
        channel: 'Sky Sport Bundesliga',
        shortChannel: 'SKY BUNDESLIGA',
        track: 'sky',
        title: 'Bundesliga: Bayern – Köln',
        description: '20.11. · 20:30 Uhr · Live auf Sky Sport Bundesliga',
        startTime: '20:30',
        slot: 'sport',
      },
    ],
  };

  const berlin1440 = new Date('2026-11-17T13:40:00Z'); // 14:40 Europe/Berlin
  vm.runInContext(`
    items = [{ id: 'wl1', tmdbId: 693134, type: 'movie', title: 'Dune: Part Two', watched: false }];
    liveTvData = ${JSON.stringify(sampleLive)};
  `, ctx);

  const nowItems = ctx.buildLiveNowItems(sampleLive, berlin1440);
  const primeItems = ctx.buildPrimetimeItems(sampleLive, berlin1440);

  // Simulcast WDR+NDR wird auf 1 Eintrag dedupliziert; laufender Sport von heute landet in Live
  assert.equal(nowItems.filter((x) => x.title === 'Watzmann ermittelt').length, 1);
  assert.equal(nowItems.some((x) => x.title === '2. Bundesliga live'), true);
  assert.equal(nowItems.some((x) => x.title === 'Dune: Part Two'), false);

  // Kinowelt TV (17:00), ZDF (22:20) und Sport von einem anderen Datum (20.11.) sind raus; Dune (Watchlist) zuerst
  assert.equal(primeItems.some((x) => /kinowelt/i.test(x.channel) || x.title === 'Malcom X'), false);
  assert.equal(primeItems.some((x) => x.title === 'Spätfilm'), false);
  assert.equal(primeItems.some((x) => x.title.includes('Bayern')), false);
  assert.equal(primeItems[0].title, 'Dune: Part Two');

  ctx.updateViewCounts(berlin1440);
  assert.equal(ctx._getEl('tabLiveCount').textContent, String(nowItems.length));
  assert.equal(ctx._getEl('tabPrimeCount').textContent, String(primeItems.length));

  // Tab-Switch zwischen live, primetime und list + Spur-Filter + Trailer/Watchlist CTAs
  ctx.switchMainView('primetime');
  ctx.renderLiveView(berlin1440);
  const primeHtml = ctx._getEl('liveView').innerHTML;
  assert.equal(ctx._getEl('app').classList.contains('view-primetime'), true);
  assert.equal(ctx._getEl('tabLivePrime').getAttribute('aria-selected'), 'true');
  assert.match(primeHtml, /Heute ab 20:15 Uhr/);
  assert.match(primeHtml, /★ Watchlist/);
  assert.match(primeHtml, /▶ Trailer/);

  ctx.switchMainView('live');
  ctx.renderLiveView(berlin1440);
  const liveHtml = ctx._getEl('liveView').innerHTML;
  assert.equal(ctx._getEl('app').classList.contains('view-live'), true);
  assert.match(liveHtml, /Jetzt live im TV/);
  assert.match(liveHtml, /noch 80 Min\.|● LIVE/);
  assert.match(liveHtml, /ARD Livestream ↗|Sky Go öffnen ↗/);

  vm.runInContext(`activeLiveTrackFilter = 'sat'; renderLiveView(new Date('2026-11-17T13:40:00Z'));`, ctx);
  assert.doesNotMatch(ctx._getEl('liveView').innerHTML, /The Last of Us/);
  assert.match(ctx._getEl('liveView').innerHTML, /Watzmann ermittelt/);

  ctx.switchMainView('list');
  assert.equal(ctx._getEl('liveView').classList.contains('hidden'), true);
});

test('handleLivePrimaryAction routet Sky je nach Geraet (macOS skygo:// + Copy vs. iOS Web) und Magenta/Sat per Web-URL', () => {
  const macCtx = loadAppContext({ platform: 'MacIntel', maxTouchPoints: 0 });
  vm.runInContext(`
    handleLivePrimaryAction({
      id: 'sky1',
      channel: 'Sky Cinema Premiere',
      track: 'sky',
      title: 'The Last of Us',
      webUrl: 'https://www.sky.de/tvguide',
    });
  `, macCtx);
  assert.equal(macCtx._getCopiedText(), 'The Last of Us');
  assert.equal(macCtx.window.location.href, 'skygo://');
  assert.equal(macCtx._opens.length, 0);

  const iosCtx = loadAppContext({ platform: 'iPhone', maxTouchPoints: 5 });
  vm.runInContext(`
    handleLivePrimaryAction({
      id: 'sky1',
      channel: 'Sky Cinema Premiere',
      track: 'sky',
      title: 'The Last of Us',
      webUrl: 'https://www.sky.de/tvguide',
    });
    handleLivePrimaryAction({
      id: 'mag1',
      channel: 'RTL',
      track: 'magenta',
      title: 'Wer wird Millionär?',
      webUrl: 'https://web.magentatv.de/tv-guide',
    });
  `, iosCtx);
  assert.equal(iosCtx._opens.length, 2);
  assert.equal(iosCtx._opens[0].url, 'https://www.sky.de/tvguide');
  assert.equal(iosCtx._opens[1].url, 'https://web.magentatv.de/tv-guide');
});
