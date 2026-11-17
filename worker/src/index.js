// Watchlist Sync API + Wochen-Magazin Engine — Cloudflare Worker + KV
// Multi-tenant: each sync key = separate watchlist namespace
//
// Endpoints:
//   GET  /sync           — return the caller's watchlist (auth: X-API-Key header)
//   PUT  /sync           — save the caller's watchlist (auth: X-API-Key header)
//   GET  /magazine       — return the caller's weekly magazine JSON (auth: X-API-Key)
//   POST /magazine-build — manual trigger of magazine pipeline
//                          auth: X-Admin-Key header == env.ADMIN_KEY
//                          ?dryRun=1   → skip Telegram + KV writes, return preview JSON
//                          ?member=KEY → build a specific member (default: owner)
//   POST /rebuild-taste  — manual taste-profile rebuild (auth: X-Admin-Key)
//                          ?member=KEY → rebuild a specific member (default: owner)
//   WL-34 (2026-10-27): Jede X-API-Key-Route (/sync, /magazine, /tmdb/*,
//   /availability) nimmt nur bekannte Schluessel an: OWNER_SYNC_KEY, API_KEY,
//   der Magazin-Roster (config:magazine_members) und die Liste config:sync_keys
//   in KV. Die Liste steht nie im (oeffentlichen) Repo. Entfernen aus
//   config:sync_keys sperrt nur, wenn der Schluessel weder Owner noch im Roster
//   ist. PUT /sync: hoechstens MAX_SYNC_BYTES, kaputtes JSON -> 400.
//   GET  /tmdb/search    — TMDB-Suche fuer die App (auth: X-API-Key), ?q=
//   GET  /tmdb/details   — TMDB-Details fuer die App (auth: X-API-Key), ?type=&id=
//   POST /availability   — WL-28: bester Anbieter je Titel (auth: X-API-Key),
//                          Body {items:[{type,id,title}]}, hoechstens
//                          AVAILABILITY_BATCH_MAX Titel je Aufruf
//
// Scheduled handler (see wrangler.toml [triggers].crons) — WL-11 multi-tenant:
//   "0 3 * * *"  → daily taste pre-warm for that day's roster member
//   "0 16 * * *" → daily magazine build for that day's roster member
//   Member = roster[floor(scheduledTime/86400000) % roster.length] — a
//   stateless round-robin: both crons pick the SAME member on a given UTC day.
//
// WL-5 (2026-06-11): Wochen-Magazin ersetzt die taegliche Telegram-Empfehlung.
//   Kein popular-per-provider-Katalogbestand mehr — nur Neuerscheinungen
//   (letzte 30d) + Demnaechst (naechste 14d), taste-ranked, als Magazin-JSON
//   in KV. Die App rendert das Magazin und IST die Benachrichtigung (Teaser
//   beim Oeffnen) — Telegram nur noch im Fehlerfall (silent-stale-Schutz,
//   Customer-Entscheid 2026-06-11). Subrequest-Budget hart gedeckelt
//   (Free-Tier 50/Invocation).
// WL-11 (2026-06-14): Magazin pro Familienmitglied. Die Build-Pipeline ist auf
//   einen `syncKey` parametrisiert (Default = Owner); ein KV-Roster
//   (config:magazine_members) listet die Member, der Owner ist immer dabei.
//   Crons rotieren zustandslos ueber den Roster (ein Member pro Tag), jede
//   Invocation = ein Member = frisches 50-Subrequest-Budget. Read-Seite war
//   schon multi-tenant (magazine:${apiKey}) — keine App-Aenderung noetig.
// Plan B (2026-05-14): Producer-Konsolidierung Mac/GHA/CC → Worker als
//   single source. Match-Schwelle MEDIUM = scoreWithTaste >= 0.35.
// WL-22 (2026-07-30): Ausbeute-Kollaps-Fix. Kill-Counter je Rubrik (Messung
//   vor jeder weiteren Schrauben-Drehung), Score-Renormalisierung bei fehlenden
//   Signalen (discover hat nie cast, Demnaechst oft vote_average=0 — fehlende
//   Daten sind keine schlechten Daten), neue Katalog-Rubrik "entdeckt"
//   (taste-genre-basierte Perlen ohne Datumsfenster — der Pool erschoepft
//   nicht), Taste-Prewarm-Sample 30 + watched-Titel doppelt gewichtet.
// WL-42 (2026-10-27): Seit WL-33 tragen die Sync-Daten Loesch-Marker
//   ({ ...titel, deleted: true, updatedAt }, 30 Tage). PUT /sync ersetzt den
//   KV-Stand nicht mehr, sondern fuehrt ihn mit mergeItems aus sync-merge.js
//   (dieselbe Regel wie die App) mit dem Body zusammen; ein kaputter KV-Stand
//   zaehlt als leer. GET /sync liefert die Marker weiter aus. Das
//   Geschmacksprofil sieht nur lebende Titel; der Magazin-Ausschluss behaelt
//   die Marker, damit gerade geloeschte Titel nicht als Empfehlung kommen.
//   Grenze: KV ist nicht transaktional, zwei Speicherungen von verschiedenen
//   Cloudflare-Standorten innerhalb etwa einer Minute koennen sich weiter
//   ueberschreiben.
// WL-NUTZUNG-MESSEN (2026-10-30): Tageszaehler je Pseudonym in Cloudflare D1
//   (Binding NUTZUNG_DB, Datenbank watchlist-nutzung, Schema
//   worker/schema/nutzung.sql). GET /sync zaehlt `abrufe`, PUT /sync
//   `sendungen`; `wer` = erste 12 Hex-Zeichen von SHA-256(Sync-Schluessel),
//   kein Titel, kein Schluessel. Gezaehlt wird nach der Antwort
//   (ctx.waitUntil), ein D1-Fehler wird nur geloggt und bricht Sync nie.
//   Fehlt das Binding, wird nicht gezaehlt. Gelesen wird aus der Cloud ueber
//   den Cloudflare-Konnektor (d1_database_query).

import '../../sync-merge.js';

const { mergeItems } = globalThis.SyncMerge;

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
};

const MIN_KEY_LENGTH = 32;

// WL-34: Schluessel-Liste und Groessengrenze.
const SYNC_KEYS_KEY = 'config:sync_keys';
const ALLOWLIST_TTL_MS = 5 * 60 * 1000;   // je Worker-Instanz
const MAX_SYNC_BYTES = 4 * 1024 * 1024;   // KV-Wand: 25 MiB je Wert

// Service display names aligned 1:1 with AVAILABILITY_SERVICES (WL-28 + Magazin v3).
const SERVICE_DISPLAY_NAMES = {
  arte: 'ARTE',
  ard: 'ARD Mediathek',
  zdf: 'ZDF Mediathek',
  '3sat': '3sat',
  kika: 'KiKA',
  netflix: 'Netflix',
  prime: 'Amazon Prime Video',
  disney: 'Disney+',
  apple: 'Apple TV+',
  sky: 'Sky Go',
  hbo: 'HBO Max',
  paramount: 'Paramount+',
  magenta: 'MagentaTV',
  joyn: 'Joyn',
  rtl: 'RTL+',
};


// ── WL-28: Dienstkatalog fuer die Verfuegbarkeit ─────────────────────────
// Eine Quelle fuer die Frage "wo kann ich das ohne Zusatzkosten schauen?".
// kind 'free'         = oeffentliche Mediathek, zaehlt immer, rangiert vor allem
// kind 'subscription' = zaehlt nur, wenn er im Profil des Sync-Keys steht
// tmdbIds             = TMDB-provider_id, gemessen 2026-09-28 per /watch/providers
//                       (watch_region=DE); Messtabelle im Plan
//                       outputs/plans/2026-09-28-wl-28-watchlist-bester-anbieter.md, Repo cowork.
//                       Sky = nur Sky Go (29); WOW (30) zaehlt bewusst nicht.
// search              = Such-Seite des Dienstes mit {q}; ohne {q} die leere Such-Seite
//                       (Dienst nimmt keinen Titel-Parameter an); null → Link auf die
//                       TMDB-Watch-Seite. Nur gemessene Vorlagen: Netflix, Magenta TV, Joyn,
//                       Disney+ und Paramount+ am 2026-09-28 im Browser des Eigentuemers. Sky Go hat keine
//                       Web-Suche; sky.de/suche?query= durchsucht die Sky-Seiten (kann einen
//                       verfuegbaren Titel verfehlen). RTL+ ?query= eingeloggt gemessen. HBO Max
//                       nur Such-Seite: der Titel-Link war nur mit aktivem Abo pruefbar.
// Die Reihenfolge der 'free'-Eintraege ist ihre Rangfolge untereinander.
const AVAILABILITY_SERVICES = [
  { id: 'arte',      kind: 'free',         tmdbIds: [234],        search: 'https://www.arte.tv/de/search/?q={q}' },
  { id: 'ard',       kind: 'free',         tmdbIds: [219],        search: 'https://www.ardmediathek.de/suche/{q}' },
  { id: 'zdf',       kind: 'free',         tmdbIds: [537],        search: 'https://www.zdf.de/suche?q={q}' },
  { id: '3sat',      kind: 'free',         tmdbIds: [2211],       search: 'https://www.3sat.de/suche?q={q}' },
  { id: 'kika',      kind: 'free',         tmdbIds: [2081],       search: 'https://www.kika.de/suche?q={q}' },
  { id: 'netflix',   kind: 'subscription', tmdbIds: [8, 1796],    search: 'https://www.netflix.com/search?q={q}' },
  { id: 'prime',     kind: 'subscription', tmdbIds: [9, 2100],    search: 'https://www.primevideo.com/search/ref=atv_nb_sug?phrase={q}' },
  { id: 'disney',    kind: 'subscription', tmdbIds: [337],        search: 'https://www.disneyplus.com/de-de/browse/search' },
  { id: 'apple',     kind: 'subscription', tmdbIds: [350],        search: 'https://tv.apple.com/de/search?term={q}' },
  { id: 'sky',       kind: 'subscription', tmdbIds: [29],         search: 'https://www.sky.de/suche?query={q}' },
  { id: 'hbo',       kind: 'subscription', tmdbIds: [1899],       search: 'https://play.hbomax.com/search' },
  { id: 'paramount', kind: 'subscription', tmdbIds: [531],        search: 'https://www.paramountplus.com/de/search/' },
  { id: 'magenta',   kind: 'subscription', tmdbIds: [178],        search: 'https://web.magentatv.de/suche/vod_more_web/{q}' },
  { id: 'joyn',      kind: 'subscription', tmdbIds: [304, 421],   search: 'https://www.joyn.de/suche?q={q}' },
  { id: 'rtl',       kind: 'subscription', tmdbIds: [2750],       search: 'https://plus.rtl.de/suche?query={q}' },
];

const AVAILABILITY_BY_TMDB = new Map();
for (const svc of AVAILABILITY_SERVICES) {
  for (const tid of svc.tmdbIds) AVAILABILITY_BY_TMDB.set(tid, svc);
}
// Legacy TMDB aliases occasionally still returned in DE watch/providers
const MAGAZINE_BY_TMDB = new Map(AVAILABILITY_BY_TMDB);
if (!MAGAZINE_BY_TMDB.has(119)) MAGAZINE_BY_TMDB.set(119, AVAILABILITY_SERVICES.find((s) => s.id === 'prime'));
if (!MAGAZINE_BY_TMDB.has(1773)) MAGAZINE_BY_TMDB.set(1773, AVAILABILITY_SERVICES.find((s) => s.id === 'joyn'));

const ALL_PROVIDER_IDS_STR = [...MAGAZINE_BY_TMDB.keys()]
  .sort((a, b) => a - b)
  .join('|');

// 50 Subrequests je Invocation: 1 KV (Profil) + je Titel 1 TMDB-Aufruf + Marge.
const AVAILABILITY_BATCH_MAX = 40;
const RENT_ONLY_NAMES_MAX = 3;

const GENRE_MAP = {
  28: 'Action', 12: 'Abenteuer', 16: 'Animation', 35: 'Komoedie',
  80: 'Krimi', 99: 'Doku', 18: 'Drama', 10751: 'Familie',
  14: 'Fantasy', 36: 'Geschichte', 27: 'Horror', 10402: 'Musik',
  9648: 'Mystery', 10749: 'Romantik', 878: 'Sci-Fi', 10770: 'TV-Film',
  53: 'Thriller', 10752: 'Krieg', 37: 'Western',
  10759: 'Action & Abenteuer', 10762: 'Kinder', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap',
  10767: 'Talk', 10768: 'Krieg & Politik',
};

const TMDB_BASE = 'https://api.themoviedb.org/3';

const MIN_RATING = 6.2;
const MIN_VOTES = 20;
const MEDIUM_THRESHOLD = 0.42;
// Inline-Rebuild bleibt kompakt (12), damit an einem Cold-Cache-Tag Taste +
// Discover + Enrich sicher unter der 50er-Subrequest-Wand bleiben.
const TASTE_SAMPLE_SIZE = 8;
const TASTE_PREWARM_SAMPLE_SIZE = 30;
const TASTE_CACHE_TTL_DAYS = 6;

