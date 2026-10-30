// WL-NUTZUNG-MESSEN: Tageszaehler je Pseudonym in D1 ueber den echten
// fetch-Handler; KV und D1 gemockt.
// Lauf: node --test worker/test/nutzung.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';

const OWNER = 'o'.repeat(40);
const STRANGER = 'x'.repeat(40);
const PSEUDONYM = createHash('sha256').update(OWNER).digest('hex').slice(0, 12);

globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });

function kvBinding(stored) {
  const kv = new Map();
  kv.set('config:magazine_members', JSON.stringify([]));
  if (stored !== undefined) kv.set(`watchlist:${OWNER}`, JSON.stringify(stored));
  return {
    get: async (k, type) => {
      const v = kv.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
  };
}

// D1-Mock: merkt sich jede Anweisung mit ihren Parametern. fail: 'prepare'
// wirft sofort, 'run' liefert ein abgelehntes Promise.
function d1({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      if (fail === 'prepare') throw new Error('d1 down');
      return {
        bind(...params) {
          return {
            run: async () => {
              if (fail === 'run') throw new Error('d1 down');
              calls.push({ sql, params });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function setup({ db = d1(), stored = [] } = {}) {
  const e = { OWNER_SYNC_KEY: OWNER, TMDB_API_KEY: 't', WATCHLIST_KV: kvBinding(stored), ALLOWLIST_TTL_MS: 0 };
  if (db) e.NUTZUNG_DB = db;
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  return { e, db, ctx, settle: () => Promise.all(waits), waits };
}

const today = () => new Date().toISOString().slice(0, 10);

async function getSync(s, key = OWNER) {
  return worker.fetch(new Request('https://w/sync', { headers: { 'X-API-Key': key } }), s.e, s.ctx);
}

async function putSync(s, items) {
  return worker.fetch(new Request('https://w/sync', {
    method: 'PUT',
    headers: { 'X-API-Key': OWNER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }), s.e, s.ctx);
}

test('GET /sync zaehlt einen Abruf fuer heute und das Pseudonym', async () => {
  const s = setup();
  const res = await getSync(s);
  assert.equal(res.status, 200);
  await s.settle();
  assert.equal(s.waits.length, 1);
  assert.equal(s.db.calls.length, 1);
  assert.match(s.db.calls[0].sql, /do update set abrufe = abrufe \+ 1$/);
  assert.deepEqual(s.db.calls[0].params, [today(), PSEUDONYM]);
});

test('PUT /sync zaehlt eine Sendung', async () => {
  const s = setup();
  const res = await putSync(s, []);
  assert.equal(res.status, 200);
  await s.settle();
  assert.equal(s.db.calls.length, 1);
  assert.match(s.db.calls[0].sql, /do update set sendungen = sendungen \+ 1$/);
  assert.deepEqual(s.db.calls[0].params, [today(), PSEUDONYM]);
});

test('Pseudonym: 12 Hex-Zeichen, kein Teil des Schluessels', () => {
  assert.match(PSEUDONYM, /^[0-9a-f]{12}$/);
  assert.ok(!OWNER.includes(PSEUDONYM));
});

for (const fail of ['prepare', 'run']) {
  test(`D1 scheitert (${fail}): GET /sync liefert trotzdem 200 mit den Daten`, async () => {
    const item = { id: 'a1', tmdbId: 1, type: 'movie', title: 'a1', watched: false, addedAt: 1, updatedAt: 1 };
    const s = setup({ db: d1({ fail }), stored: [item] });
    const res = await getSync(s);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).items.map(it => it.id), ['a1']);
    await s.settle();
  });

  test(`D1 scheitert (${fail}): PUT /sync speichert trotzdem`, async () => {
    const s = setup({ db: d1({ fail }) });
    const res = await putSync(s, []);
    assert.equal(res.status, 200);
    await s.settle();
  });
}

test('ohne Binding wird nicht gezaehlt und Sync laeuft', async () => {
  const s = setup({ db: null });
  const res = await getSync(s);
  assert.equal(res.status, 200);
  assert.equal(s.waits.length, 0);
});

test('abgelehnter Schluessel wird nicht gezaehlt', async () => {
  const s = setup();
  const res = await getSync(s, STRANGER);
  assert.equal(res.status, 401);
  await s.settle();
  assert.equal(s.db.calls.length, 0);
});

test('andere Routen zaehlen nicht', async () => {
  const s = setup();
  const res = await worker.fetch(new Request('https://w/tmdb/search?q=x', { headers: { 'X-API-Key': OWNER } }), s.e, s.ctx);
  assert.equal(res.status, 200);
  await s.settle();
  assert.equal(s.db.calls.length, 0);
});

test('ohne ctx.waitUntil (aelterer Aufrufer) laeuft Sync weiter', async () => {
  const s = setup();
  const res = await worker.fetch(new Request('https://w/sync', { headers: { 'X-API-Key': OWNER } }), s.e, {});
  assert.equal(res.status, 200);
});
