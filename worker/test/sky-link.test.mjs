// WL-43: Sky-Go-Deep-Link-Aufloesung ueber den echten fetch-Handler
// (JustWatch GraphQL + Sky Suggest DE gemockt). Lauf: node --test worker/test/sky-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'k'.repeat(32);

function makeEnv() {
  return {
    TMDB_API_KEY: 'x',
    OWNER_SYNC_KEY: KEY,
    WATCHLIST_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  };
}

async function callSkyLink(params, key = KEY) {
  const qs = new URLSearchParams(params).toString();
  const headers = key ? { 'X-API-Key': key } : {};
  const req = new Request(`https://w/sky-link?${qs}`, { method: 'GET', headers });
  const res = await worker.fetch(req, makeEnv(), {});
  return { status: res.status, body: await res.json() };
}

test('Validierung und Auth: fehlende Parameter 400, fremder Schluessel 401', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  assert.equal((await callSkyLink({ type: 'movie', id: '1' })).status, 400);
  assert.equal((await callSkyLink({ type: 'other', id: '1', title: 'X' })).status, 400);
  assert.equal((await callSkyLink({ type: 'movie', id: '0', title: 'X' })).status, 400);
  assert.equal((await callSkyLink({ type: 'movie', id: '1', title: 'X' }, 'z'.repeat(32))).status, 401);
});

test('Serie: direkter Treffer ueber Sky Suggest DE in einem Aufruf -> skygo://series/<UUID>', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init && init.headers });
    return new Response(JSON.stringify({
      results: [
        { uuid: '06411F70-9E6F-45EF-8565-A8EAC23857F4', uuidtype: 'series', t: 'House of the Dragon' },
      ],
    }), { status: 200 });
  };

  const { status, body } = await callSkyLink({ type: 'tv', id: '94997', title: 'House of the Dragon' });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    link: 'skygo://series/06411f70-9e6f-45ef-8565-a8eac23857f4',
    direct: true,
    prefilled: true,
    resolved: true,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /entity\.search\.sky\.com/);
  assert.equal(calls[0].headers['x-skyott-territory'], 'DE');
});

test('Serie mit abweichendem deutschem Titel nutzt JustWatch-Originaltitel fuer Sky Suggest', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('justwatch.com/graphql')) {
      return new Response(JSON.stringify({
        data: {
          popularTitles: {
            edges: [{
              node: {
                content: {
                  title: 'Deutscher Reihentitel',
                  originalTitle: 'Original Sky Title',
                  externalIds: { tmdbId: '555' },
                },
                offers: [],
              },
            }],
          },
        },
      }), { status: 200 });
    }
    if (u.includes('Original%20Sky%20Title')) {
      return new Response(JSON.stringify({
        results: [
          { uuid: '15204b81-063b-43f1-ac1d-d13430fa899f', uuidtype: 'series', t: 'Original Sky Title' },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };

  const { body } = await callSkyLink({ type: 'tv', id: '555', title: 'Deutscher Reihentitel' });
  assert.equal(body.link, 'skygo://series/15204b81-063b-43f1-ac1d-d13430fa899f');
  assert.equal(body.resolved, true);
});

test('Film: JustWatch gleicht exakt gegen tmdbId und packageId 29 ab -> skygo://watch/<UUID>', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('justwatch.com/graphql')) {
      return new Response(JSON.stringify({
        data: {
          popularTitles: {
            edges: [
              {
                node: {
                  content: { title: 'Halloween', originalTitle: 'Halloween', externalIds: { tmdbId: '948' } },
                  offers: [{
                    package: { packageId: 29, shortName: 'skg' },
                    standardWebURL: 'https://www.sky.de/produkte/sky-go#programme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                  }],
                },
              },
              {
                node: {
                  content: { title: 'Halloween', originalTitle: 'Halloween', externalIds: { tmdbId: '424139' } },
                  offers: [
                    {
                      package: { packageId: 30, shortName: 'sko' },
                      standardWebURL: 'https://www.wowtv.de/watch/11111111-2222-3333-4444-555555555555',
                    },
                    {
                      package: { packageId: 29, shortName: 'skg' },
                      deeplinkURL: 'https://www.sky.de/produkte/sky-go#programme/0ec07222-aef4-43e9-9bc6-a78b3ab439a7',
                    },
                  ],
                },
              },
            ],
          },
        },
      }), { status: 200 });
    }
    throw new Error('Sky Suggest sollte bei eindeutigem JustWatch-Treffer nicht noetig sein');
  };

  const { body } = await callSkyLink({
    type: 'movie',
    id: '424139',
    title: 'Halloween - Stelle dich deinem Schicksal',
  });
  assert.deepEqual(body, {
    link: 'skygo://watch/0ec07222-aef4-43e9-9bc6-a78b3ab439a7',
    direct: true,
    prefilled: true,
    resolved: true,
  });
});

test('Film-Fallback ueber Sky Suggest filtert Trailer-Clips aus und prueft Eindeutigkeit', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('justwatch.com/graphql')) {
      return new Response('upstream error', { status: 502 });
    }
    return new Response(JSON.stringify({
      results: [
        { uuid: '838c66a1-a740-4d06-a953-ca37c6bce927', uuidtype: 'programme', type: 'movie', t: 'Trailer: Scream 7' },
        { uuid: 'f14e52f0-c646-405c-8574-176010c5d5b7', uuidtype: 'programme', type: 'movie', t: 'Scream 7' },
      ],
    }), { status: 200 });
  };

  const { body } = await callSkyLink({ type: 'movie', id: '1159559', title: 'Scream 7' });
  assert.equal(body.link, 'skygo://watch/f14e52f0-c646-405c-8574-176010c5d5b7');
  assert.equal(body.resolved, true);
  assert.equal(body.prefilled, true);
});

test('Mehrdeutiger oder fehlender Treffer faellt ehrlich auf skygo:// (prefilled: false) zurueck', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('justwatch.com/graphql')) {
      return new Response(JSON.stringify({ data: { popularTitles: { edges: [] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      results: [
        { uuid: '11111111-1111-1111-1111-111111111111', uuidtype: 'programme', type: 'movie', t: 'Dune' },
        { uuid: '22222222-2222-2222-2222-222222222222', uuidtype: 'programme', type: 'movie', t: 'Dune' },
      ],
    }), { status: 200 });
  };

  const { status, body } = await callSkyLink({ type: 'movie', id: '438631', title: 'Dune' });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    link: 'skygo://',
    direct: true,
    prefilled: false,
    resolved: false,
  });
});
