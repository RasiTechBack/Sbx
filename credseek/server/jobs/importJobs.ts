import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { getPool, hasPostgres } from '../db/postgres.js'
import { enqueueImportJob } from '../redis.js'

export type ImportJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export type ImportJob = {
  id: string
  userId?: string
  kind: 'file' | 'url' | 'text'
  status: ImportJobStatus
  payload: Record<string, unknown>
  progress: Record<string, unknown>
  error?: string
  createdAt: string
  updatedAt: string
}

const memoryJobs = new Map<string, ImportJob>()
const memoryStorePath = path.join(config.dataDir, 'import-jobs.json')

function ensureStaging() {
  fs.mkdirSync(config.importStagingDir, { recursive: true })
}

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true })
}

function persistMemoryJobs() {
  if (hasPostgres()) return
  try {
    ensureDataDir()
    const list = [...memoryJobs.values()]
    fs.writeFileSync(memoryStorePath, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

function loadMemoryJobs() {
  if (hasPostgres()) return
  try {
    if (!fs.existsSync(memoryStorePath)) return
    const list = JSON.parse(fs.readFileSync(memoryStorePath, 'utf8')) as ImportJob[]
    for (const job of list) {
      if (job?.id) memoryJobs.set(job.id, job)
    }
  } catch {
    /* ignore */
  }
}

loadMemoryJobs()

export function stagingPath(jobId: string, filename: string) {
  ensureStaging()
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_')
  return path.join(config.importStagingDir, `${jobId}__${safe}`)
}

function rowToJob(row: Record<string, any>): ImportJob {
  return {
    id: row.id,
    userId: row.user_id || undefined,
    kind: row.kind,
    status: row.status,
    payload: row.payload || {},
    progress: row.progress || {},
    error: row.error || undefined,
    createdAt: row.created_at?.toISOString?.() || String(row.created_at),
    updatedAt: row.updated_at?.toISOString?.() || String(row.updated_at),
  }
}

export async function createImportJob(input: {
  userId?: string
  kind: ImportJob['kind']
  payload: Record<string, unknown>
  enqueue?: boolean
}): Promise<ImportJob> {
  const now = new Date().toISOString()
  const job: ImportJob = {
    id: randomUUID(),
    userId: input.userId,
    kind: input.kind,
    status: 'queued',
    payload: input.payload,
    progress: { done: 0, total: 0, phase: 'queued', message: 'Menunggu antrean…' },
    createdAt: now,
    updatedAt: now,
  }

  if (hasPostgres()) {
    await getPool().query(
      `INSERT INTO import_jobs (id, user_id, kind, status, payload, progress, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [
        job.id,
        job.userId || null,
        job.kind,
        job.status,
        JSON.stringify(job.payload),
        JSON.stringify(job.progress),
        job.createdAt,
        job.updatedAt,
      ],
    )
  } else {
    memoryJobs.set(job.id, job)
    persistMemoryJobs()
  }

  if (input.enqueue !== false) {
    await enqueueImportJob(job.id)
  }
  return job
}

export async function enqueueExistingJob(jobId: string) {
  await enqueueImportJob(jobId)
}

export async function getImportJob(id: string): Promise<ImportJob | null> {
  if (hasPostgres()) {
    const res = await getPool().query('SELECT * FROM import_jobs WHERE id = $1', [id])
    const row = res.rows[0]
    if (!row) return null
    return rowToJob(row)
  }
  return memoryJobs.get(id) || null
}

export async function listImportJobs(opts?: {
  userId?: string
  statuses?: ImportJobStatus[]
  limit?: number
}): Promise<ImportJob[]> {
  const limit = Math.min(100, Math.max(1, opts?.limit || 40))
  const statuses = opts?.statuses

  if (hasPostgres()) {
    const params: unknown[] = []
    const where: string[] = []
    if (opts?.userId) {
      params.push(opts.userId)
      where.push(`user_id = $${params.length}`)
    }
    if (statuses?.length) {
      params.push(statuses)
      where.push(`status = ANY($${params.length})`)
    }
    params.push(limit)
    const sql = `SELECT * FROM import_jobs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`
    const res = await getPool().query(sql, params)
    return res.rows.map(rowToJob)
  }

  let list = [...memoryJobs.values()]
  if (opts?.userId) list = list.filter((j) => j.userId === opts.userId)
  if (statuses?.length) list = list.filter((j) => statuses.includes(j.status))
  return list
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
}

export async function patchImportJob(
  id: string,
  patch: Partial<Pick<ImportJob, 'status' | 'progress' | 'error' | 'payload'>>,
) {
  const existing = await getImportJob(id)
  if (!existing) return null
  const next: ImportJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  }

  if (hasPostgres()) {
    await getPool().query(
      `UPDATE import_jobs
       SET status=$2, progress=$3::jsonb, error=$4, payload=$5::jsonb, updated_at=$6
       WHERE id=$1`,
      [
        id,
        next.status,
        JSON.stringify(next.progress),
        next.error || null,
        JSON.stringify(next.payload),
        next.updatedAt,
      ],
    )
  } else {
    memoryJobs.set(id, next)
    persistMemoryJobs()
  }
  return next
}

/** After crash/restart: running → queued and re-enqueue. */
export async function reclaimStuckImportJobs() {
  const stuck = await listImportJobs({
    statuses: ['queued', 'running'],
    limit: 100,
  })
  let n = 0
  for (const job of stuck) {
    if (job.status === 'running') {
      await patchImportJob(job.id, {
        status: 'queued',
        progress: {
          ...job.progress,
          phase: 'queued',
          message: 'Diantrekan ulang setelah restart…',
        },
      })
    }
    await enqueueImportJob(job.id)
    n += 1
  }
  return n
}