// Dreistufige Sprach- & Lokalisierungs-Logik (Magazin v3):
//   Stufe 1 (Kern): Deutsch & Englisch (volle Gewichtung)
//   Stufe 2 (Europa-Nachbarn): ab solider Resonanz + deutscher Beschreibung
//   Stufe 3 (Weltsprachen): nicht blind ausgeschlossen, aber nur echte Welt-Hits
//                           (>= 500 Stimmen, Rating >= 7.4, lokalisierter Titel/Text)
const CORE_LANGUAGES = new Set(['de', 'en']);
const EURO_LANGUAGES = new Set(['fr', 'es', 'it', 'da', 'sv', 'no', 'nl', 'pt', 'pl', 'fi', 'is']);
// Nicht-lateinische Schriften im deutschen Titel = keine Lokalisierung vorhanden
const NON_LATIN_SCRIPT_RE = /[\u0400-\u052F\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

// ── Magazine knobs (Magazin v3) ──────────────────────────────────────────
const MAGAZINE_NEW_COUNT = 8;        // Rubrik "neu" (Blockbuster & Neu im Abo)
const MAGAZINE_UPCOMING_COUNT = 4;   // Rubrik "demnaechst" (Echte Vorab-Starts)
const MAGAZINE_CATALOG_COUNT = 6;    // Rubrik "entdeckt" (Seeds + Katalog)
const MAGAZINE_ENRICH_CAP = 14;      // hard cap on per-section detail calls
const MAGAZINE_LOOKBACK_DAYS = 45;   // "neu" window: released within last 45d
const MAGAZINE_UPCOMING_DAYS = 45;   // "demnaechst" window: next 45d
const MAGAZINE_SEEN_DAYS = 28;       // dedup window vs previous issues
const MAGAZINE_DISMISSED_DAYS = 180; // "Nicht mein Fall" merkt sich 6 Monate
const MAGAZINE_DISMISSED_MAX = 300;
const MAGAZINE_REFRESH_COOLDOWN_SEC = 30;
const MAGAZINE_MIN_NEW_CANDIDATES = 5;
const CATALOG_MIN_RATING = 7.1;
const CATALOG_MIN_VOTES = 220;
const CATALOG_PAGE_SPAN = 6;
// Invariante: total Subrequests (TMDB + KV) <= 44 (unter 50er Free-Tier-Wand).
// Mit max. ~8 KV-Ops je Lauf → TMDB_CALL_CEILING = 34 (34 + 8 = 42 <= 44).
const TMDB_CALL_CEILING = 34;

// Taegliche Morgen-Cron-Slots fuer bis zu 4 Familienprofile gleichzeitig
const DAILY_BUILD_CRON_SLOTS = {
  '15 4 * * *': 0,
  '30 4 * * *': 1,
  '45 4 * * *': 2,
  '0 5 * * *': 3,
};

const MAGAZINE_ROSTER_KEY = 'config:magazine_members';
const TEST_SYNC_KEY = 'a'.repeat(40);

let tmdbCalls = 0;
let kvCalls = 0;
let ceilingHit = false;

// ─────────────────────────────────────────────────────────────────────────
// HTTP entrypoints
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/magazine-build' && request.method === 'POST') {
      return handleMagazineBuild(request, env, ctx, url);
    }

    if (url.pathname === '/rebuild-taste' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      const member = url.searchParams.get('member') || env.OWNER_SYNC_KEY;
      await rebuildTasteProfileCache(env, member);
      const cached = await kvGet(env, tasteCacheKey(member), 'json');
      return jsonResponse({
        ok: true,
        member: member.slice(0, 8),
        ts: cached && cached.ts,
        genres: cached && cached.profile && Object.keys(cached.profile.genres).length,
        decades: cached && cached.profile && Object.keys(cached.profile.decades).length,
        cast: cached && cached.profile && Object.keys(cached.profile.cast).length,
        avg_rating: cached && cached.profile && cached.profile.avg_rating,
        sample_titles: cached && Array.isArray(cached.sample) ? cached.sample.length : 0,
      });
    }

    // Owner-scoped routes via X-API-Key
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey.length < MIN_KEY_LENGTH || !(await isAllowedKey(env, apiKey))) {
      if (apiKey) console.warn('key rejected', apiKey.slice(0, 8));
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const kvKey = `watchlist:${apiKey}`;

    if (url.pathname === '/sync' && request.method === 'GET') {
      let data = await kvGet(env, kvKey, 'json');
      // Legacy single-tenant migration (kept from previous worker version)
      if (!data) {
        const legacy = await kvGet(env, 'watchlist', 'json');
        if (legacy && apiKey === env.API_KEY) {
          await kvPut(env, kvKey, JSON.stringify(legacy));
          await kvDelete(env, 'watchlist');
          data = legacy;
        }
      }
      zaehleNutzung(env, ctx, apiKey, 'abrufe');
      return jsonResponse({ items: data || [], timestamp: Date.now() });
    }

    if (url.pathname === '/sync' && request.method === 'PUT') {
      const raw = await readBodyCapped(request, MAX_SYNC_BYTES);
      if (raw === null) {
        console.error('sync body too large', apiKey.slice(0, 8));
        return jsonResponse({ error: `body larger than ${MAX_SYNC_BYTES} bytes` }, 413);
      }
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || typeof body !== 'object') {
        return jsonResponse({ error: 'invalid JSON' }, 400);
      }
      if (!Array.isArray(body.items)) {
        return jsonResponse({ error: 'items must be an array' }, 400);
      }
      // WL-42: zusammenfuehren statt ersetzen.
      let stored = null;
      try { stored = await kvGet(env, kvKey, 'json'); } catch (err) {
        console.error('sync stored value unreadable, treated as empty', apiKey.slice(0, 8), String(err));
      }
      const merged = mergeItems(body.items, Array.isArray(stored) ? stored : [], Date.now());
      await kvPut(env, kvKey, JSON.stringify(merged));
      zaehleNutzung(env, ctx, apiKey, 'sendungen');
      return jsonResponse({ ok: true, count: merged.length, timestamp: Date.now() });
    }

    if (url.pathname === '/tmdb/search' && request.method === 'GET') {
      return handleTmdbSearch(env, url);
    }

    if (url.pathname === '/tmdb/details' && request.method === 'GET') {
      return handleTmdbDetails(env, url);
    }

    if (url.pathname === '/availability' && request.method === 'POST') {
      return handleAvailability(request, env, apiKey);
    }

    if (url.pathname === '/magazine' && request.method === 'GET') {
      const magazine = await kvGet(env, `magazine:${apiKey}`, 'json');
      return jsonResponse({ magazine: magazine || null, timestamp: Date.now() });
    }

    if (url.pathname === '/live-tv' && request.method === 'GET') {
      return handleLiveTv(env, url);
    }

    if (url.pathname === '/magazine/feedback' && request.method === 'POST') {
      return handleMagazineFeedback(request, env, apiKey);
    }

    if (url.pathname === '/magazine/refresh' && request.method === 'POST') {
      return handleMagazineRefresh(request, env, apiKey, url);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const roster = await loadMagazineRoster(env);
    const day = Math.floor(event.scheduledTime / 86400000);

    if (event.cron === '0 3 * * *') {
      const member = roster[day % roster.length];
      ctx.waitUntil(prewarmTasteIfStale(env, member));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(DAILY_BUILD_CRON_SLOTS, event.cron)) {
      const slot = DAILY_BUILD_CRON_SLOTS[event.cron];
      if (roster.length <= 4) {
        if (slot >= roster.length) return;
        ctx.waitUntil(runMagazinePipeline(env, { dryRun: false, source: 'cron', syncKey: roster[slot] }));
      } else {
        const member = roster[(day * 4 + slot) % roster.length];
        ctx.waitUntil(runMagazinePipeline(env, { dryRun: false, source: 'cron', syncKey: member }));
      }
      return;
    }

    if (event.cron === '0 16 * * *') {
      const member = roster[day % roster.length];
      ctx.waitUntil(runMagazinePipeline(env, { dryRun: false, source: 'cron', syncKey: member }));
      return;
    }

    console.warn('Unknown cron trigger:', event.cron);
  },
};

async function handleMagazineFeedback(request, env, apiKey) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  const key = body && typeof body.key === 'string' ? body.key.trim() : '';
  if (!/^(movie|tv)_\d+$/.test(key)) {
    return jsonResponse({ error: 'valid key (movie_ID or tv_ID) required' }, 400);
  }
  const action = body && body.action === 'undo' ? 'undo' : 'dismiss';
  const title = body && typeof body.title === 'string' ? body.title.slice(0, 160) : '';
  const dismissed = await loadMagazineDismissed(env, apiKey);

  if (action === 'undo') {
    delete dismissed[key];
    await saveMagazineDismissed(env, apiKey, dismissed);
    return jsonResponse({ ok: true, key, action: 'undo', dismissedCount: Object.keys(dismissed).length });
  }

  dismissed[key] = { ts: Math.floor(Date.now() / 1000), title };
  await saveMagazineDismissed(env, apiKey, dismissed);

  const existing = await kvGet(env, `magazine:${apiKey}`, 'json');
  if (existing && Array.isArray(existing.sections)) {
    let changed = false;
    const counts = { ...(existing.counts || {}) };
    for (const sec of existing.sections) {
      if (!Array.isArray(sec.items)) continue;
      const before = sec.items.length;
      sec.items = sec.items.filter((it) => it && it.key !== key);
      if (sec.items.length !== before) {
        changed = true;
        counts[sec.id] = sec.items.length;
      }
    }
    if (changed) {
      existing.counts = counts;
      await kvPut(env, `magazine:${apiKey}`, JSON.stringify(existing));
    }
  }

  return jsonResponse({ ok: true, key, action: 'dismiss', dismissedCount: Object.keys(dismissed).length });
}

async function handleMagazineRefresh(request, env, apiKey, url) {
  const existing = await kvGet(env, `magazine:${apiKey}`, 'json');
  const nowSec = Math.floor(Date.now() / 1000);
  const force = url.searchParams.get('force') === '1';
  const resetCache = url.searchParams.get('resetCache') === '1';
  if (!force && !resetCache && existing && existing.issue && typeof existing.issue.ts === 'number'
      && (nowSec - existing.issue.ts) < MAGAZINE_REFRESH_COOLDOWN_SEC) {
    return jsonResponse({ ok: true, refreshed: false, cooldown: true, magazine: existing });
  }

  if (resetCache) {
    await Promise.all([
      kvDelete(env, tasteCacheKey(apiKey)),
      kvDelete(env, `magazine_seen:${apiKey}`),
    ]);
  }

  const currentKeys = new Set();
  if (!resetCache && existing && Array.isArray(existing.sections)) {
    for (const sec of existing.sections) {
      for (const it of sec.items || []) {
        if (it && it.key) currentKeys.add(it.key);
      }
    }
  }

  const result = await runMagazinePipeline(env, {
    dryRun: false,
    source: 'user-refresh',
    syncKey: apiKey,
    relaxSeen: true,
    excludeKeys: currentKeys,
  });

  if (!result.ok) {
    return jsonResponse({
      ok: Boolean(existing),
      refreshed: false,
      magazine: existing || null,
      message: result.message || result.error || 'Keine neuen Treffer verfuegbar',
    }, existing ? 200 : 502);
  }

  const fresh = await kvGet(env, `magazine:${apiKey}`, 'json');
  return jsonResponse({ ok: true, refreshed: true, magazine: fresh, counts: result.counts });
}

