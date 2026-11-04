// End to end through the Node server, with fake Torrentio and TorBox servers (no network, no real key).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createServer } from './server.mjs'

const H_BIG = 'a'.repeat(40) // cached, 500 files
const H_PACK = 'b'.repeat(40) // cached, 30 files
const H_NEW = 'c'.repeat(40) // not cached, title says Complete
const KEY = 'TEST-KEY'
const seen = { config: null, auth: null, hashes: null, listCalls: 0, listAuth: null }
const LISTS = { // what the fake TorBox lists, by API key
  'LIB-PACK': [{ hash: H_PACK.toUpperCase() }],
  'LIB-BIG': [{ hash: H_BIG }],
  'LIB-CACHE': [{ hash: H_PACK }],
}

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
  if (req.url.startsWith('/v1/api/torrents/mylist')) {
    const key = req.headers.authorization.replace('Bearer ', '')
    seen.listCalls++
    seen.listAuth = req.headers.authorization
    if (key === 'LIB-HANG') return // never answers
    if (key === 'LIB-DOWN') return res.writeHead(500).end('{}')
    if (key === 'LIB-REFUSED') return res.end(JSON.stringify({ success: false, error: 'BAD_TOKEN' }))
    return res.end(JSON.stringify({ success: true, data: LISTS[key] ?? [] }))
  }
  seen.auth = req.headers.authorization
  seen.hashes = new URL(req.url, 'http://x').searchParams.getAll('hash')
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}` }))
  res.end(JSON.stringify({ success: true, data: { [H_BIG]: { files: files(500) }, [H_PACK]: { files: files(30) } } }))
}))

const start = (env) => listen(createServer({ UPSTREAM: at(torrentio), TORBOX_API: at(torbox), MAX_SIZE: 'off', LANGUAGE: 'off', CACHED_ONLY: '0', ...env }))
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

test('cached-only keeps what TorBox has cached, or what Torrentio tags [TB+]', async () => {
  const server = await start({ TORBOX_KEY: KEY, CACHED_ONLY: undefined, MAX_FILES: '1000' })
  const r = await fetch(`${at(server)}/stream/series/tt1:1:22.json`)
  assert.deepEqual(await titles(r), ['Big pack', 'Naruto [Complete] [Extras]']) // H_NEW is not cached
  server.close()
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

test('asks Torrentio for files up to 20GB with Hindi first by default', async () => {
  const server = await start({ MAX_SIZE: undefined, LANGUAGE: undefined, TORBOX_KEY: KEY })
  await fetch(`${at(server)}/stream/movie/tt2.json`)
  assert.equal(seen.config, `sizefilter=20GB|language=hindi|torbox=${KEY}`)
  const custom = await start({ MAX_SIZE: '4 gb', LANGUAGE: 'Tamil,hindi' })
  await fetch(`${at(custom)}/stream/movie/tt2.json`)
  assert.equal(seen.config, 'sizefilter=4GB|language=tamil,hindi')
  ;[server, custom].forEach((s) => s.close())
})

test('an invalid MAX_FILES falls back to 100', async () => {
  const server = await start({ MAX_FILES: 'lots' })
  assert.equal((await (await fetch(`${at(server)}/manifest.json`)).json()).name, 'Torrentio (max 100 files)')
  server.close()
})

// Heuristics off and a high MAX_FILES keep all three streams, so the order is easy to read.
const startAll = (key) => start({ TORBOX_KEY: key, MAX_FILES: '1000', HEURISTICS: '0' })
const streamsFrom = async (server) => (await (await fetch(`${at(server)}/stream/series/tt1:1:22.json`)).json()).streams
const firstLines = (streams) => streams.map((s) => s.title.split('\n')[0])
const ORIGINAL = ['Big pack', 'Naruto [Complete] [Extras]', 'Show [Complete]']

test('puts streams from the TorBox library first, labelled', async (t) => {
  const server = await startAll('LIB-PACK')
  t.after(() => server.close())
  const streams = await streamsFrom(server)
  assert.deepEqual(firstLines(streams), ['Naruto [Complete] [Extras]', 'Big pack', 'Show [Complete]'])
  assert.deepEqual(streams.map((s) => s.name), ['⭐ MY TORBOX\nT', 'T', 'T'])
  assert.equal(seen.listAuth, 'Bearer LIB-PACK')
})

test('a library stream that fails the file filter stays hidden', async (t) => {
  const server = await start({ TORBOX_KEY: 'LIB-BIG' }) // 500 files, over the limit of 100
  t.after(() => server.close())
  assert.deepEqual(firstLines(await streamsFrom(server)), ['Naruto [Complete] [Extras]'])
})

test('asks TorBox for the library at most once a minute', async (t) => {
  const server = await startAll('LIB-CACHE')
  t.after(() => server.close())
  const before = seen.listCalls
  await streamsFrom(server)
  await streamsFrom(server)
  assert.equal(seen.listCalls - before, 1)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 61000)
  assert.equal((await streamsFrom(server))[0].name, '⭐ MY TORBOX\nT')
  assert.equal(seen.listCalls - before, 2)
})

test('a failed library lookup is logged without the key and changes nothing', async (t) => {
  for (const key of ['LIB-DOWN', 'LIB-REFUSED']) {
    const errors = t.mock.method(console, 'error', () => {})
    const server = await startAll(key)
    t.after(() => server.close())
    const before = seen.listCalls
    const streams = await streamsFrom(server)
    assert.deepEqual(firstLines(streams), ORIGINAL)
    assert.ok(streams.every((s) => s.name === 'T'))
    const logged = errors.mock.calls.map((c) => c.arguments.join(' ')).join('\n')
    assert.match(logged, /library lookup failed/)
    assert.ok(!logged.includes(key))
    await streamsFrom(server) // the failure is cached too, so no second wait
    assert.equal(seen.listCalls - before, 1)
    errors.mock.restore()
  }
})

test('gives up on a library lookup after 5 seconds and keeps the streams', async (t) => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeouts = []
  t.mock.method(AbortSignal, 'timeout', (ms) => { // shorten the wait so the test stays quick
    timeouts.push(ms)
    return realTimeout(ms === 5000 ? 50 : ms)
  })
  const errors = t.mock.method(console, 'error', () => {})
  const server = await startAll('LIB-HANG')
  t.after(() => server.close())
  assert.deepEqual(firstLines(await streamsFrom(server)), ORIGINAL)
  assert.ok(timeouts.includes(5000))
  assert.match(errors.mock.calls[0].arguments.join(' '), /library lookup failed/)
})

test.after(() => [torrentio, torbox, withKey, noKey].forEach((s) => s.close()))
