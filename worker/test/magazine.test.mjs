// WL-JULES-WARTUNG: Magazin-Pipeline (POST /magazine-build, GET /magazine) und
// TMDB-Proxy ueber den echten fetch-Handler, KV und TMDB gemockt.
// Lauf: node --test worker/test/magazine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const OWNER = 'o'.repeat(40);
const ADMIN = 'admin-key';
const NETFLIX = 8;

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

// Geschmack entsteht aus der Watchlist: ein geschautes Drama genuegt.
const SEED = [{ id: 'seed', tmdbId: 99, type: 'movie', title: 'Seed', watched: true, addedAt: 1, updatedAt: 1 }];

function env(extra = {}, { seeded = true } = {}) {
  const kv = new Map();
  kv.set('config:magazine_members', JSON.stringify([]));
  if (seeded) kv.set(`watchlist:${OWNER}`, JSON.stringify(SEED));
  const binding = {
    get: async (k, type) => {
      const v = kv.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
  };
  return {
    e: { OWNER_SYNC_KEY: OWNER, ADMIN_KEY: ADMIN, TMDB_API_KEY: 't', WATCHLIST_KV: binding, ...extra },
    kv,
  };
}

function mockTmdb(handler) {
  const paths = [];
  globalThis.fetch = async (u) => {
    const url = new URL(String(u));
    paths.push(url.pathname);
    const out = handler(url);
    if (out === null) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return paths;
}

const build = (e, query = '', headers = { 'X-Admin-Key': ADMIN }) =>
  worker.fetch(new Request(`https://w/magazine-build${query}`, { method: 'POST', headers }), e, {});

const discoverHit = (id) => ({
  id, title: `Titel ${id}`, name: `Titel ${id}`, overview: 'x',
  release_date: new Date().toISOString().slice(0, 10), first_air_date: new Date().toISOString().slice(0, 10),
  vote_average: 8, vote_count: 500, popularity: 100, genre_ids: [18], original_language: 'en',
});

function tmdbWithHits() {
  return mockTmdb((url) => {
    if (url.pathname.includes('/discover/')) {
      return { results: url.pathname.endsWith('/movie') ? [discoverHit(11), discoverHit(12)] : [] };
    }
    return {
      id: 11, title: 'Titel', genres: [{ id: 18, name: 'Drama' }],
      'watch/providers': { results: { DE: { flatrate: [{ provider_id: NETFLIX, provider_name: 'Netflix' }] } } },
      credits: { cast: [{ name: 'A', profile_path: null }] },
    };
  });
}

test('magazine-build ohne Admin-Schluessel: 401, kein TMDB-Aufruf', async () => {
  const { e } = env();
  const paths = mockTmdb(() => ({}));
  assert.equal((await build(e, '', {})).status, 401);
  assert.equal((await build(e, '', { 'X-Admin-Key': 'falsch' })).status, 401);
  assert.equal(paths.length, 0);
});

test('fehlendes TMDB-Secret: ok false mit Fehlertext, nichts gespeichert', async () => {
  const { e, kv } = env({ TMDB_API_KEY: undefined });
  mockTmdb(() => ({}));
  const body = await (await build(e)).json();
  assert.equal(body.ok, false);
  assert.match(body.error, /TMDB_API_KEY/);
  assert.equal([...kv.keys()].some((k) => k.startsWith('magazine:')), false);
});

test('keine passenden Titel: uebersprungen, kein Magazin gespeichert', async () => {
  const { e, kv } = env();
  mockTmdb(() => ({ results: [] }));
  const body = await (await build(e)).json();
  assert.equal(body.ok, false);
  assert.equal(body.skipped, true);
  assert.equal(kv.has(`magazine:${OWNER}`), false);
});

test('dryRun baut das Magazin, schreibt aber nichts', async () => {
  const { e, kv } = env();
  tmdbWithHits();
  const body = await (await build(e, '?dryRun=1')).json();
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.magazine.version, 2);
  assert.deepEqual(body.magazine.sections.map((s) => s.id), ['neu', 'demnaechst', 'entdeckt']);
  assert.ok(body.magazine.counts.neu >= 1);
  assert.equal(kv.has(`magazine:${OWNER}`), false);
});

test('echter Lauf speichert Magazin und Seen-Stand; GET /magazine liefert es', async () => {
  const { e, kv } = env();
  tmdbWithHits();
  const body = await (await build(e)).json();
  assert.equal(body.ok, true);
  assert.ok(body.counts.neu >= 1);
  assert.ok(body.subrequests.total <= 44, 'Subrequest-Invariante');
  const stored = JSON.parse(kv.get(`magazine:${OWNER}`));
  assert.equal(stored.sections[0].items.length, body.counts.neu);
  assert.ok([...kv.keys()].some((k) => k.startsWith('magazine_seen:')));

  const res = await worker.fetch(new Request('https://w/magazine', { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).magazine.version, 2);
});

test('zweiter Lauf wiederholt gesehene Titel nicht', async () => {
  const { e } = env();
  tmdbWithHits();
  await build(e);
  const second = await (await build(e, '?dryRun=1')).json();
  assert.equal(second.kills.neu.seen >= 1, true);
});

test('GET /magazine ohne gebautes Magazin: magazine null', async () => {
  const { e } = env();
  const res = await worker.fetch(new Request('https://w/magazine', { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal((await res.json()).magazine, null);
});

test('TMDB-Proxy: Suche filtert auf Film und Serie und kappt auf 8', async () => {
  const { e } = env();
  mockTmdb(() => ({
    results: [
      { media_type: 'person', id: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({ media_type: i % 2 ? 'tv' : 'movie', id: 100 + i })),
    ],
  }));
  const res = await worker.fetch(new Request('https://w/tmdb/search?q=film', { headers: { 'X-API-Key': OWNER } }), e, {});
  const { results } = await res.json();
  assert.equal(results.length, 8);
  assert.ok(results.every((r) => r.media_type === 'movie' || r.media_type === 'tv'));
});

test('TMDB-Proxy: Suche ohne q 400, TMDB-Ausfall 502', async () => {
  const { e } = env();
  mockTmdb(() => null);
  const get = (p) => worker.fetch(new Request(`https://w${p}`, { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal((await get('/tmdb/search?q=')).status, 400);
  assert.equal((await get('/tmdb/search?q=film')).status, 502);
  assert.equal((await get('/tmdb/details?type=movie&id=1')).status, 502);
});

test('TMDB-Proxy: Details verlangen gueltigen Typ und Zahl', async () => {
  const { e } = env();
  const paths = mockTmdb(() => ({ id: 5 }));
  const get = (p) => worker.fetch(new Request(`https://w${p}`, { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal((await get('/tmdb/details?type=person&id=5')).status, 400);
  assert.equal((await get('/tmdb/details?type=movie&id=abc')).status, 400);
  assert.equal((await get('/tmdb/details?type=movie&id=-3')).status, 400);
  assert.equal(paths.length, 0);
  const ok = await get('/tmdb/details?type=tv&id=5');
  assert.equal(ok.status, 200);
  assert.deepEqual(paths, ['/3/tv/5']);
});

test('Magazin v3 Sprach- & Qualitaets-Schranke: blockt unlokalisierte Nischentitel, laesst Welt-Hits durch', async () => {
  const { e } = env();
  const today = new Date().toISOString().slice(0, 10);
  mockTmdb((url) => {
    if (url.pathname.includes('/discover/movie')) {
      return {
        results: [
          {
            id: 501, title: 'அக்கா', overview: 'x', release_date: today,
            vote_average: 7.5, vote_count: 40, popularity: 80, genre_ids: [18], original_language: 'ta',
          },
          {
            id: 502, title: 'Nischentitel Ohne Resonanz', overview: 'Kurze Beschreibung auf Deutsch fuer Testzwecke.',
            release_date: today, vote_average: 7.1, vote_count: 15, popularity: 50, genre_ids: [18], original_language: 'hi',
          },
          {
            id: 503, title: 'Parasite', overview: 'Eine arme Familie schleicht sich nach und nach in das Haus einer wohlhabenden Familie ein.',
            release_date: today, vote_average: 8.5, vote_count: 18000, popularity: 120, genre_ids: [18], original_language: 'ko',
          },
        ],
      };
    }
    if (url.pathname.includes('/discover/') || url.pathname.includes('/trending/') || url.pathname.includes('/recommendations')) {
      return { results: [] };
    }
    return {
      id: 503,
      title: 'Parasite',
      release_date: today,
      vote_average: 8.5,
      vote_count: 18000,
      genres: [{ id: 18, name: 'Drama' }],
      'watch/providers': { results: { DE: { flatrate: [{ provider_id: NETFLIX, provider_name: 'Netflix' }] } } },
      videos: { results: [{ site: 'YouTube', type: 'Teaser', key: 'yt_parasite', official: true, iso_639_1: 'de' }] },
      credits: { cast: [] },
    };
  });

  const body = await (await build(e, '?dryRun=1')).json();
  assert.equal(body.ok, true);
  const neuIds = body.magazine.sections[0].items.map((x) => x.tmdb_id);
  assert.deepEqual(neuIds, [503]);
  assert.equal(body.magazine.sections[0].items[0].trailer_key, 'yt_parasite');
  assert.ok(body.kills.neu.langQuality >= 2);
});

test('Magazin v3 Demnaechst-Schutz: filtert Kino-Wiederauffuehrungen alter Klassiker (1984/2015) aus', async () => {
  const { e } = env();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  mockTmdb((url) => {
    if (url.pathname.includes('/discover/movie') && url.searchParams.get('with_release_type') === '4|6') {
      return {
        results: [
          {
            id: 601, title: 'The Hateful 8', overview: 'Tarantino Western.',
            release_date: nextWeek, vote_average: 7.8, vote_count: 12000, popularity: 60, genre_ids: [18], original_language: 'en',
          },
          {
            id: 602, title: 'Echter Neustart', overview: 'Brandneuer Film.',
            release_date: nextWeek, vote_average: 7.9, vote_count: 35, popularity: 95, genre_ids: [18], original_language: 'en',
          },
        ],
      };
    }
    if (url.pathname.includes('/discover/') || url.pathname.includes('/trending/') || url.pathname.includes('/recommendations')) {
      return { results: [] };
    }
    if (url.pathname.endsWith('/movie/601')) {
      return {
        id: 601, title: 'The Hateful 8', release_date: '2015-12-25',
        vote_average: 7.8, vote_count: 12000, genres: [{ id: 18, name: 'Drama' }],
      };
    }
    return {
      id: 602, title: 'Echter Neustart', release_date: nextWeek,
      vote_average: 7.9, vote_count: 35, genres: [{ id: 18, name: 'Drama' }],
      videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'yt_602', official: true, iso_639_1: 'de' }] },
    };
  });

  const body = await (await build(e, '?dryRun=1')).json();
  assert.equal(body.ok, true);
  const upIds = body.magazine.sections.find((s) => s.id === 'demnaechst').items.map((x) => x.tmdb_id);
  assert.deepEqual(upIds, [602]);
});

test('Magazin v3 Familien-Crons + Feedback + Refresh fuer mehrere Familienprofile', async () => {
  const MEMBER_B = 'b'.repeat(40);
  const MEMBER_C = 'c'.repeat(40);
  const MEMBER_D = 'd'.repeat(40);
  const { e, kv } = env();
  kv.set('config:magazine_members', JSON.stringify([MEMBER_B, MEMBER_C, MEMBER_D]));
  // Member D hat 0 gesehene Titel und bevorzugt Disney+ (337)
  kv.set(`watchlist:${MEMBER_D}`, JSON.stringify([
    { id: 'd1', tmdbId: 77, type: 'tv', title: 'Disney Hit', watched: false, serviceId: 'disney', addedAt: 100, updatedAt: 100 },
  ]));

  let discoverCalls = 0;
  mockTmdb((url) => {
    if (url.pathname.includes('/discover/movie')) {
      discoverCalls++;
      return { results: discoverCalls <= 2 ? [discoverHit(21), discoverHit(22)] : [discoverHit(21), discoverHit(22), discoverHit(23)] };
    }
    if (url.pathname.includes('/discover/') || url.pathname.includes('/trending/') || url.pathname.includes('/recommendations')) {
      return { results: [] };
    }
    const idMatch = url.pathname.match(/\/(\d+)$/);
    const hitId = idMatch ? Number(idMatch[1]) : 21;
    return {
      id: hitId, title: `Familien-Treffer ${hitId}`, genres: [{ id: 18, name: 'Drama' }],
      vote_average: 8.1, vote_count: 400,
      'watch/providers': {
        results: {
          DE: {
            flatrate: [
              { provider_id: NETFLIX, provider_name: 'Netflix' },
              { provider_id: 337, provider_name: 'Disney+' },
            ],
          },
        },
      },
      credits: { cast: [] },
    };
  });

  // Slot 3 ("0 5 * * *") baut gezielt das 4. Familienmitglied (MEMBER_D)
  const waits = [];
  await worker.scheduled({ cron: '0 5 * * *', scheduledTime: Date.now() }, e, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);

  const magD = JSON.parse(kv.get(`magazine:${MEMBER_D}`));
  assert.ok(magD && magD.sections[0].items.length >= 1);
  // Disney+ steht bei Member D vor Netflix, weil Member D Disney+ auf der Watchlist nutzt!
  assert.equal(magD.sections[0].items[0].providers_app[0], 'disney');

  // Member D blendet movie_21 per /magazine/feedback aus -> verschwindet sofort aus GET /magazine
  const fbRes = await worker.fetch(new Request('https://w/magazine/feedback', {
    method: 'POST',
    headers: { 'X-API-Key': MEMBER_D, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'movie_21', action: 'dismiss', title: 'Titel 21' }),
  }), e, {});
  assert.equal(fbRes.status, 200);

  const afterDismiss = await (await worker.fetch(new Request('https://w/magazine', {
    headers: { 'X-API-Key': MEMBER_D },
  }), e, {})).json();
  assert.equal(afterDismiss.magazine.sections[0].items.some((x) => x.key === 'movie_21'), false);

  // On-Demand /magazine/refresh?force=1 liefert frische Ausgabe ohne den ausgeblendeten Titel
  const refRes = await worker.fetch(new Request('https://w/magazine/refresh?force=1', {
    method: 'POST',
    headers: { 'X-API-Key': MEMBER_D },
  }), e, {});
  const refBody = await refRes.json();
  assert.equal(refRes.status, 200);
  assert.equal(refBody.refreshed, true);
  assert.equal(refBody.magazine.sections[0].items.some((x) => x.key === 'movie_21'), false);
  assert.equal(refBody.magazine.sections[0].items.some((x) => x.key === 'movie_23'), true);
});
