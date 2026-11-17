import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { TelegramMonitor } from './monitors.js'
import { readMonitors } from './monitors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const storePath = path.join(__dirname, '..', 'data', 'telegram-monitor-activity.json')

const MAX_LOGS = 400
const MAX_SERIES = 240
/** Live API returns a trimmed window so first paint stays light. */
const LIVE_LOGS = 80
const LIVE_SERIES = 90
const SERIES_MIN_GAP_MS = 2500

export type MonitorLogLevel = 'info' | 'success' | 'warn' | 'error'

export type MonitorLogEntry = {
  id: string
  at: string
  monitorId: string
  title: string
  level: MonitorLogLevel
  message: string
  delta?: {
    files?: number
    recordsAdded?: number
    recordsSkipped?: number
  }
}

export type MonitorSeriesPoint = {
  t: number
  filesImported: number
  recordsAdded: number
  recordsSkipped: number
  backfilling: number
  watching: number
}

type ActivityStore = {
  logs: MonitorLogEntry[]
  series: MonitorSeriesPoint[]
}

let mem: ActivityStore | null = null
let lastSeriesAt = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null

function emptyStore(): ActivityStore {
  return { logs: [], series: [] }
}

function loadStore(): ActivityStore {
  if (mem) return mem
  try {
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<ActivityStore>
      mem = {
        logs: Array.isArray(raw.logs) ? raw.logs.slice(-MAX_LOGS) : [],
        series: Array.isArray(raw.series) ? raw.series.slice(-MAX_SERIES) : [],
      }
      return mem
    }
  } catch {
    /* ignore */
  }
  mem = emptyStore()
  return mem
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      const dir = path.dirname(storePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const store = loadStore()
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            logs: store.logs.slice(-MAX_LOGS),
            series: store.series.slice(-MAX_SERIES),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      /* ignore disk errors */
    }
  }, 1200)
}

function aggregateFromMonitors(list: TelegramMonitor[]) {
  let filesImported = 0
  let recordsAdded = 0
  let recordsSkipped = 0
  let backfilling = 0
  let watching = 0
  let paused = 0
  let error = 0
  for (const m of list) {
    filesImported += m.stats.filesImported || 0
    recordsAdded += m.stats.recordsAdded || 0
    recordsSkipped += m.stats.recordsSkipped || 0
    if (m.status === 'backfilling') backfilling += 1
    else if (m.status === 'watching') watching += 1
    else if (m.status === 'paused') paused += 1
    else if (m.status === 'error') error += 1
  }
  return {
    total: list.length,
    filesImported,
    recordsAdded,
    recordsSkipped,
    backfilling,
    watching,
    paused,
    error,
  }
}

export function pushMonitorLog(input: {
  monitorId: string
  title?: string
  level?: MonitorLogLevel
  message: string
  delta?: MonitorLogEntry['delta']
}) {
  const store = loadStore()
  const entry: MonitorLogEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    monitorId: input.monitorId,
    title: input.title || input.monitorId.slice(0, 8),
    level: input.level || 'info',
    message: input.message,
    delta: input.delta,
  }
  store.logs.push(entry)
  if (store.logs.length > MAX_LOGS) store.logs.splice(0, store.logs.length - MAX_LOGS)
  schedulePersist()
  return entry
}

export function sampleMonitorSeries(force = false) {
  const now = Date.now()
  if (!force && now - lastSeriesAt < SERIES_MIN_GAP_MS) return null
  lastSeriesAt = now
  const agg = aggregateFromMonitors(readMonitors())
  const point: MonitorSeriesPoint = {
    t: now,
    filesImported: agg.filesImported,
    recordsAdded: agg.recordsAdded,
    recordsSkipped: agg.recordsSkipped,
    backfilling: agg.backfilling,
    watching: agg.watching,
  }
  const store = loadStore()
  const last = store.series[store.series.length - 1]
  if (
    last &&
    last.filesImported === point.filesImported &&
    last.recordsAdded === point.recordsAdded &&
    last.recordsSkipped === point.recordsSkipped &&
    last.backfilling === point.backfilling &&
    last.watching === point.watching
  ) {
    // still advance time so the live graph keeps a heartbeat while idle
    if (!force && now - last.t < 15_000) return last
  }
  store.series.push(point)
  if (store.series.length > MAX_SERIES) store.series.splice(0, store.series.length - MAX_SERIES)
  schedulePersist()
  return point
}

export function recordMonitorMutation(
  before: TelegramMonitor | null | undefined,
  after: TelegramMonitor,
  reason?: string,
) {
  if (!before) {
    pushMonitorLog({
      monitorId: after.id,
      title: after.title,
      level: 'success',
      message: reason || `Monitor ditambahkan · ${after.chatId || after.input}`,
    })
    sampleMonitorSeries(true)
    return
  }

  if (before.status !== after.status) {
    const level: MonitorLogLevel =
      after.status === 'error' ? 'error' : after.status === 'watching' ? 'success' : 'info'
    pushMonitorLog({
      monitorId: after.id,
      title: after.title,
      level,
      message:
        after.status === 'error' && after.error
          ? `Status → ${after.status}: ${after.error}`
          : `Status → ${after.status}${reason ? ` · ${reason}` : ''}`,
    })
  }

  const dFiles = (after.stats.filesImported || 0) - (before.stats.filesImported || 0)
  const dAdded = (after.stats.recordsAdded || 0) - (before.stats.recordsAdded || 0)
  const dSkip = (after.stats.recordsSkipped || 0) - (before.stats.recordsSkipped || 0)
  if (dFiles > 0 || dAdded > 0 || dSkip > 0) {
    pushMonitorLog({
      monitorId: after.id,
      title: after.title,
      level: 'success',
      message: `Import +${dFiles} file · +${dAdded} records${dSkip ? ` · skip ${dSkip}` : ''}`,
      delta: {
        files: dFiles || undefined,
        recordsAdded: dAdded || undefined,
        recordsSkipped: dSkip || undefined,
      },
    })
  }

  sampleMonitorSeries(before.status !== after.status)
}

export function recordMonitorRemoved(monitor: TelegramMonitor) {
  pushMonitorLog({
    monitorId: monitor.id,
    title: monitor.title,
    level: 'warn',
    message: 'Monitor dihapus',
  })
  sampleMonitorSeries(true)
}

export function getMonitorLiveSnapshot() {
  const monitors = readMonitors()
  const store = loadStore()
  // heartbeat + bootstrap so the live graph is never an empty dashed box
  sampleMonitorSeries(false)
  if (store.series.length === 0) {
    sampleMonitorSeries(true)
  }
  if (store.series.length === 1) {
    const only = store.series[0]!
    store.series.unshift({ ...only, t: only.t - 60_000 })
    schedulePersist()
  }
  const summary = aggregateFromMonitors(monitors)
  return {
    generatedAt: new Date().toISOString(),
    summary,
    monitors,
    series: store.series.slice(-LIVE_SERIES),
    logs: store.logs.slice(-LIVE_LOGS).reverse(),
  }
}
