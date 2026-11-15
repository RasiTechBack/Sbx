import { randomUUID } from 'node:crypto'
import { Client } from '@opensearch-project/opensearch'
import { config } from '../config.js'
import { credentialDedupeKey, type RecordItem } from '../store.js'
import {
  EXCEL_EXPORT_CAP,
  MAX_SEARCH_OFFSET,
  validateSearchQuery,
  type SearchFilter,
} from '../db/recordsDb.js'

let client: Client | null = null

export function getOpenSearch() {
  if (!client) {
    client = new Client({
      node: config.openSearchUrl,
      auth:
        config.openSearchUser && config.openSearchPassword
          ? { username: config.openSearchUser, password: config.openSearchPassword }
          : undefined,
      ssl: { rejectUnauthorized: false },
    })
  }
  return client
}

export async function ensureCredentialsIndex() {
  const os = getOpenSearch()
  const exists = await os.indices.exists({ index: config.openSearchIndex })
  if (exists.body) return

  await os.indices.create({
    index: config.openSearchIndex,
    body: {
      settings: {
        number_of_shards: Number(process.env.OPENSEARCH_SHARDS) || 3,
        number_of_replicas: Number(process.env.OPENSEARCH_REPLICAS) || 1,
        refresh_interval: '5s',
      },
      mappings: {
        properties: {
          isi: { type: 'keyword', index: false },
          database: { type: 'keyword', index: false },
          url: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 2048 } } },
          username: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 512 } } },
          password: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 512 } } },
          domain: { type: 'keyword' },
          email_local: { type: 'keyword' },
          email_domain: { type: 'keyword' },
          protocol: { type: 'keyword' },
          raw: { type: 'text', index: false },
          dedupe_key: { type: 'keyword' },
          imported_at: { type: 'date' },
        },
      },
    },
  })
}

function extractDomain(url: string) {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return new URL(url).host.toLowerCase()
  } catch {
    /* ignore */
  }
  return (url.split('/')[0] || url).toLowerCase()
}

function extractProtocol(url: string) {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return new URL(url).protocol.replace(':', '').toLowerCase()
  } catch {
    /* ignore */
  }
  return 'unknown'
}

function toDoc(item: Omit<RecordItem, 'id' | 'importedAt'> & { id?: string; importedAt?: string }) {
  const id = item.id || cryptoRandom()
  const importedAt = item.importedAt || new Date().toISOString()
  const domain = extractDomain(item.url)
  const username = item.username
  let emailLocal = ''
  let emailDomain = ''
  if (username.includes('@')) {
    const [local, dom] = username.split('@')
    emailLocal = (local || '').toLowerCase()
    emailDomain = (dom || '').toLowerCase()
  }
  const dedupe = credentialDedupeKey(item)
  return {
    id,
    body: {
      isi: item.isi,
      database: item.database,
      url: item.url,
      username: item.username,
      password: item.password,
      domain,
      email_local: emailLocal,
      email_domain: emailDomain,
      protocol: extractProtocol(item.url),
      raw: item.raw,
      dedupe_key: dedupe,
      imported_at: importedAt,
    },
  }
}

function cryptoRandom() {
  return randomUUID()
}

function hitToRecord(id: string, src: Record<string, unknown>): RecordItem {
  return {
    id,
    isi: String(src.isi ?? ''),
    database: String(src.database ?? ''),
    url: String(src.url ?? ''),
    username: String(src.username ?? ''),
    password: String(src.password ?? ''),
    raw: String(src.raw ?? ''),
    importedAt: String(src.imported_at ?? ''),
  }
}

function buildQuery(q: string, filter: SearchFilter) {
  const validated = validateSearchQuery(q)
  if (!validated.ok) return { error: validated.error as string, body: null }
  const token = validated.tokens.join(' ')

  if (filter === 'domain' || (!q.includes('@') && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(token) && filter === 'all')) {
    return {
      error: null as string | null,
      body: {
        bool: {
          should: [
            { term: { domain: token } },
            { match_phrase: { url: token } },
          ],
          minimum_should_match: 1,
        },
      },
    }
  }

  if (filter === 'username' || token.includes('@')) {
    if (token.includes('@')) {
      const [local, domain] = token.split('@')
      return {
        error: null,
        body: {
          bool: {
            should: [
              {
                bool: {
                  must: [
                    { term: { email_local: (local || '').toLowerCase() } },
                    { term: { email_domain: (domain || '').toLowerCase() } },
                  ],
                },
              },
              { match_phrase: { username: token } },
            ],
            minimum_should_match: 1,
          },
        },
      }
    }
    return {
      error: null,
      body: { match_phrase: { username: token } },
    }
  }

  if (filter === 'password') {
    return { error: null, body: { match_phrase: { password: token } } }
  }

  if (filter === 'url') {
    return {
      error: null,
      body: {
        bool: {
          should: [{ match_phrase: { url: token } }, { term: { domain: token } }],
          minimum_should_match: 1,
        },
      },
    }
  }

  return {
    error: null,
    body: {
      multi_match: {
        query: token,
        fields: ['url', 'username', 'password', 'domain'],
        type: 'best_fields',
      },
    },
  }
}

