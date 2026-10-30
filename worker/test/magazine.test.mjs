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
    e: { OWNER_SYNC_KEY: OWNER, ADMIN_KEY: ADMIN, TMDB_API_KEY: 't', WATCHLIST_KV: binding, ALLOWLIST_TTL_MS: 0, ...extra },
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
