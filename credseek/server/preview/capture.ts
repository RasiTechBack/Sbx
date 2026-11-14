import dns from 'node:dns/promises'
import net from 'node:net'
import { chromium, type Browser } from 'playwright'
import {
  extractDomainFromUrl,
  normalizePreviewUrl,
  previewHash,
  previewPaths,
  readPreviewMeta,
  writePreviewImage,
  writePreviewMeta,
  type PreviewMeta,
} from './store.js'

const NAV_TIMEOUT_MS = Number(process.env.PREVIEW_TIMEOUT_MS) || 20_000
const SETTLE_MS = Number(process.env.PREVIEW_SETTLE_MS) || 900
const VIEWPORT = { width: 1280, height: 800 }
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

let browserPromise: Promise<Browser> | null = null
let captureQueue: Promise<unknown> = Promise.resolve()

function isPrivateIp(ip: string) {
  if (net.isIP(ip) === 0) return true
  if (ip === '127.0.0.1' || ip === '::1') return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true
  const m = ip.match(/^172\.(\d+)\./)
  if (m) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return true
  }
  return false
}

async function assertPublicHttpUrl(raw: string) {
  const normalized = normalizePreviewUrl(raw)
  if (!normalized) throw new Error('URL tidak valid')
  const u = new URL(normalized)
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Hanya http/https')
  if (!u.hostname || u.hostname === 'localhost') throw new Error('Host diblokir')
  const resolved = await dns.lookup(u.hostname, { all: true })
  if (!resolved.length) throw new Error('DNS gagal')
  for (const r of resolved) {
    if (isPrivateIp(r.address)) throw new Error('IP privat diblokir')
  }
  return normalized
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function wrapText(text: string, maxChars: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length <= maxChars) cur = next
    else {
      if (cur) lines.push(cur)
      cur = w.slice(0, maxChars)
      if (lines.length >= maxLines) break
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  return lines
}

function buildCardSvg(opts: {
  title: string
  domain: string
  url: string
  dead?: boolean
}) {
  const bg = opts.dead ? '#1a0f12' : '#0b1220'
  const accent = opts.dead ? '#fb7185' : '#2dd4bf'
  const badge = opts.dead ? 'WEB MATI' : 'PREVIEW'
  const title = opts.title || (opts.dead ? 'Situs tidak dapat dijangkau' : opts.domain || 'Tanpa judul')
  const lines = wrapText(title, 34, 3)
  const lineNodes = lines
    .map(
      (line, i) =>
        `<text x="24" y="${88 + i * 28}" fill="#eef3f8" font-size="18" font-family="Segoe UI, Arial, sans-serif">${escapeXml(line)}</text>`,
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
  <rect width="320" height="200" rx="14" fill="${bg}"/>
  <rect x="0" y="0" width="320" height="6" fill="${accent}"/>
  <rect x="24" y="24" width="86" height="22" rx="6" fill="${accent}" fill-opacity="0.18"/>
  <text x="32" y="40" fill="${accent}" font-size="11" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${badge}</text>
  ${lineNodes}
  <text x="24" y="172" fill="#8b9bb0" font-size="12" font-family="Consolas, monospace">${escapeXml((opts.domain || opts.url).slice(0, 42))}</text>
</svg>`
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--hide-scrollbars',
        ],
      })
      .catch((err) => {
        browserPromise = null
        throw err
      })
  }
  return browserPromise
}

async function withCaptureLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = captureQueue.then(fn, fn)
  captureQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function screenshotUrl(normalized: string): Promise<{ title: string; buf: Buffer }> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    bypassCSP: true,
    locale: 'id-ID',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

  try {
    // Block heavy media to keep VPS RAM/CPU down.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      if (type === 'media' || type === 'font') return route.abort()
      return route.continue()
    })

    const resp = await page.goto(normalized, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    })
    if (resp && resp.status() >= 500) {
      throw new Error(`HTTP ${resp.status()}`)
    }

    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const title = (await page.title()).trim().slice(0, 160)
    const buf = Buffer.from(
      await page.screenshot({
        type: 'jpeg',
        quality: 68,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      }),
    )
    return { title, buf }
  } finally {
    await page.close().catch(() => undefined)
    await context.close().catch(() => undefined)
  }
}

function shouldRefresh(existing: PreviewMeta | null, force?: boolean) {
  if (force) return true
  if (!existing) return true
  // Upgrade anything not produced by Playwright (old HTML/og cards).
  if (existing.engine !== 'playwright') return true
  return false
}

export async function capturePreview(rawUrl: string, opts?: { force?: boolean }): Promise<PreviewMeta> {
  const normalized = await assertPublicHttpUrl(rawUrl)
  const hash = previewHash(normalized)
  const existing = readPreviewMeta(hash)
  if (!shouldRefresh(existing, opts?.force)) return existing!

  const domain = extractDomainFromUrl(normalized)
  const now = new Date().toISOString()

  return withCaptureLock(async () => {
    // Re-check cache inside the lock — another request may have finished first.
    const again = readPreviewMeta(hash)
    if (!shouldRefresh(again, opts?.force)) return again!

    try {
      const shot = await screenshotUrl(normalized)
      const imageFile = writePreviewImage(hash, shot.buf, 'img')
      const meta: PreviewMeta = {
        url: rawUrl,
        normalizedUrl: normalized,
        domain,
        title: shot.title || domain || normalized,
        status: 'ok',
        imageFile,
        contentType: 'image/jpeg',
        source: 'screenshot',
        engine: 'playwright',
        capturedAt: now,
      }
      writePreviewMeta(hash, meta)
      return meta
    } catch (err) {
      const svg = buildCardSvg({
        title: 'Situs tidak dapat dijangkau',
        domain,
        url: normalized,
        dead: true,
      })
      const imageFile = writePreviewImage(hash, Buffer.from(svg, 'utf8'), 'svg')
      const meta: PreviewMeta = {
        url: rawUrl,
        normalizedUrl: normalized,
        domain,
        title: domain || 'Web mati',
        status: 'dead',
        imageFile,
        contentType: 'image/svg+xml',
        source: 'dead',
        engine: 'playwright',
        capturedAt: now,
        error: err instanceof Error ? err.message : String(err),
      }
      writePreviewMeta(hash, meta)
      return meta
    }
  })
}

export function getCachedPreview(rawUrl: string): PreviewMeta | null {
  const normalized = normalizePreviewUrl(rawUrl)
  if (!normalized) return null
  const meta = readPreviewMeta(previewHash(normalized))
  if (!meta || meta.engine !== 'playwright') return null
  return meta
}

export function previewPublicPath(meta: PreviewMeta) {
  const normalized = meta.normalizedUrl
  const hash = previewHash(normalized)
  return `/api/preview/image/${hash}?v=pw1`
}

export async function closePreviewBrowser() {
  if (!browserPromise) return
  try {
    const b = await browserPromise
    await b.close()
  } catch {
    /* ignore */
  } finally {
    browserPromise = null
  }
}

export { previewPaths, previewHash }
