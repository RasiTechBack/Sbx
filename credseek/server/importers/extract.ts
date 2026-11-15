import { credentialDedupeKey, parseCredentialLine, type RecordItem } from '../store.js'

export type ParsedCredential = Omit<RecordItem, 'id' | 'importedAt'>

export type FileImportResult = {
  filename: string
  format: string
  added: number
  skipped: number
  extracted: number
  warning?: string
  error?: string
}

const CRED_LINE =
  /(?:https?:\/\/|wss?:\/\/|ftp:\/\/|mongodb(?:\+srv)?:\/\/|redis:\/\/|mysql:\/\/|postgres(?:ql)?:\/\/|[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)+(?:\:\d+)?)[^\s:'"]*:([^\s:'"]+):([^\s:'"]+)/gi

const KEY_HINTS = ['url', 'host', 'domain', 'endpoint', 'link', 'username', 'user', 'login', 'email', 'password', 'pass', 'passwd', 'pwd', 'secret']

export function normalizeExt(filename: string) {
  const name = filename.toLowerCase()
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1) : ''
}

export type LineScanProgress = {
  bytesDone: number
  bytesTotal: number
  lines: number
  found: number
}

export function collectFromLines(
  text: string,
  bucket: Map<string, ParsedCredential>,
  onProgress?: (p: LineScanProgress) => void,
) {
  // Avoid text.split() allocating a huge array for multi‑MB dumps.
  let start = 0
  const n = text.length
  let lines = 0
  let lastEmit = 0
  while (start <= n) {
    if (start === n) break
    let end = text.indexOf('\n', start)
    if (end < 0) end = n
    let line = text.slice(start, end)
    start = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    lines += 1

    // Pathological combo dumps can contain multi‑KB mojibake lines that make
    // CRED_LINE thrash the event loop for minutes.
    if (line.length > 512) continue

    const parsed = parseCredentialLine(line)
    if (parsed) {
      pushParsed(parsed, bucket)
    } else if (line.length >= 12 && line.includes(':') && !looksLikeCsvRow(line)) {
      // Only run the expensive global regex when the line is not a plain ULP row.
      CRED_LINE.lastIndex = 0
      const matches = line.match(CRED_LINE)
      if (matches) {
        for (const m of matches) pushParsed(parseCredentialLine(m), bucket)
      }
    }

    if (onProgress && (start - lastEmit >= 256 * 1024 || start >= n)) {
      lastEmit = start
      onProgress({ bytesDone: start, bytesTotal: n, lines, found: bucket.size })
    }
  }
  if (onProgress && n === 0) {
    onProgress({ bytesDone: 0, bytesTotal: 0, lines: 0, found: bucket.size })
  }
}

/** CSV rows with embedded JSON colons — CRED_LINE regex thrashes on these. */
function looksLikeCsvRow(line: string) {
  let commas = 0
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 44) {
      commas += 1
      if (commas >= 3) return true
    }
  }
  return false
}

/** Async line scan that yields so Express can serve other requests mid-parse. */
export async function collectFromLinesAsync(
  text: string,
  bucket: Map<string, ParsedCredential>,
  onProgress?: (p: LineScanProgress) => void,
) {
  const { yieldEventLoop } = await import('../util/yield.js')
  let start = 0
  const n = text.length
  let lines = 0
  let lastEmit = 0
  let lastYield = 0
  while (start <= n) {
    if (start === n) break
    let end = text.indexOf('\n', start)
    if (end < 0) end = n
    let line = text.slice(start, end)
    start = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    lines += 1
    if (line.length > 512) continue

    const parsed = parseCredentialLine(line)
    if (parsed) {
      pushParsed(parsed, bucket)
    } else if (line.length >= 12 && line.includes(':') && !looksLikeCsvRow(line)) {
      CRED_LINE.lastIndex = 0
      const matches = line.match(CRED_LINE)
      if (matches) {
        for (const m of matches) pushParsed(parseCredentialLine(m), bucket)
      }
    }

    if (onProgress && (start - lastEmit >= 256 * 1024 || start >= n)) {
      lastEmit = start
      onProgress({ bytesDone: start, bytesTotal: n, lines, found: bucket.size })
    }
    if (start - lastYield >= 512 * 1024) {
      lastYield = start
      await yieldEventLoop()
    }
  }
  if (onProgress && n === 0) {
    onProgress({ bytesDone: 0, bytesTotal: 0, lines: 0, found: bucket.size })
  }
}

export function harvestAsciiStrings(
  buf: Buffer,
  bucket: Map<string, ParsedCredential>,
  onProgress?: (p: { bytesDone: number; bytesTotal: number; found: number }) => void,
) {
  // Extract printable runs and scan for credential patterns (binary DB dumps, mdf/ldf/accdb/etc.)
  let current = ''
  const flush = () => {
    if (current.length >= 8) {
      collectFromLines(current, bucket)
      const m = current.match(CRED_LINE)
      if (m) for (const item of m) pushParsed(parseCredentialLine(item), bucket)
    }
    current = ''
  }

  let lastEmit = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!
    const printable = c >= 32 && c <= 126
    if (printable) current += String.fromCharCode(c)
    else flush()
    if (current.length > 4000) flush()
    if (onProgress && (i - lastEmit >= 512 * 1024 || i + 1 === buf.length)) {
      lastEmit = i
      onProgress({ bytesDone: i + 1, bytesTotal: buf.length, found: bucket.size })
    }
  }
  flush()
  if (onProgress) {
    onProgress({ bytesDone: buf.length, bytesTotal: buf.length, found: bucket.size })
  }
}

