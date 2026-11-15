import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { parseImportFile } from './parseFile.js'
import { collectFromLines, type ParsedCredential } from './extract.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const telegramConfigPath = path.join(__dirname, '..', 'data', 'telegram.json')

const MAX_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 25_000

export type TelegramConfig = {
  botToken?: string
  apiId?: number
  apiHash?: string
  updatedAt?: string
  updatedBy?: string
}

export function readTelegramConfig(): TelegramConfig {
  try {
    if (!fs.existsSync(telegramConfigPath)) return {}
    return JSON.parse(fs.readFileSync(telegramConfigPath, 'utf8')) as TelegramConfig
  } catch {
    return {}
  }
}

export function writeTelegramConfig(cfg: TelegramConfig) {
  fs.writeFileSync(telegramConfigPath, JSON.stringify(cfg, null, 2), 'utf8')
}

function isPrivateIp(ip: string) {
  if (ip === '::1') return true
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    const a = parts[0] || 0
    const b = parts[1] || 0
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

export async function assertSafeUrl(rawUrl: string) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('URL tidak valid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hanya http/https yang diizinkan')
  }
  if (url.username || url.password) {
    throw new Error('URL dengan credentials tertanam ditolak')
  }

  const hostname = url.hostname
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('Host lokal/internal ditolak')
  }

  // Resolve DNS and block private ranges (basic SSRF guard)
  try {
    const records = await lookup(hostname, { all: true })
    for (const rec of records) {
      if (isPrivateIp(rec.address)) {
        throw new Error('URL mengarah ke jaringan privat/internal')
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('privat')) throw err
    // DNS failure — still attempt fetch but hostname checks above apply
  }

  return url
}

export function isTelegramUrl(url: URL) {
  const host = url.hostname.replace(/^www\./, '')
  return host === 't.me' || host === 'telegram.me' || host === 'telegram.dog'
}

function filenameFromUrl(url: URL, contentType: string) {
  const last = path.basename(url.pathname) || 'remote'
  if (last.includes('.')) return last
  if (contentType.includes('json')) return `${last || 'remote'}.json`
  if (contentType.includes('csv')) return `${last || 'remote'}.csv`
  if (contentType.includes('xml')) return `${last || 'remote'}.xml`
  if (contentType.includes('html')) return `${last || 'remote'}.html`
  if (contentType.includes('sheet') || contentType.includes('excel')) return `${last || 'remote'}.xlsx`
  return `${last || 'remote'}.txt`
}

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

export function extractTelegramPostText(html: string) {
  const chunks: string[] = []
  const widget = [
    ...html.matchAll(
      /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    ),
  ]
  for (const m of widget) chunks.push(decodeHtmlEntities(m[1] || ''))

  const og = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i)
  if (og?.[1]) chunks.push(decodeHtmlEntities(og[1]))

  const desc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)
  if (desc?.[1]) chunks.push(decodeHtmlEntities(desc[1]))

  return chunks.filter(Boolean).join('\n')
}

function parseTelegramPath(url: URL) {
  // /channel/123 or /s/channel/123 or /username
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 's') {
    return { username: parts[1], messageId: parts[2] ? Number(parts[2]) : undefined }
  }
  if (parts[0] === 'c') {
    return { chatId: parts[1] ? `-100${parts[1]}` : undefined, messageId: parts[2] ? Number(parts[2]) : undefined }
  }
  return { username: parts[0], messageId: parts[1] ? Number(parts[1]) : undefined }
}

async function verifyTelegramBot(botToken: string) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const json = (await res.json()) as { ok?: boolean; description?: string; result?: { username?: string } }
  if (!json.ok) {
    throw new Error(json.description || 'Bot token Telegram tidak valid')
  }
  return json.result?.username || 'bot'
}

