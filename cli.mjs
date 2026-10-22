#!/usr/bin/env node
// torrentio-filter: installs the filter as a background service on macOS that starts at login.
// No dependencies. Run `torrentio-filter help` for the commands.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkTorboxKey } from './filter.mjs'
import { readConfig } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()
const LABEL = 'local.torrentio-filter'
const APP = path.join(HOME, 'Library', 'Application Support', 'TorrentioFilter')
const CONFIG = path.join(APP, 'config.env')
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG = path.join(HOME, 'Library', 'Logs', 'TorrentioFilter.log')
const LEGACY = path.join(HOME, 'Library', 'LaunchAgents', 'com.user.torrentio-filter.plist') // older hand-made setup
const FILES = ['server.mjs', 'addon.mjs', 'filter.mjs']
const DOMAIN = `gui/${process.getuid?.()}`

const tty = process.stdout.isTTY
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const bold = paint(1), dim = paint(2), green = paint(32), red = paint(31), yellow = paint(33), purple = paint(35)
const ok = (s) => console.log(`${green('✓')} ${s}`)
const warn = (s) => console.log(`${yellow('!')} ${s}`)
const fail = (s) => { console.error(`${red('✗')} ${s}`); process.exit(1) }
const step = (s) => console.log(`${purple('›')} ${s}`)

// Resolves '' when input ends (Ctrl+D, or nothing piped in). Ctrl+C quits.
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    let answered = false
    let muted = false
    // While hidden, whatever readline draws (typing, backspace, paste) becomes the prompt plus one dot per character.
    rl._writeToOutput = (s) => rl.output.write(!muted || /^\r?\n$/.test(s) ? s : `\r\x1b[2K${question}${'•'.repeat(rl.line.length)}`)
    rl.on('SIGINT', () => { rl.output.write('\n'); process.exit(130) })
    rl.once('close', () => { if (!answered) { rl.output.write('\n'); resolve('') } })
    rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer.trim()) })
    muted = hidden
  })
}

const launchctl = (...args) => {
  try { return execFileSync('launchctl', args, { stdio: 'pipe' }).toString() } catch { return null }
}
const running = () => launchctl('print', `${DOMAIN}/${LABEL}`) !== null
const port = () => Number(readConfig(CONFIG).PORT ?? 7171)
const url = (p = port()) => `http://127.0.0.1:${p}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A service that was just stopped can hold the port for a moment, so retry for a few seconds.
async function portFree(p) {
  for (let i = 0; i < 10; i++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
      s.listen(p, '127.0.0.1')
    })
    if (free) return true
    await sleep(300)
  }
  return false
}

async function health(p = port(), waitMs = 0) {
  const until = Date.now() + waitMs
  do {
    try { return await (await fetch(`${url(p)}/health`, { signal: AbortSignal.timeout(25000) })).json() } catch {} // server waits up to 20 s on Torrentio
    await sleep(300)
  } while (Date.now() < until)
  return null
}

async function askKey(current) {
  if (process.env.TORBOX_KEY) {
    warn('Using the TorBox key from the TORBOX_KEY environment variable')
    return process.env.TORBOX_KEY
  }
  if (current && (await ask(`Keep the TorBox key already set up? ${dim('(Y/n)')} `)).toLowerCase() !== 'n') return current
  console.log(dim('Find it at torbox.app → Settings → API Key. Typing is hidden.'))
  for (let tries = 0; tries < 3; tries++) {
    const key = await ask('TorBox API key: ', { hidden: true })
    if (!key) continue
    const verdict = await checkTorboxKey(key)
    if (verdict === 'ok') { ok('TorBox accepted the key'); return key }
    if (verdict === 'unreachable') { warn("Couldn't reach TorBox to check the key; using it anyway"); return key }
    console.log(red('TorBox rejected that key. Try again (copy it fresh from TorBox settings).'))
  }
  fail('No working key entered.')
}

function writeConfig(values) {
  fs.mkdirSync(APP, { recursive: true })
  const text = Object.entries(values).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join('\n')
  fs.writeFileSync(CONFIG, `${text}\n`, { mode: 0o600 })
  fs.chmodSync(CONFIG, 0o600)
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function writePlist() {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(APP, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(APP)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>
`)
}

// Stops this service and the older hand-made one. Their plists stay, so restoreServices() can bring them back.
function stopServices() {
  launchctl('bootout', `${DOMAIN}/${LABEL}`)
  if (fs.existsSync(LEGACY)) launchctl('bootout', `${DOMAIN}/com.user.torrentio-filter`)
}

function restoreServices() {
  for (const plist of [PLIST, LEGACY]) if (fs.existsSync(plist)) launchctl('bootstrap', DOMAIN, plist)
}

// launchd can refuse a bootstrap right after a bootout while it finishes tearing down, so retry briefly.
async function startService() {
  for (let i = 0; i < 5; i++) {
    if (launchctl('bootstrap', DOMAIN, PLIST) !== null || running()) return
    await sleep(500)
  }
  fail(`launchd refused to start it. Check ${PLIST}`)
}

