import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const previewDir = path.join(config.dataDir || path.join(__dirname, '..', 'data'), 'previews')
const indexPath = path.join(previewDir, 'index.json')

export type PreviewStatus = 'ok' | 'dead' | 'pending' | 'blocked'

export type UrlPreviewRecord = {
  hash: string
  url: string
  domain: string
  status: PreviewStatus
  title?: string
  httpStatus?: number
  contentType?: string
  /** Relative API path to image */
  imagePath: string
  capturedAt: string
  source: 'og' | 'card' | 'dead'
}

type IndexFile = Record<string, UrlPreviewRecord>

const inFlight = new Map<string, Promise<UrlPreviewRecord>>()
let indexCache: IndexFile | null = null

function ensureDir() {
  fs.mkdirSync(previewDir, { recursive: true })
}

function loadIndex(): IndexFile {
  if (indexCache) return indexCache
  ensureDir()
  try {
    indexCache = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexFile
  } catch {
    indexCache = {}
  }
  return indexCache!
}

function saveIndex() {
  ensureDir()
  fs.writeFileSync(indexPath, JSON.stringify(indexCache || {}, null, 0))
}

export function previewHash(url: string) {
  return createHash('sha256').update(normalizeUrlKey(url)).digest('hex').slice(0, 24)
}

export function normalizeUrlKey(raw: string) {
  const trimmed = String(raw || '').trim()
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    u.hash = ''
    // Drop credentials from cache key
    u.username = ''
    u.password = ''
    let href = u.toString()
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1)
    return href.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

