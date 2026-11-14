/**
 * Optional dedicated import worker — drains Redis/memory queue.
 * Prefer in-process runner in the API (`startImportJobRunner`) when Redis is absent.
 * Run: npm run worker:import
 */
import { config } from '../config.js'
import { initPostgres, hasPostgres } from '../db/postgres.js'
import { initRecordsDb } from '../db/recordsDb.js'
import { processImportJob } from '../jobs/processImportJob.js'
import { reclaimStuckImportJobs } from '../jobs/importJobs.js'
import { dequeueImportJob } from '../redis.js'
import { initSearchBackend } from '../search/backend.js'

async function main() {
  console.log(`Import worker starting (SEARCH_BACKEND=${config.searchBackend})`)
  if (hasPostgres()) await initPostgres()
  if (config.searchBackend === 'sqlite') initRecordsDb()
  await initSearchBackend()
  const requeued = await reclaimStuckImportJobs()
  if (requeued) console.log(`Requeued ${requeued} stuck job(s)`)

  for (;;) {
    const jobId = await dequeueImportJob(5)
    if (!jobId) continue
    console.log('Processing job', jobId)
    await processImportJob(jobId)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
