// WL-42: PUT /sync fuehrt mit dem KV-Stand zusammen, Geschmacksprofil ohne
// Loesch-Marker — ueber den echten fetch-Handler, KV und TMDB gemockt.
// Lauf: node --test worker/test/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const OWNER = 'o'.repeat(40);
const ADMIN = 'admin-key';
const DAY = 24 * 60 * 60 * 1000;

const tmdbPaths = [];
globalThis.fetch = async (url) => {
  tmdbPaths.push(new URL(String(url)).pathname);
  return new Response(JSON.stringify({ results: [], genres: [{ id: 18 }], release_date: '2001-01-01' }), { status: 200 });
};

function env(stored) {
  const kv = new Map();
  kv.set('config:magazine_members', JSON.stringify([]));
  if (stored !== undefined) kv.set(`watchlist:${OWNER}`, typeof stored === 'string' ? stored : JSON.stringify(stored));
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
    e: { OWNER_SYNC_KEY: OWNER, ADMIN_KEY: ADMIN, TMDB_API_KEY: 't', WATCHLIST_KV: binding, ALLOWLIST_TTL_MS: 0 },
    kv,
  };
}

const t = (id, extra = {}) => {
  const now = Date.now();
  return { id, tmdbId: Number(id.replace(/\D/g, '')) || 1, type: 'movie', title: id, watched: false, addedAt: now - 1000, updatedAt: now - 1000, ...extra };
};

async function put(e, items) {
  const res = await worker.fetch(new Request('https://w/sync', {
    method: 'PUT',
    headers: { 'X-API-Key': OWNER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }), e, {});
  return { status: res.status, body: await res.json() };
}

async function get(e) {
  const res = await worker.fetch(new Request('https://w/sync', { headers: { 'X-API-Key': OWNER } }), e, {});
  return (await res.json()).items;
}

const ids = (list) => list.map(it => it.id).sort();

test('zwei Geraete speichern nacheinander verschiedene Titel: beide bleiben', async () => {
  const { e } = env([]);
  await put(e, [t('a1')]);
  await put(e, [t('b2')]);
  assert.deepEqual(ids(await get(e)), ['a1', 'b2']);
});

test('leere Liste loescht nichts', async () => {
  const { e } = env([t('a1'), t('b2')]);
  const r = await put(e, []);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.deepEqual(ids(await get(e)), ['a1', 'b2']);
});

test('Marker gewinnt gegen aeltere Fassung und bleibt in GET /sync', async () => {
  const now = Date.now();
  const { e } = env([t('a1', { updatedAt: now - 5000 })]);
  await put(e, [t('a1', { deleted: true, updatedAt: now - 10 })]);
  const items = await get(e);
  assert.equal(items.length, 1);
  assert.equal(items[0].deleted, true);
});

test('Marker aelter als 30 Tage faellt beim Speichern weg', async () => {
  const old = Date.now() - 31 * DAY;
  const { e } = env([t('a1', { deleted: true, updatedAt: old, addedAt: old })]);
  await put(e, [t('b2')]);
  assert.deepEqual(ids(await get(e)), ['b2']);
});

test('Gleichstand: gespeicherte Fassung gewinnt, juengere Anbieter-Pruefung aus dem Body bleibt', async () => {
  const now = Date.now();
  const stored = t('a1', { title: 'server', updatedAt: now - 100, providers: { checkedAt: now - 5000, flatrate: [1] } });
  const { e } = env([stored]);
  await put(e, [t('a1', { title: 'geraet', updatedAt: now - 100, providers: { checkedAt: now - 10 } })]);
  const [it] = await get(e);
  assert.equal(it.title, 'server');
  assert.deepEqual(it.providers, { checkedAt: now - 10, flatrate: [1] });
});

test('kaputter KV-Stand gilt als leer: 200 und Body gespeichert', async () => {
  const { e } = env('{kaputt');
  const r = await put(e, [t('a1')]);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(await get(e)), ['a1']);
});

test('Geschmacksprofil fragt TMDB nur nach lebenden Titeln', async () => {
  const now = Date.now();
  const { e, kv } = env([t('a11'), t('b22', { deleted: true, updatedAt: now })]);
  tmdbPaths.length = 0;
  const res = await worker.fetch(new Request('https://w/rebuild-taste', {
    method: 'POST', headers: { 'X-Admin-Key': ADMIN },
  }), e, {});
  assert.equal(res.status, 200);
  assert.ok(tmdbPaths.some(p => p.endsWith('/movie/11')), tmdbPaths.join(','));
  assert.ok(!tmdbPaths.some(p => p.endsWith('/movie/22')), tmdbPaths.join(','));
  assert.ok(kv.has(`taste:${OWNER}`));
});
