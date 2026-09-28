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

test('Link faellt ohne Such-Vorlage auf die TMDB-Watch-Seite', async () => {
  mockTmdb({ 5: { flatrate: [p(8, 'Netflix')] } });
  const { body } = await avail(env(['netflix']), [{ type: 'movie', id: 5, title: 'E' }]);
  assert.match(body.results['movie:5'].best.link, /themoviedb\.org\/movie\/5\/watch/);
});

test('zu viele Titel und fehlender Schluessel werden abgewiesen', async () => {
  mockTmdb({});
  const many = Array.from({ length: 41 }, (_, i) => ({ type: 'movie', id: i + 1 }));
  assert.equal((await avail(env(null), many)).status, 400);
  const res = await worker.fetch(new Request('https://w/availability', { method: 'POST', body: '{}' }), env(null), {});
  assert.equal(res.status, 401);
});