async function handleMagazineBuild(request, env, ctx, url) {
  const adminKey = request.headers.get('X-Admin-Key');
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const dryRun = url.searchParams.get('dryRun') === '1';
  // ?member=<sync-key> builds a specific member (defaults to owner). The manual
  // path is deliberately independent of the cron's round-robin index so an
  // operator never silently targets a different member than intended.
  const member = url.searchParams.get('member') || env.OWNER_SYNC_KEY;
  const result = await runMagazinePipeline(env, { dryRun, source: 'manual', syncKey: member });
  return jsonResponse(result);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// KV access — subrequest-counting wrappers (WL-11)
// Every KV op goes through these so kvCalls reflects the real Free-tier
// subrequest cost. No direct env.WATCHLIST_KV access anywhere else.
// ─────────────────────────────────────────────────────────────────────────

function kvGet(env, key, type = 'json') {
  kvCalls++;
  return env.WATCHLIST_KV.get(key, type);
}

function kvPut(env, key, value) {
  kvCalls++;
  return env.WATCHLIST_KV.put(key, value);
}

function kvDelete(env, key) {
  kvCalls++;
  return env.WATCHLIST_KV.delete(key);
}

// ─────────────────────────────────────────────────────────────────────────
// Magazine roster (WL-11) — who gets a personal weekly magazine
// ─────────────────────────────────────────────────────────────────────────

// Effective roster = [owner, ...allowlisted family keys]. The owner is ALWAYS
// roster[0] and unconditional, so (a) a roster edit can never drop the owner's
// own magazine and (b) roster.length >= 1 is guaranteed — idx % length is never
// NaN, so we can never write magazine:undefined. The whole construction is
// wrapped in try/catch: a missing, non-JSON, or non-array config all degrade
// to owner-only instead of throwing (e.g. config '"x"' parses to a String,
// whose .filter would otherwise throw a TypeError).
async function loadMagazineRoster(env) {
  const owner = env.OWNER_SYNC_KEY;
  let extra = [];
  try {
    const raw = await kvGet(env, MAGAZINE_ROSTER_KEY, 'json');
    if (Array.isArray(raw)) {
      extra = raw.filter((k) =>
        typeof k === 'string' &&
        k.length >= MIN_KEY_LENGTH &&
        k !== owner &&
        k !== TEST_SYNC_KEY,
      );
    }
  } catch (err) {
    console.error('Roster load failed — owner-only fallback:', err && err.message ? err.message : String(err));
    extra = [];
  }
  return [owner, ...extra];
}

// ─────────────────────────────────────────────────────────────────────────
// Nutzungszaehler (WL-NUTZUNG-MESSEN) — Tageszaehler je Pseudonym in D1
// ─────────────────────────────────────────────────────────────────────────

// Je Spalte eine feste Anweisung: der Spaltenname kommt nie aus einer Eingabe.
const NUTZUNG_SQL = {
  abrufe: 'insert into nutzung (tag, wer, abrufe, sendungen) values (?1, ?2, 1, 0) '
    + 'on conflict(tag, wer) do update set abrufe = abrufe + 1',
  sendungen: 'insert into nutzung (tag, wer, abrufe, sendungen) values (?1, ?2, 0, 1) '
    + 'on conflict(tag, wer) do update set sendungen = sendungen + 1',
};

// Startet die Zaehlung, ohne die Antwort warten zu lassen. Ohne Binding oder
// mit unbekannter Spalte passiert nichts; jeder Fehler wird nur geloggt.
function zaehleNutzung(env, ctx, syncKey, spalte) {
  if (!env.NUTZUNG_DB || !NUTZUNG_SQL[spalte]) return;
  const lauf = schreibeNutzung(env, syncKey, spalte).catch((err) => {
    console.error('nutzung nicht gezaehlt', spalte, err && err.message ? err.message : String(err));
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(lauf);
}

async function schreibeNutzung(env, syncKey, spalte) {
  const tag = new Date().toISOString().slice(0, 10);
  const wer = await nutzungPseudonym(syncKey);
  await env.NUTZUNG_DB.prepare(NUTZUNG_SQL[spalte]).bind(tag, wer).run();
}

// Erste 12 Hex-Zeichen von SHA-256(Schluessel): stabil je Person, nicht
// zurueckrechenbar, kein Teil des Schluessels selbst.
async function nutzungPseudonym(syncKey) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(syncKey));
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────
// Schluessel-Liste (WL-34) — wer die X-API-Key-Routen nutzen darf
// ─────────────────────────────────────────────────────────────────────────

// Je Worker-Instanz nur Daten im Speicher (das fertige Set, kein Promise:
// I/O einer Anfrage darf nicht von einer anderen erwartet werden). Ein
// KV-Fehler wird nicht gecacht: sonst sperrte ein kurzer Aussetzer die Familie
// 5 Minuten. env.ALLOWLIST_TTL_MS gibt es nur in Tests.
let allowlistCache = null; // { keys: Set, loadedAt: ms }

async function isAllowedKey(env, key) {
  if (key === TEST_SYNC_KEY) return false;
  if (key === env.OWNER_SYNC_KEY || key === env.API_KEY) return true;
  const ttl = env.ALLOWLIST_TTL_MS !== undefined ? Number(env.ALLOWLIST_TTL_MS) : ALLOWLIST_TTL_MS;
  const now = Date.now();
  if (!allowlistCache || allowlistCache.loadedAt + ttl <= now) {
    try {
      allowlistCache = { keys: await loadAllowedKeys(env), loadedAt: now };
    } catch (err) {
      console.error('Allowlist load failed:', err && err.message ? err.message : String(err));
      return false;
    }
  }
  return allowlistCache.keys.has(key);
}

// Roster plus config:sync_keys, je Eintrag als Text gelesen und einzeln
// geparst: Fehlt eine Liste, ist sie kaputtes JSON oder kein Array, faellt nur
// sie weg (Owner/API_KEY gelten oben, der Roster bleibt). Wirft nur bei einem
// KV-Fehler.
async function loadAllowedKeys(env) {
  const raws = await Promise.all([
    kvGet(env, MAGAZINE_ROSTER_KEY, 'text'),
    kvGet(env, SYNC_KEYS_KEY, 'text'),
  ]);
  const allowed = new Set();
  for (const raw of raws) {
    let list = null;
    try { list = raw ? JSON.parse(raw) : null; } catch {
      console.error('Allowlist entry is not valid JSON');
    }
    if (!Array.isArray(list)) continue;
    for (const k of list) {
      if (typeof k === 'string' && k.length >= MIN_KEY_LENGTH && k !== TEST_SYNC_KEY) allowed.add(k);
    }
  }
  return allowed;
}

// Liest den Body als Stream und bricht ab, sobald mehr als maxBytes kommen
// (Content-Length kann fehlen oder luegen). null = zu gross.
async function readBodyCapped(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

// Best-effort taste pre-warm: rebuild the member's taste profile only if it is
// missing or past its TTL. Runs at 03:00 for the same member the 16:00 magazine
// build will target, so the build normally finds a warm cache. If this fails or
// the cache expires between 03:00 and 16:00, the magazine build is still
// self-sufficient (loadOrBuildTasteProfile rebuilds inline) — so a member never
// loses their issue on their day.
async function prewarmTasteIfStale(env, syncKey) {
  try {
    const watchlist = liveItems(await loadWatchlist(env, syncKey));
    if (watchlist.length === 0) return;
    const sig = computeWatchlistSignature(watchlist);
    const cached = await kvGet(env, tasteCacheKey(syncKey), 'json');
    if (cached && cached.ts && cached.profile) {
      const ageDays = (Date.now() / 1000 - cached.ts) / 86400;
      if (ageDays < TASTE_CACHE_TTL_DAYS && cached.sig === sig) {
        console.log(`Taste pre-warm: fresh for ${String(syncKey).slice(0, 8)} (${ageDays.toFixed(1)}d) — skip`);
        return;
      }
    }
    await rebuildTasteProfileCache(env, syncKey, watchlist);
  } catch (err) {
    console.error('Taste pre-warm failed (best-effort):', err && err.message ? err.message : String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Magazine pipeline (Magazin v3 — Multi-Member Family Intelligence)
// ─────────────────────────────────────────────────────────────────────────

async function runMagazinePipeline(env, { dryRun, source, syncKey, relaxSeen = false, excludeKeys = null }) {
  const startedAt = Date.now();
  tmdbCalls = 0;
  kvCalls = 0;
  ceilingHit = false;
  const log = [];
  const note = (msg) => { log.push(msg); console.log(msg); };

  try {
    requireSecret(env, 'OWNER_SYNC_KEY');
    requireSecret(env, 'TMDB_API_KEY');

    const owner = syncKey || env.OWNER_SYNC_KEY;
    note(`Building magazine v3 for ${String(owner).slice(0, 8)} (source=${source})`);

    const watchlist = await loadWatchlist(env, owner);
    const live = liveItems(watchlist);
    note(`Watchlist: ${watchlist.length} items (${live.length} live)`);

    const baseWatchlistIds = new Set(
      watchlist
        .filter((it) => it && it.tmdbId)
        .map((it) => `${it.type || 'movie'}_${it.tmdbId}`),
    );
    const watchlistIds = new Set(baseWatchlistIds);
    if (excludeKeys instanceof Set) {
      for (const k of excludeKeys) watchlistIds.add(k);
    }

    const { profile: taste, sample: tasteSample, seeds: tasteSeeds } =
      await loadOrBuildTasteProfile(live, env, owner, note);
    const seen = await loadMagazineSeen(env, owner);
    const dismissed = await loadMagazineDismissed(env, owner);
    const providerProfile = await loadProviderProfile(env, owner);
    const memberProviders = deriveMemberProviders(live, providerProfile);

    note(`Seen=${Object.keys(seen).length} · Dismissed=${Object.keys(dismissed).length} · TopServices=${memberProviders.preferredIds.slice(0, 4).join(',') || 'default'}`);

    const today = new Date();
    const todayStr = isoDate(today);
    const currentYear = today.getFullYear();

    // ── 1. Rubrik "neu": Blockbuster-Trends + Neuerscheinungen im Abo ──
    const [trendingRaw, windowRaw] = await Promise.all([
      fetchTrendingWindow(env),
      fetchMagazineWindow(
        isoDate(addDays(today, -MAGAZINE_LOOKBACK_DAYS)),
        todayStr,
        1,
        5,
        env,
        { providerIdsStr: memberProviders.tmdbIdsStr },
      ),
    ]);
    let newRaw = mergeCandidateLists(windowRaw, trendingRaw);
    note(`Neu raw candidates (window+trending): ${newRaw.length} (tmdbCalls=${tmdbCalls})`);

    let { list: newScored, kills: newKills } = scoreAndFilter(
      newRaw, taste, watchlistIds, seen, { dismissed },
    );

    if (newScored.length < MAGAZINE_MIN_NEW_CANDIDATES && tmdbCalls + 2 <= TMDB_CALL_CEILING) {
      note(`Neu below threshold (${newScored.length} < ${MAGAZINE_MIN_NEW_CANDIDATES}) — fetching page 2`);
      const page2 = await fetchMagazineWindow(
        isoDate(addDays(today, -MAGAZINE_LOOKBACK_DAYS)),
        todayStr,
        2,
        5,
        env,
        { providerIdsStr: memberProviders.tmdbIdsStr },
      );
      newRaw = mergeCandidateLists(newRaw, page2);
      ({ list: newScored, kills: newKills } = scoreAndFilter(
        newRaw, taste, watchlistIds, seen, { dismissed },
      ));
      note(`Neu after fallback: ${newScored.length}`);
    }

    // Bei manuellem "Neu mischen": falls fast alles schon in seen lag, seen-Historie lockern
    if (relaxSeen && newScored.length < 4) {
      ({ list: newScored } = scoreAndFilter(newRaw, taste, watchlistIds, {}, { dismissed }));
      if (newScored.length === 0 && excludeKeys instanceof Set && excludeKeys.size > 0) {
        ({ list: newScored } = scoreAndFilter(newRaw, taste, baseWatchlistIds, {}, { dismissed }));
      }
    }
    note(`Neu kill-split: ${JSON.stringify(newKills)}`);

    // ── 2. Rubrik "demnaechst": Echte Vorab-Starts (ohne Re-Release-Klassiker!) ──
    const upRawAll = await fetchMagazineWindow(
      isoDate(addDays(today, 1)),
      isoDate(addDays(today, MAGAZINE_UPCOMING_DAYS)),
      1,
      0,
      env,
      { upcoming: true },
    );
    // Schutz Stufe 1 gegen Kino-Wiederauffuehrungen alter Filme (z. B. 1984/2015)
    const upRaw = upRawAll.filter((r) => !r.release_year || r.release_year >= currentYear - 1);
    note(`Demnaechst raw candidates: ${upRaw.length}/${upRawAll.length} (tmdbCalls=${tmdbCalls})`);

    const newKeys = new Set(newScored.map((r) => r.key));
    const { list: upScored, kills: upKills } = scoreAndFilter(
      upRaw.filter((r) => !newKeys.has(itemKey(r))),
      taste,
      watchlistIds,
      seen,
      { relaxVotes: true, upcoming: true, dismissed },
    );
    note(`Neu scored: ${newScored.length} · Demnaechst scored: ${upScored.length}`);
    note(`Demnaechst kill-split: ${JSON.stringify(upKills)}`);

    // ── 3. Rubrik "entdeckt" Discovery vor Enrichment (damit kein Budget verhungert) ──
    const topGenreIds = Object.entries(taste.genres)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([gid]) => gid);

    let catScored = [];
    let catKills = { watchlist: 0, seen: 0, dismissed: 0, langQuality: 0, lowVotes: 0, lowRating: 0, belowTaste: 0, kept: 0 };

    const seedCandidates = (tasteSeeds.length > 0 && tmdbCalls + 2 <= TMDB_CALL_CEILING)
      ? await fetchSeedRecommendations(tasteSeeds.slice(0, 2), env)
      : [];

    let catalogCandidates = [];
    if (topGenreIds.length === 0 && seedCandidates.length === 0) {
      note('Entdeckt skipped — taste profile has no genres or seeds');
    } else if (topGenreIds.length > 0 && tmdbCalls + 2 <= TMDB_CALL_CEILING) {
      catalogCandidates = await fetchCatalogWindow(topGenreIds, memberProviders.tmdbIdsStr, env);
    } else if (topGenreIds.length > 0) {
      ceilingHit = true;
      note('Entdeckt catalog discover skipped — TMDB budget near ceiling');
    }

    const combinedEntdecktRaw = mergeCandidateLists(seedCandidates, catalogCandidates);
    if (combinedEntdecktRaw.length > 0) {
      note(`Entdeckt raw candidates (seeds=${seedCandidates.length} + catalog=${catalogCandidates.length}): ${combinedEntdecktRaw.length} (tmdbCalls=${tmdbCalls})`);
      const upKeys = new Set(upScored.map((r) => r.key));
      const usedKeys = new Set([...newKeys, ...upKeys]);
      ({ list: catScored, kills: catKills } = scoreAndFilter(
        combinedEntdecktRaw.filter((r) => !usedKeys.has(itemKey(r))),
        taste,
        watchlistIds,
        seen,
        { dismissed },
      ));
      if (relaxSeen && catScored.length < 4) {
        ({ list: catScored } = scoreAndFilter(
          combinedEntdecktRaw.filter((r) => !usedKeys.has(itemKey(r))),
          taste,
          watchlistIds,
          {},
          { dismissed },
        ));
      }
      note(`Entdeckt scored: ${catScored.length} · kill-split: ${JSON.stringify(catKills)}`);
    }

    // ── Proportionales Enrichment-Budget je Rubrik (Neu → Entdeckt → Demnaechst) ──
    const remBeforeNeu = Math.max(0, TMDB_CALL_CEILING - tmdbCalls);
    const neuMaxCalls = Math.max(4, Math.min(11, Math.floor(remBeforeNeu * 0.46)));
    const neuItems = await enrichMagazineItems(
      newScored,
      MAGAZINE_NEW_COUNT,
      { requireProviders: true, sectionId: 'neu', memberProviders, maxCalls: neuMaxCalls },
      taste,
      tasteSample,
      env,
      note,
    );

    const enrichedKeys = new Set(neuItems.map((x) => x.key));
    const remBeforeEntdeckt = Math.max(0, TMDB_CALL_CEILING - tmdbCalls);
    const entdecktMaxCalls = upScored.length > 0
      ? Math.max(3, Math.min(8, Math.floor(remBeforeEntdeckt * 0.65)))
      : Math.min(MAGAZINE_ENRICH_CAP, remBeforeEntdeckt);
    const entdecktItems = await enrichMagazineItems(
      catScored.filter((c) => !enrichedKeys.has(c.key)),
      MAGAZINE_CATALOG_COUNT,
      { requireProviders: true, sectionId: 'entdeckt', reasonPrefix: '', memberProviders, maxCalls: entdecktMaxCalls },
      taste,
      tasteSample,
      env,
      note,
    );
    for (const it of entdecktItems) enrichedKeys.add(it.key);

    const upItems = await enrichMagazineItems(
      upScored.filter((c) => !enrichedKeys.has(c.key)),
      MAGAZINE_UPCOMING_COUNT,
      { requireProviders: false, sectionId: 'demnaechst', rejectOldPrimaryYear: currentYear - 1, memberProviders },
      taste,
      tasteSample,
      env,
      note,
    );

    // Innerhalb einer Sektion: Titel mit direktem YouTube-Trailer bei aehnlichem Rang leicht vorziehen (Spotlight!)
    prioritizeHeroWithTrailer(neuItems);
    upItems.sort((a, b) =>
      ((a.upcoming_date || a.release_date) || '').localeCompare((b.upcoming_date || b.release_date) || ''));

    note(`Enriched: neu=${neuItems.length} demnaechst=${upItems.length} entdeckt=${entdecktItems.length} (tmdbCalls=${tmdbCalls}, ceilingHit=${ceilingHit})`);

    const kills = { neu: newKills, demnaechst: upKills, entdeckt: catKills };

    if (neuItems.length === 0 && upItems.length === 0 && entdecktItems.length === 0) {
      const msg = 'Magazin diese Woche übersprungen — keine passenden Titel gefunden.';
      note(msg);
      return {
        ok: false, source, skipped: true, message: msg, kills, capped: ceilingHit,
        subrequests: { tmdb: tmdbCalls, kv: kvCalls, total: tmdbCalls + kvCalls },
        log, elapsedMs: Date.now() - startedAt,
      };
    }

    const topGenreNames = topGenreIds.map((gid) => GENRE_MAP[gid]).filter(Boolean);
    const issueWeek = isoWeek(today);
    const magazine = {
      version: 2,
      engine: 3,
      issue: {
        week: issueWeek,
        year: currentYear,
        date: todayStr,
        ts: Math.floor(Date.now() / 1000),
      },
      taste_summary: {
        watchlist_count: live.length,
        watched_count: live.filter((x) => x.watched).length,
        shortlist_count: live.filter((x) => x.shortlist != null).length,
        top_genres: topGenreNames,
        top_services: memberProviders.preferredIds.slice(0, 5),
        seed_titles: tasteSeeds.slice(0, 3).map((s) => s.title).filter(Boolean),
      },
      counts: { neu: neuItems.length, demnaechst: upItems.length, entdeckt: entdecktItems.length },
      sections: [
        { id: 'neu', title: 'Blockbuster & Neu im Abo', items: neuItems },
        { id: 'demnaechst', title: 'Demnächst vormerken', items: upItems },
        { id: 'entdeckt', title: 'Aus deiner Liste gelernt', items: entdecktItems },
      ],
    };

    if (dryRun) {
      const kvLive = kvCalls + 2;
      return {
        ok: true, source, dryRun: true, magazine, kills, capped: ceilingHit,
        subrequests: { tmdb: tmdbCalls, kv: kvLive, total: tmdbCalls + kvLive },
        log, elapsedMs: Date.now() - startedAt,
      };
    }

    await kvPut(env, `magazine:${owner}`, JSON.stringify(magazine));

    const now = Math.floor(Date.now() / 1000);
    for (const it of [...neuItems, ...upItems, ...entdecktItems]) {
      seen[it.key] = { title: it.title, ts: now, date: todayStr };
    }
    await saveMagazineSeen(env, owner, seen);

    return {
      ok: true,
      source,
      issue: magazine.issue,
      counts: magazine.counts,
      kills,
      capped: ceilingHit,
      subrequests: { tmdb: tmdbCalls, kv: kvCalls, total: tmdbCalls + kvCalls },
      log,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    console.error('Magazine pipeline error:', err);
    return { ok: false, source, error: String(err), log, elapsedMs: Date.now() - startedAt };
  }
}

function requireSecret(env, name) {
  if (!env[name]) throw new Error(`Missing secret: ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────
// KV: owner watchlist + magazine seen & dismissed state
// ─────────────────────────────────────────────────────────────────────────

async function loadWatchlist(env, syncKey) {
  const data = await kvGet(env, `watchlist:${syncKey}`, 'json');
  return Array.isArray(data) ? data : [];
}

function liveItems(list) {
  return list.filter((it) => it && !it.deleted && !it.deletedAt);
}

async function loadMagazineSeen(env, syncKey) {
  const raw = await kvGet(env, `magazine_seen:${syncKey}`, 'json');
  if (!raw || typeof raw !== 'object') return {};
  const cutoff = Math.floor(Date.now() / 1000) - MAGAZINE_SEEN_DAYS * 86400;
  const fresh = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v.ts === 'number' && v.ts > cutoff) fresh[k] = v;
  }
  return fresh;
}

function filterRecentSeen(seen, days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const recent = {};
  for (const [k, v] of Object.entries(seen || {})) {
    if (v && typeof v.ts === 'number' && v.ts > cutoff) recent[k] = v;
  }
  return recent;
}

async function saveMagazineSeen(env, syncKey, state) {
  await kvPut(env, `magazine_seen:${syncKey}`, JSON.stringify(state));
}

async function loadMagazineDismissed(env, syncKey) {
  const raw = await kvGet(env, `magazine_dismissed:${syncKey}`, 'json');
  if (!raw || typeof raw !== 'object') return {};
  const cutoff = Math.floor(Date.now() / 1000) - MAGAZINE_DISMISSED_DAYS * 86400;
  const entries = Object.entries(raw)
    .filter(([, v]) => v && typeof v.ts === 'number' && v.ts > cutoff)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, MAGAZINE_DISMISSED_MAX);
  return Object.fromEntries(entries);
}

async function saveMagazineDismissed(env, syncKey, state) {
  await kvPut(env, `magazine_dismissed:${syncKey}`, JSON.stringify(state));
}

// ─────────────────────────────────────────────────────────────────────────
// TMDB client
// ─────────────────────────────────────────────────────────────────────────

async function tmdbGet(path, params, env) {
  const url = new URL(`${TMDB_BASE}/${path}`);
  url.searchParams.set('api_key', env.TMDB_API_KEY);
  url.searchParams.set('language', 'de-DE');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  tmdbCalls++;
  try {
    const resp = await fetch(url.toString(), { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`TMDB ${path} → HTTP ${resp.status}: ${body.slice(0, 200)}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`TMDB ${path} error:`, err && err.message ? err.message : String(err));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WL-27: TMDB fuer die App nur ueber den Worker — der Schluessel bleibt hier
// ─────────────────────────────────────────────────────────────────────────

function parseMediaRef(type, id) {
  if (type !== 'movie' && type !== 'tv') return null;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { type, id: n };
}

async function handleTmdbSearch(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 200) return jsonResponse({ error: 'q required' }, 400);
  const data = await tmdbGet('search/multi', { query: q, page: 1, include_adult: false }, env);
  if (!data) return jsonResponse({ error: 'TMDB unavailable' }, 502);
  const results = (data.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .slice(0, 8);
  return jsonResponse({ results });
}

async function handleTmdbDetails(env, url) {
  const ref = parseMediaRef(url.searchParams.get('type'), url.searchParams.get('id'));
  if (!ref) return jsonResponse({ error: 'type and id required' }, 400);
  const withVideos = url.searchParams.get('videos') === '1';
  const params = withVideos
    ? { append_to_response: 'videos', include_video_language: 'de,en,null' }
    : null;
  const data = await tmdbGet(`${ref.type}/${ref.id}`, params, env);
  if (!data) return jsonResponse({ error: 'TMDB unavailable' }, 502);
  return jsonResponse(data);
}

// ─────────────────────────────────────────────────────────────────────────
// WL-28: bester Anbieter — nur Flat aus dem Profil oder freie Mediathek
// ─────────────────────────────────────────────────────────────────────────

// Profil je Sync-Key: geordnete Liste von Dienst-IDs (Abos). Fehlt es, zaehlen
// alle Abo-Dienste des Katalogs in Katalog-Reihenfolge — Leihen/Kaufen nie.
async function loadProviderProfile(env, syncKey) {
  const raw = await kvGet(env, `config:providers:${syncKey}`, 'json');
  const known = new Set(AVAILABILITY_SERVICES.filter((s) => s.kind === 'subscription').map((s) => s.id));
  if (Array.isArray(raw)) {
    const ordered = raw.filter((id) => known.has(id));
    return { subscriptions: [...new Set(ordered)], fromKv: true };
  }
  return { subscriptions: [...known], fromKv: false };
}

function serviceLink(svc, title, ref) {
  if (svc && svc.search && title) return svc.search.replace('{q}', encodeURIComponent(title));
  return `https://www.themoviedb.org/${ref.type}/${ref.id}/watch?locale=DE`;
}

// Reine Funktion: TMDB results.DE + Profil → Urteil.
function rankAvailability(de, profile, title, ref) {
  const offered = new Set();
  const names = new Map();
  for (const list of [de && de.flatrate, de && de.free, de && de.ads]) {
    for (const p of list || []) {
      const svc = AVAILABILITY_BY_TMDB.get(p.provider_id);
      if (svc) offered.add(svc.id);
    }
  }
  const candidates = [];
  for (const svc of AVAILABILITY_SERVICES) {
    if (svc.kind === 'free' && offered.has(svc.id)) candidates.push({ svc, kind: 'free' });
  }
  for (const id of profile.subscriptions) {
    if (offered.has(id)) {
      const svc = AVAILABILITY_SERVICES.find((s) => s.id === id);
      candidates.push({ svc, kind: 'flat' });
    }
  }
  const toOut = (c) => ({
    service: c.svc.id,
    kind: c.kind,
    link: serviceLink(c.svc, title, ref),
    direct: !!(c.svc.search && title),   // false → Link ist die TMDB-Watch-Seite
    prefilled: !!(c.svc.search && title && c.svc.search.includes('{q}')),  // false → leere Such-Seite des Dienstes
  });
  const rentOnly = [];
  if (candidates.length === 0) {
    for (const list of [de && de.rent, de && de.buy]) {
      for (const p of list || []) {
        const svc = AVAILABILITY_BY_TMDB.get(p.provider_id);
        const key = svc ? svc.id : `tmdb:${p.provider_id}`;
        if (!names.has(key)) names.set(key, p.provider_name || key);
      }
    }
    for (const n of names.values()) {
      if (rentOnly.length >= RENT_ONLY_NAMES_MAX) break;
      rentOnly.push(n);
    }
  }
  return {
    best: candidates.length ? toOut(candidates[0]) : null,
    alternatives: candidates.slice(1).map(toOut),
    rentOnly,
    checkedAt: Date.now(),
  };
}

async function handleAvailability(request, env, apiKey) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  const list = body && Array.isArray(body.items) ? body.items : null;
  if (!list) return jsonResponse({ error: 'items must be an array' }, 400);
  if (list.length > AVAILABILITY_BATCH_MAX) {
    return jsonResponse({ error: `at most ${AVAILABILITY_BATCH_MAX} items` }, 400);
  }
  const profile = await loadProviderProfile(env, apiKey);
  const results = {};
  await Promise.all(list.map(async (it) => {
    const ref = it && parseMediaRef(it.type, it.id);
    if (!ref) return;
    const key = `${ref.type}:${ref.id}`;
    const data = await tmdbGet(`${ref.type}/${ref.id}/watch/providers`, null, env);
    if (!data) { results[key] = { error: 'TMDB unavailable' }; return; }
    const de = data.results && data.results.DE;
    const title = typeof it.title === 'string' ? it.title.slice(0, 200) : '';
    results[key] = rankAvailability(de, profile, title, ref);
  }));
  return jsonResponse({ results, profile: profile.fromKv ? 'kv' : 'default' });
}

// ─────────────────────────────────────────────────────────────────────────
// Taste profile (multi-factor: genres + decades + cast + avg_rating)
// ─────────────────────────────────────────────────────────────────────────

function tasteCacheKey(syncKey) {
  return `taste:${syncKey}`;
}

function computeWatchlistSignature(liveList) {
  const watchedCount = liveList.filter((x) => x.watched).length;
  const shortlistIds = liveList
    .filter((x) => x.shortlist != null && x.tmdbId)
    .sort((a, b) => Number(a.shortlist) - Number(b.shortlist))
    .map((x) => `${x.type || 'm'}${x.tmdbId}`)
    .join(',');
  return `${liveList.length}:${watchedCount}:${shortlistIds}`;
}

// Leitet fuer jedes Familienmitglied automatisch die bevorzugten Dienste aus
// der eigenen Watchlist ab (oder nutzt explizites config:providers:<key>).
function deriveMemberProviders(liveWatchlist, explicitProfile) {
  const counts = new Map();
  for (const it of liveWatchlist) {
    const sid = it && typeof it.serviceId === 'string' ? it.serviceId.trim().toLowerCase() : '';
    if (!sid || !SERVICE_DISPLAY_NAMES[sid]) continue;
    const w = it.shortlist != null ? 3 : (it.watched ? 2 : 1);
    counts.set(sid, (counts.get(sid) || 0) + w);
  }

  let preferredIds;
  let allowedServiceIds;
  if (explicitProfile && explicitProfile.fromKv && explicitProfile.subscriptions.length > 0) {
    preferredIds = [...explicitProfile.subscriptions];
    allowedServiceIds = new Set([
      ...AVAILABILITY_SERVICES.filter((s) => s.kind === 'free').map((s) => s.id),
      ...explicitProfile.subscriptions,
    ]);
  } else {
    preferredIds = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sid]) => sid);
    allowedServiceIds = new Set(AVAILABILITY_SERVICES.map((s) => s.id));
  }

  const tmdbIdSet = new Set();
  for (const [tid, svc] of MAGAZINE_BY_TMDB.entries()) {
    if (svc && allowedServiceIds.has(svc.id)) tmdbIdSet.add(tid);
  }
  const tmdbIdsStr = tmdbIdSet.size > 0
    ? [...tmdbIdSet].sort((a, b) => a - b).join('|')
    : ALL_PROVIDER_IDS_STR;

  return {
    preferredIds,
    preferredRank: new Map(preferredIds.map((id, idx) => [id, idx])),
    allowedServiceIds,
    tmdbIdsStr,
  };
}

async function loadOrBuildTasteProfile(watchlist, env, syncKey, note) {
  const sig = computeWatchlistSignature(watchlist);
  const cached = await kvGet(env, tasteCacheKey(syncKey), 'json');
  if (cached && cached.ts && cached.profile) {
    const ageDays = (Date.now() / 1000 - cached.ts) / 86400;
    const prevCount = typeof cached.liveCount === 'number' ? cached.liveCount : watchlist.length;
    const countDelta = Math.abs(watchlist.length - prevCount);
    const sigFresh = !cached.sig || (cached.sig === sig || countDelta < 4);
    if (ageDays < TASTE_CACHE_TTL_DAYS && sigFresh) {
      note(`Taste profile: KV cache hit (${ageDays.toFixed(1)}d old)`);
      return {
        profile: cached.profile,
        sample: cached.sample || [],
        seeds: extractAnchorSeeds(watchlist, cached.sample || []),
      };
    }
    note(`Taste profile: KV cache stale/changed (${ageDays.toFixed(1)}d, delta=${countDelta}) — rebuilding inline`);
  } else {
    note('Taste profile: no KV cache — building inline');
  }

  const { profile, sample } = await buildTasteProfile(watchlist, env, TASTE_SAMPLE_SIZE);
  await kvPut(
    env,
    tasteCacheKey(syncKey),
    JSON.stringify({
      profile,
      sample,
      sig,
      liveCount: watchlist.length,
      ts: Math.floor(Date.now() / 1000),
    }),
  );
  return {
    profile,
    sample,
    seeds: extractAnchorSeeds(watchlist, sample),
  };
}

async function rebuildTasteProfileCache(env, syncKey, preloadedLive = null) {
  console.log(`Taste-profile rebuild starting for ${String(syncKey).slice(0, 8)}`);
  tmdbCalls = 0;
  kvCalls = 0;
  requireSecret(env, 'OWNER_SYNC_KEY');
  requireSecret(env, 'TMDB_API_KEY');
  const watchlist = preloadedLive || liveItems(await loadWatchlist(env, syncKey));
  if (watchlist.length === 0) {
    console.log('Watchlist empty — skipping taste-profile rebuild');
    return;
  }
  const sig = computeWatchlistSignature(watchlist);
  const { profile, sample } = await buildTasteProfile(watchlist, env, TASTE_PREWARM_SAMPLE_SIZE);
  await kvPut(
    env,
    tasteCacheKey(syncKey),
    JSON.stringify({
      profile,
      sample,
      sig,
      liveCount: watchlist.length,
      ts: Math.floor(Date.now() / 1000),
    }),
  );
  console.log(`Taste profile rebuilt and cached: genres=${Object.keys(profile.genres).length} decades=${Object.keys(profile.decades).length} cast=${Object.keys(profile.cast).length} sample=${sample.length}`);
}

// Geschichtete Auswahl statt reinem Zufall:
// 1. Shortlist (staerkste aktuelle Absicht) -> 2. Gesehen -> 3. Zuletzt hinzugefuegt -> 4. Rest-Zufall
function selectStratifiedTasteSample(watchlist, sampleSize) {
  const valid = watchlist.filter((it) => it && it.tmdbId);
  if (valid.length <= sampleSize) return valid.slice();

  const picked = [];
  const seenIds = new Set();
  const pushUnique = (list, maxCount) => {
    let added = 0;
    for (const it of list) {
      if (picked.length >= sampleSize || added >= maxCount) break;
      const k = `${it.type || 'movie'}_${it.tmdbId}`;
      if (seenIds.has(k)) continue;
      seenIds.add(k);
      picked.push(it);
      added++;
    }
  };

  const shortlisted = valid
    .filter((it) => it.shortlist != null)
    .sort((a, b) => Number(a.shortlist) - Number(b.shortlist));
  pushUnique(shortlisted, 5);

  const watched = valid
    .filter((it) => it.watched)
    .sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0));
  pushUnique(watched, Math.max(4, Math.floor(sampleSize * 0.4)));

  const recentOpen = valid
    .filter((it) => !it.watched && it.shortlist == null)
    .sort((a, b) => (b.addedAt || b.updatedAt || 0) - (a.addedAt || a.updatedAt || 0));
  pushUnique(recentOpen.slice(0, 8), Math.max(3, Math.floor(sampleSize * 0.3)));

  const remaining = valid.filter((it) => !seenIds.has(`${it.type || 'movie'}_${it.tmdbId}`));
  pushUnique(sampleRandom(remaining, sampleSize), sampleSize);
  return picked;
}

function extractAnchorSeeds(watchlist, sample) {
  const valid = watchlist.filter((it) => it && it.tmdbId);
  if (valid.length === 0) return [];
  const sampleTitleByKey = new Map();
  for (const s of sample || []) {
    if (s && s.tmdb_id) sampleTitleByKey.set(`${s.type || 'movie'}_${s.tmdb_id}`, s.title);
  }
  const ranked = valid.slice().sort((a, b) => {
    const sa = a.shortlist != null ? (100 - Number(a.shortlist)) : (a.watched ? 50 : 10);
    const sb = b.shortlist != null ? (100 - Number(b.shortlist)) : (b.watched ? 50 : 10);
    if (sb !== sa) return sb - sa;
    return (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0);
  });
  // Rotiere sanft ueber die Top-6-Anker nach Kalendertag, damit Seed-Tipps taeglich variieren
  const topPool = ranked.slice(0, Math.min(6, ranked.length));
  const dayOffset = Math.floor(Date.now() / 86400000) % topPool.length;
  const rotated = topPool.slice(dayOffset).concat(topPool.slice(0, dayOffset));
  return rotated.slice(0, 3).map((it) => {
    const type = it.type === 'tv' ? 'tv' : 'movie';
    const key = `${type}_${it.tmdbId}`;
    return {
      tmdbId: it.tmdbId,
      type,
      title: it.title || sampleTitleByKey.get(key) || '',
    };
  });
}

async function buildTasteProfile(watchlist, env, sampleSize = TASTE_SAMPLE_SIZE) {
  if (!Array.isArray(watchlist) || watchlist.length === 0) {
    return {
      profile: {
        genres: { 53: 0.95, 18: 0.9, 80: 0.85, 878: 0.8, 28: 0.75, 35: 0.7 },
        decades: { 2020: 1.0, 2010: 0.75 },
        cast: {},
        directors: {},
        avg_rating: 7.2,
      },
      sample: [],
    };
  }

  const samplePick = selectStratifiedTasteSample(watchlist, sampleSize);
  const newestThreshold = samplePick
    .map((x) => x.addedAt || x.updatedAt || 0)
    .sort((a, b) => b - a)[Math.min(5, samplePick.length - 1)] || 0;

  const details = await Promise.all(
    samplePick.map((item) =>
      tmdbGet(
        `${item.type || 'movie'}/${item.tmdbId}`,
        { append_to_response: 'credits' },
        env,
      ).then((data) => ({ item, data })),
    ),
  );

  const genreCounts = new Map();
  const decadeCounts = new Map();
  const castCounts = new Map();
  const directorCounts = new Map();
  const ratings = [];
  const sample = [];

  for (const { item, data } of details) {
    if (!data) continue;
    const isRecent = newestThreshold > 0 && (item.addedAt || item.updatedAt || 0) >= newestThreshold;
    const weight = item.shortlist != null ? 3.0 : (item.watched ? 2.2 : (isRecent ? 1.8 : 1.0));
    const genreIds = (data.genres || []).map((g) => g.id).filter(Boolean);
    for (const gid of genreIds) {
      genreCounts.set(gid, (genreCounts.get(gid) || 0) + weight);
    }
    const dateField = (item.type === 'tv') ? 'first_air_date' : 'release_date';
    const dateStr = data[dateField] || '';
    if (dateStr.length >= 4) {
      const year = parseInt(dateStr.slice(0, 4), 10);
      if (!Number.isNaN(year)) {
        const decade = Math.floor(year / 10) * 10;
        decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + weight);
      }
    }
    if (typeof data.vote_average === 'number' && data.vote_average > 0) {
      const reps = Math.max(1, Math.round(weight));
      for (let i = 0; i < reps; i++) ratings.push(data.vote_average);
    }
    const cast = (data.credits && data.credits.cast) || [];
    for (const member of cast.slice(0, 5)) {
      if (member.id) castCounts.set(member.id, (castCounts.get(member.id) || 0) + weight);
    }
    const crew = (data.credits && data.credits.crew) || [];
    const dir = crew.find((p) => p.job === 'Director');
    if (dir && dir.name) {
      directorCounts.set(dir.name, (directorCounts.get(dir.name) || 0) + weight);
    }
    sample.push({
      tmdb_id: item.tmdbId,
      title: data.title || data.name || item.title || 'Unknown',
      type: item.type || 'movie',
      genre_ids: genreIds,
      weight,
    });
  }

  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 7.0;

  return {
    profile: {
      genres: normalizeMap(genreCounts),
      decades: normalizeMap(decadeCounts),
      cast: normalizeMap(castCounts),
      directors: normalizeMap(directorCounts),
      avg_rating: avgRating,
    },
    sample,
  };
}

