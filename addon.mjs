// Stremio add-on: forwards stream requests to Torrentio and drops results that come from huge
// torrents. A plain fetch handler; server.mjs serves it on 127.0.0.1.
//
// Install URL: /manifest.json, or /<torrentio config>/manifest.json to keep Torrentio's sort and
// quality options. Any debrid key in the config is replaced by TORBOX_KEY from config.env, and
// Torrentio is asked for files up to MAX_SIZE with LANGUAGE results first, unless the config says otherwise.
import { tooBig, hashOf, parseFileCounts, redact, torrentioConfig, checkTorboxKey } from './filter.mjs'

const TIMEOUT_MS = 20000
const COUNT_TTL_MS = 24 * 3600 * 1000
const COUNT_CACHE_MAX = 20000
const countCache = new Map() // hash -> { count, at }, oldest first
const stats = { since: Date.now(), lookups: 0, found: 0, hidden: 0, recent: [] } // for the status page

// A setting passed on to Torrentio: the fallback when unset or invalid, null when "off".
function option(value, fallback, valid) {
  const v = String(value ?? fallback).replace(/\s/g, '')
  if (!v || /^(off|0)$/i.test(v)) return null
  return valid.test(v) ? v : fallback
}

function settings(env) {
  const maxFiles = Number(env.MAX_FILES)
  return {
    upstream: (env.UPSTREAM ?? 'https://torrentio.strem.fun').replace(/\/$/, ''),
    torbox: (env.TORBOX_API ?? 'https://api.torbox.app').replace(/\/$/, ''),
    key: env.TORBOX_KEY || null,
    maxFiles: Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : 100,
    heuristics: env.HEURISTICS !== '0',
    maxSize: option(env.MAX_SIZE, '10GB', /^\d+(\.\d+)?(MB|GB|TB)$/i)?.toUpperCase() ?? null,
    language: option(env.LANGUAGE, 'hindi', /^[a-z]+(,[a-z]+)*$/i)?.toLowerCase() ?? null,
  }
}

