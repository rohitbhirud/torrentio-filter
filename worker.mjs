// Stremio wrapper addon: forwards stream requests to Torrentio and drops results that come from
// huge torrents. Written as a fetch handler, so it runs both locally (server.mjs) and on Workers.
// Two ways to install it:
//
//   Shared key:  /manifest.json, or /<torrentio config without a debrid key>/manifest.json
//                The server adds TORBOX_KEY. The key never reaches Stremio:
//                play links are rewritten to go through /resolve below.
//   Own key:     /<torrentio config with torbox=KEY>/manifest.json
//                The key lives only in that install URL, never on the server.
import { tooBig, hashOf, torboxKeyOf, parseFileCounts, redact, hasOwnKey, withSharedKey, checkTorboxKey } from './filter.mjs'

const TIMEOUT_MS = 20000
const COUNT_TTL_MS = 24 * 3600 * 1000
const countCache = new Map() // hash -> { count, at }; per isolate, so a few repeat lookups are fine
// What the status page shows. Only served when LOCAL=1, since it lists what was watched.
const stats = { since: Date.now(), lookups: 0, found: 0, hidden: 0, recent: [] }

function settings(env) {
  return {
    upstream: (env.UPSTREAM ?? 'https://torrentio.strem.fun').replace(/\/$/, ''),
    torbox: (env.TORBOX_API ?? 'https://api.torbox.app').replace(/\/$/, ''),
    maxFiles: Number(env.MAX_FILES ?? 100),
    heuristics: env.HEURISTICS !== '0',
  }
}

