/**
 * One-shot / resumable SQLite → OpenSearch migration.
 * Usage: SEARCH_BACKEND=opensearch OPENSEARCH_URL=... npx tsx server/scripts/migrateSqliteToOpenSearch.ts
 */
import { initRecordsDb } from '../db/recordsDb.js'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bulkIndexCredentials, ensureCredentialsIndex, getOpenSearchCount } from '../search/opensearch.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, '..', 'data', 'records.db')
const BATCH = Number(process.env.MIGRATE_BATCH) || 2000

async function main() {
  await ensureCredentialsIndex()
  initRecordsDb()

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM records').get()?.c ?? 0)
  console.log(`Migrating ${total.toLocaleString()} rows → OpenSearch…`)

  let offset = 0
  let migrated = 0
  while (offset < total) {
    const rows = db
      .prepare(
        `SELECT id, isi, database_name, url, username, password, raw, imported_at
         FROM records
         ORDER BY imported_at ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(BATCH, offset) as Record<string, unknown>[]

    if (!rows.length) break

    const items = rows.map((r) => ({
      id: String(r.id),
      isi: String(r.isi ?? ''),
      database: String(r.database_name ?? ''),
      url: String(r.url ?? ''),
      username: String(r.username ?? ''),
      password: String(r.password ?? ''),
      raw: String(r.raw ?? ''),
      importedAt: String(r.imported_at ?? new Date().toISOString()),
    }))

    const result = await bulkIndexCredentials(items)
    migrated += result.added
    offset += rows.length
    console.log(
      `… ${Math.min(offset, total).toLocaleString()}/${total.toLocaleString()} (added=${result.added}, skipped=${result.skipped})`,
    )
  }

  db.close()
  const count = await getOpenSearchCount()
  console.log(`Done. OpenSearch docs=${count.toLocaleString()}, migrated≈${migrated.toLocaleString()}`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
