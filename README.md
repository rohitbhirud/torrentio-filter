# 🧲 Torrentio Filter

A Stremio add-on that sits in front of Torrentio and hides torrents with more than 100 files.
TorBox zips those giant batches, so Torrentio can't play them and they only clutter the list.
It runs quietly on your Mac and starts by itself when you log in.

## Install (2 minutes)
You need Node 18 or newer (`node -v`; if missing: `brew install node`) and a TorBox API key.

    git clone https://github.com/rohitbhirud/torrentio-filter.git
    cd torrentio-filter
    npm install -g .
    torrentio-filter setup

`setup` asks for the TorBox key (typing is hidden), checks it with TorBox, starts the filter,
sets it to start at every login, and opens its status page.

Then click **Install in Stremio** on that page, and **Install** in the window Stremio shows.
(Or in Stremio: **Add-ons** → paste `http://127.0.0.1:7171/manifest.json` into the search box.)
Uninstall the original Torrentio so results don't show up twice.

There's no Torrentio link to enter: Torrentio is built in, with its default settings.

## Everyday commands
    torrentio-filter status      is it running, does Torrentio answer, does the key work
    torrentio-filter open        open the status page (http://127.0.0.1:7171)
    torrentio-filter key         change the TorBox key (nothing to change in Stremio)
    torrentio-filter logs        follow the log
    torrentio-filter restart     restart it
    torrentio-filter uninstall   remove it, including the saved key

Update to new code: `git pull && torrentio-filter setup` (it keeps your key and port).

The status page shows whether Torrentio and TorBox are answering, what you've looked up recently,
and how many giant batches it has hidden. Optional: if you changed sorting or quality filters on
Torrentio's configure page, paste its install link under **Optional: your own Torrentio settings**,
then click Install again.

## Where things live
- Code it runs: `~/Library/Application Support/TorrentioFilter/` (copied there by `setup`, so the
  clone can move or be deleted)
- Key and port: `config.env` in that folder, readable only by your user
- Login service: `~/Library/LaunchAgents/local.torrentio-filter.plist`
- Log: `~/Library/Logs/TorrentioFilter.log`

The service starts Node by its full path. If you remove that Node version later (nvm, Homebrew
upgrade), run `torrentio-filter setup` again.

The key isn't in the Stremio install link, so it doesn't sync to your Stremio account. Play links
come from Torrentio and carry the key, the same as with plain Torrentio. The filter listens on
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
    npm test                     unit tests plus end to end through the server, against fake Torrentio and TorBox
    TORBOX_KEY=... node server.mjs   run in the foreground

- `filter.mjs`: the rules that decide what's too big
- `addon.mjs`: the Stremio add-on and the status page
- `server.mjs`: serves it on 127.0.0.1
- `cli.mjs`: the `torrentio-filter` command

Why not a hosted server: Torrentio's firewall blocks cloud hosts. Cloudflare Workers got
403 "Attention Required" while a home connection gets 200, so each person runs their own copy.
