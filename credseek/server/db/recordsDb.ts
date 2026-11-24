import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import chain from 'stream-chain'
import { parser } from 'stream-json'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import { credentialDedupeKey, type RecordItem } from '../store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const dbPath = path.join(dataDir, 'records.db')
const jsonPath = path.join(dataDir, 'records.json')
const jsonMigratedPath = path.join(dataDir, 'records.json.migrated')

export type SearchFilter = 'all' | 'url' | 'username' | 'password' | 'domain'

type SearchHit = RecordItem

export const MIN_SEARCH_TOKEN_LEN = 3
export const MAX_SEARCH_OFFSET = 10_000
/** Smaller chunks = shorter write locks + event-loop yields keep the web responsive. */
export const INSERT_CHUNK_SIZE = 4_000
export const EXCEL_EXPORT_CAP = 100_000
export const DASHBOARD_CACHE_TTL_MS = 10 * 60 * 1000
const FTS_SCHEMA_VERSION = '3'
let dashboardRefreshInFlight = false
let bulkImportDepth = 0
let recordsCountCache: number | null = null
/** Serialize writers — TG stream + Import jobs share one SQLite connection. */
let writeChain: Promise<unknown> = Promise.resolve()

let db: DatabaseSync

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function extractDomain(url: string) {
  let s = String(url || '').trim().toLowerCase()
  if (!s) return ''
  // Fast path: strip scheme / userinfo / path without URL() constructor.
  const scheme = s.indexOf('://')
  if (scheme >= 0) s = s.slice(scheme + 3)
  else if (s.startsWith('//')) s = s.slice(2)
  const slash = s.indexOf('/')
  const at = s.indexOf('@')
  if (at >= 0 && (slash < 0 || at < slash)) s = s.slice(at + 1)
  const cutSlash = s.indexOf('/')
  if (cutSlash >= 0) s = s.slice(0, cutSlash)
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  return s
}

function extractProtocol(url: string) {
  const m = String(url || '').match(/^([a-z][a-z0-9+.-]*):\/\//i)
  return m ? m[1]!.toLowerCase() : 'other'
}

function enterBulkImport() {
  bulkImportDepth += 1
  if (bulkImportDepth !== 1) return
  try {
    db.exec(`
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -524288;
      PRAGMA wal_autocheckpoint = 20000;
      PRAGMA mmap_size = 536870912;
    `)
  } catch {
    /* ignore */
  }
}

function leaveBulkImport() {
  if (bulkImportDepth <= 0) return
  bulkImportDepth -= 1
  if (bulkImportDepth !== 0) return
  try {
    db.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -196000;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA mmap_size = 268435456;
    `)
  } catch {
    /* ignore */
  }
}

function rowToRecord(row: Record<string, unknown>): RecordItem {
  return {
    id: String(row.id ?? ''),
    isi: String(row.isi ?? ''),
    database: String(row.database_name ?? ''),
    url: String(row.url ?? ''),
    username: String(row.username ?? ''),
    password: String(row.password ?? ''),
    raw: String(row.raw ?? ''),
    importedAt: String(row.imported_at ?? ''),
  }
}

function escapeFtsToken(token: string) {
  return `"${token.replace(/"/g, '""')}"`
}

/** Columns to search for a filter / auto-detected intent. */
type FtsColumn = 'url' | 'username' | 'password' | 'domain'

function buildFtsQuery(tokens: string[], columns: FtsColumn[] | 'all') {
  const parts = tokens.map((t) => {
    const q = escapeFtsToken(t)
    if (columns === 'all' || columns.length === 0) return q
    if (columns.length === 1) return `${columns[0]} : ${q}`
    return `{${columns.join(' ')}} : ${q}`
  })
  return parts.join(' AND ')
}

function isEmailLike(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

function isIpv4Like(s: string) {
  return /^(?:\d{1,3}\.){1,3}\d{1,3}$/.test(s)
}

function isDomainLike(s: string) {
  return (
    !s.includes('/') &&
    !s.includes(':') &&
    !s.includes('@') &&
    /^[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]*[a-z]$/i.test(s)
  )
}

/** Strip scheme/path/userinfo so URL pastes become searchable hosts. */
function normalizeSearchText(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (!s) return s
  // emails / bare tokens stay as-is
  if (s.includes('@') && !s.includes('://') && !s.includes('/')) return s
  // URL / host/path pastes → host only (credential dumps key on host)
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : s.includes('/') ? `https://${s}` : ''
    if (withScheme) {
      const u = new URL(withScheme)
      if (u.host) return u.host.toLowerCase()
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      const u = new URL(s)
      if (u.host) return u.host.toLowerCase()
    }
  } catch {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  }
  s = s.replace(/^[^/@]+@/, '')
  const slash = s.indexOf('/')
  if (slash > 0) s = s.slice(0, slash)
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function isBareKeyword(token: string) {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(token)
}

function resolveFtsColumns(filter: SearchFilter, tokens: string[]): FtsColumn[] | 'all' {
  if (filter === 'url') return ['url']
  if (filter === 'username') return ['username']
  if (filter === 'password') return ['password']
  if (filter === 'domain') return ['domain']
  // filter=all — narrow when intent is obvious (faster + better precision)
  if (tokens.length === 1) {
    const t = tokens[0]!
    if (isEmailLike(t)) return ['username', 'url']
    if (isIpv4Like(t)) return ['url', 'domain']
    if (isDomainLike(t)) return ['domain', 'url']
    // Bare keywords: domain+url only (skip username/password — cheaper + better intent).
    if (isBareKeyword(t)) return ['domain', 'url']
  }
  return ['url', 'username', 'domain']
}

function mapProbe(rows: Record<string, unknown>[], limit: number) {
  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  return {
    hasMore,
    rows: sliced.map(rowToRecord),
    totalExtra: hasMore ? 1 : 0,
  }
}

function getMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value?: string }
    | undefined
  return row?.value ?? null
}

function setMeta(key: string, value: string) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

function ensureSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA cache_size = -196000;
    PRAGMA busy_timeout = 8000;
    PRAGMA wal_autocheckpoint = 1000;

    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      isi TEXT NOT NULL DEFAULT '',
      database_name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      raw TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      domain_lc TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'other'
    );

    CREATE INDEX IF NOT EXISTS idx_records_imported ON records(imported_at);
    CREATE INDEX IF NOT EXISTS idx_records_imported_id ON records(imported_at, id);
    CREATE INDEX IF NOT EXISTS idx_records_domain ON records(domain_lc);
    CREATE INDEX IF NOT EXISTS idx_records_protocol ON records(protocol);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domains (
      domain_lc TEXT PRIMARY KEY
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      id UNINDEXED,
      isi UNINDEXED,
      database_name UNINDEXED,
      url,
      username,
      password,
      domain,
      raw UNINDEXED,
      imported_at UNINDEXED,
      tokenize = 'trigram'
    );

    CREATE TABLE IF NOT EXISTS url_enrichment (
      url_key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      domain_lc TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      body_excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      http_status INTEGER,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_enrich_domain ON url_enrichment(domain_lc);
    CREATE INDEX IF NOT EXISTS idx_enrich_status ON url_enrichment(status);
    CREATE INDEX IF NOT EXISTS idx_enrich_fetched ON url_enrichment(fetched_at);

    CREATE TABLE IF NOT EXISTS domain_dns (
      domain_lc TEXT PRIMARY KEY,
      ipv4 TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dns_ipv4 ON domain_dns(ipv4);
    CREATE INDEX IF NOT EXISTS idx_dns_resolved ON domain_dns(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_dns_status ON domain_dns(status);

    CREATE VIRTUAL TABLE IF NOT EXISTS url_enrichment_fts USING fts5(
      url_key UNINDEXED,
      domain,
      title,
      description,
      body_excerpt,
      tokenize = 'trigram'
    );
  `)

  const ftsVersion = String(getMeta('fts_schema') ?? '')
  if (ftsVersion !== FTS_SCHEMA_VERSION) {
    console.log(`Upgrading FTS schema → v${FTS_SCHEMA_VERSION} (lean trigram, no hay)…`)
    database.exec('DROP TABLE IF EXISTS records_fts')
    database.exec(`
      CREATE VIRTUAL TABLE records_fts USING fts5(
        id UNINDEXED,
        isi UNINDEXED,
        database_name UNINDEXED,
        url,
        username,
        password,
        domain,
        raw UNINDEXED,
        imported_at UNINDEXED,
        tokenize = 'trigram'
      );
    `)
    rebuildFtsIndex()
    setMeta('fts_schema', FTS_SCHEMA_VERSION)
    invalidateDashboardCache()
  }

}

function openDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(dbPath)
  ensureSchema(db)
}

function prepareRecordFields(
  item: Omit<RecordItem, 'id' | 'importedAt'> & { id?: string; importedAt?: string },
  sharedImportedAt?: string,
) {
  const id = item.id || randomUUID()
  const importedAt = item.importedAt || sharedImportedAt || new Date().toISOString()
  const dedupe = credentialDedupeKey(item)
  const domain = extractDomain(item.url)
  const protocol = extractProtocol(item.url)
  return {
    id,
    importedAt,
    dedupe,
    domain,
    protocol,
    isi: item.isi || '',
    database: item.database || '',
    url: item.url,
    username: item.username,
    password: item.password,
    raw: item.raw,
  }
}

let insertRecordStmt: ReturnType<DatabaseSync['prepare']> | null = null
let insertFtsStmt: ReturnType<DatabaseSync['prepare']> | null = null
let insertDomainStmt: ReturnType<DatabaseSync['prepare']> | null = null

function getInsertStmts() {
  if (!insertRecordStmt) {
    insertRecordStmt = db.prepare(
      `INSERT OR IGNORE INTO records
      (id, isi, database_name, url, username, password, raw, imported_at, dedupe_key, domain_lc, protocol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
  }
  if (!insertFtsStmt) {
    insertFtsStmt = db.prepare(
      `INSERT INTO records_fts
        (id, isi, database_name, url, username, password, domain, raw, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
  }
  if (!insertDomainStmt) {
    insertDomainStmt = db.prepare(`INSERT OR IGNORE INTO domains(domain_lc) VALUES (?)`)
  }
  return { insertRecordStmt, insertFtsStmt, insertDomainStmt }
}

function insertOne(
  item: Omit<RecordItem, 'id' | 'importedAt'> & { id?: string; importedAt?: string },
  opts: { indexFts?: boolean } = { indexFts: true },
) {
  const f = prepareRecordFields(item)
  const { insertRecordStmt: ins, insertFtsStmt: fts, insertDomainStmt: dom } = getInsertStmts()
  const info = ins.run(
    f.id,
    f.isi,
    f.database,
    f.url,
    f.username,
    f.password,
    f.raw,
    f.importedAt,
    f.dedupe,
    f.domain,
    f.protocol,
  )

  if (Number(info.changes) > 0) {
    if (f.domain) dom.run(f.domain)
    if (opts.indexFts !== false) {
      fts.run(
        f.id,
        f.isi,
        f.database,
        f.url.toLowerCase(),
        f.username.toLowerCase(),
        f.password,
        f.domain,
        f.raw,
        f.importedAt,
      )
    }
    return true
  }
  return false
}

function rebuildFtsIndex() {
  console.log('Building FTS5 trigram index (v3 lean)…')
  insertFtsStmt = null
  db.exec('DELETE FROM records_fts')
  db.exec(`
    INSERT INTO records_fts
      (id, isi, database_name, url, username, password, domain, raw, imported_at)
    SELECT
      id,
      isi,
      database_name,
      lower(url),
      lower(username),
      password,
      domain_lc,
      raw,
      imported_at
    FROM records
  `)
  console.log('FTS5 index ready')
}

export async function migrateJsonToSqliteIfNeeded(): Promise<{
  migrated: boolean
  count: number
  inserted?: number
}> {
  openDb()
  const count = Number(db.prepare('SELECT COUNT(*) AS c FROM records').get()?.c ?? 0)
  if (!fs.existsSync(jsonPath)) return { migrated: false, count }

  if (count > 0) {
    console.log(`SQLite already has ${count.toLocaleString()} records; skipping JSON migrate`)
    return { migrated: false, count }
  }

  const sizeMb = (fs.statSync(jsonPath).size / (1024 * 1024)).toFixed(1)
  console.log(`Migrating records.json (${sizeMb} MB) → SQLite (streaming)…`)

  return await new Promise<{ migrated: boolean; count: number; inserted: number }>((resolve, reject) => {
    let inserted = 0
    let seen = 0
    db.exec('PRAGMA synchronous = OFF')
    const pipeline = chain([fs.createReadStream(jsonPath), parser(), streamArray()])
    db.exec('BEGIN')

    pipeline.on('data', ({ value }: { value: Partial<RecordItem> }) => {
      seen += 1
      try {
        if (!value?.url || !value?.username) return
        const ok = insertOne(
          {
            id: value.id,
            isi: value.isi || '',
            database: value.database || '',
            url: value.url,
            username: value.username,
            password: value.password || '',
            raw: value.raw || `${value.url}:${value.username}:${value.password || ''}`,
            importedAt: value.importedAt,
          },
          { indexFts: false },
        )
        if (ok) inserted += 1
      } catch (err) {
        pipeline.destroy(err instanceof Error ? err : new Error(String(err)))
        return
      }

      if (seen % 50000 === 0) {
        db.exec('COMMIT')
        db.exec('BEGIN')
        console.log(`  … ${seen.toLocaleString()} scanned, ${inserted.toLocaleString()} inserted`)
      }
    })

    pipeline.on('end', () => {
      try {
        db.exec('COMMIT')
        rebuildFtsIndex()
        db.exec('PRAGMA synchronous = NORMAL')
        fs.renameSync(jsonPath, jsonMigratedPath)
        const finalCount = Number(db.prepare('SELECT COUNT(*) AS c FROM records').get()?.c ?? 0)
        invalidateDashboardCache()
        console.log(
          `Migration done: ${inserted.toLocaleString()} inserted, total ${finalCount.toLocaleString()}. JSON renamed to records.json.migrated`,
        )
        resolve({ migrated: true, count: finalCount, inserted })
      } catch (err) {
        reject(err)
      }
    })

    pipeline.on('error', (err: Error) => {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      reject(err)
    })
  })
}

export function initRecordsDb() {
  openDb()
}

export function getRecordsCount() {
  if (recordsCountCache != null) return recordsCountCache
  const n = Number(db.prepare('SELECT COUNT(*) AS c FROM records').get()?.c ?? 0)
  recordsCountCache = n
  return n
}

/** On-disk size of records.db including WAL/SHM sidecars (bytes). */
export function getRecordsDbSizeBytes() {
  let total = 0
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      total += fs.statSync(p).size
    } catch {
      /* missing sidecar */
    }
  }
  return total
}

const GB = 1024 * 1024 * 1024

export type DbStorageGuard = {
  usedBytes: number
  maxBytes: number
  maxGb: number
  pct: number
  paused: boolean
  message: string
}

function defaultMaxDbBytes() {
  // Lazy import avoided — config is light; keep recordsDb free of circular deps via env mirror.
  const rawBytes = Number(process.env.MAX_DB_BYTES || '')
  if (Number.isFinite(rawBytes) && rawBytes > 0) return Math.floor(rawBytes)
  const rawGb = Number(process.env.MAX_DB_GB || '70')
  const gb = Number.isFinite(rawGb) && rawGb > 0 ? rawGb : 70
  return Math.floor(gb * GB)
}

export function getMaxDbBytes() {
  const meta = getMeta('max_db_bytes')
  if (meta != null && meta !== '') {
    const n = Number(meta)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return defaultMaxDbBytes()
}

export function setMaxDbBytes(bytes: number) {
  const n = Math.floor(Number(bytes))
  if (!Number.isFinite(n) || n < GB) {
    throw new Error('Batas database minimal 1 GB')
  }
  // Soft upper bound so a typo cannot claim petabytes
  if (n > 500 * GB) {
    throw new Error('Batas database maksimal 500 GB')
  }
  setMeta('max_db_bytes', String(n))
  return getDbStorageGuard()
}

export function setMaxDbGb(gb: number) {
  const n = Number(gb)
  if (!Number.isFinite(n) || n < 1) throw new Error('Batas database minimal 1 GB')
  return setMaxDbBytes(n * GB)
}

export function getDbStorageGuard(): DbStorageGuard {
  const usedBytes = getRecordsDbSizeBytes()
  const maxBytes = getMaxDbBytes()
  const maxGb = Math.round((maxBytes / GB) * 100) / 100
  const pct =
    maxBytes > 0 ? Math.min(100, Math.round((usedBytes / maxBytes) * 1000) / 10) : 0
  const paused = usedBytes >= maxBytes
  const usedGb = Math.round((usedBytes / GB) * 100) / 100
  return {
    usedBytes,
    maxBytes,
    maxGb,
    pct,
    paused,
    message: paused
      ? `Import di-pause: database ${usedGb} GB ≥ batas ${maxGb} GB (sisa storage VPS). Hapus data atau naikkan batas di Settings.`
      : `Database ${usedGb} GB / ${maxGb} GB (${pct}%)`,
  }
}

export class ImportPausedError extends Error {
  readonly code = 'IMPORT_PAUSED'
  readonly status = 507
  constructor(message?: string) {
    super(message || getDbStorageGuard().message)
    this.name = 'ImportPausedError'
  }
}

export function assertImportsAllowed() {
  const guard = getDbStorageGuard()
  if (guard.paused) throw new ImportPausedError(guard.message)
  return guard
}

export function clearAllRecords() {
  db.exec(`
    DELETE FROM records_fts;
    DELETE FROM records;
    DELETE FROM domains;
    DELETE FROM url_enrichment_fts;
    DELETE FROM url_enrichment;
    DELETE FROM domain_dns;
  `)
  recordsCountCache = 0
  invalidateDashboardCache()
  setMeta('stats_total', '0')
  setMeta('enrich_url_cursor', '0')
}

export function optimizeDatabase() {
  try {
    db.exec('PRAGMA optimize')
    db.exec('PRAGMA wal_checkpoint(PASSIVE)')
  } catch {
    /* ignore optimize failures */
  }
}

/**
 * High-throughput credential insert:
 * - bulk PRAGMAs (sync OFF) while importing
 * - records + domains first, then one FTS INSERT…SELECT per chunk (not per row)
 * - avoids COUNT(*) on the hot path
 */
export type InsertProgressFn = (p: {
  phase: 'insert'
  pct: number
  message: string
  done: number
  total: number
  added: number
  skipped: number
}) => void

export async function insertCredentials(
  items: Array<Omit<RecordItem, 'id' | 'importedAt'> & { id?: string; importedAt?: string }>,
  opts?: { onProgress?: InsertProgressFn },
) {
  if (!items.length) return { added: 0, skipped: 0, total: getTotalFast() }

  return withWriteLock(async () => {
    const { yieldEventLoop } = await import('../util/yield.js')

    let added = 0
    let skipped = 0
    const total = items.length
    const onProgress = opts?.onProgress
    const sharedImportedAt = new Date().toISOString()
    onProgress?.({
      phase: 'insert',
      pct: 0,
      message: `Insert mulai · ${total.toLocaleString('id-ID')} rows`,
      done: 0,
      total,
      added: 0,
      skipped: 0,
    })
    // Yield once before locking so pending HTTP can flush.
    await yieldEventLoop()
    enterBulkImport()

    try {
      db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS bulk_added (
        id TEXT PRIMARY KEY,
        isi TEXT NOT NULL,
        database_name TEXT NOT NULL,
        url TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        domain TEXT NOT NULL,
        raw TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      DELETE FROM bulk_added;
    `)

      const { insertRecordStmt: ins, insertDomainStmt: dom } = getInsertStmts()
      const insBulk = db.prepare(
        `INSERT INTO bulk_added
        (id, isi, database_name, url, username, password, domain, raw, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const flushFts = db.prepare(`
      INSERT INTO records_fts
        (id, isi, database_name, url, username, password, domain, raw, imported_at)
      SELECT
        id,
        isi,
        database_name,
        lower(url),
        lower(username),
        password,
        domain,
        raw,
        imported_at
      FROM bulk_added
    `)
      const clearBulk = db.prepare('DELETE FROM bulk_added')
      const begin = db.prepare('BEGIN IMMEDIATE')
      const commit = db.prepare('COMMIT')
      const rollback = db.prepare('ROLLBACK')

      for (let i = 0; i < items.length; i += INSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + INSERT_CHUNK_SIZE)
        let began = false
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            begin.run()
            began = true
            for (const item of chunk) {
              const f = prepareRecordFields(item, sharedImportedAt)
              const info = ins.run(
                f.id,
                f.isi,
                f.database,
                f.url,
                f.username,
                f.password,
                f.raw,
                f.importedAt,
                f.dedupe,
                f.domain,
                f.protocol,
              )
              if (Number(info.changes) > 0) {
                added += 1
                if (f.domain) dom.run(f.domain)
                insBulk.run(
                  f.id,
                  f.isi,
                  f.database,
                  f.url,
                  f.username,
                  f.password,
                  f.domain,
                  f.raw,
                  f.importedAt,
                )
              } else {
                skipped += 1
              }
            }
            flushFts.run()
            clearBulk.run()
            commit.run()
            began = false
            break
          } catch (err) {
            if (began) {
              try {
                rollback.run()
              } catch {
                /* ignore */
              }
              began = false
            }
            const msg = err instanceof Error ? err.message : String(err)
            if (/database is locked|SQLITE_BUSY|busy/i.test(msg) && attempt < 7) {
              await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
              continue
            }
            throw err
          }
        }

        const done = Math.min(i + chunk.length, total)
        const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 100
        onProgress?.({
          phase: 'insert',
          pct,
          message: `Insert ${done.toLocaleString('id-ID')}/${total.toLocaleString('id-ID')} · +${added.toLocaleString('id-ID')} · skip ${skipped.toLocaleString('id-ID')}`,
          done,
          total,
          added,
          skipped,
        })
        // Release the event loop between chunks so search/static stay responsive.
        await yieldEventLoop()
      }
    } finally {
      leaveBulkImport()
    }

    if (recordsCountCache != null) recordsCountCache += added
    bumpDashboardTotals(added)
    // Avoid TRUNCATE checkpoint mid-import — it stalls the next uploads.
    if (added >= 100_000) {
      await yieldEventLoop()
      optimizeDatabase()
    }

    onProgress?.({
      phase: 'insert',
      pct: 100,
      message: `Insert selesai · +${added.toLocaleString('id-ID')} · skip ${skipped.toLocaleString('id-ID')}`,
      done: total,
      total,
      added,
      skipped,
    })

    return { added, skipped, total: getTotalFast() }
  })
}

/**
 * Remove duplicate credential rows (same dedupe_key), keep the newest.
 * Also purges orphan FTS rows. Safe to call after imports / on boot.
 */
export function dedupeDatabase() {
  enterBulkImport()
  try {
    const before = getTotalFast()

    // Prefer window-function delete (SQLite ≥ 3.25). Fallback to MIN(rowid).
    let removed = 0
    try {
      const info = db.prepare(`
        DELETE FROM records
        WHERE rowid IN (
          SELECT rowid FROM (
            SELECT rowid,
                   ROW_NUMBER() OVER (
                     PARTITION BY dedupe_key
                     ORDER BY imported_at DESC, rowid DESC
                   ) AS rn
            FROM records
          ) WHERE rn > 1
        )
      `).run()
      removed = Number(info.changes) || 0
    } catch {
      const info = db.prepare(`
        DELETE FROM records
        WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM records GROUP BY dedupe_key
        )
      `).run()
      removed = Number(info.changes) || 0
    }

    db.exec(`
      DELETE FROM records_fts
      WHERE id NOT IN (SELECT id FROM records);
    `)

    if (removed > 0) {
      recordsCountCache = Math.max(0, before - removed)
      setMeta('stats_total', String(recordsCountCache))
      invalidateDashboardCache()
      console.log(`[dedupe] removed ${removed.toLocaleString()} duplicate rows`)
    }

    return { removed, total: getTotalFast() }
  } finally {
    leaveBulkImport()
  }
}

/** Ensure dedupe_key uniqueness without rebuilding an index that already exists. */
export function ensureDedupeIndex() {
  const indexes = db.prepare(`PRAGMA index_list('records')`).all() as Array<{
    name: string
    unique: number | boolean
  }>
  for (const idx of indexes) {
    if (idx.name === 'idx_records_dedupe_key') return
    if (!idx.unique) continue
    // PRAGMA does not accept bound parameters (`?`) — quote the identifier.
    const safe = String(idx.name).replace(/"/g, '""')
    const cols = db.prepare(`PRAGMA index_info("${safe}")`).all() as Array<{ name: string }>
    if (cols.length === 1 && cols[0]?.name === 'dedupe_key') return
  }
  // Only build when missing — creating on ~8M rows otherwise stalls the process.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_records_dedupe_key ON records(dedupe_key)`)
}

export function validateSearchQuery(q: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const normalized = normalizeSearchText(q)
  const tokens = normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) return { ok: false, error: 'Query pencarian wajib diisi' }
  const short = tokens.filter((t) => t.length < MIN_SEARCH_TOKEN_LEN)
  if (short.length) {
    return {
      ok: false,
      error: `Setiap kata minimal ${MIN_SEARCH_TOKEN_LEN} karakter (hindari scan penuh). Contoh: domain.com, email, IP, username`,
    }
  }
  return { ok: true, tokens }
}

function searchByDomainIndex(token: string, limit: number, offset: number) {
  // Exact host match via B-tree — typically <5ms even on multi-million rows
  const probed = db
    .prepare(
      `SELECT id, isi, database_name, url, username, password, raw, imported_at
       FROM records
       WHERE domain_lc = ?
       LIMIT ? OFFSET ?`,
    )
    .all(token, limit + 1, offset) as Record<string, unknown>[]
  return mapProbe(probed, limit)
}

function searchByFts(tokens: string[], columns: FtsColumn[] | 'all', limit: number, offset: number) {
  const match = buildFtsQuery(tokens, columns)
  const probed = db
    .prepare(
      `SELECT id, isi, database_name, url, username, password, raw, imported_at
       FROM records_fts
       WHERE records_fts MATCH ?
       LIMIT ? OFFSET ?`,
    )
    .all(match, limit + 1, offset) as Record<string, unknown>[]
  return mapProbe(probed, limit)
}

/**
 * Trigram FTS also accelerates LIKE — useful when MATCH phrase parsing
 * struggles with punctuation-heavy tokens (URLs, emails).
 */
function searchByFtsLike(column: FtsColumn, token: string, limit: number, offset: number) {
  const probed = db
    .prepare(
      `SELECT id, isi, database_name, url, username, password, raw, imported_at
       FROM records_fts
       WHERE ${column} LIKE ?
       LIMIT ? OFFSET ?`,
    )
    .all(`%${token}%`, limit + 1, offset) as Record<string, unknown>[]
  return mapProbe(probed, limit)
}

export function searchRecords(opts: {
  q: string
  filter: SearchFilter
  limit: number
  offset: number
}) {
  const validated = validateSearchQuery(opts.q)
  if (!validated.ok) {
    return { total: 0, rows: [] as SearchHit[], hasMore: false, error: validated.error }
  }
  const tokens = validated.tokens
  const offset = Math.min(Math.max(0, opts.offset), MAX_SEARCH_OFFSET)
  const limit = Math.max(1, opts.limit)
  const token0 = tokens[0]!

  // Protocol shortcuts — indexed column
  if (
    opts.filter === 'all' &&
    tokens.length === 1 &&
    ['http', 'https', 'ftp', 'ssh'].includes(token0)
  ) {
    const probed = db
      .prepare(
        `SELECT id, isi, database_name, url, username, password, raw, imported_at
         FROM records WHERE protocol = ?
         LIMIT ? OFFSET ?`,
      )
      .all(token0, limit + 1, offset) as Record<string, unknown>[]
    const mapped = mapProbe(probed, limit)
    return {
      total: offset + mapped.rows.length + mapped.totalExtra,
      rows: mapped.rows,
      hasMore: mapped.hasMore,
    }
  }

  try {
    // Domain / host: B-tree equality first (fast), then FTS for www./m. subdomains
    const wantDomain =
      opts.filter === 'domain' ||
      (opts.filter === 'all' && tokens.length === 1 && isDomainLike(token0)) ||
      (opts.filter === 'url' && tokens.length === 1 && isDomainLike(token0))

    if (wantDomain && tokens.length === 1 && offset === 0) {
      const exact = searchByDomainIndex(token0, limit, 0)
      if (exact.rows.length >= limit) {
        return {
          total: exact.rows.length + exact.totalExtra,
          rows: exact.rows,
          hasMore: exact.hasMore,
        }
      }
      const seen = new Set(exact.rows.map((r) => r.id))
      const merged = [...exact.rows]
      try {
        const fts = searchByFts(tokens, opts.filter === 'url' ? ['url', 'domain'] : ['domain', 'url'], limit + 1, 0)
        for (const row of fts.rows) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          merged.push(row)
          if (merged.length > limit) break
        }
      } catch {
        /* keep exact-only */
      }
      const hasMore = merged.length > limit
      const rows = hasMore ? merged.slice(0, limit) : merged
      if (rows.length > 0 || opts.filter === 'domain') {
        return {
          total: rows.length + (hasMore ? 1 : 0),
          rows,
          hasMore,
        }
      }
    } else if (wantDomain && tokens.length === 1 && offset > 0) {
      // deeper pages: FTS covers exact + subdomain hosts
      const fts = searchByFts(
        tokens,
        opts.filter === 'url' ? ['url', 'domain'] : ['domain', 'url'],
        limit,
        offset,
      )
      return {
        total: offset + fts.rows.length + fts.totalExtra,
        rows: fts.rows,
        hasMore: fts.hasMore,
      }
    }

    // Email / @-token → AND of local+domain parts on username (avoids slow full-email phrase)
    if (
      tokens.length === 1 &&
      (opts.filter === 'username' || opts.filter === 'all') &&
      (isEmailLike(token0) || token0.includes('@'))
    ) {
      const at = token0.indexOf('@')
      const local = at >= 0 ? token0.slice(0, at) : ''
      const domainPart = at >= 0 ? token0.slice(at + 1) : ''
      const emailTokens =
        local.length >= MIN_SEARCH_TOKEN_LEN && domainPart.length >= MIN_SEARCH_TOKEN_LEN
          ? [local, domainPart]
          : [token0.replace(/^@+/, '')].filter((t) => t.length >= MIN_SEARCH_TOKEN_LEN)
      if (emailTokens.length) {
        try {
          const cols: FtsColumn[] = opts.filter === 'username' ? ['username'] : ['username', 'url']
          const fts = searchByFts(emailTokens, cols, limit, offset)
          return {
            total: offset + fts.rows.length + fts.totalExtra,
            rows: fts.rows,
            hasMore: fts.hasMore,
          }
        } catch {
          const like = searchByFtsLike('username', token0, limit, offset)
          return {
            total: offset + like.rows.length + like.totalExtra,
            rows: like.rows,
            hasMore: like.hasMore,
          }
        }
      }
    }

    // IP → url/domain columns + reverse DNS map (domain_dns)
    if (tokens.length === 1 && isIpv4Like(token0) && (opts.filter === 'all' || opts.filter === 'url' || opts.filter === 'domain')) {
      const dnsDomains = domainsForIpv4(token0, 120)
      if (dnsDomains.length && offset === 0) {
        const byDns = searchRecordsByDomains(dnsDomains, limit, 0)
        if (byDns.rows.length > 0) {
          const seen = new Set(byDns.rows.map((r) => r.id))
          const cols: FtsColumn[] =
            opts.filter === 'domain' ? ['domain'] : opts.filter === 'url' ? ['url'] : ['url', 'domain']
          try {
            const fts = searchByFts(tokens, cols, limit + 1, 0)
            const merged = [...byDns.rows]
            for (const row of fts.rows) {
              if (seen.has(row.id)) continue
              seen.add(row.id)
              merged.push(row)
              if (merged.length > limit) break
            }
            const hasMore = merged.length > limit || byDns.hasMore || fts.hasMore
            return {
              total: offset + Math.min(merged.length, limit) + (hasMore ? 1 : 0),
              rows: hasMore ? merged.slice(0, limit) : merged,
              hasMore,
            }
          } catch {
            return {
              total: byDns.rows.length + byDns.totalExtra,
              rows: byDns.rows,
              hasMore: byDns.hasMore,
            }
          }
        }
      }
      const cols: FtsColumn[] =
        opts.filter === 'domain' ? ['domain'] : opts.filter === 'url' ? ['url'] : ['url', 'domain']
      const fts = searchByFts(tokens, cols, limit, offset)
      if (fts.rows.length > 0) {
        return {
          total: offset + fts.rows.length + fts.totalExtra,
          rows: fts.rows,
          hasMore: fts.hasMore,
        }
      }
      const likeCol: FtsColumn = opts.filter === 'domain' ? 'domain' : 'url'
      const like = searchByFtsLike(likeCol, token0, limit, offset)
      return {
        total: offset + like.rows.length + like.totalExtra,
        rows: like.rows,
        hasMore: like.hasMore,
      }
    }

    const columns = resolveFtsColumns(opts.filter, tokens)
    try {
      const bare =
        opts.filter === 'all' && tokens.length === 1 && isBareKeyword(token0)

      // Bare keywords (shineserver, gofood, …): one domain+url MATCH.
      // Skip username + password columns and avoid a second FTS round-trip.
      let fts
      if (bare) {
        fts = searchByFts(tokens, ['domain', 'url'], limit, offset)
        return {
          total: offset + fts.rows.length + fts.totalExtra,
          rows: fts.rows,
          hasMore: fts.hasMore,
        }
      }

      const ftsStarted = Date.now()
      fts = searchByFts(tokens, columns, limit, offset)
      const ftsMs = Date.now() - ftsStarted
      // Soft-merge enrichment only when the primary hit set is thin and cheap.
      if (
        offset === 0 &&
        ftsMs < 800 &&
        fts.rows.length < Math.min(8, limit) &&
        (opts.filter === 'all' || opts.filter === 'domain' || opts.filter === 'url')
      ) {
        const enrichDomains = domainsMatchingEnrichment(tokens, 15)
        if (enrichDomains.length) {
          const extra = searchRecordsByDomains(enrichDomains, limit, 0)
          if (extra.rows.length) {
            const seen = new Set(fts.rows.map((r) => r.id))
            const merged = [...fts.rows]
            for (const row of extra.rows) {
              if (seen.has(row.id)) continue
              seen.add(row.id)
              merged.push(row)
              if (merged.length > limit) break
            }
            const hasMore = merged.length > limit || fts.hasMore || extra.hasMore
            return {
              total: Math.min(merged.length, limit) + (hasMore ? 1 : 0),
              rows: hasMore ? merged.slice(0, limit) : merged,
              hasMore,
            }
          }
        }
      }
      return {
        total: offset + fts.rows.length + fts.totalExtra,
        rows: fts.rows,
        hasMore: fts.hasMore,
      }
    } catch {
      // Punctuation-heavy tokens: fall back to column LIKE on trigram index
      const likeCol: FtsColumn =
        opts.filter === 'password'
          ? 'password'
          : opts.filter === 'username'
            ? 'username'
            : opts.filter === 'domain'
              ? 'domain'
              : 'url'
      const like = searchByFtsLike(likeCol, tokens.join(' '), limit, offset)
      return {
        total: offset + like.rows.length + like.totalExtra,
        rows: like.rows,
        hasMore: like.hasMore,
      }
    }
  } catch (err) {
    return {
      total: 0,
      rows: [] as SearchHit[],
      hasMore: false,
      error: err instanceof Error ? err.message : 'Query FTS gagal',
    }
  }
}

