// WL-34: nur bekannte Schluessel, Groessengrenze und 400 fuer kaputtes JSON,
// ueber den echten fetch-Handler; KV und TMDB gemockt.
// Lauf: node --test worker/test/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const OWNER = 'o'.repeat(40);
const LEGACY = 'l'.repeat(40);
const ROSTER = 'r'.repeat(40);
const LISTED = 's'.repeat(40);
const STRANGER = 'x'.repeat(40);
const TEST_KEY = 'a'.repeat(40);

globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });

// KV-Mock wie Cloudflare: Werte als Text gespeichert, 'json' parst (und
// wirft bei kaputtem JSON). Der Schluessel-Cache ist modulweit; ttl 0 laedt
// in jedem Test neu, nur der Cache-Test setzt eine Laufzeit.
function env({ roster = [ROSTER], list = [LISTED], failGet = false, ttl = 0 } = {}) {
  const kv = new Map();
  const store = (k, v) => kv.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (roster !== null) store('config:magazine_members', roster); // null = Eintrag fehlt
  if (list !== null) store('config:sync_keys', list);
  const calls = { get: 0, put: 0 };
  const binding = {
    get: async (k, type) => {
      calls.get++;
      if (failGet && (k === 'config:sync_keys' || k === 'config:magazine_members')) throw new Error('kv down');
      const v = kv.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { calls.put++; kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
  };
  return {
    e: { OWNER_SYNC_KEY: OWNER, API_KEY: LEGACY, TMDB_API_KEY: 't', WATCHLIST_KV: binding, ALLOWLIST_TTL_MS: ttl },
    calls,
    kv,
  };
}

function req(path, key, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (key) headers['X-API-Key'] = key;
  return new Request(`https://w${path}`, { ...init, headers });
}

const ROUTES = [
  ['/sync', { method: 'GET' }],
  ['/sync', { method: 'PUT', body: JSON.stringify({ items: [] }), headers: { 'Content-Type': 'application/json' } }],
  ['/magazine', { method: 'GET' }],
  ['/tmdb/search?q=a', { method: 'GET' }],
  ['/tmdb/details?type=movie&id=1', { method: 'GET' }],
  ['/availability', { method: 'POST', body: JSON.stringify({ items: [] }) }],
];

test('fremder 40-Zeichen-Schluessel bekommt auf allen Routen 401', async () => {
  const { e, calls } = env();
  for (const [path, init] of ROUTES) {
    const res = await worker.fetch(req(path, STRANGER, init), e, {});
    assert.equal(res.status, 401, path);
  }
  assert.equal(calls.put, 0);
});

test('Owner, API_KEY, Roster und Liste kommen durch', async () => {
  for (const key of [OWNER, LEGACY, ROSTER, LISTED]) {
    const { e } = env();
    const res = await worker.fetch(req('/sync', key), e, {});
    assert.equal(res.status, 200, key.slice(0, 1));
  }
});

test('Test-Schluessel bleibt draussen, auch wenn er in der Liste steht', async () => {
  const { e } = env({ list: [TEST_KEY] });
  assert.equal((await worker.fetch(req('/sync', TEST_KEY), e, {})).status, 401);
});

test('fehlende oder kaputte Liste: nur Owner und Roster', async () => {
  for (const list of [null, '"x"', '{"a":1}', '["' + 's'.repeat(40) + '",']) {
    const { e } = env({ list });
    assert.equal((await worker.fetch(req('/sync', LISTED), e, {})).status, 401);
    assert.equal((await worker.fetch(req('/sync', ROSTER), e, {})).status, 200);
    assert.equal((await worker.fetch(req('/sync', OWNER), e, {})).status, 200);
  }
});

test('Liste wird je Instanz zwischengespeichert', async () => {
  const { e, calls } = env();
  await worker.fetch(req('/tmdb/search?q=a', STRANGER), e, {}); // ttl 0: laedt sicher neu
  e.ALLOWLIST_TTL_MS = 60000;
  const after1 = calls.get;
  await worker.fetch(req('/tmdb/search?q=a', STRANGER), e, {});
  await worker.fetch(req('/tmdb/search?q=a', LISTED), e, {});
  assert.equal(after1, 2); // Roster + Liste, einmal
  assert.equal(calls.get, after1);
});

test('KV-Fehler wird nicht gecacht, die naechste Anfrage liest neu', async () => {
  const { e, calls, kv } = env({ failGet: true });
  assert.equal((await worker.fetch(req('/tmdb/search?q=a', LISTED), e, {})).status, 401);
  // KV wieder gesund
  e.WATCHLIST_KV.get = async (k) => { calls.get++; return kv.get(k) ?? null; }; // 'text'
  assert.equal((await worker.fetch(req('/tmdb/search?q=a', LISTED), e, {})).status, 200);
});

test('gueltiges PUT speichert', async () => {
  const { e, kv } = env();
  const res = await worker.fetch(req('/sync', OWNER, ROUTES[1][1]), e, {});
  assert.equal(res.status, 200);
  assert.equal(kv.get(`watchlist:${OWNER}`), '[]');
});

test('kaputtes JSON gibt 400 statt 500', async () => {
  for (const body of ['{kaputt', '', 'null', '42']) {
    const { e, calls } = env();
    const res = await worker.fetch(req('/sync', OWNER, { method: 'PUT', body }), e, {});
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(calls.put, 0);
  }
});

const MAX = 4 * 1024 * 1024;

function bigBody(bytes) {
  const pad = 'é'; // 2 Byte in UTF-8: Bytes zaehlen, nicht Zeichen
  const head = '{"items":["';
  const tail = '"]}';
  const n = Math.ceil((bytes - head.length - tail.length) / 2);
  return head + pad.repeat(n) + tail;
}

test('zu grosser Body: 413 mit und ohne Content-Length', async () => {
  const body = bigBody(MAX + 2);
  assert.ok(new TextEncoder().encode(body).byteLength > MAX);
  {
    const { e, calls } = env();
    const res = await worker.fetch(req('/sync', OWNER, { method: 'PUT', body }), e, {});
    assert.equal(res.status, 413);
    assert.equal(calls.put, 0);
  }
  {
    // Stream ohne Content-Length (chunked)
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 65536) c.enqueue(bytes.slice(i, i + 65536));
        c.close();
      },
    });
    const { e, calls } = env();
    const r = new Request('https://w/sync', { method: 'PUT', body: stream, duplex: 'half', headers: { 'X-API-Key': OWNER } });
    assert.equal(r.headers.get('Content-Length'), null);
    const res = await worker.fetch(r, e, {});
    assert.equal(res.status, 413);
    assert.equal(calls.put, 0);
  }
});

test('Body knapp unter der Grenze geht durch', async () => {
  const body = bigBody(MAX - 16);
  assert.ok(new TextEncoder().encode(body).byteLength <= MAX);
  const { e } = env();
  const res = await worker.fetch(req('/sync', OWNER, { method: 'PUT', body }), e, {});
  assert.equal(res.status, 200);
});