const manifest = (opts) => ({
  id: 'local.torrentio.filtered',
  version: '0.3.0',
  name: `Torrentio (max ${opts.maxFiles} files)`,
  description: `Torrentio results, minus torrents with more than ${opts.maxFiles} files.`,
  catalogs: [],
  resources: [{ name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu'] }],
  types: ['movie', 'series', 'anime', 'other'],
  behaviorHints: { configurable: false, configurationRequired: false },
})

async function fileCounts(hashes, key, opts) {
  const now = Date.now()
  const fresh = (h) => countCache.get(h) && now - countCache.get(h).at < COUNT_TTL_MS
  const need = [...new Set(hashes)].filter((h) => h && !fresh(h))
  for (let i = 0; i < need.length; i += 40) {
    const params = new URLSearchParams({ format: 'object', list_files: 'true' })
    need.slice(i, i + 40).forEach((h) => params.append('hash', h))
    try {
      const r = await fetch(`${opts.torbox}/v1/api/torrents/checkcached?${params}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) throw new Error(`TorBox ${r.status}`)
      for (const [h, count] of parseFileCounts(await r.json())) countCache.set(h, { count, at: now })
    } catch (e) {
      console.error('file count lookup failed:', redact(String(e.message)))
      break
    }
  }
  return new Map(hashes.filter(fresh).map((h) => [h, countCache.get(h).count]))
}

async function handleStream(ctx, type, id) {
  const { opts, upstreamConfig, sharedKey, config, origin, who } = ctx
  const base = `${origin}${config ? `/${config}` : ''}`
  const r = await fetch(`${opts.upstream}${upstreamConfig ? `/${upstreamConfig}` : ''}/stream/${type}/${id}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`upstream ${r.status}`)
  const body = await r.json()
  const streams = body.streams ?? []
  const key = torboxKeyOf(upstreamConfig)
  const counts = key ? await fileCounts(streams.map(hashOf).filter(Boolean), key, opts) : new Map()
  let kept = streams.filter((s) => !tooBig(s, counts, opts))
  if (sharedKey) {
    // Point play links at this server instead of Torrentio, so the shared key is not in them.
    const prefix = `${opts.upstream}/resolve/torbox/${sharedKey}/`
    kept = kept
      .map((s) => (s.url?.startsWith(prefix) ? { ...s, url: `${base}/resolve/torbox/${s.url.slice(prefix.length)}` } : s))
      .filter((s) => !JSON.stringify(s).includes(sharedKey))
  }
  const hidden = streams.length - kept.length
  const name = decodeURIComponent(id).replace(/\.json$/, '')
  stats.lookups++
  stats.found += streams.length
  stats.hidden += hidden
  stats.recent = [{ at: Date.now(), type, id: name, found: streams.length, hidden }, ...stats.recent].slice(0, 8)
  console.log(`${who}: ${type}/${name}: ${streams.length} from upstream, exact file count for ${counts.size}, ${hidden} dropped, ${kept.length} kept`)
  return send(200, { ...body, streams: kept })
}

// Torrentio answers with a redirect to api.torbox.app/...requestdl?token=<key>, which redirects
// again to the TorBox CDN. Follow the hops that carry the key here, and hand the player only the last one.
async function handleResolve(ctx, rest, request) {
  const { opts, sharedKey } = ctx
  let location = `${opts.upstream}/resolve/torbox/${sharedKey}/${rest}`
  for (let hop = 0; hop < 4 && location.includes(sharedKey); hop++) {
    const r = await fetch(location, {
      redirect: 'manual',
      headers: { 'User-Agent': request.headers.get('User-Agent') ?? 'Stremio' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const next = r.headers.get('Location')
    if (r.status < 300 || r.status >= 400 || !next) return send(r.ok ? 502 : r.status, '')
    location = new URL(next, location).href
  }
  if (location.includes(sharedKey)) return send(502, '')
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } })
}

async function health(opts, env) {
  // A 403 titled "Attention Required! | Cloudflare" means Torrentio's firewall blocks this host's IPs.
  const [r, torbox] = await Promise.all([
    fetch(`${opts.upstream}/manifest.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => ({ status: String(e.message), text: async () => '' })),
    checkTorboxKey(env.TORBOX_KEY, opts.torbox),
  ])
  const page = r.status === 200 ? undefined : /<title>([^<]*)/i.exec(await r.text())?.[1]
  return send(200, { torrentio: r.status, page, torbox, sharedKey: Boolean(env.TORBOX_KEY), local: env.LOCAL === '1' })
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
    const { pathname, origin } = new URL(request.url)
    try {
      if (request.method === 'OPTIONS') return send(204, '')
      if (pathname === '/') return send(200, landing, 'text/html; charset=utf-8')
      if (pathname === '/health') return await health(opts, env)
      if (pathname === '/stats') return env.LOCAL === '1' ? send(200, stats) : send(404, { error: 'not found' })
      const m = /^\/(?:([^/]+)\/)?(manifest\.json|stream\/.+|resolve\/torbox\/.+)$/.exec(pathname)
      if (!m) return send(404, { error: 'not found' })
      const [, config, rest] = m

      const ctx = { opts, config, origin, upstreamConfig: config, sharedKey: null, who: 'own key' }
      if (env.TORBOX_KEY && !hasOwnKey(config)) {
        ctx.who = 'shared key'
        ctx.sharedKey = env.TORBOX_KEY
        ctx.upstreamConfig = withSharedKey(config, env.TORBOX_KEY)
      }

      if (rest === 'manifest.json') return send(200, manifest(opts))
      if (rest.startsWith('resolve/')) {
        return ctx.sharedKey ? await handleResolve(ctx, rest.slice('resolve/torbox/'.length), request) : send(404, { error: 'not found' })
      }
      const s = /^stream\/([^/]+)\/([^/]+?)(?:\.json)?$/.exec(rest)
      if (s) return await handleStream(ctx, s[1], `${s[2]}.json`)
      return send(404, { error: 'not found' })
    } catch (e) {
      console.error('error:', redact(String(e.message)))
      return send(200, { streams: [] })
    }
  },
}

// Status page. Runs only in the browser: builds the install link from what is typed, nothing typed
// is sent anywhere. Titles and posters for the recent list come from Stremio's Cinemeta.
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
button:active{transform:scale(.97)}ol{margin:16px 0 0;padding-left:22px}li{margin:4px 0}.hint{color:var(--muted);font-size:14px;margin:10px 0 0}
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
<div class=urlrow><code id=out>&nbsp;</code><button id=copy>Copy link</button></div>
<ol><li>Open Stremio and go to <b>Add-ons</b>.</li>
<li>Paste the link into the search box at the top, then press <b>Install</b>.</li>
<li>Uninstall the original Torrentio, so results don't show up twice.</li></ol>
<p id=hint class=hint></p>
<details><summary>Settings</summary>
<label for=link>Torrentio install link, to keep your sort and quality settings</label>
<input id=link placeholder="stremio://torrentio.strem.fun/.../manifest.json">
<label for=key>A different TorBox API key (leave empty to use the one set up here)</label>
<input id=key type=password autocomplete=off>
<p class=hint>After changing these, copy the link again and reinstall in Stremio.</p>
</details></section>

<section id=stats class=card hidden><h2>What it's been up to</h2>
<div class=nums><div class=num><b id=n-lookups>0</b><span>lookups</span></div>
<div class=num><b id=n-found>0</b><span>results checked</span></div>
<div class=num><b id=n-hidden>0</b><span>giant batches hidden</span></div></div>
<ul id=recent class=recent></ul><p id=since class=hint></p></section>

<footer id=foot hidden>Starts on its own when you log in. In Terminal:
<code>torrentio-filter status</code> · <code>logs</code> · <code>key</code> · <code>uninstall</code></footer>
</main>
<script>
const $ = (id) => document.getElementById(id)
const DEBRID = /^(torbox|realdebrid|alldebrid|premiumize|debridlink|easydebrid|offcloud|putio)=/i
let shared = true
function pill(id, cls, text) { $(id).className = 'pill ' + cls; $(id).textContent = text }

function update() {
  const link = $('link').value.trim(), key = $('key').value.trim()
  const m = /torrentio\.strem\.fun\/(?:(.+)\/)?manifest\.json/.exec(link)
  // Any key in the pasted link is dropped, so an empty key field always means the key set up here.
  let parts = m && m[1] ? decodeURIComponent(m[1]).split('|').filter((p) => p && !DEBRID.test(p)) : []
  if (key) parts = parts.concat('torbox=' + key)
  $('out').textContent = location.origin + (parts.length ? '/' + encodeURIComponent(parts.join('|')) : '') + '/manifest.json'
  $('hint').textContent = key || shared ? '' : 'No TorBox key is set up, so results won\'t play instantly. Add one under Settings.'
}
for (const id of ['link', 'key']) $(id).oninput = update
update()

$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('out').textContent) } catch { getSelection().selectAllChildren($('out')); return }
  $('copy').textContent = 'Copied ✓'
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1800)
}

fetch('/health').then((r) => r.json()).then((h) => {
  pill('s-torrentio', h.torrentio === 200 ? 'ok' : 'bad', h.torrentio === 200 ? 'Torrentio reachable' : 'Torrentio blocked (' + h.torrentio + ')')
  const tb = { ok: ['ok', 'TorBox key works'], invalid: ['bad', 'TorBox key rejected'], unreachable: ['', 'TorBox not answering'], 'not set': ['', 'No TorBox key'] }[h.torbox]
  pill('s-torbox', tb[0], tb[1])
  shared = h.sharedKey
  $('foot').hidden = !h.local
  update()
}).catch(() => pill('s-server', 'bad', 'Filter not answering'))

const names = new Map()
async function nameOf(type, id) {
  const imdb = id.split(':')[0]
  if (!/^tt\d+$/.test(imdb)) return { name: id }
  const k = (type === 'movie' ? 'movie' : 'series') + '/' + imdb
  if (!names.has(k)) names.set(k, fetch('https://v3-cinemeta.strem.io/meta/' + k + '.json').then((r) => r.json()).then((j) => j.meta || {}).catch(() => ({})))
  return names.get(k)
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'
}
async function loadStats() {
  const r = await fetch('/stats').catch(() => null)
  if (!r || !r.ok) return
  const st = await r.json()
  $('stats').hidden = false
  $('n-lookups').textContent = st.lookups
  $('n-found').textContent = st.found
  $('n-hidden').textContent = st.hidden
  $('since').textContent = 'Since ' + new Date(st.since).toLocaleString() + (st.recent.length ? '' : '. Open something in Stremio and it shows up here.')
  const items = await Promise.all(st.recent.map(async (x) => {
    const meta = await nameOf(x.type, x.id)
    const [, season, episode] = x.id.split(':')
    const li = document.createElement('li')
    const img = document.createElement(meta.poster ? 'img' : 'div')
    if (meta.poster) { img.src = meta.poster; img.alt = '' } else img.className = 'ph'
    const text = document.createElement('div')
    const t = document.createElement('div'); t.className = 't'
    t.textContent = (meta.name || x.id) + (season ? ' · S' + season + 'E' + episode : '')
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