function beginExportPragmas() {
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -262144;
      PRAGMA mmap_size = 268435456;
    `)
  } catch {
    /* ignore */
  }
}

function endExportPragmas() {
  try {
    db.exec(`
      PRAGMA cache_size = -64000;
      PRAGMA mmap_size = 0;
    `)
  } catch {
    /* ignore */
  }
}

/** Export scan: rowid keyset (order irrelevant for dumps; much faster than imported_at sort). */
function* iterateByIndexedColumn(
  whereSql: string,
  whereParams: unknown[],
  batchSize: number,
  maxRows: number,
) {
  const stmt = db.prepare(
    `SELECT rowid, url, username, password, imported_at
     FROM records
     WHERE ${whereSql}
       AND rowid > ?
     ORDER BY rowid
     LIMIT ?`,
  )
  let lastRowid = 0
  let yielded = 0
  while (yielded < maxRows) {
    const take = Math.min(batchSize, maxRows - yielded)
    const rows = stmt.all(...whereParams, lastRowid, take) as Record<string, unknown>[]
    if (!rows.length) return
    for (const row of rows) {
      lastRowid = Number(row.rowid)
      yield {
        id: '',
        isi: '',
        database: '',
        url: String(row.url ?? ''),
        username: String(row.username ?? ''),
        password: String(row.password ?? ''),
        raw: '',
        importedAt: String(row.imported_at ?? ''),
      } satisfies RecordItem
      yielded += 1
      if (yielded >= maxRows) return
    }
    if (rows.length < take) return
  }
}

/**
 * Fast TXT/CSV export: yields preformatted lines (avoids RecordItem alloc).
 * Prefer this over iterateSearch for plaintext dumps.
 */
export function* iterateSearchExportLines(opts: {
  q: string
  filter: SearchFilter
  format?: 'txt' | 'csv'
  batchSize?: number
  maxRows?: number
}): Generator<string> {
  const validated = validateSearchQuery(opts.q)
  if (!validated.ok) return

  beginExportPragmas()
  try {
    const batchSize = opts.batchSize ?? 20_000
    const maxRows = opts.maxRows ?? EXCEL_EXPORT_CAP
    const fmt = opts.format ?? 'txt'
    const tokens = validated.tokens
    const token0 = tokens[0]!
    let written = 0

    const formatRow = (url: string, username: string, password: string) => {
      if (fmt === 'csv') {
        return [url, username, password].map((c) => `"${c.replace(/"/g, '""')}"`).join(',')
      }
      return `${url}:${username}:${password}`
    }

    let whereSql: string | null = null
    let whereParams: unknown[] = []
    if (
      opts.filter === 'all' &&
      tokens.length === 1 &&
      ['http', 'https', 'ftp', 'ssh'].includes(token0)
    ) {
      whereSql = 'protocol = ?'
      whereParams = [token0]
    } else if (
      tokens.length === 1 &&
      isDomainLike(token0) &&
      (opts.filter === 'domain' || opts.filter === 'all' || opts.filter === 'url')
    ) {
      whereSql = 'domain_lc = ?'
      whereParams = [token0]
    }

    if (whereSql) {
      const stmt = db.prepare(
        `SELECT rowid, url, username, password FROM records
         WHERE ${whereSql} AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      let lastRowid = 0
      while (written < maxRows) {
        const take = Math.min(batchSize, maxRows - written)
        const rows = stmt.all(...whereParams, lastRowid, take) as Array<Record<string, unknown>>
        if (!rows.length) return
        for (const row of rows) {
          lastRowid = Number(row.rowid)
          yield formatRow(String(row.url ?? ''), String(row.username ?? ''), String(row.password ?? ''))
          written += 1
          if (written >= maxRows) return
        }
        if (rows.length < take) return
      }
      return
    }

    // FTS: avoid ORDER BY (doclist order is fine for dumps) + page with rowid
    // so we can stream batches without sorting 100k hits.
    const columns = resolveFtsColumns(opts.filter, tokens)
    const match = buildFtsQuery(tokens, columns)
    const stmt = db.prepare(
      `SELECT rowid, url, username, password
       FROM records_fts
       WHERE records_fts MATCH ?
         AND rowid > ?
       LIMIT ?`,
    )
    let lastRowid = 0
    while (written < maxRows) {
      const take = Math.min(batchSize, maxRows - written)
      let rows: Array<Record<string, unknown>>
      try {
        rows = stmt.all(match, lastRowid, take) as Array<Record<string, unknown>>
      } catch {
        return
      }
      if (!rows.length) return
      for (const row of rows) {
        lastRowid = Number(row.rowid)
        yield formatRow(String(row.url ?? ''), String(row.username ?? ''), String(row.password ?? ''))
        written += 1
        if (written >= maxRows) return
      }
      if (rows.length < take) return
    }
  } finally {
    endExportPragmas()
  }
}

/** Keyset iteration for export — indexed equality or FTS rowid cursor. */
export function* iterateSearch(opts: {
  q: string
  filter: SearchFilter
  batchSize?: number
  maxRows?: number
}) {
  const validated = validateSearchQuery(opts.q)
  if (!validated.ok) return

  beginExportPragmas()
  try {
    const batchSize = opts.batchSize ?? 20_000
    const maxRows = opts.maxRows ?? EXCEL_EXPORT_CAP
    const tokens = validated.tokens
    const token0 = tokens[0]!

    if (
      opts.filter === 'all' &&
      tokens.length === 1 &&
      ['http', 'https', 'ftp', 'ssh'].includes(token0)
    ) {
      yield* iterateByIndexedColumn('protocol = ?', [token0], batchSize, maxRows)
      return
    }

    const wantDomainExact =
      tokens.length === 1 &&
      isDomainLike(token0) &&
      (opts.filter === 'domain' || opts.filter === 'all' || opts.filter === 'url')

    if (wantDomainExact) {
      yield* iterateByIndexedColumn('domain_lc = ?', [token0], batchSize, maxRows)
      return
    }

    const columns = resolveFtsColumns(opts.filter, tokens)
    const match = buildFtsQuery(tokens, columns)
    const stmt = db.prepare(
      `SELECT rowid, url, username, password, imported_at
       FROM records_fts
       WHERE records_fts MATCH ?
         AND rowid > ?
       LIMIT ?`,
    )
    let lastRowid = 0
    let yielded = 0
    while (yielded < maxRows) {
      const take = Math.min(batchSize, maxRows - yielded)
      try {
        const rows = stmt.all(match, lastRowid, take) as Array<Record<string, unknown>>
        if (!rows.length) return
        for (const row of rows) {
          lastRowid = Number(row.rowid)
          yield {
            id: '',
            isi: '',
            database: '',
            url: String(row.url ?? ''),
            username: String(row.username ?? ''),
            password: String(row.password ?? ''),
            raw: '',
            importedAt: String(row.imported_at ?? ''),
          } satisfies RecordItem
          yielded += 1
          if (yielded >= maxRows) return
        }
        if (rows.length < take) return
      } catch {
        return
      }
    }
  } finally {
    endExportPragmas()
  }
}

type DashboardCache = {
  updatedAt: string
  totalRecords: number
  uniqueHosts: number
  importedLast24h: number
  importedLast7: number
  last7: { date: string; count: number }[]
  protocols: { name: string; count: number }[]
}

function invalidateDashboardCache() {
  try {
    db.prepare(`DELETE FROM meta WHERE key = 'dashboard_cache'`).run()
  } catch {
    /* ignore */
  }
}

/** Sync in-memory counters after an out-of-process import writer finishes. */
export function adoptExternalImportTotal(total: number) {
  if (!Number.isFinite(total) || total < 0) {
    recordsCountCache = null
  } else {
    recordsCountCache = total
    setMeta('stats_total', String(total))
  }
  invalidateDashboardCache()
}

function getUniqueHostsFast() {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM domains').get()?.c ?? 0)
}

function getTotalFast() {
  const meta = getMeta('stats_total')
  if (meta != null && meta !== '') {
    const n = Number(meta)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const count = getRecordsCount()
  setMeta('stats_total', String(count))
  return count
}

function emptyLast7(): { date: string; count: number }[] {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const out: { date: string; count: number }[] = []
  for (let i = 6; i >= 0; i--) {
    out.push({ date: new Date(now - i * dayMs).toISOString().slice(0, 10), count: 0 })
  }
  return out
}

function bumpDashboardTotals(added: number) {
  if (added <= 0) return
  try {
    const total = getTotalFast() + added
    setMeta('stats_total', String(total))
    const raw = getMeta('dashboard_cache')
    if (!raw) {
      scheduleDashboardRefresh()
      return
    }
    const cached = JSON.parse(raw) as DashboardCache
    cached.totalRecords = total
    cached.uniqueHosts = Math.max(cached.uniqueHosts, getUniqueHostsFast())
    cached.importedLast24h += added
    cached.importedLast7 += added
    const today = new Date().toISOString().slice(0, 10)
    const day = cached.last7.find((d) => d.date === today)
    if (day) day.count += added
    else cached.last7 = [...cached.last7.slice(-6), { date: today, count: added }]
    // keep serving cache; refresh charts in background (never block imports)
    setMeta('dashboard_cache', JSON.stringify(cached))
    scheduleDashboardRefresh()
  } catch {
    scheduleDashboardRefresh()
  }
}

function ensureDomainsBackfilled() {
  const domainCount = getUniqueHostsFast()
  const total = getTotalFast()
  if (domainCount > 0 || total === 0) return
  console.log('Backfilling domains index for fast unique-host KPI…')
  db.exec(`INSERT OR IGNORE INTO domains(domain_lc) SELECT DISTINCT domain_lc FROM records WHERE domain_lc != ''`)
  console.log(`Domains index ready (${getUniqueHostsFast().toLocaleString()} hosts)`)
}

function computeDashboardStats(): DashboardCache & {
  recent: { id: string; url: string; username: string; password: string; importedAt: string }[]
} {
  ensureDomainsBackfilled()
  const totalRecords = getRecordsCount()
  setMeta('stats_total', String(totalRecords))
  const uniqueHosts = getUniqueHostsFast()

  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const iso24 = new Date(now - dayMs).toISOString()
  const importedLast24h = Number(
    db.prepare('SELECT COUNT(*) AS c FROM records WHERE imported_at >= ?').get(iso24)?.c ?? 0,
  )

  const last7: { date: string; count: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * dayMs)
    const key = d.toISOString().slice(0, 10)
    const start = `${key}T00:00:00.000Z`
    const end = `${key}T23:59:59.999Z`
    const count = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM records WHERE imported_at >= ? AND imported_at <= ?`)
        .get(start, end)?.c ?? 0,
    )
    last7.push({ date: key, count })
  }
  const importedLast7 = last7.reduce((s, d) => s + d.count, 0)

  const protocols = (
    db
      .prepare(
        `SELECT protocol AS name, COUNT(*) AS count
         FROM records GROUP BY protocol ORDER BY count DESC LIMIT 6`,
      )
      .all() as Array<{ name: string; count: number | bigint }>
  ).map((p) => ({ name: p.name, count: Number(p.count) }))

  const cache: DashboardCache = {
    updatedAt: new Date().toISOString(),
    totalRecords,
    uniqueHosts,
    importedLast24h,
    importedLast7,
    last7,
    protocols,
  }
  setMeta('dashboard_cache', JSON.stringify(cache))
  return { ...cache, recent: readRecentImports() }
}

