// Stremio wrapper addon on Cloudflare Workers: forwards stream requests to Torrentio and drops
// results that come from huge torrents. Two ways to install it:
//
//   Shared key:  /manifest.json, or /<torrentio config without a debrid key>/manifest.json
//                The Worker adds the TORBOX_KEY secret. The key never leaves the Worker:
//                play links are rewritten to go through /resolve below.
//   Own key:     /<torrentio config with torbox=KEY>/manifest.json
//                The key lives only in that install URL, never on the server.
import { tooBig, hashOf, torboxKeyOf, parseFileCounts, redact, hasOwnKey, withSharedKey } from './filter.mjs'

const TIMEOUT_MS = 20000
const COUNT_TTL_MS = 24 * 3600 * 1000
const countCache = new Map() // hash -> { count, at }; per isolate, so a few repeat lookups are fine

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
  version: '0.2.0',
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
    // Point play links at this Worker instead of Torrentio, so the shared key is not in them.
    const prefix = `${opts.upstream}/resolve/torbox/${sharedKey}/`
    kept = kept
      .map((s) => (s.url?.startsWith(prefix) ? { ...s, url: `${base}/resolve/torbox/${s.url.slice(prefix.length)}` } : s))
      .filter((s) => !JSON.stringify(s).includes(sharedKey))
  }
  console.log(`${who}: ${type}/${decodeURIComponent(id)}: ${streams.length} from upstream, exact file count for ${counts.size}, ${streams.length - kept.length} dropped, ${kept.length} kept`)
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
  const r = await fetch(`${opts.upstream}/manifest.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => ({ status: String(e.message), text: async () => '' }))
  const page = r.status === 200 ? undefined : /<title>([^<]*)/i.exec(await r.text())?.[1]
  return send(200, { torrentio: r.status, page, sharedKey: Boolean(env.TORBOX_KEY) })
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

// Runs only in the browser: builds the install URL from what is typed, nothing is sent anywhere.
const landing = String.raw`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Torrentio filter</title>
<style>body{font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5}
input{width:100%;padding:8px;box-sizing:border-box;margin-bottom:12px}label{font-weight:600}
code{word-break:break-all}</style>
<h1>Torrentio filter</h1>
<p>Hides Torrentio results from torrents with too many files. Both fields are optional:
leave them empty to use the shared TorBox key. This page runs only in your browser; nothing you type is sent anywhere.</p>
<label for=link>Torrentio install link (keeps your sort and quality settings)</label>
<input id=link placeholder="stremio://torrentio.strem.fun/.../manifest.json">
<label for=key>Your own TorBox API key (instead of the shared one)</label>
<input id=key type=password autocomplete=off>
<p>Paste this into Stremio, under Addons:</p>
<p><code id=out>&nbsp;</code></p>
<p><a id=open href="#">Install in Stremio</a></p>
<script>
const $ = (id) => document.getElementById(id)
const DEBRID = /^(torbox|realdebrid|alldebrid|premiumize|debridlink|easydebrid|offcloud|putio)=/i
function update() {
  const link = $('link').value.trim(), key = $('key').value.trim()
  const m = /torrentio\.strem\.fun\/(?:(.+)\/)?manifest\.json/.exec(link)
  // Any key in the pasted link is dropped, so leaving the key field empty always means the shared key.
  let parts = m && m[1] ? decodeURIComponent(m[1]).split('|').filter((p) => p && !DEBRID.test(p)) : []
  if (key) parts = parts.concat('torbox=' + key)
  const path = (parts.length ? '/' + encodeURIComponent(parts.join('|')) : '') + '/manifest.json'
  $('out').textContent = location.origin + path
  $('open').href = 'stremio://' + location.host + path
}
for (const id of ['link', 'key']) $(id).oninput = update
update()
</script>`
