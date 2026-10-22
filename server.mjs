// Runs the add-on as a local server: node server.mjs
// Settings come from config.env next to this file (written by `torrentio-filter setup`):
// TORBOX_KEY, PORT (default 7171), MAX_FILES, HEURISTICS.
import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import addon from './addon.mjs'

export function readConfig(file) {
  if (!fs.existsSync(file)) return {}
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n')
      .map((line) => /^\s*([A-Z_]+)=(.*)$/.exec(line))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.trim()]),
  )
}

export function createServer(env) {
  return http.createServer(async (req, res) => {
    try {
      const r = await addon.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method }), env)
      res.writeHead(r.status, Object.fromEntries(r.headers))
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch (e) {
      console.error('server error:', e.message)
      res.writeHead(500).end()
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { ...process.env, ...readConfig(fileURLToPath(new URL('./config.env', import.meta.url))) }
  const port = Number(env.PORT ?? 7171)
  createServer(env).listen(port, '127.0.0.1', () => {
    console.log(`Torrentio filter on http://127.0.0.1:${port}  (max ${env.MAX_FILES ?? 100} files, TorBox key ${env.TORBOX_KEY ? 'set' : 'not set'})`)
  })
}