export async function searchOpenSearch(opts: {
  q: string
  filter: SearchFilter
  limit: number
  offset: number
}) {
  const built = buildQuery(opts.q, opts.filter)
  if (built.error || !built.body) {
    return { total: 0, rows: [] as RecordItem[], hasMore: false, error: built.error || 'Invalid query' }
  }

  const offset = Math.min(Math.max(0, opts.offset), MAX_SEARCH_OFFSET)
  const limit = Math.max(1, opts.limit)
  const os = getOpenSearch()
  const res = await os.search({
    index: config.openSearchIndex,
    body: {
      track_total_hits: false,
      from: offset,
      size: limit + 1,
      query: built.body,
      sort: [{ imported_at: 'desc' }, { _id: 'asc' }],
    },
  })

  const hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: Record<string, unknown> }>
  const hasMore = hits.length > limit
  const slice = hits.slice(0, limit)
  const rows = slice.map((h) => hitToRecord(h._id, h._source || {}))
  return { total: -1, rows, hasMore, error: undefined as string | undefined }
}

export async function* iterateOpenSearch(opts: {
  q: string
  filter: SearchFilter
  max?: number
}): AsyncGenerator<RecordItem> {
  const built = buildQuery(opts.q, opts.filter)
  if (built.error || !built.body) return

  const max = opts.max ?? EXCEL_EXPORT_CAP
  const os = getOpenSearch()
  let searchAfter: unknown[] | undefined
  let yielded = 0

  while (yielded < max) {
    const size = Math.min(500, max - yielded)
    const res = await os.search({
      index: config.openSearchIndex,
      body: {
        size,
        query: built.body,
        sort: [{ imported_at: 'desc' }, { _id: 'asc' }],
        search_after: searchAfter,
      },
    })
    const hits = (res.body.hits?.hits || []) as Array<{
      _id: string
      _source: Record<string, unknown>
      sort?: unknown[]
    }>
    if (!hits.length) break
    for (const h of hits) {
      yield hitToRecord(h._id, h._source || {})
      yielded += 1
      if (yielded >= max) return
    }
    searchAfter = hits[hits.length - 1]?.sort
    if (!searchAfter) break
  }
}

export async function bulkIndexCredentials(
  items: Array<Omit<RecordItem, 'id' | 'importedAt'> & { id?: string; importedAt?: string }>,
) {
  if (!items.length) return { added: 0, skipped: 0 }

  const os = getOpenSearch()
  const body: unknown[] = []
  for (const item of items) {
    const doc = toDoc(item)
    body.push({ index: { _index: config.openSearchIndex, _id: doc.id } })
    body.push(doc.body)
  }

  const res = await os.bulk({ refresh: false, body })
  let added = 0
  let skipped = 0
  const itemsOut = (res.body.items || []) as Array<Record<string, { status?: number; error?: unknown }>>
  for (const entry of itemsOut) {
    const action = entry.index || entry.create
    if (!action) continue
    if (action.error) skipped += 1
    else if (action.status && action.status >= 200 && action.status < 300) added += 1
    else skipped += 1
  }
  return { added, skipped }
}

export async function getOpenSearchCount() {
  const os = getOpenSearch()
  const res = await os.count({ index: config.openSearchIndex })
  return Number(res.body.count || 0)
}

export async function clearOpenSearchIndex() {
  const os = getOpenSearch()
  const exists = await os.indices.exists({ index: config.openSearchIndex })
  if (exists.body) {
    await os.indices.delete({ index: config.openSearchIndex })
  }
  await ensureCredentialsIndex()
}

export async function getOpenSearchDashboardStats() {
  const os = getOpenSearch()
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const res = await os.search({
    index: config.openSearchIndex,
    body: {
      size: 0,
      track_total_hits: true,
      aggs: {
        protocols: { terms: { field: 'protocol', size: 8 } },
        last7: {
          filter: {
            range: { imported_at: { gte: new Date(now - 7 * dayMs).toISOString() } },
          },
          aggs: {
            by_day: {
              date_histogram: {
                field: 'imported_at',
                calendar_interval: 'day',
                format: 'yyyy-MM-dd',
              },
            },
          },
        },
        last24h: {
          filter: {
            range: { imported_at: { gte: new Date(now - dayMs).toISOString() } },
          },
        },
        unique_hosts: { cardinality: { field: 'domain' } },
        recent: {
          top_hits: {
            size: 8,
            sort: [{ imported_at: 'desc' }],
            _source: ['url', 'username', 'password', 'imported_at'],
          },
        },
      },
    },
  })

  const aggs = (res.body.aggregations || {}) as Record<string, any>
  const hitsTotal = res.body.hits?.total as { value?: number } | number | undefined
  const totalRecords = Number(
    typeof hitsTotal === 'object' ? hitsTotal?.value : hitsTotal ?? 0,
  )
  const importsLast7Days: { date: string; count: number }[] = []
  const buckets = (aggs.last7?.by_day?.buckets || []) as Array<{
    key_as_string?: string
    key?: string | number
    doc_count?: number
  }>
  for (const b of buckets) {
    importsLast7Days.push({
      date: String(b.key_as_string || b.key),
      count: Number(b.doc_count || 0),
    })
  }
  const protocols = ((aggs.protocols?.buckets || []) as Array<{ key: string; doc_count: number }>).map(
    (b) => ({
      name: String(b.key),
      count: Number(b.doc_count || 0),
    }),
  )
  const recentHits = (aggs.recent?.hits?.hits || []) as Array<{
    _id: string
    _source: Record<string, unknown>
  }>
  const recent = recentHits.map((h) => ({
    id: h._id,
    url: String(h._source?.url ?? ''),
    username: String(h._source?.username ?? ''),
    password: String(h._source?.password ?? ''),
    importedAt: String(h._source?.imported_at ?? ''),
  }))

  return {
    kpis: {
      totalRecords,
      uniqueHosts: Number(aggs.unique_hosts?.value || 0),
      importedLast24h: Number(aggs.last24h?.doc_count || 0),
      importedLast7: Number(aggs.last7?.doc_count || 0),
    },
    charts: {
      importsLast7Days,
      protocols,
    },
    recent,
  }
}
