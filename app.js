/* ============================================
   WATCHLIST — App Logic (v2: auto-providers)
   ============================================ */

// ---- Configuration ----
// WL-27: TMDB nur noch ueber den Worker — kein Schluessel im Browser.
const WORKER_BASE = 'https://watchlist-sync.escholly.workers.dev';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const STORAGE_KEY = 'watchlist_items';
// WL-33: Loesch-Marker und Markierung "ungesendet" fuer den Sync
const DELETED_KEY = 'watchlist_deleted';
const UNSENT_KEY = 'watchlist_unsent';
const WATCH_REGION = 'DE';

// ---- Sync Configuration ----
/**
 * @design SYNC_KEY: Bewusst URL-exponiertes Bearer-Token, kein httpOnly-Cookie.
 * Begruendung: Share-URL-Pattern ('?key=...'), niedrig-sensible Daten (nur
 * Watchlist-Filmtitel, kein PII/Finance). httpOnly-Cookie-Migration wuerde
 * Share-Pattern brechen. localStorage-Persistenz nur als UX-Fallback fuer
 * iOS-Homescreen-Bookmarks.
 * Cross-Ref: Sprint 304 sessionStorage-Audit (4 SYNC_KEY-Hits), Sprint 305 WL-8.
 */
const SYNC_URL = `${WORKER_BASE}/sync`;

// WL-39: jeder Netzaufruf der App bekommt eine Zeitgrenze. Bei Ablauf wirft
// fetchT einen Fehler mit kind 'timeout'; andere Netzfehler tragen kind 'error'.
const FETCH_TIMEOUT_MS = 8000;
async function fetchT(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    err.kind = timedOut ? 'timeout' : 'error';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
let syncStatus = 'idle'; // idle | syncing | synced | error

// Read sync key from URL: ?key=KEY (query param) or #sync=KEY (legacy hash)
// Query params survive iOS homescreen bookmarks; hash fragments don't.
function getSyncKey() {
  // 1. Check query parameter (?key=KEY) — primary method
  const params = new URLSearchParams(window.location.search);
  const qKey = params.get('key');
  if (qKey) return qKey;

  // 2. Check hash fragment (#sync=KEY) — legacy/backward compat
  const hash = window.location.hash;
  const match = hash.match(/sync=([^&]+)/);
  if (match) return match[1];

  // 3. Fallback to localStorage
  return lsGet('watchlist_sync_key');
}
// WL-41: localStorage kann werfen (Safari privat, Speicher voll) — Schreiben
// darf das Speichern/Senden nie abbrechen, Lesen faellt auf null zurueck.
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function lsRemove(key) { try { localStorage.removeItem(key); } catch (_) {} }

let SYNC_KEY = getSyncKey();
let SYNC_ENABLED = !!SYNC_KEY;

// Persist key to localStorage as backup
if (SYNC_KEY) {
  lsSet('watchlist_sync_key', SYNC_KEY);
}

// Extract key from either a raw key string or a full URL (?key=... or #sync=...)
function parseInputSyncKey(raw) {
  const val = (raw || '').trim();
  if (!val) return '';
  try {
    if (val.includes('?') || val.includes('#') || val.startsWith('http')) {
      const u = new URL(val, window.location.origin);
      const qKey = u.searchParams.get('key');
      if (qKey) return qKey.trim();
      const match = (u.hash || '').match(/sync=([^&]+)/);
      if (match) return match[1].trim();
    }
  } catch (_) {}
  const qMatch = val.match(/[?&]key=([^&#\s]+)/);
  if (qMatch) return decodeURIComponent(qMatch[1]);
  const hMatch = val.match(/sync=([^&#\s]+)/);
  if (hMatch) return decodeURIComponent(hMatch[1]);
  return val;
}

function generateRandomSyncKey() {
  const arr = new Uint8Array(20);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Streaming Services with TMDB provider IDs ----
// WL-24 (2026-08-14): logo = TMDB logo_path (Quelle /watch/providers, Region DE,
// gemessen 2026-08-14). Sky zeigt bewusst das Sky-Go-Logo (Customer hat Sky Go;
// die Erkennung fasst WOW=30 + Sky Go=29 weiter unter 'sky' zusammen).
// WL-28 (2026-09-28): IDs neu gemessen (/watch/providers, watch_region=DE):
// Sky nur noch Sky Go 29 (WOW 30 zaehlt nicht, Customer hat Sky Go); ARTE 234,
// 3sat 2211, KiKA 2081 neu als freie Mediatheken (free: true); ungemessene
// Alt-IDs 119/384/536 und SkyShowtime 1773 raus. Spiegel der Worker-Liste
// AVAILABILITY_SERVICES — dort wird entschieden, hier nur angezeigt.
// RTL: [2750] ist die heutige RTL+-ID (Gratis-Stufe traegt dieselbe ID via
// ads-Merge); die frueheren 298/1771 sind stale — 1771 gehoert heute Takflix
// (Falsch-Positiv-Risiko). Amazon-Channel-Varianten bewusst nicht gemappt.
const SERVICES = [
  { id: 'netflix',   name: 'Netflix',     color: '#e50914', tmdbIds: [8, 1796],     logo: '/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg' },
  { id: 'prime',     name: 'Prime Video', color: '#00a8e1', tmdbIds: [9, 2100],     logo: '/pvske1MyAoymrs5bguRfVqYiM9a.jpg' },
  { id: 'disney',    name: 'Disney+',     color: '#113ccf', tmdbIds: [337],         logo: '/97yvRBw1GzX7fXprcF80er19ot.jpg' },
  { id: 'apple',     name: 'Apple TV+',   color: '#555',    tmdbIds: [350],         logo: '/mcbz1LgtErU9p4UdbZ0rG6RTWHX.jpg' },
  { id: 'sky',       name: 'Sky',         color: '#002f5f', tmdbIds: [29],          logo: '/vDdk3LyjWkYlfCtkrhkjFKFK1Hg.jpg' },
  { id: 'hbo',       name: 'HBO Max',     color: '#b91ad1', tmdbIds: [1899],        logo: '/jbe4gVSfRlbPTdESXhEKpornsfu.jpg' },
  { id: 'paramount', name: 'Paramount+',  color: '#0064ff', tmdbIds: [531],         logo: '/h5DcR0J2EESLitnhR8xLG1QymTE.jpg' },
  { id: 'magenta',   name: 'Magenta TV',  color: '#e20074', tmdbIds: [178],         logo: '/nCsFBTEmlCMc5NA4fwPuluTz6AO.jpg' },
  { id: 'joyn',      name: 'Joyn',        color: '#169b62', tmdbIds: [304, 421],    logo: '/3tKojIkk9QpkDUeU8HgpHQ9Jb2v.jpg' },
  { id: 'ard',       name: 'ARD',         color: '#004e8a', tmdbIds: [219],         logo: '/avItehPq07h5nKCJgwNTxl6OD0y.jpg', free: true },
  { id: 'zdf',       name: 'ZDF',         color: '#fa7d19', tmdbIds: [537],         logo: '/ugus0p8BGGhE8sxhwAjJz2o8jyy.jpg', free: true },
  { id: 'rtl',       name: 'RTL+',        color: '#e3001b', tmdbIds: [2750],        logo: '/acZuR8b9gDqMQnNFoNn82NYk72X.jpg' },
  { id: 'arte',      name: 'ARTE',        color: '#fa4b19', tmdbIds: [234],         logo: '/ieo2l4zOaljYqJNGxWY8jWryld5.png', free: true },
  { id: '3sat',      name: '3sat',        color: '#c8102e', tmdbIds: [2211],        logo: '/8JXyCxapBAF4lnsFmEKDkay60u9.png', free: true },
  { id: 'kika',      name: 'KiKA',        color: '#6cb33f', tmdbIds: [2081],        logo: '/duwuE5tiQeoLsFEAVWUTwpfnBJw.png', free: true },
];

// WL-30: Kopie der Such-Vorlagen aus worker/src/index.js (AVAILABILITY_SERVICES[].search).
// Gebraucht nur fuer einen von Hand gesetzten Dienst, zu dem der Worker keinen Link
// liefert (TMDB kennt dort kein Angebot). Aendert sich eine Vorlage im Worker: hier nachziehen.
const SERVICE_SEARCH = {
  arte: 'https://www.arte.tv/de/search/?q={q}',
  ard: 'https://www.ardmediathek.de/suche/{q}',
  zdf: 'https://www.zdf.de/suche?q={q}',
  '3sat': 'https://www.3sat.de/suche?q={q}',
  kika: 'https://www.kika.de/suche?q={q}',
  netflix: 'https://www.netflix.com/search?q={q}',
  prime: 'https://www.primevideo.com/search/ref=atv_nb_sug?phrase={q}',
  disney: 'https://www.disneyplus.com/de-de/browse/search',
  apple: 'https://tv.apple.com/de/search?term={q}',
  sky: 'https://www.sky.de/suche?query={q}',
  hbo: 'https://play.hbomax.com/search',
  paramount: 'https://www.paramountplus.com/de/search/',
  magenta: 'https://web.magentatv.de/suche/vod_more_web/{q}',
  joyn: 'https://www.joyn.de/suche?q={q}',
  rtl: 'https://plus.rtl.de/suche?query={q}',
};

// WL-30: von Hand gesetzter Dienst ("Ich sehe es bei …"). Feld pinnedServiceId im
// Item, laeuft mit dem Sync; aeltere Clients lassen es stehen. Unbekannte IDs zaehlen nicht.
function pinnedService(item) {
  const id = item && item.pinnedServiceId;
  return id && SERVICES.some(s => s.id === id) ? id : null;
}

const PIN_ICON = '<svg class="pin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 6 4 4H6l4-4z"/><line x1="12" y1="13" x2="12" y2="21"/></svg>';

// WL-24: eine Quelle fuer den Anbieter-Marker auf Karten — Logo-Kachel,
// bei fehlendem Logo direkt der Text-Badge.
function svcMarkerHtml(svc) {
  if (!svc) return '';
  if (svc.logo) {
    return `<img class="service-logo" src="${tmdbPoster(svc.logo, 'w92')}" alt="${escAttr(svc.name)}" data-svc="${svc.id}" onerror="svcLogoFallback(this)">`;
  }
  return `<div class="service-badge" style="background:${svc.color};color:${badgeTextColor(svc.color)}">${esc(svc.name)}</div>`;
}

// WL-24: laedt ein Logo nicht (CDN-Ausfall/offline-Cache), ersetzt der
// Fallback das Bild durch den netzlosen Text-Badge — nie ein Bruchbild.
function svcLogoFallback(img) {
  const svc = SERVICES.find(s => s.id === img.dataset.svc);
  if (!svc) { img.remove(); return; }
  const badge = document.createElement('div');
  badge.className = 'service-badge';
  badge.style.background = svc.color;
  badge.style.color = badgeTextColor(svc.color);
  badge.textContent = svc.name;
  img.replaceWith(badge);
}

// WL-25: Inline-Logo NEBEN dem Namen (dekorativ — der Name traegt die
// Information, daher alt="" + aria-hidden). Eine Quelle fuer alle Flaechen:
// Filter-Chips, Detail-Badge, "Im Abo verfuegbar", Add-Flow.
function svcInlineLogoHtml(svc, cls = '') {
  if (!svc || !svc.logo) return '';
  return `<img class="svc-inline-logo${cls ? ' ' + cls : ''}" src="${tmdbPoster(svc.logo, 'w92')}" alt="" aria-hidden="true" data-svc="${svc.id}" onerror="svcInlineLogoFallback(this)">`;
}

// WL-25: stellt bei Ladefehler den Vor-Logo-Zustand AKTIV wieder her —
// der Chip bekommt seinen Marken-Punkt zurueck (has-logo weg), die
// Detail-Badges ihre Markenfarben (with-logo weg + Inline-Style, Nicht-
// Current behaelt seine 0.7-Deckkraft via is-current-Marker), der
// service-btn braucht nur die img-Entfernung (Name + --svc-color bleiben).
function svcInlineLogoFallback(img) {
  const svc = SERVICES.find(s => s.id === img.dataset.svc);
  const host = img.closest('.service-chip, .detail-service-badge, .detail-provider-badge, .service-btn');
  if (host && svc) {
    if (host.classList.contains('service-chip')) {
      host.classList.remove('has-logo');
    } else if (host.classList.contains('detail-service-badge') || host.classList.contains('detail-provider-badge')) {
      host.classList.remove('with-logo');
      host.style.background = svc.color;
      if (host.classList.contains('detail-provider-badge') && !host.classList.contains('is-current')) {
        host.style.opacity = '0.7';
      } else {
        host.style.color = badgeTextColor(svc.color);
      }
    }
  }
  img.remove();
}

// WL-25: eine Quelle fuer das Detail-Anbieter-Badge (Erst-Render UND
// Promote-Update) — mit Logo neutrale Pille, ohne Logo (heute unerreichbar,
// Vorsorge) die bisherige Farb-Pille.
function detailServiceBadgeHtml(svc) {
  if (!svc) return '';
  return svc.logo
    ? `<div class="detail-service-badge with-logo">${svcInlineLogoHtml(svc, 'lg')}${esc(svc.name)}</div>`
    : `<div class="detail-service-badge" style="background:${svc.color};color:${badgeTextColor(svc.color)}">${esc(svc.name)}</div>`;
}


// ---- Sanitize (XSS protection) ----
// esc(): Text-Kontext (innerHTML zwischen Tags) — escaped &<>.
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// WL-21: escAttr() für Attribut-Werte in doppelt-gequoteten Attributen
// (alt/aria-label/data-*/src). esc() escaped NICHT " oder ' → ein Wert mit
// ASCII-" bräche das Attribut. escAttr ergänzt "→&quot; + '→&#39;.
function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- A11y: WCAG-konforme Text-Farbe (dunkel/hell) fuer solide Badges ----
function badgeTextColor(hex){
  const c=(hex||'').replace('#','');
  const f=c.length===3?c.split('').map(x=>x+x).join(''):c;
  if(f.length<6) return '#fff';
  const lin=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
  const L=0.2126*lin(parseInt(f.substr(0,2),16))+0.7152*lin(parseInt(f.substr(2,2),16))+0.0722*lin(parseInt(f.substr(4,2),16));
  return L>0.18?'#0b1326':'#fff';
}

// ---- State ----
let items = [];
// WL-33: Loesch-Marker (sync-merge.js) — nie angezeigt, nur fuer den Sync
let deletedItems = [];
let activeFilter = 'all';
let activeService = null;
let activeSort = 'added';
let selectedTmdb = null;
let selectedService = null;
let availableServices = [];
let searchTimeout = null;
let searchSeq = 0;  // WL-41: nur die juengste Suchanfrage darf rendern

const SHORTLIST_MAX = 5;

// ---- DOM ----
const $app = document.getElementById('app');
const $watchlist = document.getElementById('watchlist');
const $shortlistSection = document.getElementById('shortlistSection');
const $shortlistTrack = document.getElementById('shortlistTrack');
const $emptyState = document.getElementById('emptyState');
const $loadingState = document.getElementById('loadingState');
const $filterBar = document.getElementById('filterBar');
// WL-23 + V1 4-Tab-Navigation (Meine Liste | Für dich | Live | 20:15)
const $pillFilter = document.getElementById('pillFilter');
const $pillFilterValue = document.getElementById('pillFilterValue');
const $pillWoche = document.getElementById('pillWoche');
const $pillWocheLabel = document.getElementById('pillWocheLabel');
const $pillWocheValue = document.getElementById('pillWocheValue');
const $tabList = document.getElementById('tabList');
const $tabDiscover = document.getElementById('tabDiscover');
const $tabLiveNow = document.getElementById('tabLiveNow');
const $tabLivePrime = document.getElementById('tabLivePrime');
const $tabListCount = document.getElementById('tabListCount');
const $tabDiscoverCount = document.getElementById('tabDiscoverCount');
const $tabLiveCount = document.getElementById('tabLiveCount');
const $tabPrimeCount = document.getElementById('tabPrimeCount');
const $discoverView = document.getElementById('discoverView');
const $liveView = document.getElementById('liveView');
const $filterModal = document.getElementById('filterModal');
const $magazineModal = document.getElementById('magazineModal');
const $magazineModalBody = document.getElementById('magazineModalBody');
const $trailerModal = document.getElementById('trailerModal');
const $seenSection = document.getElementById('seenSection');
const $seenBar = document.getElementById('seenBar');
const $seenCount = document.getElementById('seenCount');
const $seenGrid = document.getElementById('seenGrid');

// WL-23: UI-Zustand nur lokal je Geraet — bewusst NICHT im Sync
// (pushToServer serialisiert ausschliesslich { items }).
const UI_KEY = 'watchlist_ui';
function loadUiState() {
  try {
    return { seenOpen: false, ...JSON.parse(lsGet(UI_KEY) || '{}') };
  } catch (_) {
    return { seenOpen: false };
  }
}
let uiState = loadUiState();
function saveUiState() {
  lsSet(UI_KEY, JSON.stringify(uiState));
}
const $addModal = document.getElementById('addModal');
const $detailModal = document.getElementById('detailModal');
const $pinModal = document.getElementById('pinModal');
const $syncModal = document.getElementById('syncModal');
const $syncKeyInput = document.getElementById('syncKeyInput');
const $syncKeyError = document.getElementById('syncKeyError');
const $btnSyncKey = document.getElementById('btnSyncKey');
const $btnEmptySyncKey = document.getElementById('btnEmptySyncKey');
const $btnSyncShare = document.getElementById('btnSyncShare');
const $btnSyncCopyUrl = document.getElementById('btnSyncCopyUrl');
const $searchInput = document.getElementById('searchInput');
const $searchClear = document.getElementById('searchClear');
const $searchResults = document.getElementById('searchResults');
const $serviceSelect = document.getElementById('serviceSelect');
const $selectedTitle = document.getElementById('selectedTitle');
const $serviceGrid = document.getElementById('serviceGrid');
const $btnSave = document.getElementById('btnSave');

// ---- A11y: Overlay-Fokus-Management (Focus-Trap + inert + Fokus-Restore) ----
let lastFocused = null;
const _trapHandlers = new WeakMap(); // overlayEl -> keydown handler (for clean removal)

// Overlay oeffnen: Hintergrund inert, Trap-Listener registrieren, Fokus setzen.
function openOverlay(overlayEl, focusTarget){
  lastFocused = document.activeElement;
  setBackgroundInert(true);
  const handler = (e) => trapTab(e, overlayEl);
  _trapHandlers.set(overlayEl, handler);
  overlayEl.addEventListener('keydown', handler);
  if(focusTarget) setTimeout(() => { try { focusTarget(); } catch(_){} }, 0);
}

// Overlay schliessen: inert weg, Trap-Listener entfernen, Fokus zuruecksetzen.
// restoreFocus=false fuer Uebergaenge Overlay->Overlay (WL-23: Woche->Reader),
// sonst reisst die Rueckgabe den Fokus in das gerade geschlossene Overlay.
function closeOverlay(overlayEl, restoreFocus = true){
  setBackgroundInert(false);
  const handler = _trapHandlers.get(overlayEl);
  if(handler){ overlayEl.removeEventListener('keydown', handler); _trapHandlers.delete(overlayEl); }
  if(restoreFocus && lastFocused && typeof lastFocused.focus === 'function'){ lastFocused.focus(); }
  lastFocused = null;
}

function setBackgroundInert(on){
  document.querySelectorAll('#app > header, #app > #pillRow, #app > #discoverView, #app > #liveView, #app > #shortlistSection, #app > #watchlist, #app > #seenSection').forEach(el => { if(on) el.setAttribute('inert',''); else el.removeAttribute('inert'); });
}

function focusables(root){
  return [...root.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null || el === document.activeElement);
}

function trapTab(e, root){
  if(e.key !== 'Tab') return;
  const f = focusables(root); if(!f.length) return;
  const first = f[0], last = f[f.length-1];
  if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
}

// ---- Init ----
async function init() {
  registerServiceWorker();
  setupOfflineAndInstallUi();
  loadItemsLocal();
  updateSyncKeyUi();
  firstSyncPending = SYNC_ENABLED && items.length === 0;
  renderFilterBar();
  renderShortlist();
  renderWatchlist();
  bindEvents();
  // WL-41: Magazin & Live-TV parallel zu Pull und Neupruefung holen (unabhaengig von der Liste)
  const magazineReady = fetchMagazine();
  const liveTvReady = fetchLiveTv();
  // Sync from server (non-blocking)
  const pulled = await pullFromServer();
  if (typeof updateViewCounts === 'function') updateViewCounts();
  // WL-28: Neupruefung nur nach erfolgreichem Pull — sonst wuerde der Push der
  // Neupruefung den Server-Stand mit der alten lokalen Liste ueberschreiben.
  if (pulled) await resolveVorgemerkt();
  // Check for auto-add URL parameter (?add=tmdbId&type=movie)
  const autoAdd = getAutoAddParams();
  if (autoAdd.tmdbId && autoAdd.mediaType) {
    await handleAutoAdd(autoAdd.tmdbId, autoAdd.mediaType);
  }
  // Wochen-Magazin (WL-5; WL-23: Pille statt Teaser im Fluss)
  await magazineReady;
  renderMagazinePill();
  maybeAutoOpenMagazine();
}

function updateSyncKeyUi() {
  if ($btnSyncKey) {
    $btnSyncKey.classList.toggle('has-key', SYNC_ENABLED);
    $btnSyncKey.title = SYNC_ENABLED ? 'Sync-Key aktiv (klicken zum Anzeigen/Ändern)' : 'Kein Sync-Key gesetzt — hier eingeben';
  }
  if ($btnEmptySyncKey) {
    $btnEmptySyncKey.classList.toggle('hidden', SYNC_ENABLED);
  }
  if ($btnSyncShare) {
    $btnSyncShare.classList.toggle('hidden', !SYNC_ENABLED);
  }
  if ($btnSyncCopyUrl) {
    $btnSyncCopyUrl.classList.toggle('hidden', !SYNC_ENABLED);
  }
}

function openSyncModal() {
  if (!$syncModal) return;
  $syncKeyInput.value = SYNC_KEY || '';
  $syncKeyError.classList.add('hidden');
  updateSyncKeyUi();
  $syncModal.classList.add('open');
  openOverlay($syncModal, () => $syncKeyInput.focus());
}

function closeSyncModal() {
  if (!$syncModal) return;
  $syncModal.classList.remove('open');
  closeOverlay($syncModal);
}

async function applySyncKey(rawInput) {
  const parsed = parseInputSyncKey(rawInput);
  if (!parsed || parsed.length < 32) {
    $syncKeyError.classList.remove('hidden');
    return;
  }
  $syncKeyError.classList.add('hidden');
  // WL-33: Wechsel auf einen anderen Schluessel — die lokale Liste gehoert
  // zum alten Schluessel und liegt dort; sie darf nicht in die neue Liste
  // hineingemischt werden (wie bisher: Server-Stand des neuen Schluessels).
  if (SYNC_KEY && SYNC_KEY !== parsed) {
    items = [];
    deletedItems = [];
    magazine = null;
    activeMagProvider = 'all';
    lsRemove(UNSENT_KEY);
    saveItemsLocal();
  }
  SYNC_KEY = parsed;
  SYNC_ENABLED = true;
  lsSet('watchlist_sync_key', SYNC_KEY);

  const params = new URLSearchParams(window.location.search);
  params.set('key', SYNC_KEY);
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);

  updateSyncKeyUi();
  closeSyncModal();
  syncProblem = null;
  renderSyncBanner();
  firstSyncPending = items.length === 0;
  renderWatchlist();
  showAutoAddToast('Synchronisiere Watchlist…', 'loading');

  const pulled = await pullFromServer();
  if (pulled) {
    await resolveVorgemerkt();
    await fetchMagazine();
    renderMagazinePill();
    showAutoAddToast(`✓ Watchlist geladen (${items.length} Titel)`, 'success');
  } else {
    showAutoAddToast('Sync fehlgeschlagen — bitte Key prüfen', 'error');
  }
}

// ---- Auto-Add via URL ----
function getAutoAddParams() {
  const params = new URLSearchParams(window.location.search);
  const add = params.get('add');
  const type = params.get('type');
  return {
    tmdbId: add ? parseInt(add) : null,
    mediaType: type || null,
  };
}

async function handleAutoAdd(tmdbId, mediaType) {
  // Already on watchlist?
  const existing = items.find(i => i.tmdbId === tmdbId && i.type === mediaType);
  if (existing) {
    showAutoAddToast(`„${existing.title}" ist bereits auf deiner Watchlist`, 'info');
    cleanAutoAddParams();
    return;
  }

  showAutoAddToast('Wird hinzugefügt…', 'loading');

  try {
    // Fetch TMDB details
    const detailRes = await fetchT(`${WORKER_BASE}/tmdb/details?type=${encodeURIComponent(mediaType)}&id=${encodeURIComponent(tmdbId)}`, { headers: { 'X-API-Key': SYNC_KEY } });
    if (!detailRes.ok) throw new Error(`TMDB ${detailRes.status}`);
    const detail = await detailRes.json();

    // Fetch providers
    const providers = (await fetchProviders(tmdbId, mediaType, detail.title || detail.name)) || { ...EMPTY_PROVIDERS };

    // Build result object (same shape as search results)
    const result = {
      id: tmdbId,
      title: detail.title || detail.name,
      name: detail.name,
      media_type: mediaType,
      poster_path: detail.poster_path,
      backdrop_path: detail.backdrop_path,
      overview: detail.overview || '',
      vote_average: detail.vote_average,
      release_date: detail.release_date,
      first_air_date: detail.first_air_date,
    };

    // WL-28: nur der beste Anbieter ohne Zusatzkosten; nur leihbar → vorgemerkt
    const serviceId = providers.flat[0] || null;

    if (!serviceId) {
      // No provider yet (upcoming title) — bookmark as "vorgemerkt" instead of
      // failing. It auto-promotes to a service once one becomes available.
      const added = addVorgemerkt({
        tmdbId,
        title: getTitle(result),
        year: (result.release_date || result.first_air_date || '').slice(0, 4),
        type: mediaType,
        poster: result.poster_path,
        backdrop: result.backdrop_path,
        overview: result.overview,
        rating: result.vote_average,
        releaseDate: result.release_date || result.first_air_date || null,
        providers,
      });
      showAutoAddToast(`„${getTitle(result)}" ${added ? 'vorgemerkt' : 'ist bereits auf deiner Watchlist'}`, added ? 'success' : 'info');
      cleanAutoAddParams();
      return;
    }

    // Set state and add
    selectedTmdb = result;
    selectedService = serviceId;
    availableServices = providers;
    addItem();

    const svc = SERVICES.find(s => s.id === serviceId);
    showAutoAddToast(`✓ „${getTitle(result)}" hinzugefügt (${svc?.name || serviceId})`, 'success');
  } catch (err) {
    console.error('Auto-add error:', err);
    showAutoAddToast('Fehler beim Hinzufügen', 'error');
  }

  cleanAutoAddParams();
}

function showAutoAddToast(message, type) {
  let toast = document.getElementById('autoAddToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'autoAddToast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    Object.assign(toast.style, {
      position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
      padding: '14px 24px', borderRadius: '12px', fontSize: '15px', fontWeight: '500',
      zIndex: '9999', color: '#fff', textAlign: 'center', maxWidth: '90vw',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)', transition: 'opacity 0.3s',
    });
    document.body.appendChild(toast);
  }
  // WL-18: dunklere Status-BG, damit der weisse Text WCAG-AA (>=4.5:1) erreicht.
  // success #15803d 5.0:1 · info #1565c0 5.8:1 · error #c62828 5.6:1 · loading #555 7.1:1.
  const colors = { loading: '#555', success: '#15803d', error: '#c62828', info: '#1565c0' };
  toast.style.background = colors[type] || '#555';
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.display = 'block';

  if (type !== 'loading') {
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => { toast.style.display = 'none'; }, 300); }, 3500);
  }
}

// WL-37: Rueckgaengig-Leiste unten, nur nach "Entfernen" und "Geschaut".
// Eine Leiste zugleich; eine neue ersetzt die alte, ohne deren Aktion zu
// widerrufen. Laeuft nach UNDO_BAR_MS aus.
const UNDO_BAR_MS = 6000;
let undoBarTimer = null;

function hideUndoBar() {
  clearTimeout(undoBarTimer);
  undoBarTimer = null;
  const bar = document.getElementById('undoBar');
  if (bar) bar.remove();
}

function showUndoBar(message, onUndo) {
  hideUndoBar();
  const bar = document.createElement('div');
  bar.id = 'undoBar';
  bar.className = 'undo-bar';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  text.className = 'undo-bar-text';
  text.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'undo-bar-btn';
  btn.textContent = 'Rückgängig';
  btn.addEventListener('click', () => {
    hideUndoBar();
    onUndo();
  });
  bar.append(text, btn);
  document.body.appendChild(bar);
  undoBarTimer = setTimeout(hideUndoBar, UNDO_BAR_MS);
}

function cleanAutoAddParams() {
  const params = new URLSearchParams(window.location.search);
  params.delete('add');
  params.delete('type');
  const newUrl = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.replaceState({}, '', newUrl);
}

// ---- Storage (Local) ----
function loadItemsLocal() {
  try {
    const data = lsGet(STORAGE_KEY);
    items = data ? JSON.parse(data) : [];
    deletedItems = JSON.parse(lsGet(DELETED_KEY) || '[]');
    // Migrate old 'joyne' -> 'joyn'
    items.forEach(item => {
      if (item.serviceId === 'joyne') item.serviceId = 'joyn';
      if (item.providers) {
        item.providers.flat = item.providers.flat?.map(id => id === 'joyne' ? 'joyn' : id) || [];
      }
    });
  } catch {
    items = [];
    deletedItems = [];
  }
}

function saveItemsLocal() {
  lsSet(STORAGE_KEY, JSON.stringify(items));
  lsSet(DELETED_KEY, JSON.stringify(deletedItems));
}

// ---- Sync ----
// WL-40: Fehlerhinweis als Banner unter der Kopfzeile. syncProblem ist null,
// 'fail' (Abgleich fehlgeschlagen) oder 'auth' (Worker: 401, Schluessel nicht
// freigeschaltet). Offline sagt das schon der Offline-Streifen.
let syncProblem = null;
let firstSyncPending = false;
let syncSpinTimer = null;
let syncSpinShown = false;

function renderSyncBanner() {
  const el = document.getElementById('syncBanner');
  if (!el) return;
  const show = !!syncProblem && SYNC_ENABLED && navigator.onLine !== false;
  if (show) {
    const auth = syncProblem === 'auth';
    document.getElementById('syncBannerText').textContent = auth ? 'Schlüssel nicht freigeschaltet' : 'Nicht synchron';
    document.getElementById('syncBannerBtn').textContent = auth ? 'Schlüssel prüfen' : 'Erneut versuchen';
    el.classList.toggle('auth', auth);
  }
  el.classList.toggle('hidden', !show);
}

function endFirstSync() {
  if (!firstSyncPending) return;
  firstSyncPending = false;
  renderWatchlist();
}

function setSyncStatus(status) {
  syncStatus = status;
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  el.className = 'sync-indicator ' + (status === 'error' ? 'idle' : status);
  // Fehler zeigt der Banner mit Text; das Kopf-Zeichen bleibt aus.
  el.textContent = { idle: '', syncing: '↻', synced: '✓', error: '' }[status] || '';
  if (status === 'synced') {
    setTimeout(() => { if (syncStatus === 'synced') setSyncStatus('idle'); }, 2000);
  }
}

// WL-33: Jeder Sync liest erst den Server-Stand, fuehrt je Titel zusammen
// (sync-merge.js) und schreibt nur dann zurueck, wenn sich etwas
// unterscheidet oder lokal etwas ungesendet ist. Ungesendetes bleibt in
// localStorage markiert und wird nach 5 s, 30 s und 2 min sowie bei
// "online", beim Wieder-Sichtbarwerden und beim App-Start nachgesendet.
const RETRY_DELAYS_MS = [5000, 30000, 120000];
let syncRunning = false;
let syncAgain = false;
let retryTimer = null;
let retryIndex = 0;
let localChangeSeq = 0;

function hasMerge() {
  return typeof SyncMerge !== 'undefined';
}

function hasUnsent() {
  return lsGet(UNSENT_KEY) === '1';
}

function allLocalItems() {
  return items.concat(deletedItems);
}

// Uebernimmt das Ergebnis, behaelt aber die vorhandenen Objekte: offene
// Ansichten (Detail-Modal) halten Referenzen auf sie.
function applyMerged(merged) {
  const byId = new Map(allLocalItems().map(it => [String(it.id), it]));
  const reused = merged.map(m => {
    const o = byId.get(String(m.id));
    if (!o) return m;
    for (const k of Object.keys(o)) if (!(k in m)) delete o[k];
    return Object.assign(o, m);
  });
  const { live, deleted } = SyncMerge.splitItems(reused);
  items = live;
  deletedItems = deleted;
  saveItemsLocal();
}

function scheduleRetry() {
  if (retryTimer || retryIndex >= RETRY_DELAYS_MS.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    syncWithServer();
  }, RETRY_DELAYS_MS[retryIndex++]);
}

// true = Server-Stand gelesen und zusammengefuehrt; false = Fehler.
async function syncWithServer() {
  if (!SYNC_ENABLED) return false;
  if (!hasMerge()) {
    // Alte index.html aus dem Cache ohne sync-merge.js: lieber nicht syncen
    // als ersetzen. Lokale Aenderungen bleiben markiert.
    syncProblem = 'fail';
    setSyncStatus('error');
    renderSyncBanner();
    endFirstSync();
    return false;
  }
  if (syncRunning) { syncAgain = true; return false; }
  syncRunning = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  let pulled = false;
  try {
    // WL-40: Ladezeichen erst bei spuerbarer Dauer; kurzes Holen bleibt still.
    syncSpinShown = false;
    clearTimeout(syncSpinTimer);
    syncSpinTimer = setTimeout(() => { syncSpinShown = true; setSyncStatus('syncing'); }, 800);
    const res = await fetchT(SYNC_URL, { headers: { 'X-API-Key': SYNC_KEY }, cache: 'no-store' });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    const data = await res.json();
    const remote = Array.isArray(data.items) ? data.items : [];

    const before = JSON.stringify(allLocalItems());
    applyMerged(SyncMerge.mergeItems(allLocalItems(), remote));
    pulled = true;
    if (JSON.stringify(allLocalItems()) !== before) {
      renderFilterBar();
      renderShortlist();
      renderWatchlist();
    }
    lsSet('watchlist_last_sync', Date.now().toString());

    if (hasUnsent() || !SyncMerge.sameState(allLocalItems(), remote)) {
      const seq = localChangeSeq;
      const put = await fetchT(SYNC_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': SYNC_KEY },
        body: JSON.stringify({ items: allLocalItems() }),
      });
      if (!put.ok) { const e = new Error(`HTTP ${put.status}`); e.status = put.status; throw e; }
      // Aenderungen waehrend des Sendens bleiben ungesendet -> Folgelauf.
      if (seq === localChangeSeq) lsRemove(UNSENT_KEY);
      else syncAgain = true;
    }
    retryIndex = 0;
    const recovered = syncProblem !== null;
    syncProblem = null;
    renderSyncBanner();
    if (syncSpinShown || recovered) setSyncStatus('synced');
    else if (syncStatus === 'syncing') setSyncStatus('idle');
  } catch (err) {
    console.error('Sync error:', err);
    syncProblem = err && err.status === 401 ? 'auth' : 'fail';
    setSyncStatus('error');
    renderSyncBanner();
    // 401 heilt nicht von selbst: kein Wiederholen im Hintergrund.
    if (syncProblem !== 'auth') scheduleRetry();
  } finally {
    clearTimeout(syncSpinTimer);
    syncRunning = false;
    endFirstSync();
    if (syncAgain) {
      syncAgain = false;
      syncWithServer();
    }
  }
  return pulled;
}

function pushToServer() {
  return syncWithServer();
}

function pullFromServer() {
  return syncWithServer();
}

function saveItems() {
  localChangeSeq++;
  if (SYNC_ENABLED) lsSet(UNSENT_KEY, '1');
  saveItemsLocal();
  retryIndex = 0;
  syncWithServer(); // async, non-blocking
}

// ---- Shortlist Logic ----
function getShortlistItems() {
  return items
    .filter(i => i.shortlist != null)
    .sort((a, b) => a.shortlist - b.shortlist);
}

function addToShortlist(itemId) {
  const current = getShortlistItems();
  if (current.length >= SHORTLIST_MAX) return false;
  const item = items.find(i => i.id === itemId);
  if (!item || item.shortlist != null) return false;
  item.shortlist = current.length;
  item.updatedAt = Date.now();
  saveItems();
  renderShortlist();
  return true;
}

function removeFromShortlist(itemId) {
  const item = items.find(i => i.id === itemId);
  if (!item || item.shortlist == null) return;
  item.shortlist = null;
  item.updatedAt = Date.now();
  // Re-index remaining positions
  reindexShortlist();
  saveItems();
  renderShortlist();
}

// WL-37: Rueckgaengig. Beide Wege schreiben den Titel mit frischem updatedAt
// zurueck, damit Last-write-wins (sync-merge.js) ihn auch auf anderen Geraeten
// gegen Marker bzw. Geschaut-Stand gewinnen laesst.
function restoreShortlistSlot(item, slot) {
  if (slot == null || item.watched) return;
  const free = getShortlistItems().filter(i => i !== item);
  if (free.length >= SHORTLIST_MAX) return;
  item.shortlist = Math.min(slot, free.length);
  free.splice(item.shortlist, 0, item);
  free.forEach((it, idx) => { if (it.shortlist !== idx) { it.shortlist = idx; it.updatedAt = Date.now(); } });
}

function undoRemove(snapshot, index) {
  if (items.some(i => String(i.id) === String(snapshot.id))) return;
  deletedItems = deletedItems.filter(i => String(i.id) !== String(snapshot.id));
  const restored = { ...snapshot, shortlist: null, updatedAt: Date.now() };
  delete restored.deleted;
  items.splice(Math.max(0, Math.min(index, items.length)), 0, restored);
  restoreShortlistSlot(restored, snapshot.shortlist);
  saveItems();
  renderShortlist();
  renderFilterBar();
  renderWatchlist();
}

function undoWatched(id, before) {
  const item = items.find(i => String(i.id) === String(id));
  if (!item) return;
  item.watched = before.watched;
  item.updatedAt = Date.now();
  restoreShortlistSlot(item, before.shortlist);
  saveItems();
  renderShortlist();
  renderWatchlist();
}

// WL-33: Positionswechsel ist eine Aenderung — ohne neues updatedAt wuerde
// der folgende Sync die alte Reihenfolge vom Server zurueckholen.
function reindexShortlist(list = getShortlistItems()) {
  const now = Date.now();
  list.forEach((it, idx) => {
    if (it.shortlist !== idx) { it.shortlist = idx; it.updatedAt = now; }
  });
}

function reorderShortlist(fromIndex, toIndex) {
  const list = getShortlistItems();
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= list.length || toIndex >= list.length) return;
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  reindexShortlist(list);
  saveItems();
  renderShortlist();
}

