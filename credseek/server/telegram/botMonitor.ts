import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { TelegramClient, Api } from 'teleproto'
import { StringSession } from 'teleproto/sessions'
import { NewMessage, NewMessageEvent } from 'teleproto/events'
import { readTelegramConfig } from '../importers/fetchRemote.js'
import './tlCompat.js'
import { collectFromLines, type ParsedCredential } from '../importers/extract.js'
import { parseImportFile, SUPPORTED_EXTENSIONS } from '../importers/parseFile.js'
import { insertCredentialsUnified } from '../search/backend.js'
import { getDbStorageGuard } from '../storageGuard.js'
import {
  getMonitor,
  patchMonitor,
  readMonitors,
  type TelegramMonitor,
} from './monitors.js'

/** In-memory parse ceiling (zip/xlsx/etc). */
const MAX_FILE_BYTES = 512 * 1024 * 1024
/** Disk download ceiling for huge ULP .txt dumps. */
const MAX_DISK_FILE_BYTES = 3 * 1024 * 1024 * 1024
/**
 * Credible declared sizes above this are skipped before download.
 * Bogus ~2GB int32 artifacts are ignored (see isBogusSizeArtifact).
 * Non-Premium Telegram throttles (~8–11s/part) make multi‑GB downloads stall the whole queue.
 */
const MAX_DECLARED_DOWNLOAD_BYTES = 450 * 1024 * 1024
/** Absolute wall-clock cap per file download (ms). */
const MAX_DOWNLOAD_MS = 12 * 60_000
/** Abort if no new bytes for this long (ms). */
const DOWNLOAD_STALL_MS = 90_000
const STREAM_FLUSH_EVERY = 5000
const TMP_PREFIX = 'credseek-tg-'

function cleanupOrphanTgTempFiles() {
  try {
    const dir = os.tmpdir()
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(TMP_PREFIX)) continue
      try {
        fs.unlinkSync(path.join(dir, name))
      } catch {
        /* ignore busy */
      }
    }
  } catch {
    /* ignore */
  }
}
const DOC_EXTS = new Set(SUPPORTED_EXTENSIONS.map((e) => e.toLowerCase()))
const DUMP_EXTS = new Set([
  ...DOC_EXTS,
  'rar',
  '7z',
  'gz',
  'tgz',
  'tar',
  'xz',
  'zst',
  'lz4',
])

let client: TelegramClient | null = null
let starting: Promise<TelegramClient | null> | null = null
let userClient: TelegramClient | null = null
let userClientMeta: { ownerUserId: string; accountId: string } | null = null
let userStarting: Promise<TelegramClient | null> | null = null
const backfillRunning = new Set<string>()
const backfillQueued = new Set<string>()
/** Serialize channel backfills — parallel downloads hammer SQLite + Telegram floodwait. */
let backfillChain: Promise<void> = Promise.resolve()
const NO_CLIENT_ERROR =
  'Belum siap monitor: isi Bot token di Settings → Telegram, atau link Personal account (session). Saat ini hanya personal account yang terhubung — channel monitor bisa pakai itu jika akun sudah join group/channel.'

const SESSION_DEAD_ERROR =
  'Personal Telegram session mati (AUTH_KEY_DUPLICATED / expired). Unlink lalu link ulang di Settings → Telegram. Jangan pakai session yang sama di 2 tempat sekaligus (Telegram langsung invalidate).'

/** Telegram often reports ~2^31-1 as a bogus size; never treat that as real progress. */
const INT32_SIZE_ARTIFACT_MIN = 0x7ffff000
const INT32_SIZE_ARTIFACT_MAX = 0x80010000

function bytesFromProgress(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (value && typeof value === 'object') {
    const anyVal = value as { toJSNumber?: () => number; valueOf?: () => number | string }
    if (typeof anyVal.toJSNumber === 'function') {
      const n = anyVal.toJSNumber()
      if (Number.isFinite(n)) return n
    }
    if (typeof anyVal.valueOf === 'function') {
      const n = Number(anyVal.valueOf())
      if (Number.isFinite(n)) return n
    }
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function isBogusSizeArtifact(n: number) {
  return n >= INT32_SIZE_ARTIFACT_MIN && n <= INT32_SIZE_ARTIFACT_MAX
}

function isAuthKeyDuplicated(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || '')
  const code = err && typeof err === 'object' && 'errorMessage' in err ? String((err as { errorMessage?: string }).errorMessage || '') : ''
  return /AUTH_KEY_DUPLICATED|AuthKeyDuplicated/i.test(msg) || code === 'AUTH_KEY_DUPLICATED'
}

/** Normalize @username, t.me links, invite links, or raw chat IDs. */
export function normalizeChatInput(input: string) {
  let raw = input.trim().replace(/\s+/g, '')
  if (!raw) return ''
  raw = raw.replace(/^(chat[_-]?id|id)\s*[:=]\s*/i, '')
  if (raw.startsWith('@')) return raw

  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (!parts.length) return raw
      if (parts[0] === 'c' && parts[1]) {
        const id = parts[1].replace(/\D/g, '')
        return id ? `-100${id}` : raw
      }
      if (parts[0] === 'joinchat' || parts[0]?.startsWith('+')) return raw
      return parts[0]!.startsWith('@') ? parts[0]! : `@${parts[0]}`
    }
  } catch {
    /* ignore */
  }

  // Raw chat IDs: -100… (channel/supergroup), -… (basic group), or digits from t.me/c/
  if (/^-100\d{5,}$/.test(raw)) return raw
  if (/^-\d{5,}$/.test(raw)) return raw
  if (/^\d{6,}$/.test(raw)) return `-100${raw}`
  if (/^-?\d+$/.test(raw)) return raw

  return `@${raw.replace(/^@/, '')}`
}

/** Try several entity keys — helpful when users paste bare channel ids. */
function chatInputCandidates(input: string): string[] {
  const raw = input.trim().replace(/\s+/g, '').replace(/^(chat[_-]?id|id)\s*[:=]\s*/i, '')
  if (!raw) return []
  const normalized = normalizeChatInput(raw)
  const out: string[] = []
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v)
  }
  push(normalized)
  push(raw)
  if (/^\d{6,}$/.test(raw)) {
    push(`-100${raw}`)
    push(`-${raw}`)
  }
  if (/^-\d{5,}$/.test(raw) && !raw.startsWith('-100')) {
    push(`-100${raw.slice(1)}`)
  }
  return out
}

