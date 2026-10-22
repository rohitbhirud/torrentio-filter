// Runs the add-on as a local server: node server.mjs
// Settings come from config.env next to this file (written by `torrentio-filter setup`):
// TORBOX_KEY, PORT (default 7171), MAX_FILES, HEURISTICS.
import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import worker from './worker.mjs'

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
  const port = Number(env.PORT ?? 7171)
  return http.createServer(async (req, res) => {
    try {
      const request = new Request(`http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`, {
        method: req.method,
        headers: { 'User-Agent': req.headers['user-agent'] ?? '' },
      })
      const r = await worker.fetch(request, { ...env, LOCAL: '1' })
      res.writeHead(r.status, Object.fromEntries(r.headers))
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch (e) {
      res.writeHead(400).end()
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { ...process.env, ...readConfig(fileURLToPath(new URL('./config.env', import.meta.url))) }
  const port = Number(env.PORT ?? 7171)
  createServer(env).listen(port, '127.0.0.1', () => {
    console.log(`Torrentio filter on http://127.0.0.1:${port}  (max ${env.MAX_FILES ?? 100} files, shared key ${env.TORBOX_KEY ? 'set' : 'not set'})`)
  })
}