function isOnShortlist(itemId) {
  const item = items.find(i => i.id === itemId);
  return item && item.shortlist != null;
}

function isShortlistFull() {
  return getShortlistItems().length >= SHORTLIST_MAX;
}

// ---- Render: Shortlist ----
function renderShortlist() {
  const list = getShortlistItems();

  // Empty-State-Strategie (WL-17/REQ-P3-K): sekundaere Schienen (Shortlist,
  // Magazin-Teaser) blenden leer komplett aus — die EINZIGE gestaltete
  // Leeransicht der App ist die Watchlist (#emptyState). Ein Dauer-Hinweis
  // "Shortlist leer" waere Clutter neben der vollen Watchlist (bewusste Wahl).
  if (list.length === 0) {
    $shortlistSection.classList.add('hidden');
    return;
  }

  $shortlistSection.classList.remove('hidden');
  $shortlistTrack.innerHTML = '';

  list.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'shortlist-card';
    card.dataset.id = item.id;
    card.dataset.index = idx;
    card.draggable = true;

    const svc = SERVICES.find(s => s.id === item.serviceId);

    card.innerHTML = `
      ${item.poster
        ? `<img class="shortlist-poster" src="${tmdbPoster(item.poster, 'w185')}" srcset="${posterSrcset(item.poster)}" sizes="${POSTER_SIZES}" alt="${escAttr(item.title)}" loading="lazy">`
        : `<div class="shortlist-no-poster">🎬</div>`
      }
      ${svcMarkerHtml(svc)}
      <button class="shortlist-remove" aria-label="${escAttr(item.title)} entfernen">×</button>
      <div class="shortlist-overlay">
        <div class="shortlist-card-title">${esc(item.title)}</div>
      </div>
    `;

    // Remove button
    card.querySelector('.shortlist-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromShortlist(item.id);
    });

    // Open detail on click
    card.addEventListener('click', (e) => {
      if (e.target.closest('.shortlist-remove')) return;
      openDetail(item);
    });

    $shortlistTrack.appendChild(card);
  });

  bindShortlistDragDrop();
}

// ---- Shortlist Drag & Drop ----
function bindShortlistDragDrop() {
  let dragIdx = null;
  let dragGhost = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let isDragging = false;

  const cards = $shortlistTrack.querySelectorAll('.shortlist-card');

  cards.forEach(card => {
    // --- Desktop drag ---
    card.addEventListener('dragstart', (e) => {
      dragIdx = parseInt(card.dataset.index);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Transparent drag image (we style via CSS)
      const img = new Image();
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(img, 0, 0);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragIdx = null;
      cards.forEach(c => c.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cards.forEach(c => c.classList.remove('drag-over'));
      card.classList.add('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const toIdx = parseInt(card.dataset.index);
      if (dragIdx != null && dragIdx !== toIdx) {
        reorderShortlist(dragIdx, toIdx);
      }
      cards.forEach(c => c.classList.remove('drag-over'));
    });

    // --- Touch drag ---
    card.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      isDragging = false;
      dragIdx = parseInt(card.dataset.index);

      // Start drag after a small hold
      card._holdTimer = setTimeout(() => {
        isDragging = true;
        card.classList.add('dragging');
        // Create ghost
        dragGhost = card.cloneNode(true);
        dragGhost.classList.add('shortlist-ghost');
        dragGhost.style.width = card.offsetWidth + 'px';
        dragGhost.style.height = card.offsetHeight + 'px';
        document.body.appendChild(dragGhost);
        positionGhost(touch);
      }, 200);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) {
        // Cancel hold if finger moved too far before drag started
        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - touchStartX);
        const dy = Math.abs(touch.clientY - touchStartY);
        if (dx > 10 || dy > 10) {
          clearTimeout(card._holdTimer);
        }
        return;
      }
      e.preventDefault();
      const touch = e.touches[0];
      positionGhost(touch);

      // Highlight target card
      cards.forEach(c => c.classList.remove('drag-over'));
      const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.shortlist-card');
      if (target && target !== card) {
        target.classList.add('drag-over');
      }
    }, { passive: false });

    card.addEventListener('touchend', (e) => {
      clearTimeout(card._holdTimer);
      if (!isDragging) { dragIdx = null; return; }

      const touch = e.changedTouches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.shortlist-card');

      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      card.classList.remove('dragging');
      cards.forEach(c => c.classList.remove('drag-over'));

      if (target && target !== card) {
        const toIdx = parseInt(target.dataset.index);
        if (dragIdx != null && dragIdx !== toIdx) {
          reorderShortlist(dragIdx, toIdx);
        }
      }

      isDragging = false;
      dragIdx = null;
    });
  });

  function positionGhost(touch) {
    if (!dragGhost) return;
    dragGhost.style.left = (touch.clientX - dragGhost.offsetWidth / 2) + 'px';
    dragGhost.style.top = (touch.clientY - dragGhost.offsetHeight / 2) + 'px';
  }
}

function exportData() {
  return JSON.stringify(items, null, 2);
}

function importData(json) {
  try {
    const data = JSON.parse(json);
    if (Array.isArray(data)) {
      // WL-33: Import fuegt hinzu und aktualisiert, loescht aber nichts.
      const now = Date.now();
      const stamped = data.filter(it => it && it.id != null && !it.deleted).map(it => ({ ...it, updatedAt: now }));
      if (typeof SyncMerge !== 'undefined') applyMerged(SyncMerge.mergeItems(allLocalItems(), stamped));
      else items = stamped;
      saveItems();
      renderFilterBar();
      renderWatchlist();
      return true;
    }
  } catch {}
  return false;
}

