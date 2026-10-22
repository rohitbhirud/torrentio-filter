// Filtering rules: decide which Torrentio results come from torrents that are too big
// (TorBox zips torrents with more than 100 files, which Torrentio then can't play).

const defaults = { maxFiles: 100, heuristics: true }
const HASH = /^[0-9a-f]{40}$/i

// Path segments of a stream's URL, or [] when it has none or it doesn't parse.
function pathParts(stream) {
  try {
    return new URL(stream.url ?? '', 'http://x').pathname.split('/')
  } catch {
    return []
  }
}

// A file index of N means the torrent has at least N + 1 files.
export function fileIdxOf(stream) {
  if (Number.isInteger(stream.fileIdx)) return stream.fileIdx
  // Debrid streams: .../resolve/<provider>/<key>/<infoHash>/<x>/<fileIdx>/<filename>
  const parts = pathParts(stream)
  const h = parts.findIndex((p) => HASH.test(p))
  if (h === -1) return null
  const idx = parts[h + 2]
  return /^\d+$/.test(idx ?? '') ? Number(idx) : null
}

const BATCH_WORD = /\b(batch|complete|collection|extras|all seasons|all episodes)\b/i
// Episode ranges such as 001-574 or 01-900, but not season ranges (S07-15),
// codec tags (x265-GROUP), resolutions (1080p) or years (1999-2023).
const EPISODE_RANGE = /(?<![\w.])(\d{1,4})\s*[-~]\s*(\d{1,4})(?![\w.])/g
const isYear = (n) => n >= 1900 && n <= 2099

function looksLikeBatch(stream, opts = defaults) {
  const torrentName = String(stream.title ?? '').split('\n')[0]
  // Words like "Batch" also appear on small packs, so only trust them when no range is given.
  const ranges = [...torrentName.matchAll(EPISODE_RANGE)]
    .map(([, a, b]) => [Number(a), Number(b)])
    .filter(([a, b]) => !(isYear(a) && isYear(b)))
    .map(([a, b]) => b - a + 1)
    .filter((n) => n > 1)
  if (ranges.length) return ranges.some((n) => n > opts.maxFiles)
  return BATCH_WORD.test(torrentName)
}

export function hashOf(stream) {
  if (HASH.test(stream.infoHash ?? '')) return stream.infoHash.toLowerCase()
  return pathParts(stream).find((p) => HASH.test(p))?.toLowerCase() ?? null
}

// counts: Map of infoHash -> exact file count from TorBox. When it knows the answer it wins;
// otherwise fall back to the file position and the name rules.
export function tooBig(stream, counts = new Map(), opts = defaults) {
  const count = counts.get(hashOf(stream))
  // TorBox lists a zipped torrent as one file, so "1 file" on a batch-looking name means zipped.
  if (count === 1 && opts.heuristics && looksLikeBatch(stream, opts)) return true
  if (count !== undefined) return count > opts.maxFiles
  const idx = fileIdxOf(stream)
  if (idx !== null && idx >= opts.maxFiles) return true
  return opts.heuristics && looksLikeBatch(stream, opts)
}

// Reads { data: { <hash>: { files: [...] } } } or { data: [{ hash, files: [...] }] }.
const ARCHIVE = /\.(zip|rar|7z|tar|tgz)$/i

export function parseFileCounts(json) {
  const data = json?.data
  const entries = Array.isArray(data) ? data.map((v) => [v?.hash, v]) : Object.entries(data ?? {})
  const out = new Map()
  for (const [k, v] of entries) {
    if (!v || !Array.isArray(v.files)) continue
    const hash = String(v.hash ?? k).toLowerCase()
    const first = String(v.files[0]?.name ?? v.files[0]?.short_name ?? '')
    // A lone archive means TorBox zipped a big torrent; its real size is unknown but over the limit.
    out.set(hash, v.files.length === 1 && ARCHIVE.test(first) ? Infinity : v.files.length)
  }
  return out
}

// Torrentio config options that hold a debrid key.
const DEBRID_SERVICES = 'torbox|realdebrid|alldebrid|premiumize|debridlink|easydebrid|offcloud|putio'
const DEBRID = new RegExp(`^(${DEBRID_SERVICES})=`, 'i')

export function redact(s) {
  return s.replace(new RegExp(`(${DEBRID_SERVICES})=[^|%/&]+`, 'gi'), '$1=***')
}

// The Torrentio config to send upstream: the user's options, plus a size limit and priority
// language unless they set their own, with any debrid key swapped for this one.
export function torrentioConfig(config, { key, maxSize, language } = {}) {
  let parts = config ? decodeURIComponent(config).split('|').filter(Boolean) : []
  const has = (name) => parts.some((p) => p.toLowerCase().startsWith(`${name}=`))
  if (maxSize && !has('sizefilter')) parts.push(`sizefilter=${maxSize}`)
  if (language && !has('language')) parts.push(`language=${language}`)
  if (key) parts = [...parts.filter((p) => !DEBRID.test(p)), `torbox=${key}`]
  return parts.length ? encodeURIComponent(parts.join('|')) : ''
}

// Does TorBox accept this key? 'ok', 'invalid', 'unreachable' or 'not set'.
export async function checkTorboxKey(key, torbox = 'https://api.torbox.app') {
  if (!key) return 'not set'
  try {
    const r = await fetch(`${torbox}/v1/api/user/me`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    if (r.status === 401 || r.status === 403) return 'invalid' // TorBox answers BAD_TOKEN with 403
    if (!r.ok) return 'unreachable' // rate limited or down: says nothing about the key
    return (await r.json()).success ? 'ok' : 'invalid'
  } catch {
    return 'unreachable'
  }
}