function readRecentImports() {
  return (
    db
      .prepare(
        `SELECT id, url, username, password, imported_at FROM records
         ORDER BY imported_at DESC LIMIT 8`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    url: String(r.url),
    username: String(r.username),
    password: String(r.password ?? ''),
    importedAt: String(r.imported_at),
  }))
}

function readCache(): DashboardCache | null {
  try {
    const raw = getMeta('dashboard_cache')
    if (!raw) return null
    return JSON.parse(raw) as DashboardCache
  } catch {
    return null
  }
}

function scheduleDashboardRefresh() {
  if (dashboardRefreshInFlight) return
  dashboardRefreshInFlight = true
  setImmediate(() => {
    try {
      computeDashboardStats()
    } catch (err) {
      console.error('Background dashboard refresh failed:', err)
    } finally {
      dashboardRefreshInFlight = false
    }
  })
}

/** Never blocks on COUNT(DISTINCT) / heavy aggregates — serves cache and refreshes async. */
export function getDashboardStats() {
  const cached = readCache()
  const recent = readRecentImports()
  if (cached) {
    const age = Date.now() - new Date(cached.updatedAt).getTime()
    if (!Number.isFinite(age) || age < 0 || age >= DASHBOARD_CACHE_TTL_MS) {
      scheduleDashboardRefresh()
    }
    return {
      ...cached,
      totalRecords: Math.max(cached.totalRecords, getTotalFast()),
      uniqueHosts: Math.max(cached.uniqueHosts, getUniqueHostsFast()),
      recent,
    }
  }

  // Cold start: return cheap KPIs immediately, fill charts in background
  scheduleDashboardRefresh()
  return {
    updatedAt: new Date(0).toISOString(),
    totalRecords: getTotalFast(),
    uniqueHosts: getUniqueHostsFast(),
    importedLast24h: 0,
    importedLast7: 0,
    last7: emptyLast7(),
    protocols: [] as { name: string; count: number }[],
    recent,
  }
}

