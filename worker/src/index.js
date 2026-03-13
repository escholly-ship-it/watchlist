// Watchlist Sync API — Cloudflare Worker + KV
// Multi-tenant: each sync key = separate watchlist namespace
// Includes scheduled recommendations with recent content filter (2025+)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

const MIN_KEY_LENGTH = 32;
const MIN_RELEASE_YEAR = 2025; // Filter: only recommend recent content
const TMDB_BASE = 'https://api.themoviedb.org/3';
const WATCH_REGION = 'DE';

// German day names for Slack header
const GERMAN_DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const GERMAN_MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// Extract year from TMDB date string (YYYY-MM-DD)
function getYear(dateStr) {
  if (!dateStr) return null;
  const year = parseInt(dateStr.substring(0, 4), 10);
  return isNaN(year) ? null : year;
}

// Check if content is recent enough (>= MIN_RELEASE_YEAR)
function isRecentContent(item) {
  const date = item.release_date || item.first_air_date;
  const year = getYear(date);
  return year !== null && year >= MIN_RELEASE_YEAR;
}

// Fetch recommendations from TMDB for a given title
async function fetchRecommendations(tmdbId, mediaType, tmdbApiKey) {
  const url = `${TMDB_BASE}/${mediaType}/${tmdbId}/recommendations?api_key=${tmdbApiKey}&language=de-DE&page=1`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

// Fetch watch providers for a title
async function fetchProviders(tmdbId, mediaType, tmdbApiKey) {
  const url = `${TMDB_BASE}/${mediaType}/${tmdbId}/watch/providers?api_key=${tmdbApiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[WATCH_REGION]?.flatrate || null;
}

// Format provider names for display
function formatProviders(providers) {
  if (!providers || providers.length === 0) return null;
  return providers.map(p => p.provider_name).join(', ');
}

// Truncate text to max length with ellipsis
function truncate(text, maxLen = 120) {
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

// Build Slack message blocks for recommendations
function buildSlackMessage(recommendations, watchlistCount, syncKey, date) {
  const dayName = GERMAN_DAYS[date.getDay()];
  const day = date.getDate().toString().padStart(2, '0');
  const month = GERMAN_MONTHS[date.getMonth()];
  const year = date.getFullYear();

  let message = `:clapper: *Watchlist-Empfehlungen — ${dayName}, ${day}. ${month} ${year}*\n`;
  message += `${recommendations.length} Empfehlungen aus ${watchlistCount} gescannten Watchlist-Titeln\n`;
  message += `_Nur aktuelle Inhalte (${MIN_RELEASE_YEAR}+)_\n\n`;

  if (recommendations.length === 0) {
    message += `Keine aktuellen Empfehlungen gefunden. Alle Vorschläge waren älter als ${MIN_RELEASE_YEAR}.`;
    return message;
  }

  // Top pick (first recommendation)
  const topPick = recommendations[0];
  message += `:star: *TOP PICK*\n`;
  message += formatRecommendation(topPick, syncKey, true);

  // Additional recommendations
  if (recommendations.length > 1) {
    message += `\n:red_circle: *EMPFEHLUNGEN*\n`;
    for (let i = 1; i < recommendations.length && i < 5; i++) {
      message += formatRecommendation(recommendations[i], syncKey, false);
    }
  }

  return message;
}

// Format a single recommendation for Slack
function formatRecommendation(rec, syncKey, isTopPick) {
  const mediaEmoji = rec.mediaType === 'tv' ? ':tv:' : ':film_frames:';
  const title = rec.title || rec.name;
  const year = getYear(rec.release_date || rec.first_air_date);
  const rating = rec.vote_average?.toFixed(1) || '?';
  const providers = formatProviders(rec.providers);
  const overview = truncate(rec.overview, isTopPick ? 200 : 100);

  let line = `${mediaEmoji} *${title}* (${year}) · :star: ${rating}`;
  if (providers) {
    line += ` · ${providers}`;
  }
  line += `\n`;

  if (rec.basedOn) {
    line += `→ Weil du *${rec.basedOn}* auf deiner Watchlist hast\n`;
  }

  if (overview) {
    line += `${overview}\n`;
  }

  // Links
  const tmdbUrl = `https://www.themoviedb.org/${rec.mediaType}/${rec.id}`;
  const addUrl = `https://escholly-ship-it.github.io/watchlist/?key=${syncKey}&add=${rec.id}&type=${rec.mediaType}`;
  line += `<${tmdbUrl}|:mag: Details>  ·  <${addUrl}|:heavy_plus_sign: Watchlist>\n\n`;

  return line;
}

// Send message to Slack webhook
async function sendToSlack(message, webhookUrl) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  return res.ok;
}

