import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import initSqlJs from 'sql.js'
import { credentialDedupeKey } from '../store.js'
import {
  collectFromLines,
  collectFromLinesAsync,
  harvestAsciiStrings,
  normalizeExt,
  parseDelimited,
  parseXmlText,
  rowsToCredentials,
  walkJson,
  type FileImportResult,
  type ParsedCredential,
} from './extract.js'
import type { ImportProgressFn } from './progress.js'
import { yieldEventLoop } from '../util/yield.js'

const ZIP_MAX_ENTRIES = 2500
const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024
const ZIP_MAX_ENTRY_BYTES = 80 * 1024 * 1024

const TEXT_EXTS = new Set([
  'txt',
  'log',
  'sql',
  'csv',
  'tsv',
  'json',
  'xml',
  'yml',
  'yaml',
  'ini',
  'conf',
  'cfg',
  'env',
  'md',
  'html',
  'htm',
])

const SQLITE_EXTS = new Set(['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'])

const BINARY_DB_EXTS = new Set([
  'accdb',
  'mdb',
  'mdf',
  'ndf',
  'ldf',
  'frm',
  'ibd',
  'myd',
  'myi',
  'dump',
  'bak',
  'dmp',
  'dat',
  'bin',
])

export const SUPPORTED_EXTENSIONS = [
  'txt',
  'log',
  'sql',
  'csv',
  'tsv',
  'json',
  'xml',
  'xlsx',
  'xls',
  'xlsm',
  'ods',
  'sqlite',
  'sqlite3',
  'db',
  'accdb',
  'mdb',
  'mdf',
  'ndf',
  'ldf',
  'bak',
  'dump',
  'yml',
  'yaml',
  'env',
  'html',
  'zip',
]

function safeZipEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('\0')) return null
  if (/^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return normalized
}

export type ParseImportOptions = {
  onProgress?: ImportProgressFn
  /** When true, skip outer start/finish events (used for nested ZIP entries). */
  nested?: boolean
}

function emitParse(
  onProgress: ImportProgressFn | undefined,
  pct: number,
  message: string,
  extra?: { done?: number; total?: number; found?: number; detail?: string },
) {
  onProgress?.({
    phase: 'parse',
    pct,
    message,
    ...extra,
  })
}

