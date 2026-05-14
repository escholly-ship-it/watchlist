// Watchlist Sync API + Recommendation Engine — Cloudflare Worker + KV
// Multi-tenant: each sync key = separate watchlist namespace
//
// Endpoints:
//   GET  /sync       — return owner's watchlist (auth: X-API-Key header)
//   PUT  /sync       — save owner's watchlist (auth: X-API-Key header)
//   POST /recommend  — manual trigger of recommendation pipeline
//                      auth: X-Admin-Key header == env.ADMIN_KEY
//                      ?dryRun=1 → skip Telegram, return preview JSON
//
// Scheduled handler runs the same recommendation pipeline on cron.
//
// Ported from watchlist/recommend.py (Cowork repo). Plan B (2026-05-14):
//   Producer-Konsolidierung Mac/GHA/CC → Cloudflare Worker als single source.
//   Match-Schwelle MEDIUM = scoreWithTaste >= 0.35 (User-Decision 2026-05-14).

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
};

const MIN_KEY_LENGTH = 32;

// Scholly's streaming providers (TMDB provider IDs → display name).
// Keep parity with recommend.py PROVIDER_IDS.
const PROVIDER_IDS = {
  8: 'Netflix',
  9: 'Amazon Prime Video',
  119: 'Amazon Prime Video',
  337: 'Disney+',
  350: 'Apple TV+',
  30: 'Sky',
  531: 'Paramount+',
  178: 'MagentaTV',
  421: 'Joyn',
  1773: 'Joyn',
  219: 'ARD',
  220: 'ZDF',
  298: 'RTL+',
  1899: 'HBO Max',
};

// Distinct provider IDs only — used for popular-per-provider fetching to avoid
// duplicate calls when two IDs map to the same display name.
const DISTINCT_PROVIDER_IDS = (() => {
  const seen = new Set();
  const out = [];
  for (const [pid, name] of Object.entries(PROVIDER_IDS)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(Number(pid));
  }
  return out;
})();

const PROVIDER_IDS_STR = Object.keys(PROVIDER_IDS)
  .map(Number)
  .sort((a, b) => a - b)
  .join('|');

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

const WATCHLIST_APP_URL = 'https://escholly-ship-it.github.io/watchlist/';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_WEB_BASE = 'https://www.themoviedb.org';

const MAX_PRIMARY = 8;       // "Heute streamen" — Top-N popular-per-provider
const MAX_SECONDARY = 5;     // "Neuerscheinungen" — Top-N new releases
const DEDUP_DAYS = 14;
const MIN_RATING = 5.5;
const MIN_VOTES = 20;
const LOOKBACK_DAYS = 28;
const LOOKAHEAD_DAYS = 90;
const MEDIUM_THRESHOLD = 0.35;  // User-Decision 2026-05-14
const TASTE_SAMPLE_SIZE = 15;   // Weekly cron only; daily cron reads KV cache.
const TELEGRAM_CHUNK_LIMIT = 4000;

// Subrequest budget on Workers Free is 50/invocation. Tight knobs below stay
// well under that for the daily run (taste profile is cached weekly).
const POPULAR_TOP_PROVIDERS = 5;   // Only top-5 providers for "Heute streamen"
const POPULAR_MEDIA_TYPES = ['movie']; // Skip TV in popular pass — covered by Secondary
const NEW_RELEASE_PAGES = 1;       // 1 page × 2 media types = 2 calls
const ENRICH_CHECK_FACTOR = 2;     // limit × N candidates to provider-check
const TASTE_CACHE_TTL_DAYS = 8;    // Refreshed weekly; soft refresh window 8d