// ---- TMDB API ----
async function searchTmdb(query) {
  if (!SYNC_ENABLED || !query.trim()) return [];
  const url = `${WORKER_BASE}/tmdb/search?q=${encodeURIComponent(query)}`;
  // WL-39: Ausfall ist kein „keine Treffer" — der Fehler geht an den Aufrufer.
  try {
    const res = await fetchT(url, { headers: { 'X-API-Key': SYNC_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.error('TMDB search error:', err);
    if (!err.kind) err.kind = 'error';
    throw err;
  }
}

// WL-28: Urteil des Workers → das bisherige providers-Format. flat = Dienste
// ohne Zusatzkosten in Rangfolge (freie Mediathek zuerst, dann Abos im Profil);
// rent/buy bleiben leer, Leih-Angebote stehen nur als Namen in rentOnly.
function providersFromVerdict(v) {
  if (!v || v.error) return null;
  const list = [v.best, ...(v.alternatives || [])].filter(Boolean);
  const links = {};
  const direct = {};
  const prefilled = {};
  list.forEach(o => {
    // nur http(s)-Links vom Worker uebernehmen
    if (typeof o.link === 'string' && /^https:\/\//.test(o.link)) links[o.service] = o.link;
    direct[o.service] = !!o.direct && !!links[o.service];
    // aeltere Worker-Antworten ohne Feld gelten als vorbefuellt
    prefilled[o.service] = direct[o.service] && o.prefilled !== false;
  });
  return {
    flat: list.map(o => o.service),
    rent: [],
    buy: [],
    rentOnly: v.rentOnly || [],
    links,
    direct,
    prefilled,
    checkedAt: v.checkedAt || Date.now(),
  };
}

const EMPTY_PROVIDERS = { flat: [], rent: [], buy: [], rentOnly: [], links: {} };
const AVAILABILITY_BATCH = 40;          // = AVAILABILITY_BATCH_MAX im Worker
const AVAILABILITY_STALE_MS = 12 * 3600 * 1000;

// Eine Liste {type,id,title} → Map "type:id" → providers (fehlt bei Fehler).
async function fetchAvailability(list) {
  const out = new Map();
  out.failKind = null; // WL-39: 'timeout' | 'error', wenn ein Teilaufruf scheiterte
  if (!SYNC_ENABLED || list.length === 0) return out;
  for (let i = 0; i < list.length; i += AVAILABILITY_BATCH) {
    const chunk = list.slice(i, i + AVAILABILITY_BATCH);
    try {
      const res = await fetchT(`${WORKER_BASE}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': SYNC_KEY },
        body: JSON.stringify({ items: chunk }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const [key, v] of Object.entries(data.results || {})) {
        const p = providersFromVerdict(v);
        if (p) out.set(key, p);
      }
    } catch (err) {
      console.error('Availability error:', err);
      out.failKind = out.failKind === 'timeout' ? 'timeout' : (err.kind || 'error');
    }
  }
  return out;
}

// null = Pruefung fehlgeschlagen (Netz, Worker) — nie als "kein Angebot" lesen.
// info (optional) bekommt failKind: 'timeout' | 'error' (WL-39).
async function fetchProviders(tmdbId, mediaType, title, info) {
  const map = await fetchAvailability([{ type: mediaType, id: tmdbId, title: title || '' }]);
  if (info) info.failKind = map.failKind || 'error';
  return map.get(`${mediaType}:${tmdbId}`) || null;
}

function tmdbPoster(path, size = 'w342') {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

// Kachelbreite fuer srcset — spiegelt die fluide Spaltenformel von .watchlist
// UND .shortlist-card (style.css, dort der Gegen-Verweis): 3/4/5/6 Spalten;
// Paddings 2*8/2*12/2*20 px + gaps 2*6/3*8/4*8/5*10 px. min() deckelt ab
// --content-max (1440 px). Border-los seit WL-26b, kein Slot-Abzug noetig.
// Annahme 20 px = --margin-outer (1.25rem bei 16-px-Wurzelschrift); bei
// vergroesserter Browser-Schrift ueberschaetzt sizes nur (kostet Bytes,
// keine Unschaerfe).
const POSTER_SIZES = '(min-width: 1024px) min(calc((100vw - 90px) / 6), 232px), (min-width: 768px) calc((100vw - 72px) / 5), (min-width: 500px) calc((100vw - 48px) / 4), calc((100vw - 28px) / 3)';

function posterSrcset(path) {
  return `${tmdbPoster(path, 'w185')} 185w, ${tmdbPoster(path, 'w342')} 342w, ${tmdbPoster(path, 'w500')} 500w`;
}

function tmdbBackdrop(path) {
  return path ? `${TMDB_IMG}/w780${path}` : null;
}

function tmdbProfile(path, size = 'w185') {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

const LANG_MAP = {
  en: 'Englisch', de: 'Deutsch', sv: 'Schwedisch', fr: 'Französisch',
  es: 'Spanisch', it: 'Italienisch', ja: 'Japanisch', ko: 'Koreanisch',
  da: 'Dänisch', no: 'Norwegisch', nl: 'Niederländisch', pt: 'Portugiesisch',
};

// WL-13: kuratierte EN→DE-Map für die häufigsten TMDB-Keywords (kein KI). TMDB
// liefert Keywords NUR englisch; im deutschen Magazin wirken sie fremd. Nicht
// gemappte Keywords werden ausgeblendet (deKeyword→null), damit NIE ein
// englischer Mood-Tag im Heft steht — lieber weniger Tags als gemischte Sprache.
const KEYWORD_DE = {
  'based on novel or book': 'Romanverfilmung', 'based on novel': 'Romanverfilmung',
  'based on book': 'Romanverfilmung', 'based on young adult novel': 'Jugendbuchverfilmung',
  'based on true story': 'Nach wahrer Begebenheit', 'based on a true story': 'Nach wahrer Begebenheit',
  'based on real events': 'Nach wahren Ereignissen', 'based on comic': 'Comicverfilmung',
  'based on comic book': 'Comicverfilmung', 'based on video game': 'Videospielverfilmung',
  'based on play': 'Nach einem Theaterstück', 'based on tv series': 'Nach einer Serie',
  'biography': 'Biografie', 'first love': 'Erste Liebe', 'forbidden love': 'Verbotene Liebe',
  'love triangle': 'Dreiecksbeziehung', 'romance': 'Romanze', 'wedding': 'Hochzeit',
  'divorce': 'Scheidung', 'pregnancy': 'Schwangerschaft', 'friendship': 'Freundschaft',
  'family': 'Familie', 'dysfunctional family': 'Zerrüttete Familie',
  'father son relationship': 'Vater-Sohn-Beziehung', 'mother daughter relationship': 'Mutter-Tochter-Beziehung',
  'coming of age': 'Erwachsenwerden', 'high school': 'Highschool', 'teenager': 'Jugendliche',
  'murder': 'Mord', 'witness to murder': 'Zeuge eines Mordes', 'serial killer': 'Serienmörder',
  'revenge': 'Rache', 'betrayal': 'Verrat', 'kidnapping': 'Entführung', 'heist': 'Raubüberfall',
  'robbery': 'Raubüberfall', 'conspiracy': 'Verschwörung', 'corruption': 'Korruption',
  'investigation': 'Ermittlung', 'detective': 'Detektiv', 'police': 'Polizei',
  'crime': 'Verbrechen', 'mafia': 'Mafia', 'gangster': 'Gangster', 'prison': 'Gefängnis',
  'drugs': 'Drogen', 'drug cartel': 'Drogenkartell', 'spy': 'Spionage', 'espionage': 'Spionage',
  'assassin': 'Auftragskiller', 'terrorism': 'Terrorismus', 'survival': 'Überleben',
  'time travel': 'Zeitreise', 'dystopia': 'Dystopie', 'apocalypse': 'Apokalypse',
  'post-apocalyptic future': 'Postapokalypse', 'artificial intelligence': 'Künstliche Intelligenz',
  'robot': 'Roboter', 'space travel': 'Raumfahrt', 'alien': 'Außerirdische',
  'outer space': 'Weltraum', 'virtual reality': 'Virtuelle Realität', 'hacker': 'Hacker',
  'dinosaur': 'Dinosaurier', 'superhero': 'Superheld', 'supervillain': 'Superschurke',
  'magic': 'Magie', 'witch': 'Hexe', 'vampire': 'Vampir', 'werewolf': 'Werwolf',
  'zombie': 'Zombie', 'ghost': 'Geist', 'haunted house': 'Spukhaus', 'supernatural': 'Übernatürlich',
  'dragon': 'Drache', 'monster': 'Monster', 'fairy tale': 'Märchen', 'mythology': 'Mythologie',
  'world war ii': 'Zweiter Weltkrieg', 'world war i': 'Erster Weltkrieg', 'cold war': 'Kalter Krieg',
  'war': 'Krieg', 'soldier': 'Soldat', 'military': 'Militär', 'holocaust': 'Holocaust',
  'slavery': 'Sklaverei', 'racism': 'Rassismus', 'politics': 'Politik', 'pandemic': 'Pandemie',
  'death': 'Tod', 'grief': 'Trauer', 'mental illness': 'Psychische Erkrankung',
  'depression': 'Depression', 'addiction': 'Sucht', 'alcoholism': 'Alkoholismus',
  'music': 'Musik', 'musician': 'Musiker', 'dance': 'Tanz', 'sport': 'Sport', 'boxing': 'Boxen',
  'martial arts': 'Kampfkunst', 'road trip': 'Roadtrip', 'treasure hunt': 'Schatzsuche',
  'car chase': 'Verfolgungsjagd', 'small town': 'Kleinstadt', 'island': 'Insel',
  'christmas': 'Weihnachten', 'halloween': 'Halloween', 'immigrant': 'Einwanderer',
  'religion': 'Religion', 'lgbt': 'LGBTQ', 'coming out': 'Coming-out', 'amnesia': 'Amnesie',
  'secret identity': 'Geheime Identität', 'twist ending': 'Überraschendes Ende',
  'sequel': 'Fortsetzung', 'prequel': 'Vorgeschichte', 'remake': 'Neuverfilmung',
  'anime': 'Anime', 'anthology': 'Anthologie', 'nonlinear timeline': 'Nichtlineare Erzählung',
  // Coverage-Ausbau (Live-Magazin-Verify 2026-06-16): beobachtete reale + weitere häufige Keywords
  'space': 'Weltraum', 'astronaut': 'Astronaut', 'spacecraft': 'Raumschiff', 'musical': 'Musical',
  'based on play or musical': 'Nach Bühnenvorlage', 'impostor': 'Hochstapler', 'con artist': 'Trickbetrüger',
  'sword fight': 'Schwertkampf', 'gunslinger': 'Revolverheld', 'showdown': 'Showdown', 'fistfight': 'Faustkampf',
  'western': 'Western', 'cowboy': 'Cowboy', 'pirate': 'Pirat', 'medieval': 'Mittelalter',
  'undercover': 'Undercover', 'hostage': 'Geiselnahme', 'bank robbery': 'Bankraub', 'escape': 'Flucht',
  'rescue': 'Rettung', 'gambling': 'Glücksspiel', 'casino': 'Casino', 'twins': 'Zwillinge', 'orphan': 'Waise',
  'father daughter relationship': 'Vater-Tochter-Beziehung', 'school': 'Schule', 'college': 'Studium',
  'courtroom': 'Gerichtssaal', 'trial': 'Gerichtsprozess', 'hospital': 'Krankenhaus', 'cancer': 'Krebs',
  'submarine': 'U-Boot', 'airplane': 'Flugzeug', 'train': 'Zug', 'rebellion': 'Rebellion',
  'revolution': 'Revolution', 'dictatorship': 'Diktatur', 'royalty': 'Königshaus', 'king': 'König',
  'queen': 'Königin', 'time loop': 'Zeitschleife', 'parallel world': 'Parallelwelt', 'clone': 'Klon',
  'experiment': 'Experiment', 'curse': 'Fluch', 'demon': 'Dämon', 'exorcism': 'Exorzismus', 'cult': 'Sekte',
  'dog': 'Hund', 'horse': 'Pferd', 'animal': 'Tier', 'climate change': 'Klimawandel',
};

// EN-Keyword → kuratiertes Deutsch, oder null wenn nicht gemappt (→ ausgeblendet).
function deKeyword(k) {
  return KEYWORD_DE[(k || '').toLowerCase().trim()] || null;
}

function initials(name) {
  return (name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase() || '?';
}

function getTitle(item) {
  return item.title || item.name || 'Unbekannt';
}

function getYear(item) {
  const date = item.release_date || item.first_air_date || '';
  return date ? date.substring(0, 4) : '';
}

function getType(item) {
  return item.media_type === 'tv' ? 'Serie' : 'Film';
}

function getTypeTag(item) {
  return item.media_type === 'tv' ? 'tv' : 'movie';
}

// ---- Render: Filter Bar ----
function renderFilterBar() {
  // .filter(Boolean) drops the null serviceId of vorgemerkt items — they get
  // their own chip below, not a broken service chip.
  const usedServices = [...new Set(items.map(i => i.serviceId))].filter(Boolean);
  const hasVorgemerkt = items.some(i => i.serviceId == null);
  // WL-19: war ein Service-/Vorgemerkt-Filter aktiv, dessen Gruppe jetzt KEIN Item
  // mehr hat (letztes entfernt/geschaut/promoted), gibt es seinen Chip nicht mehr —
  // der Filter zeigte sonst einen toten „Keine Ergebnisse"-Zustand ohne Ausweg.
  // Zurueck auf „Alle", BEVOR renderWatchlist filtert.
  if (activeService === '__vorgemerkt__' ? !hasVorgemerkt : (activeService && !usedServices.includes(activeService))) {
    activeService = null;
  }
  // REQ-P2-Q: Service-Chips gehoeren ZWISCHEN die Divider (Typ | Service | Sort),
  // darum vor der .sort-divider einfuegen statt ans Ende anzuhaengen.
  const sortDivider = $filterBar.querySelector('.sort-divider');
  const serviceDivider = $filterBar.querySelector('.service-divider');
  $filterBar.querySelectorAll('.service-chip').forEach(c => c.remove());

  usedServices.forEach(svcId => {
    const svc = SERVICES.find(s => s.id === svcId);
    if (!svc) return;
    const chip = document.createElement('button');
    chip.className = 'filter-chip service-chip';
    chip.dataset.service = svc.id;
    chip.style.setProperty('--chip-color', svc.color);
    chip.style.setProperty('--chip-text', badgeTextColor(svc.color));
    // WL-25: Logo + Name (Namens-span statt textContent; Logo via derselben
    // Helfer-Quelle). Ohne logo-Feld bleibt der heutige Punkt+Text-Chip.
    const nameSpan = document.createElement('span');
    nameSpan.textContent = svc.name;
    chip.appendChild(nameSpan);
    if (svc.logo) {
      chip.classList.add('has-logo');
      chip.insertAdjacentHTML('afterbegin', svcInlineLogoHtml(svc));
    }
    if (activeService === svc.id) chip.classList.add('active');
    $filterBar.insertBefore(chip, sortDivider);
  });

  // "Vorgemerkt" chip for service-less (upcoming) items
  if (hasVorgemerkt) {
    const chip = document.createElement('button');
    chip.className = 'filter-chip service-chip chip-vorgemerkt';
    chip.dataset.service = '__vorgemerkt__';
    chip.style.setProperty('--chip-color', 'var(--tertiary)');
    chip.style.setProperty('--chip-text', badgeTextColor('#ffb786'));
    chip.textContent = 'Vorgemerkt';
    if (activeService === '__vorgemerkt__') chip.classList.add('active');
    $filterBar.insertBefore(chip, sortDivider);
  }

  // REQ-P2-Q: zwei Divider nie nebeneinander — Service-Divider nur zeigen, wenn
  // rechts davon wirklich Service-Chips stehen (sonst kollabiert er auf .hidden).
  if (serviceDivider) serviceDivider.classList.toggle('hidden', usedServices.length === 0 && !hasVorgemerkt);
}
// WL-23: updateFilterFade ist ersatzlos entfernt — im Sheet wrappt die Bar
// viewport-unabhaengig (.filter-sheet .filter-bar), nichts scrollt horizontal.

// ---- Render: Watchlist ----
function renderWatchlist() {
  // WL-23 Raeum-Vertrag: BEIDE Card-Ziele raeumen, sonst stapeln Re-Renders.
  $watchlist.querySelectorAll('.card, .count-badge').forEach(el => el.remove());
  $seenGrid.querySelectorAll('.card').forEach(el => el.remove());

  let filtered = items;

  if (activeFilter === 'movie') {
    filtered = filtered.filter(i => i.type === 'movie');
  } else if (activeFilter === 'tv') {
    filtered = filtered.filter(i => i.type === 'tv');
  }

  if (activeService === '__vorgemerkt__') {
    filtered = filtered.filter(i => i.serviceId == null);
  } else if (activeService) {
    filtered = filtered.filter(i => i.serviceId === activeService);
  }

  // WL-23: strikt zweiwertiger Split — truthy watched -> gesehen, alles
  // andere (auch undefined) bleibt offen. Kein drittes Bucket.
  const bySort = (a, b) => {
    if (activeSort === 'rating') return (b.rating || 0) - (a.rating || 0);
    if (activeSort === 'alpha') return (a.title || '').localeCompare(b.title || '', 'de');
    return (b.addedAt || 0) - (a.addedAt || 0);
  };
  const open = filtered.filter(i => !i.watched).sort(bySort);
  const seen = filtered.filter(i => i.watched).sort(bySort);

  // WL-40: solange der erste Abgleich laeuft, zeigt eine leere Liste den
  // Ladezustand statt "leer".
  const loadingFirst = items.length === 0 && firstSyncPending;
  if ($loadingState) $loadingState.classList.toggle('hidden', !loadingFirst);
  if (loadingFirst) {
    $emptyState.classList.add('hidden');
  } else if (items.length === 0) {
    $emptyState.classList.remove('hidden');
  } else {
    $emptyState.classList.add('hidden');

    if (filtered.length === 0) {
      const badge = document.createElement('div');
      badge.className = 'count-badge';
      badge.textContent = 'Keine Ergebnisse für diesen Filter';
      $watchlist.appendChild(badge);
    } else {
      const badge = document.createElement('div');
      badge.className = 'count-badge';
      // REQ-P2-R: Filterkontext explizit machen — "gesamt" war bei aktivem
      // Filter irrefuehrend (es zeigte die gefilterte Teilmenge). Typ UND Service
      // koennen gleichzeitig aktiv sein (Service-Klick setzt activeFilter nicht
      // zurueck) -> beide Dimensionen kombiniert nennen.
      const typeLabel = activeFilter === 'movie' ? 'Filme' : activeFilter === 'tv' ? 'Serien' : '';
      const typePrefix = typeLabel ? `${typeLabel} ` : '';
      let scope;
      if (activeService === '__vorgemerkt__') scope = `${typePrefix}vorgemerkt`;
      else if (activeService) scope = `${typePrefix}bei ${SERVICES.find(s => s.id === activeService)?.name || 'Dienst'}`;
      else scope = typeLabel || 'Titel';
      badge.textContent = `${open.length} offen · ${filtered.length} ${scope}`;
      $watchlist.appendChild(badge);

      // WL-23 Leerlauf-Vertrag: alles Gefilterte ist gesehen -> sagen, wo es liegt,
      // statt eine leere Mitte zu zeigen.
      if (open.length === 0 && seen.length > 0) {
        const hint = document.createElement('div');
        hint.className = 'count-badge seen-hint';
        hint.textContent = seen.length === 1
          ? 'Keine offenen Titel — 1 gesehener liegt unter „Gesehen"'
          : `Keine offenen Titel — ${seen.length} gesehene liegen unter „Gesehen"`;
        $watchlist.appendChild(hint);
      }
    }

    open.forEach(item => {
      $watchlist.appendChild(createCard(item));
    });
  }

  renderSeenSection(seen);
  updateFilterPill();
  updateViewCounts();
  if (activeMainView === 'discover') refreshDiscoverButtonStates();
  if (activeMainView === 'live' || activeMainView === 'primetime') renderLiveView();
}

// WL-23: Gesehen-Sektion — Leiste immer (ab 1 Titel), Raster nur aufgeklappt.
function renderSeenSection(seen) {
  if (seen.length === 0) {
    $seenSection.classList.add('hidden');
    return;
  }
  $seenSection.classList.remove('hidden');
  $seenCount.textContent = `${seen.length} Titel`;
  const isOpen = !!uiState.seenOpen;
  $seenBar.setAttribute('aria-expanded', String(isOpen));
  $seenBar.classList.toggle('open', isOpen);
  $seenGrid.classList.toggle('hidden', !isOpen);
  if (isOpen) {
    seen.forEach(item => $seenGrid.appendChild(createCard(item)));
  }
}

// WL-23: Filter-Pille zeigt den aktiven Stand kompakt; Akzent bei Abweichung
// vom Default (Alle · Neu).
function updateFilterPill() {
  const typeLabel = activeFilter === 'movie' ? 'Filme' : activeFilter === 'tv' ? 'Serien' : 'Alle';
  let svcLabel = null;
  if (activeService === '__vorgemerkt__') svcLabel = 'Vorgemerkt';
  else if (activeService) svcLabel = SERVICES.find(s => s.id === activeService)?.name || null;
  const sortLabel = activeSort === 'rating' ? 'Bewertung' : activeSort === 'alpha' ? 'A–Z' : 'Neu';
  $pillFilterValue.textContent = [typeLabel, svcLabel, sortLabel].filter(Boolean).join(' · ');
  const isDefault = activeFilter === 'all' && !activeService && activeSort === 'added';
  $pillFilter.classList.toggle('pill-active', !isDefault);
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.watched ? ' watched' : '');
  card.dataset.id = item.id;
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');
  const svc = SERVICES.find(s => s.id === item.serviceId);
  // WL-30: Merkmal "manuell", wenn der gezeigte Dienst von Hand gesetzt ist
  const pinned = !!svc && pinnedService(item) === svc.id;
  card.setAttribute('aria-label', `${esc(item.title)} öffnen${pinned ? ', Dienst von dir gesetzt' : ''}`);

  card.innerHTML = `
    ${item.poster
      ? `<img class="card-poster" src="${tmdbPoster(item.poster)}" srcset="${posterSrcset(item.poster)}" sizes="${POSTER_SIZES}" alt="${escAttr(item.title)}" loading="lazy">`
      : `<div class="card-no-poster">🎬</div>`
    }
    <div class="card-overlay">
      <div class="card-title">${esc(item.title)}</div>
      <div class="card-meta">
        <span class="card-year">${esc(item.year)}</span>
        <span class="card-type">${item.type === 'tv' ? 'Serie' : 'Film'}</span>
      </div>
    </div>
    ${svc
      ? (pinned ? `<div class="card-marker-row">${svcMarkerHtml(svc)}<span class="card-pin-tag">${PIN_ICON}<span class="card-pin-text">manuell</span></span></div>` : svcMarkerHtml(svc))
      : (item.serviceId == null ? `<div class="card-badge-vorgemerkt">${vorgemerktBadgeText(item)}</div>` : '')}
  `;

  card.addEventListener('click', () => openDetail(item));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(item); }
  });
  return card;
}

// ---- Render: Search Results ----
// WL-39 Design A: Such-Ausfall steht dort, wo die Ergebnisse stünden.
function outageTitle(kind, base) {
  return kind === 'timeout' ? 'Antwortet gerade zu langsam' : base;
}
function renderSearchError(kind, retry) {
  $searchResults.innerHTML = `
    <div class="outage-box" role="alert">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M8.5 8.6A5 5 0 0 0 6 18h11"></path><path d="M10.4 5.2A6 6 0 0 1 18 10a4 4 0 0 1 2.7 6.9"></path></svg>
      <div class="outage-title">${outageTitle(kind, 'Suche gerade nicht erreichbar')}</div>
      <div class="outage-text">Der Dienst antwortet nicht. Deine Liste ist davon nicht betroffen.</div>
      <button type="button" class="btn-outage-primary">Nochmal versuchen</button>
    </div>`;
  const btn = $searchResults.querySelector('.btn-outage-primary');
  btn.addEventListener('click', retry);
  btn.focus();
}

