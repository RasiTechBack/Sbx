import { iterateSearchUnified } from '../search/backend.js'
import type { SearchFilter } from '../db/recordsDb.js'
import { extractDomainFromUrl, normalizePreviewUrl } from './store.js'
import { capturePreview, getCachedPreview, previewPublicPath } from './capture.js'

const SAMPLE_ROWS = 400
const MAX_DOMAINS = 80
const MAX_PICTURES = 48
const CAPTURE_CONCURRENCY = 3

export type DomainAgg = {
  domain: string
  count: number
  sampleUrl: string
}

export type PictureItem = {
  url: string
  normalizedUrl: string
  domain: string
  title: string
  status: 'ok' | 'dead' | 'pending'
  imageUrl?: string
  source?: string
  count: number
}

async function sampleSearchRows(q: string, filter: SearchFilter, max = SAMPLE_ROWS) {
  const rows: Array<{ url: string; username: string; password: string; id: string }> = []
  for await (const r of iterateSearchUnified({ q, filter, max })) {
    rows.push({
      id: r.id,
      url: r.url,
      username: r.username,
      password: r.password,
    })
    if (rows.length >= max) break
  }
  return rows
}

export async function aggregateDomainsFromSearch(q: string, filter: SearchFilter): Promise<{
  domains: DomainAgg[]
  sampled: number
}> {
  const rows = await sampleSearchRows(q, filter)
  const map = new Map<string, DomainAgg>()
  for (const r of rows) {
    const normalized = normalizePreviewUrl(r.url)
    const domain = normalized ? extractDomainFromUrl(normalized) : ''
    if (!domain) continue
    const cur = map.get(domain)
    if (cur) {
      cur.count += 1
    } else {
      map.set(domain, { domain, count: 1, sampleUrl: normalized || r.url })
    }
  }
  const domains = [...map.values()].sort((a, b) => b.count - a.count).slice(0, MAX_DOMAINS)
  return { domains, sampled: rows.length }
}

export async function aggregatePicturesFromSearch(
  q: string,
  filter: SearchFilter,
  opts?: { capture?: boolean },
): Promise<{ pictures: PictureItem[]; sampled: number }> {
  const rows = await sampleSearchRows(q, filter)
  const byUrl = new Map<string, PictureItem>()

  for (const r of rows) {
    const normalized = normalizePreviewUrl(r.url)
    if (!normalized) continue
    const cur = byUrl.get(normalized)
    if (cur) {
      cur.count += 1
      continue
    }
    const cached = getCachedPreview(normalized)
    byUrl.set(normalized, {
      url: r.url,
      normalizedUrl: normalized,
      domain: extractDomainFromUrl(normalized),
      title: cached?.title || extractDomainFromUrl(normalized) || normalized,
      status: cached?.status || 'pending',
      imageUrl: cached ? previewPublicPath(cached) : undefined,
      source: cached?.source,
      count: 1,
    })
  }

  let pictures = [...byUrl.values()].sort((a, b) => b.count - a.count).slice(0, MAX_PICTURES)

  // Default: do not block on capture — images load via /api/preview/for lazily.
  if (opts?.capture) {
    const pending = pictures.filter((p) => p.status === 'pending')
    for (let i = 0; i < pending.length; i += CAPTURE_CONCURRENCY) {
      const batch = pending.slice(i, i + CAPTURE_CONCURRENCY)
      await Promise.all(
        batch.map(async (p) => {
          try {
            const meta = await capturePreview(p.normalizedUrl)
            p.title = meta.title
            p.status = meta.status
            p.imageUrl = previewPublicPath(meta)
            p.source = meta.source
            p.domain = meta.domain || p.domain
          } catch {
            p.status = 'dead'
            p.title = p.domain || 'Web mati'
          }
        }),
      )
    }
    pictures = pictures.map((p) => byUrl.get(p.normalizedUrl) || p)
  } else {
    // Point pending items at the lazy capture endpoint.
    for (const p of pictures) {
      if (!p.imageUrl) {
        p.imageUrl = `/api/preview/for?url=${encodeURIComponent(p.normalizedUrl)}&v=pw1`
      }
    }
  }

  return { pictures, sampled: rows.length }
}

export async function listRecordsForUrl(q: string, filter: SearchFilter, targetUrl: string, limit = 100) {
  const normalizedTarget = normalizePreviewUrl(targetUrl)
  const out: Array<{
    id: string
    url: string
    username: string
    password: string
  }> = []
  for await (const r of iterateSearchUnified({ q, filter, max: SAMPLE_ROWS })) {
    const n = normalizePreviewUrl(r.url)
    if (!n) continue
    if (normalizedTarget) {
      if (n !== normalizedTarget) continue
    } else if (r.url !== targetUrl) {
      continue
    }
    out.push({ id: r.id, url: r.url, username: r.username, password: r.password })
    if (out.length >= limit) break
  }
  return out
}
