# 🧲 Torrentio Filter

A Stremio add-on that sits in front of Torrentio and hides torrents with more than 100 files.
TorBox zips those giant batches, so Torrentio can't play them and they only clutter the list.
It runs quietly on your Mac and starts by itself when you log in.

## Install (2 minutes)
You need Node 18 or newer (`node -v`; if missing: `brew install node`) and a TorBox API key.

    git clone git@github.com:rohitbhirud/torrentio-filter.git
    cd torrentio-filter
    npm install -g .
    torrentio-filter setup

`setup` asks for the TorBox key (typing is hidden), checks it with TorBox, starts the filter,
sets it to start at every login, and opens its status page.

Then in Stremio: **Add-ons** → paste `http://127.0.0.1:7171/manifest.json` into the search box →
**Install**. Uninstall the original Torrentio so results don't show up twice.

## Everyday commands
    torrentio-filter status      is it running, does Torrentio answer, does the key work
    torrentio-filter open        open the status page (http://127.0.0.1:7171)
    torrentio-filter key         change the TorBox key (nothing to change in Stremio)
    torrentio-filter logs        follow the log
    torrentio-filter restart     restart it
    torrentio-filter uninstall   remove it, including the saved key

Update to new code: `git pull && torrentio-filter setup` (it keeps your key and port).

The status page shows whether Torrentio and TorBox are answering, what you've looked up recently,
and how many giant batches it has hidden. Under **Settings** you can paste a Torrentio install link
to keep its sort and quality options. Copy the link again afterwards and reinstall in Stremio.

## Where things live
- Code it runs: `~/Library/Application Support/TorrentioFilter/` (copied there by `setup`, so the
  clone can move or be deleted)
- Key and port: `config.env` in that folder, readable only by your user
- Login service: `~/Library/LaunchAgents/local.torrentio-filter.plist`
- Log: `~/Library/Logs/TorrentioFilter.log`

The service starts Node by its full path. If you remove that Node version later (nvm, Homebrew
upgrade), run `torrentio-filter setup` again.

The key never reaches Stremio. Play links point at the filter, which follows Torrentio's and
TorBox's redirects itself and hands the player only the final video link. The filter listens on
127.0.0.1 only, so other devices on your network can't use it.

Port 7171 is taken? `torrentio-filter setup --port 7272`, then use that port in the Stremio link.

## How it filters
1. With a TorBox key, it asks TorBox for the real file count of each cached torrent
   (GET /v1/api/torrents/checkcached?list_files=true) and drops anything over MAX_FILES. Exact.
2. For torrents TorBox doesn't know (or if the lookup fails) it falls back to guesses:
   - fileIdx >= MAX_FILES means more than MAX_FILES files.
   - Episode ranges in the name wider than MAX_FILES (001-574), or words like Batch/Complete/Extras with no range.
   - HEURISTICS=0 turns off the name rules and keeps only the fileIdx rule.

MAX_FILES and HEURISTICS can be added to `config.env`, then `torrentio-filter restart`.

## Development
    npm test                     unit tests plus end to end against fake Torrentio, TorBox and CDN servers
    node cli.mjs run             run in the foreground

`worker.mjs` is a plain fetch handler: `server.mjs` runs it on Node, and `wrangler.jsonc` deploys
it to Cloudflare Workers. Workers doesn't work for this today: Torrentio's firewall blocks
Cloudflare's servers (`/health` shows `"torrentio": 403`). See CLOUDFLARE-WORKERS-PLAN.md.
