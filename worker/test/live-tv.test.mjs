// Tests fuer GET /live-tv (Auth, RSS/HTML/OpenLigaDB-Parsing, 3-Spur-Routing, KV-Cache)
// Lauf: node --test worker/test/live-tv.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const OWNER = 'o'.repeat(40);
const STRANGER = 'x'.repeat(40);
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

function makeEnv(extra = {}) {
  const kv = new Map();
  kv.set('config:magazine_members', JSON.stringify([]));
  const kvCalls = { get: 0, put: 0 };
  const binding = {
    get: async (k, type) => {
      kvCalls.get++;
      const v = kv.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => {
      kvCalls.put++;
      kv.set(k, v);
    },
    delete: async (k) => { kv.delete(k); },
  };
  return {
    e: { OWNER_SYNC_KEY: OWNER, TMDB_API_KEY: 'test-tmdb', WATCHLIST_KV: binding, ALLOWLIST_TTL_MS: 0, ...extra },
    kv,
    kvCalls,
  };
}

const SAMPLE_JETZT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>13:10 | Arte | Stadt Land Kunst</title>
    <description>Kultur und Musik.</description>
    <enclosure url="https://img.tvspielfilm.de/74/6b/c9/sample.jpeg?im=Crop,rect=(0,0,1232,845),gravity=Center;Resize,width=159" type="image/jpeg"/>
  </item>
  <item>
    <title>13:10 | VOX | CSI: Miami</title>
    <description>Krimiserie aus Miami.</description>
    <enclosure url="https://img.tvspielfilm.de/31/53/c9/vox.jpeg?im=Resize,width=159" type="image/jpeg"/>
  </item>
</channel></rss>`;

const SAMPLE_2015_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>20:15 | Das Erste | Die Kanzlei</title>
    <description>Anwaltsserie aus Hamburg.</description>
    <enclosure url="https://img.tvspielfilm.de/1d/45/cc/ard.jpeg?im=Resize,width=159" type="image/jpeg"/>
  </item>
  <item>
    <title>20:15 | sky cinema premiere | Song Sung Blue</title>
    <description>Musikfilm mit Hugh Jackman.</description>
    <enclosure url="https://img.tvspielfilm.de/68/53/59/sky.jpeg?im=Resize,width=159" type="image/jpeg"/>
  </item>
</channel></rss>`;

const SAMPLE_SKY_BULI_HTML = `<table>
  <tr class="hover">
    <td class="col-2">13:30 - 14:30</td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/sendung/1">Fußball: Bundesliga</a></td>
    <td class="col-4">Fußballmagazin</td>
  </tr>
</table>`;

const SAMPLE_BL1_JSON = JSON.stringify([
  {
    matchIsFinished: false,
    matchDateTime: '2026-11-20T20:30:00',
    team1: { teamName: 'FC Bayern München', shortName: 'Bayern' },
    team2: { teamName: '1. FC Köln', shortName: 'Köln' },
  },
]);

function mockLiveSources({ tmdbBackdrop = '/abc123.jpg' } = {}) {
  const fetched = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    fetched.push(s);
    if (s.includes('/rss/jetzt.xml')) return new Response(SAMPLE_JETZT_XML, { status: 200 });
    if (s.includes('/rss/heute2015.xml')) return new Response(SAMPLE_2015_XML, { status: 200 });
    if (s.includes('/rss/filme.xml')) return new Response(SAMPLE_2015_XML, { status: 200 });
    if (s.includes('sky-sport-bundesliga,BULI.html')) return new Response(SAMPLE_SKY_BULI_HTML, { status: 200 });
    if (s.includes('api.openligadb.de/getmatchdata/bl1')) return new Response(SAMPLE_BL1_JSON, { status: 200 });
    if (s.includes('tvspielfilm.de/tv-programm/sendungen/')) return new Response('<table></table>', { status: 200 });
    if (s.includes('api.themoviedb.org/3/search/multi')) {
      return new Response(JSON.stringify({
        results: [{ id: 555, media_type: 'movie', backdrop_path: tmdbBackdrop, poster_path: '/p.jpg', vote_average: 7.9 }],
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return fetched;
}

test('GET /live-tv verlangt bekannten X-API-Key', async () => {
  const { e } = makeEnv();
  const resNoKey = await worker.fetch(new Request('https://w/live-tv'), e, {});
  assert.equal(resNoKey.status, 401);
  const resBadKey = await worker.fetch(new Request('https://w/live-tv', { headers: { 'X-API-Key': STRANGER } }), e, {});
  assert.equal(resBadKey.status, 401);
});

test('GET /live-tv ordnet 3 Spuren korrekt zu, skaliert Bilder und nutzt KV-Cache', async () => {
  const { e, kv } = makeEnv();
  const fetched = mockLiveSources();

  const res1 = await worker.fetch(new Request('https://w/live-tv', { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.cached, false);

  const allItems = [...body1.now, ...body1.primetime, ...body1.sport];
  const arte = allItems.find((x) => x.channel === 'Arte');
  const vox = allItems.find((x) => x.channel === 'VOX');
  const skyFilm = allItems.find((x) => x.title === 'Song Sung Blue');
  const bl1 = body1.sport.find((x) => x.title.includes('Bayern'));

  assert.equal(arte.track, 'sat');
  assert.equal(arte.mediathekServiceId, 'arte');
  assert.match(arte.imageUrl, /Resize,width=1280|image\.tmdb\.org/);

  assert.equal(vox.track, 'magenta');
  assert.equal(vox.trackLabel, 'MAGENTA HD');
  assert.equal(vox.webUrl, 'https://web.magentatv.de/tv-guide');

  assert.equal(skyFilm.track, 'sky');
  assert.equal(skyFilm.tmdbId, 555);
  assert.equal(skyFilm.imageUrl, 'https://image.tmdb.org/t/p/w1280/abc123.jpg');

  assert.ok(bl1);
  assert.equal(bl1.track, 'sky');
  assert.equal(bl1.startTime, '20:30');
  assert.ok(kv.has('live_tv:v1'));

  const callsAfterFirst = fetched.length;
  assert.ok(callsAfterFirst <= 18, `TMDB + EPG calls stayed compact (${callsAfterFirst})`);

  // Zweiter Aufruf muss komplett aus dem KV-Cache kommen (0 neue HTTP-Fetches!)
  const res2 = await worker.fetch(new Request('https://w/live-tv', { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.cached, true);
  assert.equal(fetched.length, callsAfterFirst);
});

test('GET /live-tv bleibt stabil wenn Teilquellen 500 liefern', async () => {
  const { e } = makeEnv();
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('/rss/heute2015.xml')) return new Response(SAMPLE_2015_XML, { status: 200 });
    return new Response('err', { status: 500 });
  };
  const res = await worker.fetch(new Request('https://w/live-tv', { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.primetime.length >= 2);
});
