# Hosting the Torrentio filter on Cloudflare Workers

> Status (2026-10-22): blocked. Torrentio's firewall answers Workers with 403 "Attention Required! | Cloudflare".
> The filter now runs locally on each Mac instead (README.md). Earlier status: ported. `worker.mjs` + `filter.mjs` replace `server.mjs`; deploy steps are in README.md.
> Decision: share one TorBox key, held as a Worker secret, with no password: install URLs without a key use it (see Risks, item 3).

Goal: run the filter 24/7 on a free, always-on host with HTTPS, so a friend can use it
without installing Node, and without my laptop being switched on.

## Why Workers
- Free, always on, no sleeping, HTTPS included (`<name>.<account>.workers.dev`).
- Free plan: 100,000 requests/day, 50 subrequests per request, 10 ms CPU per request.
- The add-on only serves streams (no catalog), so Stremio calls it once per title page opened.
  A few hundred requests per day at most, far below the limit.
- Each stream request makes about 3-5 outgoing calls (1 to Torrentio + TorBox file-count
  calls, batched 40 hashes at a time), well under the 50 limit.

## Risks to check first
1. **Torrentio may block Cloudflare / cloud IPs** (403 or captcha). This is the biggest unknown.
   Run Step 1 before doing any porting work.
2. **10 ms CPU limit.** Waiting on network does not count, but parsing and filtering the JSON does.
   Should fit, but not guaranteed. If it fails, the paid Workers plan (about $5/month) has much more.
3. **TorBox terms.** The Terms of Service (updated July 31, 2026) say not to share the account or
   API key without written permission, while the help center article (April 2026) says sharing is
   fine. Safest: the friend uses their own TorBox key, or ask TorBox support for written permission.
   Decision: share one key anyway, accepting the risk that TorBox revokes it. The key is a Worker
   secret (not in the code or repo), there are no access codes (kept simple on purpose), and the key never reaches
   Stremio (the Worker follows the resolve redirects itself).

## Step 1: 10-minute test (is Torrentio reachable from Workers?)
Make a new empty folder with these two files.

`wrangler.toml`
```toml
name = "torrentio-test"
main = "index.js"
compatibility_date = "2026-10-01"
```

`index.js`
```js
export default {
  async fetch() {
    const r = await fetch('https://torrentio.strem.fun/manifest.json')
    return new Response(`Torrentio status: ${r.status}`)
  },
}
```

Run:
```
npx wrangler login
npx wrangler deploy
```
Open the printed `*.workers.dev` URL.
- `Torrentio status: 200` -> go to Step 2.
- `403` or a captcha -> Workers is blocked. Fall back to a cheap VPS ($2-5/month, e.g. Fly.io,
  Railway Hobby, Hetzner). Test it first with `curl -I https://torrentio.strem.fun/manifest.json`
  on that host.

## Step 2: Port `server.mjs` to a Worker
The filtering logic (`tooBig`, `looksLikeBatch`, `hashOf`, `fileIdxOf`, `parseFileCounts`,
`fileCounts`, `redact`) stays the same. Only the server wrapper changes.

- Replace `http.createServer(...)` and `server.listen(...)` with
  `export default { async fetch(request, env) { ... } }`.
- Read the path from `new URL(request.url).pathname`.
- Return `new Response(body, { status, headers })` instead of `res.writeHead` / `res.end`.
  Keep the CORS headers.
- Replace `process.env.X` with constants, or with `env.X` set under `[vars]` in `wrangler.toml`
  (MAX_FILES, HEURISTICS, UPSTREAM).
- Remove the `node:http` and `node:url` imports and the "run directly" block at the bottom.
- The in-memory `countCache` still works, but only per running instance, so a few extra TorBox
  lookups are fine.
- Update `test.mjs` / `integration.test.mjs`. The integration test probably imports `server`
  and listens on a port, so it needs to call the Worker's `fetch` instead.

## Step 3: Deploy
`wrangler.toml`
```toml
name = "torrentio-filter"
main = "worker.mjs"
compatibility_date = "2026-10-01"
```
```
npx wrangler deploy
```
You get `https://torrentio-filter.<account>.workers.dev`. Optional: attach a custom domain from
the Cloudflare dashboard.

**Do not turn on Workers logging/observability for request URLs.** The Torrentio config,
including the TorBox key, is in the URL path. Keep the `redact()` calls on error logs.

## Step 4: Test end to end
1. Open `https://torrentio-filter.<account>.workers.dev/` (the landing page).
2. Paste my Torrentio install link, copy the URL it shows, add it in Stremio under Addons.
3. Remove the original Torrentio add-on so results are not listed twice.
4. Open a big-batch show. Torrents with more than 100 files should be gone.
5. Check the dashboard for CPU time per request. Under 10 ms is good.

## Step 5: Share with the friend
1. Friend gets their own TorBox key (see Risks, item 3).
2. Friend configures Torrentio at torrentio.strem.fun/configure with their key and copies the link.
3. Friend pastes it into the landing page of the hosted Worker, copies the URL it shows,
   and adds it in Stremio.

## Before sharing anything
My TorBox API key was pasted in a chat. Regenerate it in TorBox settings and update my add-on URL.

## Sources
- Torrentio blocking server IP ranges: https://github.com/Viren070/AIOStreams/wiki/Deployment
- Torrentio 403 issue: https://github.com/TheBeastLT/torrentio-scraper/issues/339
- Workers limits: https://developers.cloudflare.com/workers/platform/limits
- TorBox IP/sharing help article: https://support.torbox.app/en/articles/9836406-can-i-use-my-account-with-many-different-ip-s
- TorBox plan limits: https://support.torbox.app/en/articles/9836418-account-restrictions
- TorBox feedback thread on simultaneous connections: https://torbox.featurebase.app/p/clear-limit-on-simultaneous-connections
- Free tier comparison: https://flaviocopes.com/hosting-free-tiers/
