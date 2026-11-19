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

test('index.html, style.css und sw.js enthalten V1 4-Tab-Navigation und #liveView (v11-Cache)', () => {
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
  assert.match(SW_SRC, /CACHE_VERSION = 'v11'/);
});

test('buildLiveNowItems und buildPrimetimeItems filtern Sky raus, pinnen ARD #1 + ZDF #2 vor RTL/Sat.1/ProSieben und verlinken Direkt-Streams', () => {
  const ctx = loadAppContext({ platform: 'MacIntel', maxTouchPoints: 0 });
  const sampleLive = {
    ok: true,
    now: [
      {
        id: 'sat_wdr_1500',
        channel: 'WDR',
        shortChannel: 'WDR HD',
        track: 'sat',
        title: 'Watzmann ermittelt',
        startTime: '14:30',
        endTime: '15:20',
        isLive: true,
      },
      {
        id: 'sky_ssn_now',
        channel: 'Sky Sport News',
        shortChannel: 'SKY SPORT NEWS',
        track: 'sky',
        trackLabel: 'SKY · 200',
        badge: 'SKY',
        title: 'Sky Sport News Live',
        startTime: '14:00',
        endTime: '15:30',
        isLive: true,
        progressPct: 50,
        webUrl: 'https://www.sky.de/tvguide',
        mediathekServiceId: 'sky',
      },
      {
        id: 'mag_pro7_now',
        channel: 'ProSieben',
        shortChannel: 'PROSIEBEN',
        track: 'magenta',
        title: 'taff',
        startTime: '14:00',
        endTime: '15:00',
        isLive: true,
        progressPct: 40,
        imageUrl: 'https://example.test/p7.jpg',
        rating: 8.1,
      },
      {
        id: 'sat_zdf_now',
        channel: 'ZDF',
        shortChannel: 'ZDF HD',
        track: 'sat',
        title: 'heute',
        startTime: '14:00',
        endTime: '14:15',
        isLive: true,
        progressPct: 20,
      },
      {
        id: 'sat_ard_1430',
        channel: 'Das Erste',
        shortChannel: 'DAS ERSTE',
        track: 'sat',
        trackLabel: 'SAT HD',
        badge: 'SAT',
        title: 'Wer weiß denn sowas?',
        startTime: '14:30',
        endTime: '15:20',
        isLive: true,
        progressPct: 45,
        webUrl: 'https://www.ardmediathek.de/live',
        mediathekServiceId: 'ard',
      },
      {
        id: 'sky_cin_now',
        channel: 'Sky Cinema Premiere',
        shortChannel: 'SKY CINEMA',
        track: 'sky',
        title: 'Twisters',
        startTime: '14:15',
        endTime: '15:55',
        isLive: true,
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
        id: 'sat_3sat_2015',
        channel: '3sat',
        shortChannel: '3SAT HD',
        track: 'sat',
        title: 'Kulturzeit Extra',
        startTime: '20:15',
        isLive: false,
      },
      {
        id: 'mag_vox_2015',
        channel: 'VOX',
        shortChannel: 'VOX HD',
        track: 'magenta',
        title: 'Goodbye Deutschland',
        startTime: '20:15',
        isLive: false,
      },
      {
        id: 'sky_f1_2000',
        channel: 'Sky Sport F1',
        shortChannel: 'SKY SPORT F1',
        track: 'sky',
        trackLabel: 'SKY · 207',
        badge: 'SKY',
        title: 'Formel 1: Großer Preis der USA',
        startTime: '20:00',
        endTime: '22:00',
        isLive: false,
        webUrl: 'https://www.sky.de/tvguide',
        mediathekServiceId: 'sky',
      },
      {
        id: 'mag_rtl_2015',
        channel: 'RTL',
        shortChannel: 'RTL HD',
        track: 'magenta',
        trackLabel: 'MAGENTA HD',
        badge: 'MAGENTA',
        title: 'Wer wird Millionär?',
        startTime: '20:15',
        endTime: '22:15',
        isLive: false,
        webUrl: 'https://web.magentatv.de/tv-guide',
      },
      {
        id: 'mag_sat1_2015',
        channel: 'Sat.1',
        shortChannel: 'SAT.1 HD',
        track: 'magenta',
        title: 'Navy CIS',
        startTime: '20:15',
        endTime: '21:15',
        isLive: false,
        tmdbId: 4614,
        mediaType: 'tv',
        rating: 7.6,
      },
      {
        id: 'sat_zdf_2015',
        channel: 'ZDF',
        shortChannel: 'ZDF HD',
        track: 'sat',
        title: 'Die Geschichte der Deutschen',
        startTime: '20:15',
        endTime: '21:00',
        isLive: false,
      },
      {
        id: 'sat_ard_2015',
        channel: 'Das Erste',
        shortChannel: 'DAS ERSTE',
        track: 'sat',
        trackLabel: 'SAT HD',
        badge: 'SAT',
        title: 'Die Kanzlei',
        startTime: '20:15',
        endTime: '21:00',
        isLive: false,
        tmdbId: 65432,
        mediaType: 'tv',
        rating: 7.4,
        webUrl: 'https://www.ardmediathek.de/live',
        mediathekServiceId: 'ard',
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
    items = [{ id: 'wl1', tmdbId: 4614, type: 'tv', title: 'Navy CIS', watched: false }];
    liveTvData = ${JSON.stringify(sampleLive)};
  `, ctx);

  const nowItems = ctx.buildLiveNowItems(sampleLive, berlin1440);
  const primeItems = ctx.buildPrimetimeItems(sampleLive, berlin1440);

  // WDR, Sky Cinema Premiere und alle Sky Sport Sender sind raus; ARD #1 und ZDF #2 IMMER ganz vorne vor RTL/Sat.1/ProSieben!
  assert.equal(nowItems.some((x) => x.channel === 'WDR' || /sky/i.test(x.channel)), false);
  assert.equal(nowItems[0].channel, 'Das Erste');
  assert.equal(nowItems[1].channel, 'ZDF');
  assert.equal(nowItems[2].channel, 'ProSieben');
  assert.equal(nowItems.some((x) => x.title === '2. Bundesliga live'), false);

  // 20:15: 3sat, VOX, Kinowelt, Sky Sport F1, ZDF 22:20 und Sport sind raus; Reihenfolge ARD #1, ZDF #2, RTL #3, Sat.1 #4!
  assert.equal(primeItems.some((x) => /3sat|vox|kinowelt|sky/i.test(x.channel)), false);
  assert.equal(primeItems.some((x) => x.title === 'Spätfilm' || x.title.includes('Bayern')), false);
  assert.equal(primeItems[0].channel, 'Das Erste');
  assert.equal(primeItems[1].channel, 'ZDF');
  assert.equal(primeItems[2].channel, 'RTL');
  assert.equal(primeItems[3].channel, 'Sat.1');

  ctx.updateViewCounts(berlin1440);
  assert.equal(ctx._getEl('tabLiveCount').textContent, String(nowItems.length));
  assert.equal(ctx._getEl('tabPrimeCount').textContent, String(primeItems.length));

  // macOS Desktop: echte Direkt-Links (ARD CRID, ZDF, RTL+, Joyn) ohne Sky Sport oder skygo:// in BEIDEN Live-Tabs
  ctx.switchMainView('primetime');
  ctx.renderLiveView(berlin1440);
  const primeHtml = ctx._getEl('liveView').innerHTML;
  assert.equal(ctx._getEl('app').classList.contains('view-primetime'), true);
  assert.equal(ctx._getEl('tabLivePrime').getAttribute('aria-selected'), 'true');
  assert.match(primeHtml, /Heute ab 20:15 Uhr/);
  assert.match(primeHtml, /★ Watchlist/);
  assert.match(primeHtml, /▶ Trailer/);
  assert.match(primeHtml, /href="https:\/\/www\.ardmediathek\.de\/live\/Y3JpZDovL2Rhc2Vyc3Rl/);
  assert.match(primeHtml, /href="https:\/\/www\.zdf\.de\/live-tv"/);
  assert.match(primeHtml, /href="https:\/\/plus\.rtl\.de\/rtl\/live"[^>]*>▶ RTL\+ Live ↗<\/a>/);
  assert.match(primeHtml, /href="https:\/\/www\.joyn\.de\/play\/live-tv\?channel_id=139"[^>]*>JOYN ↗<\/a>/);
  assert.doesNotMatch(primeHtml, /Sky Sport/);
  assert.doesNotMatch(primeHtml, /skygo:\/\//);

  ctx.switchMainView('live');
  ctx.renderLiveView(berlin1440);
  const liveHtml = ctx._getEl('liveView').innerHTML;
  assert.equal(ctx._getEl('app').classList.contains('view-live'), true);
  assert.match(liveHtml, /Jetzt live im TV/);
  assert.doesNotMatch(liveHtml, /Sky Sport/);
  assert.doesNotMatch(liveHtml, /skygo:\/\//);
  assert.match(liveHtml, /href="https:\/\/www\.ardmediathek\.de\/live\/Y3JpZDovL2Rhc2Vyc3Rl[^>]*>▶ Das Erste Live ↗<\/a>/);
  assert.match(liveHtml, /href="https:\/\/www\.zdf\.de\/live-tv"[^>]*>▶ ZDF Live ↗<\/a>/);
  assert.match(liveHtml, /href="https:\/\/www\.joyn\.de\/play\/live-tv\?channel_id=138"[^>]*>▶ ProSieben Live \(Joyn\) ↗<\/a>/);

  // Spur-Filter hat genau Alle, ARD & ZDF sowie RTL+ & Joyn (ohne Sky Sport)
  assert.match(liveHtml, /ARD &amp; ZDF/);
  assert.match(liveHtml, /RTL\+ &amp; Joyn/);
  assert.doesNotMatch(liveHtml, /data-live-track="sky"/);
  vm.runInContext(`activeLiveTrackFilter = 'sat'; renderLiveView(new Date('2026-11-17T13:40:00Z'));`, ctx);
  assert.doesNotMatch(ctx._getEl('liveView').innerHTML, /ProSieben/);
  assert.match(ctx._getEl('liveView').innerHTML, /Wer weiß denn sowas\?/);

  // Veralteter 'sky'-Trackfilter faellt sauber auf 'all' zurueck
  vm.runInContext(`activeLiveTrackFilter = 'sky'; renderLiveView(new Date('2026-11-17T13:40:00Z'));`, ctx);
  assert.match(ctx._getEl('liveView').innerHTML, /Wer weiß denn sowas\?/);
  assert.match(ctx._getEl('liveView').innerHTML, /taff/);

  // iPhone/iOS zeigt ebenfalls nur Direkt-Streams ohne Sky Sport
  const iosCtx = loadAppContext({ platform: 'iPhone', maxTouchPoints: 5 });
  vm.runInContext(`liveTvData = ${JSON.stringify(sampleLive)}; switchMainView('live'); renderLiveView(new Date('2026-11-17T13:40:00Z'));`, iosCtx);
  const iosHtml = iosCtx._getEl('liveView').innerHTML;
  assert.doesNotMatch(iosHtml, /Sky Sport/);
  assert.doesNotMatch(iosHtml, /href="skygo:\/\/"/);
  assert.match(iosHtml, /https:\/\/www\.joyn\.de\/play\/live-tv\?channel_id=138/);

  ctx.switchMainView('list');
  assert.equal(ctx._getEl('liveView').classList.contains('hidden'), true);
});

test('handleLivePrimaryAction routet RTL+/Joyn direkt und openMagazineItemDetail behaelt Sky Go auf macOS', () => {
  const macCtx = loadAppContext({ platform: 'MacIntel', maxTouchPoints: 0 });
  // Magazin-Detail (✦ Fuer dich) rendert auf macOS bei Sky weiterhin nativen skygo://-Anchor
  vm.runInContext(`
    magazine = {
      sections: [{ id: 'neu', items: [{ key: 'm1', tmdb_id: 99, type: 'movie', title: 'Sky Exclusiv Film', providers_app: ['sky'] }] }],
    };
    openMagazineItemDetail('m1');
  `, macCtx);
  assert.match(macCtx._getEl('magazineModalBody').innerHTML, /<a class="btn-primary-cta" href="skygo:\/\/" data-sky-copy="Sky Exclusiv Film"/);

  const iosCtx = loadAppContext({ platform: 'iPhone', maxTouchPoints: 5 });
  vm.runInContext(`
    magazine = {
      sections: [{ id: 'neu', items: [{ key: 'm1', tmdb_id: 99, type: 'movie', title: 'Sky Exclusiv Film', providers_app: ['sky'] }] }],
    };
    openMagazineItemDetail('m1');
    handleLivePrimaryAction({
      id: 'mag1',
      channel: 'RTL',
      track: 'magenta',
      title: 'Wer wird Millionär?',
      webUrl: 'https://web.magentatv.de/tv-guide',
    });
    handleLivePrimaryAction({
      id: 'mag2',
      channel: 'Sat.1',
      track: 'magenta',
      title: 'Navy CIS',
    });
  `, iosCtx);
  const iosMagHtml = iosCtx._getEl('magazineModalBody').innerHTML;
  assert.doesNotMatch(iosMagHtml, /sky\.de\/suche/);
  assert.doesNotMatch(iosMagHtml, /skygo:\/\//);
  assert.match(iosMagHtml, /Trailer ansehen/);
  assert.equal(iosCtx._opens.length, 2);
  assert.equal(iosCtx._opens[0].url, 'https://plus.rtl.de/rtl/live');
  assert.equal(iosCtx._opens[1].url, 'https://www.joyn.de/play/live-tv?channel_id=139');
});
