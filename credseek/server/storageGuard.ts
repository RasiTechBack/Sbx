import {
  assertImportsAllowed,
  getDbStorageGuard,
  ImportPausedError,
  setMaxDbBytes,
  setMaxDbGb,
  type DbStorageGuard,
} from './db/recordsDb.js'

export {
  assertImportsAllowed,
  getDbStorageGuard,
  ImportPausedError,
  setMaxDbBytes,
  setMaxDbGb,
  type DbStorageGuard,
}

export function isImportPausedError(err: unknown): err is ImportPausedError {
  return (
    err instanceof ImportPausedError ||
    (Boolean(err) &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'IMPORT_PAUSED')
  )
}
