// End to end through the Node server, with fake Torrentio and TorBox servers (no network, no real key).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createServer } from './server.mjs'

const H_BIG = 'a'.repeat(40) // cached, 500 files
const H_PACK = 'b'.repeat(40) // cached, 30 files
const H_NEW = 'c'.repeat(40) // not cached, title says Complete
const KEY = 'TEST-KEY'
const seen = { config: null, auth: null, hashes: null }

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)))
const at = (s) => `http://127.0.0.1:${s.address().port}`

const torrentio = await listen(http.createServer((req, res) => {
  if (req.url === '/manifest.json') return res.end('{}')
  seen.config = decodeURIComponent(req.url.split('/stream/')[0].slice(1))
  const stream = (h, title) => ({ name: 'T', title: `${title}\nep.mkv\n👤 5 💾 1 GB`, infoHash: h, fileIdx: 3 })
  if (req.url.includes('/tt-bad-url.json')) return res.end(JSON.stringify({ streams: [{ title: 'Odd\nx', url: 'http://[bad' }, stream(H_PACK, 'Fine')] }))
  res.end(JSON.stringify({ streams: [stream(H_BIG, 'Big pack'), stream(H_PACK, 'Naruto [Complete] [Extras]'), stream(H_NEW, 'Show [Complete]')] }))
}))
const torbox = await listen(http.createServer((req, res) => {
  const good = req.headers.authorization === `Bearer ${KEY}`
  if (req.url.startsWith('/v1/api/user/me')) {
    if (req.headers.authorization === 'Bearer RATE-LIMITED') return res.writeHead(429).end('{}')
    res.writeHead(good ? 200 : 403) // TorBox answers a bad key with 403 BAD_TOKEN
    return res.end(JSON.stringify({ success: good, error: good ? null : 'BAD_TOKEN' }))
  }
  seen.auth = req.headers.authorization
  seen.hashes = new URL(req.url, 'http://x').searchParams.getAll('hash')
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}` }))
  res.end(JSON.stringify({ success: true, data: { [H_BIG]: { files: files(500) }, [H_PACK]: { files: files(30) } } }))
}))

const start = (env) => listen(createServer({ UPSTREAM: at(torrentio), TORBOX_API: at(torbox), ...env }))
const withKey = await start({ TORBOX_KEY: KEY })
const noKey = await start({})
const titles = async (r) => (await r.json()).streams.map((s) => s.title.split('\n')[0])

test('uses TorBox file counts and falls back to the name for uncached torrents', async () => {
  const r = await fetch(`${at(withKey)}/sort=seeders/stream/series/tt1:1:22.json`)
  assert.deepEqual(await titles(r), ['Naruto [Complete] [Extras]']) // 30 files kept; 500 dropped; uncached "Complete" dropped
  assert.equal(seen.config, `sort=seeders|torbox=${KEY}`)
  assert.equal(seen.auth, `Bearer ${KEY}`)
  assert.deepEqual(seen.hashes.sort(), [H_BIG, H_PACK, H_NEW].sort())
})

test('a key in the install link is replaced by the one from setup', async () => {
  await fetch(`${at(withKey)}/sort=seeders%7Ctorbox=OLD/stream/series/tt1:1:22.json`)
  assert.equal(seen.config, `sort=seeders|torbox=${KEY}`)
  await fetch(`${at(withKey)}/stream/movie/tt2.json`)
  assert.equal(seen.config, `torbox=${KEY}`)
})

test('works without a TorBox key (name rules only)', async () => {
  const r = await fetch(`${at(noKey)}/sort=seeders/stream/series/tt1:1:22.json`)
  assert.deepEqual(await titles(r), ['Big pack'])
  assert.equal(seen.config, 'sort=seeders')
})

test('serves the manifest, health and stats', async () => {
  for (const path of ['/manifest.json', '/sort=seeders/manifest.json']) {
    assert.equal((await (await fetch(at(withKey) + path)).json()).id, 'local.torrentio.filtered')
  }
  assert.deepEqual(await (await fetch(`${at(withKey)}/health`)).json(), { torrentio: 200, torbox: 'ok' })
  assert.deepEqual(await (await fetch(`${at(noKey)}/health`)).json(), { torrentio: 200, torbox: 'not set' })
  const stats = await (await fetch(`${at(withKey)}/stats`)).json()
  assert.ok(stats.lookups >= 3)
  assert.ok(stats.recent.some((x) => x.id === 'tt2' && x.type === 'movie'))
})

test('one malformed stream url does not wipe the other results', async () => {
  const r = await fetch(`${at(withKey)}/stream/series/tt-bad-url.json`)
  assert.deepEqual(await titles(r), ['Odd', 'Fine'])
})

test('tells a rejected key apart from a rate-limited TorBox', async () => {
  for (const [key, verdict] of [['WRONG', 'invalid'], ['RATE-LIMITED', 'unreachable']]) {
    const server = await start({ TORBOX_KEY: key })
    assert.equal((await (await fetch(`${at(server)}/health`)).json()).torbox, verdict)
    server.close()
  }
})

test('an invalid MAX_FILES falls back to 100', async () => {
  const server = await start({ MAX_FILES: 'lots' })
  assert.equal((await (await fetch(`${at(server)}/manifest.json`)).json()).name, 'Torrentio (max 100 files)')
  server.close()
})

test.after(() => [torrentio, torbox, withKey, noKey].forEach((s) => s.close()))