function extractInviteHash(input: string): string | null {
  const raw = input.trim().replace(/\s+/g, '')
  if (!raw) return null
  if (/^\+[A-Za-z0-9_-]{5,}$/.test(raw)) return raw.slice(1)
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts[0] === 'joinchat' && parts[1]) return parts[1]
      if (parts[0]?.startsWith('+') && parts[0].length > 5) return parts[0].slice(1)
    }
  } catch {
    /* ignore */
  }
  return null
}

function extractPublicUsername(input: string): string | null {
  const raw = input.trim().replace(/\s+/g, '')
  if (!raw) return null
  if (extractInviteHash(raw)) return null
  if (/^-?\d+$/.test(raw.replace(/^(chat[_-]?id|id)\s*[:=]\s*/i, ''))) return null

  const normalized = normalizeChatInput(raw)
  if (normalized.startsWith('@') && /^@[A-Za-z0-9_]{4,}$/i.test(normalized)) {
    return normalized.slice(1)
  }

  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (
        parts[0] &&
        parts[0] !== 'c' &&
        parts[0] !== 'joinchat' &&
        !parts[0].startsWith('+') &&
        /^[A-Za-z0-9_]{4,}$/.test(parts[0])
      ) {
        return parts[0]
      }
    }
  } catch {
    /* ignore */
  }

  if (/^@?[A-Za-z0-9_]{4,}$/.test(raw)) return raw.replace(/^@/, '')
  return null
}

async function clientIsBot(client: TelegramClient) {
  try {
    const me = await client.getMe()
    return Boolean(me && typeof me === 'object' && 'bot' in me && (me as { bot?: boolean }).bot)
  } catch {
    return false
  }
}

function isAlreadyJoinedError(message: string) {
  return /USER_ALREADY_PARTICIPANT|already a participant|already in/i.test(message)
}

async function importInviteLink(client: TelegramClient, inviteHash: string) {
  try {
    await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isAlreadyJoinedError(msg)) return
    if (/INVITE_REQUEST_SENT/i.test(msg)) {
      throw new Error(
        'Join request terkirim ke admin. Setelah disetujui, klik Add & backfill lagi.',
      )
    }
    if (/INVITE_HASH_EXPIRED/i.test(msg)) throw new Error('Invite link sudah kedaluwarsa')
    if (/INVITE_HASH_INVALID/i.test(msg)) throw new Error('Invite link tidak valid')
    throw new Error(`Auto-join via invite gagal: ${msg}`)
  }
}

