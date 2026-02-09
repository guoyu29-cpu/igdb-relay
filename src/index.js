/**
 * IGDB API Relay - Cloudflare Worker
 * 
 * Handles Twitch OAuth token acquisition/caching and proxies requests
 * to the IGDB API. Designed for use from servers in China where
 * id.twitch.tv is blocked.
 * 
 * Environment variables (set as secrets):
 *   TWITCH_CLIENT_ID     - Twitch application Client ID
 *   TWITCH_CLIENT_SECRET - Twitch application Client Secret
 *   API_KEY              - Secret key for authenticating relay clients
 * 
 * KV binding:
 *   TOKEN_CACHE          - KV namespace for caching OAuth tokens
 */

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_BASE_URL = 'https://api.igdb.com/v4';
const TOKEN_KV_KEY = 'twitch_access_token';

// CORS headers for allowed origins
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

/**
 * Get allowed origins from environment or use defaults
 */
function getAllowedOrigins(env) {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  }
  return ['*'];
}

/**
 * Build CORS headers with origin check
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = getAllowedOrigins(env);
  const headers = { ...CORS_HEADERS };

  if (allowed.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (allowed.some(o => origin === o || origin.endsWith(o.replace('*', '')))) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else {
    headers['Access-Control-Allow-Origin'] = allowed[0];
  }

  return headers;
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Acquire a fresh Twitch OAuth token using client_credentials grant
 */
async function fetchTwitchToken(env) {
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    body: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twitch token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  // data: { access_token, expires_in, token_type }
  return data;
}

/**
 * Get a valid access token, using KV cache when possible.
 * Refreshes automatically when expired or about to expire (5 min buffer).
 */
async function getAccessToken(env) {
  // Try KV cache first
  const cached = await env.TOKEN_CACHE.get(TOKEN_KV_KEY, { type: 'json' });

  if (cached && cached.access_token && cached.expires_at) {
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minutes before expiry
    if (cached.expires_at - bufferMs > now) {
      return cached.access_token;
    }
  }

  // Fetch new token
  const tokenData = await fetchTwitchToken(env);
  const expiresAt = Date.now() + tokenData.expires_in * 1000;

  // Store in KV with TTL matching token lifetime (minus buffer)
  const ttlSeconds = Math.max(tokenData.expires_in - 600, 3600); // at least 1 hour
  await env.TOKEN_CACHE.put(
    TOKEN_KV_KEY,
    JSON.stringify({
      access_token: tokenData.access_token,
      expires_at: expiresAt,
    }),
    { expirationTtl: ttlSeconds }
  );

  return tokenData.access_token;
}

/**
 * Validate the API key from the request
 */
function validateApiKey(request, env) {
  if (!env.API_KEY) return true; // No API_KEY configured = open relay (dev mode)

  const key = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
  return key === env.API_KEY;
}

/**
 * Proxy a request to the IGDB API
 * 
 * Route: POST /v4/{endpoint}
 * Body: Apicalypse query string (e.g. "fields name; limit 10;")
 */
async function proxyIgdbRequest(endpoint, body, env) {
  const accessToken = await getAccessToken(env);

  const igdbUrl = `${IGDB_BASE_URL}/${endpoint}`;

  const response = await fetch(igdbUrl, {
    method: 'POST',
    headers: {
      'Client-ID': env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'text/plain',
    },
    body: body,
  });

  // If 401, token may have been revoked — retry once with fresh token
  if (response.status === 401) {
    // Clear cached token
    await env.TOKEN_CACHE.delete(TOKEN_KV_KEY);
    const freshToken = await getAccessToken(env);

    const retryResponse = await fetch(igdbUrl, {
      method: 'POST',
      headers: {
        'Client-ID': env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${freshToken}`,
        'Accept': 'application/json',
        'Content-Type': 'text/plain',
      },
      body: body,
    });

    return retryResponse;
  }

  return response;
}

/**
 * Handle multi-query (IGDB multiquery endpoint)
 * Route: POST /v4/multiquery
 */
async function proxyMultiQuery(body, env) {
  return proxyIgdbRequest('multiquery', body, env);
}

/**
 * Main request handler
 */
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const cors = corsHeaders(request, env);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Health check
  if (path === '/' || path === '/health') {
    return jsonResponse({ status: 'ok', service: 'igdb-relay' }, 200, cors);
  }

  // Validate API key for all /v4 routes
  if (path.startsWith('/v4')) {
    if (!validateApiKey(request, env)) {
      return jsonResponse({ error: 'Unauthorized: invalid API key' }, 401, cors);
    }
  }

  // POST /v4/{endpoint} — proxy to IGDB
  if (request.method === 'POST' && path.startsWith('/v4/')) {
    const endpoint = path.replace('/v4/', '');

    if (!endpoint) {
      return jsonResponse({ error: 'Missing IGDB endpoint' }, 400, cors);
    }

    try {
      const body = await request.text();
      const igdbResponse = await proxyIgdbRequest(endpoint, body, env);

      // Stream the IGDB response back
      const responseHeaders = new Headers(cors);
      responseHeaders.set('Content-Type', igdbResponse.headers.get('Content-Type') || 'application/json');

      // Forward rate limit headers from IGDB
      const rateLimitHeaders = ['X-Count', 'X-Next-Page'];
      for (const h of rateLimitHeaders) {
        const val = igdbResponse.headers.get(h);
        if (val) responseHeaders.set(h, val);
      }

      return new Response(igdbResponse.body, {
        status: igdbResponse.status,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('IGDB proxy error:', error);
      return jsonResponse(
        { error: 'Failed to proxy IGDB request', details: error.message },
        502,
        cors
      );
    }
  }

  // GET /token/status — check token status (debug endpoint)
  if (request.method === 'GET' && path === '/token/status') {
    if (!validateApiKey(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    try {
      const cached = await env.TOKEN_CACHE.get(TOKEN_KV_KEY, { type: 'json' });
      if (cached && cached.expires_at) {
        const remaining = Math.max(0, cached.expires_at - Date.now());
        return jsonResponse({
          has_token: true,
          expires_in_seconds: Math.floor(remaining / 1000),
          expires_at: new Date(cached.expires_at).toISOString(),
        }, 200, cors);
      }
      return jsonResponse({ has_token: false }, 200, cors);
    } catch (error) {
      return jsonResponse({ error: error.message }, 500, cors);
    }
  }

  // GET /token/refresh — force token refresh (debug endpoint)
  if (request.method === 'GET' && path === '/token/refresh') {
    if (!validateApiKey(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    try {
      await env.TOKEN_CACHE.delete(TOKEN_KV_KEY);
      const token = await getAccessToken(env);
      return jsonResponse({ success: true, token_preview: token.substring(0, 8) + '...' }, 200, cors);
    } catch (error) {
      return jsonResponse({ error: error.message }, 500, cors);
    }
  }

  return jsonResponse({ error: 'Not found' }, 404, cors);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};