// Main recommendation generation logic
async function generateRecommendations(env) {
  const syncKey = env.API_KEY;
  const tmdbApiKey = env.TMDB_API_KEY;
  const slackWebhook = env.SLACK_WEBHOOK_URL;

  if (!syncKey || !tmdbApiKey || !slackWebhook) {
    console.log('Missing env vars: API_KEY, TMDB_API_KEY, or SLACK_WEBHOOK_URL');
    return { error: 'Missing configuration' };
  }

  // Load watchlist
  const kvKey = `watchlist:${syncKey}`;
  const watchlist = await env.WATCHLIST_KV.get(kvKey, 'json') || [];
  const unwatched = watchlist.filter(item => !item.watched);

  if (unwatched.length === 0) {
    return { message: 'No unwatched items in watchlist' };
  }

  // Collect recommendations from all watchlist items
  const allRecs = [];
  const seenIds = new Set(watchlist.map(i => i.tmdbId));

  for (const item of unwatched.slice(0, 10)) { // Limit to 10 items to avoid rate limits
    const recs = await fetchRecommendations(item.tmdbId, item.type, tmdbApiKey);

    for (const rec of recs) {
      // Skip if already in watchlist or already recommended
      if (seenIds.has(rec.id)) continue;

      // Filter: only recent content (2025+)
      if (!isRecentContent(rec)) continue;

      seenIds.add(rec.id);

      // Fetch providers
      const mediaType = rec.media_type || item.type;
      const providers = await fetchProviders(rec.id, mediaType, tmdbApiKey);

      allRecs.push({
        ...rec,
        mediaType,
        providers,
        basedOn: item.title,
      });
    }
  }

  // Sort by rating (highest first)
  allRecs.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));

  // Build and send Slack message
  const message = buildSlackMessage(allRecs, unwatched.length, syncKey, new Date());
  await sendToSlack(message, slackWebhook);

  return {
    success: true,
    recommendationsCount: allRecs.length,
    watchlistScanned: unwatched.length,
    minYear: MIN_RELEASE_YEAR,
  };
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Auth: key must be present and long enough (entropy = security)
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey.length < MIN_KEY_LENGTH) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const kvKey = `watchlist:${apiKey}`;
    const url = new URL(request.url);

    if (url.pathname === '/sync' && request.method === 'GET') {
      // GET /sync — return watchlist for this key
      let data = await env.WATCHLIST_KV.get(kvKey, 'json');

      // Legacy migration: if no data under namespaced key, check old single-tenant key
      if (!data) {
        const legacy = await env.WATCHLIST_KV.get('watchlist', 'json');
        if (legacy && apiKey === env.API_KEY) {
          // Migrate: copy to new namespace, delete legacy
          await env.WATCHLIST_KV.put(kvKey, JSON.stringify(legacy));
          await env.WATCHLIST_KV.delete('watchlist');
          data = legacy;
        }
      }

      return json({ items: data || [], timestamp: Date.now() });
    }

    if (url.pathname === '/sync' && request.method === 'PUT') {
      // PUT /sync — save watchlist for this key
      const body = await request.json();
      if (!Array.isArray(body.items)) {
        return json({ error: 'items must be an array' }, 400);
      }
      await env.WATCHLIST_KV.put(kvKey, JSON.stringify(body.items));
      return json({ ok: true, count: body.items.length, timestamp: Date.now() });
    }

    return json({ error: 'Not found' }, 404);
  },

  // Scheduled trigger for daily recommendations
  async scheduled(event, env, ctx) {
    console.log('Running scheduled recommendations job...');
    const result = await generateRecommendations(env);
    console.log('Recommendations result:', JSON.stringify(result));
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
