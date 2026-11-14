import { dequeueImportJob } from '../redis.js'
import { processImportJob } from './processImportJob.js'
import { reclaimStuckImportJobs } from './importJobs.js'

let started = false

/**
 * Drain the import queue inside the API process.
 * Works with memory fallback (no Redis) and also with Redis if a separate
 * worker is not running — duplicate claim is safe via job status checks.
 */
export function startImportJobRunner() {
  if (started) return
  started = true
  console.log('[import-runner] armed (in-process queue drain)')

  void reclaimStuckImportJobs()
    .then((n) => {
      if (n > 0) console.log(`[import-runner] requeued ${n} stuck job(s)`)
    })
    .catch((err) => console.warn('[import-runner] reclaim failed', err))

  const tick = async () => {
    let jobId: string | null = null
    try {
      jobId = await dequeueImportJob(0)
      if (jobId) {
        console.log('[import-runner] processing', jobId)
        await processImportJob(jobId)
      }
    } catch (err) {
      console.error('[import-runner]', err instanceof Error ? err.message : err)
    }
    setTimeout(() => void tick(), jobId ? 100 : 1200)
  }
  void tick()
}
