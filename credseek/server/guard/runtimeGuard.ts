import { monitorEventLoopDelay } from 'node:perf_hooks'

export type GuardLimits = {
  /** Process RSS soft limit — exit so PM2 can restart. */
  maxRssMb: number
  /** V8 heap used soft limit. */
  maxHeapMb: number
  /** Event-loop p99 delay threshold (ms) before counting a strike. */
  maxLoopDelayMs: number
  /** Consecutive loop-delay strikes before exit. */
  loopStrikes: number
  /** How often to sample. */
  intervalMs: number
}

const defaults: GuardLimits = {
  maxRssMb: Number(process.env.GUARD_MAX_RSS_MB) || 1500,
  maxHeapMb: Number(process.env.GUARD_MAX_HEAP_MB) || 1200,
  maxLoopDelayMs: Number(process.env.GUARD_MAX_LOOP_MS) || 20_000,
  loopStrikes: Number(process.env.GUARD_LOOP_STRIKES) || 8,
  intervalMs: Number(process.env.GUARD_INTERVAL_MS) || 15_000,
}

let started = false
let loopHits = 0
let lastSample = {
  rssMb: 0,
  heapMb: 0,
  loopP99Ms: 0,
  at: '',
}

export function getGuardSample() {
  return { ...lastSample, loopHits }
}

/**
 * In-process safety net: OOM-ish memory / event-loop freeze → exit(1)
 * so PM2 autorestart kicks in before the host becomes unresponsive.
 */
export function startRuntimeGuard(limits: Partial<GuardLimits> = {}) {
  if (started) return
  started = true
  const cfg = { ...defaults, ...limits }

  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  console.log(
    `[guard] runtime armed · rss≤${cfg.maxRssMb}MB heap≤${cfg.maxHeapMb}MB loopP99≤${cfg.maxLoopDelayMs}ms`,
  )

  setInterval(() => {
    const mem = process.memoryUsage()
    const rssMb = Math.round(mem.rss / (1024 * 1024))
    const heapMb = Math.round(mem.heapUsed / (1024 * 1024))
    const loopP99Ms = Math.round(histogram.percentile(99) / 1e6)
    histogram.reset()

    lastSample = {
      rssMb,
      heapMb,
      loopP99Ms,
      at: new Date().toISOString(),
    }

    if (loopP99Ms >= cfg.maxLoopDelayMs) {
      loopHits += 1
      console.warn(
        `[guard] event-loop lag ${loopP99Ms}ms (strike ${loopHits}/${cfg.loopStrikes}) rss=${rssMb}MB`,
      )
    } else {
      loopHits = 0
    }

    const reason =
      rssMb >= cfg.maxRssMb
        ? `RSS ${rssMb}MB ≥ ${cfg.maxRssMb}MB`
        : heapMb >= cfg.maxHeapMb
          ? `heap ${heapMb}MB ≥ ${cfg.maxHeapMb}MB`
          : loopHits >= cfg.loopStrikes
            ? `event-loop lag ×${loopHits} (p99 ${loopP99Ms}ms)`
            : null

    if (!reason) return

    console.error(`[guard] restarting process — ${reason}`)
    // Give logs a tick to flush, then hard-exit for PM2.
    setTimeout(() => process.exit(1), 200)
  }, cfg.intervalMs).unref()
}
