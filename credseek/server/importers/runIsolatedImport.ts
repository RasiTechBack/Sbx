import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import type { ImportProgressEvent } from './progress.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerScript = path.join(__dirname, '../workers/runFileImport.ts')

function resolveTsxCli() {
  const candidates = [
    path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

export type IsolatedImportResult = {
  added: number
  skipped: number
  total: number
  timing?: { parseMs: number; insertMs: number }
  extracted?: number
  format?: string
  warning?: string
  error?: string
}

let importChain: Promise<void> = Promise.resolve()

/** Serialize isolated imports so SQLite writers don't stampede. */
export function enqueueIsolatedImport<T>(fn: () => Promise<T>): Promise<T> {
  const run = importChain.then(fn, fn)
  importChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function runIsolatedStagedFileImport(input: {
  filename: string
  filePath: string
  onProgress?: (ev: ImportProgressEvent) => void
  signal?: AbortSignal
  deleteAfter?: boolean
}): Promise<IsolatedImportResult> {
  const tsxCli = resolveTsxCli()
  if (!tsxCli) {
    throw new Error('tsx CLI not found — cannot run isolated import worker')
  }
  if (!fs.existsSync(input.filePath)) {
    throw new Error('Staging file tidak ditemukan')
  }

  return await new Promise<IsolatedImportResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, workerScript, '--file', input.filePath, '--name', input.filename],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false
    let result: IsolatedImportResult | null = null

    const cleanup = () => {
      if (!input.deleteAfter) return
      try {
        fs.unlinkSync(input.filePath)
      } catch {
        /* ignore */
      }
    }

    const finishOk = (data: IsolatedImportResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(data)
    }

    const finishErr = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onAbort = () => {
      child.kill('SIGTERM')
      finishErr(new Error('Import dibatalkan'))
    }
    input.signal?.addEventListener('abort', onAbort)

    const consume = (chunk: string, final = false) => {
      stdoutBuf += chunk
      const parts = stdoutBuf.split('\n')
      stdoutBuf = final ? '' : parts.pop() || ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let row: Record<string, unknown>
        try {
          row = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        if (row.type === 'progress') {
          input.onProgress?.(row as unknown as ImportProgressEvent)
        } else if (row.type === 'done') {
          result = {
            added: Number(row.added) || 0,
            skipped: Number(row.skipped) || 0,
            total: Number(row.total) || 0,
            timing: row.timing as IsolatedImportResult['timing'],
            extracted: typeof row.extracted === 'number' ? row.extracted : undefined,
            format: typeof row.format === 'string' ? row.format : undefined,
            warning: typeof row.warning === 'string' ? row.warning : undefined,
            error: typeof row.error === 'string' ? row.error : undefined,
          }
        } else if (row.type === 'error') {
          finishErr(new Error(String(row.error || 'Import worker failed')))
        }
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => consume(d, false))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      stderrBuf += d
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000)
    })

    child.on('error', (err) => {
      input.signal?.removeEventListener('abort', onAbort)
      finishErr(err)
    })

    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort)
      consume('', true)
      if (settled) return
      if (code === 0 && result) {
        finishOk(result)
        return
      }
      finishErr(
        new Error(
          result?.error ||
            (stderrBuf.trim() ? stderrBuf.trim().slice(0, 500) : `Import worker exited (${code})`),
        ),
      )
    })
  })
}

export async function runIsolatedFileImport(input: {
  filename: string
  buffer: Buffer
  onProgress?: (ev: ImportProgressEvent) => void
  signal?: AbortSignal
}): Promise<IsolatedImportResult> {
  fs.mkdirSync(config.importStagingDir, { recursive: true })
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const tempPath = path.join(config.importStagingDir, `${randomUUID()}__${safe}`)
  fs.writeFileSync(tempPath, input.buffer)
  return runIsolatedStagedFileImport({
    filename: input.filename,
    filePath: tempPath,
    onProgress: input.onProgress,
    signal: input.signal,
    deleteAfter: true,
  })
}
