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

const PROVIDER_IDS_STR = Object.keys(PROVIDER_IDS)
  .map(Number)
  .sort((a, b) => a - b)
  .join('|');

// TMDB provider ID → App-Service-ID (mirror of app.js SERVICES.tmdbIds).
// providers_app feeds the in-app 1-tap-add (serviceId without client roundtrip).
const APP_SERVICE_MAP = {
  8: 'netflix',
  9: 'prime', 119: 'prime',
  337: 'disney',
  350: 'apple',
  30: 'sky', 1773: 'sky', 29: 'sky',
  384: 'hbo', 1899: 'hbo',
  531: 'paramount',
  178: 'magenta',
  304: 'joyn', 421: 'joyn',
  219: 'ard',
  537: 'zdf', 536: 'zdf',
  298: 'rtl', 1771: 'rtl',
};

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

const MIN_RATING = 5.5;
const MIN_VOTES = 20;
const MEDIUM_THRESHOLD = 0.35;  // User-Decision 2026-05-14
const TASTE_SAMPLE_SIZE = 15;
const TASTE_CACHE_TTL_DAYS = 8;
const TELEGRAM_CHUNK_LIMIT = 4000;

// Original-language preference (Scholly watches OV only).
const PREFERRED_LANGUAGES = new Set(['en', 'de', 'sv']);
const NON_PREFERRED_LANG_FACTOR = 0.5;

// ── Magazine knobs (WL-5) ────────────────────────────────────────────────
// Subrequest budget on Workers Free is 50/invocation (fetch + KV combined).
// Worst case: 4-6 discover + ≤16 details + 1 Telegram + ~8 KV ≈ 31 — the
// TMDB_CALL_CEILING is a runtime guard well below the wall.
const MAGAZINE_NEW_COUNT = 8;        // Rubrik "Neu fuer dich"
const MAGAZINE_UPCOMING_COUNT = 4;   // Rubrik "Demnaechst"
const MAGAZINE_ENRICH_CAP = 16;      // hard cap on per-title detail calls
const MAGAZINE_LOOKBACK_DAYS = 30;   // "neu" window: released within last 30d
const MAGAZINE_LOOKAHEAD_DAYS = 14;  // "demnaechst" window: next 14d
const MAGAZINE_SEEN_DAYS = 35;       // dedup window vs previous issues
const MAGAZINE_MIN_NEW_CANDIDATES = 5; // below this → fetch discover page 2
const TMDB_CALL_CEILING = 40;        // runtime guard on TMDB calls per invocation

// WL-11: roster of sync-keys that each get a personal weekly magazine. Lives in
// KV as a JSON array; the owner is always included unconditionally (see
// loadMagazineRoster). The 40-char all-'a' dev/test key is hard-excluded.
const MAGAZINE_ROSTER_KEY = 'config:magazine_members';
const TEST_SYNC_KEY = 'a'.repeat(40);

// Per-invocation subrequest counters, reset at the start of each pipeline /
// taste-rebuild run. tmdbCalls gates enrichment (TMDB_CALL_CEILING); kvCalls
// makes the dryRun subrequest report honest — KV ops count toward the Free-tier
// 50/invocation wall just like fetches. WL-11 fires ONE member per cron run
// (stateless round-robin on event.scheduledTime), so there is no cross-member
// counter leak: each invocation is a fresh isolate.
let tmdbCalls = 0;
let kvCalls = 0;

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
    if (!apiKey || apiKey.length < MIN_KEY_LENGTH) {
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
      return jsonResponse({ items: data || [], timestamp: Date.now() });
    }

    if (url.pathname === '/sync' && request.method === 'PUT') {
      const body = await request.json();
      if (!Array.isArray(body.items)) {
        return jsonResponse({ error: 'items must be an array' }, 400);
      }
      await kvPut(env, kvKey, JSON.stringify(body.items));
      return jsonResponse({ ok: true, count: body.items.length, timestamp: Date.now() });
    }

    if (url.pathname === '/magazine' && request.method === 'GET') {
      const magazine = await kvGet(env, `magazine:${apiKey}`, 'json');
      return jsonResponse({ magazine: magazine || null, timestamp: Date.now() });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // WL-11: stateless round-robin over the magazine roster. Both crons derive
    // the SAME member index from event.scheduledTime (UTC ms) on a given day —
    // 03:00 and 16:00 fall in the same UTC day, so floor(t/86400000) is equal —
    // hence the taste pre-warm and the magazine build always target the same
    // member. No stored cursor, no decoupled sequences.
    //   "0 3 * * *"  → daily taste pre-warm for that day's member (if stale)
    //   "0 16 * * *" → daily magazine build for that day's member
    const roster = await loadMagazineRoster(env);
    const idx = Math.floor(event.scheduledTime / 86400000) % roster.length;
    const member = roster[idx];
    if (event.cron === '0 3 * * *') {
      ctx.waitUntil(prewarmTasteIfStale(env, member));
    } else if (event.cron === '0 16 * * *') {
      ctx.waitUntil(runMagazinePipeline(env, { dryRun: false, source: 'cron', syncKey: member }));
    } else {
      console.warn('Unknown cron trigger:', event.cron);
    }
  },
};

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