async function fetchTelegramContent(url: URL) {
  const cfg = readTelegramConfig()
  const parsed = parseTelegramPath(url)

  if (parsed.chatId) {
    if (!cfg.botToken) {
      throw new Error(
        'Link privat t.me/c/... membutuhkan bot token admin/dev. Simpan token di halaman Import, atau gunakan link publik t.me/username/id',
      )
    }
    await verifyTelegramBot(cfg.botToken)
    const chatRes = await fetch(
      `https://api.telegram.org/bot${cfg.botToken}/getChat?chat_id=${encodeURIComponent(parsed.chatId)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    )
    const chatJson = (await chatRes.json()) as { ok?: boolean; description?: string }
    if (!chatJson.ok) {
      throw new Error(
        'Bot tidak punya akses ke chat privat ini. Jadikan bot sebagai admin channel/group.',
      )
    }
    throw new Error(
      'Pesan privat historis tidak bisa diambil lewat Bot API. Gunakan export chat Telegram / link publik / upload file.',
    )
  }

  // Optional: validate bot token is configured (admin/dev account integration)
  if (cfg.botToken) {
    try {
      await verifyTelegramBot(cfg.botToken)
    } catch {
      // continue with public scrape; token may be stale
    }
  }

  const candidates = [url.toString()]
  if (parsed.username && parsed.messageId) {
    candidates.unshift(`https://t.me/${parsed.username}/${parsed.messageId}?embed=1&mode=tme`)
    candidates.unshift(`https://t.me/s/${parsed.username}/${parsed.messageId}`)
  } else if (parsed.username) {
    candidates.unshift(`https://t.me/s/${parsed.username}`)
  }

  let lastError = 'Gagal mengambil konten Telegram'
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'CredSeekImporter/1.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      })
      if (!res.ok) {
        lastError = `Telegram HTTP ${res.status}`
        continue
      }
      const html = await res.text()
      const text = extractTelegramPostText(html)
      if (text.trim()) {
        return {
          filename: `telegram-${parsed.username || 'chat'}-${parsed.messageId || 'feed'}.txt`,
          buffer: Buffer.from(text, 'utf8'),
          source: candidate,
          kind: 'telegram' as const,
        }
      }
      lastError = 'Konten Telegram kosong / tidak publik'
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Fetch Telegram gagal'
    }
  }
  throw new Error(lastError)
}

export async function fetchRemoteSource(rawUrl: string, userId?: string) {
  const url = await assertSafeUrl(rawUrl.trim())

  if (isTelegramUrl(url)) {
    if (userId) {
      try {
        const { fetchTelegramMessageTextWithUser, listLinkedTelegramAccounts } = await import(
          '../telegram/auth.js'
        )
        if (listLinkedTelegramAccounts(userId).length > 0) {
          const text = await fetchTelegramMessageTextWithUser(userId, url.toString())
          const parsed = parseTelegramPath(url)
          return {
            filename: `telegram-user-${parsed.username || parsed.chatId || 'chat'}-${parsed.messageId || 'msg'}.txt`,
            buffer: Buffer.from(text, 'utf8'),
            source: url.toString(),
            kind: 'telegram' as const,
          }
        }
      } catch (err) {
        // fall back to public scrape if user session cannot read the message
        if (err instanceof Error && err.message.includes('belum terhubung')) {
          // continue
        } else {
          // try public next; keep error if both fail
          try {
            return await fetchTelegramContent(url)
          } catch {
            throw err
          }
        }
      }
    }
    return fetchTelegramContent(url)
  }

  const res = await fetch(url.toString(), {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'CredSeekImporter/1.0',
      Accept: '*/*',
    },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} saat mengunduh URL`)
  }

  const contentType = res.headers.get('content-type') || ''
  const lenHeader = Number(res.headers.get('content-length') || 0)
  if (lenHeader > MAX_BYTES) {
    throw new Error('File remote terlalu besar (max 25MB)')
  }

  const ab = await res.arrayBuffer()
  if (ab.byteLength > MAX_BYTES) {
    throw new Error('File remote terlalu besar (max 25MB)')
  }

  return {
    filename: filenameFromUrl(url, contentType),
    buffer: Buffer.from(ab),
    source: url.toString(),
    kind: 'url' as const,
  }
}

export async function importFromRemoteUrl(rawUrl: string, userId?: string) {
  const remote = await fetchRemoteSource(rawUrl, userId)
  const parsed = await parseImportFile(remote.filename, remote.buffer)

  // Telegram text may not match file parser path well if empty credentials structured — also scan raw text
  if (remote.kind === 'telegram' && parsed.credentials.length === 0) {
    const bucket = new Map<string, ParsedCredential>()
    collectFromLines(remote.buffer.toString('utf8'), bucket)
    return {
      ...remote,
      credentials: [...bucket.values()],
      meta: {
        filename: remote.filename,
        format: 'telegram',
        extracted: bucket.size,
      },
    }
  }

  return {
    ...remote,
    credentials: parsed.credentials,
    meta: {
      ...parsed.meta,
      format: remote.kind === 'telegram' ? `telegram:${parsed.meta.format}` : parsed.meta.format,
    },
  }
}
