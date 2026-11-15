import Redis from 'ioredis'
import { config } from './config.js'

let redis: Redis | null = null
let memoryFallback = new Map<string, { value: string; expiresAt?: number }>()

export function hasRedis() {
  return Boolean(config.redisUrl)
}

export function getRedis() {
  if (!config.redisUrl) return null
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    })
    redis.on('error', (err) => {
      console.warn('[redis]', err.message)
    })
  }
  return redis
}

async function memGet(key: string) {
  const hit = memoryFallback.get(key)
  if (!hit) return null
  if (hit.expiresAt && hit.expiresAt < Date.now()) {
    memoryFallback.delete(key)
    return null
  }
  return hit.value
}

async function memSet(key: string, value: string, ttlSec?: number) {
  memoryFallback.set(key, {
    value,
    expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : undefined,
  })
}

export async function cacheGet(key: string): Promise<string | null> {
  const r = getRedis()
  if (r) {
    try {
      return await r.get(key)
    } catch {
      /* fall through */
    }
  }
  return memGet(key)
}

export async function cacheSet(key: string, value: string, ttlSec = 60) {
  const r = getRedis()
  if (r) {
    try {
      await r.set(key, value, 'EX', ttlSec)
      return
    } catch {
      /* fall through */
    }
  }
  await memSet(key, value, ttlSec)
}

export async function cacheDel(key: string) {
  const r = getRedis()
  if (r) {
    try {
      await r.del(key)
    } catch {
      /* ignore */
    }
  }
  memoryFallback.delete(key)
}

/** Sliding-window style fixed window counter. Returns remaining + whether limited. */
export async function rateLimit(opts: {
  key: string
  limit: number
  windowSec: number
}): Promise<{ ok: boolean; remaining: number; resetSec: number }> {
  const r = getRedis()
  const fullKey = `rl:${opts.key}`
  if (r) {
    try {
      const count = await r.incr(fullKey)
      if (count === 1) await r.expire(fullKey, opts.windowSec)
      const ttl = await r.ttl(fullKey)
      const remaining = Math.max(0, opts.limit - count)
      return {
        ok: count <= opts.limit,
        remaining,
        resetSec: ttl > 0 ? ttl : opts.windowSec,
      }
    } catch {
      /* fall through to memory */
    }
  }

  const raw = await memGet(fullKey)
  const count = (raw ? Number(raw) : 0) + 1
  await memSet(fullKey, String(count), opts.windowSec)
  return {
    ok: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    resetSec: opts.windowSec,
  }
}

export const IMPORT_QUEUE_KEY = 'credseek:import:queue'

export async function enqueueImportJob(jobId: string) {
  const r = getRedis()
  if (r) {
    await r.lpush(IMPORT_QUEUE_KEY, jobId)
    return
  }
  // memory fallback: store as list in one key
  const raw = (await memGet(IMPORT_QUEUE_KEY)) || '[]'
  const list = JSON.parse(raw) as string[]
  list.unshift(jobId)
  await memSet(IMPORT_QUEUE_KEY, JSON.stringify(list))
}

export async function dequeueImportJob(blockSec = 5): Promise<string | null> {
  const r = getRedis()
  if (r) {
    const res = await r.brpop(IMPORT_QUEUE_KEY, blockSec)
    return res?.[1] ?? null
  }
  const raw = (await memGet(IMPORT_QUEUE_KEY)) || '[]'
  const list = JSON.parse(raw) as string[]
  const jobId = list.pop() || null
  await memSet(IMPORT_QUEUE_KEY, JSON.stringify(list))
  if (!jobId && blockSec > 0) {
    await new Promise((r) => setTimeout(r, Math.min(blockSec, 1) * 1000))
  }
  return jobId
}

export async function closeRedis() {
  if (redis) {
    await redis.quit()
    redis = null
  }
}
