# IGDB API Relay (Cloudflare Worker)

A Cloudflare Worker that relays requests to the IGDB API, handling Twitch OAuth token management automatically. Designed for servers in China where `id.twitch.tv` is blocked.

## How It Works

```
Your App (China) → Cloudflare Worker (global edge) → IGDB API + Twitch OAuth
```

- The worker handles the Twitch `client_credentials` OAuth flow
- Tokens are cached in Cloudflare KV (auto-refreshed before expiry)
- All IGDB API endpoints are proxied transparently
- Your app only needs to send the Apicalypse query body

## Setup

### 1. Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- Twitch Developer credentials ([get them here](https://dev.twitch.tv/console/apps))

### 2. Install Dependencies

```bash
cd igdb-relay
npm install
```

### 3. Create KV Namespace

```bash
wrangler kv namespace create TOKEN_CACHE
```

Copy the output `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TOKEN_CACHE"
id = "your-namespace-id-here"
```

### 4. Set Secrets

```bash
wrangler secret put TWITCH_CLIENT_ID
wrangler secret put TWITCH_CLIENT_SECRET
wrangler secret put API_KEY
```

- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` — from your Twitch Developer Console
- `API_KEY` — any random string you generate; your app sends this to authenticate with the relay

### 5. (Optional) Configure CORS Origins

Set the `ALLOWED_ORIGINS` environment variable in `wrangler.toml` if you want to restrict which domains can call the relay:

```toml
[vars]
ALLOWED_ORIGINS = "https://rgm.games,https://yourdomain.com"
```

If not set, defaults to `*` (allow all origins).

### 6. Deploy

```bash
wrangler deploy
```

Your worker will be available at `https://igdb-relay.<your-subdomain>.workers.dev`.

## API Usage

### Proxy IGDB Endpoint

All IGDB endpoints are available under `/v4/{endpoint}`.

```bash
# Search for games
curl -X POST https://igdb-relay.your-subdomain.workers.dev/v4/games \
  -H "X-API-Key: your-api-key" \
  -d 'search "Halo"; fields name,cover,platforms,first_release_date,summary; limit 10;'

# Get game covers
curl -X POST https://igdb-relay.your-subdomain.workers.dev/v4/covers \
  -H "X-API-Key: your-api-key" \
  -d 'fields url,image_id,width,height; where game = 1942;'

# Get screenshots
curl -X POST https://igdb-relay.your-subdomain.workers.dev/v4/screenshots \
  -H "X-API-Key: your-api-key" \
  -d 'fields url,image_id,width,height; where game = 1942; limit 5;'

# Get platforms
curl -X POST https://igdb-relay.your-subdomain.workers.dev/v4/platforms \
  -H "X-API-Key: your-api-key" \
  -d 'fields name,abbreviation; limit 50;'

# Multi-query
curl -X POST https://igdb-relay.your-subdomain.workers.dev/v4/multiquery \
  -H "X-API-Key: your-api-key" \
  -d 'query games "Search" { search "Mario"; fields name,cover; limit 5; };'
```

### Debug Endpoints

```bash
# Health check
curl https://igdb-relay.your-subdomain.workers.dev/health

# Token status
curl https://igdb-relay.your-subdomain.workers.dev/token/status \
  -H "X-API-Key: your-api-key"

# Force token refresh
curl https://igdb-relay.your-subdomain.workers.dev/token/refresh \
  -H "X-API-Key: your-api-key"
```

## Using from Your App

Replace your direct IGDB calls with calls to the relay. Example:

```typescript
const RELAY_URL = 'https://igdb-relay.your-subdomain.workers.dev';
const API_KEY = 'your-api-key';

async function searchGames(query: string) {
  const response = await fetch(`${RELAY_URL}/v4/games`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: `search "${query}"; fields name,cover.url,platforms.name,first_release_date,summary,screenshots.url; limit 10;`,
  });
  return response.json();
}
```

## IGDB Image URLs

IGDB returns image IDs. Construct full URLs like:

```
https://images.igdb.com/igdb/image/upload/t_{size}/{image_id}.jpg
```

Sizes: `thumb`, `cover_small`, `cover_big`, `screenshot_med`, `screenshot_big`, `screenshot_huge`, `720p`, `1080p`

Example: `https://images.igdb.com/igdb/image/upload/t_cover_big/co1wyy.jpg`

## Rate Limits

IGDB allows **4 requests/second** with up to 8 concurrent open requests. The relay does not add its own rate limiting — respect IGDB's limits from your app side.

## Local Development

```bash
# Create a .dev.vars file with your secrets
echo 'TWITCH_CLIENT_ID=your_id' >> .dev.vars
echo 'TWITCH_CLIENT_SECRET=your_secret' >> .dev.vars
echo 'API_KEY=test_key' >> .dev.vars

# Run locally
npm run dev
```

For local dev, wrangler simulates KV automatically.