export async function parseImportFile(
  filename: string,
  buffer: Buffer,
  opts?: ParseImportOptions,
): Promise<{ credentials: ParsedCredential[]; meta: Omit<FileImportResult, 'added' | 'skipped'> & { extracted: number } }> {
  const onProgress = opts?.onProgress
  const ext = normalizeExt(filename)
  const bucket = new Map<string, ParsedCredential>()
  let format = ext || 'unknown'
  let warning: string | undefined
  let error: string | undefined

  if (!opts?.nested) {
    emitParse(onProgress, 0, `Parse mulai · ${filename} · ${(buffer.length / (1024 * 1024)).toFixed(2)} MB`, {
      done: 0,
      total: buffer.length,
      found: 0,
      detail: ext || 'unknown',
    })
  }

  const lineProgress = (label: string) => (p: { bytesDone: number; bytesTotal: number; lines?: number; found: number }) => {
    const pct = p.bytesTotal > 0 ? Math.min(99, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 50
    const linesPart = p.lines != null ? ` · ${p.lines.toLocaleString('id-ID')} baris` : ''
    emitParse(
      onProgress,
      pct,
      `${label}${linesPart} · ${p.found.toLocaleString('id-ID')} creds · ${Math.round(p.bytesDone / 1024).toLocaleString('id-ID')} KB`,
      { done: p.bytesDone, total: p.bytesTotal, found: p.found },
    )
  }

  try {
    if (ext === 'json') {
      format = 'json'
      emitParse(onProgress, 10, 'Decode JSON…')
      walkJson(JSON.parse(buffer.toString('utf8')), bucket)
      emitParse(onProgress, 90, `JSON walk selesai · ${bucket.size.toLocaleString('id-ID')} creds`, {
        found: bucket.size,
      })
    } else if (ext === 'xml' || ext === 'html' || ext === 'htm') {
      format = ext
      emitParse(onProgress, 10, `Parse ${ext.toUpperCase()}…`)
      parseXmlText(buffer.toString('utf8'), bucket)
    } else if (ext === 'csv') {
      format = 'csv'
      emitParse(onProgress, 10, 'Parse CSV…')
      parseDelimited(buffer.toString('utf8'), ',', bucket)
    } else if (ext === 'tsv') {
      format = 'tsv'
      emitParse(onProgress, 10, 'Parse TSV…')
      parseDelimited(buffer.toString('utf8'), '\t', bucket)
    } else if (ext === 'xlsx' || ext === 'xlsm') {
      format = ext
      emitParse(onProgress, 5, 'Load workbook Excel…')
      await parseExcelXlsx(buffer, bucket, onProgress)
    } else if (ext === 'xls') {
      format = 'xls'
      harvestAsciiStrings(buffer, bucket, lineProgress('Harvest .xls binary'))
      warning = 'Legacy .xls: extracted via binary string harvest (convert to .xlsx for best results)'
    } else if (SQLITE_EXTS.has(ext)) {
      format = 'sqlite'
      await parseSqlite(buffer, bucket, onProgress)
    } else if (TEXT_EXTS.has(ext)) {
      format = ext
      await collectFromLinesAsync(buffer.toString('utf8'), bucket, lineProgress(`Scan .${ext}`))
    } else if (ext === 'zip') {
      format = 'zip'
      warning = await parseZipArchive(filename, buffer, bucket, onProgress)
    } else if (BINARY_DB_EXTS.has(ext) || !ext) {
      format = ext || 'binary'
      harvestAsciiStrings(buffer, bucket, lineProgress('Harvest binary strings'))
      warning =
        'Binary DB format: credentials extracted from readable strings inside the file'
    } else {
      format = ext
      const asText = buffer.toString('utf8')
      await collectFromLinesAsync(asText, bucket, lineProgress(`Scan .${ext}`))
      harvestAsciiStrings(buffer, bucket, lineProgress(`Harvest .${ext}`))
      warning = `.${ext} handled with generic extraction`
    }
  } catch (err) {
    harvestAsciiStrings(buffer, bucket, lineProgress('Fallback harvest'))
    error = err instanceof Error ? err.message : 'Parse failed'
  }

  if (!opts?.nested) {
    emitParse(onProgress, 100, `Parse selesai · ${bucket.size.toLocaleString('id-ID')} credentials`, {
      done: buffer.length,
      total: buffer.length,
      found: bucket.size,
      detail: format,
    })
  }

  return {
    credentials: [...bucket.values()],
    meta: {
      filename,
      format,
      extracted: bucket.size,
      warning,
      error,
    },
  }
}

async function parseZipArchive(
  zipName: string,
  buffer: Buffer,
  bucket: Map<string, ParsedCredential>,
  onProgress?: ImportProgressFn,
): Promise<string | undefined> {
  emitParse(onProgress, 2, 'Unzip archive…', { detail: zipName })
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(buffer), {
      filter(file) {
        if (file.originalSize > ZIP_MAX_ENTRY_BYTES) return false
        return true
      },
    })
  } catch (err) {
    throw new Error(err instanceof Error ? `Invalid ZIP: ${err.message}` : 'Invalid ZIP archive')
  }

  const names = Object.keys(entries)
  if (names.length > ZIP_MAX_ENTRIES) {
    throw new Error(`ZIP has too many entries (max ${ZIP_MAX_ENTRIES})`)
  }

  const workNames = names.filter((raw) => {
    const safe = safeZipEntryName(raw)
    return Boolean(safe && !safe.endsWith('/'))
  })
  emitParse(onProgress, 5, `ZIP dibuka · ${workNames.length} entry`, {
    done: 0,
    total: workNames.length,
    found: bucket.size,
  })

  let totalBytes = 0
  let parsedFiles = 0
  let skippedNestedZip = 0
  let skippedUnsafe = 0
  const warnings: string[] = []
  let processed = 0

  for (const rawName of names) {
    const safeName = safeZipEntryName(rawName)
    if (!safeName) {
      skippedUnsafe += 1
      continue
    }
    if (safeName.endsWith('/')) continue

    const data = entries[rawName]
    if (!data || data.byteLength === 0) {
      processed += 1
      continue
    }

    totalBytes += data.byteLength
    if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
      throw new Error('ZIP uncompressed size exceeds limit')
    }

    const innerExt = normalizeExt(safeName)
    if (innerExt === 'zip') {
      skippedNestedZip += 1
      processed += 1
      continue
    }

    const pct = workNames.length
      ? Math.min(99, Math.round((processed / workNames.length) * 100))
      : 50
    emitParse(
      onProgress,
      pct,
      `ZIP ${processed + 1}/${workNames.length} · ${safeName}`,
      {
        done: processed,
        total: workNames.length,
        found: bucket.size,
        detail: safeName,
      },
    )

    const innerBuf = Buffer.from(data)
    const inner = await parseImportFile(`${zipName}!${safeName}`, innerBuf, {
      nested: true,
      onProgress: (ev) => {
        // Keep zip-level pct; append inner detail.
        emitParse(onProgress, pct, `ZIP ${safeName}: ${ev.message}`, {
          done: processed,
          total: workNames.length,
          found: bucket.size,
          detail: safeName,
        })
      },
    })
    for (const cred of inner.credentials) {
      const key = credentialDedupeKey(cred)
      if (!bucket.has(key)) bucket.set(key, cred)
    }
    if (inner.meta.error) warnings.push(`${safeName}: ${inner.meta.error}`)
    parsedFiles += 1
    processed += 1
    await yieldEventLoop()
  }

  const notes: string[] = [`${parsedFiles} file(s) parsed from archive`]
  if (skippedNestedZip) notes.push(`${skippedNestedZip} nested zip skipped`)
  if (skippedUnsafe) notes.push(`${skippedUnsafe} unsafe path(s) skipped`)
  if (warnings.length) notes.push(warnings.slice(0, 3).join('; '))
  emitParse(onProgress, 99, notes.join(' · '), {
    done: workNames.length,
    total: workNames.length,
    found: bucket.size,
  })
  return notes.join(' · ')
}