export function pushParsed(
  parsed: ParsedCredential | null,
  bucket: Map<string, ParsedCredential>,
) {
  if (!parsed) return
  if (!parsed.url || !parsed.username) return
  const key = credentialDedupeKey(parsed)
  if (!bucket.has(key)) bucket.set(key, parsed)
}

export function rowsToCredentials(rows: string[][], bucket: Map<string, ParsedCredential>) {
  if (!rows.length) return
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const looksHeader = header.some((h) => KEY_HINTS.some((k) => h.includes(k)))

  let urlIdx = header.findIndex((h) => /^(url|host|domain|endpoint|link|site)$/.test(h) || h.includes('url'))
  let userIdx = header.findIndex((h) => /^(user|username|login|email|account)$/.test(h) || h.includes('user'))
  let passIdx = header.findIndex((h) => /^(pass|password|passwd|pwd|secret)$/.test(h) || h.includes('pass'))

  const start = looksHeader ? 1 : 0
  for (let r = start; r < rows.length; r++) {
    const row = rows[r]!
    if (!row.length) continue

    if (looksHeader && urlIdx >= 0 && userIdx >= 0 && passIdx >= 0) {
      const url = (row[urlIdx] || '').trim()
      const username = (row[userIdx] || '').trim()
      const password = (row[passIdx] || '').trim()
      if (url && username) {
        pushParsed(
          {
            isi: '',
            database: '',
            url,
            username,
            password,
            raw: `${url}:${username}:${password}`,
          },
          bucket,
        )
      }
      continue
    }

    // fallback: join cells / scan each cell
    const joined = row.join(':')
    pushParsed(parseCredentialLine(joined), bucket)
    for (const cell of row) {
      collectFromLines(String(cell ?? ''), bucket)
    }
  }
}

export function parseDelimited(text: string, delimiter: string, bucket: Map<string, ParsedCredential>) {
  const rows: string[][] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    rows.push(splitDelimitedLine(line, delimiter))
  }
  rowsToCredentials(rows, bucket)
}

function splitDelimitedLine(line: string, delimiter: string) {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
      continue
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

export function walkJson(value: unknown, bucket: Map<string, ParsedCredential>) {
  if (value == null) return
  if (typeof value === 'string') {
    collectFromLines(value, bucket)
    return
  }
  if (Array.isArray(value)) {
    // array of objects with credential fields
    if (value.length && typeof value[0] === 'object' && value[0] !== null) {
      const keys = Object.keys(value[0] as object)
      const header = keys
      const rows = [
        header,
        ...value.map((item) => header.map((k) => String((item as Record<string, unknown>)[k] ?? ''))),
      ]
      rowsToCredentials(rows, bucket)
    }
    for (const item of value) walkJson(item, bucket)
    return
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const lower: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v

    const url = String(lower.url ?? lower.host ?? lower.domain ?? lower.endpoint ?? lower.link ?? '')
    const username = String(lower.username ?? lower.user ?? lower.login ?? lower.email ?? '')
    const password = String(lower.password ?? lower.pass ?? lower.passwd ?? lower.pwd ?? lower.secret ?? '')
    if (url && username) {
      pushParsed(
        {
          isi: '',
          database: String(lower.database ?? lower.db ?? ''),
          url,
          username,
          password,
          raw: `${url}:${username}:${password}`,
        },
        bucket,
      )
    }
    for (const v of Object.values(obj)) walkJson(v, bucket)
  }
}

export function parseXmlText(text: string, bucket: Map<string, ParsedCredential>) {
  collectFromLines(text, bucket)
  // crude tag value extraction
  const tagValues = [...text.matchAll(/>([^<>]{3,200})</g)].map((m) => m[1]!.trim())
  for (const v of tagValues) collectFromLines(v, bucket)

  const attrs = [...text.matchAll(/\b(?:url|host|user(?:name)?|login|pass(?:word)?|pwd)\s*=\s*"([^"]+)"/gi)]
  // also try reconstructing from nearby attributes on same tag
  const tags = text.match(/<[^>]+>/g) || []
  for (const tag of tags) {
    const url = tag.match(/\b(?:url|host|domain|endpoint)\s*=\s*"([^"]+)"/i)?.[1]
    const user = tag.match(/\b(?:user|username|login)\s*=\s*"([^"]+)"/i)?.[1]
    const pass = tag.match(/\b(?:pass|password|pwd|secret)\s*=\s*"([^"]+)"/i)?.[1]
    if (url && user) {
      pushParsed(
        {
          isi: '',
          database: '',
          url,
          username: user,
          password: pass || '',
          raw: `${url}:${user}:${pass || ''}`,
        },
        bucket,
      )
    }
  }
  void attrs
}
