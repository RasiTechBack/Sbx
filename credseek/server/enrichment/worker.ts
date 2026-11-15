import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import {
  claimPendingDomainsForDns,
  claimPendingHomepagesForEnrich,
  claimPendingRecordUrlsForEnrich,
  dnsExists,
  enrichmentExists,
  getEnrichmentProgress,
  upsertDomainDns,
  upsertUrlEnrichment,
} from '../db/recordsDb.js'
import { resolveDomainIpv4 } from './dnsResolve.js'
import {
  enrichUrlKey,
  extractDomainLc,
  fetchPageEnrichment,
  normalizeEnrichUrl,
} from './fetchPage.js'

const DNS_BATCH = Number(process.env.ENRICH_DNS_BATCH || 30)
const URL_BATCH = Number(process.env.ENRICH_URL_BATCH || 12)
const URL_SCAN_BATCH = Number(process.env.ENRICH_URL_SCAN_BATCH || 8)
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.ENRICH_CONCURRENCY || 3)))
const TICK_MS = Math.max(1500, Number(process.env.ENRICH_TICK_MS || 4000))

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let tickInFlight = false

function countPreviewMetas() {
  try {
    const root = path.join(config.dataDir, 'previews')
    if (!fs.existsSync(root)) return 0
    let n = 0
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith('.json')) n += 1
    }
    return n
  } catch {
    return 0
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>) {
  const out: R[] = []
  let i = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
  return out
}

async function runDnsBatch() {
  const pending = claimPendingDomainsForDns(DNS_BATCH).filter((d) => !dnsExists(d))
  if (!pending.length) return 0
  let done = 0
  await mapPool(pending, CONCURRENCY, async (domain) => {
    const res = await resolveDomainIpv4(domain)
    upsertDomainDns({ domainLc: res.domainLc, ipv4: res.ipv4, status: res.status })
    const ipPreview = res.ipv4.slice(0, 2).join(', ') || res.status
    console.log(`[enrich] dns ${res.status} · ${res.domainLc} → ${ipPreview}`)
    done += 1
  })
  return done
}

async function enrichOneUrl(rawUrl: string) {
  const normalized = normalizeEnrichUrl(rawUrl)
  if (!normalized) return false
  const key = enrichUrlKey(normalized)
  if (enrichmentExists(key)) return false
  const page = await fetchPageEnrichment(normalized)
  upsertUrlEnrichment({
    urlKey: page.urlKey,
    url: page.url,
    domainLc: page.domainLc || extractDomainLc(page.url),
    title: page.title,
    description: page.description,
    bodyExcerpt: page.bodyExcerpt,
    status: page.status,
    httpStatus: page.httpStatus,
  })
  const titleBit = String(page.title || '').trim().slice(0, 60)
  const httpBit = page.httpStatus != null ? `HTTP ${page.httpStatus}` : ''
  const detail = titleBit || httpBit || page.status
  console.log(`[enrich] url ${page.status} · ${page.url} · ${detail}`)
  return true
}

async function runUrlBatch() {
  const homes = claimPendingHomepagesForEnrich(URL_BATCH)
  let wrote = 0
  await mapPool(
    homes.map((h) => h.url),
    CONCURRENCY,
    async (url) => {
      if (await enrichOneUrl(url)) wrote += 1
    },
  )
  const scanned = claimPendingRecordUrlsForEnrich(URL_SCAN_BATCH)
  await mapPool(scanned, Math.max(1, CONCURRENCY - 1), async (url) => {
    if (await enrichOneUrl(url)) wrote += 1
  })
  return wrote
}

async function tick() {
  if (tickInFlight) return
  tickInFlight = true
  try {
    const dnsN = await runDnsBatch()
    const urlN = await runUrlBatch()
    if (dnsN || urlN) {
      const p = getEnrichmentProgress(countPreviewMetas())
      console.log(
        `[enrich] tick dns +${dnsN} (${p.dns.pct}%) · url +${urlN} (${p.urlText.pct}%) · previews ${p.previews.done}`,
      )
    }
  } catch (err) {
    console.warn('[enrich] tick failed:', err instanceof Error ? err.message : err)
  } finally {
    tickInFlight = false
  }
}

function scheduleNext() {
  if (!running) return
  timer = setTimeout(() => {
    void tick().finally(scheduleNext)
  }, TICK_MS)
}

export function startEnrichmentWorker() {
  if (running) return
  if (process.env.ENRICH_DISABLED === '1') {
    console.log('[enrich] disabled via ENRICH_DISABLED=1')
    return
  }
  running = true
  console.log(
    `[enrich] worker started (dns=${DNS_BATCH}/tick, url=${URL_BATCH}+${URL_SCAN_BATCH}, concurrency=${CONCURRENCY})`,
  )
  void tick().finally(scheduleNext)
}

export function stopEnrichmentWorker() {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}

export function enrichmentStatusSnapshot() {
  return getEnrichmentProgress(countPreviewMetas())
}
