// Tests fuer GET /live-tv (Auth, Paket B 10-Sender-Filter, HTML Joyn-Skip & 20:15-Auswahl, KV-Cache live_tv:v2)
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

function berlinWindowHhMm() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 12) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const startMin = h * 60 + m - 10;
  const endMin = h * 60 + m + 45;
  const fmt = (tot) => {
    const wrapped = ((tot % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  return { start: fmt(startMin), end: fmt(endMin) };
}

const { start: CUR_START, end: CUR_END } = berlinWindowHhMm();

// Realistisches TV-Spielfilm-HTML mit vorgelagertem leerem Joyn-Icon-Anchor in col-3 + 19:45 Vorlauf + 20:00 Tagesschau + 20:15 Hauptsendung
const SAMPLE_ARD_HTML = `<table>
  <tr class="hover">
    <td class="col-2"><strong>${CUR_START} - ${CUR_END}</strong></td>
    <td class="col-3">
      <div class="programm-listing-livetv">
        <a title="Live" href="https://x.tvspielfilm.de/joyn" class="check-livetv"><span class="add-info icon-joyn"></span></a>
      </div>
      <span>
        <a href="https://www.tvspielfilm.de/tv-programm/sendung/wer-weiss-denn-sowas,123.html"><strong>Wer weiß denn sowas?</strong></a> D&nbsp; 2026
      </span>
    </td>
    <td class="col-4"><span>Quiz</span></td>
    <td class="col-5"><span>Unterhaltung</span></td>
  </tr>
  <tr class="hover">
    <td class="col-2"><strong>19:45 - 19:50</strong></td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/tv-programm/sendung/wissen,124.html"><strong>Wissen vor acht</strong></a></td>
    <td class="col-4"><span>Wissen</span></td>
  </tr>
  <tr class="hover">
    <td class="col-2"><strong>20:00 - 20:15</strong></td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/tv-programm/sendung/tagesschau,125.html"><strong>Tagesschau</strong></a></td>
    <td class="col-4"><span>Nachrichten</span></td>
  </tr>
  <tr class="hover">
    <td class="col-2"><strong>20:15 - 21:00</strong></td>
    <td class="col-3">
      <div class="programm-listing-livetv"><a href="https://x.tvspielfilm.de/joyn" class="check-livetv"><span class="icon-joyn"></span></a></div>
      <a href="https://www.tvspielfilm.de/tv-programm/sendung/kanzlei,126.html"><strong>Die Kanzlei</strong></a>
    </td>
    <td class="col-4"><span>Krimiserie</span></td>
  </tr>
</table>`;

const SAMPLE_RTL_HTML = `<table>
  <tr class="hover">
    <td class="col-2"><strong>${CUR_START} - ${CUR_END}</strong></td>
    <td class="col-3">
      <a href="https://x.tvspielfilm.de/joyn" class="check-livetv"><span class="icon-joyn"></span></a>
      <a href="https://www.tvspielfilm.de/tv-programm/sendung/explosiv,201.html"><strong>Explosiv</strong></a>
    </td>
    <td class="col-4"><span>Magazin</span></td>
  </tr>
  <tr class="hover">
    <td class="col-2"><strong>20:15 - 22:30</strong></td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/tv-programm/sendung/wer-wird-millionaer,202.html"><strong>Wer wird Millionär?</strong></a></td>
    <td class="col-4"><span>Quizshow</span></td>
  </tr>
</table>`;

const SAMPLE_SKY_BULI_HTML = `<table>
  <tr class="hover">
    <td class="col-2">${CUR_START} - ${CUR_END}</td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/tv-programm/sendung/buli-live,1.html">Fußball: Bundesliga live</a></td>
    <td class="col-4">Sport</td>
  </tr>
  <tr class="hover">
    <td class="col-2">19:30 - 21:30</td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/tv-programm/sendung/topspiel,2.html">Fußball: Bundesliga Topspiel</a></td>
    <td class="col-4">Sport</td>
  </tr>
</table>`;

const SAMPLE_SKY_F1_HTML = `<table>
  <tr class="hover">
    <td class="col-2">20:00 - 22:00</td>
    <td class="col-3"><a href="https://www.tvspielfilm.de/tv-programm/sendung/f1,3.html">Formel 1: Großer Preis der USA</a></td>
    <td class="col-4">Motorsport</td>
  </tr>
</table>`;

const SAMPLE_JETZT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>13:10 | Arte | Stadt Land Kunst</title>
    <description>Kultur und Musik.</description>
    <enclosure url="https://img.tvspielfilm.de/74/6b/c9/sample.jpeg?im=Resize,width=159" type="image/jpeg"/>
  </item>
  <item>
    <title>13:10 | VOX | CSI: Miami</title>
    <description>Krimiserie aus Miami.</description>
    <enclosure url="https://img.tvspielfilm.de/31/53/c9/vox.jpeg?im=Resize,width=159" type="image/jpeg"/>
  </item>
  <item>
    <title>20:15 | ZDF | heute-show Spezial</title>
    <description>Satire-Live-Rückblick.</description>
    <enclosure url="https://img.tvspielfilm.de/31/53/c9/zdf.jpeg?im=Resize,width=159" type="image/jpeg"/>
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
    <description>Musikfilm — nicht in Paket B.</description>
  </item>
  <item>
    <title>17:00 | Kinowelt TV | Malcom X</title>
    <description>Nicht abonnierter Drittanbieter.</description>
  </item>
  <item>
    <title>20:15 | ZDF | Champions League</title>
    <description>Live aus München.</description>
    <enclosure url="https://img.tvspielfilm.de/1d/45/cc/zdf2015.jpeg?im=Resize,width=159" type="image/jpeg"/>
  </item>
</channel></rss>`;

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
    if (s.includes('das-erste,ARD.html')) return new Response(SAMPLE_ARD_HTML, { status: 200 });
    if (s.includes('rtl,RTL.html')) return new Response(SAMPLE_RTL_HTML, { status: 200 });
    if (s.includes('sky-sport-bundesliga,BULI.html')) return new Response(SAMPLE_SKY_BULI_HTML, { status: 200 });
    if (s.includes('sky-sport-f1,SKYF1.html')) return new Response(SAMPLE_SKY_F1_HTML, { status: 200 });
    if (s.includes('sky-sport-news,SNHD.html')) {
      return new Response(`<table><tr class="hover"><td class="col-2">${CUR_START} - ${CUR_END}</td><td class="col-3"><a href="/tv-programm/sendung/ssn,1.html">Sky Sport News</a></td></tr></table>`, { status: 200 });
    }
    if (s.includes('sky-sport-top-event,SKYSTE.html')) {
      return new Response(`<table><tr class="hover"><td class="col-2">20:10 - 22:30</td><td class="col-3"><a href="/tv-programm/sendung/atp,2.html">Tennis: ATP World Tour Finals</a></td></tr></table>`, { status: 200 });
    }
    if (s.includes('sky-sport-premier-league,SKYSPL.html')) {
      return new Response(`<table><tr class="hover"><td class="col-2">20:45 - 21:45</td><td class="col-3"><a href="/tv-programm/sendung/pl,3.html">Fußball: Premier League</a></td></tr></table>`, { status: 200 });
    }
    if (s.includes('tvspielfilm.de/tv-programm/sendungen/')) return new Response('<table></table>', { status: 200 });
    if (s.includes('api.openligadb.de/getmatchdata/bl1')) return new Response(SAMPLE_BL1_JSON, { status: 200 });
    if (s.includes('api.themoviedb.org/3/search/multi')) {
      return new Response(JSON.stringify({
        results: [{ id: 555, media_type: 'tv', backdrop_path: tmdbBackdrop, poster_path: '/p.jpg', vote_average: 7.9 }],
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

test('GET /live-tv filtert strikt Paket B (10 Sender), ueberspringt Joyn-Icon & Vorlauf und nutzt live_tv:v2 Cache', async () => {
  const { e, kv } = makeEnv();
  const fetched = mockLiveSources();

  const res1 = await worker.fetch(new Request('https://w/live-tv', { headers: { 'X-API-Key': OWNER } }), e, {});
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.cached, false);

  const allItems = [...body1.now, ...body1.primetime, ...body1.sport];
  const ardNow = body1.now.find((x) => x.channel === 'Das Erste');
  const ardPrime = body1.primetime.find((x) => x.channel === 'Das Erste');
  const rtlPrime = body1.primetime.find((x) => x.channel === 'RTL');
  const buliLive = body1.now.find((x) => x.channel === 'Sky Sport Bundesliga');
  const buliPrime = body1.primetime.find((x) => x.channel === 'Sky Sport Bundesliga');
  const f1Prime = body1.primetime.find((x) => x.channel === 'Sky Sport F1');
  const plPrime = body1.primetime.find((x) => x.channel === 'Sky Sport Premier League');
  const bl1 = body1.sport.find((x) => x.title.includes('Bayern'));

  // Joyn-Icon-Anchor darf Titel nicht leeren
  assert.equal(ardNow.title, 'Wer weiß denn sowas?');
  assert.equal(ardNow.track, 'sat');
  // 20:15 waehlt Hauptsendung statt 19:45 Vorlauf oder 20:00 Tagesschau + uebernimmt RSS-Bild/TMDB
  assert.equal(ardPrime.title, 'Die Kanzlei');
  assert.equal(ardPrime.tmdbId, 555);
  assert.equal(rtlPrime.title, 'Wer wird Millionär?');
  assert.equal(rtlPrime.track, 'magenta');

  // Alle 5 Sky-Sport-Kanaele inkl. 19:30-21:30 Bundesliga sind im Live/20:15-Strom; kein Sky-TMDB-Call
  assert.equal(buliLive.title, 'Fußball: Bundesliga live');
  assert.equal(buliPrime.title, 'Fußball: Bundesliga Topspiel');
  assert.equal(buliPrime.startTime, '19:30');
  assert.equal(f1Prime.title, 'Formel 1: Großer Preis der USA');
  assert.equal(plPrime.title, 'Fußball: Premier League');
  assert.ok(bl1);

  // Paket B: Arte, VOX, Sky Cinema Premiere und Kinowelt TV sind komplett ausgeschlossen
  assert.equal(allItems.some((x) => /arte|vox|kinowelt|sky cinema/i.test(x.channel)), false);
  assert.ok(kv.has('live_tv:v2'));

  // TMDB wird NICHT fuer Wer wird Millionaer oder Sky Sport gerufen -> exakt <= 1 TMDB Call (Die Kanzlei)
  const tmdbSearches = fetched.filter((u) => u.includes('search/multi'));
  assert.equal(tmdbSearches.length, 1);
  assert.ok(fetched.length <= 16, `Subrequests kompakt (${fetched.length})`);

  // Zweiter Aufruf komplett aus KV-Cache (0 neue Fetches!)
  const callsAfterFirst = fetched.length;
  const res2 = await worker.fetch(new Request('https://w/live-tv', { headers: { 'X-API-Key': OWNER } }), e, {});
  const body2 = await res2.json();
  assert.equal(body2.cached, true);
  assert.equal(fetched.length, callsAfterFirst);
});

test('GET /live-tv faellt sauber auf Paket-B RSS-Eintraege zurueck wenn HTML-Seiten 500 liefern', async () => {
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
  assert.ok(body.primetime.some((x) => x.channel === 'Das Erste' && x.title === 'Die Kanzlei'));
  assert.ok(body.primetime.some((x) => x.channel === 'ZDF' && x.title === 'Champions League'));
  assert.equal(body.primetime.some((x) => /sky cinema|kinowelt/i.test(x.channel)), false);
});
