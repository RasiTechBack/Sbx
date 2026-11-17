/** Tiny in-memory TTL cache for hot search/dashboard reads. */

type Entry<T> = { value: T; expiresAt: number }

export function createTtlCache<T>(opts?: { maxEntries?: number; defaultTtlMs?: number }) {
  const maxEntries = Math.max(8, opts?.maxEntries ?? 200)
  const defaultTtlMs = Math.max(250, opts?.defaultTtlMs ?? 45_000)
  const map = new Map<string, Entry<T>>()

  function prune(now: number) {
    for (const [k, v] of map) {
      if (v.expiresAt <= now) map.delete(k)
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  return {
    get(key: string): T | undefined {
      const now = Date.now()
      const hit = map.get(key)
      if (!hit) return undefined
      if (hit.expiresAt <= now) {
        map.delete(key)
        return undefined
      }
      // refresh insertion order (Map preserves order)
      map.delete(key)
      map.set(key, hit)
      return hit.value
    },
    set(key: string, value: T, ttlMs = defaultTtlMs) {
      const now = Date.now()
      prune(now)
      map.set(key, { value, expiresAt: now + ttlMs })
    },
    clear() {
      map.clear()
    },
    size() {
      return map.size
    },
  }
}