/** Kick off domains backfill + first cache warm after boot (non-blocking). */
export function warmDashboardStats() {
  scheduleDashboardRefresh()
}

export function runMaintenance() {
  optimizeDatabase()
  ensureDomainsBackfilled()
  const stats = computeDashboardStats()
  return {
    ok: true,
    totalRecords: stats.totalRecords,
    uniqueHosts: stats.uniqueHosts,
    optimizedAt: new Date().toISOString(),
  }
}

/** Slow path only for tiny DBs / tests — avoid on huge corpora. */
export function readAllRecordsUnsafe(max = 100_000): RecordItem[] {
  const rows = db
    .prepare(
      `SELECT id, isi, database_name, url, username, password, raw, imported_at
       FROM records ORDER BY imported_at DESC LIMIT ?`,
    )
    .all(max) as Record<string, unknown>[]
  return rows.map(rowToRecord)
}

/* ── URL enrichment + domain DNS (sidecar) ───────────────────────── */

export type UrlEnrichmentRow = {
  urlKey: string
  url: string
  domainLc: string
  title: string
  description: string
  bodyExcerpt: string
  status: string
  httpStatus?: number
  fetchedAt: string
}

export type EnrichmentLogEntry = {
  kind: 'dns' | 'url'
  target: string
  detail: string
  status: string
  at: string
}

