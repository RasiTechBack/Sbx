import { config } from '../config.js'
import {
  clearAllRecords,
  EXCEL_EXPORT_CAP,
  getDashboardStats,
  getRecordsCount,
  assertImportsAllowed,
  getRecordsDbSizeBytes,
  insertCredentials as insertSqlite,
  iterateSearch as iterateSqlite,
  searchRecords as searchSqlite,
  type SearchFilter,
} from '../db/recordsDb.js'
import type { RecordItem } from '../store.js'
import {
  bulkIndexCredentials,
  clearOpenSearchIndex,
  ensureCredentialsIndex,
  getOpenSearchCount,
  getOpenSearchDashboardStats,
  iterateOpenSearch,
  searchOpenSearch,
} from './opensearch.js'

export function searchBackend() {
  return config.searchBackend === 'opensearch' ? 'opensearch' : 'sqlite'
}

export async function initSearchBackend() {
  if (searchBackend() === 'opensearch') {
    await ensureCredentialsIndex()
  }
}

export async function searchRecordsUnified(opts: {
  q: string
  filter: SearchFilter
  limit: number
  offset: number
}) {
  if (searchBackend() === 'opensearch') return searchOpenSearch(opts)
  return searchSqlite(opts)
}

export async function* iterateSearchUnified(opts: {
  q: string
  filter: SearchFilter
  max?: number
}): AsyncGenerator<RecordItem> {
  if (searchBackend() === 'opensearch') {
    yield* iterateOpenSearch(opts)
    return
  }
  for (const row of iterateSqlite({
    q: opts.q,
    filter: opts.filter,
    maxRows: opts.max ?? EXCEL_EXPORT_CAP,
  })) {
    yield row
  }
}

export async function insertCredentialsUnified(
  items: Array<Omit<RecordItem, 'id' | 'importedAt'> & { id?: string; importedAt?: string }>,
  opts?: {
    onProgress?: (p: {
      phase: 'insert'
      pct: number
      message: string
      done: number
      total: number
      added: number
      skipped: number
    }) => void
  },
) {
  // Hard stop before writing when on-disk SQLite has hit the configured ceiling.
  assertImportsAllowed()
  if (searchBackend() === 'opensearch') {
    opts?.onProgress?.({
      phase: 'insert',
      pct: 0,
      message: `OpenSearch bulk · ${items.length.toLocaleString('id-ID')} docs`,
      done: 0,
      total: items.length,
      added: 0,
      skipped: 0,
    })
    const result = await bulkIndexCredentials(items)
    const total = await getOpenSearchCount()
    opts?.onProgress?.({
      phase: 'insert',
      pct: 100,
      message: `OpenSearch selesai · +${result.added} · skip ${result.skipped}`,
      done: items.length,
      total: items.length,
      added: result.added,
      skipped: result.skipped,
    })
    return { ...result, total }
  }
  return insertSqlite(items, opts)
}

export async function getRecordsCountUnified() {
  if (searchBackend() === 'opensearch') return getOpenSearchCount()
  return getRecordsCount()
}

export function getRecordsDbSizeBytesUnified() {
  return getRecordsDbSizeBytes()
}

export async function clearAllRecordsUnified() {
  if (searchBackend() === 'opensearch') {
    await clearOpenSearchIndex()
    return
  }
  clearAllRecords()
}

export async function getDashboardStatsUnified() {
  if (searchBackend() === 'opensearch') {
    const stats = await getOpenSearchDashboardStats()
    return {
      totalRecords: stats.kpis.totalRecords,
      uniqueHosts: stats.kpis.uniqueHosts,
      importedLast24h: stats.kpis.importedLast24h,
      importedLast7: stats.kpis.importedLast7,
      last7: stats.charts.importsLast7Days,
      protocols: stats.charts.protocols,
      recent: stats.recent,
    }
  }
  return getDashboardStats()
}