function renderSearchResults(results) {
  if (results === null) {
    $searchResults.innerHTML = '<div class="search-loading">Suche...</div>';
    return;
  }

  if (results.length === 0) {
    $searchResults.innerHTML = '<div class="search-empty">Keine Ergebnisse</div>';
    return;
  }

  $searchResults.innerHTML = results.map(r => `
    <div class="search-result" role="button" tabindex="0" data-id="${r.id}" data-type="${r.media_type}">
      <img class="result-poster"
           src="${tmdbPoster(r.poster_path, 'w92') || ''}"
           alt=""
           onerror="this.src='';this.style.background='#222'">
      <div class="result-info">
        <div class="result-title">${esc(getTitle(r))}</div>
        <div class="result-meta">${esc(getYear(r))} · ${getType(r)}</div>
        ${r.overview ? `<div class="result-overview">${esc(r.overview)}</div>` : ''}
      </div>
    </div>
  `).join('');

  $searchResults.querySelectorAll('.search-result').forEach(el => {
    const choose = () => {
      const tmdbId = parseInt(el.dataset.id);
      const result = results.find(r => r.id === tmdbId);
      if (result) selectResult(result);
    };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
  });
}

// ---- Render: Service Grid with Availability ----
function renderServiceGrid(available) {
  const flatSet = new Set(available?.flat || []);
  const allAvailable = new Set([
    ...(available?.flat || []),
    ...(available?.rent || []),
    ...(available?.buy || []),
  ]);

  $serviceGrid.innerHTML = SERVICES.map(svc => {
    const isFlat = flatSet.has(svc.id);
    const isAvail = allAvailable.has(svc.id);
    const classes = ['service-btn'];
    if (isFlat) classes.push('available');
    else if (!isAvail && allAvailable.size > 0) classes.push('unavailable');

    return `<button class="${classes.join(' ')}" data-service="${svc.id}" style="--svc-color:${svc.color}">
      ${svcInlineLogoHtml(svc)}<span>${esc(svc.name)}</span>
    </button>`;
  }).join('');

  $serviceGrid.querySelectorAll('.service-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $serviceGrid.querySelectorAll('.service-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedService = btn.dataset.service;
      $btnSave.disabled = false;
    });
  });

  // WL-28: den besten Anbieter vorwaehlen (flat ist nach Rang sortiert)
  if (flatSet.size > 0) {
    const autoId = available.flat[0];
    const autoBtn = $serviceGrid.querySelector(`[data-service="${autoId}"]`);
    if (autoBtn) {
      autoBtn.classList.add('selected');
      selectedService = autoId;
      $btnSave.disabled = false;
    }
  }
}

// ---- Select TMDB Result ----
async function selectResult(result) {
  selectedTmdb = result;
  selectedService = null;
  availableServices = [];

  // Show service selection
  $searchResults.classList.add('hidden');
  $serviceSelect.classList.remove('hidden');
  document.querySelector('.search-wrapper').classList.add('hidden');

  $selectedTitle.innerHTML = `
    <img src="${tmdbPoster(result.poster_path, 'w92') || ''}" alt="">
    <div>
      <div class="selected-title-text">${esc(getTitle(result))}</div>
      <div class="selected-title-sub">${esc(getYear(result))} · ${getType(result)}</div>
    </div>
  `;

  // Render grid without availability first
  renderServiceGrid({});
  $btnSave.disabled = true;

  runAvailabilityCheck(result);
}

// WL-39 Design A: Ausfall der Prüfung ≠ „keine Verfügbarkeit". Das Raster bleibt
// wählbar, Speichern geht nach manueller Wahl; „Nochmal prüfen" wiederholt.
async function runAvailabilityCheck(result) {
  const availContainer = document.getElementById('availabilityInfo');
  if (availContainer) availContainer.remove();
  const loadingEl = document.createElement('div');
  loadingEl.id = 'availabilityInfo';
  loadingEl.className = 'availability-loading';
  loadingEl.innerHTML = '<div class="spinner"></div> Verfügbarkeit wird geprüft...';
  $serviceGrid.parentNode.insertBefore(loadingEl, $serviceGrid);

  const info = {};
  const providers = await fetchProviders(result.id, result.media_type, getTitle(result), info);
  if (selectedTmdb !== result) return; // anderer Titel gewählt oder Dialog geschlossen

  const infoEl = document.getElementById('availabilityInfo');
  if (!providers) {
    availableServices = { ...EMPTY_PROVIDERS };
    if (infoEl) {
      infoEl.className = 'availability-info availability-outage';
      infoEl.innerHTML = `
        <div class="outage-title amber">${outageTitle(info.failKind, 'Verfügbarkeit konnte nicht geprüft werden')}</div>
        <div class="outage-text">Wähle den Dienst selbst oder prüfe es gleich noch einmal.</div>
        <button type="button" class="btn-outage-outline">Nochmal prüfen</button>`;
      infoEl.setAttribute('role', 'alert');
      infoEl.querySelector('.btn-outage-outline').addEventListener('click', () => runAvailabilityCheck(result));
    }
    return; // Raster unverändert wählbar; ein schon gewählter Dienst bleibt
  }
  availableServices = providers;

  if (infoEl) {
    if (providers.flat.length > 0) {
      const names = providers.flat.map(id => SERVICES.find(s => s.id === id)?.name).filter(Boolean);
      infoEl.className = 'availability-info';
      infoEl.innerHTML = `✓ Ohne Zusatzkosten bei: ${esc(names.join(', '))}`;
    } else if ((providers.rentOnly || []).length > 0) {
      infoEl.className = 'availability-info not-found';
      infoEl.innerHTML = `⚡ Nur leihbar: ${esc(providers.rentOnly.join(', '))}`;
    } else {
      infoEl.className = 'availability-info not-found';
      infoEl.innerHTML = '⚠ Keine Streaming-Verfügbarkeit in DE gefunden';
    }
  }

  // Re-render grid with availability
  const keep = selectedService;
  renderServiceGrid(providers);
  if (keep && !providers.flat.length) {
    const btn = $serviceGrid.querySelector(`[data-service="${keep}"]`);
    if (btn) { btn.classList.add('selected'); selectedService = keep; $btnSave.disabled = false; }
  }
}

// ---- Add Item ----
function addItem() {
  if (!selectedTmdb || !selectedService) return;

  // Check for duplicate
  const exists = items.find(i => i.tmdbId === selectedTmdb.id && i.type === getTypeTag(selectedTmdb));
  if (exists) {
    closeAddModal();
    openDetail(exists);
    return;
  }

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    tmdbId: selectedTmdb.id,
    title: getTitle(selectedTmdb),
    year: getYear(selectedTmdb),
    type: getTypeTag(selectedTmdb),
    poster: selectedTmdb.poster_path,
    backdrop: selectedTmdb.backdrop_path,
    overview: selectedTmdb.overview || '',
    rating: selectedTmdb.vote_average ? Math.round(selectedTmdb.vote_average * 10) / 10 : null,
    serviceId: selectedService,
    watched: false,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    providers: availableServices,
  };

  items.unshift(item);
  saveItems();
  closeAddModal();
  renderFilterBar();
  renderWatchlist();
}

// ---- Detail View ----
let detailRequestId = 0; // race condition guard

async function openDetail(item) {
  const requestId = ++detailRequestId;
  let svc = SERVICES.find(s => s.id === item.serviceId);
  const $backdrop = document.getElementById('detailBackdrop');
  const $content = document.getElementById('detailContent');

  if (item.backdrop) {
    $backdrop.style.backgroundImage = `url(${tmdbBackdrop(item.backdrop)})`;
  } else if (item.poster) {
    $backdrop.style.backgroundImage = `url(${tmdbPoster(item.poster, 'w780')})`;
  } else {
    $backdrop.style.backgroundImage = 'none';
    $backdrop.style.background = 'linear-gradient(135deg, #222, #333)';
  }

  const ratingPct = item.rating ? Math.round(item.rating * 10) : null;

  // Close button — inject into .detail-modal (not $content) so it's not clipped by overflow:hidden
  const $modal = $detailModal.querySelector('.detail-modal');
  let $closeBtn = $modal.querySelector('.detail-close');
  if (!$closeBtn) {
    $closeBtn = document.createElement('button');
    $closeBtn.className = 'detail-close';
    $closeBtn.setAttribute('aria-label', 'Schließen');
    $closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    $modal.appendChild($closeBtn);
  }
  $closeBtn.onclick = closeDetailModal;

  $content.innerHTML = `
    <div class="detail-head" id="detailHead">${detailHeadHtml(item, svc)}</div>
    <h2 class="detail-title" id="detailModalTitle">${esc(item.title)}</h2>
    <div class="detail-meta">
      ${ratingPct ? `<span class="detail-match">${ratingPct}% Match</span>` : ''}
      <span>${esc(item.year)}</span>
      <span>·</span>
      <span>${item.type === 'tv' ? 'Serie' : 'Film'}</span>
    </div>
    ${item.overview ? `<p class="detail-overview">${esc(item.overview)}</p>` : ''}
    <div id="detailPinNote"></div>
    <div id="detailProviders"></div>
    <div class="detail-actions">
      ${detailCtaHtml(item, svc)}
      <div class="detail-pin-slot" id="detailPinSlot"></div>
      <div class="detail-actions-row">
        <button class="btn-trailer" type="button" data-id="${item.id}">▶ Trailer</button>
        ${!item.watched ? `<button class="btn-shortlist${isOnShortlist(item.id) ? ' on-shortlist' : ''}" data-id="${item.id}"${!isOnShortlist(item.id) && isShortlistFull() ? ' disabled title="Shortlist voll (max 5)"' : ''}>
          ${isOnShortlist(item.id) ? '★ Shortlist' : '☆ Shortlist'}
        </button>` : ''}
        <button class="btn-watched" data-id="${item.id}">
          ${item.watched ? '↩ Nicht gesehen' : '✓ Geschaut'}
        </button>
        <button class="btn-remove" data-id="${item.id}">Entfernen</button>
      </div>
      <div class="detail-pin-slot" id="detailUnpinSlot"></div>
      <div class="detail-source">
        <span>Verfügbarkeit: JustWatch</span>
        <a href="${tmdbWatchUrl(item)}" target="_blank" rel="noopener" aria-label="${item.serviceId ? 'Auf TMDB ansehen' : 'Angebote auf TMDB'} (öffnet neuen Tab)">${item.serviceId ? 'Auf TMDB ansehen' : 'Angebote auf TMDB'} ↗</a>
      </div>
    </div>
  `;

  // Bind actions
  const $trailerBtn = $content.querySelector('.btn-trailer');
  if ($trailerBtn) {
    $trailerBtn.addEventListener('click', () => openTrailerForWatchlistItem(item));
  }

  const $shortlistBtn = $content.querySelector('.btn-shortlist');
  if ($shortlistBtn) {
    $shortlistBtn.addEventListener('click', () => {
      if (isOnShortlist(item.id)) {
        removeFromShortlist(item.id);
      } else {
        addToShortlist(item.id);
      }
      closeDetailModal();
      renderWatchlist();
    });
  }

  $content.querySelector('.btn-watched').addEventListener('click', () => {
    const before = { watched: item.watched, shortlist: item.shortlist };
    item.watched = !item.watched;
    item.updatedAt = Date.now();
    // Remove from shortlist when marked as watched
    if (item.watched && item.shortlist != null) {
      item.shortlist = null;
      reindexShortlist();
    }
    saveItems();
    closeDetailModal();
    renderShortlist();
    renderWatchlist();
    if (item.watched) showUndoBar(`„${item.title}" als geschaut markiert`, () => undoWatched(item.id, before));
  });

  $content.querySelector('.btn-remove').addEventListener('click', () => {
    const snapshot = { ...item };
    const index = items.indexOf(item);
    // WL-33: Marker statt nur entfernen, damit andere Geraete mitloeschen
    if (typeof SyncMerge !== 'undefined') deletedItems.push(SyncMerge.makeTombstone(item));
    items = items.filter(i => i.id !== item.id);
    // Re-index shortlist after removal
    reindexShortlist();
    saveItems();
    closeDetailModal();
    renderShortlist();
    renderFilterBar();
    renderWatchlist();
    showUndoBar(`„${item.title}" entfernt`, () => undoRemove(snapshot, index));
  });

  refreshDetailPin(item);

  $detailModal.classList.add('open');
  openOverlay($detailModal, () => $closeBtn.focus());

  // Fetch fresh providers in background
  const $providers = document.getElementById('detailProviders');
  $providers.innerHTML = '<div class="availability-loading"><div class="spinner"></div> Verfügbarkeit prüfen...</div>';

  const providers = await fetchProviders(item.tmdbId, item.type, item.title);

  // Race condition guard: only update if this is still the active detail view
  if (requestId !== detailRequestId) return;

  // A vorgemerkt item may now have a provider — promote it. Re-bind svc and
  // re-render the header badge (which was absent while service-less).
  if (!providers) {
    $providers.innerHTML = '<div class="availability-info not-found">⚠ Verfügbarkeit gerade nicht prüfbar</div>';
    return;
  }

  // WL-28: frischer Stand gilt — bester Anbieter, oder vorgemerkt ohne Angebot.
  // WL-30: ein von Hand gesetzter Dienst bleibt (applyProviders).
  const change = applyProviders(item, providers);
  if (change) saveItems();
  else saveItemsLocal();  // nur checkedAt neu — kein PUT /sync je Oeffnen
  $providers.dataset.loaded = '1';
  refreshDetailPin(item);
  if (change && change !== 'updated') {
    renderFilterBar();
    renderWatchlist();
  }
}

// WL-30: Kopf der Detailansicht — Dienst-Badge, bei Pin mit Merkmal "manuell".
function detailHeadHtml(item, svc) {
  if (!svc) return '';
  const tag = pinnedService(item) === svc.id
    ? `<span class="detail-pin-tag">${PIN_ICON}manuell</span>` : '';
  return detailServiceBadgeHtml(svc) + tag;
}

// WL-30: Hinweis, warum der Dienst bleibt — je nach dem, was JustWatch fuer DE kennt.
function pinNoteText(item) {
  const id = pinnedService(item);
  const name = SERVICES.find(s => s.id === id)?.name || id;
  const flat = item.providers?.flat || [];
  if (flat.includes(id)) return `Von dir gesetzt: ${name}. JustWatch führt den Titel dort ebenfalls.`;
  if (flat.length === 0) return `Von dir gesetzt: ${name}. JustWatch kennt für Deutschland kein Streaming-Angebot bei deinen Diensten, die automatische Prüfung ändert den Dienst deshalb nicht.`;
  return `Von dir gesetzt: ${name}. JustWatch führt den Titel für Deutschland bei einem anderen deiner Dienste, die automatische Prüfung ändert deinen Dienst trotzdem nicht.`;
}

// Anbieter-Liste der Detailansicht aus item.providers — WL-28: getrennt nach
// freier Mediathek und Abo.
function detailProvidersHtml(item) {
  const providers = item.providers || EMPTY_PROVIDERS;
  const pinned = !item.watched && pinnedService(item);
  let providerHtml = '';
  const chip = (svcId) => {
    const s = SERVICES.find(x => x.id === svcId);
    if (!s) return '';
    const isCurrent = svcId === item.serviceId;
    if (s.logo) {
      // WL-25: neutrale Mini-Chips mit Kachel + Name; is-current als
      // DOM-Marker, damit der Logo-Fallback die Deckkraft korrekt
      // restaurieren kann. Nicht-current dimmt via CSS auf 0.7.
      return `<div class="detail-provider-badge with-logo${isCurrent ? ' is-current' : ''}">${svcInlineLogoHtml(s)}${esc(s.name)}</div>`;
    }
    const provColor = isCurrent ? `;color:${badgeTextColor(s.color)}` : ';opacity:0.7';
    return `<div class="detail-provider-badge${isCurrent ? ' is-current' : ''}" style="background:${s.color}${provColor}">${esc(s.name)}</div>`;
  };
  const freeIds = providers.flat.filter(id => SERVICES.find(x => x.id === id)?.free);
  const aboIds = providers.flat.filter(id => !SERVICES.find(x => x.id === id)?.free);
  if (freeIds.length > 0) {
    providerHtml += `<div class="detail-provider-type">Kostenlos in der Mediathek:</div><div class="detail-providers">${freeIds.map(chip).join('')}</div>`;
  }
  if (aboIds.length > 0) {
    providerHtml += `<div class="detail-provider-type">In deinen Abos:</div><div class="detail-providers">${aboIds.map(chip).join('')}</div>`;
  }

  // WL-30: bei Pin sagt die Hinweiszeile, was JustWatch kennt — keine Warnung doppelt
  if (providers.flat.length === 0 && (providers.rentOnly || []).length > 0) {
    const waitNote = item.watched || pinned ? '' : ' Kein Abo und keine Mediathek hat den Titel gerade, er bleibt vorgemerkt und wird bei jedem Öffnen der App neu geprüft.';
    providerHtml += `<div class="availability-info not-found" style="margin-top:8px">Nur leihbar: ${esc(providers.rentOnly.join(', '))}.${waitNote}</div>`;
  } else if (providers.flat.length === 0 && !pinned) {
    providerHtml += `<div class="availability-info not-found" style="margin-top:8px">⚠ Aktuell keine Streaming-Verfügbarkeit in DE gefunden</div>`;
  }
  return providerHtml;
}

// WL-30: alles, was am Pin haengt, neu zeichnen — Kopf, Hinweis, CTA, Pin-Knoepfe
// und (nach der Pruefung) die Anbieter-Liste. Liest nur item.
function refreshDetailPin(item) {
  const $content = document.getElementById('detailContent');
  if (!$content) return;
  const svc = SERVICES.find(s => s.id === item.serviceId);
  const pinned = pinnedService(item);
  const open = !item.watched;
  const $head = $content.querySelector('#detailHead');
  if ($head) $head.innerHTML = detailHeadHtml(item, svc);
  const $note = $content.querySelector('#detailPinNote');
  if ($note) $note.innerHTML = open && pinned ? `<div class="detail-pin-note">${esc(pinNoteText(item))}</div>` : '';
  const $cta = $content.querySelector('.btn-primary-cta, .detail-cta-slot');
  if ($cta) $cta.outerHTML = detailCtaHtml(item, svc);
  const $pinSlot = $content.querySelector('#detailPinSlot');
  if ($pinSlot) {
    $pinSlot.innerHTML = open && !pinned ? `<button class="btn-pin" type="button">${PIN_ICON}Ich sehe es bei …</button>` : '';
    const $b = $pinSlot.querySelector('.btn-pin');
    if ($b) $b.addEventListener('click', () => openPinSheet(item));
  }
  const $unpinSlot = $content.querySelector('#detailUnpinSlot');
  if ($unpinSlot) {
    $unpinSlot.innerHTML = open && pinned ? '<button class="btn-unpin" type="button">Automatisch prüfen lassen</button>' : '';
    const $b = $unpinSlot.querySelector('.btn-unpin');
    if ($b) $b.addEventListener('click', () => unpinService(item));
  }
  const $providers = $content.querySelector('#detailProviders');
  if ($providers && $providers.dataset.loaded) $providers.innerHTML = detailProvidersHtml(item);
}

// ---- Pin-Sheet (WL-30) ----
let pinItem = null;
let pinPrevFocus = null;  // Opener der Detailansicht — ueberlebt das Sheet

function pinChipHtml(s, current) {
  return `<button class="pin-chip${current === s.id ? ' is-current' : ''}" type="button" data-svc="${s.id}">${svcInlineLogoHtml(s)}<span>${esc(s.name)}</span></button>`;
}

function openPinSheet(item) {
  pinItem = item;
  const current = pinnedService(item) || item.serviceId;
  document.getElementById('pinGridAbo').innerHTML = SERVICES.filter(s => !s.free).map(s => pinChipHtml(s, current)).join('');
  document.getElementById('pinGridFree').innerHTML = SERVICES.filter(s => s.free).map(s => pinChipHtml(s, current)).join('');
  pinPrevFocus = lastFocused;
  $pinModal.classList.add('open');
  openOverlay($pinModal, () => { const c = $pinModal.querySelector('.pin-chip'); if (c) c.focus(); });
}

function closePinSheet() {
  $pinModal.classList.remove('open');
  closeOverlay($pinModal);
  pinItem = null;
  // Detailansicht ist noch offen: Hintergrund bleibt inert, ihr Opener bleibt gemerkt
  if ($detailModal.classList.contains('open')) {
    setBackgroundInert(true);
    lastFocused = pinPrevFocus;
  }
  pinPrevFocus = null;
}

// Die Karten werden neu gezeichnet, waehrend die Detailansicht offen ist: den
// gemerkten Opener auf die neue Karte umhaengen, sonst faellt der Fokus beim
// Schliessen auf body (qa#1-Hinweis b).
function refocusOpenerCard(item) {
  if (lastFocused && lastFocused.isConnected) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(item.id)}"]`);
  if (card) lastFocused = card;
}

function pinService(item, id) {
  if (!SERVICES.some(s => s.id === id)) return;
  item.pinnedServiceId = id;
  item.serviceId = id;
  item.updatedAt = Date.now();
  saveItems();
  refreshDetailPin(item);
  renderFilterBar();
  renderShortlist();
  renderWatchlist();
  refocusOpenerCard(item);
}

// Pin loesen: sofort nach dem zuletzt geprueften Stand einstufen (WL-28-Regeln).
function unpinService(item) {
  delete item.pinnedServiceId;
  item.updatedAt = Date.now();
  applyProviders(item, item.providers || { ...EMPTY_PROVIDERS });
  saveItems();
  refreshDetailPin(item);
  renderFilterBar();
  renderShortlist();
  renderWatchlist();
  refocusOpenerCard(item);
  const $pin = document.querySelector('#detailPinSlot .btn-pin');
  if ($pin) $pin.focus();
}

function closeDetailModal() {
  $detailModal.classList.remove('open');
  closeOverlay($detailModal);
}

// ---- Add Modal ----
function openAddModal(prefillQuery) {
  if (!SYNC_ENABLED) {
    openSyncModal();
    return;
  }
  resetAddModal();
  $addModal.classList.add('open');
  openOverlay($addModal, null);
  if (typeof prefillQuery === 'string' && prefillQuery.trim()) {
    const q = prefillQuery.trim();
    $searchInput.value = q;
    $searchClear.classList.remove('hidden');
    $searchInput.dispatchEvent(new Event('input'));
  }
  setTimeout(() => $searchInput.focus(), 300);
}

function closeAddModal() {
  $addModal.classList.remove('open');
  closeOverlay($addModal);
  resetAddModal();
}