// ─────────────────────────────────────────────────────────────────────────
// HTTP entrypoints
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/recommend' && request.method === 'POST') {
      return handleRecommendTrigger(request, env, ctx, url);
    }

    if (url.pathname === '/rebuild-taste' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      await rebuildTasteProfileCache(env);
      const cached = await env.WATCHLIST_KV.get(tasteCacheKey(env), 'json');
      return jsonResponse({
        ok: true,
        ts: cached && cached.ts,
        genres: cached && cached.profile && Object.keys(cached.profile.genres).length,
        decades: cached && cached.profile && Object.keys(cached.profile.decades).length,
        cast: cached && cached.profile && Object.keys(cached.profile.cast).length,
        avg_rating: cached && cached.profile && cached.profile.avg_rating,
      });
    }

    // /sync routes — owner-scoped via X-API-Key
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey.length < MIN_KEY_LENGTH) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const kvKey = `watchlist:${apiKey}`;

    if (url.pathname === '/sync' && request.method === 'GET') {
      let data = await env.WATCHLIST_KV.get(kvKey, 'json');
      // Legacy single-tenant migration (kept from previous worker version)
      if (!data) {
        const legacy = await env.WATCHLIST_KV.get('watchlist', 'json');
        if (legacy && apiKey === env.API_KEY) {
          await env.WATCHLIST_KV.put(kvKey, JSON.stringify(legacy));
          await env.WATCHLIST_KV.delete('watchlist');
          data = legacy;
        }
      }
      return jsonResponse({ items: data || [], timestamp: Date.now() });
    }

    if (url.pathname === '/sync' && request.method === 'PUT') {
      const body = await request.json();
      if (!Array.isArray(body.items)) {
        return jsonResponse({ error: 'items must be an array' }, 400);
      }
      await env.WATCHLIST_KV.put(kvKey, JSON.stringify(body.items));
      return jsonResponse({ ok: true, count: body.items.length, timestamp: Date.now() });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // Two cron schedules — see wrangler.toml [triggers].crons:
    //   "35 16 * * *"  → daily recommendation run
    //   "0 3 * * 0"    → weekly taste-profile rebuild (Sunday 03:00 UTC)
    if (event.cron === '0 3 * * SUN') {
      ctx.waitUntil(rebuildTasteProfileCache(env));
    } else {
      ctx.waitUntil(runRecommendationPipeline(env, { dryRun: false, source: 'cron' }));
    }
  },
};

