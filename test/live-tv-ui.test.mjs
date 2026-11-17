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
    'app', 'watchlist', 'shortlistSection', 'shortlistTrack', 'liveBandSection',
    'liveBandTrack', 'liveBandMeta', 'liveTvModal', 'liveTvSheetBody',
    'liveSheetFilters', 'btnOpenLiveSheet', 'liveTvClose', 'emptyState',
    'loadingState', 'filterBar', 'pillFilter', 'pillFilterValue', 'pillWoche',
    'pillWocheLabel', 'pillWocheValue', 'tabList', 'tabDiscover', 'tabListCount',
    'tabDiscoverCount', 'discoverView', 'filterModal', 'magazineModal',
    'magazineModalBody', 'trailerModal', 'seenSection', 'seenBar', 'seenCount',
    'seenGrid', 'addModal', 'detailModal', 'pinModal', 'syncModal',
    'syncKeyInput', 'syncKeyError', 'btnSyncKey', 'btnEmptySyncKey',
    'btnSyncShare', 'btnSyncCopyUrl', 'searchInput', 'searchClear',
    'searchResults', 'serviceSelect', 'selectedTitle', 'serviceGrid', 'btnSave',
    'btnAdd', 'modalClose', 'filterClose', 'magazineModalClose', 'pinCancel',
  ].forEach(getEl);

  const opens = [];
  const toasts = [];
  let copiedText = '';
  const loc = {
    origin: 'https://escholly-ship-it.github.io',
    pathname: '/watchlist/',
    search: '?key=TESTKEY1',
    href: 'https://escholly-ship-it.github.io/watchlist/?key=TESTKEY1',
  };
  const storage = new Map();

  const context = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
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

test('index.html, style.css und sw.js enthalten das Live-TV-Band, Sheet und v6-Cache', () => {
  assert.match(HTML_SRC, /id="liveBandSection"/);
  assert.match(HTML_SRC, /id="liveBandTrack"/);
  assert.match(HTML_SRC, /id="btnOpenLiveSheet"/);
  assert.match(HTML_SRC, /id="liveTvModal"/);
  assert.match(HTML_SRC, /data-live-filter="sat"/);
  assert.match(HTML_SRC, /data-live-filter="magenta"/);
  assert.match(HTML_SRC, /data-live-filter="sky"/);
  assert.match(CSS_SRC, /\.live-band-section/);
  assert.match(CSS_SRC, /#app\.view-discover #liveBandSection/);
  assert.match(SW_SRC, /CACHE_VERSION = 'v6'/);
});

test('renderLiveBand sortiert Watchlist-Treffer an erste Stelle und switchMainView blendet im Discover-Tab aus', () => {
  const ctx = loadAppContext();
  const sampleLive = {
    ok: true,
    spotlight: [
      {
        id: 'sat_zdf_2015',
        channel: 'ZDF',
        shortChannel: 'ZDF HD',
        track: 'sat',
        trackLabel: 'SAT HD',
        badge: 'SAT',
        title: 'Heute Journal Spezial',
        startTime: '20:15',
        isLive: false,
        progressPct: 0,
        webUrl: 'https://www.zdf.de/live-tv',
        tmdbId: null,
        mediaType: null,
      },
      {
        id: 'sky_dune_2015',
        channel: 'Sky Cinema Premiere',
        shortChannel: 'SKY CINEMA',
        track: 'sky',
        trackLabel: 'SKY · HDMI 3',
        badge: 'SKY',
        title: 'Dune: Part Two',
        startTime: '20:15',
        isLive: false,
        progressPct: 0,
        webUrl: 'https://www.sky.de/tvguide',
        tmdbId: 693134,
        mediaType: 'movie',
        rating: 8.2,
      },
    ],
    now: [],
    primetime: [],
    sport: [],
  };

  vm.runInContext(`
    items = [{ id: 'wl1', tmdbId: 693134, type: 'movie', title: 'Dune: Part Two', watched: false }];
    liveTvData = ${JSON.stringify(sampleLive)};
    renderLiveBand();
  `, ctx);

  const trackHtml = ctx._getEl('liveBandTrack').innerHTML;
  const bandSec = ctx._getEl('liveBandSection');
  assert.equal(bandSec.classList.contains('hidden'), false);
  assert.match(trackHtml, /★ Watchlist/);
  assert.ok(
    trackHtml.indexOf('Dune: Part Two') < trackHtml.indexOf('Heute Journal Spezial'),
    'Watchlist match should be ordered before non-matched live broadcast',
  );
  assert.match(ctx._getEl('liveBandMeta').textContent, /1× Watchlist/);

  ctx.switchMainView('discover');
  assert.equal(bandSec.classList.contains('hidden'), true);
  ctx.switchMainView('list');
  assert.equal(bandSec.classList.contains('hidden'), false);
});

test('handleLivePrimaryAction routet Sky je nach Geraet (macOS skygo:// + Copy vs. iOS Web) und Magenta/Sat per Web-URL', () => {
  const macCtx = loadAppContext({ platform: 'MacIntel', maxTouchPoints: 0 });
  vm.runInContext(`
    handleLivePrimaryAction({
      id: 'sky1',
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
      track: 'sky',
      title: 'The Last of Us',
      webUrl: 'https://www.sky.de/tvguide',
    });
    handleLivePrimaryAction({
      id: 'mag1',
      track: 'magenta',
      title: 'Wer wird Millionär?',
      webUrl: 'https://web.magentatv.de/tv-guide',
    });
  `, iosCtx);
  assert.equal(iosCtx._opens.length, 2);
  assert.equal(iosCtx._opens[0].url, 'https://www.sky.de/tvguide');
  assert.equal(iosCtx._opens[1].url, 'https://web.magentatv.de/tv-guide');
});
