/**
 * External watchdog for CredSeek.
 * - health timeout / non-200 → pm2 restart
 * - process RSS too high → pm2 restart
 * - host mem pressure / thermal (if available) → pm2 restart
 * Cooldown prevents restart storms.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HEALTH_URL = process.env.GUARD_HEALTH_URL || 'http://127.0.0.1:3001/api/health'
const APP_NAME = process.env.GUARD_APP_NAME || 'credseek'
const INTERVAL_MS = Number(process.env.GUARD_WATCH_MS) || 30_000
// Longer timeout: bulk SQLite inserts + TG downloads can block the loop briefly.
const HEALTH_TIMEOUT_MS = Number(process.env.GUARD_HEALTH_TIMEOUT_MS) || 45_000
const FAIL_STREAK = Number(process.env.GUARD_FAIL_STREAK) || 4
const COOLDOWN_MS = Number(process.env.GUARD_COOLDOWN_MS) || 180_000
const BOOT_GRACE_MS = Number(process.env.GUARD_BOOT_GRACE_MS) || 180_000
const MAX_RSS_MB = Number(process.env.GUARD_MAX_RSS_MB) || 1600
const MAX_LOAD_PER_CPU = Number(process.env.GUARD_MAX_LOAD) || 6
const MAX_TEMP_C = Number(process.env.GUARD_MAX_TEMP_C) || 90
const MIN_AVAIL_MEM_MB = Number(process.env.GUARD_MIN_AVAIL_MEM_MB) || 200

let failStreak = 0
let lastRestartAt = 0
const guardStartedAt = Date.now()
let pm2Bin: string | null = null

function log(msg: string) {
  console.log(`[health-guard] ${new Date().toISOString()} ${msg}`)
}

async function resolvePm2() {
  if (pm2Bin) return pm2Bin
  const candidates = [
    process.env.PM2_BIN,
    'pm2',
    '/usr/bin/pm2',
    '/usr/local/bin/pm2',
    '/root/.local/share/pnpm/pm2',
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['-v'], { timeout: 8_000, windowsHide: true, env: process.env })
      pm2Bin = c
      log(`using pm2 binary: ${c}`)
      return c
    } catch {
      /* try next */
    }
  }
  throw new Error('pm2 binary not found in PATH')
}

async function pm2Restart(reason: string) {
  const now = Date.now()
  if (now - guardStartedAt < BOOT_GRACE_MS) {
    log(`skip restart (boot grace ${Math.round((BOOT_GRACE_MS - (now - guardStartedAt)) / 1000)}s left) · ${reason}`)
    return
  }
  if (now - lastRestartAt < COOLDOWN_MS) {
    log(`skip restart (cooldown) · ${reason}`)
    return
  }
  lastRestartAt = now
  failStreak = 0
  log(`RESTART ${APP_NAME} · ${reason}`)
  try {
    const bin = await resolvePm2()
    await execFileAsync(bin, ['restart', APP_NAME, '--update-env'], {
      timeout: 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      },
    })
    log('pm2 restart issued')
  } catch (err) {
    log(`pm2 restart failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function checkHealth(): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json()) as { ok?: boolean }
    if (body.ok === false) return { ok: false, detail: 'health.ok=false' }
    return { ok: true, detail: 'ok' }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function appRssMb(): Promise<number | null> {
  try {
    const bin = await resolvePm2()
    const { stdout } = await execFileAsync(bin, ['jlist'], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      },
    })
    const list = JSON.parse(stdout) as Array<{
      name?: string
      monit?: { memory?: number }
      pid?: number
    }>
    const app = list.find((a) => a.name === APP_NAME)
    if (!app?.monit?.memory) return null
    return Math.round(app.monit.memory / (1024 * 1024))
  } catch {
    return null
  }
}

function readLoadPerCpu(): number | null {
  try {
    const raw = fs.readFileSync('/proc/loadavg', 'utf8')
    const load1 = Number(raw.split(/\s+/)[0])
    const cpus = Math.max(1, Number(fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/gm)?.length || 1))
    if (!Number.isFinite(load1)) return null
    return load1 / cpus
  } catch {
    return null
  }
}

function readAvailMemMb(): number | null {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m)
    if (!m) return null
    return Math.round(Number(m[1]) / 1024)
  } catch {
    return null
  }
}

function readMaxTempC(): number | null {
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter((n) => n.startsWith('thermal_zone'))
    let max = -1
    for (const z of zones) {
      try {
        const t = Number(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8').trim())
        // Usually millidegree C
        const c = t > 1000 ? t / 1000 : t
        if (Number.isFinite(c) && c > max) max = c
      } catch {
        /* ignore */
      }
    }
    return max >= 0 ? max : null
  } catch {
    return null
  }
}

async function tick() {
  const health = await checkHealth()
  if (!health.ok) {
    failStreak += 1
    log(`health FAIL (${failStreak}/${FAIL_STREAK}): ${health.detail}`)
    if (failStreak >= FAIL_STREAK) {
      await pm2Restart(`health unavailable: ${health.detail}`)
    }
  } else {
    if (failStreak > 0) log('health recovered')
    failStreak = 0
  }

  const rss = await appRssMb()
  if (rss != null && rss >= MAX_RSS_MB) {
    await pm2Restart(`RSS ${rss}MB ≥ ${MAX_RSS_MB}MB`)
    return
  }

  const avail = readAvailMemMb()
  if (avail != null && avail < MIN_AVAIL_MEM_MB) {
    await pm2Restart(`MemAvailable ${avail}MB < ${MIN_AVAIL_MEM_MB}MB`)
    return
  }

  const load = readLoadPerCpu()
  if (load != null && load >= MAX_LOAD_PER_CPU && !health.ok) {
    await pm2Restart(`load/cpu ${load.toFixed(2)} ≥ ${MAX_LOAD_PER_CPU} + health down`)
    return
  }

  const temp = readMaxTempC()
  if (temp != null && temp >= MAX_TEMP_C) {
    await pm2Restart(`thermal ${temp.toFixed(1)}°C ≥ ${MAX_TEMP_C}°C`)
  }
}

async function main() {
  log(
    `armed · app=${APP_NAME} health=${HEALTH_URL} every ${INTERVAL_MS}ms · rss≤${MAX_RSS_MB}MB avail≥${MIN_AVAIL_MEM_MB}MB`,
  )
  for (;;) {
    try {
      await tick()
    } catch (err) {
      log(`tick error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

void main()