function normalizeMap(map) {
  if (map.size === 0) return {};
  const max = Math.max(...map.values());
  const out = {};
  for (const [k, v] of map.entries()) out[k] = v / max;
  return out;
}

function sampleRandom(arr, n) {
  if (arr.length <= n) return arr.slice();
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ─────────────────────────────────────────────────────────────────────────
// Sprach- & Qualitaets-Schranke + Scoring (Magazin v3)
// ─────────────────────────────────────────────────────────────────────────

function passesLanguageAndQualityGate(item, { upcoming = false } = {}) {
  const title = (item.title || '').trim();
  if (!title || title === 'Unknown') return false;
  // Nicht-lateinische Schrift trotz language=de-DE => unlokalisierter Nischentitel
  if (NON_LATIN_SCRIPT_RE.test(title)) return false;

  const lang = (item.original_language || '').toLowerCase();
  const votes = item.vote_count || 0;
  const rating = item.vote_average || 0;
  const overviewLen = (item.overview || '').trim().length;

  // Stufe 1: Deutsch & Englisch (oder leer in Mocks)
  if (!lang || CORE_LANGUAGES.has(lang)) {
    if (!upcoming && votes >= MIN_VOTES && rating < MIN_RATING) return false;
    return true;
  }

  // Stufe 2: Europaeische Nachbarsprachen — solide Resonanz + deutsche Beschreibung
  if (EURO_LANGUAGES.has(lang)) {
    if (overviewLen < 20) return false;
    if (upcoming) return (item.popularity || 0) >= 25;
    return votes >= 90 && rating >= 7.0;
  }

  // Stufe 3: Weltsprachen (KO, JA, HI, TA, TR, ZH …) — nicht ausgeschlossen,
  // aber nur echte globale Ausnahmetitel (z. B. Squid Game, Parasite, Shogun)
  if (overviewLen < 25) return false;
  if (upcoming) return false;
  return votes >= 500 && rating >= 7.4;
}

function scoreWithTaste(item, taste) {
  const gIds = item.genre_ids || [];
  const hasTasteGenres = taste && taste.genres && Object.keys(taste.genres).length > 0;

  let gScore = 0;
  if (gIds.length > 0 && hasTasteGenres) {
    const scores = gIds.map((gid) => taste.genres[gid] || 0).sort((a, b) => b - a);
    const top1 = scores[0] || 0;
    const top2Avg = scores.length > 1 ? (scores[0] + scores[1]) / 2 : top1;
    // Bestraft mehrteilige Blockbuster (Action+Sci-Fi+Abenteuer) nicht mehr durch Durchschnitt ueber alle Genres
    gScore = 0.65 * top1 + 0.35 * top2Avg;
  } else if (!hasTasteGenres) {
    gScore = 0.65;
  }

  // Ohne jeglichen Genre-Bezug (und ohne direkten Seed-Treffer) kein Durchrutschen ueber Dekade+Rating!
  if (hasTasteGenres && gScore < 0.08 && !item._seedTitle) {
    return 0.15;
  }

  const releaseYear = item.release_year || parseReleaseYear(item) || new Date().getFullYear();
  const decade = Math.floor(releaseYear / 10) * 10;
  const dScore = (taste.decades && taste.decades[decade] !== undefined) ? taste.decades[decade] : 0.7;

  const cIds = item.cast_ids || [];
  const hasCast = cIds.length > 0;
  const cScore = hasCast
    ? Math.max(0, ...cIds.map((cid) => (taste.cast && taste.cast[cid]) || 0))
    : 0;

  const rating = (typeof item.vote_average === 'number' && item.vote_average > 0)
    ? item.vote_average
    : null;
  const targetRating = (taste && taste.avg_rating) || 7.2;
  const rScore = rating === null
    ? 0.65
    : Math.min(1, Math.max(0.2, 1 - Math.max(0, targetRating - rating) / 3.5 + Math.max(0, rating - 7.5) * 0.12));

  let base = hasCast
    ? 0.52 * gScore + 0.16 * dScore + 0.14 * cScore + 0.18 * rScore
    : 0.60 * gScore + 0.18 * dScore + 0.22 * rScore;

  // Direkter TMDB-Recommendation-Treffer aus einem Watchlist-Favoriten bekommt echten Relevanz-Bonus
  if (item._seedTitle) {
    base = Math.min(0.98, base + 0.14);
  }
  if (item._isTrending && (rating === null || rating >= 7.2)) {
    base = Math.min(0.98, base + 0.05);
  }

  const lang = (item.original_language || '').toLowerCase();
  const langFactor = (!lang || CORE_LANGUAGES.has(lang))
    ? 1.0
    : (EURO_LANGUAGES.has(lang) ? 0.93 : 0.88);

  // Kalibrierung auf realistische 0..0.98 Skala (damit Web & TV echte Match-% anzeigen)
  const calibrated = Math.min(0.98, base * langFactor * 1.08);
  return Math.round(calibrated * 1000) / 1000;
}

function parseReleaseYear(item) {
  const d = item.release_date || item.first_air_date || '';
  if (d.length < 4) return null;
  const y = parseInt(d.slice(0, 4), 10);
  return Number.isNaN(y) ? null : y;
}

function itemKey(item) {
  const type = item.type || (item.media_type === 'tv' ? 'tv' : 'movie');
  const id = item.tmdb_id || item.id;
  return `${type}_${id}`;
}

function mergeCandidateLists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const it of list || []) {
      if (!it) continue;
      const k = itemKey(it);
      const prev = merged.get(k);
      if (!prev) {
        merged.set(k, it);
      } else {
        if (it._seedTitle && !prev._seedTitle) prev._seedTitle = it._seedTitle;
        if (it._isTrending) prev._isTrending = true;
      }
    }
  }
  return Array.from(merged.values());
}