export function extractHost(raw: string) {
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return u.hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true
  // IPv4 private / link-local / metadata
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function truncate(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  return `${t.slice(0, n - 1)}…`
}

function writeSvgCard(opts: {
  hash: string
  host: string
  title: string
  badge: string
  dead?: boolean
}) {
  ensureDir()
  const bg = opts.dead ? '#1c1014' : '#0b1220'
  const accent = opts.dead ? '#fb7185' : '#2dd4bf'
  const badgeBg = opts.dead ? 'rgba(251,113,133,0.18)' : 'rgba(45,212,191,0.16)'
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${opts.dead ? '#3f1d24' : '#122033'}"/>
      <stop offset="100%" stop-color="${bg}"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" rx="12" fill="url(#g)"/>
  <rect x="12" y="12" width="296" height="156" rx="10" fill="none" stroke="${accent}" stroke-opacity="0.35"/>
  <rect x="20" y="20" width="88" height="22" rx="6" fill="${badgeBg}"/>
  <text x="28" y="36" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700" fill="${accent}">${escapeXml(opts.badge)}</text>
  <text x="20" y="78" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#eef3f8">${escapeXml(truncate(opts.host || 'unknown', 28))}</text>
  <text x="20" y="104" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#8b9bb0">${escapeXml(truncate(opts.title || (opts.dead ? 'Website tidak dapat dijangkau' : 'Preview halaman'), 42))}</text>
  <text x="20" y="150" font-family="Consolas, monospace" font-size="10" fill="#64748b">CredSeek preview</text>
</svg>`
  const file = path.join(previewDir, `${opts.hash}.svg`)
  fs.writeFileSync(file, svg)
  return file
}

function parseHtmlMeta(html: string) {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1] ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ||
    ''
  const ogImage =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    ''
  return {
    title: title.replace(/\s+/g, ' ').trim(),
    ogImage: ogImage.trim(),
  }
}

async function trySaveOgImage(hash: string, pageUrl: string, ogImage: string) {
  try {
    const u = new URL(ogImage, pageUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (isPrivateHost(u.hostname)) return null
    const abs = u.toString()

    const ctrl = AbortSignal.timeout(5000)
    const res = await fetch(abs, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl,
      headers: {
        'User-Agent': 'CredSeekPreview/1.0',
        Accept: 'image/*,*/*;q=0.8',
      },
    })
    if (!res.ok) return null
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    if (!ctype.startsWith('image/') || ctype.includes('svg')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 200 || buf.length > 1_500_000) return null
    const ext = ctype.includes('png')
      ? 'png'
      : ctype.includes('webp')
        ? 'webp'
        : ctype.includes('gif')
          ? 'gif'
          : 'jpg'
    const file = path.join(previewDir, `${hash}.${ext}`)
    fs.writeFileSync(file, buf)
    return { file, contentType: ctype, ext }
  } catch {
    return null
  }
}

async function captureOne(rawUrl: string): Promise<UrlPreviewRecord> {
  const key = normalizeUrlKey(rawUrl)
  const hash = previewHash(key)
  const index = loadIndex()
  const existing = index[hash]
  if (existing && existing.status !== 'pending') return existing

  let domain = extractHost(key)
  let fetchUrl = key
  try {
    const u = new URL(key)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      const rec: UrlPreviewRecord = {
        hash,
        url: key,
        domain,
        status: 'blocked',
        title: 'Skema URL tidak didukung',
        imagePath: `/api/previews/image/${hash}`,
        capturedAt: new Date().toISOString(),
        source: 'dead',
      }
      writeSvgCard({ hash, host: domain || key, title: rec.title!, badge: 'BLOCKED', dead: true })
      index[hash] = rec
      saveIndex()
      return rec
    }
    if (isPrivateHost(u.hostname)) {
      const rec: UrlPreviewRecord = {
        hash,
        url: key,
        domain,
        status: 'blocked',
        title: 'Host privat diblokir',
        imagePath: `/api/previews/image/${hash}`,
        capturedAt: new Date().toISOString(),
        source: 'dead',
      }
      writeSvgCard({ hash, host: domain, title: rec.title!, badge: 'BLOCKED', dead: true })
      index[hash] = rec
      saveIndex()
      return rec
    }
    fetchUrl = u.toString()
  } catch {
    const rec: UrlPreviewRecord = {
      hash,
      url: key,
      domain,
      status: 'dead',
      title: 'URL tidak valid',
      imagePath: `/api/previews/image/${hash}`,
      capturedAt: new Date().toISOString(),
      source: 'dead',
    }
    writeSvgCard({ hash, host: domain || 'invalid', title: rec.title!, badge: 'DEAD', dead: true })
    index[hash] = rec
    saveIndex()
    return rec
  }

  try {
    const ctrl = AbortSignal.timeout(7000)
    const res = await fetch(fetchUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; CredSeekPreview/1.0; +https://credseek.local)',
        Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
      },
    })
    const httpStatus = res.status
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    domain = extractHost(res.url || fetchUrl) || domain

    if (!res.ok) {
      const rec: UrlPreviewRecord = {
        hash,
        url: key,
        domain,
        status: 'dead',
        title: `HTTP ${httpStatus}`,
        httpStatus,
        contentType: ctype,
        imagePath: `/api/previews/image/${hash}`,
        capturedAt: new Date().toISOString(),
        source: 'dead',
      }
      writeSvgCard({
        hash,
        host: domain,
        title: `Website mati · HTTP ${httpStatus}`,
        badge: 'DEAD',
        dead: true,
      })
      index[hash] = rec
      saveIndex()
      return rec
    }

    // Direct image response
    if (ctype.startsWith('image/') && !ctype.includes('svg')) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 200 && buf.length <= 1_500_000) {
        const ext = ctype.includes('png') ? 'png' : ctype.includes('webp') ? 'webp' : 'jpg'
        fs.writeFileSync(path.join(previewDir, `${hash}.${ext}`), buf)
        const rec: UrlPreviewRecord = {
          hash,
          url: key,
          domain,
          status: 'ok',
          title: domain,
          httpStatus,
          contentType: ctype,
          imagePath: `/api/previews/image/${hash}`,
          capturedAt: new Date().toISOString(),
          source: 'og',
        }
        index[hash] = rec
        saveIndex()
        return rec
      }
    }

    const raw = Buffer.from(await res.arrayBuffer()).toString('utf8').slice(0, 400_000)
    const meta = parseHtmlMeta(raw)
    const og = meta.ogImage ? await trySaveOgImage(hash, res.url || fetchUrl, meta.ogImage) : null
    if (og) {
      const rec: UrlPreviewRecord = {
        hash,
        url: key,
        domain,
        status: 'ok',
        title: meta.title || domain,
        httpStatus,
        contentType: og.contentType,
        imagePath: `/api/previews/image/${hash}`,
        capturedAt: new Date().toISOString(),
        source: 'og',
      }
      index[hash] = rec
      saveIndex()
      return rec
    }

    writeSvgCard({
      hash,
      host: domain,
      title: meta.title || `HTTP ${httpStatus}`,
      badge: `OK ${httpStatus}`,
    })
    const rec: UrlPreviewRecord = {
      hash,
      url: key,
      domain,
      status: 'ok',
      title: meta.title || domain,
      httpStatus,
      contentType: ctype,
      imagePath: `/api/previews/image/${hash}`,
      capturedAt: new Date().toISOString(),
      source: 'card',
    }
    index[hash] = rec
    saveIndex()
    return rec
  } catch (err) {
    const rec: UrlPreviewRecord = {
      hash,
      url: key,
      domain,
      status: 'dead',
      title: err instanceof Error ? err.message.slice(0, 80) : 'Fetch failed',
      imagePath: `/api/previews/image/${hash}`,
      capturedAt: new Date().toISOString(),
      source: 'dead',
    }
    writeSvgCard({
      hash,
      host: domain || 'offline',
      title: 'Website mati / tidak merespons',
      badge: 'DEAD',
      dead: true,
    })
    index[hash] = rec
    saveIndex()
    return rec
  }
}

export function getCachedPreview(url: string): UrlPreviewRecord | null {
  const hash = previewHash(url)
  return loadIndex()[hash] || null
}

export function resolvePreviewFile(hash: string): { filePath: string; contentType: string } | null {
  if (!/^[a-f0-9]{16,64}$/i.test(hash)) return null
  ensureDir()
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg']) {
    const filePath = path.join(previewDir, `${hash}.${ext}`)
    if (fs.existsSync(filePath)) {
      const contentType =
        ext === 'svg'
          ? 'image/svg+xml'
          : ext === 'png'
            ? 'image/png'
            : ext === 'webp'
              ? 'image/webp'
              : ext === 'gif'
                ? 'image/gif'
                : 'image/jpeg'
      return { filePath, contentType }
    }
  }
  return null
}

export async function ensureUrlPreviews(urls: string[], opts?: { concurrency?: number }) {
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const key = normalizeUrlKey(raw)
    if (!key || seen.has(key)) continue
    // Skip obvious non-http junk
    if (!/^https?:\/\//i.test(key) && !key.includes('.')) continue
    seen.add(key)
    uniq.push(key)
  }

  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, 4))
  const out: UrlPreviewRecord[] = []
  let i = 0

  async function worker() {
    while (i < uniq.length) {
      const idx = i++
      const url = uniq[idx]!
      const hash = previewHash(url)
      const cached = loadIndex()[hash]
      if (cached && cached.status !== 'pending') {
        out[idx] = cached
        continue
      }
      let job = inFlight.get(hash)
      if (!job) {
        job = captureOne(url).finally(() => inFlight.delete(hash))
        inFlight.set(hash, job)
      }
      out[idx] = await job
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniq.length) }, () => worker()))
  return out.filter(Boolean)
}

export function listDomainsFromUrls(urls: string[]) {
  const counts = new Map<string, number>()
  for (const u of urls) {
    const d = extractHost(normalizeUrlKey(u))
    if (!d) continue
    counts.set(d, (counts.get(d) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
}
