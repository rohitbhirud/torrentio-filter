// End to end with fake Torrentio, TorBox and CDN servers (no network, no real key).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import worker from './worker.mjs'

const H_BIG = 'a'.repeat(40) // cached, 500 files
const H_PACK = 'b'.repeat(40) // cached, 30 files
const H_NEW = 'c'.repeat(40) // not cached, title says Complete
const SHARED = 'SHARED-KEY-123'
const seen = { auth: null, query: null, resolvedWith: null }

const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)) })
const at = (s) => `http://127.0.0.1:${s.address().port}`

const cdn = await listen((req, res) => res.end('video'))
const torbox = await listen((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.endsWith('/requestdl')) {
    res.writeHead(302, { Location: `${at(cdn)}/dl/abc.mkv?sig=xyz` })
    return res.end()
  }
  seen.auth = req.headers.authorization
  seen.query = url.searchParams
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}` }))
  res.end(JSON.stringify({ success: true, data: { [H_BIG]: { files: files(500) }, [H_PACK]: { files: files(30) } } }))
})
const torrentio = await listen((req, res) => {
  const [, config] = decodeURIComponent(req.url).split('/')
  const key = /torbox=([^|]+)/.exec(config)?.[1]
  if (config === 'resolve') {
    seen.resolvedWith = req.url
    res.writeHead(302, { Location: `${at(torbox)}/v1/api/torrents/requestdl?token=${SHARED}&torrent_id=1&file_id=2&redirect=true` })
    return res.end()
  }
  const stream = (h, title) => ({
    name: 'T',
    title: `${title}\nep.mkv\n👤 5 💾 1 GB`,
    infoHash: h,
    fileIdx: 3,
    ...(key && { url: `${at(torrentio)}/resolve/torbox/${key}/${h}/null/3/ep.mkv` }),
  })
  res.end(JSON.stringify({ streams: [stream(H_BIG, 'Big pack'), stream(H_PACK, 'Naruto [Complete] [Extras]'), stream(H_NEW, 'Show [Complete]')] }))
})

const env = {
  UPSTREAM: at(torrentio),
  TORBOX_API: at(torbox),
  TORBOX_KEY: SHARED,
  ACCESS_CODE_ROHIT: 'code-rohit',
  ACCESS_CODE_FRIEND: 'code-friend',
}
const get = (path, init) => worker.fetch(new Request(`https://filter.example${path}`, init), env)
const titles = async (r) => (await r.json()).streams.map((s) => s.title.split('\n')[0])

test('uses TorBox file counts and falls back to the name for uncached torrents', async () => {
  const r = await get('/sort=seeders%7Ctorbox=OWNKEY/stream/series/tt1:1:22.json')
  assert.deepEqual(await titles(r), ['Naruto [Complete] [Extras]']) // 30 files kept; 500 dropped; uncached "Complete" dropped
  assert.equal(seen.auth, 'Bearer OWNKEY')
  assert.equal(seen.query.get('list_files'), 'true')
  assert.deepEqual(seen.query.getAll('hash').sort(), [H_BIG, H_PACK, H_NEW].sort())
})

test('works without a TorBox key (name rules only)', async () => {
  const r = await get('/sort=seeders/stream/series/tt1:1:22.json')
  assert.deepEqual(await titles(r), ['Big pack'])
})

test('an access code uses the shared key and never returns it', async () => {
  const r = await get('/sort=seeders%7Caccess=code-friend/stream/series/tt1:1:22.json')
  const text = await r.text()
  assert.equal(seen.auth, `Bearer ${SHARED}`)
  assert.ok(!text.includes(SHARED))
  const [s] = JSON.parse(text).streams
  assert.equal(s.url, `https://filter.example/sort=seeders%7Caccess=code-friend/resolve/torbox/${H_PACK}/null/3/ep.mkv`)
})

test('resolve follows the hops that carry the key and redirects to the CDN link only', async () => {
  const r = await get(`/access=code-rohit/resolve/torbox/${H_PACK}/null/3/ep.mkv`, { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('Location'), `${at(cdn)}/dl/abc.mkv?sig=xyz`)
  assert.equal(seen.resolvedWith, `/resolve/torbox/${SHARED}/${H_PACK}/null/3/ep.mkv`)
})

test('an unknown access code is refused', async () => {
  assert.equal((await get('/access=nope/manifest.json')).status, 403)
  assert.equal((await get(`/access=nope/resolve/torbox/${H_PACK}/null/3/ep.mkv`)).status, 403)
  assert.equal((await get('/access=code-friend/manifest.json')).status, 200)
})

test('resolve is not open without an access code', async () => {
  assert.equal((await get(`/sort=seeders/resolve/torbox/${H_PACK}/null/3/ep.mkv`)).status, 404)
})

test.after(() => { torrentio.close(); torbox.close(); cdn.close() })