function prioritizeHeroWithTrailer(items) {
  if (!Array.isArray(items) || items.length < 2) return;
  if (items[0].trailer_key) return;
  const idx = items.findIndex((it, i) => i > 0 && i <= 3 && it.trailer_key && it.taste_score >= items[0].taste_score - 0.08);
  if (idx > 0) {
    const [picked] = items.splice(idx, 1);
    items.unshift(picked);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Discovery — 4-Quellen-Pool (Trending-Blockbuster, Neu-Fenster, Seeds, Katalog)
// ─────────────────────────────────────────────────────────────────────────

async function fetchTrendingWindow(env) {
  const tasks = ['movie', 'tv'].map((mediaType) =>
    tmdbGet(`trending/${mediaType}/week`, { page: 1 }, env).then((data) =>
      (data && Array.isArray(data.results) ? data.results : [])
        .map((r) => ({ ...normalizeDiscoverItem(r, mediaType), _isTrending: true }))),
  );
  const pages = await Promise.all(tasks);
  return mergeCandidateLists(...pages);
}

async function fetchSeedRecommendations(seeds, env) {
  const tasks = seeds
    .filter((s) => s && s.tmdbId)
    .map((seed) =>
      tmdbGet(`${seed.type}/${seed.tmdbId}/recommendations`, { page: 1 }, env).then((data) =>
        (data && Array.isArray(data.results) ? data.results : [])
          .slice(0, 12)
          .map((r) => ({
            ...normalizeDiscoverItem(r, r.media_type === 'tv' ? 'tv' : (r.media_type === 'movie' ? 'movie' : seed.type)),
            _seedTitle: seed.title || null,
          }))),
    );
  const pages = await Promise.all(tasks);
  return mergeCandidateLists(...pages);
}

async function fetchMagazineWindow(dateFrom, dateTo, page, voteCountGte, env, opts = {}) {
  const tasks = [];
  for (const mediaType of ['movie', 'tv']) {
    tasks.push(fetchWindowPage(mediaType, dateFrom, dateTo, page, voteCountGte, env, opts));
  }
  const pages = await Promise.all(tasks);
  return mergeCandidateLists(...pages);
}

async function fetchWindowPage(mediaType, dateFrom, dateTo, page, voteCountGte, env, opts = {}) {
  const upcoming = !!opts.upcoming;
  const providerIdsStr = opts.providerIdsStr || ALL_PROVIDER_IDS_STR;
  const params = {
    sort_by: 'popularity.desc',
    'vote_count.gte': voteCountGte,
    page,
  };
  if (mediaType === 'movie') {
    if (upcoming) {
      params.region = 'DE';
      params.with_release_type = '4|6';
      params['primary_release_date.gte'] = dateFrom;
      params['primary_release_date.lte'] = dateTo;
    } else {
      params.watch_region = 'DE';
      params.with_watch_providers = providerIdsStr;
      params.with_watch_monetization_types = 'flatrate|free|ads';
      params['primary_release_date.gte'] = dateFrom;
      params['primary_release_date.lte'] = dateTo;
    }
  } else {
    params['first_air_date.gte'] = dateFrom;
    params['first_air_date.lte'] = dateTo;
    params.watch_region = 'DE';
    if (!upcoming) {
      params.with_watch_providers = providerIdsStr;
      params.with_watch_monetization_types = 'flatrate|free|ads';
    }
  }
  const data = await tmdbGet(`discover/${mediaType}`, params, env);
  if (!data || !Array.isArray(data.results)) return [];
  return data.results.map((r) => normalizeDiscoverItem(r, mediaType));
}

async function fetchCatalogWindow(topGenreIds, providerIdsStr, env) {
  const page = (Math.floor(Date.now() / 86400000) % CATALOG_PAGE_SPAN) + 1;
  const tasks = ['movie', 'tv'].map((mediaType) =>
    tmdbGet(`discover/${mediaType}`, {
      sort_by: 'popularity.desc',
      'vote_count.gte': CATALOG_MIN_VOTES,
      'vote_average.gte': CATALOG_MIN_RATING,
      with_genres: topGenreIds.join('|'),
      watch_region: 'DE',
      with_watch_providers: providerIdsStr || ALL_PROVIDER_IDS_STR,
      with_watch_monetization_types: 'flatrate|free|ads',
      page,
    }, env).then((data) =>
      (data && Array.isArray(data.results) ? data.results : [])
        .map((r) => normalizeDiscoverItem(r, mediaType))),
  );
  const pages = await Promise.all(tasks);
  return mergeCandidateLists(...pages);
}

function normalizeDiscoverItem(r, mediaType) {
  return {
    tmdb_id: r.id,
    type: mediaType,
    title: r.title || r.name || 'Unknown',
    overview: r.overview || '',
    vote_average: r.vote_average || 0,
    vote_count: r.vote_count || 0,
    genre_ids: r.genre_ids || [],
    release_date: r.release_date || r.first_air_date || '',
    release_year: parseReleaseYear(r),
    popularity: r.popularity || 0,
    original_language: r.original_language || '',
    poster_path: r.poster_path || null,
    backdrop_path: r.backdrop_path || null,
    cast_ids: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring pipeline: exclude watchlist/seen/dismissed → language/quality gate → taste → sort
// ─────────────────────────────────────────────────────────────────────────

function scoreAndFilter(items, taste, watchlistIds, seenState, opts = {}) {
  const relaxVotes = !!opts.relaxVotes;
  const upcoming = !!opts.upcoming;
  const dismissedState = opts.dismissed || {};
  const today = new Date();
  const todayStr = isoDate(today);
  const scored = [];
  const kills = {
    watchlist: 0,
    seen: 0,
    dismissed: 0,
    langQuality: 0,
    lowVotes: 0,
    lowRating: 0,
    belowTaste: 0,
    kept: 0,
  };

  for (const it of items) {
    const key = itemKey(it);
    if (watchlistIds.has(key)) { kills.watchlist++; continue; }
    if (dismissedState[key]) { kills.dismissed++; continue; }
    if (seenState[key]) { kills.seen++; continue; }

    if (!relaxVotes && it.vote_count < 8 && !it._isTrending) { kills.lowVotes++; continue; }
    if (relaxVotes && it.vote_count < 5 && (it.popularity || 0) < 15) { kills.lowVotes++; continue; }
    if (!upcoming && it.vote_average < MIN_RATING && it.vote_count >= MIN_VOTES) { kills.lowRating++; continue; }

    if (!passesLanguageAndQualityGate(it, { upcoming })) {
      kills.langQuality++;
      continue;
    }

    const taste_score = scoreWithTaste(it, taste);
    if (taste_score < MEDIUM_THRESHOLD) { kills.belowTaste++; continue; }

    const popularity = it.popularity || 0;
    let recencyBoost = 1.0;
    if (it.release_date) {
      const releaseTs = new Date(it.release_date).getTime();
      if (!Number.isNaN(releaseTs)) {
        const daysFrom = Math.abs((releaseTs - today.getTime()) / 86400000);
        recencyBoost = 1.0 + 0.45 * Math.max(0, 1 - daysFrom / 120);
      }
    }
    const seedBoost = it._seedTitle ? 1.12 : 1.0;
    const isUpcoming = it.release_date && it.release_date > todayStr;
    const rankScore = (Math.log10(Math.max(popularity, 1)) * 2.1 + it.vote_average + taste_score * 6.5) * recencyBoost * seedBoost;

    kills.kept++;
    scored.push({
      ...it,
      key,
      taste_score,
      rank_score: rankScore,
      is_upcoming: isUpcoming,
    });
  }

  scored.sort((a, b) => b.rank_score - a.rank_score);
  return { list: scored, kills };
}

// ─────────────────────────────────────────────────────────────────────────
// Magazine enrichment — ONE combined TMDB call per candidate
// ─────────────────────────────────────────────────────────────────────────

async function enrichMagazineItems(scored, limit, opts, taste, tasteSample, env, note) {
  const { requireProviders, reasonPrefix = '', rejectOldPrimaryYear = null, memberProviders = null, maxCalls = MAGAZINE_ENRICH_CAP } = opts || {};
  const sectionCallCap = Math.min(MAGAZINE_ENRICH_CAP, Math.max(1, maxCalls));
  const out = [];
  let detailCalls = 0;

  for (const c of scored) {
    if (out.length >= limit) break;
    if (detailCalls >= sectionCallCap) {
      note(`Section enrich cap reached (${sectionCallCap}) — stopping`);
      break;
    }
    if (tmdbCalls >= TMDB_CALL_CEILING) {
      ceilingHit = true;
      note(`TMDB call ceiling reached (${TMDB_CALL_CEILING}) — stopping enrichment`);
      break;
    }

    detailCalls++;
    const data = await tmdbGet(
      `${c.type}/${c.tmdb_id}`,
      {
        append_to_response: 'credits,watch/providers,videos,release_dates,content_ratings,keywords,recommendations',
        include_video_language: 'de,en,null',
      },
      env,
    );
    if (!data) continue;

    // Schutz Stufe 2 gegen Kino-Wiederauffuehrungen alter Klassiker in "Demnaechst"
    const worldPrimaryDate = (c.type === 'tv' ? data.first_air_date : data.release_date) || c.release_date || '';
    const worldPrimaryYear = worldPrimaryDate.length >= 4 ? parseInt(worldPrimaryDate.slice(0, 4), 10) : null;
    if (rejectOldPrimaryYear && worldPrimaryYear && !Number.isNaN(worldPrimaryYear) && worldPrimaryYear < rejectOldPrimaryYear) {
      continue;
    }

    // Echte Detail-Bewertung nachpruefen (verhindert 5.8-Durchrutscher)
    const detailVotes = typeof data.vote_count === 'number' ? data.vote_count : c.vote_count;
    const detailRating = typeof data.vote_average === 'number' && data.vote_average > 0 ? data.vote_average : c.vote_average;
    if (!c.is_upcoming && !rejectOldPrimaryYear && detailVotes >= 15 && detailRating < MIN_RATING) {
      continue;
    }

    const de = data['watch/providers'] && data['watch/providers'].results
      ? data['watch/providers'].results.DE
      : null;

    const matchedSvcIds = new Set();
    if (de) {
      for (const cat of ['flatrate', 'free', 'ads']) {
        for (const p of de[cat] || []) {
          const svc = MAGAZINE_BY_TMDB.get(p.provider_id);
          if (!svc) continue;
          if (memberProviders && !memberProviders.allowedServiceIds.has(svc.id)) continue;
          matchedSvcIds.add(svc.id);
        }
      }
    }
    if (requireProviders && matchedSvcIds.size === 0) continue;

    // Sortiere Anbieter nach persoenlicher Nutzungs-Reihenfolge des Familienprofils (freie Mediatheken + Lieblingsabos zuerst)
    const orderedSvcIds = Array.from(matchedSvcIds).sort((a, b) => {
      const rankMap = memberProviders && memberProviders.preferredRank;
      const ra = rankMap && rankMap.has(a) ? rankMap.get(a) : 999;
      const rb = rankMap && rankMap.has(b) ? rankMap.get(b) : 999;
      if (ra !== rb) return ra - rb;
      const sa = AVAILABILITY_SERVICES.findIndex((s) => s.id === a);
      const sb = AVAILABILITY_SERVICES.findIndex((s) => s.id === b);
      return sa - sb;
    });
    const providerNames = orderedSvcIds.map((id) => SERVICE_DISPLAY_NAMES[id]).filter(Boolean);

    const castList = ((data.credits && data.credits.cast) || []).slice(0, 5);
    const cast = castList
      .map((m) => ({ name: m.name, profile_path: m.profile_path || null }))
      .filter((m) => m.name);

    const genreNames = (data.genres || [])
      .map((g) => g.name || GENRE_MAP[g.id])
      .filter(Boolean)
      .slice(0, 3);

    const country = c.type === 'tv'
      ? ((data.origin_country && data.origin_country[0]) || null)
      : ((data.production_countries && data.production_countries[0] && data.production_countries[0].iso_3166_1) || null);

    // ── Magazin v3 Trailer-Extraktion: Trailer bevorzugt, Teaser/Clip als Fallback, DE vor EN vor International ──
    const vids = ((data.videos && data.videos.results) || []).filter(
      (v) => v && v.site === 'YouTube' && v.key && (v.type === 'Trailer' || v.type === 'Teaser' || v.type === 'Clip'),
    );
    const typeRank = (t) => (t === 'Trailer' ? 0 : (t === 'Teaser' ? 1 : 2));
    const langRank = (l) => (l === 'de' ? 0 : (l === 'en' ? 1 : 2));
    vids.sort((a, b) => {
      if (typeRank(a.type) !== typeRank(b.type)) return typeRank(a.type) - typeRank(b.type);
      if (!!b.official !== !!a.official) return (b.official ? 1 : 0) - (a.official ? 1 : 0);
      return langRank(a.iso_639_1) - langRank(b.iso_639_1);
    });
    const trailer_key = vids.length ? vids[0].key : null;

    const director = c.type === 'tv'
      ? ((data.created_by && data.created_by[0] && data.created_by[0].name) || null)
      : (((data.credits && data.credits.crew) || []).find((p) => p.job === 'Director') || {}).name || null;

    const tagline = data.tagline || null;

    let certification = null;
    if (c.type === 'tv') {
      const deRating = ((data.content_ratings && data.content_ratings.results) || [])
        .find((r) => r.iso_3166_1 === 'DE');
      certification = (deRating && deRating.rating) || null;
    } else {
      const deRel = ((data.release_dates && data.release_dates.results) || [])
        .find((r) => r.iso_3166_1 === 'DE');
      const withCert = deRel && Array.isArray(deRel.release_dates)
        ? deRel.release_dates.find((x) => x.certification)
        : null;
      certification = (withCert && withCert.certification) || null;
    }

    let upcoming_date = null;
    if (c.type !== 'tv') {
      const deRel = ((data.release_dates && data.release_dates.results) || [])
        .find((r) => r.iso_3166_1 === 'DE');
      if (deRel && Array.isArray(deRel.release_dates)) {
        const today = isoDate(new Date());
        upcoming_date = deRel.release_dates
          .filter((x) => (x.type === 4 || x.type === 6) && x.release_date)
          .map((x) => x.release_date.slice(0, 10))
          .filter((d) => d >= today)
          .sort()[0] || null;
      }
    }

    const kwRaw = c.type === 'tv'
      ? ((data.keywords && data.keywords.results) || [])
      : ((data.keywords && data.keywords.keywords) || []);
    const keywords = kwRaw.slice(0, 4).map((k) => k.name).filter(Boolean);

    const recommendations = ((data.recommendations && data.recommendations.results) || [])
      .slice(0, 2)
      .map((r) => ({ id: r.id, title: r.title || r.name || '', poster_path: r.poster_path || null }))
      .filter((r) => r.title);

    // Persoenlicher Anbieter-Bonus im finalen Taste-Score
    let finalTaste = c.taste_score;
    if (memberProviders && orderedSvcIds.length > 0 && memberProviders.preferredRank.has(orderedSvcIds[0])) {
      const pos = memberProviders.preferredRank.get(orderedSvcIds[0]);
      if (pos <= 2) finalTaste = Math.min(0.98, Math.round((finalTaste + 0.03) * 1000) / 1000);
    }
    const fanOf = c._seedTitle || pickFanOf(c, tasteSample);
    const displayTitle = c.title !== 'Unknown' ? c.title : (data.title || data.name || c.title);
    const displayYear = (worldPrimaryDate || c.release_date || '').slice(0, 4);

    out.push({
      key: c.key,
      tmdb_id: c.tmdb_id,
      type: c.type,
      title: displayTitle,
      year: displayYear,
      release_date: worldPrimaryDate || c.release_date,
      is_upcoming: !!c.is_upcoming || !!upcoming_date,
      upcoming_date,
      rating: Math.round(detailRating * 10) / 10,
      vote_count: detailVotes,
      taste_score: finalTaste,
      match_pct: Math.max(70, Math.min(98, Math.round(finalTaste * 100))),
      genres: genreNames,
      genre_ids: c.genre_ids,
      providers: providerNames,
      providers_app: orderedSvcIds,
      cast,
      director,
      tagline,
      certification,
      keywords,
      recommendations,
      trailer_key,
      trailer_search_query: `${displayTitle} ${displayYear} Trailer Deutsch`.trim(),
      original_language: c.original_language || null,
      country,
      runtime: c.type === 'movie' ? (data.runtime || null) : null,
      seasons: c.type === 'tv' ? (data.number_of_seasons || null) : null,
      episodes: c.type === 'tv' ? (data.number_of_episodes || null) : null,
      overview: data.overview || c.overview || '',
      poster_path: data.poster_path || c.poster_path,
      backdrop_path: data.backdrop_path || c.backdrop_path,
      reason: (reasonPrefix || '') + buildReason(c, taste, castList, director, providerNames[0]),
      fan_of: fanOf,
    });
  }
  return out;
}

function buildReason(c, taste, castList, director, topProviderName) {
  const parts = [];

  if (c._seedTitle) {
    parts.push(`Weil „${c._seedTitle}“ auf deiner Liste steht`);
  } else if (c._isTrending && topProviderName) {
    parts.push(`Aktueller Blockbuster-Trend bei ${topProviderName}`);
  }

  const matchedGenres = (c.genre_ids || [])
    .filter((gid) => (taste.genres[gid] || 0) >= 0.35)
    .sort((a, b) => (taste.genres[b] || 0) - (taste.genres[a] || 0))
    .slice(0, 2)
    .map((gid) => GENRE_MAP[gid])
    .filter(Boolean);
  if (matchedGenres.length > 0 && parts.length < 2) {
    parts.push(`${matchedGenres.join(' & ')} trifft dein Profil`);
  }

  const tasteCast = castList.find((m) => m.id && (taste.cast[m.id] || 0) > 0);
  if (tasteCast && parts.length < 3) {
    parts.push(`mit ${tasteCast.name}`);
  } else if (director && taste.directors && taste.directors[director] && parts.length < 3) {
    parts.push(`von ${director}`);
  }

  if (parts.length < 2 && typeof c.vote_average === 'number' && c.vote_average >= 7.5) {
    parts.push(`Stark bewertet (${c.vote_average.toFixed(1).replace('.', ',')} ★)`);
  }

  if (parts.length === 0) {
    parts.push('Passend zu deinem Geschmacksprofil kuratiert');
  }
  return parts.slice(0, 3).join(' · ');
}

function pickFanOf(c, tasteSample) {
  if (!Array.isArray(tasteSample) || tasteSample.length === 0) return null;
  const cGenres = new Set(c.genre_ids || []);
  if (cGenres.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const s of tasteSample) {
    const overlap = (s.genre_ids || []).filter((g) => cGenres.has(g)).length;
    if (overlap === 0) continue;
    const weighted = overlap * 10 + (s.weight || 1);
    if (weighted > bestScore) {
      bestScore = weighted;
      best = s;
    }
  }
  const minOverlap = cGenres.size === 1 ? 1 : 2;
  const bestOverlap = best ? (best.genre_ids || []).filter((g) => cGenres.has(g)).length : 0;
  return bestOverlap >= minOverlap ? best.title : null;
}


// ─────────────────────────────────────────────────────────────────────────
// Live-TV & 20:15 3-Spur-EPG (Paket B: 10 Echt-Live-Sender)
// ─────────────────────────────────────────────────────────────────────────

const LIVE_TV_KV_KEY = 'live_tv:v2';
const LIVE_TV_TTL_MS = 10 * 60 * 1000;
const LIVE_TV_FORCE_COOLDOWN_MS = 30 * 1000;
const LIVE_TV_FETCH_TIMEOUT_MS = 4500;
const LIVE_TV_TMDB_MAX = 4;
const LIVE_TV_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const LIVE_TV_CURATED_CHANNELS = [
  { channel: 'Das Erste', aliases: ['das erste', 'ard', 'das erste hd'], shortChannel: 'DAS ERSTE', slug: 'das-erste,ARD.html', track: 'sat', trackLabel: 'SAT HD', badge: 'ARD', webUrl: 'https://www.ardmediathek.de/live/Y3JpZDovL2Rhc2Vyc3RlLmRlL2xpdmUvY2xpcC9hYmNhMDdhMy0zNDc2LTQ4NTEtYjE2Mi1mZGU4ZjY0NmQ0YzQ', mediathekServiceId: 'ard', kind: 'general' },
  { channel: 'ZDF', aliases: ['zdf', 'zdf hd'], shortChannel: 'ZDF HD', slug: 'zdf,ZDF.html', track: 'sat', trackLabel: 'SAT HD', badge: 'ZDF', webUrl: 'https://www.zdf.de/live-tv', mediathekServiceId: 'zdf', kind: 'general' },
  { channel: 'Sky Sport Bundesliga', aliases: ['sky sport bundesliga', 'sky sport bundesliga hd'], shortChannel: 'SKY BUNDESLIGA', slug: 'sky-sport-bundesliga,BULI.html', track: 'sky', trackLabel: 'SKY · 202', badge: 'SKY', webUrl: 'https://www.sky.de/tvguide', mediathekServiceId: 'sky', kind: 'sport' },
  { channel: 'Sky Sport Top Event', aliases: ['sky sport top event', 'sky sport top event hd'], shortChannel: 'SKY TOP EVENT', slug: 'sky-sport-top-event,SKYSTE.html', track: 'sky', trackLabel: 'SKY · 201', badge: 'SKY', webUrl: 'https://www.sky.de/tvguide', mediathekServiceId: 'sky', kind: 'sport' },
  { channel: 'Sky Sport News', aliases: ['sky sport news', 'sky sport news hd'], shortChannel: 'SKY SPORT NEWS', slug: 'sky-sport-news,SNHD.html', track: 'sky', trackLabel: 'SKY · 200', badge: 'SKY', webUrl: 'https://www.sky.de/tvguide', mediathekServiceId: 'sky', kind: 'sport' },
  { channel: 'Sky Sport Premier League', aliases: ['sky sport premier league', 'sky sport premier league hd'], shortChannel: 'SKY PREMIER L.', slug: 'sky-sport-premier-league,SKYSPL.html', track: 'sky', trackLabel: 'SKY · 203', badge: 'SKY', webUrl: 'https://www.sky.de/tvguide', mediathekServiceId: 'sky', kind: 'sport' },
  { channel: 'Sky Sport F1', aliases: ['sky sport f1', 'sky sport f1 hd'], shortChannel: 'SKY SPORT F1', slug: 'sky-sport-f1,SKYF1.html', track: 'sky', trackLabel: 'SKY · 207', badge: 'SKY', webUrl: 'https://www.sky.de/tvguide', mediathekServiceId: 'sky', kind: 'sport' },
  { channel: 'RTL', aliases: ['rtl', 'rtl hd'], shortChannel: 'RTL HD', slug: 'rtl,RTL.html', track: 'magenta', trackLabel: 'MAGENTA HD', badge: 'RTL+', webUrl: 'https://plus.rtl.de/rtl/live', mediathekServiceId: 'rtl', kind: 'general' },
  { channel: 'Sat.1', aliases: ['sat.1', 'sat1', 'sat 1', 'sat.1 hd'], shortChannel: 'SAT.1 HD', slug: 'sat1,SAT1.html', track: 'magenta', trackLabel: 'MAGENTA HD', badge: 'JOYN', webUrl: 'https://www.joyn.de/play/live-tv?channel_id=139', mediathekServiceId: 'joyn', kind: 'general' },
  { channel: 'ProSieben', aliases: ['prosieben', 'pro7', 'prosieben hd'], shortChannel: 'PROSIEBEN', slug: 'prosieben,PRO7.html', track: 'magenta', trackLabel: 'MAGENTA HD', badge: 'JOYN', webUrl: 'https://www.joyn.de/play/live-tv?channel_id=138', mediathekServiceId: 'joyn', kind: 'general' },
];

const LIVE_TV_CHANNEL_BY_ALIAS = new Map();
for (const ch of LIVE_TV_CURATED_CHANNELS) {
  for (const a of ch.aliases) {
    LIVE_TV_CHANNEL_BY_ALIAS.set(a, ch);
  }
}

const LIVE_TV_NON_TMDB_RE = /\b(tagesschau|heute\b|wetter|mittagsmagazin|morgenmagazin|nachtmagazin|punkt\s*12|brisant|hallo deutschland|bundesliga|2\.\s*bundesliga|tennis|formel\s*[12]|f1\b|grand prix|doppelpass|sportstudio|nachrichten|teletext|börse|boerse|sky sport|premier league|champions league|europa league|dfb-pokal|länderspiel|laenderspiel|wm-quali|em-quali|atp\b|wta\b|nfl\b|nhl\b|darts|tv total|wer wird millionär|wer weiss denn sowas|wer weiß denn sowas|bauer sucht frau|galileo|newstime|exclusiv|explosiv|zdf magazin|heute-show|maischberger|markus lanz|maybrit illner|hart aber fair|arenal)\b/i;

function resolveChannelMeta(rawChannel) {
  const clean = String(rawChannel || '').replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  const bare = lower.replace(/\s+(hd|uhd)$/i, '').trim();
  const cfg = LIVE_TV_CHANNEL_BY_ALIAS.get(lower) || LIVE_TV_CHANNEL_BY_ALIAS.get(bare);
  if (!cfg) return null;
  return {
    channel: cfg.channel,
    shortChannel: cfg.shortChannel,
    track: cfg.track,
    trackLabel: cfg.trackLabel,
    badge: cfg.badge,
    webUrl: cfg.webUrl,
    mediathekServiceId: cfg.mediathekServiceId,
  };
}

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function upgradeTvSpielfilmImg(url) {
  if (!url) return '';
  return String(url).replace(/Resize,width=\d+/i, 'Resize,width=1280');
}

function berlinMinutesNow(nowDate = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(nowDate);
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return (h % 24) * 60 + m;
  } catch {
    return nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
  }
}

function parseHhMmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return (Number(m[1]) % 24) * 60 + Number(m[2]);
}

function computeProgressPct(startStr, endStr, nowMin, isLiveSlot) {
  const start = parseHhMmToMinutes(startStr);
  if (start === null) return isLiveSlot ? 40 : 0;
  let end = parseHhMmToMinutes(endStr);
  if (end === null) {
    if (!isLiveSlot) return 0;
    end = start + 55;
  }
  let cur = nowMin;
  if (end <= start) end += 1440;
  if (cur < start && cur + 1440 <= end + 60) cur += 1440;
  if (cur < start) return 0;
  if (cur >= end) return 96;
  const pct = Math.round(((cur - start) / Math.max(10, end - start)) * 100);
  return Math.max(5, Math.min(96, pct));
}

function parseTvSpielfilmRss(xmlText, slot, nowMin) {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const items = [];
  const itemMatches = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemMatches) {
    const rawTitle = decodeXmlEntities((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    if (!rawTitle) continue;
    const parts = rawTitle.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const startTime = parts[0];
    const rawChannel = parts[1];
    const title = parts.slice(2).join(' | ');
    const desc = decodeXmlEntities((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '');
    const encMatch = block.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
    const imageUrl = encMatch ? upgradeTvSpielfilmImg(decodeXmlEntities(encMatch[1])) : '';
    const meta = resolveChannelMeta(rawChannel);
    if (!meta) continue;
    const isLive = slot === 'now';
    const progressPct = isLive ? computeProgressPct(startTime, '', nowMin, true) : 0;
    const idSlug = `${meta.track}_${meta.shortChannel}_${startTime}_${title}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 64);

    items.push({
      id: idSlug,
      ...meta,
      title,
      description: desc,
      startTime,
      endTime: '',
      isLive,
      progressPct,
      slot,
      imageUrl,
      tmdbId: null,
      mediaType: null,
      rating: null,
      posterPath: null,
    });
  }
  return items;
}

function extractCol3Title(col3Html) {
  if (!col3Html) return '';
  const sendungMatch = col3Html.match(/<a[^>]+href="[^"]*\/tv-programm\/sendung\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (sendungMatch) {
    const t = decodeXmlEntities(sendungMatch[1]);
    if (t) return t;
  }
  for (const m of col3Html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = decodeXmlEntities(m[1]);
    if (t) return t;
  }
  const strongMatch = col3Html.match(/<strong>([\s\S]*?)<\/strong>/i);
  return strongMatch ? decodeXmlEntities(strongMatch[1]) : '';
}

function buildLiveItemFromRow(chCfg, rowMeta, { isLive, slot }) {
  const { startTime, endTime, title, desc, progressPct } = rowMeta;
  const suffix = slot === 'primetime' ? '2015_' : '';
  return {
    id: `${chCfg.track}_${chCfg.shortChannel}_${suffix}${startTime}_${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 64),
    channel: chCfg.channel,
    shortChannel: chCfg.shortChannel,
    track: chCfg.track,
    trackLabel: chCfg.trackLabel,
    badge: chCfg.badge,
    webUrl: chCfg.webUrl,
    mediathekServiceId: chCfg.mediathekServiceId,
    title,
    description: desc,
    startTime,
    endTime,
    isLive,
    progressPct: isLive ? progressPct : 0,
    slot,
    imageUrl: '',
    tmdbId: null,
    mediaType: null,
    rating: null,
    posterPath: null,
  };
}

function pickPrimetimeRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Tier 1: Haupt-20:15-Sendung (>= 25 Min., Start 20:00..20:45 — ueberspringt 5-Min.-Vorlauf & kurze Nachrichten)
  const tier1 = rows
    .filter((r) => r.startMin >= 20 * 60 && r.startMin <= 20 * 60 + 45 && r.dur >= 25)
    .sort((a, b) => Math.abs(a.startMin - (20 * 60 + 15)) - Math.abs(b.startMin - (20 * 60 + 15)));
  if (tier1.length > 0) return tier1[0];

  // Tier 2: Laengere Live-Uebertragung ab 19:15..20:14 ueber 20:15 hinweg (z. B. 19:30-21:30 Bundesliga)
  const tier2 = rows
    .filter((r) => r.startMin >= 19 * 60 + 15 && r.startMin < 20 * 60 + 15 && r.endAdj >= 20 * 60 + 35)
    .sort((a, b) => b.startMin - a.startMin);
  if (tier2.length > 0) return tier2[0];

  // Tier 3: Fallback fuer Sendungen rund um 20:20 oder im klassischen 19:45..21:15-Fenster
  const tier3 = rows.filter(
    (r) => (r.startMin <= 20 * 60 + 20 && r.endAdj > 20 * 60 + 20)
      || (r.startMin >= 19 * 60 + 45 && r.startMin <= 21 * 60 + 15),
  );
  if (tier3.length === 0) return null;
  tier3.sort((a, b) => Math.abs(a.startMin - (20 * 60 + 15)) - Math.abs(b.startMin - (20 * 60 + 15)));
  return tier3[0];
}

function parseChannelScheduleHtml(html, chCfg, nowMin) {
  if (!html || typeof html !== 'string' || !chCfg) return { live: null, primetime: null };
  const rows = html.match(/<tr[^>]*class="hover"[\s\S]*?<\/tr>/gi) || [];
  const parsed = [];
  for (const row of rows.slice(0, 40)) {
    const tm = row.match(/(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/);
    const col3 = row.match(/class="col-3"[^>]*>([\s\S]*?)<\/td>/i);
    if (!tm || !col3) continue;
    const title = extractCol3Title(col3[1]);
    if (!title) continue;
    const col4 = row.match(/class="col-4"[^>]*>([\s\S]*?)<\/td>/i);
    const col5 = row.match(/class="col-5"[^>]*>([\s\S]*?)<\/td>/i);
    const genre = col4 ? decodeXmlEntities(col4[1]) : '';
    const cat = col5 ? decodeXmlEntities(col5[1]) : '';
    const descHead = genre && cat && genre.toLowerCase() !== cat.toLowerCase()
      ? `${genre} (${cat})`
      : (genre || cat);
    const desc = descHead ? `${descHead} · ${chCfg.channel}` : chCfg.channel;

    const startTime = tm[1];
    const endTime = tm[2];
    const startMin = parseHhMmToMinutes(startTime);
    const rawEndMin = parseHhMmToMinutes(endTime);
    if (startMin === null || rawEndMin === null) continue;
    const endAdj = rawEndMin <= startMin ? rawEndMin + 1440 : rawEndMin;
    const dur = endAdj - startMin;
    let cur = nowMin;
    if (cur < startMin && cur + 1440 <= endAdj + 30) cur += 1440;
    const isLive = cur >= startMin && cur < endAdj;
    const progressPct = isLive ? computeProgressPct(startTime, endTime, nowMin, true) : 0;

    parsed.push({ startTime, endTime, startMin, endAdj, dur, title, desc, isLive, progressPct });
  }
  if (parsed.length === 0) return { live: null, primetime: null };
  const liveRow = parsed.find((x) => x.isLive) || parsed[0];
  const primeRow = pickPrimetimeRow(parsed);
  return {
    live: liveRow ? buildLiveItemFromRow(chCfg, liveRow, { isLive: true, slot: 'now' }) : null,
    primetime: primeRow ? buildLiveItemFromRow(chCfg, primeRow, { isLive: false, slot: 'primetime' }) : null,
  };
}

async function fetchTextTimeout(url, timeoutMs = LIVE_TV_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': LIVE_TV_BROWSER_UA, Accept: 'application/xml,text/xml,text/html,application/json,*/*' },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichLiveHighlights(candidates, env) {
  if (!env.TMDB_API_KEY || !Array.isArray(candidates) || candidates.length === 0) return;
  const seenTitles = new Set();
  let enriched = 0;
  for (const item of candidates) {
    if (enriched >= LIVE_TV_TMDB_MAX || tmdbCalls >= TMDB_CALL_CEILING) break;
    if (!item || !item.title || item.slot === 'sport' || item.track === 'sky') continue;
    if (LIVE_TV_NON_TMDB_RE.test(item.title)) continue;
    const normTitle = item.title.replace(/\s*\([^)]*\)\s*$/g, '').trim();
    const key = normTitle.toLowerCase();
    if (!normTitle || normTitle.length < 3 || seenTitles.has(key)) continue;
    seenTitles.add(key);

    enriched++;
    const data = await tmdbGet('search/multi', { query: normTitle, page: 1, include_adult: false }, env);
    const hit = data && Array.isArray(data.results)
      ? data.results.find((r) => (r.media_type === 'movie' || r.media_type === 'tv') && (r.backdrop_path || r.poster_path))
      : null;
    if (hit) {
      item.tmdbId = hit.id;
      item.mediaType = hit.media_type;
      item.rating = typeof hit.vote_average === 'number' && hit.vote_average > 0
        ? Math.round(hit.vote_average * 10) / 10
        : null;
      item.posterPath = hit.poster_path || null;
      if (hit.backdrop_path) {
        item.imageUrl = `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}`;
      }
    }
  }
}

function dedupeLiveItems(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it || !it.channel || !it.title) continue;
    const k = `${it.channel.toLowerCase()}|${it.startTime}|${it.title.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function handleLiveTv(env, url) {
  tmdbCalls = 0;
  kvCalls = 0;
  ceilingHit = false;

  const nowMs = Date.now();
  const force = url.searchParams.get('force') === '1';
  let cached = null;
  try {
    cached = await kvGet(env, LIVE_TV_KV_KEY, 'json');
  } catch {
    cached = null;
  }

  if (cached && typeof cached.generatedAt === 'number') {
    const ageMs = nowMs - cached.generatedAt;
    if ((!force && ageMs < LIVE_TV_TTL_MS) || (force && ageMs < LIVE_TV_FORCE_COOLDOWN_MS)) {
      return jsonResponse({ ...cached, cached: true });
    }
  }

  const nowMin = berlinMinutesNow(new Date(nowMs));
  const [jetztXml, p2015Xml, bl1Text, ...channelHtmls] = await Promise.all([
    fetchTextTimeout('https://www.tvspielfilm.de/tv-programm/rss/jetzt.xml'),
    fetchTextTimeout('https://www.tvspielfilm.de/tv-programm/rss/heute2015.xml'),
    fetchTextTimeout('https://api.openligadb.de/getmatchdata/bl1'),
    ...LIVE_TV_CURATED_CHANNELS.map((c) => fetchTextTimeout(`https://www.tvspielfilm.de/tv-programm/sendungen/${c.slug}`)),
  ]);

  const nowRss = parseTvSpielfilmRss(jetztXml, 'now', nowMin);
  const primeRss = parseTvSpielfilmRss(p2015Xml, 'primetime', nowMin);

  // Image & synopsis lookup by channel+title from RSS feeds
  const rssImageMap = new Map();
  const rssDescMap = new Map();
  for (const it of [...primeRss, ...nowRss]) {
    const key = `${it.channel.toLowerCase()}|${it.title.toLowerCase()}`;
    if (it.imageUrl && !rssImageMap.has(key)) rssImageMap.set(key, it.imageUrl);
    if (it.description && !rssDescMap.has(key)) rssDescMap.set(key, it.description);
  }

  const applyRssMeta = (entry) => {
    const key = `${entry.channel.toLowerCase()}|${entry.title.toLowerCase()}`;
    const img = rssImageMap.get(key);
    const desc = rssDescMap.get(key);
    if (img) entry.imageUrl = img;
    if (desc && desc.length > (entry.description || '').length) entry.description = desc;
    return entry;
  };

  const htmlNow = [];
  const htmlPrime = [];
  const htmlNowChannels = new Set();
  const htmlPrimeChannels = new Set();

  LIVE_TV_CURATED_CHANNELS.forEach((chCfg, idx) => {
    const { live, primetime } = parseChannelScheduleHtml(channelHtmls[idx], chCfg, nowMin);
    if (live) {
      htmlNow.push(applyRssMeta(live));
      htmlNowChannels.add(live.channel.toLowerCase());
    }
    if (primetime) {
      htmlPrime.push(applyRssMeta(primetime));
      htmlPrimeChannels.add(primetime.channel.toLowerCase());
    }
  });

  const nowMerged = dedupeLiveItems([
    ...htmlNow,
    ...nowRss.filter((x) => !htmlNowChannels.has(x.channel.toLowerCase())),
  ]).slice(0, 15);

  const primetimeMerged = dedupeLiveItems([
    ...htmlPrime,
    ...primeRss.filter((x) => {
      if (htmlPrimeChannels.has(x.channel.toLowerCase())) return false;
      const m = parseHhMmToMinutes(x.startTime);
      return m === null || (m >= 19 * 60 + 15 && m <= 21 * 60 + 15);
    }),
  ]).slice(0, 15);

  // Next Bundesliga fixture card on Sky Sport Bundesliga (supplemental OpenLigaDB card)
  const sportList = [];
  if (bl1Text) {
    try {
      const matches = JSON.parse(bl1Text);
      const nextMatch = Array.isArray(matches)
        ? matches.find((m) => m && !m.matchIsFinished && m.team1 && m.team2)
        : null;
      if (nextMatch) {
        const t1 = nextMatch.team1.shortName || nextMatch.team1.teamName;
        const t2 = nextMatch.team2.shortName || nextMatch.team2.teamName;
        const dtStr = String(nextMatch.matchDateTime || '');
        const hhmm = dtStr.length >= 16 ? dtStr.slice(11, 16) : '20:30';
        const dateLabel = dtStr.length >= 10 ? `${dtStr.slice(8, 10)}.${dtStr.slice(5, 7)}.` : '';
        const meta = resolveChannelMeta('Sky Sport Bundesliga');
        sportList.push({
          id: `sky_bl1_${t1}_${t2}`.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          ...meta,
          title: `Bundesliga: ${t1} – ${t2}`,
          description: `${dateLabel ? dateLabel + ' · ' : ''}${hhmm} Uhr · Live auf Sky Sport Bundesliga`,
          startTime: hhmm,
          endTime: '',
          isLive: false,
          progressPct: 0,
          slot: 'sport',
          imageUrl: '',
          tmdbId: null,
          mediaType: null,
          rating: null,
          posterPath: null,
        });
      }
    } catch {
      // ignore invalid OpenLigaDB JSON
    }
  }

  const sportMerged = dedupeLiveItems(sportList).slice(0, 4);

  // Enrich only rare non-sport Free-TV movies/series via TMDB (strictly <= 4 calls, never Sky Sport)
  const enrichTargets = [
    ...primetimeMerged.filter((x) => x.track !== 'sky'),
    ...nowMerged.filter((x) => x.track !== 'sky'),
  ];
  await enrichLiveHighlights(enrichTargets, env);

  // Curated mixed spotlight across all 3 tracks (Sat · Sky Sport · Magenta)
  const spotlight = dedupeLiveItems([
    ...nowMerged.filter((x) => x.track === 'sky').slice(0, 2),
    ...primetimeMerged.filter((x) => x.track === 'sat').slice(0, 2),
    ...nowMerged.filter((x) => x.track === 'sat').slice(0, 2),
    ...primetimeMerged.filter((x) => x.track === 'magenta').slice(0, 2),
    ...sportMerged.slice(0, 1),
    ...primetimeMerged,
    ...nowMerged,
  ]).slice(0, 10);

  const hasAny = spotlight.length > 0 || nowMerged.length > 0 || primetimeMerged.length > 0;
  if (!hasAny && cached) {
    return jsonResponse({ ...cached, cached: true, stale: true });
  }

  const payload = {
    ok: true,
    generatedAt: nowMs,
    spotlight,
    now: nowMerged,
    primetime: primetimeMerged,
    sport: sportMerged,
  };

  if (hasAny) {
    try {
      await kvPut(env, LIVE_TV_KV_KEY, JSON.stringify(payload));
    } catch {
      // non-fatal cache write failure
    }
  }

  return jsonResponse({ ...payload, cached: false });
}


// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