function printStatus(h, p) {
  const line = (good, text) => console.log(`  ${good ? green('●') : red('●')} ${text}`)
  line(Boolean(h), h ? `Running at ${url(p)}` : 'Not answering')
  if (!h) return
  line(h.torrentio === 200, h.torrentio === 200 ? 'Torrentio reachable' : `Torrentio not answering (${h.torrentio})`)
  line(h.torbox === 'ok', { ok: 'TorBox key works', invalid: 'TorBox key rejected (run: torrentio-filter key)', unreachable: 'TorBox not answering', 'not set': 'No TorBox key (run: torrentio-filter key)' }[h.torbox])
}

const banner = () => console.log(`\n  🧲 ${bold('Torrentio Filter')}  ${dim("Torrentio, minus the giant batches TorBox can't play")}\n`)

const commands = {
  async setup() {
    banner()
    if (process.platform !== 'darwin') fail('Setup is for macOS. Elsewhere, run `node server.mjs` and keep it running.')
    const [major] = process.versions.node.split('.').map(Number)
    if (major < 18) fail(`Node 18 or newer is needed (you have ${process.versions.node}). Try: brew install node`)
    const current = readConfig(CONFIG)
    const key = await askKey(current.TORBOX_KEY)

    const flag = process.argv.indexOf('--port')
    const p = Number(flag > -1 ? process.argv[flag + 1] : current.PORT ?? 7171)
    if (!Number.isInteger(p) || p < 1024 || p > 65535) fail('--port needs a number from 1024 to 65535')
    step('Stopping any running copy')
    stopServices()
    if (!(await portFree(p))) {
      restoreServices()
      fail(`Port ${p} is in use by another app. Pick another: torrentio-filter setup --port 7272`)
    }

    step(`Installing to ${dim(APP)}`)
    fs.mkdirSync(APP, { recursive: true })
    for (const f of fs.readdirSync(APP)) if (f.endsWith('.mjs')) fs.rmSync(path.join(APP, f)) // files from older versions
    for (const f of FILES) fs.copyFileSync(path.join(HERE, f), path.join(APP, f))
    writeConfig({ ...current, TORBOX_KEY: key, PORT: String(p) })
    writePlist()
    step('Starting it, and setting it to start at every login')
    await startService()

    const h = await health(p, 10000)
    if (!h) fail(`It didn't come up. Look at the log: torrentio-filter logs`)
    if (fs.existsSync(LEGACY)) {
      fs.rmSync(LEGACY)
      warn('Replaced the older torrentio-filter service. Reinstall the add-on in Stremio with the link below.')
    }
    console.log()
    printStatus(h, p)
    console.log(`\n  ${bold('Add it to Stremio:')} Add-ons → paste this in the search box → Install\n\n    ${purple(`${url(p)}/manifest.json`)}\n`)
    console.log(dim(`  Status page: ${url(p)}   ·   torrentio-filter help for more\n`))
    if (!process.argv.includes('--no-open')) spawn('open', [url(p)], { stdio: 'ignore', detached: true }).unref()
  },

  async status() {
    if (!fs.existsSync(PLIST)) fail('Not installed. Run: torrentio-filter setup')
    console.log(`\n  ${bold('Torrentio Filter')} ${running() ? green('(service loaded)') : red('(service not loaded)')}`)
    printStatus(await health(), port())
    console.log(`\n  Stremio link: ${purple(`${url()}/manifest.json`)}\n`)
  },

  async key() {
    if (!fs.existsSync(CONFIG)) fail('Not installed. Run: torrentio-filter setup')
    const current = readConfig(CONFIG)
    writeConfig({ ...current, TORBOX_KEY: await askKey() })
    if (launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`) === null) fail('Key saved, but the service is not running. Run: torrentio-filter setup')
    ok('Key saved and the filter restarted. Nothing to change in Stremio.')
  },

  async restart() {
    if (launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`) === null) fail('Not running. Run: torrentio-filter setup')
    ok('Restarted')
  },

  async logs() {
    if (!fs.existsSync(LOG)) fail('No log yet.')
    spawn('tail', ['-n', '40', '-f', LOG], { stdio: 'inherit' })
  },

  async open() {
    spawn('open', [url()], { stdio: 'ignore', detached: true }).unref()
  },

  async uninstall() {
    const paths = [PLIST, LEGACY, APP, LOG].filter((p) => fs.existsSync(p))
    if (!paths.length) return ok('Nothing to remove: it is not installed.')
    stopServices()
    for (const p of paths) fs.rmSync(p, { recursive: true, force: true })
    ok('Removed the service, its settings (including the key) and its log. Remove the add-on in Stremio too.')
  },

  help() {
    banner()
    console.log(`  ${bold('torrentio-filter setup')}      install, or update after pulling new code ${dim('(--port N, --no-open)')}
  ${bold('torrentio-filter status')}     is it running, does Torrentio answer, does the key work
  ${bold('torrentio-filter open')}       open the status page
  ${bold('torrentio-filter key')}        change the TorBox API key
  ${bold('torrentio-filter logs')}       follow the log
  ${bold('torrentio-filter restart')}    restart the background service
  ${bold('torrentio-filter uninstall')}  remove everything, including the saved key
`)
  },
}

const name = { '-h': 'help', '--help': 'help' }[process.argv[2]] ?? process.argv[2] ?? 'help'
await (commands[name] ?? (() => fail(`Unknown command "${name}". Try: torrentio-filter help`)))()