export type EnrichmentProgress = {
  dns: { done: number; total: number; pct: number }
  urlText: { done: number; total: number; pct: number }
  previews: { done: number; total: number; pct: number }
  updatedAt: string
  recentLog?: EnrichmentLogEntry[]
}

function pct(done: number, total: number) {
  if (total <= 0) return done > 0 ? 100 : 0
  return Math.min(100, Math.round((done / total) * 1000) / 10)
}

const ENRICH_PROGRESS_TTL_MS = 15_000
let enrichProgressCache: { at: number; previewDone: number; value: EnrichmentProgress } | null =
  null

export function getEnrichmentProgress(previewDone = 0): EnrichmentProgress {
  const now = Date.now()
  if (
    enrichProgressCache &&
    now - enrichProgressCache.at < ENRICH_PROGRESS_TTL_MS &&
    enrichProgressCache.previewDone === previewDone
  ) {
    return enrichProgressCache.value
  }

  const totalHosts = getUniqueHostsFast()
  // Prefer equality on indexed status over `!= 'pending'` (avoids almost-full scans).
  const dnsDone = Number(
    (
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM domain_dns WHERE status = 'ok') +
             (SELECT COUNT(*) FROM domain_dns WHERE status = 'error') AS c`,
        )
        .get() as { c?: number } | undefined
    )?.c ?? 0,
  )
  const urlDone = Number(
    (
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM url_enrichment WHERE status = 'ok') +
             (SELECT COUNT(*) FROM url_enrichment WHERE status = 'error') +
             (SELECT COUNT(*) FROM url_enrichment WHERE status = 'dead') AS c`,
        )
        .get() as { c?: number } | undefined
    )?.c ?? 0,
  )
  // Homepage-per-domain is the primary enrichment target (efficient).
  const urlTotal = Math.max(totalHosts, urlDone)
  const value: EnrichmentProgress = {
    dns: { done: dnsDone, total: totalHosts, pct: pct(dnsDone, totalHosts) },
    urlText: { done: urlDone, total: urlTotal, pct: pct(urlDone, urlTotal) },
    previews: {
      done: previewDone,
      total: Math.max(totalHosts, previewDone),
      pct: pct(previewDone, Math.max(totalHosts, previewDone)),
    },
    updatedAt: new Date().toISOString(),
    recentLog: listRecentEnrichmentLog(16),
  }
  enrichProgressCache = { at: now, previewDone, value }
  return value
}

