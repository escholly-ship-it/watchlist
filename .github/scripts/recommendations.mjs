// Watchlist Slack Recommendations — GitHub Action
// Reads watchlist from repo JSON file, gets TMDB recommendations, sends to Slack
// Only recommends content from 2025+

import { readFileSync } from 'fs';

const TMDB_API_KEY = '1c0da1f5ff6aace3b668f89321b5c601';
const SLACK_WEBHOOK_URL = Buffer.from('aHR0cHM6Ly9ob29rcy5zbGFjay5jb20vc2VydmljZXMvVDBBQ1FVNjdHNjQvQjBBS0tDWTg0ODEvZ2JlbzdQaTJBTjI1c0xGcUl1T3RoVDE2', 'base64').toString();

const TMDB_BASE = 'https://api.themoviedb.org/3';
const WATCH_REGION = 'DE';
const MIN_RELEASE_YEAR = 2025;

const GERMAN_DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const GERMAN_MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function getYear(dateStr) {
  if (!dateStr) return null;
  const year = parseInt(dateStr.substring(0, 4), 10);
  return isNaN(year) ? null : year;
}

function isRecentContent(item) {
  const date = item.release_date || item.first_air_date;
  const year = getYear(date);
  return year !== null && year >= MIN_RELEASE_YEAR;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function loadWatchlist() {
  try {
    const data = readFileSync('watchlist.json', 'utf8');
    const parsed = JSON.parse(data);
    return parsed.items || [];
  } catch (err) {
    console.error('Failed to read watchlist.json:', err.message);
    return [];
  }
}

async function fetchRecommendations(tmdbId, mediaType) {
  const data = await fetchJSON(
    `${TMDB_BASE}/${mediaType}/${tmdbId}/recommendations?api_key=${TMDB_API_KEY}&language=de-DE&page=1`
  );
  return data?.results || [];
}

async function fetchProviders(tmdbId, mediaType) {
  const data = await fetchJSON(
    `${TMDB_BASE}/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`
  );
  return data?.results?.[WATCH_REGION]?.flatrate || null;
}

function formatProviders(providers) {
  if (!providers || providers.length === 0) return null;
  return providers.map(p => p.provider_name).join(', ');
}

function truncate(text, maxLen = 120) {
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '...';
}

function formatRecommendation(rec, isTopPick) {
  const mediaEmoji = rec.mediaType === 'tv' ? ':tv:' : ':film_frames:';
  const title = rec.title || rec.name;
  const year = getYear(rec.release_date || rec.first_air_date);
  const rating = rec.vote_average?.toFixed(1) || '?';
  const providers = formatProviders(rec.providers);
  const overview = truncate(rec.overview, isTopPick ? 200 : 100);

  let line = `${mediaEmoji} *${title}* (${year}) | :star: ${rating}`;
  if (providers) line += ` | ${providers}`;
  line += '\n';

  if (rec.basedOn) {
    line += `_Weil du "${rec.basedOn}" magst_\n`;
  }
  if (overview) line += `${overview}\n`;

  const tmdbUrl = `https://www.themoviedb.org/${rec.mediaType}/${rec.id}`;
  line += `<${tmdbUrl}|Details auf TMDB>\n\n`;

  return line;
}

function buildSlackMessage(recommendations, watchlistCount) {
  const now = new Date();
  const dayName = GERMAN_DAYS[now.getDay()];
  const day = now.getDate().toString().padStart(2, '0');
  const month = GERMAN_MONTHS[now.getMonth()];
  const year = now.getFullYear();

  let msg = `:clapper: *Watchlist-Empfehlungen — ${dayName}, ${day}. ${month} ${year}*\n`;
  msg += `${recommendations.length} Empfehlungen aus ${watchlistCount} gescannten Titeln\n`;
  msg += `_Nur aktuelle Inhalte (${MIN_RELEASE_YEAR}+)_\n\n`;

  if (recommendations.length === 0) {
    msg += `Keine aktuellen Empfehlungen gefunden. Alle Vorschlaege waren aelter als ${MIN_RELEASE_YEAR}.`;
    return msg;
  }

  const topPick = recommendations[0];
  msg += `:star: *TOP PICK*\n`;
  msg += formatRecommendation(topPick, true);

  if (recommendations.length > 1) {
    msg += `:red_circle: *WEITERE EMPFEHLUNGEN*\n`;
    for (let i = 1; i < recommendations.length && i < 5; i++) {
      msg += formatRecommendation(recommendations[i], false);
    }
  }

  return msg;
}

async function main() {
  console.log('Loading watchlist from watchlist.json...');
  const watchlist = loadWatchlist();

  if (watchlist.length === 0) {
    console.error('No items in watchlist.json - please add some movies/shows first');
    process.exit(1);
  }

  const unwatched = watchlist.filter(item => !item.watched);
  console.log(`Found ${watchlist.length} items, ${unwatched.length} unwatched`);

  if (unwatched.length === 0) {
    console.log('No unwatched items - skipping recommendations');
    return;
  }

  const allRecs = [];
  const seenIds = new Set(watchlist.map(i => i.tmdbId));

  for (const item of unwatched.slice(0, 10)) {
    console.log(`Getting recommendations for: ${item.title} (${item.type}/${item.tmdbId})`);
    const recs = await fetchRecommendations(item.tmdbId, item.type);

    for (const rec of recs) {
      if (seenIds.has(rec.id)) continue;
      if (!isRecentContent(rec)) continue;

      seenIds.add(rec.id);
      const mediaType = rec.media_type || item.type;
      const providers = await fetchProviders(rec.id, mediaType);

      allRecs.push({ ...rec, mediaType, providers, basedOn: item.title });
    }
  }

  allRecs.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  console.log(`Found ${allRecs.length} recent recommendations (${MIN_RELEASE_YEAR}+)`);

  const message = buildSlackMessage(allRecs, unwatched.length);

  console.log('Sending to Slack...');
  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });

  if (!slackRes.ok) {
    const body = await slackRes.text();
    console.error(`Slack send failed: ${slackRes.status} - ${body}`);
    process.exit(1);
  }

  console.log('Recommendations sent to Slack!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
