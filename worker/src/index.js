// Watchlist Sync API — Cloudflare Worker + KV
// Multi-tenant: each sync key = separate watchlist namespace

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

const MIN_KEY_LENGTH = 32;

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
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