async function handleRecommendTrigger(request, env, ctx, url) {
  const adminKey = request.headers.get('X-Admin-Key');
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const dryRun = url.searchParams.get('dryRun') === '1';
  const result = await runRecommendationPipeline(env, { dryRun, source: 'manual' });
  return jsonResponse(result);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline orchestrator
// ─────────────────────────────────────────────────────────────────────────

async function runRecommendationPipeline(env, { dryRun, source }) {
  const startedAt = Date.now();
  const log = [];
  const note = (msg) => { log.push(msg); console.log(msg); };

  try {
    requireSecret(env, 'OWNER_SYNC_KEY');
    requireSecret(env, 'TMDB_API_KEY');
    if (!dryRun) {
      requireSecret(env, 'TELEGRAM_BOT_TOKEN');
      requireSecret(env, 'TELEGRAM_CHAT_ID');
    }

    const watchlist = await loadOwnerWatchlist(env);
    note(`Watchlist: ${watchlist.length} items`);
    if (watchlist.length === 0) {
      const msg = 'Watchlist leer — nichts zu empfehlen.';
      if (!dryRun) await postTelegram(`🎬 ${msg}`, env);
      return { ok: true, source, message: msg, log };
    }

    const watchlistIds = new Set(
      watchlist
        .filter((it) => it.tmdbId)
        .map((it) => `${it.type || 'movie'}_${it.tmdbId}`)
    );

    const taste = await loadOrBuildTasteProfile(watchlist, env, note);
    const topGenres = Object.entries(taste.genres)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([gid, w]) => `${GENRE_MAP[gid] || gid} (${w.toFixed(2)})`);
    note(`Top genres: ${topGenres.join(', ')}`);

    const recommended = await loadDedupState(env);
    note(`Dedup state: ${Object.keys(recommended).length} entries (last ${DEDUP_DAYS}d)`);

    // ── Primary: "Heute streamen" — popular per provider ──
    const primaryRaw = await fetchPopularPerProvider(env);
    note(`Primary raw candidates: ${primaryRaw.length}`);
    const primaryScored = scoreAndFilter(primaryRaw, taste, watchlistIds, recommended);
    note(`Primary after MEDIUM filter (>= ${MEDIUM_THRESHOLD}): ${primaryScored.length}`);
    const primaryFinal = await enrichWithProviders(primaryScored, env, MAX_PRIMARY);
    note(`Primary final: ${primaryFinal.length}`);

    // ── Secondary: "Neuerscheinungen" — discover by release_date ──
    const secondaryRaw = await fetchNewReleases(env);
    note(`Secondary raw candidates: ${secondaryRaw.length}`);
    const primaryKeys = new Set(primaryFinal.map((r) => r.key));
    const secondaryScored = scoreAndFilter(
      secondaryRaw.filter((r) => !primaryKeys.has(itemKey(r))),
      taste,
      watchlistIds,
      recommended,
    );
    note(`Secondary after MEDIUM filter: ${secondaryScored.length}`);
    const secondaryFinal = await enrichWithProviders(secondaryScored, env, MAX_SECONDARY);
    note(`Secondary final: ${secondaryFinal.length}`);

    // ── Format + post ──
    const message = formatTelegramMessage(primaryFinal, secondaryFinal, env.OWNER_SYNC_KEY);
    note(`Message length: ${message.length} chars`);

    if (dryRun) {
      return {
        ok: true,
        source,
        dryRun: true,
        primary: primaryFinal,
        secondary: secondaryFinal,
        message,
        log,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (primaryFinal.length === 0 && secondaryFinal.length === 0) {
      const emptyMsg = '🎬 <b>Streaming-Empfehlungen</b>\nHeute keine neuen Empfehlungen — alle Kandidaten waren bereits bekannt oder unter MEDIUM-Schwelle.';
      await postTelegram(emptyMsg, env);
    } else {
      await postTelegram(message, env);
    }

    // Update dedup state
    const now = Math.floor(Date.now() / 1000);
    const today = new Date().toISOString().slice(0, 10);
    for (const rec of [...primaryFinal, ...secondaryFinal]) {
      recommended[rec.key] = { title: rec.title, ts: now, date: today };
    }
    await saveDedupState(env, recommended);
    note(`Dedup updated: ${Object.keys(recommended).length} entries`);

    return {
      ok: true,
      source,
      primaryCount: primaryFinal.length,
      secondaryCount: secondaryFinal.length,
      log,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    console.error('Pipeline error:', err);
    if (!dryRun) {
      try {
        await postTelegram(`⚠️ Watchlist-Empfehlungen Fehler: ${err.message || err}`, env);
      } catch (postErr) {
        console.error('Failed to post error to Telegram:', postErr);
      }
    }
    return { ok: false, source, error: String(err), log, elapsedMs: Date.now() - startedAt };
  }
}

function requireSecret(env, name) {
  if (!env[name]) throw new Error(`Missing secret: ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────
// KV: owner watchlist + dedup state
// ─────────────────────────────────────────────────────────────────────────

async function loadOwnerWatchlist(env) {
  const data = await env.WATCHLIST_KV.get(`watchlist:${env.OWNER_SYNC_KEY}`, 'json');
  return Array.isArray(data) ? data : [];
}

async function loadDedupState(env) {
  const key = `recommended:${env.OWNER_SYNC_KEY}`;
  const raw = await env.WATCHLIST_KV.get(key, 'json');
  if (!raw || typeof raw !== 'object') return {};
  const cutoff = Math.floor(Date.now() / 1000) - DEDUP_DAYS * 86400;
  const fresh = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v.ts === 'number' && v.ts > cutoff) fresh[k] = v;
  }
  return fresh;
}

async function saveDedupState(env, state) {
  const key = `recommended:${env.OWNER_SYNC_KEY}`;
  await env.WATCHLIST_KV.put(key, JSON.stringify(state));
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
  // Cache TTL deliberately short: TMDB results we care about (discover, providers)
  // change over the day, and a cached empty response would poison the pipeline.
  // 60 s is enough to coalesce duplicate calls within a single scheduled invocation.
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
// Taste profile (Sprint 262 multi-factor: genres + decades + cast + avg_rating)
// ─────────────────────────────────────────────────────────────────────────

function tasteCacheKey(env) {
  return `taste:${env.OWNER_SYNC_KEY}`;
}

async function loadOrBuildTasteProfile(watchlist, env, note) {
  const cached = await env.WATCHLIST_KV.get(tasteCacheKey(env), 'json');
  if (cached && cached.ts && cached.profile) {
    const ageDays = (Date.now() / 1000 - cached.ts) / 86400;
    if (ageDays < TASTE_CACHE_TTL_DAYS) {
      note(`Taste profile: KV cache hit (${ageDays.toFixed(1)}d old)`);
      return cached.profile;
    }
    note(`Taste profile: KV cache stale (${ageDays.toFixed(1)}d old) — rebuilding inline`);
  } else {
    note('Taste profile: no KV cache — building inline');
  }
  // Inline build (only on cold start / cache-stale day; weekly cron normally
  // keeps cache fresh and we never hit this branch from the daily run).
  const profile = await buildTasteProfile(watchlist, env);
  await env.WATCHLIST_KV.put(
    tasteCacheKey(env),
    JSON.stringify({ profile, ts: Math.floor(Date.now() / 1000) }),
  );
  return profile;
}

async function rebuildTasteProfileCache(env) {
  console.log('Weekly taste-profile rebuild starting');
  requireSecret(env, 'OWNER_SYNC_KEY');
  requireSecret(env, 'TMDB_API_KEY');
  const watchlist = await loadOwnerWatchlist(env);
  if (watchlist.length === 0) {
    console.log('Watchlist empty — skipping taste-profile rebuild');
    return;
  }
  const profile = await buildTasteProfile(watchlist, env);
  await env.WATCHLIST_KV.put(
    tasteCacheKey(env),
    JSON.stringify({ profile, ts: Math.floor(Date.now() / 1000) }),
  );
  console.log(`Taste profile rebuilt and cached: genres=${Object.keys(profile.genres).length} decades=${Object.keys(profile.decades).length} cast=${Object.keys(profile.cast).length}`);
}

async function buildTasteProfile(watchlist, env) {
  const sample = sampleRandom(
    watchlist.filter((it) => it.tmdbId),
    TASTE_SAMPLE_SIZE,
  );

  // Parallel fetch with append_to_response=credits to halve API calls
  const details = await Promise.all(
    sample.map((item) =>
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
  const ratings = [];

  for (const { item, data } of details) {
    if (!data) continue;
    for (const g of data.genres || []) {
      if (g.id) genreCounts.set(g.id, (genreCounts.get(g.id) || 0) + 1);
    }
    const dateField = (item.type === 'tv') ? 'first_air_date' : 'release_date';
    const dateStr = data[dateField] || '';
    if (dateStr.length >= 4) {
      const year = parseInt(dateStr.slice(0, 4), 10);
      if (!Number.isNaN(year)) {
        const decade = Math.floor(year / 10) * 10;
        decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + 1);
      }
    }
    if (typeof data.vote_average === 'number' && data.vote_average > 0) {
      ratings.push(data.vote_average);
    }
    const cast = (data.credits && data.credits.cast) || [];
    for (const member of cast.slice(0, 5)) {
      if (member.id) castCounts.set(member.id, (castCounts.get(member.id) || 0) + 1);
    }
  }

  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 6.5;

  return {
    genres: normalizeMap(genreCounts),
    decades: normalizeMap(decadeCounts),
    cast: normalizeMap(castCounts),
    avg_rating: avgRating,
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
// Scoring (Sprint 262 score_with_taste, range 0..1)
// ─────────────────────────────────────────────────────────────────────────

function scoreWithTaste(item, taste) {
  const gIds = item.genre_ids || [];
  const gScore = gIds.length > 0
    ? gIds.reduce((sum, gid) => sum + (taste.genres[gid] || 0), 0) / gIds.length
    : 0;

  const releaseYear = item.release_year || parseReleaseYear(item) || 2020;
  const decade = Math.floor(releaseYear / 10) * 10;
  const dScore = taste.decades[decade] !== undefined ? taste.decades[decade] : 0.5;

  const cIds = item.cast_ids || [];
  const cScore = cIds.length > 0
    ? Math.max(0, ...cIds.map((cid) => taste.cast[cid] || 0))
    : 0;

  const rating = typeof item.vote_average === 'number' ? item.vote_average : 6.5;
  const rScore = Math.max(0, 1 - Math.abs(rating - taste.avg_rating) / 5);

  return Math.round((0.4 * gScore + 0.2 * dScore + 0.2 * cScore + 0.2 * rScore) * 1000) / 1000;
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

// ─────────────────────────────────────────────────────────────────────────
// Discovery — Primary "Heute streamen" + Secondary "Neuerscheinungen"
// ─────────────────────────────────────────────────────────────────────────

async function fetchPopularPerProvider(env) {
  // Subrequest-budget cap: only top N providers × restricted media types.
  const providers = DISTINCT_PROVIDER_IDS.slice(0, POPULAR_TOP_PROVIDERS);
  const tasks = [];
  for (const pid of providers) {
    for (const mediaType of POPULAR_MEDIA_TYPES) {
      tasks.push(fetchPopularForProvider(pid, mediaType, env));
    }
  }
  const results = await Promise.all(tasks);
  const seen = new Map();
  for (const list of results) {
    for (const it of list) {
      const k = itemKey(it);
      if (!seen.has(k)) seen.set(k, it);
    }
  }
  return Array.from(seen.values());
}

async function fetchPopularForProvider(providerId, mediaType, env) {
  const data = await tmdbGet(`discover/${mediaType}`, {
    watch_region: 'DE',
    with_watch_providers: providerId,
    with_watch_monetization_types: 'flatrate|free|ads',
    sort_by: 'popularity.desc',
    'vote_count.gte': 50,
    page: 1,
  }, env);
  if (!data || !Array.isArray(data.results)) return [];
  return data.results.map((r) => normalizeDiscoverItem(r, mediaType));
}

async function fetchNewReleases(env) {
  const today = new Date();
  const dateFrom = isoDate(addDays(today, -LOOKBACK_DAYS));
  const dateTo = isoDate(addDays(today, LOOKAHEAD_DAYS));

  const tasks = [];
  for (const mediaType of ['movie', 'tv']) {
    for (let page = 1; page <= NEW_RELEASE_PAGES; page++) {
      tasks.push(fetchNewReleasesPage(mediaType, dateFrom, dateTo, page, env));
    }
  }
  const pages = await Promise.all(tasks);
  const seen = new Map();
  for (const list of pages) {
    for (const it of list) {
      const k = itemKey(it);
      if (!seen.has(k)) seen.set(k, it);
    }
  }
  return Array.from(seen.values());
}

async function fetchNewReleasesPage(mediaType, dateFrom, dateTo, page, env) {
  const dateGteKey = mediaType === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte';
  const dateLteKey = mediaType === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte';
  const data = await tmdbGet(`discover/${mediaType}`, {
    watch_region: 'DE',
    with_watch_providers: PROVIDER_IDS_STR,
    with_watch_monetization_types: 'flatrate|free|ads',
    [dateGteKey]: dateFrom,
    [dateLteKey]: dateTo,
    sort_by: 'popularity.desc',
    'vote_count.gte': 5,
    page,
  }, env);
  if (!data || !Array.isArray(data.results)) return [];
  return data.results.map((r) => normalizeDiscoverItem(r, mediaType));
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
    cast_ids: [], // populated lazily — discover endpoint has no cast
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring pipeline: score → MEDIUM filter → exclude watchlist+dedup → sort
// ─────────────────────────────────────────────────────────────────────────

function scoreAndFilter(items, taste, watchlistIds, recommended) {
  const today = new Date();
  const todayStr = isoDate(today);
  const scored = [];

  for (const it of items) {
    const key = itemKey(it);
    if (watchlistIds.has(key)) continue;
    if (recommended[key]) continue;

    if (it.vote_count < 5) continue;
    if (it.vote_average < MIN_RATING && it.vote_count >= MIN_VOTES) continue;

    const taste_score = scoreWithTaste(it, taste);
    if (taste_score < MEDIUM_THRESHOLD) continue;

    // Composite ranking score (mirrors recommend.py gather_candidates)
    const popularity = it.popularity || 0;
    let recencyBoost = 1.0;
    if (it.release_date) {
      const releaseTs = new Date(it.release_date).getTime();
      if (!Number.isNaN(releaseTs)) {
        const daysFrom = Math.abs((releaseTs - today.getTime()) / 86400000);
        recencyBoost = 1.0 + 0.5 * Math.max(0, 1 - daysFrom / 90);
      }
    }
    const isUpcoming = it.release_date && it.release_date > todayStr;
    const rankScore = (Math.log10(Math.max(popularity, 1)) * 2 + it.vote_average + taste_score * 5) * recencyBoost;

    scored.push({
      ...it,
      key,
      taste_score,
      rank_score: rankScore,
      is_upcoming: isUpcoming,
    });
  }

  scored.sort((a, b) => b.rank_score - a.rank_score);
  return scored;
}

async function enrichWithProviders(scored, env, limit) {
  const checkLimit = Math.min(scored.length, limit * ENRICH_CHECK_FACTOR);
  const out = [];
  let probedNoProviders = 0;
  for (let i = 0; i < checkLimit && out.length < limit; i++) {
    const c = scored[i];
    const providers = await getStreamingProviders(c.type, c.tmdb_id, env);
    if (providers.length === 0) {
      probedNoProviders++;
      if (probedNoProviders <= 3) {
        console.log(`enrich: no providers for ${c.type}/${c.tmdb_id} (${c.title})`);
      }
      continue;
    }
    const year = c.release_date ? c.release_date.slice(0, 4) : '';
    const genres = c.genre_ids.slice(0, 3).map((g) => GENRE_MAP[g]).filter(Boolean).join(', ');
    out.push({
      key: c.key,
      tmdb_id: c.tmdb_id,
      type: c.type,
      title: c.title,
      year,
      release_date: c.release_date,
      rating: Math.round(c.vote_average * 10) / 10,
      vote_count: c.vote_count,
      genres,
      providers,
      overview: c.overview,
      is_upcoming: !!c.is_upcoming,
      taste_score: c.taste_score,
    });
  }
  return out;
}

async function getStreamingProviders(mediaType, tmdbId, env) {
  const data = await tmdbGet(`${mediaType}/${tmdbId}/watch/providers`, null, env);
  if (!data || !data.results || !data.results.DE) return [];
  const de = data.results.DE;
  const providers = new Set();
  for (const cat of ['flatrate', 'free', 'ads']) {
    for (const p of de[cat] || []) {
      if (PROVIDER_IDS[p.provider_id]) providers.add(PROVIDER_IDS[p.provider_id]);
    }
  }
  return Array.from(providers).sort();
}

// ─────────────────────────────────────────────────────────────────────────
// Telegram formatting
// ─────────────────────────────────────────────────────────────────────────

function formatTelegramMessage(primary, secondary, ownerKey) {
  const today = new Date();
  const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  const header = `🎬 <b>Heute streamen — ${weekdays[today.getDay()]}, ${dd}.${mm}.${yyyy}</b>`;
  const total = primary.length + secondary.length;
  const lines = [header, `${total} Empfehlungen auf deinen Streaming-Diensten`, ''];

  if (primary.length > 0) {
    lines.push('🆕 <b>GERADE AUF DEINEN DIENSTEN</b>');
    for (const rec of primary) lines.push(...formatItemLines(rec, false, ownerKey));
  }
  if (secondary.length > 0) {
    lines.push('📅 <b>NEU IN DEN NÄCHSTEN WOCHEN</b>');
    for (const rec of secondary) lines.push(...formatItemLines(rec, true, ownerKey));
  }
  return lines.join('\n');
}

function formatItemLines(rec, showReleaseInTitle, ownerKey) {
  const icon = rec.type === 'tv' ? '📺' : '🎬';
  const providers = rec.providers.join(', ');
  const ratingStr = rec.vote_count >= MIN_VOTES ? ` · ⭐ ${rec.rating}` : '';
  const dateInfo = formatReleaseDate(rec.release_date, rec.is_upcoming);
  const titleBlock = showReleaseInTitle && dateInfo
    ? `${icon} <b>${escapeHtml(rec.title)}</b> (${dateInfo})${ratingStr} · ${providers}`
    : `${icon} <b>${escapeHtml(rec.title)}</b> (${rec.year})${ratingStr} · ${providers}`;
  const lines = [titleBlock];
  if (!showReleaseInTitle && dateInfo) {
    lines.push(`<i>${escapeHtml(rec.genres)}</i> · ${dateInfo}`);
  } else if (rec.genres) {
    lines.push(`<i>${escapeHtml(rec.genres)}</i>`);
  }
  if (rec.overview) {
    const ov = rec.overview.length > 140 ? rec.overview.slice(0, 140) + '…' : rec.overview;
    lines.push(`→ ${escapeHtml(ov)}`);
  }
  lines.push(itemLinks(rec, ownerKey));
  lines.push('');
  return lines;
}

function itemLinks(rec, ownerKey) {
  const detailsUrl = `${TMDB_WEB_BASE}/${rec.type}/${rec.tmdb_id}`;
  const addUrl = `${WATCHLIST_APP_URL}?key=${encodeURIComponent(ownerKey)}&add=${rec.tmdb_id}&type=${rec.type}`;
  return `<a href="${escapeHtml(detailsUrl)}">Details</a>  ·  <a href="${escapeHtml(addUrl)}">+ Watchlist</a>`;
}

function formatReleaseDate(releaseDate, isUpcoming) {
  if (!releaseDate) return '';
  const d = new Date(releaseDate);
  if (Number.isNaN(d.getTime())) return '';
  const ddmm = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (isUpcoming) {
    return `ab ${ddmm}.${d.getFullYear()}`;
  }
  const daysAgo = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (daysAgo <= 7) return 'diese Woche';
  if (daysAgo <= 14) return 'letzte Woche';
  return `seit ${ddmm}.`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ─────────────────────────────────────────────────────────────────────────
// Telegram sender — HTML mode, chunked at paragraph boundaries
// ─────────────────────────────────────────────────────────────────────────

async function postTelegram(text, env) {
  const chunks = splitTelegramMessage(text, TELEGRAM_CHUNK_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const resp = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: chunks[i],
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Telegram ${resp.status}: ${body.slice(0, 200)}`);
    }
    if (chunks.length > 1 && i < chunks.length - 1) {
      await sleep(500);
    }
  }
}

function splitTelegramMessage(message, maxLen) {
  if (message.length <= maxLen) return [message];
  const chunks = [];
  const blocks = message.split('\n\n');
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

