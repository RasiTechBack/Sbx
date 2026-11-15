/**
 * Isolated file import process — keeps the web event loop free.
 * Usage: tsx server/workers/runFileImport.ts --file <path> --name <originalName>
 * Emits NDJSON progress/done/error lines on stdout.
 */
import fs from 'node:fs'
import { initRecordsDb } from '../db/recordsDb.js'
import { parseImportFile } from '../importers/parseFile.js'
import {
  createProgressThrottler,
  mapOverallPct,
  type ImportProgressEvent,
} from '../importers/progress.js'
import { insertCredentialsUnified, initSearchBackend } from '../search/backend.js'

function arg(name: string) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function emit(obj: unknown) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

async function main() {
  const filePath = arg('--file')
  const filename = arg('--name') || (filePath ? filePath.split(/[/\\]/).pop() : '') || 'upload.bin'
  if (!filePath) {
    emit({ type: 'error', error: 'Missing --file' })
    process.exit(2)
  }
  if (!fs.existsSync(filePath)) {
    emit({ type: 'error', error: `File not found: ${filePath}` })
    process.exit(2)
  }

  initRecordsDb()
  await initSearchBackend()

  const buffer = fs.readFileSync(filePath)
  emit({
    type: 'progress',
    phase: 'receive',
    pct: 100,
    overallPct: 5,
    message: `Upload diterima · ${filename} · ${(buffer.length / (1024 * 1024)).toFixed(2)} MB`,
    done: buffer.length,
    total: buffer.length,
  } satisfies ImportProgressEvent)

  const emitProgress = createProgressThrottler((raw) => {
    const overallPct = raw.overallPct ?? mapOverallPct(raw.phase, raw.pct)
    emit({ type: 'progress', ...raw, overallPct })
  })

  const t0 = Date.now()
  const parsed = await parseImportFile(filename, buffer, { onProgress: emitProgress })
  const t1 = Date.now()
  const saved = await insertCredentialsUnified(parsed.credentials, { onProgress: emitProgress })
  const t2 = Date.now()

  const result = {
    type: 'done' as const,
    added: saved.added,
    skipped: saved.skipped,
    total: saved.total,
    timing: { parseMs: t1 - t0, insertMs: t2 - t1 },
    extracted: parsed.meta.extracted,
    format: parsed.meta.format,
    warning: parsed.meta.warning,
    error: parsed.meta.error,
  }

  emit({
    type: 'progress',
    phase: 'done',
    pct: 100,
    overallPct: 100,
    message: `Selesai · +${saved.added} · skip ${saved.skipped} · parse ${t1 - t0}ms · insert ${t2 - t1}ms`,
    added: saved.added,
    skipped: saved.skipped,
    found: parsed.meta.extracted,
  } satisfies ImportProgressEvent)
  emit(result)

  console.error(
    `[import-worker] ${filename}: ${parsed.credentials.length} creds · parse ${t1 - t0}ms · insert ${t2 - t1}ms · +${saved.added}/skip ${saved.skipped}`,
  )
}

void main().catch((err) => {
  emit({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
