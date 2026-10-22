import test from 'node:test'
import assert from 'node:assert/strict'
import { tooBig, fileIdxOf, parseFileCounts, hashOf, withKey } from './filter.mjs'

const s = (name, extra = {}) => ({ title: `${name}\nfile.mkv\n👤 10 💾 1 GB ⚙️ X`, ...extra })

test('drops huge batches by file index', () => {
  assert.equal(tooBig(s('Show S01', { fileIdx: 409 })), true)
  assert.equal(tooBig(s('Show S01', { fileIdx: 12 })), false)
})

test('drops long episode ranges, keeps short ones', () => {
  assert.equal(tooBig(s('[Judas] One Piece 001-574 [1080p]', { fileIdx: 0 })), true)
  assert.equal(tooBig(s('[One Pace][409-411] Enies Lobby 16 [1080p]', { fileIdx: 0 })), false)
  assert.equal(tooBig(s('[Puto] One Piece 395-425 (1280x720 WEB)', { fileIdx: 15 })), false)
})

test('does not mistake codec tags, resolutions or season ranges for ranges', () => {
  assert.equal(tooBig(s('Movie.2003.1080p.BluRay.x264-RARBG', { fileIdx: 0 })), false)
  assert.equal(tooBig(s('Show {S07-15 | WEB}', { fileIdx: 3 })), false)
})

test('Batch word only counts when there is no range', () => {
  assert.equal(tooBig(s('Show (Batch)', { fileIdx: 0 })), true)
  assert.equal(tooBig(s('Show 01-12 (Batch)', { fileIdx: 0 })), false)
})

test('reads fileIdx from a debrid resolve url', () => {
  const hash = 'a'.repeat(40)
  const url = `https://torrentio.strem.fun/resolve/torbox/KEY/${hash}/null/847/ep.mkv`
  assert.equal(fileIdxOf({ url }), 847)
  assert.equal(tooBig({ title: 'x', url }), true)
})

test('exact file count wins over name and position rules', () => {
  const hash = 'b'.repeat(40)
  const complete = { title: 'Naruto [Complete] [Extras]\nep 022.mkv', infoHash: hash, fileIdx: 21 }
  assert.equal(tooBig(complete), true) // unknown count: falls back to name words
  assert.equal(tooBig(complete, new Map([[hash, 40]])), false) // a 40-file pack is fine
  assert.equal(tooBig({ title: 'Show S01', infoHash: hash, fileIdx: 0 }, new Map([[hash, 500]])), true)
})

test('parses TorBox checkcached responses in both shapes', () => {
  const h = 'c'.repeat(40)
  const files = [{ name: 'a' }, { name: 'b' }]
  assert.deepEqual([...parseFileCounts({ data: { [h]: { files } } })], [[h, 2]])
  assert.deepEqual([...parseFileCounts({ data: [{ hash: h.toUpperCase(), files }] })], [[h, 2]])
  assert.equal(parseFileCounts({ data: { [h]: null } }).size, 0) // not cached
  assert.equal(parseFileCounts(null).size, 0)
})

test('swaps any debrid key in a Torrentio config for ours', () => {
  assert.equal(decodeURIComponent(withKey('sort=seeders%7Ctorbox=OLD%7Crealdebrid=RD', 'NEW')), 'sort=seeders|torbox=NEW')
  assert.equal(decodeURIComponent(withKey(undefined, 'NEW')), 'torbox=NEW')
})

test('reads hashes out of streams', () => {
  const h = 'd'.repeat(40)
  assert.equal(hashOf({ url: `https://t/resolve/torbox/K/${h}/null/3/x.mkv` }), h)
})

test('a one-file torrent with a batch-looking name is a zipped batch', () => {
  const hash = 'e'.repeat(40)
  const one = new Map([[hash, 1]])
  assert.equal(tooBig({ title: 'Show (Complete Series 001-500)\nx', infoHash: hash }, one), true)
  assert.equal(tooBig({ title: '[One Pace][409-411] Arc\nx', infoHash: hash }, one), false)
  assert.equal(tooBig({ title: 'Movie.2003.1080p.x264-RARBG\nx', infoHash: hash }, one), false)
})

test('a lone archive file is treated as zipped', () => {
  const h = 'f'.repeat(40)
  const counts = parseFileCounts({ data: { [h]: { files: [{ name: 'Show (Batch).zip' }] } } })
  assert.equal(counts.get(h), Infinity)
  assert.equal(tooBig({ title: 'Show\nx', infoHash: h }, counts), true)
})