function resetAddModal() {
  searchSeq++;
  clearTimeout(searchTimeout);
  $searchInput.value = '';
  $searchClear.classList.add('hidden');
  $searchResults.innerHTML = '';
  $searchResults.classList.remove('hidden');
  $serviceSelect.classList.add('hidden');
  document.querySelector('.search-wrapper').classList.remove('hidden');
  const availEl = document.getElementById('availabilityInfo');
  if (availEl) availEl.remove();
  selectedTmdb = null;
  selectedService = null;
  availableServices = [];
}

// ---- Events ----
function bindEvents() {
  document.getElementById('btnAdd').addEventListener('click', openAddModal);

  document.getElementById('modalClose').addEventListener('click', closeAddModal);
  $addModal.addEventListener('click', (e) => {
    if (e.target === $addModal) closeAddModal();
  });
  $detailModal.addEventListener('click', (e) => {
    if (e.target === $detailModal) { closeDetailModal(); return; }
    const skyCta = e.target.closest('a.btn-primary-cta[data-sky-copy]');
    if (skyCta) {
      const title = skyCta.getAttribute('data-sky-copy') || '';
      if (title) copyTextToClipboard(title);
      showAutoAddToast(
        title ? `„${title}" kopiert — in Sky Go einfügen (⌘V)` : 'Sky Go wird geöffnet…',
        'info',
      );
    }
  });

  // Search input
  $searchInput.addEventListener('input', (e) => {
    const q = e.target.value;
    $searchClear.classList.toggle('hidden', !q);

    clearTimeout(searchTimeout);
    const mySearch = ++searchSeq;
    if (q.length < 2) {
      $searchResults.innerHTML = '';
      return;
    }

    renderSearchResults(null);
    const run = async () => {
      let results;
      try {
        results = await searchTmdb(q);
      } catch (err) {
        if (mySearch !== searchSeq) return;
        renderSearchError(err.kind, () => { renderSearchResults(null); run(); });
        return;
      }
      if (mySearch !== searchSeq) return; // WL-41: veraltete Antwort verwerfen
      renderSearchResults(results);
    };
    searchTimeout = setTimeout(run, 400);
  });

  $searchClear.addEventListener('click', () => {
    searchSeq++;
    clearTimeout(searchTimeout);
    $searchInput.value = '';
    $searchClear.classList.add('hidden');
    $searchResults.innerHTML = '';
    $searchInput.focus();
  });

  $btnSave.addEventListener('click', addItem);

  // ---- WL-23: Kompakt-Kopf, Sheet, Overlay, Gesehen ----
  $pillFilter.addEventListener('click', openFilterSheet);
  document.getElementById('filterClose').addEventListener('click', closeFilterSheet);
  $filterModal.addEventListener('click', (e) => {
    if (e.target === $filterModal) closeFilterSheet();
  });

  $pillWoche.addEventListener('click', () => switchMainView('discover'));
  if ($tabList) $tabList.addEventListener('click', () => switchMainView('list'));
  if ($tabDiscover) $tabDiscover.addEventListener('click', () => switchMainView('discover'));
  if ($tabLiveNow) $tabLiveNow.addEventListener('click', () => switchMainView('live'));
  if ($tabLivePrime) $tabLivePrime.addEventListener('click', () => switchMainView('primetime'));
  document.getElementById('magazineModalClose').addEventListener('click', () => closeMagazineModal());
  $magazineModal.addEventListener('click', (e) => {
    if (e.target === $magazineModal) closeMagazineModal();
  });
  const $trailerClose = document.getElementById('trailerModalClose');
  if ($trailerClose) $trailerClose.addEventListener('click', closeTrailerModal);
  if ($trailerModal) {
    $trailerModal.addEventListener('click', (e) => {
      if (e.target === $trailerModal) closeTrailerModal();
    });
  }

  // V1 Live & 20:15 delegierte Events
  if ($liveView) {
    $liveView.addEventListener('click', (e) => {
      const refreshBtn = e.target.closest('[data-live-refresh]');
      if (refreshBtn) {
        fetchLiveTv({ force: true });
        return;
      }
      const trackChip = e.target.closest('[data-live-track]');
      if (trackChip) {
        activeLiveTrackFilter = trackChip.dataset.liveTrack || 'all';
        renderLiveView();
        return;
      }
      const actBtn = e.target.closest('[data-live-act][data-live-id]');
      if (actBtn) handleLiveCardEvent(actBtn.dataset.liveAct, actBtn.dataset.liveId);
    });
  }

  $seenBar.addEventListener('click', () => {
    uiState.seenOpen = !uiState.seenOpen;
    saveUiState();
    renderWatchlist();
  });

  // Filter chips
  $filterBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;

    if (chip.dataset.filter) {
      activeFilter = chip.dataset.filter;
      $filterBar.querySelectorAll('[data-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeService = null;
      $filterBar.querySelectorAll('.service-chip').forEach(c => c.classList.remove('active'));
    } else if (chip.dataset.sort) {
      activeSort = chip.dataset.sort;
      $filterBar.querySelectorAll('.sort-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    } else if (chip.dataset.service) {
      if (activeService === chip.dataset.service) {
        activeService = null;
        chip.classList.remove('active');
      } else {
        activeService = chip.dataset.service;
        $filterBar.querySelectorAll('.service-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      }
    }

    renderWatchlist();
  });

  // WL-30: Pin-Sheet — Tipp daneben oder "Abbrechen" schliesst, ein Dienst pinnt
  $pinModal.addEventListener('click', (e) => {
    if (e.target === $pinModal) { closePinSheet(); return; }
    const chip = e.target.closest('.pin-chip');
    if (chip && pinItem) {
      const item = pinItem;
      closePinSheet();
      pinService(item, chip.dataset.svc);
      const $unpin = document.querySelector('#detailUnpinSlot .btn-unpin');
      if ($unpin) $unpin.focus();
    }
  });
  document.getElementById('pinCancel').addEventListener('click', closePinSheet);

  // Sync-Key Modal
  if ($btnSyncKey) $btnSyncKey.addEventListener('click', openSyncModal);
  if ($btnEmptySyncKey) $btnEmptySyncKey.addEventListener('click', openSyncModal);
  const $syncClose = document.getElementById('syncModalClose');
  if ($syncClose) $syncClose.addEventListener('click', closeSyncModal);
  if ($syncModal) {
    $syncModal.addEventListener('click', (e) => {
      if (e.target === $syncModal) closeSyncModal();
    });
  }
  const $btnSyncSave = document.getElementById('btnSyncSave');
  if ($btnSyncSave) {
    $btnSyncSave.addEventListener('click', () => applySyncKey($syncKeyInput.value));
  }
  if ($syncKeyInput) {
    $syncKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applySyncKey($syncKeyInput.value); }
    });
  }
  const $btnSyncGen = document.getElementById('btnSyncGenerate');
  if ($btnSyncGen) {
    $btnSyncGen.addEventListener('click', () => {
      $syncKeyInput.value = generateRandomSyncKey();
      $syncKeyError.classList.add('hidden');
    });
  }
  if ($btnSyncShare) {
    $btnSyncShare.addEventListener('click', async () => {
      const key = parseInputSyncKey($syncKeyInput.value) || SYNC_KEY;
      if (!key) return;
      const shareUrl = `${window.location.origin}${window.location.pathname}?key=${encodeURIComponent(key)}`;
      const shareData = {
        title: 'Watchlist — Streaming-Watchlist',
        text: 'Hier ist der persönliche Sync-Link zu unserer Watchlist:',
        url: shareUrl,
      };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      // Fallback: E-Mail-Client via mailto: öffnen
      const subject = encodeURIComponent(shareData.title);
      const body = encodeURIComponent(`${shareData.text}\n\n${shareUrl}`);
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    });
  }
  if ($btnSyncCopyUrl) {
    $btnSyncCopyUrl.addEventListener('click', async () => {
      const key = parseInputSyncKey($syncKeyInput.value) || SYNC_KEY;
      if (!key) return;
      const shareUrl = `${window.location.origin}${window.location.pathname}?key=${encodeURIComponent(key)}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        showAutoAddToast('✓ Share-URL in Zwischenablage kopiert', 'success');
      } catch (_) {
        $syncKeyInput.value = shareUrl;
        $syncKeyInput.select();
      }
    });
  }

  // WL-23 + Magazin v3 Escape-Kette: oberstes Overlay zuerst (Trailer > Reader > Sheet/Overlay > Pin > Detail > Add > Sync).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const $reader = document.getElementById('magazineReader');
      if ($trailerModal && $trailerModal.classList.contains('open')) closeTrailerModal();
      else if ($reader && !$reader.classList.contains('hidden')) closeMagazineReader();
      else if ($filterModal.classList.contains('open')) closeFilterSheet();
      else if ($magazineModal.classList.contains('open')) closeMagazineModal();
      else if ($pinModal.classList.contains('open')) closePinSheet();
      else if ($detailModal.classList.contains('open')) closeDetailModal();
      else if ($addModal.classList.contains('open')) closeAddModal();
      else if ($syncModal && $syncModal.classList.contains('open')) closeSyncModal();
    }
  });
}

// ---- V1 Live-TV & 20:15 Programm (Getrennte Tabs: Live | 20:15 · Satellit | Magenta HD | Sky) ----
const LIVE_TV_URL = `${WORKER_BASE}/live-tv`;
let liveTvData = null;
let liveTvFetching = false;
let activeLiveTrackFilter = 'all'; // 'all' | 'sat' | 'magenta' | 'sky'
const liveTvIndex = new Map();
const LIVE_NON_TMDB_RE = /\b(tagesschau|heute\b|wetter|mittagsmagazin|morgenmagazin|nachtmagazin|punkt\s*12|brisant|hallo deutschland|bundesliga|2\.\s*bundesliga|tennis|formel\s*[12]|doppelpass|sportstudio|nachrichten|teletext|börse|boerse)\b/i;

const LIVE_SAT_ALLOW = new Set([
  'das erste', 'ard', 'zdf', 'arte', '3sat', 'zdfneo', 'zdf info', 'zdfinfo', 'one', 'kika',
  'wdr', 'wdr fernsehen', 'ndr', 'ndr fernsehen', 'br', 'br fernsehen', 'swr', 'swr sr', 'swr fernsehen',
  'mdr', 'mdr fernsehen', 'hr', 'hr fernsehen', 'rbb', 'rbb fernsehen', 'phoenix', 'tagesschau24',
  'ard alpha', 'servustv', 'servus tv', 'df1', 'eurosport 1', 'eurosport',
]);
const LIVE_MAGENTA_ALLOW = new Set([
  'rtl', 'prosieben', 'pro7', 'sat 1', 'sat1', 'vox', 'kabel eins', 'kabel 1', 'nitro', 'rtl nitro',
  'rtl zwei', 'rtlzwei', 'rtl2', 'rtl ii', 'prosieben maxx', 'pro7 maxx', 'sixx', 'sat 1 gold',
  'super rtl', 'toggo plus', 'sport1', 'dmax', 'tele 5', 'disney channel', 'comedy central',
  'welt', 'ntv', 'n tv', 'voxup', 'rtlup',
]);
const LIVE_SKY_PREFIXES = [
  'sky cinema', 'sky atlantic', 'sky showcase', 'sky one', 'sky replay',
  'sky krimi', 'sky crime', 'sky documentaries', 'sky nature', 'sky sport',
  'warner tv',
];
const LIVE_REGIONAL_SIMULCAST_RE = /^(wdr|ndr|br|swr|mdr|hr|rbb)\b/i;

function normalizeLiveChannelName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\b(hd|uhd|tv)\b/g, ' ')
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .trim();
}

function resolveReceivableTrack(it) {
  if (!it) return null;
  const raw = String(it.channel || it.shortChannel || '').replace(/\s+/g, ' ').trim();
  const rawLower = raw.toLowerCase();
  if (/kinowelt|silverline|heimatkanal|13th street|syfy|axn|romance tv|universal|history|crime \+ investigation|goldstar|motorvision|beate/i.test(rawLower)) {
    return null;
  }
  const cleanSky = rawLower.replace(/\s+(hd|uhd)$/i, '').trim();
  if (LIVE_SKY_PREFIXES.some((p) => cleanSky.startsWith(p))) return 'sky';

  const norm = normalizeLiveChannelName(raw) || normalizeLiveChannelName(it.shortChannel);
  if (LIVE_SAT_ALLOW.has(norm) || LIVE_SAT_ALLOW.has(rawLower.replace(/\s+hd$/i, '').trim())) {
    return 'sat';
  }
  if (LIVE_MAGENTA_ALLOW.has(norm) || LIVE_MAGENTA_ALLOW.has(rawLower.replace(/\s+hd$/i, '').trim())) {
    return 'magenta';
  }
  return null;
}

function isReceivableLiveItem(it) {
  return resolveReceivableTrack(it) !== null;
}

function parseHhMmMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return (Number(m[1]) % 24) * 60 + Number(m[2]);
}

function berlinNowParts(nowDate = new Date()) {
  try {
    const d = nowDate instanceof Date ? nowDate : new Date(nowDate);
    const parts = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const min = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const day = parts.find((p) => p.type === 'day')?.value || '01';
    const month = parts.find((p) => p.type === 'month')?.value || '01';
    return { minutes: (h % 24) * 60 + min, ddmm: `${day}.${month}.` };
  } catch (_) {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return { minutes: d.getHours() * 60 + d.getMinutes(), ddmm: `${dd}.${mm}.` };
  }
}

function isSportItemToday(it, todayDdMm) {
  const desc = String(it?.description || '').trim();
  const m = /^(\d{2}\.\d{2}\.)/.exec(desc);
  if (!m) return true;
  return m[1] === todayDdMm;
}

function isTimeRunningNow(startTime, endTime, nowMin) {
  const start = parseHhMmMin(startTime);
  if (start === null) return false;
  let end = parseHhMmMin(endTime);
  if (end === null) end = start + 110;
  let cur = nowMin;
  if (end <= start) end += 1440;
  if (cur < start && cur + 1440 <= end + 30) cur += 1440;
  return cur >= start && cur < end;
}

function remainingMinutesLabel(it, nowMin) {
  if (!it || !it.endTime) return '';
  const start = parseHhMmMin(it.startTime);
  let end = parseHhMmMin(it.endTime);
  if (start === null || end === null) return '';
  let cur = nowMin;
  if (end <= start) end += 1440;
  if (cur < start && cur + 1440 <= end + 30) cur += 1440;
  const rem = end - cur;
  if (rem > 0 && rem < 240) return `noch ${rem} Min.`;
  return '';
}

function normalizeLiveMatchTitle(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/^(film|serie|live|doku)\s*:\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .trim();
}

function isLiveItemOnWatchlist(liveItem) {
  if (!liveItem || !Array.isArray(items) || items.length === 0) return null;
  if (liveItem.tmdbId) {
    const byId = items.find(
      (x) => !x.watched && x.tmdbId === liveItem.tmdbId && (!liveItem.mediaType || x.type === liveItem.mediaType),
    );
    if (byId) return byId;
  }
  const target = normalizeLiveMatchTitle(liveItem.title);
  if (target.length < 4) return null;
  return items.find((x) => !x.watched && normalizeLiveMatchTitle(x.title) === target) || null;
}

function normalizeLiveItemTrack(it) {
  const resolved = resolveReceivableTrack(it);
  if (!resolved) return null;
  if (it.track === resolved) return it;
  const trackLabel = resolved === 'sky' ? 'SKY · HDMI 3' : (resolved === 'magenta' ? 'MAGENTA HD' : 'SAT HD');
  const badge = resolved === 'sky' ? 'SKY' : (resolved === 'magenta' ? 'MAGENTA' : 'SAT');
  return { ...it, track: resolved, trackLabel, badge };
}

function dedupeLiveBroadcasts(list) {
  const seenExact = new Set();
  const seenSimulcast = new Set();
  const out = [];
  for (const raw of list) {
    const it = normalizeLiveItemTrack(raw);
    if (!it || !it.title || !it.channel) continue;
    const chKey = String(it.channel).toLowerCase().trim();
    const normTitle = normalizeLiveMatchTitle(it.title);
    const startKey = String(it.startTime || '').trim();
    const exactKey = `${chKey}|${startKey}|${normTitle}`;
    if (seenExact.has(exactKey)) continue;
    if (it.track === 'sat' && LIVE_REGIONAL_SIMULCAST_RE.test(it.channel) && normTitle) {
      const simKey = `regional|${startKey}|${normTitle}`;
      if (seenSimulcast.has(simKey)) continue;
      seenSimulcast.add(simKey);
    }
    seenExact.add(exactKey);
    out.push(it);
  }
  return out;
}

function liveItemSortScore(it) {
  const wl = isLiveItemOnWatchlist(it) ? 1000 : 0;
  const rating = it.rating ? Math.round(Number(it.rating) * 10) : 0;
  const img = it.imageUrl || it.posterPath ? 40 : 0;
  const track = it.track === 'sky' ? 20 : (it.track === 'sat' ? 15 : 10);
  return wl + img + rating + track;
}

function buildLiveNowItems(data, nowDate = new Date()) {
  if (!data) return [];
  const { minutes, ddmm } = berlinNowParts(nowDate);
  const runningSport = (Array.isArray(data.sport) ? data.sport : [])
    .filter((s) => s && isSportItemToday(s, ddmm) && (s.isLive || isTimeRunningNow(s.startTime, s.endTime, minutes)))
    .map((s) => ({ ...s, isLive: true }));
  const nowBase = Array.isArray(data.now) ? data.now : [];
  const merged = dedupeLiveBroadcasts([...runningSport, ...nowBase].map((it) => ({ ...it, isLive: true })));
  return merged.sort((a, b) => liveItemSortScore(b) - liveItemSortScore(a));
}

function buildPrimetimeItems(data, nowDate = new Date()) {
  if (!data) return [];
  const { ddmm } = berlinNowParts(nowDate);
  const eveningSport = (Array.isArray(data.sport) ? data.sport : [])
    .filter((s) => s && !s.isLive && isSportItemToday(s, ddmm));
  const primeBase = Array.isArray(data.primetime) ? data.primetime : [];
  const inPrimetimeWindow = [...primeBase, ...eveningSport].filter((it) => {
    const startMin = parseHhMmMin(it?.startTime);
    return startMin !== null && startMin >= 19 * 60 + 45 && startMin <= 21 * 60 + 15;
  });
  const merged = dedupeLiveBroadcasts(inPrimetimeWindow.map((it) => ({ ...it, isLive: false })));
  return merged.sort((a, b) => {
    const wlDiff = (isLiveItemOnWatchlist(b) ? 1 : 0) - (isLiveItemOnWatchlist(a) ? 1 : 0);
    if (wlDiff !== 0) return wlDiff;
    const startDiff = (parseHhMmMin(a.startTime) || 9999) - (parseHhMmMin(b.startTime) || 9999);
    const metaDiff = (b.tmdbId || b.imageUrl ? 1 : 0) - (a.tmdbId || a.imageUrl ? 1 : 0);
    if (metaDiff !== 0) return metaDiff;
    if (startDiff !== 0) return startDiff;
    return liveItemSortScore(b) - liveItemSortScore(a);
  });
}

function indexLiveTvData(data, nowDate = new Date()) {
  liveTvIndex.clear();
  if (!data) return;
  [...buildLiveNowItems(data, nowDate), ...buildPrimetimeItems(data, nowDate)].forEach((it) => {
    if (it && it.id) liveTvIndex.set(it.id, it);
  });
}

function liveStreamButtonLabel(it) {
  if (!it) return 'Livestream ↗';
  if (it.track === 'sky') return isMacDesktop() ? 'Sky Go öffnen ↗' : 'Sky Guide ↗';
  if (it.track === 'magenta') return 'MagentaTV Live ↗';
  if (it.mediathekServiceId === 'ard') return 'ARD Livestream ↗';
  if (it.mediathekServiceId === 'zdf') return 'ZDF Livestream ↗';
  if (it.mediathekServiceId === 'arte') return 'ARTE Livestream ↗';
  if (it.mediathekServiceId === '3sat') return '3sat Livestream ↗';
  if (it.mediathekServiceId === 'kika') return 'KiKA Livestream ↗';
  return 'Livestream ↗';
}

function isPrimetimeTunableNow(nowDate = new Date()) {
  const { minutes } = berlinNowParts(nowDate);
  return minutes >= 20 * 60 + 10 || minutes < 60;
}

function renderLiveCardHtml(it, { viewMode = 'live', nowMin = 0, primetimeTunable = false } = {}) {
  const matchedItem = isLiveItemOnWatchlist(it);
  const imgUrl = it.imageUrl || (it.posterPath ? tmdbPoster(it.posterPath, 'w500') : '');
  const track = it.track || 'sat';
  const badgeText = esc(it.badge || it.trackLabel || 'SAT');
  const remText = viewMode === 'live' ? remainingMinutesLabel(it, nowMin) : '';
  const statusText = matchedItem
    ? '★ Watchlist'
    : (viewMode === 'live' ? (remText ? `● LIVE · ${remText}` : '● LIVE') : (it.startTime ? `${it.startTime} Uhr` : '20:15 Uhr'));
  const statusCls = matchedItem ? 'match' : (viewMode === 'live' ? 'live' : 'time');

  const metaParts = [];
  if (viewMode === 'live') {
    if (it.startTime) metaParts.push(`seit ${it.startTime} Uhr`);
    if (remText) metaParts.push(remText);
  } else {
    if (it.startTime) metaParts.push(`Heute ${it.startTime} Uhr`);
  }
  metaParts.push(it.channel || it.shortChannel || '');
  if (it.rating) metaParts.push(`★ ${Number(it.rating).toFixed(1)}`);

  const progBar = viewMode === 'live' && it.progressPct > 0
    ? `<div class="live-progress-track"><div class="live-progress-fill" style="width:${Math.min(100, Math.max(4, Number(it.progressPct)))}%"></div></div>`
    : '';

  const nonMovie = LIVE_NON_TMDB_RE.test(it.title || '');
  const allowAdd = !!matchedItem || !nonMovie;
  const allowTrailer = !!it.tmdbId || !nonMovie;
  const trackCls = track === 'sky' ? ' track-sky' : track === 'magenta' ? ' track-magenta' : '';
  const chFallbackTag = track === 'sky' ? 'Sky Stream · HDMI 3' : (track === 'magenta' ? 'MagentaTV HD' : 'Satellit · Free-TV HD');

  let actionsHtml = '';
  if (viewMode === 'primetime' && !primetimeTunable) {
    const primaryBtn = matchedItem
      ? `<button class="live-cta-btn is-primary" type="button" data-live-act="detail" data-live-id="${escAttr(it.id)}">★ Watchlist</button>`
      : (allowAdd
        ? `<button class="live-cta-btn is-primary" type="button" data-live-act="add" data-live-id="${escAttr(it.id)}">+ Merkliste</button>`
        : `<button class="live-cta-btn${trackCls}" type="button" data-live-act="open" data-live-id="${escAttr(it.id)}">${esc(liveStreamButtonLabel(it))}</button>`);
    const trailerBtn = allowTrailer
      ? `<button class="live-sec-btn" type="button" data-live-act="trailer" data-live-id="${escAttr(it.id)}" aria-label="Trailer zu ${escAttr(it.title)} ansehen">▶ Trailer</button>`
      : '';
    const senderBtn = allowAdd
      ? `<button class="live-sec-btn" type="button" data-live-act="open" data-live-id="${escAttr(it.id)}" title="${escAttr(liveStreamButtonLabel(it))}" aria-label="${escAttr(it.channel + ' öffnen')}">Sender ↗</button>`
      : '';
    actionsHtml = `<div class="live-card-actions">${primaryBtn}${trailerBtn}${senderBtn}</div>`;
  } else {
    const trailerBtn = allowTrailer
      ? `<button class="live-sec-btn" type="button" data-live-act="trailer" data-live-id="${escAttr(it.id)}" aria-label="Trailer zu ${escAttr(it.title)} ansehen">▶ Trailer</button>`
      : '';
    const listBtn = allowAdd
      ? `<button class="live-sec-btn${matchedItem ? ' on-list' : ''}" type="button" data-live-act="${matchedItem ? 'detail' : 'add'}" data-live-id="${escAttr(it.id)}" aria-label="${matchedItem ? escAttr(it.title + ' auf Watchlist ansehen') : escAttr(it.title + ' auf Watchlist setzen')}">${matchedItem ? '✓ Liste' : '+'}</button>`
      : '';
    actionsHtml = `<div class="live-card-actions"><button class="live-cta-btn${trackCls}" type="button" data-live-act="open" data-live-id="${escAttr(it.id)}">${esc(liveStreamButtonLabel(it))}</button>${trailerBtn}${listBtn}</div>`;
  }

  return `
    <article class="live-card${matchedItem ? ' is-match' : ''}">
      <div class="live-card-media">
        ${imgUrl
          ? `<img src="${escAttr(imgUrl)}" alt="" loading="lazy">`
          : `<div class="live-card-fallback track-${escAttr(track)}"><span class="live-card-fallback-ch">${esc(it.shortChannel || it.channel || '')}</span><span class="live-card-fallback-tag">${esc(chFallbackTag)}</span></div>`}
        <div class="live-card-scrim"></div>
        <div class="live-card-top-badges">
          <span class="live-track-pill ${escAttr(track)}">${badgeText}</span>
          <span class="live-track-pill ${statusCls}">${esc(statusText)}</span>
        </div>
        <div class="live-card-ch">
          <span>${esc(it.shortChannel || it.channel || '')}</span>
          ${it.tmdbId && it.rating ? `<span>★ ${Number(it.rating).toFixed(1)}</span>` : ''}
        </div>
        ${progBar}
      </div>
      <div class="live-card-body">
        <h3 class="live-card-title">${esc(it.title || '')}</h3>
        <div class="live-card-meta">${esc(metaParts.filter(Boolean).join(' · '))}</div>
        ${it.description ? `<p class="live-card-desc">${esc(it.description)}</p>` : ''}
        ${actionsHtml}
      </div>
    </article>`;
}

function renderLiveView(nowDate = new Date()) {
  if (!$liveView) return;
  if (activeMainView !== 'live' && activeMainView !== 'primetime') return;

  const viewMode = activeMainView;
  indexLiveTvData(liveTvData, nowDate);
  const { minutes } = berlinNowParts(nowDate);
  const primetimeTunable = isPrimetimeTunableNow(nowDate);

  if (!liveTvData) {
    $liveView.innerHTML = `
      <div class="live-view-head">
        <div class="live-view-title-group">
          <div class="live-view-heading">
            ${viewMode === 'live' ? '<span class="live-pulse-dot" aria-hidden="true"></span>' : ''}
            <h2 class="live-view-title">${viewMode === 'live' ? 'Jetzt live im TV' : 'Heute ab 20:15 Uhr'}</h2>
          </div>
          <span class="live-view-sub">${liveTvFetching ? 'Programm wird geladen…' : 'Aktuelles TV-Programm über Satellit, MagentaTV HD & Sky Stream'}</span>
        </div>
        <button class="live-view-refresh" type="button" data-live-refresh="1"${liveTvFetching ? ' disabled' : ''}>↻ Aktualisieren</button>
      </div>
      <div class="live-empty">${liveTvFetching ? 'Lade Live-Programm…' : 'Aktuell noch keine Live-Daten geladen.'}</div>`;
    return;
  }

  const baseList = viewMode === 'live'
    ? buildLiveNowItems(liveTvData, nowDate)
    : buildPrimetimeItems(liveTvData, nowDate);

  const satCnt = baseList.filter((x) => x.track === 'sat').length;
  const magCnt = baseList.filter((x) => x.track === 'magenta').length;
  const skyCnt = baseList.filter((x) => x.track === 'sky').length;

  const trackFilter = activeLiveTrackFilter || 'all';
  const filtered = trackFilter === 'all' ? baseList : baseList.filter((x) => x.track === trackFilter);
  const matchCount = filtered.filter((x) => isLiveItemOnWatchlist(x)).length;

  const headingTitle = viewMode === 'live' ? 'Jetzt live im TV' : 'Heute ab 20:15 Uhr';
  const baseSub = viewMode === 'live'
    ? 'Laufende Sendungen · Satellit HD, MagentaTV HD & Sky Stream'
    : (primetimeTunable ? 'Abendprogramm läuft — direkt einschalten oder vormerken' : 'Abendprogramm — Trailer ansehen oder direkt auf die Merkliste setzen');
  const subText = matchCount > 0 ? `${matchCount}× auf deiner Watchlist · ${baseSub}` : baseSub;

  const filterChips = [
    { id: 'all', label: `Alle (${baseList.length})` },
    { id: 'sat', label: `Satellit HD (${satCnt})` },
    { id: 'magenta', label: `Magenta HD (${magCnt})` },
    { id: 'sky', label: `Sky Stream (${skyCnt})` },
  ].map((c) => {
    const isAct = trackFilter === c.id;
    return `<button class="filter-chip${isAct ? ' active' : ''}" type="button" data-live-track="${c.id}" aria-pressed="${String(isAct)}">${esc(c.label)}</button>`;
  }).join('');

  const cardsHtml = filtered.length > 0
    ? `<div class="live-grid">${filtered.map((it) => renderLiveCardHtml(it, { viewMode, nowMin: minutes, primetimeTunable })).join('')}</div>`
    : `<div class="live-empty">Keine Sendungen in diesem Empfangsweg gefunden.</div>`;

  $liveView.innerHTML = `
    <div class="live-view-head">
      <div class="live-view-title-group">
        <div class="live-view-heading">
          ${viewMode === 'live' ? '<span class="live-pulse-dot" aria-hidden="true"></span>' : ''}
          <h2 class="live-view-title">${esc(headingTitle)}</h2>
        </div>
        <span class="live-view-sub">${esc(subText)}</span>
      </div>
      <button class="live-view-refresh" type="button" data-live-refresh="1"${liveTvFetching ? ' disabled' : ''}>↻ Aktualisieren</button>
    </div>
    <div class="live-filter-bar" role="group" aria-label="Empfangsweg filtern">${filterChips}</div>
    ${cardsHtml}`;
}

function handleLivePrimaryAction(item) {
  if (!item) return;
  const track = resolveReceivableTrack(item) || item.track;
  if (track === 'sky') {
    if (isMacDesktop()) {
      const title = item.title || '';
      if (title) copyTextToClipboard(title);
      showAutoAddToast(
        title ? `„${title}" kopiert — in Sky Go einfügen (⌘V)` : 'Sky Go wird geöffnet…',
        'info',
      );
      try {
        window.location.href = 'skygo://';
      } catch (_) {}
      return;
    }
    window.open(item.webUrl || 'https://www.sky.de/tvguide', '_blank', 'noopener,noreferrer');
    return;
  }
  const fallback = track === 'magenta'
    ? 'https://web.magentatv.de/tv-guide'
    : 'https://www.ardmediathek.de/live';
  window.open(item.webUrl || fallback, '_blank', 'noopener,noreferrer');
}

