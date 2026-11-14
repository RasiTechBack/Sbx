import { createHash } from 'node:crypto'

const UA =
  'Mozilla/5.0 (compatible; CredSeekEnrich/1.0; +https://credseek.local)'

export function normalizeEnrichUrl(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const u = new URL(withScheme)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    u.hash = ''
    u.username = ''
    u.password = ''
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

export function enrichUrlKey(normalizedUrl: string) {
  return createHash('sha1').update(normalizedUrl).digest('hex')
}

export function extractDomainLc(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true
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

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

function metaContent(html: string, ...names: string[]) {
  for (const name of names) {
    const re1 = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i',
    )
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
      'i',
    )
    const m = html.match(re1) || html.match(re2)
    if (m?.[1]) return decodeEntities(m[1].replace(/\s+/g, ' ').trim())
  }
  return ''
}

function stripHtmlToText(html: string, maxLen: number) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  t = decodeEntities(t).replace(/\s+/g, ' ').trim()
  if (t.length <= maxLen) return t
  return t.slice(0, maxLen)
}

export type PageEnrichResult = {
  urlKey: string
  url: string
  domainLc: string
  title: string
  description: string
  bodyExcerpt: string
  status: 'ok' | 'dead' | 'blocked' | 'error'
  httpStatus?: number
}

export async function fetchPageEnrichment(rawUrl: string): Promise<PageEnrichResult> {
  const normalized = normalizeEnrichUrl(rawUrl)
  if (!normalized) {
    return {
      urlKey: enrichUrlKey(String(rawUrl || '')),
      url: String(rawUrl || ''),
      domainLc: '',
      title: '',
      description: '',
      bodyExcerpt: '',
      status: 'blocked',
    }
  }
  const urlKey = enrichUrlKey(normalized)
  const domainLc = extractDomainLc(normalized)
  try {
    const host = new URL(normalized).hostname
    if (isPrivateHost(host)) {
      return {
        urlKey,
        url: normalized,
        domainLc,
        title: '',
        description: '',
        bodyExcerpt: '',
        status: 'blocked',
      }
    }
  } catch {
    return {
      urlKey,
      url: normalized,
      domainLc,
      title: '',
      description: '',
      bodyExcerpt: '',
      status: 'blocked',
    }
  }

  try {
    const res = await fetch(normalized, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
    })
    const httpStatus = res.status
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    if (!res.ok) {
      return {
        urlKey,
        url: normalized,
        domainLc: extractDomainLc(res.url || normalized) || domainLc,
        title: '',
        description: '',
        bodyExcerpt: '',
        status: 'dead',
        httpStatus,
      }
    }
    if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
      return {
        urlKey,
        url: normalized,
        domainLc: extractDomainLc(res.url || normalized) || domainLc,
        title: domainLc,
        description: ctype.slice(0, 80),
        bodyExcerpt: '',
        status: 'ok',
        httpStatus,
      }
    }
    // Cap read — first ~180KB is enough for title/meta + excerpt
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const maxBytes = 180_000
    if (reader) {
      while (size < maxBytes) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        size += value.byteLength
        if (size >= maxBytes) break
      }
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      chunks.push(buf.subarray(0, maxBytes))
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
    const title =
      metaContent(html, 'og:title', 'twitter:title') ||
      decodeEntities(
        (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim(),
      )
    const description =
      metaContent(html, 'og:description', 'description', 'twitter:description') ||
      stripHtmlToText(html, 280)
    const bodyExcerpt = stripHtmlToText(html, 4000)

    return {
      urlKey,
      url: normalized,
      domainLc: extractDomainLc(res.url || normalized) || domainLc,
      title: title.slice(0, 300),
      description: description.slice(0, 500),
      bodyExcerpt,
      status: 'ok',
      httpStatus,
    }
  } catch {
    return {
      urlKey,
      url: normalized,
      domainLc,
      title: '',
      description: '',
      bodyExcerpt: '',
      status: 'error',
    }
  }
}