/** Resolve @username via contacts.ResolveUsername, then JoinChannel with real accessHash. */
async function resolveAndJoinUsername(client: TelegramClient, username: string) {
  const uname = username.replace(/^@/, '').trim()
  if (!uname) throw new Error('Username kosong')

  let resolved: Api.contacts.TypeResolvedPeer
  try {
    resolved = await client.invoke(new Api.contacts.ResolveUsername({ username: uname }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/i.test(msg)) {
      throw new Error(`Username @${uname} tidak ditemukan di Telegram`)
    }
    throw new Error(`Gagal resolve @${uname}: ${msg}`)
  }

  const channel = (resolved.chats || []).find((c): c is Api.Channel => c instanceof Api.Channel)
  if (!channel) {
    const basic = (resolved.chats || []).find((c): c is Api.Chat => c instanceof Api.Chat)
    if (basic) {
      const peerId = await client.getPeerId(basic)
      return {
        chatId: String(peerId),
        title: basic.title || `@${uname}`,
        username: uname,
      }
    }
    throw new Error(`@${uname} ter-resolve tapi bukan channel/group yang bisa dimonitor`)
  }

  if (channel instanceof Api.ChannelForbidden || (channel as { banned?: boolean }).banned) {
    throw new Error(`@${uname} forbidden/banned untuk akun Telegram ini`)
  }

  if (!(await clientIsBot(client))) {
    if (channel.accessHash == null) {
      throw new Error(`@${uname} tidak punya accessHash — coba invite link`)
    }
    try {
      await client.invoke(
        new Api.channels.JoinChannel({
          channel: new Api.InputChannel({
            channelId: channel.id,
            accessHash: channel.accessHash,
          }),
        }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/INVITE_REQUEST_SENT/i.test(msg)) {
        throw new Error(
          'Join request terkirim ke admin. Setelah disetujui, klik Add & backfill lagi.',
        )
      }
      if (/CHANNELS_TOO_MUCH|USER_CHANNELS_TOO_MUCH/i.test(msg)) {
        throw new Error('Personal account sudah join terlalu banyak channel/group')
      }
      if (!isAlreadyJoinedError(msg)) {
        // Still usable if ResolveUsername returned the channel (already member / public)
        console.warn(`[tg] JoinChannel @${uname}:`, msg)
      }
    }
  }

  const peerId = await client.getPeerId(channel)
  return {
    chatId: String(peerId),
    title: channel.title || `@${uname}`,
    username: channel.username || uname,
  }
}

function fileExtFromName(name: string) {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

function tlClassName(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const obj = value as { className?: string; _?: string }
  return String(obj.className || obj._ || '')
}

function isTlOf(value: unknown, name: string, ctor?: new (...args: never[]) => unknown) {
  if (!value) return false
  if (ctor && value instanceof ctor) return true
  return tlClassName(value) === name || tlClassName(value).endsWith(`.${name}`)
}

type ExtractedDoc = {
  doc: Api.TypeDocument
  filename: string
  mime: string
  size: number
}

/** teleproto `long` fields are often big-integer / Long-like. */
function toByteSize(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 0 ? value : 0
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  if (value && typeof value === 'object') {
    const obj = value as {
      low?: number | string
      high?: number | string
      toJSNumber?: () => number
      toNumber?: () => number
      valueOf?: () => unknown
      toString?: (radix?: number) => string
    }
    if (typeof obj.low !== 'undefined' && typeof obj.high !== 'undefined') {
      const low = Number(obj.low) >>> 0
      const high = Number(obj.high) | 0
      const n = high * 4294967296 + low
      return Number.isFinite(n) && n >= 0 ? n : 0
    }
    if (typeof obj.toJSNumber === 'function') {
      const n = obj.toJSNumber()
      if (Number.isFinite(n) && n >= 0) return n
    }
    if (typeof obj.toNumber === 'function') {
      const n = obj.toNumber()
      if (Number.isFinite(n) && n >= 0) return n
    }
    if (typeof obj.toString === 'function') {
      const asString = obj.toString(10).replace(/[^\d]/g, '')
      if (asString) {
        const n = Number(asString)
        if (Number.isFinite(n) && n >= 0) return n
      }
    }
    if (typeof obj.valueOf === 'function') {
      const n = Number(obj.valueOf())
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  const asString = String(value ?? '').replace(/[^\d]/g, '')
  if (!asString) return 0
  const n = Number(asString)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Pull a document payload from a message — duck-typed for teleproto layer objects. */
function extractDocument(msg: Api.Message): ExtractedDoc | null {
  const media = msg.media
  if (!media) return null
  if (!isTlOf(media, 'MessageMediaDocument', Api.MessageMediaDocument)) return null
  const doc = (media as Api.MessageMediaDocument).document
  if (!doc || !isTlOf(doc, 'Document', Api.Document)) return null
  const real = doc as Api.Document
  const size = toByteSize(real.size)
  let filename = ''
  for (const attr of real.attributes || []) {
    if (isTlOf(attr, 'DocumentAttributeFilename', Api.DocumentAttributeFilename)) {
      filename = String((attr as Api.DocumentAttributeFilename).fileName || '')
      break
    }
  }
  return {
    doc: real,
    filename,
    mime: String(real.mimeType || '').toLowerCase(),
    size,
  }
}

function isMediaOnlyDocument(extracted: ExtractedDoc) {
  const { mime, filename, doc } = extracted
  if (/^(image|video|audio)\//.test(mime)) return true
  if (mime.includes('ogg') || mime.includes('webp') || mime.includes('sticker')) return true
  const ext = fileExtFromName(filename)
  if (['mp4', 'mp3', 'mov', 'mkv', 'webm', 'avi', 'm4a', 'ogg', 'opus', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'tgs', 'webm'].includes(ext)) {
    return true
  }
  for (const attr of (doc as Api.Document).attributes || []) {
    const name = tlClassName(attr)
    if (
      /DocumentAttribute(Video|Audio|Animated|Sticker|CustomEmoji|VideoStream)/i.test(name) ||
      attr instanceof Api.DocumentAttributeVideo ||
      attr instanceof Api.DocumentAttributeAudio ||
      attr instanceof Api.DocumentAttributeAnimated ||
      attr instanceof Api.DocumentAttributeSticker
    ) {
      // still allow if it also has a dump-like filename (.txt/.zip/…)
      if (ext && DOC_EXTS.has(ext)) return false
      return true
    }
  }
  return false
}

function looksLikeCredentialDump(extracted: ExtractedDoc) {
  const ext = fileExtFromName(extracted.filename)
  if (ext && DUMP_EXTS.has(ext)) return true
  if (extracted.mime.includes('text') || extracted.mime.includes('json') || extracted.mime.includes('zip')) {
    return true
  }
  return false
}

/**
 * Accept almost any channel "Files" tab document except clear media.
 * Do not trust declared size for rejection — ULP channels often report bogus ~2GB sizes
 * while the real download is much smaller. Enforce the limit on actual bytes after download.
 */
function isWantedDocument(msg: Api.Message) {
  const extracted = extractDocument(msg)
  if (!extracted) return false
  if (isMediaOnlyDocument(extracted)) return false
  // Always try non-media docs. Huge ULP .txt dumps are downloaded to disk and streamed.
  return true
}

function documentFilename(msg: Api.Message) {
  const extracted = extractDocument(msg)
  if (!extracted) return 'telegram.bin'
  if (extracted.filename) return extracted.filename
  const mime = extracted.mime || 'application/octet-stream'
  if (mime.includes('zip')) return 'telegram.zip'
  if (mime.includes('json')) return 'telegram.json'
  if (mime.includes('csv')) return 'telegram.csv'
  if (mime.includes('sql')) return 'telegram.sql'
  if (mime.includes('text')) return 'telegram.txt'
  return 'telegram.bin'
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function flushCredentialBucket(bucket: Map<string, ParsedCredential>) {
  if (!bucket.size) return { added: 0, skipped: 0 }
  const batch = [...bucket.values()]
  bucket.clear()
  return insertCredentialsUnified(batch)
}

async function importTextDumpFromPath(
  filePath: string,
  opts?: { onProgress?: (info: { lines: number; added: number; skipped: number }) => void },
) {
  const { yieldEventLoop } = await import('../util/yield.js')
  const bucket = new Map<string, ParsedCredential>()
  let added = 0
  let skipped = 0
  let lines = 0
  let lastProgressAt = Date.now()
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    lines += 1
    collectFromLines(`${line}\n`, bucket)
    if (bucket.size >= STREAM_FLUSH_EVERY) {
      const saved = await flushCredentialBucket(bucket)
      added += saved.added
      skipped += saved.skipped
      opts?.onProgress?.({ lines, added, skipped })
      lastProgressAt = Date.now()
    }
    // Keep HTTP/uploads responsive during multi‑hundred‑k line dumps.
    if (lines % 500 === 0) {
      await yieldEventLoop()
      if (Date.now() - lastProgressAt > 2_000) {
        opts?.onProgress?.({ lines, added, skipped })
        lastProgressAt = Date.now()
      }
      // No ULP-shaped hits after 30k lines → bail (e.g. non-credential dumps).
      if (lines >= 30_000 && added === 0 && skipped === 0 && bucket.size === 0) {
        console.warn(`[tg] stream abort — 0 credentials after ${lines} lines`)
        break
      }
    }
  }
  const saved = await flushCredentialBucket(bucket)
  added += saved.added
  skipped += saved.skipped
  opts?.onProgress?.({ lines, added, skipped })
  return { added, skipped, lines }
}

type ImportDocResult = {
  added: number
  skipped: number
  imported: boolean
  reason: string
}

async function importMessageDocument(
  msg: Api.Message,
  active: TelegramClient,
  opts?: {
    onDownloadProgress?: (info: {
      filename: string
      received: number
      declared: number
      phase: 'download' | 'import'
      lines?: number
      added?: number
      skipped?: number
    }) => void
  },
): Promise<ImportDocResult> {
  if (!isWantedDocument(msg)) return { added: 0, skipped: 0, imported: false, reason: 'not-wanted' }
  const storage = getDbStorageGuard()
  if (storage.paused) {
    return { added: 0, skipped: 0, imported: false, reason: 'db-size-limit' }
  }
  const extracted = extractDocument(msg)
  const filename = documentFilename(msg)
  const ext = fileExtFromName(filename)
  // CSV/TSV need the delimited parser (column headers). Plain ULP line-scan
  // on CSV rows with JSON "extra" fields hangs the CRED_LINE regex for minutes.
  const streamableText =
    ext === 'txt' ||
    ext === 'log' ||
    ext === 'json' ||
    ext === 'ndjson' ||
    ((extracted?.mime || '').includes('text') && ext !== 'csv' && ext !== 'tsv')

  const declared = extracted?.size || 0
  const declaredCredible = declared > 0 && !isBogusSizeArtifact(declared)
  if (declaredCredible && declared > MAX_DECLARED_DOWNLOAD_BYTES) {
    const mb = Math.round(declared / 1024 / 1024)
    console.warn(`[tg] skip oversized declared ${filename}: ${mb}MB`)
    return { added: 0, skipped: 0, imported: false, reason: `too-large-declared:${mb}MB` }
  }

  // Archives we cannot unpack in-process — skip without downloading.
  if (['rar', '7z', 'xz', 'zst', 'lz4'].includes(ext)) {
    return { added: 0, skipped: 0, imported: false, reason: `unsupported-archive:${ext}` }
  }

  const tmp = path.join(
    os.tmpdir(),
    `${TMP_PREFIX}${randomUUID()}${ext ? `.${ext}` : streamableText ? '.txt' : '.bin'}`,
  )

  try {
    try {
      const abort = new AbortController()
      let lastBytes = 0
      let lastProgressAt = Date.now()
      let lastLogAt = 0
      let lastPatchAt = 0
      const startedAt = Date.now()

      const progressCallback = ((received: unknown) => {
        const n = bytesFromProgress(received)
        if (!n || isBogusSizeArtifact(n)) return
        if (n > lastBytes) {
          lastBytes = n
          lastProgressAt = Date.now()
        }
        // Cap practical downloads at 450MB — multi‑GB ULP dumps stall the queue ~20h+.
        if (n > MAX_DECLARED_DOWNLOAD_BYTES || n > MAX_DISK_FILE_BYTES) {
          progressCallback.isCanceled = true
          abort.abort()
          return
        }
        const now = Date.now()
        if (now - startedAt > MAX_DOWNLOAD_MS) {
          progressCallback.isCanceled = true
          abort.abort()
          return
        }
        if (now - lastProgressAt > DOWNLOAD_STALL_MS) {
          progressCallback.isCanceled = true
          abort.abort()
          return
        }
        if (now - lastLogAt > 15_000) {
          lastLogAt = now
          console.log(
            `[tg] downloading ${filename}: ${Math.round(n / 1024 / 1024)}MB` +
              (declaredCredible ? ` / ${Math.round(declared / 1024 / 1024)}MB` : ''),
          )
        }
        if (now - lastPatchAt > 5_000) {
          lastPatchAt = now
          opts?.onDownloadProgress?.({
            filename,
            received: n,
            declared: declaredCredible ? declared : 0,
            phase: 'download',
          })
        }
      }) as ((received: unknown) => void) & { isCanceled?: boolean }

      // Stall watchdog — Premium throttle still ticks bytes; true hangs do not.
      const stallTimer = setInterval(() => {
        const now = Date.now()
        if (now - lastProgressAt > DOWNLOAD_STALL_MS || now - startedAt > MAX_DOWNLOAD_MS) {
          progressCallback.isCanceled = true
          abort.abort()
        }
      }, 5_000)
      stallTimer.unref?.()

      try {
        await withTimeout(
          active.downloadMedia(msg, {
            outputFile: tmp,
            progressCallback,
            signal: abort.signal,
          }),
          MAX_DOWNLOAD_MS + 30_000,
          `download ${filename}`,
        )
      } finally {
        clearInterval(stallTimer)
      }

      if (progressCallback.isCanceled) {
        if (lastBytes > MAX_DECLARED_DOWNLOAD_BYTES || lastBytes > MAX_DISK_FILE_BYTES) {
          return {
            added: 0,
            skipped: 0,
            imported: false,
            reason: `too-large-progress:${Math.round(lastBytes / 1024 / 1024)}MB`,
          }
        }
        if (Date.now() - startedAt > MAX_DOWNLOAD_MS) {
          return {
            added: 0,
            skipped: 0,
            imported: false,
            reason: `download-timeout:${Math.round(lastBytes / 1024 / 1024)}MB`,
          }
        }
        return {
          added: 0,
          skipped: 0,
          imported: false,
          reason: `download-stalled:${Math.round(lastBytes / 1024 / 1024)}MB`,
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[tg] download failed ${filename}:`, reason)
      if (/too-large/i.test(reason)) {
        return { added: 0, skipped: 0, imported: false, reason }
      }
      if (/timeout|aborted|AbortError|MediaAbort/i.test(reason)) {
        return { added: 0, skipped: 0, imported: false, reason: `download-aborted:${reason.slice(0, 80)}` }
      }
      return { added: 0, skipped: 0, imported: false, reason: 'download-failed' }
    }

    if (!fs.existsSync(tmp)) {
      return { added: 0, skipped: 0, imported: false, reason: 'empty-download' }
    }
    const size = fs.statSync(tmp).size
    if (!size) return { added: 0, skipped: 0, imported: false, reason: 'empty-buffer' }
    // Bogus declared sizes often look like ~2GB; enforce the real cap on disk bytes.
    if (size > MAX_DECLARED_DOWNLOAD_BYTES || size > MAX_DISK_FILE_BYTES) {
      console.warn(
        `[tg] skip oversized actual ${filename}: ${Math.round(size / 1024 / 1024)}MB`,
      )
      return {
        added: 0,
        skipped: 0,
        imported: false,
        reason: `too-large-actual:${Math.round(size / 1024 / 1024)}MB`,
      }
    }

    opts?.onDownloadProgress?.({
      filename,
      received: size,
      declared: declaredCredible ? declared : 0,
      phase: 'import',
    })

    if (streamableText) {
      try {
        console.log(
          `[tg] stream import start ${filename}: ${Math.round(size / 1024 / 1024)}MB`,
        )
        const saved = await importTextDumpFromPath(tmp, {
          onProgress: ({ lines, added, skipped }) => {
            opts?.onDownloadProgress?.({
              filename,
              received: size,
              declared: declaredCredible ? declared : 0,
              phase: 'import',
              lines,
              added,
              skipped,
            })
          },
        })
        console.log(
          `[tg] streamed ${filename}: ${Math.round(size / 1024 / 1024)}MB · ${saved.lines} lines · +${saved.added}`,
        )
        return { added: saved.added, skipped: saved.skipped, imported: true, reason: 'ok' }
      } catch (err) {
        console.warn(`[tg] stream parse failed ${filename}:`, err instanceof Error ? err.message : err)
        return { added: 0, skipped: 0, imported: false, reason: 'parse-failed' }
      }
    }

    if (size > MAX_FILE_BYTES) {
      return {
        added: 0,
        skipped: 0,
        imported: false,
        reason: `too-large-for-parser:${Math.round(size / 1024 / 1024)}MB`,
      }
    }

    try {
      const buffer = fs.readFileSync(tmp)
      const parsed = await parseImportFile(filename, buffer)
      const saved = await insertCredentialsUnified(parsed.credentials)
      return { added: saved.added, skipped: saved.skipped, imported: true, reason: 'ok' }
    } catch (err) {
      console.warn(`[tg] parse failed ${filename}:`, err instanceof Error ? err.message : err)
      return { added: 0, skipped: 0, imported: false, reason: 'parse-failed' }
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

export async function getBotClient(): Promise<TelegramClient | null> {
  const cfg = readTelegramConfig()
  if (!cfg.botToken?.trim() || !cfg.apiId || !cfg.apiHash?.trim()) return null

  if (client?.connected) return client
  if (starting) return starting

  starting = (async () => {
    try {
      if (client) {
        try {
          await client.disconnect()
        } catch {
          /* ignore */
        }
        client = null
      }
      const next = new TelegramClient(
        new StringSession(''),
        Number(cfg.apiId),
        cfg.apiHash.trim(),
        { connectionRetries: 5, useWSS: false },
      )
      await next.start({
        botAuthToken: cfg.botToken!.trim(),
      })
      client = next
      attachLiveHandler(next)
      return next
    } catch (err) {
      client = null
      throw err
    } finally {
      starting = null
    }
  })()

  return starting
}

let lastPersonalClientError = ''
let personalFailUntil = 0

async function getPersonalWatchClient(preferredUserId?: string): Promise<TelegramClient | null> {
  const { listUniqueLinkedAccountRows, purgeSessionsMatching } = await import('./auth.js')
  const ordered = listUniqueLinkedAccountRows(preferredUserId)
  if (!ordered.length) {
    lastPersonalClientError = ''
    return null
  }

  if (userClient?.connected && userClientMeta) {
    const stillThere = ordered.some((r) => r.account.id === userClientMeta!.accountId)
    if (stillThere) return userClient
  }

  if (Date.now() < personalFailUntil && lastPersonalClientError) {
    return null
  }

  if (userStarting) return userStarting

  userStarting = (async () => {
    let authDup = false
    let sawAuthFailure = false
    let deadSession = ''
    let deadTgUser = ''
    try {
      for (const row of ordered) {
        try {
          if (userClient) {
            try {
              await userClient.disconnect()
            } catch {
              /* ignore */
            }
            userClient = null
            userClientMeta = null
          }
          const next = new TelegramClient(
            new StringSession(row.account.session),
            row.account.apiId,
            row.account.apiHash,
            {
              connectionRetries: 3,
              useWSS: false,
              // Avoid silent multi-connection storms after AUTH_KEY_DUPLICATED.
              autoReconnect: false,
              floodSleepThreshold: 24,
            },
          )
          await next.connect()
          if (!(await next.checkAuthorization())) {
            sawAuthFailure = true
            await next.disconnect().catch(() => undefined)
            continue
          }
          // Prove the auth key is still accepted (checkAuthorization alone can race).
          await next.getMe()
          userClient = next
          userClientMeta = { ownerUserId: row.ownerUserId, accountId: row.account.id }
          attachLiveHandler(next)
          lastPersonalClientError = ''
          personalFailUntil = 0
          return next
        } catch (err) {
          if (isAuthKeyDuplicated(err)) {
            authDup = true
            deadSession = row.account.session
            deadTgUser = String(row.account.telegramUser?.id || '')
          } else {
            sawAuthFailure = true
          }
          console.warn(
            '[tg] personal session connect failed:',
            err instanceof Error ? err.message : err,
          )
        }
      }
      if (authDup) {
        const purged = purgeSessionsMatching({
          session: deadSession || undefined,
          telegramUserId: deadTgUser || undefined,
        })
        lastPersonalClientError =
          SESSION_DEAD_ERROR +
          (purged
            ? ` Session mati sudah dihapus (${purged}). Import session baru (hanya di 1 akun CredSeek).`
            : '')
        personalFailUntil = Date.now() + 60_000
      } else if (sawAuthFailure) {
        lastPersonalClientError =
          'Personal Telegram session gagal auth. Link ulang di Settings → Telegram.'
        personalFailUntil = Date.now() + 30_000
      } else {
        lastPersonalClientError = ''
      }
      return null
    } finally {
      userStarting = null
    }
  })()

  return userStarting
}

/** Prefer bot token; fall back to linked personal account sessions. */
export async function getMonitorClient(preferredUserId?: string): Promise<TelegramClient> {
  try {
    const bot = await getBotClient()
    if (bot) return bot
  } catch {
    /* fall through to personal accounts */
  }

  const personal = await getPersonalWatchClient(preferredUserId)
  if (personal) return personal

  if (lastPersonalClientError) throw new Error(lastPersonalClientError)

  const { countAllLinkedAccounts } = await import('./auth.js')
  if (countAllLinkedAccounts() > 0) throw new Error(SESSION_DEAD_ERROR)

  throw new Error(NO_CLIENT_ERROR)
}

export async function stopBotClient() {
  if (client) {
    try {
      await client.disconnect()
    } catch {
      /* ignore */
    }
  }
  client = null
}

export async function testBotConnection() {
  const active = await getBotClient()
  if (!active) throw new Error('Lengkapi bot token, api_id, dan api_hash di Settings')
  const me = await active.getMe()
  if (!me || !('username' in me)) throw new Error('Bot tidak valid')
  return {
    id: String(me.id),
    username: me.username || undefined,
    firstName: 'firstName' in me ? String(me.firstName || '') : undefined,
  }
}

export type TelegramDialogOption = {
  id: string
  title: string
  username?: string
  kind: 'channel' | 'group' | 'user'
  unread: number
}

/** Chat list from the linked personal account (groups/channels first). */
export async function listAccountDialogs(
  preferredUserId?: string,
  opts?: { limit?: number; query?: string; includeUsers?: boolean },
): Promise<TelegramDialogOption[]> {
  const personal = await getPersonalWatchClient(preferredUserId)
  if (!personal) {
    if (lastPersonalClientError) throw new Error(lastPersonalClientError)
    const { countAllLinkedAccounts } = await import('./auth.js')
    if (countAllLinkedAccounts() > 0) throw new Error(SESSION_DEAD_ERROR)
    throw new Error(
      'Link personal account di Settings → Telegram untuk memilih dari chat list.',
    )
  }

  const limit = Math.min(Math.max(Number(opts?.limit) || 100, 1), 250)
  const includeUsers = Boolean(opts?.includeUsers)
  const query = String(opts?.query || '')
    .trim()
    .toLowerCase()

  const dialogs = await personal.getDialogs({ limit })
  const out: TelegramDialogOption[] = []

  for (const dialog of dialogs) {
    if (dialog.isUser && !includeUsers) continue
    if (!dialog.id) continue

    const id = String(dialog.id)
    const title = String(dialog.title || dialog.name || id).trim() || id
    let username: string | undefined
    const entity = dialog.entity
    if (entity && typeof entity === 'object' && 'username' in entity && entity.username) {
      username = String(entity.username)
    }

    const kind: TelegramDialogOption['kind'] = dialog.isChannel
      ? 'channel'
      : dialog.isGroup
        ? 'group'
        : 'user'

    if (query) {
      const hay = `${title} ${username || ''} ${id}`.toLowerCase()
      if (!hay.includes(query)) continue
    }

    out.push({
      id,
      title,
      username,
      kind,
      unread: Number(dialog.unreadCount) || 0,
    })
  }

  out.sort((a, b) => {
    const rank = (k: TelegramDialogOption['kind']) =>
      k === 'channel' ? 0 : k === 'group' ? 1 : 2
    const d = rank(a.kind) - rank(b.kind)
    if (d !== 0) return d
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  })

  return out
}

function peerKeysMatch(a: string, b: string) {
  const na = String(a || '').replace(/^-/, '')
  const nb = String(b || '').replace(/^-/, '')
  if (!na || !nb) return false
  return (
    na === nb ||
    na === `100${nb}` ||
    nb === `100${na}` ||
    na.endsWith(nb) ||
    nb.endsWith(na)
  )
}

async function resolveFromDialogs(active: TelegramClient, input: string) {
  const candidates = chatInputCandidates(input)
  if (!candidates.length) return null
  const dialogs = await active.getDialogs({ limit: 200 })
  for (const dialog of dialogs) {
    if (!dialog.id) continue
    const id = String(dialog.id)
    if (!candidates.some((c) => peerKeysMatch(c, id))) continue
    const entity = dialog.entity
    let title = String(dialog.title || dialog.name || id)
    let username: string | undefined
    if (entity && typeof entity === 'object') {
      if ('title' in entity && entity.title) title = String(entity.title)
      if ('username' in entity && entity.username) username = String(entity.username)
    }
    return { chatId: id, title, username }
  }
  return null
}

async function resolveEntityFromInput(active: TelegramClient, input: string) {
  const candidates = chatInputCandidates(input)
  if (!candidates.length) throw new Error('Isi @username, link t.me, atau chat ID')

  let lastError: Error | null = null
  for (const entityKey of candidates) {
    try {
      const entity = await active.getEntity(entityKey)
      const peerId = await active.getPeerId(entity)
      let title = entityKey
      let username: string | undefined
      if ('title' in entity && entity.title) title = String(entity.title)
      if ('username' in entity && entity.username) username = String(entity.username)
      if ('firstName' in entity && entity.firstName) {
        title = [entity.firstName, 'lastName' in entity ? entity.lastName : '']
          .filter(Boolean)
          .join(' ')
      }
      return { chatId: String(peerId), title, username }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  // Numeric -100… IDs often need access_hash from dialog cache.
  try {
    const fromDialogs = await resolveFromDialogs(active, input)
    if (fromDialogs) return fromDialogs
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err))
  }

  throw (
    lastError ||
    new Error(
      'Chat ID tidak ketemu di session. Pastikan akun sudah join channel itu, atau pakai @username / Load chats.',
    )
  )
}

export async function resolveAndAttachMonitor(input: string, preferredUserId?: string) {
  const username = extractPublicUsername(input)
  const inviteHash = extractInviteHash(input)
  const joinable = Boolean(username || inviteHash)

  // Prefer personal account when auto-join is possible (bots cannot JoinChannel / ImportChatInvite).
  let active: TelegramClient | null = null
  if (joinable) {
    active = await getPersonalWatchClient(preferredUserId)
  }
  if (!active) {
    active = await getMonitorClient(preferredUserId)
  }

  const bot = await clientIsBot(active)

  if (username) {
    if (bot) {
      try {
        return await resolveAndJoinUsername(active, username)
      } catch {
        throw new Error(
          `Bot tidak bisa auto-join @${username}. Link personal account di Settings, atau add bot manual ke channel.`,
        )
      }
    }
    return await resolveAndJoinUsername(active, username)
  }

  if (inviteHash) {
    if (bot) {
      throw new Error(
        'Invite link butuh personal account (bot tidak bisa ImportChatInvite). Link personal account di Settings.',
      )
    }
    await importInviteLink(active, inviteHash)
    try {
      return await resolveEntityFromInput(active, input)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Sudah join invite, tapi resolve gagal: ${msg}`)
    }
  }

  try {
    return await resolveEntityFromInput(active, input)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /Could not find|CHANNEL|PEER/i.test(msg)
        ? `Chat ID tidak ditemukan (${msg}). Pastikan akun sudah join, atau pakai @username / invite link.`
        : msg,
    )
  }
}

/** Resolve channel entity with username/accessHash refresh — chatId alone often fails after restart. */
async function resolveMonitorEntity(monitor: {
  chatId: string
  input: string
  username?: string
  title?: string
}, preferredUserId?: string) {
  const username =
    (monitor.username || '').replace(/^@/, '').trim() ||
    extractPublicUsername(monitor.input || '') ||
    extractPublicUsername(monitor.chatId || '')

  // Prefer personal account when we can ResolveUsername / JoinChannel.
  let active: TelegramClient | null = null
  if (username) {
    active = await getPersonalWatchClient(preferredUserId)
  }
  if (!active) {
    active = await getMonitorClient(preferredUserId)
  }

  let lastError: Error | null = null

  if (username) {
    try {
      const resolved = await resolveAndJoinUsername(active, username)
      if (resolved.chatId && resolved.chatId !== monitor.chatId) {
        // keep chatId fresh when Telegram returns a stable peer id
        /* caller may patch */
      }
      const entity = await active.getEntity(resolved.chatId)
      return { active, entity, resolved }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(`[tg] resolve @${username} failed, trying chatId/input:`, lastError.message)
    }
  }

  const keys = [monitor.input, monitor.chatId].filter(Boolean)
  for (const key of keys) {
    try {
      const resolved = await resolveEntityFromInput(active, key)
      const entity = await active.getEntity(resolved.chatId)
      return { active, entity, resolved }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw (
    lastError ||
    new Error(
      `Tidak bisa resolve channel “${monitor.title || monitor.input || monitor.chatId}”. Pastikan akun sudah join, atau pakai @username.`,
    )
  )
}

export async function backfillMonitor(monitorId: string, preferredUserId?: string) {
  const existing = getMonitor(monitorId)
  if (!existing) throw new Error('Monitor tidak ditemukan')
  if (existing.status === 'paused') throw new Error('Monitor sedang di-pause')
  if (backfillRunning.has(monitorId) || backfillQueued.has(monitorId)) {
    return existing
  }

  backfillQueued.add(monitorId)
  patchMonitor(monitorId, {
    status: 'backfilling',
    error: undefined,
    progressNote: undefined,
    lastSyncAt: new Date().toISOString(),
  })

  const run = () => runBackfillMonitor(monitorId, preferredUserId)
  const queued = backfillChain.then(run, run)
  backfillChain = queued.then(
    () => undefined,
    () => undefined,
  )
  try {
    return await queued
  } finally {
    backfillQueued.delete(monitorId)
  }
}

async function runBackfillMonitor(monitorId: string, preferredUserId?: string) {
  if (backfillRunning.has(monitorId)) return getMonitor(monitorId)
  const monitor = getMonitor(monitorId)
  if (!monitor) throw new Error('Monitor tidak ditemukan')
  if (monitor.status === 'paused') throw new Error('Monitor sedang di-pause')

  backfillRunning.add(monitorId)
  patchMonitor(monitorId, {
    status: 'backfilling',
    error: undefined,
    lastSyncAt: new Date().toISOString(),
  })

  try {
    const { active, entity, resolved } = await resolveMonitorEntity(monitor, preferredUserId)
    if (resolved.chatId && resolved.chatId !== monitor.chatId) {
      patchMonitor(monitorId, {
        chatId: resolved.chatId,
        title: resolved.title || monitor.title,
        username: resolved.username || monitor.username,
      })
    }
    let filesImported = monitor.stats.filesImported || 0
    let recordsAdded = monitor.stats.recordsAdded || 0
    let recordsSkipped = monitor.stats.recordsSkipped || 0
    let docsSeen = monitor.stats.docsSeen || 0
    // Resume cursor — never re-download messages already walked (even if backfillDone=false).
    const resumeAfterId = Number(monitor.lastMessageId) || 0
    let maxId = resumeAfterId
    let processed = 0

    console.log(
      `[tg] backfill start · ${monitor.title} · resumeAfter=#${resumeAfterId} · docsSeen=${docsSeen} imported=${filesImported}`,
    )

    // Prefer document filter; fall back to full history if the filter path yields nothing useful.
    const iterate = async function* () {
      let count = 0
      try {
        for await (const msg of active.iterMessages(entity, {
          reverse: true,
          minId: resumeAfterId,
          filter: new Api.InputMessagesFilterDocument(),
        })) {
          count += 1
          yield msg
        }
      } catch (err) {
        console.warn('[tg] document-filter iter failed, falling back to all messages:', err)
      }
      if (count > 0) return
      for await (const msg of active.iterMessages(entity, {
        reverse: true,
        minId: resumeAfterId,
      })) {
        yield msg
      }
    }

    for await (const msg of iterate()) {
      const live = getMonitor(monitorId)
      if (live?.status === 'paused') {
        console.log(`[tg] backfill paused · ${monitor.title} · at #${maxId}`)
        return patchMonitor(monitorId, {
          status: 'paused',
          lastMessageId: maxId,
          lastSyncAt: new Date().toISOString(),
          progressNote: undefined,
          stats: { filesImported, recordsAdded, recordsSkipped, docsSeen },
        })
      }

      if (!(msg instanceof Api.Message) && tlClassName(msg) !== 'Message') continue
      const message = msg as Api.Message
      // Exclusive resume: skip anything already covered by lastMessageId.
      if (message.id <= resumeAfterId || message.id <= maxId) continue

      const hasDoc = Boolean(extractDocument(message))
      if (hasDoc) docsSeen += 1

      // Advance cursor BEFORE download/import so a crash/restart does not
      // re-download the same multi‑GB file forever.
      if (message.id > maxId) maxId = message.id
      processed += 1
      patchMonitor(monitorId, {
        lastMessageId: maxId,
        progressNote: hasDoc
          ? `Queued #${maxId} · ${documentFilename(message)}`
          : `Scanning · msg #${maxId}`,
        stats: { filesImported, recordsAdded, recordsSkipped, docsSeen },
        lastSyncAt: new Date().toISOString(),
        status: 'backfilling',
      })

      try {
        const result = await importMessageDocument(message, active, {
          onDownloadProgress: ({ filename, received, declared, phase, lines, added, skipped }) => {
            const mb = Math.round(received / 1024 / 1024)
            const total =
              declared > 0 ? ` / ${Math.round(declared / 1024 / 1024)}MB` : ''
            const liveAdded = recordsAdded + (added || 0)
            const liveSkipped = recordsSkipped + (skipped || 0)
            patchMonitor(monitorId, {
              progressNote:
                phase === 'import'
                  ? `Importing ${filename}` +
                    (lines != null
                      ? ` · ${lines.toLocaleString('en-US')} lines · +${added || 0}/${skipped || 0} · ${mb}MB`
                      : ` · ${mb}MB`)
                  : `Downloading ${filename} · ${mb}MB${total}`,
              lastSyncAt: new Date().toISOString(),
              status: 'backfilling',
              // Live counters so UI is not stuck at 0 while a multi‑GB dump inserts.
              stats: {
                filesImported,
                recordsAdded: liveAdded,
                recordsSkipped: liveSkipped,
                docsSeen,
              },
            })
          },
        })
        if (result.imported) {
          filesImported += 1
          recordsAdded += result.added
          recordsSkipped += result.skipped
          void import('./activity.js')
            .then(({ pushMonitorLog }) =>
              pushMonitorLog({
                monitorId,
                title: monitor.title,
                level: 'success',
                message: `File · ${documentFilename(message)} · +${result.added} records`,
                delta: {
                  files: 1,
                  recordsAdded: result.added || undefined,
                  recordsSkipped: result.skipped || undefined,
                },
              }),
            )
            .catch(() => undefined)
        } else if (hasDoc) {
          const extracted = extractDocument(message)
          console.warn(
            `[tg] skip #${message.id} ${documentFilename(message)} · ${result.reason || 'unknown'}`,
          )
          void import('./activity.js')
            .then(({ pushMonitorLog }) =>
              pushMonitorLog({
                monitorId,
                title: monitor.title,
                level: 'warn',
                message: `Skip ${documentFilename(message) || 'doc'} · ${result.reason || 'unknown'}${
                  extracted ? ` · ${extracted.size}B · ${extracted.mime || 'no-mime'}` : ''
                }`,
              }),
            )
            .catch(() => undefined)
        }
      } catch (err) {
        console.warn('[tg] import message failed:', err instanceof Error ? err.message : err)
      }

      if (processed === 1 || processed % 2 === 0 || hasDoc) {
        patchMonitor(monitorId, {
          lastMessageId: maxId,
          progressNote: `Scanning · msg #${maxId} · ${docsSeen} docs · ${filesImported} imported`,
          stats: { filesImported, recordsAdded, recordsSkipped, docsSeen },
          lastSyncAt: new Date().toISOString(),
          status: 'backfilling',
        })
      }
    }

    console.log(
      `[tg] backfill done · ${monitor.title} · last=#${maxId} · docs=${docsSeen} · files=${filesImported} · +${recordsAdded}`,
    )
    return patchMonitor(monitorId, {
      status: 'watching',
      backfillDone: true,
      lastMessageId: maxId,
      lastSyncAt: new Date().toISOString(),
      error: undefined,
      progressNote: undefined,
      stats: { filesImported, recordsAdded, recordsSkipped, docsSeen },
    })
  } catch (err) {
    return patchMonitor(monitorId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    backfillRunning.delete(monitorId)
  }
}

/**
 * After process restart: never auto-resume heavy TG backfills.
 * Auto-resume previously starved HTTP uploads (multer aborted) and tripped the runtime guard.
 * Operators continue via Monitoring → Backfill / Resume.
 */
export async function resumeIncompleteBackfills(_preferredUserId?: string) {
  cleanupOrphanTgTempFiles()
  const interrupted = readMonitors().filter((m) => m.status === 'backfilling')
  for (const m of interrupted) {
    console.log(`[tg] pause interrupted backfill after restart · ${m.title}`)
    patchMonitor(m.id, {
      status: 'paused',
      progressNote: 'Paused after restart — klik Backfill/Resume untuk lanjut',
      lastSyncAt: new Date().toISOString(),
    })
  }
  return interrupted.length
}

function normalizePeerKey(value: string | number | bigint | undefined | null) {
  if (value === undefined || value === null || value === '') return ''
  const raw = String(value).trim()
  if (!raw) return ''
  // Channel peers often appear as -100xxxxxxxxxx or plain xxxxxxxxxx
  if (/^-?\d+$/.test(raw)) {
    const abs = raw.replace(/^-/, '')
    if (abs.startsWith('100') && abs.length > 3) return abs
    return abs
  }
  return raw.toLowerCase()
}

function chatsMatch(monitorChatId: string, eventChatId: string | bigint | undefined) {
  const a = normalizePeerKey(monitorChatId)
  const b = normalizePeerKey(eventChatId)
  if (!a || !b) return false
  return a === b || a.endsWith(b) || b.endsWith(a)
}

function attachLiveHandler(active: TelegramClient) {
  active.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const msg = event.message
      if (!(msg instanceof Api.Message)) return
      if (!isWantedDocument(msg)) return

      const targets = readMonitors().filter(
        (m) => m.status === 'watching' && chatsMatch(m.chatId, event.chatId),
      )
      if (!targets.length) return

      const result = await importMessageDocument(msg, active)
      if (!result.imported) return

      for (const m of targets) {
        const fresh = getMonitor(m.id) || m
        patchMonitor(m.id, {
          lastMessageId: Math.max(fresh.lastMessageId, msg.id),
          lastSyncAt: new Date().toISOString(),
          stats: {
            filesImported: fresh.stats.filesImported + 1,
            recordsAdded: fresh.stats.recordsAdded + result.added,
            recordsSkipped: fresh.stats.recordsSkipped + result.skipped,
          },
        })
      }
    } catch {
      /* ignore live errors */
    }
  }, new NewMessage({}))
}

let startupBackfillsPaused = false

/** Call once after process boot — pause leftover 'backfilling' rows from a prior crash. */
export async function pauseInterruptedBackfillsOnStartup() {
  if (startupBackfillsPaused) return 0
  startupBackfillsPaused = true
  try {
    return await resumeIncompleteBackfills()
  } catch (err) {
    console.warn('[tg] startup pause interrupted failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

export async function ensureLiveWatcher(preferredUserId?: string) {
  try {
    // Establish a single shared client first — never resume while another
    // connect with the same StringSession is still in flight.
    await getMonitorClient(preferredUserId)
  } catch (err) {
    console.warn('[tg] watcher client not ready:', err instanceof Error ? err.message : err)
    return
  }
  // Do NOT call resumeIncompleteBackfills here — that would pause legitimate
  // in-progress history walks whenever a watching monitor is (re)attached.
}

export function listMonitorSnapshot(): TelegramMonitor[] {
  return readMonitors()
}