async function handleLiveAddToWatchlist(item) {
  if (!item) return;
  const existing = isLiveItemOnWatchlist(item);
  if (existing) {
    openDetail(existing);
    return;
  }
  if (item.tmdbId && (item.mediaType === 'movie' || item.mediaType === 'tv')) {
    await addFromMagazine({
      tmdb_id: item.tmdbId,
      type: item.mediaType,
      title: item.title,
      year: '',
      poster_path: item.posterPath || null,
      backdrop_path: null,
      overview: item.description || '',
      rating: item.rating || null,
      providers_app: item.mediathekServiceId ? [item.mediathekServiceId] : [],
    });
    updateViewCounts();
    renderLiveView();
    return;
  }
  openAddModal(item.title || '');
}

function handleLiveCardEvent(action, id) {
  const item = liveTvIndex.get(id);
  if (!item) return;
  if (action === 'open') {
    handleLivePrimaryAction(item);
  } else if (action === 'trailer') {
    openTrailerModal({
      title: item.title || '',
      year: '',
      type: item.mediaType || 'movie',
      tmdbId: item.tmdbId || 0,
      trailerKey: null,
      searchQuery: `${item.title || ''} Trailer Deutsch`.trim(),
      magItem: null,
    });
  } else if (action === 'detail') {
    const existing = isLiveItemOnWatchlist(item);
    if (existing) openDetail(existing);
  } else if (action === 'add') {
    handleLiveAddToWatchlist(item);
  }
}