const manifest = (opts) => ({
  id: 'local.torrentio.filtered',
  version: '0.4.0',
  name: `Torrentio (max ${opts.maxFiles} files)`,
  description: `Torrentio results, minus torrents with more than ${opts.maxFiles} files`
    + (opts.maxSize ? ` and files over ${opts.maxSize}` : '')
    + (opts.language ? `, ${opts.language} first.` : '.'),
  catalogs: [],
  resources: [{ name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu'] }],
  types: ['movie', 'series', 'anime', 'other'],
  behaviorHints: { configurable: false, configurationRequired: false },
})

async function fileCounts(hashes, opts) {
  const now = Date.now()
  const fresh = (h) => countCache.get(h) && now - countCache.get(h).at < COUNT_TTL_MS
  const need = [...new Set(hashes)].filter((h) => !fresh(h))
  for (let i = 0; i < need.length; i += 40) {
    const params = new URLSearchParams({ format: 'object', list_files: 'true' })
    need.slice(i, i + 40).forEach((h) => params.append('hash', h))
    try {
      const r = await fetch(`${opts.torbox}/v1/api/torrents/checkcached?${params}`, {
        headers: { Authorization: `Bearer ${opts.key}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) throw new Error(`TorBox ${r.status}`)
      for (const [h, count] of parseFileCounts(await r.json())) {
        countCache.delete(h) // re-insert so the Map stays ordered oldest first
        countCache.set(h, { count, at: now })
      }
    } catch (e) {
      console.error('file count lookup failed:', redact(String(e.message)))
      break
    }
  }
  const out = new Map(hashes.filter(fresh).map((h) => [h, countCache.get(h).count]))
  // The server runs for months, so keep the cache bounded: drop the oldest entries.
  for (const h of countCache.keys()) {
    if (countCache.size <= COUNT_CACHE_MAX) break
    countCache.delete(h)
  }
  return out
}

async function handleStream(opts, config, type, id) {
  const upstreamConfig = torrentioConfig(config, opts)
  const r = await fetch(`${opts.upstream}${upstreamConfig ? `/${upstreamConfig}` : ''}/stream/${type}/${id}.json`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`upstream ${r.status}`)
  const body = await r.json()
  const streams = body.streams ?? []
  const counts = opts.key ? await fileCounts(streams.map(hashOf).filter(Boolean), opts) : new Map()
  const kept = streams.filter((s) => !tooBig(s, counts, opts))
  const hidden = streams.length - kept.length
  const name = decodeURIComponent(id)
  stats.lookups++
  stats.found += streams.length
  stats.hidden += hidden
  stats.recent = [{ at: Date.now(), type, id: name, found: streams.length, hidden }, ...stats.recent].slice(0, 8)
  console.log(`${type}/${name}: ${streams.length} from upstream, exact file count for ${counts.size}, ${hidden} dropped, ${kept.length} kept`)
  return send(200, { ...body, streams: kept })
}

async function health(opts) {
  const [torrentio, torbox] = await Promise.all([
    fetch(`${opts.upstream}/manifest.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.status, (e) => String(e.message)),
    checkTorboxKey(opts.key, opts.torbox),
  ])
  return send(200, { torrentio, torbox })
}

function send(status, body, type = 'application/json') {
  return new Response(typeof body === 'string' ? body || null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
  })
}

export default {
  async fetch(request, env) {
    const opts = settings(env)
    const { pathname } = new URL(request.url)
    try {
      if (request.method === 'OPTIONS') return send(204, '')
      if (pathname === '/') return send(200, landing, 'text/html; charset=utf-8')
      if (pathname === '/health') return await health(opts)
      if (pathname === '/stats') return send(200, stats)
      if (/^\/(?:[^/]+\/)?manifest\.json$/.test(pathname)) return send(200, manifest(opts))
      const m = /^\/(?:([^/]+)\/)?stream\/([^/]+)\/([^/]+?)(?:\.json)?$/.exec(pathname)
      if (m) return await handleStream(opts, m[1], m[2], m[3])
      return send(404, { error: 'not found' })
    } catch (e) {
      console.error('error:', redact(String(e.message)))
      return send(200, { streams: [] })
    }
  },
}

// Status page. Builds the install link in the browser; titles and posters for the recent list
// come from Stremio's Cinemeta and Kitsu add-ons.
const landing = String.raw`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Torrentio Filter</title>
<style>
:root{--bg:#f5f4fa;--card:#fff;--text:#1d1b26;--muted:#6b6880;--line:#e5e2ef;--accent:#6d4aff;--accent-ink:#fff;
--ok:#167045;--ok-bg:#e1f5ea;--bad:#b42318;--bad-bg:#fde8e7;--wait:#7a5f00;--wait-bg:#fff3c4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121118;--card:#1b1a24;--text:#ecebf3;--muted:#9c99b0;--line:#2c2a3a;--accent:#9077ff;
--ok:#63d39c;--ok-bg:#15301f;--bad:#ff8f86;--bad-bg:#3a1714;--wait:#f0cf5a;--wait-bg:#332a0b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
header{display:flex;gap:14px;align-items:center;margin-bottom:8px}.logo{font-size:44px;line-height:1}
h1{margin:0;font-size:28px;letter-spacing:-.02em}h2{margin:0 0 12px;font-size:18px}.tag{margin:0;color:var(--muted)}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 24px}
.pill{padding:4px 12px;border-radius:999px;font-size:14px;font-weight:600;background:var(--wait-bg);color:var(--wait)}
.pill::before{content:"● "}.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.urlrow{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
.urlrow code{flex:1 1 280px;min-width:0;padding:10px 12px;border-radius:10px;background:var(--bg);border:1px solid var(--line);word-break:break-all;font-size:14px}
button{border:0;border-radius:10px;padding:10px 18px;font:600 15px system-ui;background:var(--accent);color:var(--accent-ink);cursor:pointer}
button:active,.install:active{transform:scale(.97)}
.install{display:block;text-align:center;text-decoration:none;border-radius:12px;padding:14px 18px;font:700 17px system-ui;background:var(--accent);color:var(--accent-ink);margin-bottom:12px}
.urlrow button{background:var(--bg);color:var(--text);border:1px solid var(--line)}ol{margin:16px 0 0;padding-left:22px}li{margin:4px 0}.hint{color:var(--muted);font-size:14px;margin:10px 0 0}
details summary{cursor:pointer;font-weight:600}label{display:block;font-weight:600;font-size:14px;margin:14px 0 4px}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:15px system-ui}
.nums{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.num{background:var(--bg);border-radius:12px;padding:12px;text-align:center}.num b{display:block;font-size:26px;letter-spacing:-.02em}
.num span{color:var(--muted);font-size:13px}.recent{list-style:none;margin:0;padding:0}
.recent li{display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.recent img,.recent .ph{width:40px;height:60px;border-radius:6px;object-fit:cover;background:var(--bg);flex:none}
.recent .t{font-weight:600}.recent .m{color:var(--muted);font-size:14px}footer{color:var(--muted);font-size:14px;text-align:center;margin-top:24px}
footer code{font-size:13px}
</style>
<main>
<header><div class=logo>🧲</div><div><h1>Torrentio Filter</h1>
<p class=tag>Torrentio, minus the giant batch torrents TorBox can't play.</p></div></header>
<div class=pills><span id=s-server class="pill ok">Filter running</span><span id=s-torrentio class=pill>Checking Torrentio…</span><span id=s-torbox class=pill>Checking TorBox…</span></div>

<section class=card><h2>Add it to Stremio</h2>
<a id=install class=install href="#">Install in Stremio</a>
<ol><li>Click <b>Install in Stremio</b>, then <b>Install</b> in the window Stremio shows.</li>
<li>Uninstall the original Torrentio, so results don't show up twice.</li></ol>
<p class=hint>Stremio didn't open? Copy the link, then in Stremio go to Add-ons and paste it into the search box.</p>
<div class=urlrow><code id=out>&nbsp;</code><button id=copy>Copy link</button></div>
<p id=hint class=hint></p>
<details><summary>Optional: your own Torrentio settings</summary>
<p class=hint>Not needed. Torrentio is built in and uses its default settings, plus a size limit and a priority
language (10GB and Hindi unless config.env says otherwise). Only if you changed sorting or
quality filters on Torrentio's configure page, paste its install link here, then click Install again.</p>
<label for=link>Torrentio install link</label>
<input id=link placeholder="stremio://torrentio.strem.fun/.../manifest.json">
</details></section>

<section id=stats class=card hidden><h2>What it's been up to</h2>
<div class=nums><div class=num><b id=n-lookups>0</b><span>lookups</span></div>
<div class=num><b id=n-found>0</b><span>results checked</span></div>
<div class=num><b id=n-hidden>0</b><span>giant batches hidden</span></div></div>
<ul id=recent class=recent></ul><p id=since class=hint></p></section>

<footer>Starts on its own when you log in. In Terminal:
<code>torrentio-filter status</code> · <code>logs</code> · <code>key</code> · <code>uninstall</code></footer>
</main>
<script>
const $ = (id) => document.getElementById(id)
const DEBRID = /^(torbox|realdebrid|alldebrid|premiumize|debridlink|easydebrid|offcloud|putio)=/i
function pill(id, cls, text) { $(id).className = 'pill ' + cls; $(id).textContent = text }

function update() {
  const m = /torrentio\.strem\.fun\/(?:(.+)\/)?manifest\.json/.exec($('link').value)
  let parts = []
  // The key in a pasted link is dropped: the server adds the one from setup.
  try { parts = m && m[1] ? decodeURIComponent(m[1]).split('|').filter((p) => p && !DEBRID.test(p)) : [] } catch {}
  const url = location.origin + (parts.length ? '/' + encodeURIComponent(parts.join('|')) : '') + '/manifest.json'
  $('out').textContent = url
  // stremio://host/... links always become https, so use the form that opens the install window with this exact URL.
  $('install').href = 'stremio:///addons?addon=' + encodeURIComponent(url)
}
$('link').oninput = update
update()

$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('out').textContent) } catch { getSelection().selectAllChildren($('out')); return }
  $('copy').textContent = 'Copied ✓'
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1800)
}

fetch('/health').then((r) => r.json()).then((h) => {
  pill('s-torrentio', h.torrentio === 200 ? 'ok' : 'bad', h.torrentio === 200 ? 'Torrentio reachable' : 'Torrentio not answering (' + h.torrentio + ')')
  const tb = { ok: ['ok', 'TorBox key works'], invalid: ['bad', 'TorBox key rejected'], 'not set': ['bad', 'No TorBox key'] }[h.torbox] || ['', 'TorBox not answering']
  pill('s-torbox', tb[0], tb[1])
  if (h.torbox === 'invalid' || h.torbox === 'not set') $('hint').textContent = 'Results won\'t play until a working key is set. In Terminal: torrentio-filter key'
}).catch(() => {
  pill('s-server', 'bad', 'Filter not answering')
  pill('s-torrentio', '', 'Torrentio unknown')
  pill('s-torbox', '', 'TorBox unknown')
})

const names = new Map()
// Name and poster: Cinemeta for IMDb ids, Stremio's Kitsu add-on for anime.
function nameOf(type, id) {
  const p = id.split(':')
  const url = p[0] === 'kitsu' ? 'https://anime-kitsu.strem.fun/meta/anime/kitsu:' + p[1] + '.json'
    : /^tt\d+$/.test(p[0]) ? 'https://v3-cinemeta.strem.io/meta/' + (type === 'movie' ? 'movie' : 'series') + '/' + p[0] + '.json'
    : null
  if (!url) return Promise.resolve({})
  if (!names.has(url)) names.set(url, fetch(url).then((r) => r.json()).then((j) => j.meta || {}).catch(() => ({})))
  return names.get(url)
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'
}
// Ids are tt123 (movie), tt123:season:episode (series) or kitsu:123:episode (anime).
function episodeOf(id) {
  const p = id.split(':')
  if (p[0] === 'kitsu') return p[2] ? ' · Episode ' + p[2] : ''
  return p[2] ? ' · S' + p[1] + 'E' + p[2] : ''
}
let shown = ''
async function loadStats() {
  const r = await fetch('/stats').catch(() => null)
  if (!r || !r.ok) return
  const st = await r.json()
  $('stats').hidden = false
  // Re-render only when something changed, so posters don't flicker. Minutes keep the "ago" text fresh.
  const sig = JSON.stringify(st) + Math.floor(Date.now() / 60000)
  if (sig === shown) return
  shown = sig
  $('n-lookups').textContent = st.lookups
  $('n-found').textContent = st.found
  $('n-hidden').textContent = st.hidden
  $('since').textContent = 'Since ' + new Date(st.since).toLocaleString() + (st.recent.length ? '' : '. Open something in Stremio and it shows up here.')
  const items = await Promise.all(st.recent.map(async (x) => {
    const meta = await nameOf(x.type, x.id)
    const li = document.createElement('li')
    const img = document.createElement(meta.poster ? 'img' : 'div')
    if (meta.poster) { img.src = meta.poster; img.alt = ''; img.loading = 'lazy' } else img.className = 'ph'
    const text = document.createElement('div')
    const t = document.createElement('div'); t.className = 't'
    t.textContent = (meta.name || x.id) + episodeOf(x.id)
    const m = document.createElement('div'); m.className = 'm'
    m.textContent = x.found + ' found · ' + x.hidden + ' hidden · ' + ago(x.at)
    text.append(t, m); li.append(img, text)
    return li
  }))
  $('recent').replaceChildren(...items)
}
loadStats()
setInterval(loadStats, 15000)
</script>`
