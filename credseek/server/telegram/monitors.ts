import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const monitorsPath = path.join(__dirname, '..', 'data', 'telegram-monitors.json')

export type MonitorStatus = 'idle' | 'backfilling' | 'watching' | 'paused' | 'error'

export type TelegramMonitor = {
  id: string
  input: string
  chatId: string
  title: string
  username?: string
  status: MonitorStatus
  backfillDone: boolean
  lastMessageId: number
  lastSyncAt?: string
  error?: string
  /** Live backfill/download hint shown in the Monitoring UI. */
  progressNote?: string
  stats: {
    filesImported: number
    recordsAdded: number
    recordsSkipped: number
    /** Document messages seen during backfill/live (including skipped). */
    docsSeen?: number
  }
  createdAt: string
  updatedAt: string
}

function ensure() {
  const dir = path.dirname(monitorsPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(monitorsPath)) fs.writeFileSync(monitorsPath, '[]', 'utf8')
}

/** In-memory source of truth — avoids lost updates from disk read/modify/write races. */
let monitorsCache: TelegramMonitor[] | null = null

function loadCache(): TelegramMonitor[] {
  if (monitorsCache) return monitorsCache
  ensure()
  try {
    monitorsCache = JSON.parse(fs.readFileSync(monitorsPath, 'utf8')) as TelegramMonitor[]
  } catch {
    monitorsCache = []
  }
  return monitorsCache
}

function persistCache() {
  ensure()
  fs.writeFileSync(monitorsPath, JSON.stringify(loadCache(), null, 2), 'utf8')
}

export function readMonitors(): TelegramMonitor[] {
  return loadCache()
}

export function writeMonitors(list: TelegramMonitor[]) {
  monitorsCache = list
  persistCache()
}

export function getMonitor(id: string) {
  return loadCache().find((m) => m.id === id) || null
}

export function upsertMonitor(monitor: TelegramMonitor) {
  const list = loadCache()
  const idx = list.findIndex((m) => m.id === monitor.id)
  const before = idx >= 0 ? list[idx] : null
  if (idx >= 0) list[idx] = monitor
  else list.unshift(monitor)
  persistCache()
  void import('./activity.js')
    .then(({ recordMonitorMutation }) => {
      recordMonitorMutation(before, monitor, before ? 'Updated' : undefined)
    })
    .catch(() => undefined)
  return monitor
}

export function patchMonitor(id: string, patch: Partial<TelegramMonitor>) {
  const list = loadCache()
  const idx = list.findIndex((m) => m.id === id)
  if (idx < 0) return null
  const before = list[idx]!
  const next = {
    ...before,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  list[idx] = next
  persistCache()
  void import('./activity.js')
    .then(({ recordMonitorMutation }) => {
      recordMonitorMutation(before, next)
    })
    .catch(() => undefined)
  return next
}

export function removeMonitor(id: string) {
  const list = loadCache()
  const removed = list.find((m) => m.id === id)
  const next = list.filter((m) => m.id !== id)
  monitorsCache = next
  persistCache()
  if (removed) {
    void import('./activity.js')
      .then(({ recordMonitorRemoved }) => {
        recordMonitorRemoved(removed)
      })
      .catch(() => undefined)
  }
  return list.length !== next.length
}

export function createMonitorDraft(input: string): TelegramMonitor {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    input: input.trim(),
    chatId: '',
    title: input.trim(),
    status: 'idle',
    backfillDone: false,
    lastMessageId: 0,
    stats: { filesImported: 0, recordsAdded: 0, recordsSkipped: 0 },
    createdAt: now,
    updatedAt: now,
  }
}
