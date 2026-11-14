/**
 * Shared import job processor — used by in-process runner and optional Redis worker.
 */
import fs from 'node:fs'
import { parseCredentialLine } from '../store.js'
import { importFromRemoteUrl } from '../importers/fetchRemote.js'
import { runIsolatedStagedFileImport } from '../importers/runIsolatedImport.js'
import { insertCredentialsUnified } from '../search/backend.js'
import { assertImportsAllowed } from '../storageGuard.js'
import { getImportJob, patchImportJob } from './importJobs.js'

export async function processImportJob(jobId: string) {
  const job = await getImportJob(jobId)
  if (!job) {
    console.warn('[import-job] missing', jobId)
    return
  }
  if (job.status === 'cancelled' || job.status === 'done') return

  try {
    assertImportsAllowed()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import di-pause (batas database)'
    await patchImportJob(jobId, {
      status: 'error',
      error: message,
      progress: { done: 0, total: 1, phase: 'paused', message },
    })
    return
  }

  await patchImportJob(jobId, {
    status: 'running',
    progress: { done: 0, total: 1, phase: 'starting', message: 'Menyiapkan…' },
  })

  try {
    if (job.kind === 'text') {
      const text = String(job.payload.text || '')
      const items = text
        .split(/\r?\n/)
        .map((line) => parseCredentialLine(line))
        .filter(Boolean) as NonNullable<ReturnType<typeof parseCredentialLine>>[]
      const result = await insertCredentialsUnified(items)
      await patchImportJob(jobId, {
        status: 'done',
        progress: {
          done: 1,
          total: 1,
          phase: 'done',
          added: result.added,
          skipped: result.skipped,
          totalRecords: result.total,
          message: 'Selesai',
        },
      })
      return
    }

    if (job.kind === 'url') {
      const urls = (job.payload.urls as string[]) || []
      let added = 0
      let skipped = 0
      const results = []
      for (let i = 0; i < urls.length; i++) {
        const again = await getImportJob(jobId)
        if (again?.status === 'cancelled') return
        const url = urls[i]!
        try {
          const out = await importFromRemoteUrl(url)
          const result = await insertCredentialsUnified(out.credentials || [])
          added += result.added
          skipped += result.skipped
          results.push({
            url,
            added: result.added,
            skipped: result.skipped,
            kind: out.kind,
            filename: out.filename,
            format: out.meta?.format,
            extracted: out.credentials?.length || 0,
            warning: out.meta?.warning,
          })
        } catch (err) {
          results.push({
            url,
            added: 0,
            skipped: 0,
            error: err instanceof Error ? err.message : 'Import failed',
          })
        }
        await patchImportJob(jobId, {
          status: 'running',
          progress: {
            done: i + 1,
            total: urls.length,
            phase: 'insert',
            added,
            skipped,
            results,
            message: `URL ${i + 1}/${urls.length}`,
          },
        })
      }
      await patchImportJob(jobId, {
        status: 'done',
        progress: {
          done: urls.length,
          total: urls.length,
          phase: 'done',
          added,
          skipped,
          results,
          message: 'Selesai',
        },
      })
      return
    }

    if (job.kind === 'file') {
      const files = (job.payload.files as Array<{ path: string; filename: string }>) || []
      let added = 0
      let skipped = 0
      const fileReports = []
      for (let i = 0; i < files.length; i++) {
        const again = await getImportJob(jobId)
        if (again?.status === 'cancelled') return
        const f = files[i]!
        await patchImportJob(jobId, {
          status: 'running',
          progress: {
            done: i,
            total: files.length,
            phase: 'parse',
            pct: 0,
            added,
            skipped,
            files: fileReports,
            currentFile: f.filename,
            message: `Memproses ${f.filename}…`,
          },
        })
        try {
          if (!fs.existsSync(f.path)) {
            throw new Error('File staging hilang')
          }
          const out = await runIsolatedStagedFileImport({
            filename: f.filename,
            filePath: f.path,
            deleteAfter: true,
            onProgress: (ev) => {
              void patchImportJob(jobId, {
                status: 'running',
                progress: {
                  done: i,
                  total: files.length,
                  phase: ev.phase || 'processing',
                  pct: ev.pct,
                  overallPct: ev.overallPct,
                  found: ev.found,
                  added: typeof ev.added === 'number' ? added + ev.added : added,
                  skipped,
                  files: fileReports,
                  currentFile: f.filename,
                  message: ev.message || `Memproses ${f.filename}`,
                  detail: ev.detail,
                },
              })
            },
          })
          added += out.added
          skipped += out.skipped
          fileReports.push({
            filename: f.filename,
            format: out.format || 'file',
            extracted: out.extracted ?? out.added + out.skipped,
            added: out.added,
            skipped: out.skipped,
            warning: out.warning,
          })
        } catch (err) {
          fileReports.push({
            filename: f.filename,
            format: 'unknown',
            extracted: 0,
            added: 0,
            skipped: 0,
            error: err instanceof Error ? err.message : 'Parse failed',
          })
          try {
            fs.unlinkSync(f.path)
          } catch {
            /* ignore */
          }
        }
        await patchImportJob(jobId, {
          status: 'running',
          progress: {
            done: i + 1,
            total: files.length,
            phase: 'processing',
            added,
            skipped,
            files: fileReports,
            message: `Selesai ${i + 1}/${files.length} file`,
          },
        })
      }
      await patchImportJob(jobId, {
        status: 'done',
        progress: {
          done: files.length,
          total: files.length,
          phase: 'done',
          added,
          skipped,
          files: fileReports,
          message: 'Selesai',
        },
      })
    }
  } catch (err) {
    await patchImportJob(jobId, {
      status: 'error',
      error: err instanceof Error ? err.message : 'Worker failed',
    })
  }
}