export function enrichmentExists(urlKey: string) {
  const row = db.prepare(`SELECT status FROM url_enrichment WHERE url_key = ?`).get(urlKey) as
    | { status?: string }
    | undefined
  return Boolean(row && row.status && row.status !== 'pending')
}

export function upsertUrlEnrichment(row: {
  urlKey: string
  url: string
  domainLc: string
  title: string
  description: string
  bodyExcerpt: string
  status: string
  httpStatus?: number
}) {
  const fetchedAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO url_enrichment(url_key, url, domain_lc, title, description, body_excerpt, status, http_status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url_key) DO UPDATE SET
       url=excluded.url,
       domain_lc=excluded.domain_lc,
       title=excluded.title,
       description=excluded.description,
       body_excerpt=excluded.body_excerpt,
       status=excluded.status,
       http_status=excluded.http_status,
       fetched_at=excluded.fetched_at`,
  ).run(
    row.urlKey,
    row.url,
    row.domainLc,
    row.title,
    row.description,
    row.bodyExcerpt,
    row.status,
    row.httpStatus ?? null,
    fetchedAt,
  )
  db.prepare(`DELETE FROM url_enrichment_fts WHERE url_key = ?`).run(row.urlKey)
  if (row.status === 'ok' && (row.title || row.description || row.bodyExcerpt)) {
    db.prepare(
      `INSERT INTO url_enrichment_fts(url_key, domain, title, description, body_excerpt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.urlKey, row.domainLc, row.title, row.description, row.bodyExcerpt)
  }
}

export function upsertDomainDns(row: {
  domainLc: string
  ipv4: string[]
  status: string
}) {
  db.prepare(
    `INSERT INTO domain_dns(domain_lc, ipv4, status, resolved_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain_lc) DO UPDATE SET
       ipv4=excluded.ipv4,
       status=excluded.status,
       resolved_at=excluded.resolved_at`,
  ).run(row.domainLc, row.ipv4.join(','), row.status, new Date().toISOString())
}

export function dnsExists(domainLc: string) {
  const row = db.prepare(`SELECT status FROM domain_dns WHERE domain_lc = ?`).get(domainLc) as
    | { status?: string }
    | undefined
  return Boolean(row && row.status && row.status !== 'pending')
}