async function fetchLiveTv({ force = false } = {}) {
  if (!SYNC_ENABLED || liveTvFetching) return null;
  liveTvFetching = true;
  if (activeMainView === 'live' || activeMainView === 'primetime') renderLiveView();
  try {
    const url = force ? `${LIVE_TV_URL}?force=1` : LIVE_TV_URL;
    const res = await fetchT(url, { headers: { 'X-API-Key': SYNC_KEY }, cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok) return null;
    liveTvData = data;
    indexLiveTvData(data);
    updateViewCounts();
    if (activeMainView === 'live' || activeMainView === 'primetime') renderLiveView();
    return data;
  } catch (_) {
    return null;
  } finally {
    liveTvFetching = false;
    if (activeMainView === 'live' || activeMainView === 'primetime') renderLiveView();
  }
}

// ---- Für-Dich Streaming-Hub (Magazin v3) ----
const MAGAZINE_URL = `${WORKER_BASE}/magazine`;
const MAGAZINE_FEEDBACK_URL = `${WORKER_BASE}/magazine/feedback`;
const MAGAZINE_REFRESH_URL = `${WORKER_BASE}/magazine/refresh`;
let magazine = null;
let activeMainView = 'list';      // 'list' | 'discover' | 'live' | 'primetime'
let activeMagProvider = 'all';    // 'all' | serviceId | '__upcoming__'
let magRefreshing = false;
let magCurrentIdx = 0;            // legacy reader compat
let magObserver = null;
let trailerPrevFocus = null;
const trailerCache = new Map();   // "type:id" -> trailerKey | ''

const GERMAN_MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

async function fetchMagazine() {
  if (!SYNC_ENABLED) return;
  try {
    const res = await fetchT(MAGAZINE_URL, { headers: { 'X-API-Key': SYNC_KEY }, cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    magazine = data.magazine || null;
  } catch (err) {
    console.error('Magazine fetch error:', err);
  }
}

function magazineItems() {
  if (!magazine || !Array.isArray(magazine.sections)) return [];
  return magazine.sections.flatMap((s) => (s.items || []).map((it) => ({
    ...it,
    key: it.key || `${it.type || 'movie'}_${it.tmdb_id}`,
    _section: s.id,
  })));
}

function findMagazineItem(key) {
  return magazineItems().find((it) => it.key === key) || null;
}

function findWatchlistItemForMag(it) {
  if (!it) return null;
  return items.find((x) => x.tmdbId === it.tmdb_id && x.type === it.type) || null;
}

function formatIssueDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()}. ${GERMAN_MONTHS[d.getMonth()]}`;
}

function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

function matchPctForMag(it) {
  if (typeof it.match_pct === 'number' && it.match_pct > 0) return Math.round(it.match_pct);
  if (typeof it.taste_score === 'number' && it.taste_score > 0) {
    return Math.max(70, Math.min(98, Math.round(it.taste_score * 100)));
  }
  return null;
}

function updateViewCounts(nowDate = new Date()) {
  if ($tabListCount) {
    const openCount = items.filter((i) => !i.watched).length;
    $tabListCount.textContent = openCount > 0 ? String(openCount) : '';
    $tabListCount.classList.toggle('hidden', openCount === 0);
  }
  if ($tabDiscoverCount) {
    const all = magazineItems();
    const freshCount = all.filter((it) => !findWatchlistItemForMag(it)).length;
    const shown = freshCount > 0 ? freshCount : all.length;
    $tabDiscoverCount.textContent = shown > 0 ? String(shown) : '';
    $tabDiscoverCount.classList.toggle('hidden', shown === 0);
  }
  if ($tabLiveCount) {
    const liveCnt = liveTvData ? buildLiveNowItems(liveTvData, nowDate).length : 0;
    $tabLiveCount.textContent = liveCnt > 0 ? String(liveCnt) : '';
    $tabLiveCount.classList.toggle('hidden', liveCnt === 0);
  }
  if ($tabPrimeCount) {
    const primeCnt = liveTvData ? buildPrimetimeItems(liveTvData, nowDate).length : 0;
    $tabPrimeCount.textContent = primeCnt > 0 ? String(primeCnt) : '';
    $tabPrimeCount.classList.toggle('hidden', primeCnt === 0);
  }
}

function switchMainView(view) {
  const next = view === 'discover' || view === 'live' || view === 'primetime' ? view : 'list';
  if (next !== 'list' && !SYNC_ENABLED) {
    openSyncModal();
    return;
  }
  activeMainView = next;
  const tabMap = [
    [$tabList, 'list'],
    [$tabDiscover, 'discover'],
    [$tabLiveNow, 'live'],
    [$tabLivePrime, 'primetime'],
  ];
  for (const [el, id] of tabMap) {
    if (!el) continue;
    const isActive = next === id;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
  }
  if ($app) {
    $app.classList.toggle('view-discover', next === 'discover');
    $app.classList.toggle('view-live', next === 'live');
    $app.classList.toggle('view-primetime', next === 'primetime');
  }
  if ($discoverView) $discoverView.classList.toggle('hidden', next !== 'discover');
  if ($liveView) $liveView.classList.toggle('hidden', next !== 'live' && next !== 'primetime');

  if (next === 'discover') {
    renderDiscoverView();
  } else if (next === 'live' || next === 'primetime') {
    if (!liveTvData && !liveTvFetching) fetchLiveTv();
    renderLiveView();
  }
}

function renderMagazinePill() {
  // Die fruehere Sekundaer-Pille weicht dem direkten Top-Tab "Für dich"
  if ($pillWoche) $pillWoche.classList.add('hidden');
  updateViewCounts();
  if (activeMainView === 'discover') {
    renderDiscoverView();
  }
}

function filterMagazineByProvider(list, provFilter) {
  if (!provFilter || provFilter === 'all') return list;
  if (provFilter === '__upcoming__') {
    return list.filter((it) => it.is_upcoming || !(Array.isArray(it.providers_app) && it.providers_app.length > 0));
  }
  return list.filter((it) => Array.isArray(it.providers_app) && it.providers_app.includes(provFilter));
}

function buildTasteSummaryHtml() {
  const ts = (magazine && magazine.taste_summary) || null;
  const issueDate = formatIssueDate(magazine && magazine.issue && magazine.issue.date);
  const issueLabel = issueDate ? `Stand: ${esc(issueDate)}` : 'Täglich frisch kuratiert';

  let lineHtml = 'Kuratierte Neuheiten & Empfehlungen passend zu deinen Streaming-Diensten.';
  const wlCount = ts && typeof ts.watchlist_count === 'number' ? ts.watchlist_count : items.length;
  const topGenres = (ts && Array.isArray(ts.top_genres) ? ts.top_genres : []).slice(0, 3);
  const seeds = (ts && Array.isArray(ts.seed_titles) ? ts.seed_titles : []).slice(0, 2);

  if (wlCount > 0 && topGenres.length > 0) {
    const seedPart = seeds.length > 0 ? ` · Anker: <strong>${esc(seeds.join(', '))}</strong>` : '';
    lineHtml = `Gelernt aus <strong>${wlCount} ${wlCount === 1 ? 'Titel' : 'Titeln'}</strong> · Fokus: <strong>${esc(topGenres.join(', '))}</strong>${seedPart}`;
  } else if (wlCount > 0) {
    lineHtml = `Gelernt aus <strong>${wlCount} ${wlCount === 1 ? 'Titel' : 'Titeln'}</strong> auf deiner persönlichen Watchlist.`;
  }

  return `
    <div class="mag-taste-bar">
      <div class="mag-taste-info">
        <div class="mag-taste-kicker">
          <span>✦ Dein Geschmacksprofil</span>
          <span class="mag-taste-issue">${issueLabel}</span>
        </div>
        <div class="mag-taste-line">${lineHtml}</div>
      </div>
      <button class="btn-mag-refresh${magRefreshing ? ' spinning' : ''}" id="btnMagRefresh" type="button" data-mag-refresh="1"${magRefreshing ? ' disabled' : ''} title="Frische Auswahl passend zu deinem Profil mischen">
        <span class="refresh-icon" aria-hidden="true">↻</span>
        <span>${magRefreshing ? 'Mischt…' : 'Neu mischen'}</span>
      </button>
    </div>`;
}

function buildProviderFilterBarHtml(all) {
  const counts = new Map();
  let upcomingNoSvc = 0;
  for (const it of all) {
    const provs = Array.isArray(it.providers_app) ? it.providers_app : [];
    const seenInItem = new Set();
    for (const id of provs) {
      if (SERVICES.some((s) => s.id === id) && !seenInItem.has(id)) {
        seenInItem.add(id);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    if (provs.length === 0 || it.is_upcoming) upcomingNoSvc++;
  }

  // Falls aktiver Filter nicht mehr vorkommt, sauber auf Alle zurueckfallen
  if (activeMagProvider !== 'all') {
    if (activeMagProvider === '__upcoming__' && upcomingNoSvc === 0) activeMagProvider = 'all';
    else if (activeMagProvider !== '__upcoming__' && !counts.has(activeMagProvider)) activeMagProvider = 'all';
  }

  const preferredOrder = (magazine && magazine.taste_summary && Array.isArray(magazine.taste_summary.top_services))
    ? magazine.taste_summary.top_services
    : [];
  const orderedIds = Array.from(counts.keys()).sort((a, b) => {
    const pa = preferredOrder.indexOf(a);
    const pb = preferredOrder.indexOf(b);
    if (pa !== -1 || pb !== -1) {
      if (pa === -1) return 1;
      if (pb === -1) return -1;
      if (pa !== pb) return pa - pb;
    }
    return (counts.get(b) || 0) - (counts.get(a) || 0);
  });

  const chips = [
    `<button class="mag-prov-chip${activeMagProvider === 'all' ? ' active' : ''}" type="button" data-mag-prov="all">
      <span>Alle Dienste</span><span class="mag-prov-count">${all.length}</span>
    </button>`,
  ];

  for (const id of orderedIds) {
    const svc = SERVICES.find((s) => s.id === id);
    if (!svc) continue;
    chips.push(`<button class="mag-prov-chip${activeMagProvider === id ? ' active' : ''}" type="button" data-mag-prov="${escAttr(id)}">
      ${svcInlineLogoHtml(svc)}<span>${esc(svc.name)}</span><span class="mag-prov-count">${counts.get(id)}</span>
    </button>`);
  }

  if (upcomingNoSvc > 0) {
    chips.push(`<button class="mag-prov-chip${activeMagProvider === '__upcoming__' ? ' active' : ''}" type="button" data-mag-prov="__upcoming__">
      <span>🗓️ Demnächst</span><span class="mag-prov-count">${upcomingNoSvc}</span>
    </button>`);
  }

  return `<div class="mag-provider-bar" role="toolbar" aria-label="Empfehlungen nach Anbieter filtern">${chips.join('')}</div>`;
}

function primaryServiceForMag(it) {
  const provs = Array.isArray(it.providers_app) ? it.providers_app : [];
  if (activeMagProvider && activeMagProvider !== 'all' && activeMagProvider !== '__upcoming__' && provs.includes(activeMagProvider)) {
    return SERVICES.find((s) => s.id === activeMagProvider) || null;
  }
  for (const id of provs) {
    const svc = SERVICES.find((s) => s.id === id);
    if (svc) return svc;
  }
  return null;
}

function magArtFallback(img) {
  if (!img) return;
  const fb = img.dataset.fallback;
  if (fb && img.dataset.triedFallback !== '1') {
    img.dataset.triedFallback = '1';
    img.src = fb;
    return;
  }
  if (img.classList.contains('mag-hub-art')) {
    const ph = document.createElement('div');
    ph.className = 'mag-hub-ph';
    ph.setAttribute('aria-hidden', 'true');
    ph.textContent = '🎬';
    img.replaceWith(ph);
  } else {
    img.remove();
  }
}

function spotlightHeroHtml(it) {
  const posterFb = tmdbPoster(it.poster_path, 'w780');
  const bg = (it.backdrop_path ? `${TMDB_IMG}/w1280${it.backdrop_path}` : null) || posterFb;
  const svc = primaryServiceForMag(it);
  const matchPct = matchPctForMag(it);
  const wlItem = findWatchlistItemForMag(it);
  const onList = !!wlItem;
  const onShort = !!(wlItem && isOnShortlist(wlItem.id));

  const badgeDate = it.upcoming_date || it.release_date;
  let provPill = '';
  if (svc) {
    provPill = `<span class="mag-prov-pill">${svcInlineLogoHtml(svc)}${esc(svc.name)}</span>`;
  } else if (it.is_upcoming && badgeDate) {
    provPill = `<span class="mag-prov-pill upcoming">🗓️ Ab ${esc(formatShortDate(badgeDate))}</span>`;
  }

  const sectionLabel = it._section === 'demnaechst'
    ? 'Vorab-Highlight'
    : (it._section === 'entdeckt' ? 'Top-Match für dich' : 'Blockbuster & Neu im Abo');
  const metaParts = [esc(sectionLabel)];
  if (it.year) metaParts.push(esc(String(it.year)));
  if (it.type === 'tv') {
    metaParts.push(it.seasons && it.seasons > 1 ? `${it.seasons} Staffeln` : 'Serie');
  } else {
    metaParts.push(it.runtime ? `Film · ${it.runtime} Min.` : 'Film');
  }
  if (it.rating) metaParts.push(`★ ${esc(String(it.rating))}`);
  if (it.certification) metaParts.push(`FSK ${esc(String(it.certification))}`);

  const fanNote = it.fan_of && (!it.reason || !it.reason.includes(it.fan_of))
    ? ` · Für Fans von „${esc(it.fan_of)}"`
    : '';
  const reasonText = it.reason
    ? `${esc(it.reason)}${fanNote}`
    : `Passend zu deinem Geschmacksprofil ausgewählt${fanNote}`;

  const addLabel = onList
    ? '✓ Gemerkt'
    : (it.is_upcoming && !svc ? '+ Vormerken' : '+ Merkliste');

  return `
    <article class="mag-spot-hero" data-mag-key="${escAttr(it.key)}">
      ${bg ? `<img class="mag-spot-bg" src="${escAttr(bg)}"${posterFb && posterFb !== bg ? ` data-fallback="${escAttr(posterFb)}"` : ''} alt="" loading="eager" onerror="magArtFallback(this)">` : ''}
      <div class="mag-spot-scrim"></div>
      <div class="mag-spot-top">
        <div class="mag-spot-badges">
          ${provPill}
          ${matchPct ? `<span class="mag-match-chip">${matchPct}% Match</span>` : ''}
        </div>
        <button class="mag-spot-dismiss" type="button" data-mag-action="dismiss" data-mag-key="${escAttr(it.key)}" aria-label="${escAttr(it.title)} ausblenden" title="Nicht mein Geschmack — ausblenden">✕</button>
      </div>
      <div class="mag-spot-body">
        <div class="mag-spot-meta">${metaParts.join(' <span class="sep">·</span> ')}</div>
        <h2 class="mag-spot-title" data-mag-action="detail" data-mag-key="${escAttr(it.key)}">${esc(it.title)}</h2>
        ${it.overview ? `<p class="mag-spot-overview">${esc(it.overview)}</p>` : ''}
        <div class="mag-spot-reason">
          <strong>✦ Warum für dich:</strong>
          <span>${reasonText}</span>
        </div>
        <div class="mag-spot-actions">
          <button class="btn-spot-trailer" type="button" data-mag-action="trailer" data-mag-key="${escAttr(it.key)}">
            <span aria-hidden="true">▶</span><span>Trailer</span>
          </button>
          <button class="btn-spot-add${onList ? ' added' : ''}" type="button" data-mag-action="add" data-mag-key="${escAttr(it.key)}">${esc(addLabel)}</button>
          <button class="btn-spot-shortlist${onShort ? ' active' : ''}" type="button" data-mag-action="shortlist" data-mag-key="${escAttr(it.key)}" title="${onShort ? 'Auf deiner Shortlist' : 'Direkt auf Merkliste + Top-5-Shortlist setzen'}">
            <span aria-hidden="true">${onShort ? '★' : '☆'}</span><span class="shortlist-word">Shortlist</span>
          </button>
        </div>
      </div>
    </article>`;
}

function hubCardHtml(it) {
  const posterFb = tmdbPoster(it.poster_path, 'w500');
  const art = tmdbBackdrop(it.backdrop_path) || posterFb;
  const svc = primaryServiceForMag(it);
  const matchPct = matchPctForMag(it);
  const wlItem = findWatchlistItemForMag(it);
  const onList = !!wlItem;
  const badgeDate = it.upcoming_date || it.release_date;

  const marker = svc
    ? svcMarkerHtml(svc)
    : `<div class="card-badge-vorgemerkt">${it.is_upcoming && badgeDate ? `ab ${esc(formatShortDate(badgeDate))}` : 'Vorschau'}</div>`;

  const metaBits = [];
  if (it.year) metaBits.push(esc(String(it.year)));
  metaBits.push(it.type === 'tv' ? 'Serie' : 'Film');
  if (it.rating) metaBits.push(`★ ${esc(String(it.rating))}`);
  if (it.genres && it.genres[0]) metaBits.push(esc(it.genres[0]));

  const reason = it.reason || (it.fan_of ? `Für Fans von „${it.fan_of}"` : 'Passend zu deinem Profil');
  const addLabel = onList
    ? '✓ Gemerkt'
    : (it.is_upcoming && !svc ? '+ Vormerken' : '+ Merkliste');

  return `
    <article class="mag-hub-card" data-mag-key="${escAttr(it.key)}">
      <div class="mag-hub-media" data-mag-action="detail" data-mag-key="${escAttr(it.key)}">
        ${art ? `<img class="mag-hub-art" src="${escAttr(art)}"${posterFb && posterFb !== art ? ` data-fallback="${escAttr(posterFb)}"` : ''} alt="" loading="lazy" onerror="magArtFallback(this)">` : '<div class="mag-hub-ph" aria-hidden="true">🎬</div>'}
        ${marker}
        ${matchPct ? `<span class="mag-hub-match">${matchPct}%</span>` : ''}
        <button class="mag-hub-trailer" type="button" data-mag-action="trailer" data-mag-key="${escAttr(it.key)}" aria-label="Trailer zu ${escAttr(it.title)} abspielen">▶ Trailer</button>
      </div>
      <div class="mag-hub-body">
        <h3 class="mag-hub-title" data-mag-action="detail" data-mag-key="${escAttr(it.key)}">${esc(it.title)}</h3>
        <div class="mag-hub-meta">${metaBits.join(' · ')}</div>
        <p class="mag-hub-reason">${esc(reason)}</p>
        <div class="mag-hub-actions">
          <button class="btn-hub-add${onList ? ' added' : ''}" type="button" data-mag-action="add" data-mag-key="${escAttr(it.key)}">${esc(addLabel)}</button>
          <button class="btn-hub-dismiss" type="button" data-mag-action="dismiss" data-mag-key="${escAttr(it.key)}" aria-label="${escAttr(it.title)} ausblenden" title="Nicht mein Geschmack — ausblenden">✕</button>
        </div>
      </div>
    </article>`;
}

function pickSpotlightItem(filtered) {
  if (!filtered.length) return null;
  const neuWithTrailer = filtered.find((it) => it._section === 'neu' && it.backdrop_path && it.trailer_key);
  if (neuWithTrailer) return neuWithTrailer;
  const anyWithTrailer = filtered.find((it) => it.backdrop_path && it.trailer_key);
  if (anyWithTrailer) return anyWithTrailer;
  return filtered[0];
}

function renderDiscoverView() {
  if (!$discoverView) return;
  const all = magazineItems();

  if (all.length === 0) {
    $discoverView.innerHTML = `
      ${buildTasteSummaryHtml()}
      <div class="mag-empty-hub">
        <div class="empty-icon" aria-hidden="true">✨</div>
        <h3>Deine Empfehlungen werden vorbereitet</h3>
        <p>Wir gleichen deine Watchlist, bevorzugten Dienste und aktuellen Streaming-Starts ab. Starte jetzt direkt deinen ersten persönlichen Durchlauf.</p>
        <button class="btn-mag-refresh${magRefreshing ? ' spinning' : ''}" type="button" data-mag-refresh="1"${magRefreshing ? ' disabled' : ''}>
          <span class="refresh-icon" aria-hidden="true">↻</span>
          <span>${magRefreshing ? 'Empfehlungen werden geladen…' : 'Jetzt Empfehlungen erstellen'}</span>
        </button>
      </div>`;
    return;
  }

  const providerBarHtml = buildProviderFilterBarHtml(all);
  const filtered = filterMagazineByProvider(all, activeMagProvider);
  const hero = pickSpotlightItem(filtered);
  const heroKey = hero ? hero.key : null;

  const railDefs = [
    { id: 'neu', icon: '🔥', title: 'Blockbuster & Neu im Abo', sub: 'Frisch gestartet bei deinen Diensten' },
    { id: 'entdeckt', icon: '🎯', title: 'Aus deiner Liste gelernt', sub: 'Direkt aus deinen Favoriten abgeleitet' },
    { id: 'demnaechst', icon: '🗓️', title: 'Demnächst vormerken', sub: 'Kommende Neustarts zum Vorab-Speichern' },
  ];

  const railsHtml = railDefs.map((def) => {
    const secItems = filtered.filter((it) => it._section === def.id && it.key !== heroKey);
    if (secItems.length === 0) return '';
    return `
      <section class="mag-rail-section" data-rail="${def.id}">
        <div class="mag-rail-head">
          <h3 class="mag-rail-title">${def.icon} ${esc(def.title)}</h3>
          <span class="mag-rail-sub">${secItems.length} ${secItems.length === 1 ? 'Tipp' : 'Tipps'}</span>
        </div>
        <div class="mag-rail-grid">
          ${secItems.map(hubCardHtml).join('')}
        </div>
      </section>`;
  }).filter(Boolean).join('');

  $discoverView.innerHTML = `
    ${buildTasteSummaryHtml()}
    ${providerBarHtml}
    ${hero ? spotlightHeroHtml(hero) : ''}
    ${railsHtml}`;
}

function refreshDiscoverButtonStates() {
  if (!$discoverView || activeMainView !== 'discover') return;
  $discoverView.querySelectorAll('[data-mag-action="add"]').forEach((btn) => {
    const it = findMagazineItem(btn.dataset.magKey);
    if (!it) return;
    const onList = !!findWatchlistItemForMag(it);
    const svc = primaryServiceForMag(it);
    btn.classList.toggle('added', onList);
    btn.textContent = onList ? '✓ Gemerkt' : (it.is_upcoming && !svc ? '+ Vormerken' : '+ Merkliste');
  });
  $discoverView.querySelectorAll('[data-mag-action="shortlist"]').forEach((btn) => {
    const it = findMagazineItem(btn.dataset.magKey);
    if (!it) return;
    const wlItem = findWatchlistItemForMag(it);
    const onShort = !!(wlItem && isOnShortlist(wlItem.id));
    btn.classList.toggle('active', onShort);
    btn.innerHTML = `<span aria-hidden="true">${onShort ? '★' : '☆'}</span><span class="shortlist-word">Shortlist</span>`;
  });
}

// ---- Magazin-Detail-Sheet (#magazineModal) ----
function openMagazineItemDetail(key) {
  const it = findMagazineItem(key);
  if (!it || !$magazineModal || !$magazineModalBody) return;

  const titleEl = document.getElementById('magazineModalTitle');
  if (titleEl) titleEl.textContent = it.title || 'Empfehlung';

  const hero = tmdbBackdrop(it.backdrop_path) || tmdbPoster(it.poster_path, 'w500');
  const matchPct = matchPctForMag(it);
  const wlItem = findWatchlistItemForMag(it);
  const onList = !!wlItem;
  const onShort = !!(wlItem && isOnShortlist(wlItem.id));

  const lang = it.original_language
    ? (LANG_MAP[it.original_language] || it.original_language.toUpperCase()) : null;
  const facts = [];
  if (matchPct) facts.push({ big: `${matchPct}% Match`, small: 'Dein Profil', accent: true });
  if (it.rating) facts.push({ big: `★ ${it.rating}`, small: 'TMDB-Wertung' });
  if (it.type === 'tv' && (it.episodes || it.seasons)) {
    facts.push({ big: it.seasons && it.seasons > 1 ? `${it.seasons} Staffeln` : `${it.episodes || '?'} Folgen`, small: 'Umfang' });
  } else if (it.runtime) {
    facts.push({ big: `${it.runtime} Min.`, small: 'Laufzeit' });
  }
  if (it.certification) facts.push({ big: `FSK ${esc(it.certification)}`, small: lang ? esc(lang) : 'Freigabe' });
  else if (it.director) facts.push({ big: esc(it.director), small: 'Regie / Idee' });

  const provBadges = (Array.isArray(it.providers_app) ? it.providers_app : [])
    .map((id) => SERVICES.find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => `<div class="detail-provider-badge with-logo is-current">${svcInlineLogoHtml(s)}${esc(s.name)}</div>`)
    .join('');

  const castHtml = (it.cast && it.cast.length) ? `
    <div class="mag-cast">${it.cast.slice(0, 4).map((m) => {
      const photo = tmdbProfile(m.profile_path);
      const inner = photo
        ? `<img src="${escAttr(photo)}" alt="" loading="lazy">`
        : `<span class="mag-cast-ini">${esc(initials(m.name))}</span>`;
      return `<div class="mag-cast-m"><div class="mag-cast-av">${inner}</div><span class="mag-cast-name">${esc(m.name)}</span></div>`;
    }).join('')}</div>` : '';

  const deTags = [...new Set((it.keywords || []).map(deKeyword).filter(Boolean))];
  const tagsHtml = deTags.length
    ? `<div class="mag-tags">${deTags.slice(0, 4).map((k) => `<span class="mag-tag">${esc(k)}</span>`).join('')}</div>`
    : '';

  const recsHtml = (it.recommendations && it.recommendations.length) ? `
    <div class="mag-recs">
      <span class="mag-box-label mag-recs-label">Das könnte dir auch gefallen</span>
      <div class="mag-recs-row">${it.recommendations.slice(0, 2).map((r) => {
        const poster = tmdbPoster(r.poster_path, 'w185');
        return `<div class="mag-rec" role="button" tabindex="0" data-rec-id="${r.id}" data-rec-title="${escAttr(r.title)}" aria-label="${escAttr(r.title)} zur Watchlist hinzufügen">${poster ? `<img src="${escAttr(poster)}" alt="" loading="lazy">` : '<div class="mag-rec-ph"></div>'}<span class="mag-rec-title">${esc(r.title)}</span><span class="mag-rec-add" aria-hidden="true">+</span></div>`;
      }).join('')}</div>
    </div>` : '';

  const fanInline = it.fan_of && (!it.reason || !it.reason.includes(it.fan_of))
    ? ` <span class="mag-why-fan">Für Fans von ${esc(it.fan_of)}.</span>`
    : '';

  $magazineModalBody.innerHTML = `
    <div class="mag-detail-body" data-mag-key="${escAttr(it.key)}">
      ${hero ? `<div class="mag-detail-hero"><img src="${escAttr(hero)}" alt=""></div>` : ''}
      ${it.tagline ? `<p class="mag-tagline">„${esc(it.tagline)}"</p>` : ''}
      ${provBadges ? `<div class="detail-providers" style="margin-bottom:0">${provBadges}</div>` : ''}
      ${facts.length ? `<div class="mag-facts">${facts.slice(0, 4).map((f) => `<div class="mag-fact${f.accent ? ' mag-fact-accent' : ''}"><span class="mag-fact-big">${f.big}</span><span class="mag-fact-small">${f.small}</span></div>`).join('')}</div>` : ''}
      ${it.overview ? `<p class="detail-overview" style="margin-bottom:0">${esc(it.overview)}</p>` : ''}
      ${it.reason ? `<div class="mag-why"><span class="mag-box-label mag-why-label">Warum es zu dir passt</span><span class="mag-box-text">${esc(it.reason)}${fanInline}</span></div>` : ''}
      ${castHtml}
      ${tagsHtml}
      ${recsHtml}
      <div class="mag-detail-actions">
        <button class="btn-primary-cta" type="button" data-mag-modal-action="trailer" data-mag-key="${escAttr(it.key)}">
          <span aria-hidden="true">▶</span> Trailer ansehen
        </button>
        <div class="mag-detail-row">
          <button class="btn-watched" type="button" data-mag-modal-action="add" data-mag-key="${escAttr(it.key)}">
            ${onList ? '✓ Auf deiner Watchlist' : (it.is_upcoming && !provBadges ? '+ Vormerken' : '+ Auf die Watchlist')}
          </button>
          <button class="btn-shortlist${onShort ? ' on-shortlist' : ''}" type="button" data-mag-modal-action="shortlist" data-mag-key="${escAttr(it.key)}">
            ${onShort ? '★ Shortlist' : '☆ Shortlist'}
          </button>
          <button class="btn-remove" type="button" data-mag-modal-action="dismiss" data-mag-key="${escAttr(it.key)}">✕ Ausblenden</button>
        </div>
      </div>
    </div>`;

  $magazineModal.classList.add('open');
  openOverlay($magazineModal, () => {
    const c = document.getElementById('magazineModalClose');
    if (c) c.focus();
  });
}

function openMagazineModal() {
  switchMainView('discover');
}

function closeMagazineModal(opts) {
  $magazineModal.classList.remove('open');
  closeOverlay($magazineModal, !(opts && opts.restoreFocus === false));
}

function openFilterSheet() {
  $filterModal.classList.add('open');
  openOverlay($filterModal, () => { const c = document.getElementById('filterClose'); if (c) c.focus(); });
}

function closeFilterSheet() {
  $filterModal.classList.remove('open');
  closeOverlay($filterModal);
}

function maybeAutoOpenMagazine() {
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  let target = null;
  if (params.get('magazin') === '1' || viewParam === 'discover') target = 'discover';
  else if (viewParam === 'live') target = 'live';
  else if (viewParam === 'primetime') target = 'primetime';
  if (!target) return;
  params.delete('magazin');
  params.delete('view');
  const newUrl = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.replaceState({}, '', newUrl);
  if (SYNC_ENABLED) switchMainView(target);
}

// ---- Inline YouTube Trailer Player (#trailerModal) ----
function pickBestYoutubeKey(videos) {
  const list = (Array.isArray(videos) ? videos : []).filter(
    (v) => v && v.site === 'YouTube' && v.key && (v.type === 'Trailer' || v.type === 'Teaser' || v.type === 'Clip'),
  );
  const tRank = (t) => (t === 'Trailer' ? 0 : (t === 'Teaser' ? 1 : 2));
  const lRank = (l) => (l === 'de' ? 0 : (l === 'en' ? 1 : 2));
  list.sort((a, b) => {
    if (tRank(a.type) !== tRank(b.type)) return tRank(a.type) - tRank(b.type);
    if (!!b.official !== !!a.official) return (b.official ? 1 : 0) - (a.official ? 1 : 0);
    return lRank(a.iso_639_1) - lRank(b.iso_639_1);
  });
  return list.length > 0 ? list[0].key : null;
}

async function resolveTrailerKey(type, tmdbId, knownKey) {
  if (knownKey) return knownKey;
  const cacheId = `${type}:${tmdbId}`;
  if (trailerCache.has(cacheId)) return trailerCache.get(cacheId) || null;
  if (!SYNC_ENABLED || !tmdbId) return null;
  try {
    const res = await fetchT(
      `${WORKER_BASE}/tmdb/details?type=${encodeURIComponent(type)}&id=${encodeURIComponent(tmdbId)}&videos=1`,
      { headers: { 'X-API-Key': SYNC_KEY } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const key = pickBestYoutubeKey(data && data.videos && data.videos.results);
    trailerCache.set(cacheId, key || '');
    return key;
  } catch (_) {
    return null;
  }
}

function youtubeSearchUrl(title, year) {
  const q = `${title || ''} ${year || ''} Trailer Deutsch`.trim();
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

async function openTrailerModal({ title, year, type, tmdbId, trailerKey, searchQuery, magItem }) {
  if (!$trailerModal) return;
  const $title = document.getElementById('trailerModalTitle');
  const $stage = document.getElementById('trailerStage');
  const $footer = document.getElementById('trailerFooter');
  if (!$stage || !$footer) return;

  if ($title) $title.textContent = `${title || 'Trailer'} — Trailer`;
  $stage.innerHTML = '<div class="trailer-fallback"><div class="loading-spinner"></div><span>Trailer wird geladen…</span></div>';
  $footer.innerHTML = '';

  const hadUnderlyingModal = ($detailModal && $detailModal.classList.contains('open'))
    || ($magazineModal && $magazineModal.classList.contains('open'));
  trailerPrevFocus = hadUnderlyingModal ? lastFocused : null;

  $trailerModal.classList.add('open');
  openOverlay($trailerModal, () => {
    const c = document.getElementById('trailerModalClose');
    if (c) c.focus();
  });

  const resolvedKey = await resolveTrailerKey(type, tmdbId, trailerKey);
  if (!$trailerModal.classList.contains('open')) return;

  const ytSearch = searchQuery
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`
    : youtubeSearchUrl(title, year);
  const ytDirect = resolvedKey
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(resolvedKey)}`
    : ytSearch;

  if (resolvedKey) {
    if (magItem && !magItem.trailer_key) magItem.trailer_key = resolvedKey;
    const embedSrc = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(resolvedKey)}?autoplay=1&playsinline=1&rel=0`;
    $stage.innerHTML = `<iframe src="${escAttr(embedSrc)}" title="Trailer zu ${escAttr(title || '')}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else {
    $stage.innerHTML = `
      <div class="trailer-fallback">
        <p>Für „${esc(title || '')}" liegt bei TMDB noch kein direkter Video-Code vor.</p>
        <a class="btn-primary-cta" style="padding:0 22px" href="${escAttr(ytSearch)}" target="_blank" rel="noopener">
          <span aria-hidden="true">▶</span> Trailer direkt auf YouTube öffnen <span class="btn-cta-ext" aria-hidden="true">↗</span>
        </a>
      </div>`;
  }

  const onList = items.some((x) => x.tmdbId === tmdbId && x.type === type);
  const addBtnHtml = magItem
    ? `<button class="btn-spot-add${onList ? ' added' : ''}" id="trailerAddBtn" type="button" style="flex:0 0 auto">${onList ? '✓ Auf deiner Merkliste' : '+ Auf meine Merkliste'}</button>`
    : '<span></span>';

  $footer.innerHTML = `
    ${addBtnHtml}
    <a class="btn-yt-ext" href="${escAttr(ytDirect)}" target="_blank" rel="noopener">
      <span>Auf YouTube öffnen</span><span aria-hidden="true">↗</span>
    </a>`;

  const $addBtn = document.getElementById('trailerAddBtn');
  if ($addBtn && magItem) {
    $addBtn.addEventListener('click', async () => {
      if (findWatchlistItemForMag(magItem)) return;
      $addBtn.disabled = true;
      $addBtn.textContent = 'Wird gespeichert…';
      await addFromMagazine(magItem);
      $addBtn.disabled = false;
      $addBtn.classList.add('added');
      $addBtn.textContent = '✓ Auf deiner Merkliste';
    });
  }
}

function closeTrailerModal() {
  if (!$trailerModal || !$trailerModal.classList.contains('open')) return;
  const $stage = document.getElementById('trailerStage');
  if ($stage) $stage.innerHTML = ''; // Stoppt YouTube-Audio sofort
  $trailerModal.classList.remove('open');
  closeOverlay($trailerModal);
  if (($detailModal && $detailModal.classList.contains('open'))
      || ($magazineModal && $magazineModal.classList.contains('open'))) {
    setBackgroundInert(true);
    if (trailerPrevFocus) lastFocused = trailerPrevFocus;
  }
  trailerPrevFocus = null;
}

function openTrailerModalForMagKey(key) {
  const it = findMagazineItem(key);
  if (!it) return;
  openTrailerModal({
    title: it.title,
    year: it.year,
    type: it.type,
    tmdbId: it.tmdb_id,
    trailerKey: it.trailer_key || null,
    searchQuery: it.trailer_search_query || null,
    magItem: it,
  });
}

function openTrailerForWatchlistItem(item) {
  if (!item) return;
  openTrailerModal({
    title: item.title,
    year: item.year,
    type: item.type,
    tmdbId: item.tmdbId,
    trailerKey: null,
    searchQuery: `${item.title || ''} ${item.year || ''} Trailer Deutsch`.trim(),
    magItem: null,
  });
}

// ---- Magazin-Interaktionen: Merkliste, Shortlist, Ausblenden + Undo, Neu mischen ----
async function handleMagAddClick(key, btn) {
  const it = findMagazineItem(key);
  if (!it) return;
  const existing = findWatchlistItemForMag(it);
  if (existing) {
    if ($magazineModal && $magazineModal.classList.contains('open')) closeMagazineModal({ restoreFocus: false });
    openDetail(existing);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Speichert…';
  }
  await addFromMagazine(it);
  if (btn) btn.disabled = false;
  refreshDiscoverButtonStates();
}

async function handleMagShortlistClick(key, btn) {
  const it = findMagazineItem(key);
  if (!it) return;
  let wlItem = findWatchlistItemForMag(it);
  if (!wlItem) {
    if (btn) btn.disabled = true;
    await addFromMagazine(it, { silent: true });
    if (btn) btn.disabled = false;
    wlItem = findWatchlistItemForMag(it);
  }
  if (!wlItem) return;

  if (isOnShortlist(wlItem.id)) {
    removeFromShortlist(wlItem.id);
    showAutoAddToast(`„${it.title}" von Shortlist gelöst`, 'info');
  } else if (isShortlistFull()) {
    showAutoAddToast(`✓ Auf Merkliste (Shortlist voll — max. ${SHORTLIST_MAX})`, 'info');
  } else {
    addToShortlist(wlItem.id);
    showAutoAddToast(`★ „${it.title}" auf Merkliste & Shortlist`, 'success');
  }
  refreshDiscoverButtonStates();
}

