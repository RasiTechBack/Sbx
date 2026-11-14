import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config } from '../config.js'

export type PreviewStatus = 'ok' | 'dead' | 'pending'

export type PreviewMeta = {
  url: string
  normalizedUrl: string
  domain: string
  title: string
  status: PreviewStatus
  imageFile?: string
  contentType?: string
  source: 'og' | 'card' | 'dead' | 'screenshot'
  /** Capture engine that produced this meta — used to invalidate old HTML/og cards. */
  engine?: 'html' | 'playwright'
  capturedAt: string
  error?: string
}

const previewRoot = path.join(config.dataDir, 'previews')

export function ensurePreviewDir() {
  fs.mkdirSync(previewRoot, { recursive: true })
}

export function normalizePreviewUrl(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const u = new URL(withScheme)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = ''
    }
    let pathname = u.pathname || '/'
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
    u.pathname = pathname
    return u.toString()
  } catch {
    return null
  }
}

export function previewHash(normalizedUrl: string) {
  return createHash('sha1').update(normalizedUrl).digest('hex')
}

export function previewPaths(hash: string) {
  ensurePreviewDir()
  return {
    meta: path.join(previewRoot, `${hash}.json`),
    image: path.join(previewRoot, `${hash}.img`),
  }
}

export function readPreviewMeta(hash: string): PreviewMeta | null {
  const { meta } = previewPaths(hash)
  if (!fs.existsSync(meta)) return null
  try {
    return JSON.parse(fs.readFileSync(meta, 'utf8')) as PreviewMeta
  } catch {
    return null
  }
}

export function writePreviewMeta(hash: string, data: PreviewMeta) {
  const { meta } = previewPaths(hash)
  fs.writeFileSync(meta, JSON.stringify(data, null, 0))
}

export function writePreviewImage(hash: string, buf: Buffer, extHint = 'img') {
  const file = path.join(previewRoot, `${hash}.${extHint === 'svg' ? 'svg' : 'img'}`)
  fs.writeFileSync(file, buf)
  return path.basename(file)
}

export function resolvePreviewImagePath(meta: PreviewMeta): string | null {
  if (!meta.imageFile) return null
  const full = path.join(previewRoot, meta.imageFile)
  return fs.existsSync(full) ? full : null
}

export function extractDomainFromUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}