// Best-effort taste pre-warm: rebuild the member's taste profile only if it is
// missing or past its TTL. Runs at 03:00 for the same member the 16:00 magazine
// build will target, so the build normally finds a warm cache. If this fails or
// the cache expires between 03:00 and 16:00, the magazine build is still
// self-sufficient (loadOrBuildTasteProfile rebuilds inline) — so a member never
// loses their issue on their day.
async function prewarmTasteIfStale(env, syncKey) {
  try {
    const cached = await kvGet(env, tasteCacheKey(syncKey), 'json');
    if (cached && cached.ts && cached.profile) {
      const ageDays = (Date.now() / 1000 - cached.ts) / 86400;
      if (ageDays < TASTE_CACHE_TTL_DAYS) {
        console.log(`Taste pre-warm: fresh for ${String(syncKey).slice(0, 8)} (${ageDays.toFixed(1)}d) — skip`);
        return;
      }
    }
    await rebuildTasteProfileCache(env, syncKey);
  } catch (err) {
    console.error('Taste pre-warm failed (best-effort):', err && err.message ? err.message : String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Magazine pipeline (WL-5)
// ─────────────────────────────────────────────────────────────────────────

async function runMagazinePipeline(env, { dryRun, source, syncKey }) {
  const startedAt = Date.now();
  tmdbCalls = 0;
  kvCalls = 0;
  const log = [];
  const note = (msg) => { log.push(msg); console.log(msg); };

  try {
    requireSecret(env, 'OWNER_SYNC_KEY');
    requireSecret(env, 'TMDB_API_KEY');

    // WL-11: build for the given member (defaults to owner — backward-safe for
    // the manual /magazine-build path). All KV sub-keys are scoped to `owner`.
    const owner = syncKey || env.OWNER_SYNC_KEY;
    note(`Building magazine for ${String(owner).slice(0, 8)} (source=${source})`);

    const watchlist = await loadWatchlist(env, owner);
    note(`Watchlist: ${watchlist.length} items`);

    const watchlistIds = new Set(
      watchlist
        .filter((it) => it.tmdbId)
        .map((it) => `${it.type || 'movie'}_${it.tmdbId}`)
    );

    const { profile: taste, sample: tasteSample } =
      await loadOrBuildTasteProfile(watchlist, env, owner, note);
    const seen = await loadMagazineSeen(env, owner);
    note(`Magazine seen state: ${Object.keys(seen).length} entries (last ${MAGAZINE_SEEN_DAYS}d)`);

    const today = new Date();
    const todayStr = isoDate(today);

    // ── Rubrik "Neu fuer dich": released within last MAGAZINE_LOOKBACK_DAYS ──
    let newRaw = await fetchMagazineWindow(
      isoDate(addDays(today, -MAGAZINE_LOOKBACK_DAYS)), todayStr, 1, 5, env,
    );
    note(`Neu raw candidates: ${newRaw.length} (tmdbCalls=${tmdbCalls})`);
    let newScored = scoreAndFilter(newRaw, taste, watchlistIds, seen);

    // Fallback: thin yield → widen with discover page 2 (P2-NEU-1 fix)
    if (newScored.length < MAGAZINE_MIN_NEW_CANDIDATES) {
      note(`Neu below threshold (${newScored.length} < ${MAGAZINE_MIN_NEW_CANDIDATES}) — fetching page 2`);
      const page2 = await fetchMagazineWindow(
        isoDate(addDays(today, -MAGAZINE_LOOKBACK_DAYS)), todayStr, 2, 5, env,
      );
      const known = new Set(newRaw.map((r) => itemKey(r)));
      newRaw = newRaw.concat(page2.filter((r) => !known.has(itemKey(r))));
      newScored = scoreAndFilter(newRaw, taste, watchlistIds, seen);
      note(`Neu after fallback: ${newScored.length}`);
    }

    // ── Rubrik "Demnaechst": next MAGAZINE_LOOKAHEAD_DAYS ──
    const upRaw = await fetchMagazineWindow(
      isoDate(addDays(today, 1)), isoDate(addDays(today, MAGAZINE_LOOKAHEAD_DAYS)), 1, 0, env,
    );
    note(`Demnaechst raw candidates: ${upRaw.length} (tmdbCalls=${tmdbCalls})`);
    const newKeys = new Set(newScored.map((r) => r.key));
    const upScored = scoreAndFilter(
      upRaw.filter((r) => !newKeys.has(itemKey(r))),
      taste, watchlistIds, seen, { relaxVotes: true },
    );
    note(`Neu scored: ${newScored.length} · Demnaechst scored: ${upScored.length}`);

    // ── Enrichment: ONE combined details call per candidate ──
    const neuItems = await enrichMagazineItems(
      newScored, MAGAZINE_NEW_COUNT, { requireProviders: true }, taste, tasteSample, env, note,
    );
    const upItems = await enrichMagazineItems(
      upScored, MAGAZINE_UPCOMING_COUNT, { requireProviders: false }, taste, tasteSample, env, note,
    );
    upItems.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
    note(`Enriched: neu=${neuItems.length} demnaechst=${upItems.length} (tmdbCalls=${tmdbCalls})`);

    // Honest subrequest accounting (WL-11): tmdb + kv are both measured, no
    // estimate. The two KV writes further down (magazine + seen) are added
    // explicitly to the dryRun report so it matches a real build's cost; the
    // live return re-reads the counters after those writes. The cron path adds
    // one more KV read (the roster) outside this function.
    if (neuItems.length === 0 && upItems.length === 0) {
      const msg = 'Magazin diese Woche uebersprungen — keine passenden Neuerscheinungen gefunden.';
      note(msg);
      if (!dryRun) await postTelegram(`⚠️ ${msg}`, env);
      return {
        ok: false, source, skipped: true, message: msg,
        subrequests: { tmdb: tmdbCalls, kv: kvCalls, total: tmdbCalls + kvCalls },
        log, elapsedMs: Date.now() - startedAt,
      };
    }

    const issueWeek = isoWeek(today);
    const magazine = {
      version: 1,
      issue: {
        week: issueWeek,
        year: today.getFullYear(),
        date: todayStr,
        ts: Math.floor(Date.now() / 1000),
      },
      counts: { neu: neuItems.length, demnaechst: upItems.length },
      sections: [
        { id: 'neu', title: 'Neu fuer dich', items: neuItems },
        { id: 'demnaechst', title: 'Demnaechst', items: upItems },
      ],
    };

    if (dryRun) {
      // +2 for the magazine + seen writes a real build would perform.
      const kvLive = kvCalls + 2;
      return {
        ok: true, source, dryRun: true, magazine,
        subrequests: { tmdb: tmdbCalls, kv: kvLive, total: tmdbCalls + kvLive },
        log, elapsedMs: Date.now() - startedAt,
      };
    }

    await kvPut(env, `magazine:${owner}`, JSON.stringify(magazine));

    // Update seen state so next issue does not repeat titles
    const now = Math.floor(Date.now() / 1000);
    for (const it of [...neuItems, ...upItems]) {
      seen[it.key] = { title: it.title, ts: now, date: todayStr };
    }
    await saveMagazineSeen(env, owner, seen);

    // Customer-Entscheid 2026-06-11: kein Erfolgs-Ping — die App selbst zeigt
    // die neue Ausgabe beim Oeffnen (Teaser-Karte). Telegram nur im Fehlerfall
    // (silent-stale-Schutz). Web-Push in der App: Backlog WL-10.

    return {
      ok: true,
      source,
      issue: magazine.issue,
      counts: magazine.counts,
      subrequests: { tmdb: tmdbCalls, kv: kvCalls, total: tmdbCalls + kvCalls },
      log,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    console.error('Magazine pipeline error:', err);
    if (!dryRun) {
      try {
        await postTelegram(`⚠️ Wochen-Magazin Fehler: ${err.message || err}`, env);
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
// KV: owner watchlist + magazine seen state
// ─────────────────────────────────────────────────────────────────────────

async function loadWatchlist(env, syncKey) {
  const data = await kvGet(env, `watchlist:${syncKey}`, 'json');
  return Array.isArray(data) ? data : [];
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

async function saveMagazineSeen(env, syncKey, state) {
  await kvPut(env, `magazine_seen:${syncKey}`, JSON.stringify(state));
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
  // Cache TTL deliberately short — 60 s coalesces duplicate calls within one
  // invocation without letting a cached empty response poison the pipeline.
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
// Taste profile (multi-factor: genres + decades + cast + avg_rating)
// ─────────────────────────────────────────────────────────────────────────

function tasteCacheKey(syncKey) {
  return `taste:${syncKey}`;
}

async function loadOrBuildTasteProfile(watchlist, env, syncKey, note) {
  const cached = await kvGet(env, tasteCacheKey(syncKey), 'json');
  if (cached && cached.ts && cached.profile) {
    const ageDays = (Date.now() / 1000 - cached.ts) / 86400;
    if (ageDays < TASTE_CACHE_TTL_DAYS) {
      note(`Taste profile: KV cache hit (${ageDays.toFixed(1)}d old)`);
      return { profile: cached.profile, sample: cached.sample || [] };
    }
    note(`Taste profile: KV cache stale (${ageDays.toFixed(1)}d old) — rebuilding inline`);
  } else {
    note('Taste profile: no KV cache — building inline');
  }
  const { profile, sample } = await buildTasteProfile(watchlist, env);
  await kvPut(
    env,
    tasteCacheKey(syncKey),
    JSON.stringify({ profile, sample, ts: Math.floor(Date.now() / 1000) }),
  );
  return { profile, sample };
}

async function rebuildTasteProfileCache(env, syncKey) {
  console.log(`Taste-profile rebuild starting for ${String(syncKey).slice(0, 8)}`);
  tmdbCalls = 0;
  kvCalls = 0;
  requireSecret(env, 'OWNER_SYNC_KEY');
  requireSecret(env, 'TMDB_API_KEY');
  const watchlist = await loadWatchlist(env, syncKey);
  if (watchlist.length === 0) {
    console.log('Watchlist empty — skipping taste-profile rebuild');
    return;
  }
  const { profile, sample } = await buildTasteProfile(watchlist, env);
  await kvPut(
    env,
    tasteCacheKey(syncKey),
    JSON.stringify({ profile, sample, ts: Math.floor(Date.now() / 1000) }),
  );
  console.log(`Taste profile rebuilt and cached: genres=${Object.keys(profile.genres).length} decades=${Object.keys(profile.decades).length} cast=${Object.keys(profile.cast).length} sample=${sample.length}`);
}

async function buildTasteProfile(watchlist, env) {
  const samplePick = sampleRandom(
    watchlist.filter((it) => it.tmdbId),
    TASTE_SAMPLE_SIZE,
  );

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
  const ratings = [];
  // Per-title sample meta — powers the magazine "Fuer Fans von" line without
  // extra subrequests (data is already on hand during rebuild).
  const sample = [];

  for (const { item, data } of details) {
    if (!data) continue;
    const genreIds = (data.genres || []).map((g) => g.id).filter(Boolean);
    for (const gid of genreIds) {
      genreCounts.set(gid, (genreCounts.get(gid) || 0) + 1);
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
    sample.push({
      title: data.title || data.name || item.title || 'Unknown',
      type: item.type || 'movie',
      genre_ids: genreIds,
    });
  }

  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 6.5;

  return {
    profile: {
      genres: normalizeMap(genreCounts),
      decades: normalizeMap(decadeCounts),
      cast: normalizeMap(castCounts),
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
// Scoring (score_with_taste, range 0..1)
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

  const base = 0.4 * gScore + 0.2 * dScore + 0.2 * cScore + 0.2 * rScore;
  const lang = (item.original_language || '').toLowerCase();
  const langFactor = PREFERRED_LANGUAGES.has(lang) ? 1.0 : NON_PREFERRED_LANG_FACTOR;
  return Math.round(base * langFactor * 1000) / 1000;
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
// Discovery — release windows on Scholly's providers (DE)
// ─────────────────────────────────────────────────────────────────────────

async function fetchMagazineWindow(dateFrom, dateTo, page, voteCountGte, env) {
  const tasks = [];
  for (const mediaType of ['movie', 'tv']) {
    tasks.push(fetchWindowPage(mediaType, dateFrom, dateTo, page, voteCountGte, env));
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

async function fetchWindowPage(mediaType, dateFrom, dateTo, page, voteCountGte, env) {
  const dateGteKey = mediaType === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte';
  const dateLteKey = mediaType === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte';
  const data = await tmdbGet(`discover/${mediaType}`, {
    watch_region: 'DE',
    with_watch_providers: PROVIDER_IDS_STR,
    with_watch_monetization_types: 'flatrate|free|ads',
    [dateGteKey]: dateFrom,
    [dateLteKey]: dateTo,
    sort_by: 'popularity.desc',
    'vote_count.gte': voteCountGte,
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
    original_language: r.original_language || '',
    poster_path: r.poster_path || null,
    backdrop_path: r.backdrop_path || null,
    cast_ids: [], // discover endpoint has no cast
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring pipeline: score → MEDIUM filter → exclude watchlist+seen → sort
// ─────────────────────────────────────────────────────────────────────────

function scoreAndFilter(items, taste, watchlistIds, seenState, opts = {}) {
  const relaxVotes = !!opts.relaxVotes;
  const today = new Date();
  const todayStr = isoDate(today);
  const scored = [];

  for (const it of items) {
    const key = itemKey(it);
    if (watchlistIds.has(key)) continue;
    if (seenState[key]) continue;

    // Upcoming titles legitimately have few votes — relax for "Demnaechst",
    // but require a minimum popularity so true long-tail noise stays out.
    if (!relaxVotes && it.vote_count < 5) continue;
    if (relaxVotes && it.vote_count < 5 && (it.popularity || 0) < 15) continue;
    if (it.vote_average < MIN_RATING && it.vote_count >= MIN_VOTES) continue;

    const taste_score = scoreWithTaste(it, taste);
    if (taste_score < MEDIUM_THRESHOLD) continue;

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

// ─────────────────────────────────────────────────────────────────────────
// Magazine enrichment — ONE combined TMDB call per candidate
// (append_to_response=credits,watch/providers), hard-capped.
// ─────────────────────────────────────────────────────────────────────────

async function enrichMagazineItems(scored, limit, { requireProviders }, taste, tasteSample, env, note) {
  const out = [];
  let detailCalls = 0;
  for (const c of scored) {
    if (out.length >= limit) break;
    if (detailCalls >= MAGAZINE_ENRICH_CAP) {
      note(`Enrich cap reached (${MAGAZINE_ENRICH_CAP}) — stopping`);
      break;
    }
    if (tmdbCalls >= TMDB_CALL_CEILING) {
      note(`TMDB call ceiling reached (${TMDB_CALL_CEILING}) — stopping enrichment`);
      break;
    }

    detailCalls++;
    const data = await tmdbGet(
      `${c.type}/${c.tmdb_id}`,
      { append_to_response: 'credits,watch/providers' },
      env,
    );
    if (!data) continue;

    const de = data['watch/providers'] && data['watch/providers'].results
      ? data['watch/providers'].results.DE
      : null;
    const providerNames = new Set();
    const providerAppIds = new Set();
    if (de) {
      for (const cat of ['flatrate', 'free', 'ads']) {
        for (const p of de[cat] || []) {
          if (PROVIDER_IDS[p.provider_id]) providerNames.add(PROVIDER_IDS[p.provider_id]);
          if (APP_SERVICE_MAP[p.provider_id]) providerAppIds.add(APP_SERVICE_MAP[p.provider_id]);
        }
      }
    }
    if (requireProviders && providerNames.size === 0) continue;

    const castList = ((data.credits && data.credits.cast) || []).slice(0, 5);
    const castIds = castList.map((m) => m.id).filter(Boolean);
    const castNames = castList.slice(0, 3).map((m) => m.name).filter(Boolean);

    const genreNames = (data.genres || [])
      .map((g) => g.name || GENRE_MAP[g.id])
      .filter(Boolean)
      .slice(0, 3);

    const country = c.type === 'tv'
      ? ((data.origin_country && data.origin_country[0]) || null)
      : ((data.production_countries && data.production_countries[0] && data.production_countries[0].iso_3166_1) || null);

    out.push({
      key: c.key,
      tmdb_id: c.tmdb_id,
      type: c.type,
      title: c.title,
      year: c.release_date ? c.release_date.slice(0, 4) : '',
      release_date: c.release_date,
      is_upcoming: !!c.is_upcoming,
      rating: Math.round(c.vote_average * 10) / 10,
      vote_count: c.vote_count,
      taste_score: c.taste_score,
      genres: genreNames,
      genre_ids: c.genre_ids,
      providers: Array.from(providerNames).sort(),
      providers_app: Array.from(providerAppIds),
      cast: castNames,
      country,
      runtime: c.type === 'movie' ? (data.runtime || null) : null,
      seasons: c.type === 'tv' ? (data.number_of_seasons || null) : null,
      episodes: c.type === 'tv' ? (data.number_of_episodes || null) : null,
      overview: data.overview || c.overview || '',
      poster_path: data.poster_path || c.poster_path,
      backdrop_path: data.backdrop_path || c.backdrop_path,
      reason: buildReason(c, taste, castList),
      fan_of: pickFanOf(c, tasteSample),
    });
  }
  return out;
}

// Rule-based "Warum fuer dich" — composed from the taste-match factors that
// actually fired for this item. Lean v1: no LLM involved.
function buildReason(c, taste, castList) {
  const parts = [];

  const matchedGenres = (c.genre_ids || [])
    .filter((gid) => (taste.genres[gid] || 0) >= 0.4)
    .sort((a, b) => (taste.genres[b] || 0) - (taste.genres[a] || 0))
    .slice(0, 2)
    .map((gid) => GENRE_MAP[gid])
    .filter(Boolean);
  if (matchedGenres.length > 0) {
    parts.push(`${matchedGenres.join(' + ')} ${matchedGenres.length > 1 ? 'treffen' : 'trifft'} dein Profil`);
  }

  const tasteCast = castList.find((m) => m.id && (taste.cast[m.id] || 0) > 0);
  if (tasteCast) {
    parts.push(`mit ${tasteCast.name} aus deinem Profil`);
  }

  const year = c.release_year || parseReleaseYear(c);
  if (year && parts.length < 3) {
    const decade = Math.floor(year / 10) * 10;
    if ((taste.decades[decade] || 0) >= 0.6) {
      parts.push(`${decade}er liegen dir`);
    }
  }

  if (parts.length < 3 && typeof c.vote_average === 'number' && c.vote_average > 0
      && Math.abs(c.vote_average - taste.avg_rating) <= 0.7) {
    parts.push(`Bewertung auf deinem Niveau`);
  }

  if (parts.length === 0) {
    parts.push('Insgesamt nah an deinem Geschmacksprofil');
  }
  return parts.slice(0, 3).join(' · ');
}

// "Fuer Fans von" — watchlist sample title with max genre overlap.
// Known v1 quality limit: genre-based similarity is coarse (documented in plan).
function pickFanOf(c, tasteSample) {
  if (!Array.isArray(tasteSample) || tasteSample.length === 0) return null;
  const cGenres = new Set(c.genre_ids || []);
  if (cGenres.size === 0) return null;
  let best = null;
  let bestOverlap = 0;
  for (const s of tasteSample) {
    const overlap = (s.genre_ids || []).filter((g) => cGenres.has(g)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = s;
    }
  }
  const minOverlap = cGenres.size === 1 ? 1 : 2;
  return bestOverlap >= minOverlap ? best.title : null;
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