async function sendMagazineFeedback(key, action, title) {
  if (!SYNC_ENABLED) return;
  try {
    await fetchT(MAGAZINE_FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SYNC_KEY },
      body: JSON.stringify({ key, action, title: title || '' }),
    });
  } catch (err) {
    console.warn('Magazine feedback failed:', err);
  }
}

function dismissMagazineItemByKey(key) {
  if (!magazine || !Array.isArray(magazine.sections)) return;
  let removedItem = null;
  let removedSectionId = null;
  let removedIndex = -1;

  for (const sec of magazine.sections) {
    if (!Array.isArray(sec.items)) continue;
    const idx = sec.items.findIndex((it) => (it.key || `${it.type}_${it.tmdb_id}`) === key);
    if (idx !== -1) {
      removedItem = sec.items[idx];
      removedSectionId = sec.id;
      removedIndex = idx;
      sec.items.splice(idx, 1);
      if (magazine.counts) magazine.counts[sec.id] = sec.items.length;
      break;
    }
  }
  if (!removedItem) return;

  if ($magazineModal && $magazineModal.classList.contains('open')) {
    closeMagazineModal();
  }
  updateViewCounts();
  renderDiscoverView();
  sendMagazineFeedback(key, 'dismiss', removedItem.title);

  showUndoBar(`„${removedItem.title}" ausgeblendet`, () => {
    const sec = magazine && Array.isArray(magazine.sections)
      ? magazine.sections.find((s) => s.id === removedSectionId)
      : null;
    if (sec && Array.isArray(sec.items)) {
      sec.items.splice(Math.min(removedIndex, sec.items.length), 0, removedItem);
      if (magazine.counts) magazine.counts[sec.id] = sec.items.length;
      updateViewCounts();
      renderDiscoverView();
    }
    sendMagazineFeedback(key, 'undo', removedItem.title);
  });
}

async function refreshMagazineNow() {
  if (!SYNC_ENABLED || magRefreshing) return;
  magRefreshing = true;
  renderDiscoverView();
  try {
    const res = await fetchT(`${MAGAZINE_REFRESH_URL}?force=1`, {
      method: 'POST',
      headers: { 'X-API-Key': SYNC_KEY },
    }, 22000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.magazine) {
      magazine = data.magazine;
      activeMagProvider = 'all';
      showAutoAddToast('✓ Frische Empfehlungen für dich gemischt', 'success');
    } else {
      showAutoAddToast('Auswahl ist bereits auf dem neuesten Stand', 'info');
    }
  } catch (err) {
    console.error('Magazine refresh error:', err);
    showAutoAddToast('Neu mischen gerade nicht erreichbar', 'error');
  } finally {
    magRefreshing = false;
    updateViewCounts();
    renderDiscoverView();
  }
}

// Legacy-Stubs fuer eventuelle Alt-Aufrufe
function openMagazineReader() { switchMainView('discover'); }
function closeMagazineReader() {}
function updateFab() {}

// ---- Vorgemerkt (service-less / upcoming watchlist items) ----

// Bookmark a title that has no streaming service yet (serviceId stays null).
// Returns false if it's already on the watchlist.
function addVorgemerkt(data) {
  if (items.some(x => x.tmdbId === data.tmdbId && x.type === data.type)) return false;
  items.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    tmdbId: data.tmdbId,
    title: data.title,
    year: data.year || '',
    type: data.type,
    poster: data.poster || null,
    backdrop: data.backdrop || null,
    overview: data.overview || '',
    rating: data.rating || null,
    serviceId: null,              // null serviceId === "vorgemerkt"
    releaseDate: data.releaseDate || null,
    lastPromoteCheck: null,
    watched: false,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    providers: data.providers || { flat: [], rent: [], buy: [] },
  });
  saveItems();
  renderFilterBar();
  renderWatchlist();
  return true;
}

// WL-28: frisch gepruefte Anbieter auf ein Item anwenden. Bleibt der gewaehlte
// Dienst ohne Zusatzkosten verfuegbar, bleibt er (manuelle Wahl respektiert);
// sonst gilt der beste. Ohne Angebot → vorgemerkt (serviceId null).
// WL-30: ein von Hand gesetzter Dienst gilt unabhaengig vom Urteil — nie 'demoted';
// hat ein aelterer Client ihn zurueckgestuft, stellt der naechste Lauf ihn wieder her.
// Rueckgabe: 'promoted' | 'changed' | 'demoted' | 'updated' | null. Mutiert das Item.
function applyProviders(item, providers) {
  const before = item.serviceId ?? null;
  let next = before;
  if (!item.watched) {
    const pinned = pinnedService(item);
    next = pinned || (providers.flat.includes(before) ? before : (providers.flat[0] || null));
  }
  const strip = (p) => JSON.stringify({ ...(p || {}), checkedAt: 0 });
  const changedProviders = strip(item.providers) !== strip(providers);
  item.providers = providers;
  if (next === before) {
    if (changedProviders) { item.updatedAt = Date.now(); return 'updated'; }
    return null;
  }
  item.serviceId = next;
  item.updatedAt = Date.now();
  if (before == null) return 'promoted';
  return next == null ? 'demoted' : 'changed';
}

function tmdbWatchUrl(item) {
  return `https://www.themoviedb.org/${item.type}/${item.tmdbId}/watch?locale=DE`;
}

// WL-43: Echter macOS-Desktop (ohne iPadOS im Desktop-Modus, das maxTouchPoints > 1 meldet).
function isMacDesktop() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav) return false;
  const ua = nav.userAgent || '';
  if (/iphone|ipad|ipod|android/i.test(ua)) return false;
  if ((nav.maxTouchPoints || 0) > 1) return false;
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /mac/i.test(platform) || /macintosh|mac os x/i.test(ua);
}

function copyTextToClipboard(text) {
  if (!text) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  try {
    const prev = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', opacity: '0', pointerEvents: 'none' });
    ($detailModal || document.body).appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (prev && typeof prev.focus === 'function') prev.focus();
    return ok;
  } catch (_) {
    return false;
  }
}

// Primaer-Aktion: direkt zum gewaehlten Anbieter (Link vom Worker: Such-Seite
// des Dienstes oder TMDB, wo keine Such-Seite belegt ist). Ohne Anbieter keine
// Primaer-Aktion — der TMDB-Link steht dann in der Quellen-Zeile.
// Ohne belegte Such-Seite (direct false) fuehrt der Knopf ehrlich beschriftet
// zur TMDB-Watch-Seite, statt "Bei <Dienst> ansehen" zu versprechen.
function detailCtaHtml(item, svc) {
  if (!svc) return '<span class="detail-cta-slot"></span>';
  let direct = !!item.providers?.direct?.[svc.id];
  let link = direct ? item.providers.links[svc.id] : tmdbWatchUrl(item);
  // Such-Seite ohne Titel-Parameter (Disney+, Paramount+): ehrlich "suchen"
  let prefilled = direct && item.providers?.prefilled?.[svc.id] !== false;
  // Selbstheilung fuer gecachte skygo://-Links aus dem ersten WL-43-Versuch:
  // sofort auf den gueltigen https-Suchlink zurueckfuehren, damit iOS nie scheitert.
  if (svc.id === 'sky' && direct && typeof link === 'string' && link.startsWith('skygo://')) {
    link = SERVICE_SEARCH.sky.replace('{q}', encodeURIComponent(item.title || ''));
    prefilled = true;
  }
  // WL-30: von Hand gesetzter Dienst ohne Worker-Link → eigene Kopie der Such-Vorlage
  if (!direct && pinnedService(item) === svc.id && SERVICE_SEARCH[svc.id]) {
    const tpl = SERVICE_SEARCH[svc.id];
    link = tpl.replace('{q}', encodeURIComponent(item.title || ''));
    direct = true;
    prefilled = tpl.includes('{q}');
  }
  // WL-43: Sky Go DE hat weder Web-Player noch Inhalts-Deep-Links, startet auf
  // macOS Desktop aber per `skygo://` die Sky Go App. Dort oeffnet der Klick die
  // App und kopiert den Titel fuer die Suche (⌘V); iOS/iPadOS/Web bleiben beim
  // fehlerfreien https-Suchlink (`sky.de/suche`).
  if (svc.id === 'sky' && direct && isMacDesktop()) {
    const skyLabel = 'Sky Go öffnen';
    return `<a class="btn-primary-cta" href="skygo://" data-sky-copy="${escAttr(item.title || '')}" aria-label="${escAttr(skyLabel)} (kopiert Titel und startet Sky Go App)">
        <span aria-hidden="true">▶</span> ${esc(skyLabel)} <span class="btn-cta-ext" aria-hidden="true">↗</span>
      </a>`;
  }
  const label = !direct ? `${svc.name}-Angebot auf TMDB` : prefilled ? `Bei ${svc.name} ansehen` : `Bei ${svc.name} suchen`;
  return `<a class="btn-primary-cta" href="${escAttr(link)}" target="_blank" rel="noopener" aria-label="${escAttr(label)} (öffnet neuen Tab)">
        <span aria-hidden="true">▶</span> ${esc(label)} <span class="btn-cta-ext" aria-hidden="true">↗</span>
      </a>`;
}

// Card badge label for a vorgemerkt item: future release date, else neutral.
function vorgemerktBadgeText(item) {
  const today = new Date().toISOString().slice(0, 10);
  if (item.releaseDate && item.releaseDate > today) {
    return `ab ${esc(formatShortDate(item.releaseDate))}`;
  }
  return 'Vorgemerkt';
}

// WL-28: beim App-Start alle ungesehenen Titel neu pruefen, deren letzte
// Pruefung aelter als 12 h ist — vorgemerkte zuerst, in Bloecken zu 40 an den
// Worker. Ersetzt den frueheren 24-h-Check nur fuer vorgemerkte Titel.
async function resolveVorgemerkt() {
  const now = Date.now();
  const due = items
    .filter(i => !i.watched && (!i.providers?.checkedAt || now - i.providers.checkedAt > AVAILABILITY_STALE_MS))
    .sort((a, b) => (a.serviceId == null ? 0 : 1) - (b.serviceId == null ? 0 : 1));
  if (due.length === 0) return;
  const results = await fetchAvailability(due.map(i => ({ type: i.type, id: i.tmdbId, title: i.title })));
  if (results.size === 0) return;
  let promoted = 0;
  let touched = false;
  for (const item of due) {
    const p = results.get(`${item.type}:${item.tmdbId}`);
    if (!p) continue;
    const r = applyProviders(item, p);
    touched = true;
    // WL-30: ein wiederhergestellter Pin ist keine neue Verfuegbarkeit — kein Toast
    if (r === 'promoted' && !pinnedService(item) && promoted++ === 0) {
      const svc = SERVICES.find(s => s.id === item.serviceId);
      showAutoAddToast(`„${item.title}" jetzt bei ${svc ? svc.name : 'einem Anbieter'}`, 'info');
    }
  }
  if (touched) { saveItems(); renderFilterBar(); renderWatchlist(); renderShortlist(); }
}

// Returns true if the title is on the watchlist afterwards. Decoupled from any
// DOM button so the single floating button can drive it (P1-2).
async function addFromMagazine(it, opts = {}) {
  if (items.some(x => x.tmdbId === it.tmdb_id && x.type === it.type)) return true;

  // WL-28: bester Anbieter per Pruefung (Profil + Rang); faellt sie aus, die
  // Magazin-Liste nach Rang (freie Mediathek zuerst), ohne checkedAt — der
  // naechste App-Start prueft dann nach.
  const checked = await fetchProviders(it.tmdb_id, it.type, it.title);
  const rankedApp = (Array.isArray(it.providers_app) ? it.providers_app : [])
    .filter(id => SERVICES.some(s => s.id === id))
    .sort((a, b) => (SERVICES.find(s => s.id === b)?.free ? 1 : 0) - (SERVICES.find(s => s.id === a)?.free ? 1 : 0));
  const magProviders = checked || { flat: rankedApp, rent: [], buy: [], rentOnly: [], links: {}, direct: {} };
  if (magProviders.flat.length > 0) {
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      tmdbId: it.tmdb_id,
      title: it.title,
      year: it.year || '',
      type: it.type,
      poster: it.poster_path,
      backdrop: it.backdrop_path,
      overview: it.overview || '',
      rating: it.rating || null,
      serviceId: magProviders.flat[0],
      watched: false,
      addedAt: Date.now(),
      updatedAt: Date.now(),
      providers: magProviders,
    };
    items.unshift(item);
    saveItems();
    renderFilterBar();
    renderWatchlist();
    if (!opts.silent) showAutoAddToast(`✓ „${it.title}" hinzugefügt`, 'success');
    return true;
  }
  // No provider yet (upcoming title) — bookmark as "vorgemerkt" directly from
  // the magazine data (no TMDB roundtrip; title/poster/date are in the JSON).
  const added = addVorgemerkt({
    tmdbId: it.tmdb_id,
    title: it.title,
    year: it.year || '',
    type: it.type,
    poster: it.poster_path,
    backdrop: it.backdrop_path,
    overview: it.overview,
    rating: it.rating,
    releaseDate: it.upcoming_date || it.release_date || null,
    providers: magProviders,
  });
  if (added && !opts.silent) showAutoAddToast(`✓ „${it.title}" vorgemerkt`, 'success');
  return true;
}

// WL-20: Empfehlungs-Karte → Titel auf die Watchlist. Rec-Daten tragen KEIN
// media_type (nur id/title/poster) → media_type per Titel-Suche (id-Match,
// sprachunabhängig) auflösen, dann direkt adden (Provider-Lookup + vorgemerkt-
// Fallback). Bewusst OHNE die Add-Modal-Maschinerie (closeAddModal würde sonst
// inert/Fokus des offenen Magazin-Readers stören).
const pendingRecAdds = new Set(); // WL-20 P2: Re-Entry-Guard gegen nebenläufigen Doppel-Klick
async function addRecommendationFromMagazine(rec) {
  if (!rec || !rec.id || pendingRecAdds.has(rec.id)) return;
  pendingRecAdds.add(rec.id);
  showAutoAddToast('Wird hinzugefügt…', 'loading');
  try {
    let results;
    try {
      results = await searchTmdb(rec.title);
    } catch {
      showAutoAddToast('Suche gerade nicht erreichbar', 'error');
      return;
    }
    const match = results.find(r => r.id === rec.id) || results.find(r => getTitle(r) === rec.title);
    if (!match) { showAutoAddToast(`„${rec.title}" konnte nicht aufgelöst werden`, 'error'); return; }
    const type = getTypeTag(match);
    // WL-20 P2: Dedup auf tmdbId+type (konsistent mit addItem/addFromMagazine/
    // addVorgemerkt; TMDB-ids sind pro media_type vergeben → erst nach Typ-
    // Auflösung autoritativ prüfbar, daher hier statt am Funktionsanfang).
    if (items.some(i => i.tmdbId === match.id && i.type === type)) {
      showAutoAddToast(`„${getTitle(match)}" ist schon auf deiner Watchlist`, 'info');
      return;
    }
    const providers = (await fetchProviders(match.id, type, getTitle(match))) || { ...EMPTY_PROVIDERS };
    const serviceId = providers.flat[0] || null;
    const rating = match.vote_average ? Math.round(match.vote_average * 10) / 10 : null;
    if (!serviceId) {
      const added = addVorgemerkt({
        tmdbId: match.id, title: getTitle(match), year: getYear(match), type,
        poster: match.poster_path, backdrop: match.backdrop_path, overview: match.overview,
        rating, releaseDate: match.release_date || match.first_air_date || null,
        providers,
      });
      showAutoAddToast(`„${getTitle(match)}" ${added ? 'vorgemerkt' : 'ist schon auf deiner Watchlist'}`, added ? 'success' : 'info');
      return;
    }
    items.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      tmdbId: match.id, title: getTitle(match), year: getYear(match), type,
      poster: match.poster_path, backdrop: match.backdrop_path, overview: match.overview || '',
      rating, serviceId, watched: false, addedAt: Date.now(), updatedAt: Date.now(), providers,
    });
    saveItems();
    renderFilterBar();
    renderWatchlist();
    showAutoAddToast(`✓ „${getTitle(match)}" hinzugefügt`, 'success');
  } catch (e) {
    console.error('Rec add error:', e);
    showAutoAddToast('Fehler beim Hinzufügen', 'error');
  } finally {
    pendingRecAdds.delete(rec.id);
    updateFab(magCurrentIdx); // WL-20 P3: FAB-Stand auffrischen, falls Rec == sichtbare Karte
  }
}

// Delegierte Handler fuer den Für-Dich Streaming-Hub (#discoverView) & das Magazin-Detail-Sheet (#magazineModalBody)
if ($discoverView) {
  $discoverView.addEventListener('click', (e) => {
    const refreshBtn = e.target.closest('[data-mag-refresh]');
    if (refreshBtn) {
      refreshMagazineNow();
      return;
    }
    const provChip = e.target.closest('[data-mag-prov]');
    if (provChip) {
      activeMagProvider = provChip.dataset.magProv || 'all';
      renderDiscoverView();
      return;
    }
    const actEl = e.target.closest('[data-mag-action]');
    if (!actEl) return;
    const action = actEl.dataset.magAction;
    const key = actEl.dataset.magKey;
    if (!key) return;
    if (action === 'trailer') { e.stopPropagation(); openTrailerModalForMagKey(key); }
    else if (action === 'add') { e.stopPropagation(); handleMagAddClick(key, actEl); }
    else if (action === 'shortlist') { e.stopPropagation(); handleMagShortlistClick(key, actEl); }
    else if (action === 'dismiss') { e.stopPropagation(); dismissMagazineItemByKey(key); }
    else if (action === 'detail') openMagazineItemDetail(key);
  });
}

if ($magazineModalBody) {
  const handleModalRec = (el) => {
    if (el) addRecommendationFromMagazine({ id: parseInt(el.dataset.recId, 10), title: el.dataset.recTitle });
  };
  $magazineModalBody.addEventListener('click', async (e) => {
    const recEl = e.target.closest('.mag-rec');
    if (recEl) { handleModalRec(recEl); return; }
    const actBtn = e.target.closest('[data-mag-modal-action]');
    if (!actBtn) return;
    const action = actBtn.dataset.magModalAction;
    const key = actBtn.dataset.magKey;
    if (!key) return;
    if (action === 'trailer') {
      openTrailerModalForMagKey(key);
    } else if (action === 'add') {
      await handleMagAddClick(key, actBtn);
      if ($magazineModal.classList.contains('open')) openMagazineItemDetail(key);
    } else if (action === 'shortlist') {
      await handleMagShortlistClick(key, actBtn);
      if ($magazineModal.classList.contains('open')) openMagazineItemDetail(key);
    } else if (action === 'dismiss') {
      dismissMagazineItemByKey(key);
    }
  });
  $magazineModalBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('.mag-rec');
    if (el) { e.preventDefault(); handleModalRec(el); }
  });
}

const $magClose = document.getElementById('magazineClose');
if ($magClose) $magClose.addEventListener('click', closeMagazineReader);

// ---- Service Worker & Offline / Install UI ----
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch((err) => {
      console.warn('Service Worker registration failed:', err);
    });
  });
}

let deferredInstallPrompt = null;

function setupOfflineAndInstallUi() {
  const $offlineBadge = document.getElementById('offlineBadge');
  const $btnInstall = document.getElementById('btnInstallPwa');

  const updateOnlineStatus = () => {
    const isOffline = !navigator.onLine;
    if ($offlineBadge) $offlineBadge.classList.toggle('hidden', !isOffline);
    document.body.classList.toggle('is-offline', isOffline);
    renderSyncBanner();
  };

  updateOnlineStatus();
  window.addEventListener('offline', () => {
    updateOnlineStatus();
    showAutoAddToast('Offline-Modus — lokale Watchlist aktiv', 'info');
  });
  window.addEventListener('online', async () => {
    updateOnlineStatus();
    if (SYNC_ENABLED) {
      retryIndex = 0;
      await pushToServer();
    }
  });
  // WL-33: Ungesendetes nachsenden, sobald die App wieder sichtbar ist.
  // WL-40: zusaetzlich still holen (hoechstens alle 10 s, ausser bei
  // Ungesendetem oder Fehler).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !SYNC_ENABLED) return;
    const last = Number(lsGet('watchlist_last_sync')) || 0;
    if (hasUnsent() || syncProblem || Date.now() - last > 10000) {
      retryIndex = 0;
      pullFromServer();
    }
  });
  const $syncBannerBtn = document.getElementById('syncBannerBtn');
  if ($syncBannerBtn) $syncBannerBtn.addEventListener('click', () => {
    if (syncProblem === 'auth') { openSyncModal(); return; }
    retryIndex = 0;
    pullFromServer();
  });

  if (!$btnInstall) return;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) return;

  const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
  if (isIOS) {
    $btnInstall.classList.remove('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $btnInstall.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    $btnInstall.classList.add('hidden');
  });

  $btnInstall.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredInstallPrompt = null;
        $btnInstall.classList.add('hidden');
      }
    } else if (isIOS) {
      showAutoAddToast('iOS: Tippe in Safari auf „Teilen" → „Zum Home-Bildschirm"', 'info');
    }
  });
}

// ---- Boot ----
init();
