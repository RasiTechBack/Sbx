export type ImportPhase = 'receive' | 'parse' | 'insert' | 'done'

export type ImportProgressEvent = {
  type: 'progress'
  phase: ImportPhase
  /** 0–100 within the current phase */
  pct: number
  /** 0–100 overall for this file (upload already done → parse+insert) */
  overallPct: number
  message: string
  done?: number
  total?: number
  found?: number
  added?: number
  skipped?: number
  detail?: string
}

export type ImportProgressFn = (ev: Omit<ImportProgressEvent, 'type' | 'overallPct'> & {
  overallPct?: number
}) => void

export function mapOverallPct(phase: ImportPhase, phasePct: number): number {
  const p = Math.max(0, Math.min(100, phasePct))
  if (phase === 'receive') return Math.round(p * 0.05)
  if (phase === 'parse') return Math.round(5 + p * 0.5)
  if (phase === 'insert') return Math.round(55 + p * 0.45)
  return 100
}

/** Throttle progress emissions so huge files don't flood the socket. */
export function createProgressThrottler(
  emit: ImportProgressFn,
  minIntervalMs = 200,
): ImportProgressFn {
  let lastAt = 0
  let lastKey = ''
  let pending: Parameters<ImportProgressFn>[0] | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    if (!pending) return
    const ev = pending
    pending = null
    lastAt = Date.now()
    lastKey = `${ev.phase}:${Math.floor(ev.pct / 5)}`
    emit(ev)
  }

  return (ev) => {
    const key = `${ev.phase}:${Math.floor(ev.pct / 5)}`
    const now = Date.now()
    const force = ev.pct >= 100 || ev.phase === 'done' || key !== lastKey
    pending = ev
    if (force || now - lastAt >= minIntervalMs) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      flush()
      return
    }
    if (!timer) timer = setTimeout(flush, minIntervalMs - (now - lastAt))
  }
}