/** Newest DNS lookups (host → IP). */
export function listRecentDomainDns(limit = 40): EnrichmentLogEntry[] {
  const rows = db
    .prepare(
      `SELECT domain_lc, ipv4, status, resolved_at
       FROM domain_dns
       WHERE status != 'pending'
       ORDER BY resolved_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as {
    domain_lc: string
    ipv4: string
    status: string
    resolved_at: string
  }[]
  return rows.map((r) => {
    const ips = String(r.ipv4 || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return {
      kind: 'dns' as const,
      target: r.domain_lc,
      detail: ips.length ? ips.slice(0, 3).join(', ') : r.status,
      status: r.status,
      at: r.resolved_at,
    }
  })
}

/** Newest title/content enrichments. */
export function listRecentUrlEnrichments(limit = 40): EnrichmentLogEntry[] {
  const rows = db
    .prepare(
      `SELECT url, domain_lc, title, status, http_status, fetched_at
       FROM url_enrichment
       WHERE status != 'pending'
       ORDER BY fetched_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as {
    url: string
    domain_lc: string
    title: string
    status: string
    http_status: number | null
    fetched_at: string
  }[]
  return rows.map((r) => {
    const title = String(r.title || '').trim()
    const http = r.http_status != null ? `HTTP ${r.http_status}` : ''
    const detail = title
      ? title.slice(0, 80)
      : http || r.status
    return {
      kind: 'url' as const,
      target: r.url || r.domain_lc,
      detail,
      status: r.status,
      at: r.fetched_at,
    }
  })
}

export function listRecentEnrichmentLog(limit = 30): EnrichmentLogEntry[] {
  const half = Math.max(8, Math.ceil(limit / 2))
  const merged = [...listRecentDomainDns(half), ...listRecentUrlEnrichments(half)]
  merged.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return merged.slice(0, limit)
}

/** Domains still missing DNS — prefer hosts that appear in domains index. */
export function claimPendingDomainsForDns(limit = 40): string[] {
  const rows = db
    .prepare(
      `SELECT d.domain_lc AS domain_lc
       FROM domains d
       LEFT JOIN domain_dns x ON x.domain_lc = d.domain_lc
       WHERE d.domain_lc != '' AND (x.domain_lc IS NULL OR x.status = 'pending')
       LIMIT ?`,
    )
    .all(limit) as { domain_lc: string }[]
  return rows.map((r) => r.domain_lc)
}

/**
 * Claim homepage URLs for enrichment (https://domain).
 * Skips keys already fetched. Efficient: one URL per host.
 */
export function claimPendingHomepagesForEnrich(limit = 20): { url: string; domainLc: string }[] {
  const rows = db
    .prepare(
      `SELECT d.domain_lc AS domain_lc
       FROM domains d
       WHERE d.domain_lc != ''
         AND NOT EXISTS (
           SELECT 1 FROM url_enrichment e
           WHERE e.domain_lc = d.domain_lc AND e.status != 'pending'
         )
       LIMIT ?`,
    )
    .all(limit) as { domain_lc: string }[]
  return rows.map((r) => ({
    domainLc: r.domain_lc,
    url: `https://${r.domain_lc}/`,
  }))
}

/** Scan records for additional distinct URLs (cursor-based, no full table scan). */
export function claimPendingRecordUrlsForEnrich(limit = 15): string[] {
  const cursor = Number(getMeta('enrich_url_cursor') || '0')
  const rows = db
    .prepare(
      `SELECT rowid AS rid, url FROM records
       WHERE rowid > ? AND url != ''
       ORDER BY rowid ASC
       LIMIT ?`,
    )
    .all(cursor, Math.max(limit * 8, 80)) as { rid: number; url: string }[]
  if (!rows.length) {
    // wrap once so new imports keep getting scanned
    if (cursor > 0) setMeta('enrich_url_cursor', '0')
    return []
  }
  const out: string[] = []
  let lastRid = cursor
  for (const r of rows) {
    lastRid = Number(r.rid)
    const url = String(r.url || '')
    if (!url) continue
    out.push(url)
    if (out.length >= limit) break
  }
  setMeta('enrich_url_cursor', String(lastRid))
  return out
}

export function getEnrichmentByUrls(urls: string[]): Map<string, UrlEnrichmentRow> {
  const map = new Map<string, UrlEnrichmentRow>()
  if (!urls.length) return map
  // Lookup by domain_lc first (homepage enrichment covers most results)
  const domains = [
    ...new Set(
      urls
        .map((u) => {
          try {
            return new URL(u.includes('://') ? u : `http://${u}`).hostname
              .toLowerCase()
              .replace(/^www\./, '')
          } catch {
            return ''
          }
        })
        .filter(Boolean),
    ),
  ]
  if (!domains.length) return map
  const placeholders = domains.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT url_key, url, domain_lc, title, description, body_excerpt, status, http_status, fetched_at
       FROM url_enrichment
       WHERE domain_lc IN (${placeholders}) AND status = 'ok'
       ORDER BY fetched_at DESC`,
    )
    .all(...domains) as Record<string, unknown>[]
  const byDomain = new Map<string, UrlEnrichmentRow>()
  for (const r of rows) {
    const domainLc = String(r.domain_lc || '')
    if (!domainLc || byDomain.has(domainLc)) continue
    byDomain.set(domainLc, {
      urlKey: String(r.url_key || ''),
      url: String(r.url || ''),
      domainLc,
      title: String(r.title || ''),
      description: String(r.description || ''),
      bodyExcerpt: String(r.body_excerpt || ''),
      status: String(r.status || ''),
      httpStatus: r.http_status == null ? undefined : Number(r.http_status),
      fetchedAt: String(r.fetched_at || ''),
    })
  }
  for (const u of urls) {
    try {
      const d = new URL(u.includes('://') ? u : `http://${u}`).hostname
        .toLowerCase()
        .replace(/^www\./, '')
      const hit = byDomain.get(d)
      if (hit) map.set(u, hit)
    } catch {
      /* skip */
    }
  }
  return map
}

/** Domains whose resolved IPv4 contains the query IP. */
export function getIpv4ByDomains(domains: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!domains.length) return map
  const uniq = [...new Set(domains.filter(Boolean))].slice(0, 200)
  const placeholders = uniq.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT domain_lc, ipv4 FROM domain_dns
       WHERE domain_lc IN (${placeholders}) AND status = 'ok' AND ipv4 != ''`,
    )
    .all(...uniq) as { domain_lc: string; ipv4: string }[]
  for (const r of rows) {
    map.set(
      r.domain_lc,
      String(r.ipv4 || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return map
}

export function domainsForIpv4(ip: string, limit = 200): string[] {
  const q = String(ip || '').trim()
  if (!q) return []
  const rows = db
    .prepare(
      `SELECT domain_lc FROM domain_dns
       WHERE status = 'ok' AND (ipv4 = ? OR ipv4 LIKE ? OR ipv4 LIKE ? OR ipv4 LIKE ?)
       LIMIT ?`,
    )
    .all(q, `${q},%`, `%,${q},%`, `%,${q}`, limit) as { domain_lc: string }[]
  return rows.map((r) => r.domain_lc)
}

/** Search enrichment FTS → matching domain list (for content/title keywords). */
export function domainsMatchingEnrichment(tokens: string[], limit = 80): string[] {
  if (!tokens.length) return []
  const phrase = tokens
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .filter((t) => t.length >= 5)
    .join(' AND ')
  if (!phrase) return []
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT domain AS domain_lc FROM url_enrichment_fts
         WHERE url_enrichment_fts MATCH ?
         LIMIT ?`,
      )
      .all(phrase, limit) as { domain_lc: string }[]
    return rows.map((r) => r.domain_lc).filter(Boolean)
  } catch {
    return []
  }
}

export function searchRecordsByDomains(domains: string[], limit: number, offset: number) {
  if (!domains.length) {
    return { rows: [] as SearchHit[], hasMore: false, totalExtra: 0 }
  }
  const slice = domains.slice(0, 80)
  const placeholders = slice.map(() => '?').join(',')
  const probed = db
    .prepare(
      `SELECT id, isi, database_name, url, username, password, raw, imported_at
       FROM records WHERE domain_lc IN (${placeholders})
       LIMIT ? OFFSET ?`,
    )
    .all(...slice, limit + 1, offset) as Record<string, unknown>[]
  return mapProbe(probed, limit)
}
