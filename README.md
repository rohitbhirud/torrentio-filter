# Torrentio filter

Stremio addon that sits in front of Torrentio and hides torrents with more than 100 files
(TorBox zips those, so Torrentio can't play them). Runs on Cloudflare Workers (free plan).

## Two ways to use it
- **Shared key:** the Worker holds one TorBox API key as an encrypted Cloudflare secret. Each person
  gets their own access code and puts that in their install URL instead of the key. The key never
  reaches Stremio: play links go through the Worker, which follows Torrentio's and TorBox's
  redirects itself and hands the player only the final CDN link.
- **Own key:** anyone can paste their own TorBox key on the landing page. That key lives only in
  their install URL, like plain Torrentio. The Worker never stores it.

The key is never in the code or the repo. Secrets are encrypted by Cloudflare, can't be read back
from the dashboard, and are only visible to the running Worker.

## Deploy (once)
    npm install
    npx wrangler login                          # opens the browser, sign in to Cloudflare
    npm run deploy                              # prints https://torrentio-filter.<you>.workers.dev
    npx wrangler secret put TORBOX_KEY          # paste the TorBox API key when asked

Then check `https://torrentio-filter.<you>.workers.dev/health`. `"torrentio": 200` means Torrentio
answers Cloudflare's servers. A 403 means Torrentio blocks them, and Workers won't work for this.

## Access codes
One secret per person, so you can revoke one without changing the others:

    npm run new-code                            # prints a random code
    npx wrangler secret put ACCESS_CODE_ROHIT   # paste your code
    npx wrangler secret put ACCESS_CODE_FRIEND  # paste a different code; send it to your friend privately

Revoke: `npx wrangler secret delete ACCESS_CODE_FRIEND`. Their addon stops working at once.
If the TorBox key itself leaks, regenerate it in TorBox and run `wrangler secret put TORBOX_KEY` again.
Nobody needs to reinstall.

## Install in Stremio
1. Open `https://torrentio-filter.<you>.workers.dev/`.
2. Optional: paste a Torrentio install link (torrentio.strem.fun/configure, "Copy Link") to keep its
   sort and quality settings. Configure it without a debrid key; any key in it is replaced.
3. Enter your access code (or your own TorBox key).
4. Click "Install in Stremio", or paste the URL it shows into Stremio, under Addons.
5. Uninstall the original Torrentio so results are not listed twice.

## How it filters
1. With a TorBox key, it asks TorBox for the real file count of each cached torrent
   (GET /v1/api/torrents/checkcached?list_files=true) and drops anything over MAX_FILES. Exact.
2. For torrents TorBox doesn't know (or if the lookup fails) it falls back to guesses:
   - fileIdx >= MAX_FILES means more than MAX_FILES files.
   - Episode ranges in the name wider than MAX_FILES (001-574), or words like Batch/Complete/Extras with no range.
   - HEURISTICS=0 turns off the name rules and keeps only the fileIdx rule.

MAX_FILES and HEURISTICS are set under `vars` in `wrangler.jsonc`.

## Local run and tests
    npm test                                    # unit tests plus end to end against fake Torrentio and TorBox servers
    npm run dev                                 # http://127.0.0.1:8787, reads secrets from .dev.vars (gitignored)

Request logging (Workers observability) is off on purpose: own-key install URLs contain the key.