async function parseExcelXlsx(
  buffer: Buffer,
  bucket: Map<string, ParsedCredential>,
  onProgress?: ImportProgressFn,
) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  emitParse(onProgress, 20, `Workbook loaded · ${workbook.worksheets.length} sheet`)

  const sheets = workbook.worksheets
  sheets.forEach((sheet, idx) => {
    const rows: string[][] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values : []
      rows.push(
        values.slice(1).map((v) => {
          if (v == null) return ''
          if (typeof v === 'object' && 'text' in (v as object)) {
            return String((v as { text?: string }).text ?? '')
          }
          return String(v).trim()
        }),
      )
    })
    rowsToCredentials(rows, bucket)
    const pct = sheets.length
      ? Math.min(95, Math.round(((idx + 1) / sheets.length) * 80) + 20)
      : 90
    emitParse(onProgress, pct, `Sheet ${idx + 1}/${sheets.length} · ${sheet.name} · ${bucket.size.toLocaleString('id-ID')} creds`, {
      done: idx + 1,
      total: sheets.length,
      found: bucket.size,
      detail: sheet.name,
    })
  })
}

async function parseSqlite(
  buffer: Buffer,
  bucket: Map<string, ParsedCredential>,
  onProgress?: ImportProgressFn,
) {
  emitParse(onProgress, 5, 'Load SQLite…')
  const SQL = await initSqlJs()
  const db = new SQL.Database(buffer)
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")
    const names =
      tables[0]?.values.map((row) => String(row[0])).filter((n) => !n.startsWith('sqlite_')) ?? []
    emitParse(onProgress, 15, `SQLite · ${names.length} tabel`, { total: names.length, found: 0 })

    for (let i = 0; i < names.length; i++) {
      const table = names[i]!
      let result
      try {
        result = db.exec(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 5000`)
      } catch {
        continue
      }
      for (const set of result) {
        const rows = [set.columns, ...set.values.map((row) => row.map((c) => String(c ?? '')))]
        rowsToCredentials(rows, bucket)
        for (const row of set.values) {
          for (const cell of row) collectFromLines(String(cell ?? ''), bucket)
        }
      }
      const pct = names.length
        ? Math.min(95, Math.round(((i + 1) / names.length) * 80) + 15)
        : 90
      emitParse(onProgress, pct, `Tabel ${i + 1}/${names.length} · ${table} · ${bucket.size.toLocaleString('id-ID')} creds`, {
        done: i + 1,
        total: names.length,
        found: bucket.size,
        detail: table,
      })
    }
  } finally {
    db.close()
  }
}
