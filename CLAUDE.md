# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Plain Node ES modules (Node >= 18), no dependencies, no build or lint step.

    npm test                                         all tests (node --test: test.mjs + integration.test.mjs)
    node --test test.mjs                             one file
    node --test --test-name-pattern="year ranges"    one test by name
    TORBOX_KEY=... node server.mjs                   run in the foreground on 127.0.0.1:7171

## Architecture

A local Stremio add-on that proxies Torrentio and drops streams from torrents with too many files
(TorBox zips those, so they can't be played). It runs on the user's Mac, not a hosted server:
Torrentio's firewall blocks cloud hosts (Cloudflare Workers got 403s).

- `filter.mjs` is pure logic: `tooBig` decides per stream. An exact file count from TorBox wins when
  known (a lone archive file, or "1 file" on a batch-looking name, means TorBox zipped it); otherwise
  it falls back to `fileIdx` and name heuristics (episode ranges, words like Batch/Complete, with
  years excluded). `torrentioConfig` builds the upstream Torrentio config: the user's pasted options,
  plus `sizefilter`/`language` unless they set their own, with any debrid key replaced by `torbox=<key>`.
- `addon.mjs` is a Workers-style `{ fetch(request, env) }` handler. Settings are parsed from `env`
  on every request (`settings()`), so defaults like MAX_SIZE/LANGUAGE live there. Routes: `/`
  (status page, an inline HTML string at the bottom of the file), `/health`, `/stats`,
  `[/<config>]/manifest.json`, `[/<config>]/stream/<type>/<id>.json`. Errors are logged and answered
  with `200 { streams: [] }` so Stremio doesn't break. TorBox file counts are cached in memory
  (24h TTL, bounded size) because the process runs for months.
- `server.mjs` adapts the fetch handler to `node:http` and reads `config.env` next to itself.
  `createServer(env)` is what the integration tests use.
- `cli.mjs` is the `torrentio-filter` command. `setup` copies only `server.mjs`, `addon.mjs` and
  `filter.mjs` (the `FILES` list) to `~/Library/Application Support/TorrentioFilter/`, writes
  `config.env` there (TORBOX_KEY, PORT, optional MAX_FILES, HEURISTICS, CACHED_ONLY, MAX_SIZE, LANGUAGE), and
  registers a launchd agent (`local.torrentio-filter`) that starts Node by its full path. Code
  changes reach the running service only after `torrentio-filter setup` again; config changes
  need `torrentio-filter restart`. A new runtime file must be added to `FILES`.

## Conventions

- Never log or expose debrid keys: pass log text through `redact()`. The key is kept out of the
  Stremio install link; the server listens on 127.0.0.1 only.
- `integration.test.mjs` runs the real server against fake Torrentio and TorBox servers (no
  network). It turns MAX_SIZE and LANGUAGE `off` by default; tests for the defaults set them to
  `undefined`.
- The add-on version appears in both `package.json` and the manifest in `addon.mjs`.
- When a default changes (size limit, language, max files), update the README and the status-page
  hint text in `addon.mjs` too.
- `terms.txt` (TorBox terms of service) is git-ignored reference material.
