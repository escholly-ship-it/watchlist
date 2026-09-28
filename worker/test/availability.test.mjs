// WL-28: kritischer Pfad der Anbieter-Wahl ueber den echten fetch-Handler,
// TMDB und KV gemockt. Lauf: node --test worker/test/availability.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'k'.repeat(32);

function env(profile) {
  const kv = new Map();
  if (profile) kv.set(`config:providers:${KEY}`, profile);
  return {
    TMDB_API_KEY: 'x',
    WATCHLIST_KV: { get: async (k) => kv.get(k) ?? null, put: async () => {}, delete: async () => {} },
  };
}

function mockTmdb(byId) {
  globalThis.fetch = async (u) => {
    const m = String(u).match(/\/(movie|tv)\/(\d+)\/watch\/providers/);
    const de = m ? byId[m[2]] : undefined;
    return new Response(JSON.stringify({ results: de ? { DE: de } : {} }), { status: 200 });
  };
}

async function avail(e, items) {
  const req = new Request('https://w/availability', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const res = await worker.fetch(req, e, {});
  return { status: res.status, body: await res.json() };
}

const p = (id, name) => ({ provider_id: id, provider_name: name });

test('nur Leihen/Kaufen ergibt kein best, dafuer rentOnly', async () => {
  mockTmdb({ 1: { rent: [p(178, 'MagentaTV'), p(2, 'Apple TV')], buy: [p(178, 'MagentaTV')] } });
  const { body } = await avail(env(['magenta']), [{ type: 'movie', id: 1, title: 'A' }]);
  const r = body.results['movie:1'];
  assert.equal(r.best, null);
  assert.deepEqual(r.rentOnly, ['MagentaTV', 'Apple TV']);
});

test('freie Mediathek schlaegt ein Abo', async () => {
  mockTmdb({ 2: { flatrate: [p(8, 'Netflix')], free: [p(219, 'ARD')] } });
  const { body } = await avail(env(['netflix']), [{ type: 'movie', id: 2, title: 'B' }]);
  const r = body.results['movie:2'];
  assert.equal(r.best.service, 'ard');
  assert.equal(r.best.kind, 'free');
  assert.deepEqual(r.alternatives.map((a) => a.service), ['netflix']);
});

test('Abo ausserhalb des Profils zaehlt nicht, Profil-Reihenfolge entscheidet', async () => {
  mockTmdb({ 3: { flatrate: [p(8, 'Netflix'), p(337, 'Disney+'), p(531, 'Paramount+')] } });
  const { body } = await avail(env(['paramount', 'disney']), [{ type: 'movie', id: 3, title: 'C' }]);
  const r = body.results['movie:3'];
  assert.equal(r.best.service, 'paramount');
  assert.deepEqual(r.alternatives.map((a) => a.service), ['disney']);
  assert.equal(body.profile, 'kv');
});

test('ohne Profil zaehlen alle Abos, Leihen nie', async () => {
  mockTmdb({ 4: { flatrate: [p(178, 'MagentaTV')], rent: [p(8, 'Netflix')] } });
  const { body } = await avail(env(null), [{ type: 'tv', id: 4, title: 'D' }]);
  assert.equal(body.results['tv:4'].best.service, 'magenta');
  assert.equal(body.profile, 'default');
});

test('Link faellt ohne Titel auf die TMDB-Watch-Seite', async () => {
  mockTmdb({ 5: { flatrate: [p(1899, 'HBO Max')] } });
  const { body } = await avail(env(['hbo']), [{ type: 'movie', id: 5 }]);
  assert.match(body.results['movie:5'].best.link, /themoviedb\.org\/movie\/5\/watch/);
  assert.equal(body.results['movie:5'].best.direct, false);
});

test('zu viele Titel und fehlender Schluessel werden abgewiesen', async () => {
  mockTmdb({});
  const many = Array.from({ length: 41 }, (_, i) => ({ type: 'movie', id: i + 1 }));
  assert.equal((await avail(env(null), many)).status, 400);
  const res = await worker.fetch(new Request('https://w/availability', { method: 'POST', body: '{}' }), env(null), {});
  assert.equal(res.status, 401);
});

test('Sterben-Fall: nur frei bei ARTE, Link auf die ARTE-Suche', async () => {
  mockTmdb({ 1232781: { free: [p(234, 'Arte')], rent: [p(178, 'MagentaTV')] } });
  const { body } = await avail(env(['magenta']), [{ type: 'movie', id: 1232781, title: 'Sterben' }]);
  const r = body.results['movie:1232781'];
  assert.equal(r.best.service, 'arte');
  assert.equal(r.best.link, 'https://www.arte.tv/de/search/?q=Sterben');
  assert.equal(r.best.direct, true);
});

test('WOW zaehlt nicht als Sky, Sky Go schon', async () => {
  mockTmdb({ 6: { flatrate: [p(30, 'WOW')] }, 7: { flatrate: [p(29, 'Sky Go')] } });
  const { body } = await avail(env(['sky']), [{ type: 'movie', id: 6, title: 'F' }, { type: 'movie', id: 7, title: 'G' }]);
  assert.equal(body.results['movie:6'].best, null);
  assert.equal(body.results['movie:7'].best.service, 'sky');
});

test('Abo-Suchlinks: Netflix, Magenta TV, Joyn mit Titel, Disney+ nur Such-Seite', async () => {
  mockTmdb({
    6: { flatrate: [p(8, 'Netflix')] },
    7: { flatrate: [p(178, 'MagentaTV')] },
    8: { flatrate: [p(304, 'Joyn')] },
    9: { flatrate: [p(337, 'Disney+')] },
    10: { flatrate: [p(29, 'Sky Go')] },
    12: { flatrate: [p(2750, 'RTL+')] },
    13: { flatrate: [p(1899, 'HBO Max')] },
  });
  const items = [6, 7, 8, 9, 10, 12, 13].map((id) => ({ type: 'movie', id, title: 'Stranger Things' }));
  const { body } = await avail(env(null), items);
  const best = (id) => body.results[`movie:${id}`].best;
  assert.equal(best(6).link, 'https://www.netflix.com/search?q=Stranger%20Things');
  assert.equal(best(7).link, 'https://web.magentatv.de/suche/vod_more_web/Stranger%20Things');
  assert.equal(best(8).link, 'https://www.joyn.de/suche?q=Stranger%20Things');
  for (const id of [6, 7, 8]) assert.equal(best(id).prefilled, true);
  assert.equal(best(9).link, 'https://www.disneyplus.com/de-de/browse/search');
  assert.equal(best(9).direct, true);
  assert.equal(best(9).prefilled, false);
  assert.equal(best(10).link, 'https://www.sky.de/suche?query=Stranger%20Things');
  assert.equal(best(10).prefilled, true);
  assert.equal(best(12).link, 'https://plus.rtl.de/suche?query=Stranger%20Things');
  assert.equal(best(12).prefilled, true);
  assert.equal(best(13).link, 'https://play.hbomax.com/search');
  assert.equal(best(13).prefilled, false);
});
